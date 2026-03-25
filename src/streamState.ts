type StreamState = {
  accumulated: string;
  startedAt: number;
  pendingDelta: string;
  lastDeltaFlushAt: number;
};

const activeStreams = new Map<string, StreamState>();

export function beginStream(threadId: string): void {
  const now = Date.now();
  activeStreams.set(threadId, {
    accumulated: "",
    startedAt: now,
    pendingDelta: "",
    lastDeltaFlushAt: now,
  });
}

export function isStreamActive(threadId: string): boolean {
  return activeStreams.has(threadId);
}

export function appendStreamChunk(threadId: string, chunk: string): string {
  const state = activeStreams.get(threadId);
  if (!state) return "";
  state.accumulated += chunk;
  state.pendingDelta += chunk;
  return state.accumulated;
}

export function takeDeltaIfReady(
  threadId: string,
  now = Date.now(),
): string | undefined {
  const state = activeStreams.get(threadId);
  if (!state) return undefined;

  // Flush immediately so UI receives live chunk-by-chunk streaming.
  if (state.pendingDelta.length === 0) return undefined;

  const out = state.pendingDelta;
  state.pendingDelta = "";
  state.lastDeltaFlushAt = now;
  return out || undefined;
}

export function takeRemainingDelta(threadId: string): string | undefined {
  const state = activeStreams.get(threadId);
  if (!state) return undefined;
  const out = state.pendingDelta;
  state.pendingDelta = "";
  state.lastDeltaFlushAt = Date.now();
  return out || undefined;
}

export function readAccumulatedStream(threadId: string): string {
  return activeStreams.get(threadId)?.accumulated ?? "";
}

export function endStream(threadId: string): void {
  activeStreams.delete(threadId);
}
