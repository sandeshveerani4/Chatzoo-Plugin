/**
 * Inbound webhook handler — POST /webhook/chatzoo
 *
 * The llm-gateway POSTs user messages here so OpenClaw's agent pipeline can
 * process them. Authentication uses HMAC-SHA256 over the raw request body
 * with the shared hookToken as the secret.
 *
 * Expected body:
 *   { conversationId: string, message: string, userId: string }
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/irc";
import { runtimeStore } from "./client.js";
import { deliverMessage, sendStreamEvent } from "./outbound.js";
import {
  appendStreamChunk,
  appendStreamMedia,
  appendStreamReasoning,
  beginStream,
  endStream,
  readAccumulatedStream,
  readAccumulatedMedia,
  readAccumulatedReasoning,
  setResolvedModel,
  getResolvedModel,
  getCostUsd,
} from "./streamState.js";
import { modelContext } from "./modelContext.js";

interface InboundBody {
  conversationId: string;
  message: string;
  userId: string;
  model?: string;
}

const INBOUND_DISPATCH_TIMEOUT_MS = 90_000;

export async function handleInbound(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: {
    hookToken: string;
    gatewayUrl: string;
    deliveryTimeoutMs: number;
    openclawConfig?: unknown;
  },
): Promise<void> {
  const writeJson = (status: number, body: Record<string, unknown>): void => {
    if (res.headersSent) return;
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };

  const rawBody = await new Promise<string>((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });

  try {
    const sigHeader = req.headers["x-hook-signature"];
    const sig = typeof sigHeader === "string" ? sigHeader : "";
    const token = extractHookToken(req);
    const configuredToken = cfg.hookToken?.trim() ?? "";
    const tokenMatchesConfigured =
      token.length > 0 &&
      configuredToken.length > 0 &&
      token === configuredToken;
    const signatureMatchesConfigured =
      configuredToken.length > 0 &&
      verifySignature(rawBody, configuredToken, sig);
    const signatureMatchesProvidedToken =
      token.length > 0 && verifySignature(rawBody, token, sig);

    if (
      !signatureMatchesConfigured &&
      !tokenMatchesConfigured &&
      !signatureMatchesProvidedToken
    ) {
      runtimeStore
        .get()
        ?.log?.warn?.(
          `chatzoo inbound auth failed: sigPresent=${Boolean(sig)} tokenPresent=${Boolean(token)} configuredTokenPresent=${configuredToken.length > 0}`,
        );
      writeJson(401, { error: "unauthorized" });
      return;
    }

    const authMode = signatureMatchesConfigured
      ? "signature-configured-token"
      : tokenMatchesConfigured
        ? "header-token-configured-token"
        : "signature-provided-token";
    runtimeStore
      .get()
      ?.log?.info?.(`chatzoo inbound auth ok: mode=${authMode}`);

    let data: InboundBody;
    try {
      data = JSON.parse(rawBody) as InboundBody;
    } catch {
      writeJson(400, { error: "invalid json" });
      return;
    }

    if (!data.conversationId || !data.message || !data.userId) {
      writeJson(400, {
        error: "conversationId, message, and userId are required",
      });
      return;
    }

    const runtime = runtimeStore.get();
    if (!runtime) {
      writeJson(500, { error: "runtime not initialized" });
      return;
    }

    const resolveAgentRoute = runtime.channel?.routing?.resolveAgentRoute;
    const resolveStorePath = runtime.channel?.session?.resolveStorePath;
    const recordInboundSession = runtime.channel?.session?.recordInboundSession;
    const finalizeInboundContext =
      runtime.channel?.reply?.finalizeInboundContext;
    const dispatchReplyWithBufferedBlockDispatcher =
      runtime.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;

    if (
      !resolveAgentRoute ||
      !resolveStorePath ||
      !recordInboundSession ||
      !finalizeInboundContext ||
      !dispatchReplyWithBufferedBlockDispatcher ||
      !cfg.openclawConfig
    ) {
      writeJson(503, {
        error: "runtime channel dispatch APIs are unavailable",
      });
      return;
    }

    beginStream(data.conversationId);
    try {
      runtime.log?.info?.(
        `chatzoo inbound: webhook received for conversation ${data.conversationId}, message="${data.message.slice(0, 80)}"`,
      );

      // Per-token streaming callback: fires for every LLM chunk before blocks are
      // assembled. payload.text is the CUMULATIVE text so far (like a Telegram
      // draft that grows with each token), NOT just the new characters. We track
      // how much we have already forwarded and only send the new tail as a delta.
      //
      // OpenClaw calls onPartialReply WITHOUT await (fire-and-forget), so multiple
      // invocations can be in-flight concurrently. To prevent out-of-order HTTP
      // delivery we serialize sends via a Promise chain queue: each send only
      // starts after the previous one completes, preserving call order.
      let partialSentLength = 0;
      let sendQueue: Promise<void> = Promise.resolve();
      const onPartialReply = (payload: { text?: string }): void => {
        const fullText = typeof payload?.text === "string" ? payload.text : "";
        const delta = fullText.slice(partialSentLength);
        if (!delta) return;
        partialSentLength = fullText.length;
        appendStreamChunk(data.conversationId, delta);
        // Capture delta in closure before enqueuing — partialSentLength may
        // advance before the queued microtask runs.
        const capturedDelta = delta;
        sendQueue = sendQueue.then(async () => {
          try {
            await sendStreamEvent({
              gatewayUrl: cfg.gatewayUrl,
              hookToken: cfg.hookToken,
              timeoutMs: 5_000,
              event: {
                type: "agent.stream.delta",
                conversationId: data.conversationId,
                text: capturedDelta,
              },
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            runtime.log?.error?.(
              `chatzoo partial-reply: delta send failed: ${msg}`,
            );
            // Non-blocking — agent run must not fail because of a delivery error.
          }
        });
      };

      const route = resolveAgentRoute({
        cfg: cfg.openclawConfig,
        channel: "chatzoo",
        accountId: "default",
        peer: { kind: "direct", id: data.conversationId },
      });

      const ctxPayload = finalizeInboundContext(
        {
          Channel: "chatzoo",
          Surface: "chatzoo",
          Provider: "chatzoo",
          AccountId: route.accountId,
          ChatType: "direct",
          From: data.userId,
          SenderId: data.userId,
          To: data.conversationId,
          Body: data.message,
          BodyForAgent: data.message,
          MessageId: `chatzoo-inbound-${Date.now()}`,
          Timestamp: Date.now(),
          SessionKey: route.sessionKey,
          OriginatingChannel: "chatzoo",
          OriginatingTo: data.conversationId,
        },
        {
          forceBodyForAgent: true,
          forceBodyForCommands: true,
          forceChatType: true,
          forceConversationLabel: true,
        },
      );

      runtime.log?.info?.(`chatzoo inbound: starting dispatch to agent`);

      const runDispatch = () =>
        Promise.race([
          dispatchInboundReplyWithBase({
            cfg: cfg.openclawConfig as any,
            channel: "chatzoo",
            accountId: route.accountId,
            route: {
              agentId: route.agentId,
              sessionKey: route.sessionKey,
            },
            storePath: resolveStorePath(
              (
                cfg.openclawConfig as
                  | { session?: { store?: string } }
                  | undefined
              )?.session?.store,
            ),
            ctxPayload: ctxPayload as any,
            core: {
              channel: {
                session: { recordInboundSession },
                reply: {
                  dispatchReplyWithBufferedBlockDispatcher:
                    dispatchReplyWithBufferedBlockDispatcher as any,
                },
              },
            },
            deliver: async (payload) => {
              const text =
                typeof payload?.text === "string"
                  ? payload.text
                  : typeof (payload as { body?: unknown })?.body === "string"
                    ? ((payload as { body?: string }).body ?? "")
                    : "";

              // Extract media URLs from the OutboundReplyPayload.
              // OpenClaw sends absolute filesystem paths (e.g.
              // /home/openclaw/.openclaw/media/browser/abc.jpg).
              const OPENCLAW_ROOT = "/home/openclaw/.openclaw/";
              const rawPaths: string[] = [];
              if (typeof payload?.mediaUrl === "string")
                rawPaths.push(payload.mediaUrl);
              if (Array.isArray(payload?.mediaUrls)) {
                for (const u of payload.mediaUrls) {
                  if (typeof u === "string") rawPaths.push(u);
                }
              }
              const storagePaths: string[] = [];
              const seen = new Set<string>();
              for (const p of rawPaths) {
                if (!p || seen.has(p)) continue;
                seen.add(p);
                if (!p.startsWith("/") || p.includes("..")) continue;
                const relative = p.startsWith(OPENCLAW_ROOT)
                  ? p.slice(OPENCLAW_ROOT.length)
                  : p.slice(1);
                if (!relative) continue;
                storagePaths.push(
                  `computer/media?path=${encodeURIComponent(relative)}`,
                );
              }
              if (storagePaths.length > 0) {
                appendStreamMedia(data.conversationId, storagePaths);
              }

              runtime.log?.info?.(
                `chatzoo deliver: block text="${text.slice(0, 80)}" (${text.length} chars), media=${storagePaths.length}`,
              );
            },
            onRecordError: (err) => {
              const msg = err instanceof Error ? err.message : String(err);
              runtime.log?.warn?.(`chatzoo inbound record failed: ${msg}`);
            },
            onDispatchError: (err, info) => {
              const msg = err instanceof Error ? err.message : String(err);
              runtime.log?.error?.(
                `chatzoo inbound dispatch error [${info.kind}]: ${msg}`,
              );
              throw new Error(`dispatch error [${info.kind}]: ${msg}`);
            },
            replyOptions: Object.assign(
              {
                disableBlockStreaming: true,
                onPartialReply,
                onAssistantMessageStart: () => {
                  partialSentLength = 0;
                },
                onReasoningStream: (payload: { text?: string }) => {
                  const text =
                    typeof payload?.text === "string" ? payload.text : "";
                  if (!text) return;
                  appendStreamReasoning(data.conversationId, text);
                  sendQueue = sendQueue.then(async () => {
                    try {
                      await sendStreamEvent({
                        gatewayUrl: cfg.gatewayUrl,
                        hookToken: cfg.hookToken,
                        timeoutMs: 1500,
                        event: {
                          type: "agent.stream.reasoning",
                          conversationId: data.conversationId,
                          text,
                        },
                      });
                    } catch (err) {
                      const msg =
                        err instanceof Error ? err.message : String(err);
                      runtime.log?.error?.(
                        `chatzoo reasoning-stream: send failed: ${msg}`,
                      );
                    }
                  });
                },
                onToolStart: (payload: { name?: string; phase?: string }) => {
                  sendQueue = sendQueue.then(async () => {
                    try {
                      await sendStreamEvent({
                        gatewayUrl: cfg.gatewayUrl,
                        hookToken: cfg.hookToken,
                        timeoutMs: 1500,
                        event: {
                          type: "agent.stream.tool-start",
                          conversationId: data.conversationId,
                          name: payload?.name,
                          phase: payload?.phase,
                        },
                      });
                    } catch (err) {
                      const msg =
                        err instanceof Error ? err.message : String(err);
                      runtime.log?.error?.(
                        `chatzoo tool-start: send failed: ${msg}`,
                      );
                    }
                  });
                },
              },
              {
                // onModelSelected is not in ReplyOptionsWithoutModelSelected but
                // the underlying getReply runtime accepts it. Use Object.assign to
                // bypass the excess-property check.
                onModelSelected: (ctx: {
                  provider?: string;
                  model?: string;
                }) => {
                  if (ctx?.model) {
                    // ctx.model already includes the provider prefix from
                    // OpenRouter (e.g. "openai/gpt-5.4"), so use it directly
                    // instead of prepending ctx.provider which would double-prefix.
                    setResolvedModel(data.conversationId, ctx.model);
                    runtime.log?.info?.(
                      `chatzoo: model selected: ${ctx.model}`,
                    );
                  }
                },
              },
            ),
          }),
          new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(new Error("inbound dispatch timed out"));
            }, INBOUND_DISPATCH_TIMEOUT_MS);
          }),
        ]);

      await (data.model
        ? modelContext.run({ model: data.model }, runDispatch)
        : runDispatch());

      // Drain the delta send queue before signalling done. dispatchInboundReplyWithBase
      // resolves as soon as the LLM finishes generating, but onPartialReply fires
      // fire-and-forget so sendQueue may still have pending HTTP sends. If we POST
      // the done event before those complete, the gateway closes the SSE stream and
      // the iOS app stops reading — dropping the last N tokens entirely.
      await sendQueue;

      // All tokens were already streamed via onPartialReply (which also called
      // appendStreamChunk). Build the final message from the accumulator.
      const assistantMessage = readAccumulatedStream(data.conversationId);
      const imageUrls = readAccumulatedMedia(data.conversationId);
      const reasoning = readAccumulatedReasoning(data.conversationId);
      const resolvedModel = getResolvedModel(data.conversationId);
      const costUsd = getCostUsd(data.conversationId);
      const messageId = `chatzoo-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

      runtime.log?.info?.(
        `chatzoo inbound: complete, accumulated message="${assistantMessage.slice(0, 80)}" (${assistantMessage.length} chars)`,
      );

      if (assistantMessage.trim().length > 0) {
        let doneEventSent = false;
        try {
          runtime.log?.info?.(`chatzoo inbound: sending done event`);
          await sendStreamEvent({
            gatewayUrl: cfg.gatewayUrl,
            hookToken: cfg.hookToken,
            timeoutMs: 15_000,
            event: {
              type: "agent.stream.done",
              conversationId: data.conversationId,
              assistantMessage,
              messageId,
              ...(imageUrls.length > 0 ? { imageUrls } : {}),
              ...(reasoning ? { reasoning } : {}),
              ...(resolvedModel ? { model: resolvedModel } : {}),
              ...(costUsd > 0 ? { costUsd } : {}),
            },
          });
          runtime.log?.info?.(`chatzoo inbound: done event sent`);
          doneEventSent = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          runtime.log?.error?.(`chatzoo inbound: done event failed: ${msg}`);
        }

        // The gateway's done handler persists to DB via notify.
        // Only call deliverMessage as a fallback if the done event failed,
        // to avoid duplicate DB rows.
        if (!doneEventSent) {
          await deliverMessage({
            gatewayUrl: cfg.gatewayUrl,
            hookToken: cfg.hookToken,
            deliveryTimeoutMs: cfg.deliveryTimeoutMs,
            threadId: data.conversationId,
            content: assistantMessage,
            messageId,
            ...(imageUrls.length > 0 ? { imageUrls } : {}),
          });

          // Retry done event with a longer timeout so the gateway can resolve
          // the pending SSE stream. Without this the 120s timeout fires.
          try {
            await sendStreamEvent({
              gatewayUrl: cfg.gatewayUrl,
              hookToken: cfg.hookToken,
              timeoutMs: 30_000,
              event: {
                type: "agent.stream.done",
                conversationId: data.conversationId,
                assistantMessage,
                messageId,
                ...(imageUrls.length > 0 ? { imageUrls } : {}),
                ...(reasoning ? { reasoning } : {}),
                ...(resolvedModel ? { model: resolvedModel } : {}),
                ...(costUsd > 0 ? { costUsd } : {}),
              },
            });
          } catch {
            runtime.log?.error?.(
              `chatzoo inbound: retry done event also failed`,
            );
          }
        }
      }

      writeJson(200, { ok: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      try {
        await sendStreamEvent({
          gatewayUrl: cfg.gatewayUrl,
          hookToken: cfg.hookToken,
          timeoutMs: 5000,
          event: {
            type: "agent.stream.error",
            conversationId: data.conversationId,
            message: msg,
          },
        });
      } catch {
        // Best effort only.
      }
      writeJson(500, { error: msg });
    } finally {
      endStream(data.conversationId);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    writeJson(500, { error: msg });
  }
}

function verifySignature(
  body: string,
  secret: string,
  signature: string,
): boolean {
  if (!signature) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const expectedBuf = Buffer.from(expected);
  const sigBuf = Buffer.from(signature);
  if (expectedBuf.length !== sigBuf.length) return false;
  return timingSafeEqual(expectedBuf, sigBuf);
}

function readHeaderValue(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return (value[0] ?? "").trim();
  return "";
}

function extractHookToken(req: IncomingMessage): string {
  const xHook = readHeaderValue(req, "x-hook-token");
  if (xHook) return xHook;

  const xOpenclaw = readHeaderValue(req, "x-openclaw-token");
  if (xOpenclaw) return xOpenclaw;

  const auth = readHeaderValue(req, "authorization");
  if (!auth) return "";
  return /^Bearer\s+/i.test(auth)
    ? auth.replace(/^Bearer\s+/i, "").trim()
    : auth;
}
