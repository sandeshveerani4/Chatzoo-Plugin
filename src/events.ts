/**
 * Event emitters for CRON executions, heartbeats, task updates, and agent
 * status changes.
 *
 * Registers:
 *   POST /webhook/chatzoo/events  — gateway can also push events inbound
 *   registerHook("cron.afterExecute")  — fires after each cron job completes
 *   registerHook("agent.heartbeat")    — fires on each heartbeat tick
 *
 * All outbound events are forwarded to POST /v1/computer/events on the
 * llm-gateway with retry+backoff so transient failures don't drop events.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { IncomingMessage, ServerResponse } from "node:http";

export type ChatzooEvent =
  | {
      type: "cron.executed";
      jobId: string;
      jobName: string;
      result: string;
      executedAt: string;
      sessionKey?: string;
      conversationId?: string;
    }
  | {
      type: "heartbeat.ping";
      instanceId: string;
      status: "healthy" | "degraded";
      timestamp: string;
    }
  | { type: "task.updated"; taskId: string; status: string; progress?: number }
  | { type: "agent.status.changed"; agentId: string; status: string };

interface EventCfg {
  gatewayUrl: string;
  hookToken: string;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readRequestJson(req: IncomingMessage): Promise<unknown> {
  const raw = await new Promise<string>((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
  return JSON.parse(raw);
}

export function registerEventRoutes(api: OpenClawPluginApi, cfg: EventCfg) {
  // Allow the gateway to push arbitrary events into OpenClaw as well
  api.registerHttpRoute?.({
    path: "/webhook/chatzoo/events",
    auth: "plugin",
    handler: async (req, res) => {
      try {
        const event = (await readRequestJson(req)) as ChatzooEvent;
        await forwardEvent(cfg, event, api);
        sendJson(res, 200, { ok: true });
        return true;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        sendJson(res, 400, { error: msg });
        return true;
      }
    },
  });

  // Hook: cron job completed
  api.registerHook?.(
    "cron.afterExecute",
    async (params: unknown) => {
      const { jobId, jobName, result, sessionKey, conversationId } = params as {
        jobId: string;
        jobName: string;
        result: unknown;
        sessionKey?: string;
        conversationId?: string;
        session?: { key?: string };
      };
      try {
        const resolvedSessionKey =
          typeof sessionKey === "string"
            ? sessionKey
            : typeof params === "object" &&
                params !== null &&
                typeof (params as { session?: { key?: unknown } }).session
                  ?.key === "string"
              ? ((params as { session?: { key?: string } }).session?.key ?? "")
              : undefined;

        const resolvedConversationId =
          typeof conversationId === "string" && conversationId.trim().length > 0
            ? conversationId
            : resolvedSessionKey?.startsWith("chatzoo:")
              ? resolvedSessionKey.slice("chatzoo:".length)
              : undefined;

        await forwardEvent(
          cfg,
          {
            type: "cron.executed",
            jobId,
            jobName,
            result:
              typeof result === "string" ? result : JSON.stringify(result),
            executedAt: new Date().toISOString(),
            ...(resolvedSessionKey ? { sessionKey: resolvedSessionKey } : {}),
            ...(resolvedConversationId
              ? { conversationId: resolvedConversationId }
              : {}),
          },
          api,
        );
      } catch (error) {
        api.logger.warn(
          `chatzoo: cron event forward failed event=cron.executed jobId=${jobId} error=${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    { name: "chatzoo-cron-after-execute" },
  );

  // Hook: heartbeat tick
  api.registerHook?.(
    "agent.heartbeat",
    async (params: unknown) => {
      const { instanceId, status } = params as {
        instanceId: string;
        status: "healthy" | "degraded";
      };
      try {
        await forwardEvent(
          cfg,
          {
            type: "heartbeat.ping",
            instanceId,
            status,
            timestamp: new Date().toISOString(),
          },
          api,
        );
      } catch (error) {
        api.logger.warn(
          `chatzoo: heartbeat event forward failed event=heartbeat.ping instanceId=${instanceId} error=${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    { name: "chatzoo-agent-heartbeat" },
  );
}

async function forwardEvent(
  cfg: EventCfg,
  event: ChatzooEvent,
  api: OpenClawPluginApi,
  maxAttempts = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${cfg.gatewayUrl}/v1/computer/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-hook-token": cfg.hookToken,
        },
        body: JSON.stringify(event),
      });
      if (res.ok) {
        return;
      }
      api.logger.warn(
        `chatzoo: event forward non-ok event=${(event as unknown as Record<string, string>).type} status=${res.status} attempt=${attempt}`,
      );
    } catch (err) {
      api.logger.warn(
        `chatzoo: event forward failed event=${(event as unknown as Record<string, string>).type} attempt=${attempt} error=${err instanceof Error ? err.message : String(err)}`,
      );
      if (attempt === maxAttempts) {
        throw err;
      }
    }
    // Exponential backoff: 200ms, 400ms
    await new Promise((r) => setTimeout(r, 200 * attempt));
  }
}
