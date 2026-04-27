/**
 * Channel definition — ChatZoo messaging channel with security, pairing,
 * and outbound delivery. Returns a channel plugin object compatible with
 * current OpenClaw gateway runtime expectations.
 */
import { deliverMessage } from "./outbound.js";

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

    execApprovals: {
      // ChatZoo supports exec approvals: the approval request message (with
      // channelData.execApproval) is delivered to the iOS app, which renders
      // approve/deny buttons. The user's tap sends "/approve <id> allow-once"
      // (or deny) back as a regular inbound message, which OpenClaw handles.
      getInitiatingSurfaceState: () => ({ kind: "enabled" as const }),
      shouldSuppressLocalPrompt: () => true,
      hasConfiguredDmRoute: () => false,
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
        // Convert filesystem paths to gateway-relative storagePaths that the
        // app fetches via fetchImage(storagePath) → GET /v1/<storagePath> with
        // Firebase auth. This mirrors exactly how normal chat imageUrls work.
        const storagePaths: string[] = [];
        const seen = new Set<string>();
        for (const p of rawPaths) {
          if (typeof p !== "string" || seen.has(p)) continue;
          seen.add(p);
          if (!p.startsWith("/")) continue;
          if (p.includes("..")) continue;
          const relative = p.startsWith(OPENCLAW_ROOT)
            ? p.slice(OPENCLAW_ROOT.length)
            : p.slice(1);
          if (!relative) continue;
          storagePaths.push(
            `computer/media?path=${encodeURIComponent(relative)}`,
          );
        }
        // Text stays clean — images arrive as imageUrls in the done event.
        const fullText = text;
        if (!account.gatewayUrl || !account.hookToken) {
          throw new Error(
            "chatzoo: gatewayUrl and hookToken are required in config",
          );
        }

        const generatedMessageId = `chatzoo-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
        await deliverMessage({
          gatewayUrl: account.gatewayUrl,
          hookToken: account.hookToken,
          deliveryTimeoutMs: account.deliveryTimeoutMs,
          threadId: String(to),
          content: fullText,
          messageId: generatedMessageId,
          ...(storagePaths.length > 0 ? { imageUrls: storagePaths } : {}),
          ...(rest.channelData && typeof rest.channelData === "object"
            ? { channelData: rest.channelData as Record<string, unknown> }
            : {}),
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
