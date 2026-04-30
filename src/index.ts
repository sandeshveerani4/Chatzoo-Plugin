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
import { createHmac, timingSafeEqual } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createOperatorApprovalsGatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { buildChannel } from "./channel.js";
import { getActiveSoulMd } from "./activeAgent.js";
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

// Guard against OpenClaw calling register() more than once (e.g. on channel
// reconnect or plugin hot-reload events).  Duplicate registrations stack up
// multiple handlers for every hook/route/channel, multiplying work per request
// and starving the event loop — which causes CDP/browser tool timeouts.
let _registered = false;

/**
 * Main plugin export. OpenClaw calls register(api) to initialize the plugin.
 */
export default {
  id: "chatzoo",
  name: "ChatZoo",
  description:
    "Real-time event-driven bridge between OpenClaw and the ChatZoo iOS app backend",

  register(api: OpenClawPluginApi) {
    const cfg = resolvePluginConfig(api);

    // Always register the model provider — OpenClaw calls register() on fresh
    // registries when resolving implicit providers (activate:false), and the
    // provider must be present in each of those registries for catalog.run to
    // be invoked. Provider registration is stateless and safe to repeat.
    registerChatzooProvider(api, {
      baseUrl: cfg.providerBaseUrl || `${cfg.gatewayUrl}/v1/computer/llm`,
      apiKey: cfg.providerApiKey,
      computerDefaultModel: cfg.computerDefaultModel,
    });

    if (_registered) {
      api.logger?.debug?.(
        "ChatZoo plugin already registered — skipping duplicate register() call",
      );
      return;
    }
    _registered = true;

    // Persist runtime reference for use across modules (outbound, inbound, events)
    runtimeStore.set(api.runtime);

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

    // Approve: llm-gateway → OpenClaw (user approves/denies an exec approval)
    // Uses HMAC-SHA256 auth (same hookToken as /webhook/chatzoo) and resolves
    // the pending approval via the OpenClaw gateway's exec.approval.resolve method.
    api.registerHttpRoute({
      path: "/webhook/chatzoo/approve",
      auth: "plugin",
      handler: async (req, res) => {
        const writeJson = (
          status: number,
          body: Record<string, unknown>,
        ): boolean => {
          if (res.headersSent) return true;
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(body));
          return true;
        };

        // Read body
        let body: Buffer;
        try {
          body = await new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk: Buffer) => chunks.push(chunk));
            req.on("end", () => resolve(Buffer.concat(chunks)));
            req.on("error", reject);
          });
        } catch {
          return writeJson(400, { error: "bad_request" });
        }

        // Verify HMAC-SHA256 signature
        const sigHeader =
          (req.headers["x-hook-signature"] as string | undefined) ?? "";
        const expected = createHmac("sha256", cfg.hookToken)
          .update(body)
          .digest("hex");
        const expectedBuf = Buffer.from(expected, "utf8");
        const actualBuf = Buffer.from(sigHeader, "utf8");
        if (
          expectedBuf.length !== actualBuf.length ||
          !timingSafeEqual(expectedBuf, actualBuf)
        ) {
          return writeJson(401, { error: "unauthorized" });
        }

        let parsed: { approvalId?: string; decision?: string };
        try {
          parsed = JSON.parse(body.toString("utf8"));
        } catch {
          return writeJson(400, { error: "invalid_json" });
        }

        const { approvalId, decision } = parsed;
        if (
          !approvalId ||
          !decision ||
          !["allow-once", "allow-always", "deny"].includes(decision)
        ) {
          return writeJson(400, {
            error: "bad_request",
            message: "Missing or invalid approvalId/decision",
          });
        }

        // Resolve the approval via OpenClaw gateway WebSocket.
        // createOperatorApprovalsGatewayClient returns the client immediately after
        // starting the WS connection — before the socket is OPEN. Calling
        // request() before the handshake completes throws "gateway not connected".
        // We pass onHelloOk/onConnectError to a promise that resolves only once
        // the client is fully authenticated and ready to accept requests.
        let gatewayClient: Awaited<
          ReturnType<typeof createOperatorApprovalsGatewayClient>
        > | null = null;
        try {
          let resolveReady!: () => void;
          let rejectReady!: (err: Error) => void;
          const ready = new Promise<void>((res, rej) => {
            resolveReady = res;
            rejectReady = rej;
          });

          gatewayClient = await createOperatorApprovalsGatewayClient({
            config: cfg.openclawConfig as any,
            gatewayUrl: "ws://localhost:18789",
            clientDisplayName: "chatzoo-approve",
            onHelloOk: () => resolveReady(),
            onConnectError: (err: Error) => rejectReady(err),
          });

          await ready;

          await gatewayClient.request("exec.approval.resolve", {
            id: approvalId,
            decision,
          });
          return writeJson(200, { ok: true });
        } catch (err: any) {
          return writeJson(502, {
            error: "resolve_failed",
            message: String(err?.message ?? err),
          });
        } finally {
          gatewayClient?.stop();
        }
      },
    });

    // Events: cron.executed, heartbeat.ping, task.updated, agent.status.changed
    registerEventRoutes(api, cfg);

    // Agent-facing helpers so OpenClaw understands ChatZoo routing/reminder semantics
    registerChatzooTools(api);

    // Inject the active agent soul as the system prompt before each agent run.
    // The soul is received from the gateway via the inbound webhook body and
    // stored in activeAgent.ts. This replaces proxy-level system message injection.
    api.on("before_prompt_build", () => {
      const soul = getActiveSoulMd();
      if (!soul) return;
      return { systemPrompt: soul };
    });

    api.logger.info("ChatZoo channel plugin registered");
  },
};
