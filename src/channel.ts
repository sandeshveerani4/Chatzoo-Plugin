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
      sendText: async ({ to, text, accountId, cfg }: any) => {
        const account = resolveAccount(cfg ?? {}, accountId);
        if (!account.gatewayUrl || !account.hookToken) {
          throw new Error(
            "chatzoo: gatewayUrl and hookToken are required in config",
          );
        }

        // When an inbound stream is active for this conversation, OpenClaw may
        // call sendText multiple times with partial chunks. In that mode we
        // forward chunks as stream deltas and defer persistence to stream end.
        if (isStreamActive(String(to))) {
          appendStreamChunk(String(to), text);
          await sendStreamEvent({
            gatewayUrl: account.gatewayUrl,
            hookToken: account.hookToken,
            event: {
              type: "agent.stream.delta",
              conversationId: String(to),
              text,
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
          content: text,
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
