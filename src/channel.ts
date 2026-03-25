/**
 * Channel definition — ChatZoo messaging channel with security, pairing,
 * and outbound delivery. Returns a channel plugin object compatible with
 * current OpenClaw gateway runtime expectations.
 */
import { deliverMessage } from "./outbound.js";
import { sendStreamEvent } from "./outbound.js";
import { appendStreamChunk, isStreamActive } from "./streamState.js";

export interface ChannelConfig {
  gatewayUrl: string;
  hookToken: string;
  deliveryTimeoutMs: number;
}

const CHANNEL_ID = "chatzoo";
const DEFAULT_ACCOUNT_ID = "default";

function resolveChannelSection(cfg: any): Record<string, any> {
  const pluginEntryCfg = cfg?.plugins?.entries?.[CHANNEL_ID]?.config;
  const channelCfg = (cfg?.channels as Record<string, any>)?.[CHANNEL_ID];
  return {
    ...(channelCfg ?? {}),
    ...(pluginEntryCfg ?? {}),
  };
}

function resolveAccount(cfg: any, accountId?: string | null) {
  const section = resolveChannelSection(cfg);
  return {
    accountId: accountId ?? DEFAULT_ACCOUNT_ID,
    gatewayUrl: section.gatewayUrl,
    hookToken: section.hookToken,
    deliveryTimeoutMs: section.deliveryTimeoutMs ?? 3000,
    enabled: Boolean(section.enabled ?? true),
    configured: Boolean(section.gatewayUrl && section.hookToken),
  };
}

export function buildChannel() {
  return {
    id: CHANNEL_ID,

    meta: {
      id: CHANNEL_ID,
      label: "ChatZoo",
      selectionLabel: "ChatZoo",
      docsPath: "https://docs.openclaw.ai/plugins/sdk-channel-plugins",
      detailLabel: "ChatZoo iOS Gateway",
      blurb: "Connect OpenClaw to ChatZoo via llm-gateway webhooks",
      order: 90,
    },

    capabilities: {
      chatTypes: ["direct" as const, "thread" as const],
      media: true,
      threads: true,
      reactions: false,
      edit: false,
      unsend: false,
      reply: true,
      effects: false,
      blockStreaming: false,
    },

    reload: { configPrefixes: ["channels.chatzoo"] },

    config: {
      listAccountIds: (_cfg: any) => [DEFAULT_ACCOUNT_ID],
      resolveAccount: (cfg: any, accountId?: string | null) =>
        resolveAccount(cfg, accountId),
      inspectAccount: (cfg: any, accountId?: string | null) => {
        const account = resolveAccount(cfg, accountId);
        return {
          enabled: account.enabled,
          configured: account.configured,
          gatewayUrlStatus: account.gatewayUrl ? "available" : "missing",
          tokenStatus: account.hookToken ? "available" : "missing",
        };
      },
      defaultAccountId: (_cfg: any) => DEFAULT_ACCOUNT_ID,
    },

    security: {
      resolveDmPolicy: () => ({
        policy: "none",
        allowFrom: [],
        policyPath: "channels.chatzoo.dmPolicy",
        allowFromPath: "channels.chatzoo.allowFrom",
        approveHint: "OpenClaw pairing is disabled for ChatZoo",
        normalizeEntry: (raw: string) => raw.trim(),
      }),
      collectWarnings: () => [],
    },

    messaging: {
      normalizeTarget: (target: string) => {
        const trimmed = target?.trim();
        return trimmed ? trimmed : undefined;
      },
      targetResolver: {
        looksLikeId: (id: string) => Boolean(id?.trim()),
        hint: "<conversationId>",
      },
    },

    directory: {
      self: async () => null,
      listPeers: async () => [],
      listGroups: async () => [],
    },

    outbound: {
      deliveryMode: "gateway" as const,
      textChunkLimit: 4000,
      sendText: async ({ to, text, accountId, cfg, ...rest }: any) => {
        const account = resolveAccount(cfg ?? {}, accountId);

        // OpenClaw's built-in `message` tool passes media as absolute filesystem
        // paths (e.g. /home/openclaw/.openclaw/media/browser/abc.jpg).
        // Convert them to gateway proxy URLs and append as markdown images so the
        // app can fetch and display them.
        const OPENCLAW_ROOT = "/home/openclaw/.openclaw/";
        const rawPaths: unknown[] = [
          ...(rest.mediaUrl != null ? [rest.mediaUrl] : []),
          ...(Array.isArray(rest.mediaUrls) ? rest.mediaUrls : []),
        ];
        const mediaMarkdown: string[] = [];
        const seen = new Set<string>();
        for (const p of rawPaths) {
          if (typeof p !== "string" || seen.has(p)) continue;
          seen.add(p);
          // Only handle absolute filesystem paths; HTTP URLs are handled by the
          // gateway's rewriteMediaUrls function.
          if (!p.startsWith("/")) continue;
          if (p.includes("..")) continue; // reject traversal attempts
          const relative = p.startsWith(OPENCLAW_ROOT)
            ? p.slice(OPENCLAW_ROOT.length)
            : p.slice(1);
          if (!relative) continue;
          const proxyUrl = `${account.gatewayUrl}/v1/computer/media?path=${encodeURIComponent(relative)}`;
          mediaMarkdown.push(`![media](${proxyUrl})`);
        }
        const fullText = mediaMarkdown.length
          ? text
            ? `${text}\n\n${mediaMarkdown.join("\n")}`
            : mediaMarkdown.join("\n")
          : text;
        if (!account.gatewayUrl || !account.hookToken) {
          throw new Error(
            "chatzoo: gatewayUrl and hookToken are required in config",
          );
        }

        // When an inbound stream is active for this conversation, OpenClaw may
        // call sendText multiple times with partial chunks. In that mode we
        // forward chunks as stream deltas and defer persistence to stream end.
        if (isStreamActive(String(to))) {
          appendStreamChunk(String(to), fullText);
          await sendStreamEvent({
            gatewayUrl: account.gatewayUrl,
            hookToken: account.hookToken,
            event: {
              type: "agent.stream.delta",
              conversationId: String(to),
              text: fullText,
            },
          });

          const chunkMessageId = `chatzoo-chunk-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
          return {
            channel: CHANNEL_ID,
            messageId: chunkMessageId,
            chatId: String(to),
          };
        }

        const generatedMessageId = `chatzoo-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
        await deliverMessage({
          gatewayUrl: account.gatewayUrl,
          hookToken: account.hookToken,
          deliveryTimeoutMs: account.deliveryTimeoutMs,
          threadId: String(to),
          content: fullText,
          messageId: generatedMessageId,
        });
        return {
          channel: CHANNEL_ID,
          messageId: generatedMessageId,
          chatId: String(to),
        };
      },
    },
  };
}
