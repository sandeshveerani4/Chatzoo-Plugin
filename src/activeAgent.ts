/**
 * Per-request active soul context using AsyncLocalStorage.
 *
 * Each inbound webhook wraps its dispatch in `soulContext.run({ soul })` so
 * concurrent requests cannot corrupt each other's agent personality — mirrors
 * the pattern used by modelContext.ts for the model override.
 */
import { AsyncLocalStorage } from "node:async_hooks";

interface SoulContext {
  soul: string | null;
}

export const soulContext = new AsyncLocalStorage<SoulContext>();

export function getActiveSoulMd(): string | null {
  return soulContext.getStore()?.soul ?? null;
}
