/**
 * Outbound delivery adapter.
 *
 * When OpenClaw finishes generating a response it calls sendText() here.
 * We implement the two-phase delivery strategy:
 *
 *   1. Try in-app delivery (POST /v1/computer/delivery/message).
 *      If the iOS app has an open SSE connection the gateway pushes the
 *      message directly — no push notification needed.
 *
 *   2. If in-app delivery times out or fails, fall through to
 *      POST /v1/computer/notify with sendPushNotification=true so the
 *      gateway both persists the message AND fires an FCM push.
 *
 * In both cases the message is persisted to the DB by the gateway.
 */
import { runtimeStore } from "./client.js";

function buildHookAuthHeaders(token: string): Record<string, string> {
  const trimmed = token.trim();
  return {
    "x-hook-token": trimmed,
    "x-openclaw-token": trimmed,
    Authorization: `Bearer ${trimmed}`,
  };
}

export interface DeliverOptions {
  gatewayUrl: string;
  hookToken: string;
  deliveryTimeoutMs: number;
  threadId: string;
  content: string;
  messageId: string;
  imageUrls?: string[];
}

export interface StreamEventOptions {
  gatewayUrl: string;
  hookToken: string;
  timeoutMs?: number;
  event:
    | {
        type: "agent.stream.delta";
        conversationId: string;
        text: string;
      }
    | {
        type: "agent.stream.reasoning";
        conversationId: string;
        text: string;
      }
    | {
        type: "agent.stream.tool-start";
        conversationId: string;
        name?: string;
        phase?: string;
      }
    | {
        type: "agent.stream.done";
        conversationId: string;
        assistantMessage: string;
        messageId: string;
        imageUrls?: string[];
        reasoning?: string;
        model?: string;
      }
    | {
        type: "agent.stream.error";
        conversationId: string;
        message: string;
      };
}

export async function deliverMessage(
  opts: DeliverOptions,
): Promise<{ messageId: string }> {
  let runtime: ReturnType<typeof runtimeStore.get> | null = null;
  try {
    runtime = runtimeStore.get();
  } catch {
    runtime = null;
  }

  const log = runtime?.log ?? {
    info: (..._args: any[]) => {},
    warn: (..._args: any[]) => {},
    error: (..._args: any[]) => {},
  };

  const payload = {
    threadId: opts.threadId,
    messageId: opts.messageId,
    content: opts.content,
    timestamp: new Date().toISOString(),
    ...(opts.imageUrls && opts.imageUrls.length > 0
      ? { imageUrls: opts.imageUrls }
      : {}),
  };

  try {
    const inAppDelivered = await tryInAppDelivery(opts, payload);

    if (inAppDelivered) {
      // App is foregrounded — gateway will persist + stream; skip push
      await persistMessage(opts, payload, false);
      log.info?.(
        { messageId: opts.messageId },
        "chatzoo: message delivered in-app",
      );
      return { messageId: opts.messageId };
    }

    // App is backgrounded — persist + send FCM push
    await persistMessage(opts, payload, true);
    log.info?.(
      { messageId: opts.messageId },
      "chatzoo: message stored + push sent",
    );
    return { messageId: opts.messageId };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error?.(
      { messageId: opts.messageId, error: msg },
      "chatzoo: delivery failed",
    );
    throw error;
  }
}

export async function sendStreamEvent(opts: StreamEventOptions): Promise<void> {
  const timeoutMs = Number.isFinite(opts.timeoutMs)
    ? Math.max(0, opts.timeoutMs ?? 0)
    : 0;
  const controller = new AbortController();
  const timer =
    timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  const res = await fetch(`${opts.gatewayUrl}/v1/computer/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...buildHookAuthHeaders(opts.hookToken),
    },
    body: JSON.stringify(opts.event),
    signal: controller.signal,
  });

  if (timer) clearTimeout(timer);

  if (!res.ok) {
    throw new Error(`stream event failed: ${res.status} ${res.statusText}`);
  }
}

async function tryInAppDelivery(
  opts: DeliverOptions,
  payload: object,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.deliveryTimeoutMs);
  try {
    const res = await fetch(`${opts.gatewayUrl}/v1/computer/delivery/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildHookAuthHeaders(opts.hookToken),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function persistMessage(
  opts: DeliverOptions,
  payload: object,
  sendPushNotification: boolean,
): Promise<void> {
  const res = await fetch(`${opts.gatewayUrl}/v1/computer/notify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...buildHookAuthHeaders(opts.hookToken),
    },
    body: JSON.stringify({ ...payload, sendPushNotification }),
  });

  if (!res.ok) {
    throw new Error(`persist failed: ${res.status} ${res.statusText}`);
  }
}
