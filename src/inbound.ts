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
import {
  appendDeliveredText,
  appendStreamChunk,
  appendStreamMedia,
  appendStreamReasoning,
  beginStream,
  endStream,
  readAccumulatedStream,
  readAccumulatedMedia,
  readAccumulatedReasoning,
  readDeliveredText,
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
  reasoningEffort?: string;
}

const INBOUND_DISPATCH_TIMEOUT_MS = 10 * 60 * 1_000; // 10 minutes

export async function handleInbound(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: {
    hookToken: string;
    gatewayUrl: string;
    deliveryTimeoutMs: number;
    computerDefaultModel: string;
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

    // ── Session reset commands ───────────────────────────────────────────────
    // Intercept /new, /reset, /clear etc. before dispatching to the agent.
    // Clears the OpenClaw session and signals the iOS app to wipe messages.
    if (isSessionResetCommand(data.message)) {
      const runtime = runtimeStore.get();
      runtime?.log?.info?.(
        `chatzoo: session reset command "${data.message}" for ${data.conversationId}`,
      );

      // Try to clear the OpenClaw session history.
      const resolveAgentRoute = runtime?.channel?.routing?.resolveAgentRoute;
      const resolveStorePath = runtime?.channel?.session?.resolveStorePath;
      if (resolveAgentRoute && cfg.openclawConfig) {
        try {
          const route = resolveAgentRoute({
            cfg: cfg.openclawConfig,
            channel: "chatzoo",
            accountId: "default",
            peer: { kind: "direct", id: data.conversationId },
          });
          const storePath = resolveStorePath?.(
            (cfg.openclawConfig as { session?: { store?: string } })?.session
              ?.store,
          );
          await clearOpenClawSession(
            runtime,
            route.sessionKey,
            storePath ?? "",
          );
        } catch (err) {
          runtime?.log?.warn?.(
            `chatzoo: session clear failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Respond with SSE done + clearMessages flag.
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const writeSse = (eventType: string, payload: unknown): void => {
        if (res.writableEnded) return;
        res.write(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`);
      };
      writeSse("done", {
        conversationId: data.conversationId,
        messageId: `chatzoo-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
        assistantMessage: "Session cleared. Starting fresh!",
        clearMessages: true,
      });
      if (!res.writableEnded) res.end();
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

    // ── Start SSE response ───────────────────────────────────────────────────
    // Set headers and flush immediately so the gateway's fetch() resolves and
    // the iOS client sees the stream is open before we even start the LLM.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    if (typeof (res as any).flushHeaders === "function") {
      (res as any).flushHeaders();
    }

    const writeSse = (eventType: string, payload: unknown): void => {
      if (res.writableEnded) return;
      res.write(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    let backgroundMode = false;
    beginStream(data.conversationId);
    try {
      runtime.log?.info?.(
        `chatzoo inbound: webhook received for conversation ${data.conversationId}, message="${data.message.slice(0, 80)}"`,
      );

      // Per-token streaming callbacks.
      //
      // OpenClaw delivers TWO separate snapshot streams:
      //   • onPartialReply  → full accumulated answer text snapshot.  For some
      //     models / reasoning modes this may include raw <think>/</think> (or
      //     <thinking>) blocks.  We accumulate the RAW snapshot for reasoning
      //     extraction at done-time, but strip complete thinking blocks before
      //     computing the incremental delta sent to the iOS client.
      //   • onReasoningStream → full accumulated FORMATTED reasoning text
      //     ("Reasoning:\n_line_\n…").  Also a snapshot — same delta approach.
      let partialSentLength = 0; // tracks stripped-snapshot length for delta
      let rawPartialSentLength = 0; // tracks raw-snapshot length for accumulation
      let lastReasoningLength = 0; // tracks plain-text reasoning chars already sent
      const onPartialReply = (payload: { text?: string }): void => {
        const rawFull = typeof payload?.text === "string" ? payload.text : "";
        // Accumulate the RAW snapshot so reasoning can be extracted at done-time.
        if (rawFull.length > rawPartialSentLength) {
          appendStreamChunk(
            data.conversationId,
            rawFull.slice(rawPartialSentLength),
          );
          rawPartialSentLength = rawFull.length;
        }
        // Strip complete thinking blocks before computing the clean delta for iOS.
        const fullText = stripThinkTags(rawFull);
        // If stripped length shrank, a think block just closed — reset so the
        // clean answer text isn't skipped.
        if (fullText.length < partialSentLength) {
          partialSentLength = 0;
        }
        const delta = fullText.slice(partialSentLength);
        if (!delta) return;
        partialSentLength = fullText.length;
        writeSse("delta", { text: delta });
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
          forceBodyForCommands: false,
          forceChatType: true,
          forceConversationLabel: true,
        },
      );

      runtime.log?.info?.(`chatzoo inbound: starting dispatch to agent`);

      const runDispatch = () =>
        dispatchInboundReplyWithBase({
          cfg: cfg.openclawConfig as any,
          channel: "chatzoo",
          accountId: route.accountId,
          route: {
            agentId: route.agentId,
            sessionKey: route.sessionKey,
          },
          storePath: resolveStorePath(
            (cfg.openclawConfig as { session?: { store?: string } } | undefined)
              ?.session?.store,
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

            // Capture the clean reply text delivered by OpenClaw.  This is the
            // authoritative content (thinking-blocks already stripped internally)
            // and is preferred over the onPartialReply accumulation at done-time.
            if (text) {
              appendDeliveredText(data.conversationId, text);
            }
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
              reasoningMode: "stream" as const,
              ...(data.reasoningEffort
                ? { reasoningEffort: data.reasoningEffort }
                : {}),
              onPartialReply,
              onAssistantMessageStart: () => {
                partialSentLength = 0;
                rawPartialSentLength = 0;
                lastReasoningLength = 0;
              },
              onReasoningStream: (payload: { text?: string }) => {
                const fullFormatted =
                  typeof payload?.text === "string" ? payload.text : "";
                if (!fullFormatted) return;
                // OpenClaw delivers the full accumulated reasoning as a snapshot
                // formatted as "Reasoning:\n_<text>_" (Markdown italic wrapper).
                // Strip the header and outer italic markers to get raw plain text,
                // then use length-based delta so the closing "_" doesn't break
                // startsWith comparisons as content grows.
                const plain = fullFormatted
                  .replace(/^Reasoning:\n/i, "")
                  .replace(/^_+/, "")
                  .replace(/_+$/, "");
                if (!plain || plain.length <= lastReasoningLength) return;
                const delta = plain.slice(lastReasoningLength);
                lastReasoningLength = plain.length;
                appendStreamReasoning(data.conversationId, delta);
                writeSse("reasoning", { text: delta });
              },
              onToolStart: (payload: { name?: string; phase?: string }) => {
                const json = JSON.stringify({
                  name: payload?.name ?? "tool",
                  ...(payload?.phase ? { phase: payload.phase } : {}),
                });
                const fence = `\n\`\`\`tool-call\n${json}\n\`\`\`\n`;
                appendStreamChunk(data.conversationId, fence);
                writeSse("delta", { text: fence });
              },
            },
            {
              onModelSelected: (ctx: { provider?: string; model?: string }) => {
                // Only record the model if the runtime reports a real upstream
                // model ID (contains "/").  Virtual IDs like "openclaw" or
                // "chatzoo-default" are already resolved to the real model by
                // resolveDynamicModel, which fires inside the modelContext scope.
                if (ctx?.model?.includes("/")) {
                  setResolvedModel(data.conversationId, ctx.model);
                  runtime.log?.info?.(`chatzoo: model selected: ${ctx.model}`);
                }
              },
            },
          ),
        });

      // Start dispatch — no timeout here; it runs until completion regardless.
      const dispatchPromise = modelContext.run(
        {
          model: data.model,
          conversationId: data.conversationId,
          reasoningEffort: data.reasoningEffort,
        },
        runDispatch,
      );

      type Outcome =
        | { status: "done" }
        | { status: "error"; err: unknown }
        | { status: "timeout" };

      const outcome = await Promise.race<Outcome>([
        dispatchPromise
          .then(() => ({ status: "done" as const }))
          .catch((err) => ({ status: "error" as const, err })),
        new Promise<Outcome>((resolve) =>
          setTimeout(
            () => resolve({ status: "timeout" }),
            INBOUND_DISPATCH_TIMEOUT_MS,
          ),
        ),
      ]);

      if (outcome.status === "timeout") {
        // Close the SSE stream to iOS so it shows something, but keep the
        // dispatch running in the background.  When it finishes, call the
        // gateway notify endpoint directly so the message is persisted and a
        // push notification is sent — no duplication because no "done" event
        // was ever forwarded through the SSE pipe.
        runtime.log?.warn?.(
          `chatzoo: SSE timeout for ${data.conversationId}, dispatch continues in background`,
        );
        writeSse("timeout", {
          message:
            "Response is taking longer than expected. You'll receive a push notification when it completes.",
        });
        if (!res.writableEnded) res.end();

        // Background completion — endStream called here, NOT in finally below.
        backgroundMode = true;
        void dispatchPromise
          .then(() => {
            const rawMessage = readAccumulatedStream(data.conversationId);
            const deliveredText = readDeliveredText(data.conversationId);
            if (!rawMessage && !deliveredText) return;
            const imageUrls = readAccumulatedMedia(data.conversationId);
            let reasoning = readAccumulatedReasoning(data.conversationId);

            if (!reasoning && rawMessage) {
              const extracted = extractThinkContent(rawMessage);
              if (extracted.thinking) reasoning = extracted.thinking;
            }

            let assistantMessage: string;
            if (deliveredText) {
              assistantMessage = deliveredText;
            } else {
              const extracted = extractThinkContent(rawMessage);
              assistantMessage = extracted.content || rawMessage;
              if (!reasoning && extracted.thinking)
                reasoning = extracted.thinking;
              if (!assistantMessage && extracted.thinking)
                assistantMessage = extracted.thinking;
            }
            const resolvedModel = getResolvedModel(data.conversationId);
            const costUsd = getCostUsd(data.conversationId);
            const messageId = `chatzoo-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
            runtime.log?.info?.(
              `chatzoo: background dispatch complete for ${data.conversationId}, notifying gateway`,
            );
            return fetch(`${cfg.gatewayUrl}/v1/computer/notify`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${cfg.hookToken}`,
              },
              body: JSON.stringify({
                conversationId: data.conversationId,
                messageId,
                content: assistantMessage,
                sendPushNotification: true,
                ...(imageUrls.length > 0 ? { imageUrls } : {}),
                ...(reasoning ? { reasoning } : {}),
                ...(resolvedModel ? { model: resolvedModel } : {}),
                ...(costUsd > 0 ? { costUsd } : {}),
              }),
            } as any).catch((err: Error) => {
              runtime.log?.error?.(
                `chatzoo background notify failed: ${err.message}`,
              );
            });
          })
          .catch((err: unknown) => {
            runtime.log?.error?.(
              `chatzoo background dispatch error: ${err instanceof Error ? err.message : String(err)}`,
            );
          })
          .finally(() => endStream(data.conversationId));
        return;
      }

      if (outcome.status === "error") {
        const msg =
          outcome.err instanceof Error
            ? outcome.err.message
            : String(outcome.err);
        runtime.log?.error?.(`chatzoo inbound error: ${msg}`);
        writeSse("error", { message: msg });
        if (!res.writableEnded) res.end();
        return;
      }

      // Normal path: dispatch completed within the SSE window.
      const rawMessage = readAccumulatedStream(data.conversationId);
      const deliveredText = readDeliveredText(data.conversationId);
      const imageUrls = readAccumulatedMedia(data.conversationId);
      let reasoning = readAccumulatedReasoning(data.conversationId);

      // Extract reasoning from raw accumulated content regardless of path —
      // covers models that embed <think> blocks in onPartialReply rather than
      // firing onReasoningStream.
      if (!reasoning && rawMessage) {
        const extracted = extractThinkContent(rawMessage);
        if (extracted.thinking) reasoning = extracted.thinking;
      }

      // Prefer the text captured from the `deliver` callback (OpenClaw's final,
      // think-tag-stripped output) over the onPartialReply accumulation.
      // Fall back to stripping rawMessage when deliver didn't fire.
      let assistantMessage: string;
      if (deliveredText) {
        assistantMessage = deliveredText;
      } else {
        const extracted = extractThinkContent(rawMessage);
        assistantMessage = extracted.content || rawMessage;
        if (!reasoning && extracted.thinking) reasoning = extracted.thinking;
        if (!assistantMessage && extracted.thinking)
          assistantMessage = extracted.thinking;
      }
      const resolvedModel = getResolvedModel(data.conversationId);
      const costUsd = getCostUsd(data.conversationId);
      const messageId = `chatzoo-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

      runtime.log?.info?.(
        `chatzoo inbound: complete, accumulated message="${assistantMessage.slice(0, 80)}" (${assistantMessage.length} chars)`,
      );

      writeSse("done", {
        conversationId: data.conversationId,
        messageId,
        assistantMessage,
        ...(imageUrls.length > 0 ? { imageUrls } : {}),
        ...(reasoning ? { reasoning } : {}),
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(costUsd > 0 ? { costUsd } : {}),
      });

      if (!res.writableEnded) res.end();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      runtime.log?.error?.(`chatzoo inbound error: ${msg}`);
      writeSse("error", { message: msg });
      if (!res.writableEnded) res.end();
    } finally {
      // In background mode the dispatch is still running; it calls endStream
      // itself when it finishes.  Only clean up here for the normal paths.
      if (!backgroundMode) endStream(data.conversationId);
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

/** Strip complete thinking blocks from a text snapshot (used on onPartialReply snapshots). */
function stripThinkTags(text: string): string {
  return text.replace(
    /<(think|thinking|thought|antthinking)>([\s\S]*?)<\/\1>/gi,
    "",
  );
}

/** Extract thinking block content and return it separately from the visible content. */
function extractThinkContent(text: string): {
  content: string;
  thinking: string;
} {
  const thinkRegex = /<(think|thinking|thought|antthinking)>([\s\S]*?)<\/\1>/gi;
  const thinkParts: string[] = [];
  const content = text
    .replace(thinkRegex, (_match: string, _tag: string, inner: string) => {
      thinkParts.push(inner);
      return "";
    })
    .trim();
  return { content, thinking: thinkParts.join("") };
}

// ── Session reset helpers ──────────────────────────────────────────────────

const SESSION_RESET_COMMANDS = new Set([
  "/new",
  "/reset",
  "/clear",
  "/cls",
  "/restart",
]);

function isSessionResetCommand(msg: string): boolean {
  return SESSION_RESET_COMMANDS.has(msg.trim().toLowerCase());
}

/**
 * Best-effort clearing of an OpenClaw session's history.
 * Tries known runtime APIs, then falls back to deleting the session store file.
 */
async function clearOpenClawSession(
  runtime: ReturnType<typeof runtimeStore.get>,
  sessionKey: string,
  storePath: string,
): Promise<void> {
  const session = (runtime as any)?.channel?.session;

  // Try common SDK clear/delete APIs.
  if (typeof session?.clearSession === "function") {
    await session.clearSession(sessionKey);
    runtime?.log?.info?.(
      `chatzoo: session ${sessionKey} cleared via clearSession()`,
    );
    return;
  }
  if (typeof session?.deleteSession === "function") {
    await session.deleteSession(sessionKey);
    runtime?.log?.info?.(
      `chatzoo: session ${sessionKey} cleared via deleteSession()`,
    );
    return;
  }
  if (typeof session?.clearHistory === "function") {
    await session.clearHistory(sessionKey);
    runtime?.log?.info?.(
      `chatzoo: session ${sessionKey} cleared via clearHistory()`,
    );
    return;
  }

  // Fallback: delete the session store file on disk.
  if (storePath) {
    try {
      const { unlink } = await import("node:fs/promises");
      const filePath = `${storePath}/${sessionKey}.json`.replace(/\/+/g, "/");
      await unlink(filePath);
      runtime?.log?.info?.(
        `chatzoo: session ${sessionKey} cleared via fs unlink`,
      );
    } catch {
      runtime?.log?.info?.(
        `chatzoo: no session file found for ${sessionKey} (may already be clean)`,
      );
    }
  }
}
