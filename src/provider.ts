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
  api.registerProvider({
    id: PROVIDER_ID,
    label: "ChatZoo",

    // No interactive auth — the API key is baked into openclaw.json already.
    auth: [],

    catalog: {
      order: "simple",
      run: async () => {
        if (!cfg.apiKey) return null;
        return {
          provider: {
            baseUrl: cfg.baseUrl,
            apiKey: cfg.apiKey,
            api: "openai-completions" as const,
            models: [],
          },
        };
      },
    },

    resolveDynamicModel: (ctx) => {
      const upstreamId = resolveUpstreamModelId(
        ctx.modelId,
        cfg.computerDefaultModel,
      );
      const capabilities = getOpenRouterModelCapabilities(upstreamId);
      return {
        id: upstreamId,
        name: capabilities?.name ?? upstreamId,
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
