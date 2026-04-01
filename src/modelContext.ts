/**
 * Per-request model context using AsyncLocalStorage.
 *
 * When a webhook inbound comes in with a model override, the dispatch is
 * wrapped in modelContext.run({ model }) so the provider's resolveDynamicModel
 * can read the model without any global mutation or shared state.
 */
import { AsyncLocalStorage } from "node:async_hooks";

interface ModelContext {
  model: string;
}

export const modelContext = new AsyncLocalStorage<ModelContext>();
