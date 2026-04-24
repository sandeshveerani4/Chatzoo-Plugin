/**
 * ChatZoo model provider plugin.
 *
 * Registers "chatzoo" as a provider so OpenClaw resolves model cost rates
 * dynamically from OpenRouter's catalog. This ensures `calculateCost` in
 * pi-ai produces real USD values regardless of which upstream model the
 * gateway proxies to.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  getOpenRouterModelCapabilities,
  loadOpenRouterModelCapabilities,
} from "openclaw/plugin-sdk/provider-stream";
import { modelContext } from "./modelContext.js";
import { setResolvedModel } from "./streamState.js";

const PROVIDER_ID = "chatzoo";

interface ChatZooProviderConfig {
  /** Gateway LLM proxy base URL (e.g. https://…/v1/computer/llm) */
  baseUrl: string;
  /** API key the gateway proxy expects (per-user key) */
  apiKey: string;
  /** The real OpenRouter model ID behind "chatzoo-default" */
  computerDefaultModel: string;
}

/**
 * Resolve the real OpenRouter model ID for a given chatzoo model ID.
 * "chatzoo-default" maps to whatever the gateway's COMPUTER_DEFAULT_MODEL is,
 * unless a per-request model override is present in AsyncLocalStorage.
 */
function resolveUpstreamModelId(
  modelId: string,
  computerDefaultModel: string,
): string {
  if (modelId === "chatzoo-default") {
    return modelContext.getStore()?.model ?? computerDefaultModel;
  }
  return modelId;
}

export function registerChatzooProvider(
  api: OpenClawPluginApi,
  cfg: ChatZooProviderConfig,
): void {
  api.logger?.info?.(
    `[chatzoo-provider] registerChatzooProvider called: apiKey=${Boolean(cfg.apiKey)}, baseUrl=${cfg.baseUrl}`,
  );
  api.registerProvider({
    id: PROVIDER_ID,
    label: "ChatZoo",

    // No interactive auth — the API key is baked into openclaw.json already.
    auth: [],

    catalog: {
      order: "simple",
      run: async (ctx) => {
        // Prefer credential resolved via OpenClaw's standard path
        // (config.providers.chatzoo.apiKey) over the plugin-config fallback.
        const resolvedApiKey =
          (ctx as any)?.resolveProviderApiKey?.(PROVIDER_ID)?.apiKey ||
          cfg.apiKey;
        const baseUrl =
          (ctx as any)?.config?.providers?.[PROVIDER_ID]?.baseUrl ||
          cfg.baseUrl;
        api.logger?.info?.(
          `[chatzoo-provider] catalog.run called, apiKey=${Boolean(resolvedApiKey)}, baseUrl=${baseUrl}`,
        );
        if (!resolvedApiKey) return null;
        // "chatzoo-default" must appear in the catalog so OpenClaw can resolve
        // the provider for this model ID at warmup and at runtime.
        // The actual upstream model ID is resolved dynamically in
        // resolveDynamicModel / prepareDynamicModel below.
        return {
          provider: {
            baseUrl,
            apiKey: resolvedApiKey,
            api: "openai-completions" as const,
            models: [
              {
                id: "chatzoo-default",
                name: "ChatZoo Default",
                api: "openai-completions" as const,
                input: ["text"] as const,
                reasoning: false,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 8192,
              },
            ],
          },
        };
      },
    },

    resolveDynamicModel: (ctx) => {
      const upstreamId = resolveUpstreamModelId(
        ctx.modelId,
        cfg.computerDefaultModel,
      );
      // Capture the real upstream model while we're still inside the
      // modelContext.run() scope — onModelSelected fires outside it.
      const conversationId = modelContext.getStore()?.conversationId;
      if (conversationId) setResolvedModel(conversationId, upstreamId);
      const capabilities = getOpenRouterModelCapabilities(upstreamId);
      // Keep id as ctx.modelId ("chatzoo-default") so OpenClaw can find it in
      // our catalog. The gateway at baseUrl handles the upstream remapping.
      return {
        id: ctx.modelId,
        name: capabilities?.name ?? ctx.modelId,
        api: "openai-completions" as const,
        provider: PROVIDER_ID,
        baseUrl: cfg.baseUrl,
        reasoning: capabilities?.reasoning ?? false,
        input: capabilities?.input ?? ["text"],
        cost: capabilities?.cost ?? {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: capabilities?.contextWindow ?? 128000,
        maxTokens: capabilities?.maxTokens ?? 8192,
      };
    },

    prepareDynamicModel: async (ctx) => {
      const upstreamId = resolveUpstreamModelId(
        ctx.modelId,
        cfg.computerDefaultModel,
      );
      await loadOpenRouterModelCapabilities(upstreamId);
    },
  });
}
