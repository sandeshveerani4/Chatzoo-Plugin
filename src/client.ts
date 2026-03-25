/**
 * Shared runtime store — lets channel.ts, outbound.ts, and events.ts access
 * the OpenClaw plugin runtime without circular imports.
 */
type PluginRuntimeLike = {
  log?: {
    info?: (...args: any[]) => void;
    warn?: (...args: any[]) => void;
    error?: (...args: any[]) => void;
  };
  channel?: {
    routing?: {
      resolveAgentRoute?: (input: {
        cfg: unknown;
        channel: string;
        accountId?: string | null;
        peer?: {
          kind: "direct" | "group" | "channel" | "thread";
          id: string;
        } | null;
      }) => { agentId: string; sessionKey: string; accountId: string };
    };
    session?: {
      resolveStorePath?: (cfg: unknown) => string;
      recordInboundSession?: (...args: any[]) => Promise<void>;
    };
    reply?: {
      finalizeInboundContext?: (
        ctx: Record<string, unknown>,
        opts?: Record<string, unknown>,
      ) => Record<string, unknown>;
      dispatchReplyWithBufferedBlockDispatcher?: (
        ...args: any[]
      ) => Promise<unknown>;
    };
  };
  agent?: {
    session?: {
      dispatch?: (input: {
        channel: string;
        threadId: string;
        userId: string;
        content: string;
      }) => Promise<void>;
    };
  };
};

class PluginRuntimeStore {
  private runtime: unknown = null;

  set(runtime: unknown): void {
    this.runtime = runtime;
  }

  get(): PluginRuntimeLike {
    if (!this.runtime) {
      throw new Error(
        "Runtime not initialized. Call set() first in the plugin entry.",
      );
    }
    return this.runtime as PluginRuntimeLike;
  }
}

export const runtimeStore = new PluginRuntimeStore();
