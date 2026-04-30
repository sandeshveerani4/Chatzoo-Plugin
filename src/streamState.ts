type StreamState = {
  accumulated: string;
  startedAt: number;
  mediaUrls: string[];
  reasoning: string;
  deliveredText: string;
  resolvedModel: string;
  costUsd: number;
  toolCalls: string;
};

const activeStreams = new Map<string, StreamState>();

export function beginStream(threadId: string): void {
  activeStreams.set(threadId, {
    accumulated: "",
    startedAt: Date.now(),
    mediaUrls: [],
    reasoning: "",
    deliveredText: "",
    resolvedModel: "",
    costUsd: 0,
    toolCalls: "",
  });
}

export function appendStreamChunk(threadId: string, chunk: string): string {
  const state = activeStreams.get(threadId);
  if (!state) return "";
  state.accumulated += chunk;
  return state.accumulated;
}

export function readAccumulatedStream(threadId: string): string {
  return activeStreams.get(threadId)?.accumulated ?? "";
}

export function appendStreamMedia(threadId: string, paths: string[]): void {
  const state = activeStreams.get(threadId);
  if (!state || paths.length === 0) return;
  const seen = new Set(state.mediaUrls);
  for (const p of paths) {
    if (!seen.has(p)) {
      state.mediaUrls.push(p);
      seen.add(p);
    }
  }
}

export function readAccumulatedMedia(threadId: string): string[] {
  return activeStreams.get(threadId)?.mediaUrls ?? [];
}

export function appendStreamReasoning(threadId: string, chunk: string): void {
  const state = activeStreams.get(threadId);
  if (!state) return;
  state.reasoning += chunk;
}

export function readAccumulatedReasoning(threadId: string): string {
  return activeStreams.get(threadId)?.reasoning ?? "";
}

export function appendDeliveredText(threadId: string, chunk: string): void {
  const state = activeStreams.get(threadId);
  if (!state || !chunk) return;
  state.deliveredText += chunk;
}

export function readDeliveredText(threadId: string): string {
  return activeStreams.get(threadId)?.deliveredText ?? "";
}

export function setResolvedModel(threadId: string, model: string): void {
  const state = activeStreams.get(threadId);
  if (state) state.resolvedModel = model;
}

export function getResolvedModel(threadId: string): string {
  return activeStreams.get(threadId)?.resolvedModel ?? "";
}

export function addCostUsd(threadId: string, cost: number): void {
  const state = activeStreams.get(threadId);
  if (state) state.costUsd += cost;
}

export function getCostUsd(threadId: string): number {
  return activeStreams.get(threadId)?.costUsd ?? 0;
}

export function appendStreamToolCall(threadId: string, fence: string): void {
  const state = activeStreams.get(threadId);
  if (state) state.toolCalls += fence;
}

export function readAccumulatedToolCalls(threadId: string): string {
  return activeStreams.get(threadId)?.toolCalls ?? "";
}

export function endStream(threadId: string): void {
  activeStreams.delete(threadId);
}
