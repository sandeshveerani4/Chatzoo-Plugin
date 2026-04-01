/**
 * ChatZoo channel plugin — full runtime entry point.
 *
 * Registered capabilities:
 *   - ChatZoo messaging channel (createChatChannelPlugin)
 *   - POST /webhook/chatzoo          inbound messages from llm-gateway
 *   - POST /webhook/chatzoo/events   cron/heartbeat/task events
 *   - cron.afterExecute hook         forwards cron results to gateway
 *   - agent.heartbeat hook           forwards heartbeat pings to gateway
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildChannel } from "./channel.js";
import { runtimeStore } from "./client.js";
import { registerEventRoutes } from "./events.js";
import { handleInbound } from "./inbound.js";
import { registerChatzooTools } from "./tools.js";
import { registerChatzooProvider } from "./provider.js";

interface PluginConfig {
  gatewayUrl: string;
  hookToken: string;
  deliveryTimeoutMs: number;
  computerDefaultModel: string;
  providerBaseUrl: string;
  providerApiKey: string;
  openclawConfig?: unknown;
}

function resolvePluginConfig(api: OpenClawPluginApi): PluginConfig {
  const pluginCfg = (api.pluginConfig ?? {}) as Partial<PluginConfig>;
  const channelCfg =
    (
      (api as unknown as { config?: any }).config?.channels as
        | Record<string, any>
        | undefined
    )?.["chatzoo"] ?? {};

  return {
    gatewayUrl: (
      pluginCfg.gatewayUrl ??
      channelCfg.gatewayUrl ??
      ""
    ).toString(),
    hookToken: (pluginCfg.hookToken ?? channelCfg.hookToken ?? "").toString(),
    deliveryTimeoutMs:
      Number(
        pluginCfg.deliveryTimeoutMs ?? channelCfg.deliveryTimeoutMs ?? 3000,
      ) || 3000,
    computerDefaultModel: (
      pluginCfg.computerDefaultModel ??
      channelCfg.computerDefaultModel ??
      "openai/gpt-5.4"
    ).toString(),
    providerBaseUrl: (
      pluginCfg.providerBaseUrl ??
      channelCfg.providerBaseUrl ??
      ""
    ).toString(),
    providerApiKey: (
      pluginCfg.providerApiKey ??
      channelCfg.providerApiKey ??
      ""
    ).toString(),
    openclawConfig: api.config,
  };
}

/**
 * Main plugin export. OpenClaw calls register(api) to initialize the plugin.
 */
export default {
  id: "chatzoo",
  name: "ChatZoo",
  description:
    "Real-time event-driven bridge between OpenClaw and the ChatZoo iOS app backend",

  register(api: OpenClawPluginApi) {
    // Persist runtime reference for use across modules (outbound, inbound, events)
    runtimeStore.set(api.runtime);

    const cfg = resolvePluginConfig(api);

    // Register the ChatZoo messaging channel surface
    api.registerChannel({ plugin: buildChannel() });

    // Inbound: llm-gateway → OpenClaw (user sends a message)
    api.registerHttpRoute({
      path: "/webhook/chatzoo",
      auth: "plugin",
      handler: async (req, res) => {
        await handleInbound(req, res, cfg);
        return true;
      },
    });

    // Events: cron.executed, heartbeat.ping, task.updated, agent.status.changed
    registerEventRoutes(api, cfg);

    // Agent-facing helpers so OpenClaw understands ChatZoo routing/reminder semantics
    registerChatzooTools(api);

    // Register ChatZoo as a model provider so OpenClaw resolves real cost
    // rates from OpenRouter's catalog — works for any upstream model.
    registerChatzooProvider(api, {
      baseUrl: cfg.providerBaseUrl || `${cfg.gatewayUrl}/v1/computer/llm`,
      apiKey: cfg.providerApiKey,
      computerDefaultModel: cfg.computerDefaultModel,
    });

    api.logger.info("ChatZoo channel plugin registered");
  },
};
