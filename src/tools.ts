import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

type RemindParams = {
  action?: "add" | "list" | "remove";
  content?: string;
  cronExpr?: string;
  everyMs?: number;
  deleteAfterRun?: boolean;
  jobId?: string;
  name?: string;
  conversationId?: string;
};

type GatewayOpts = { url: string; token?: string };

function jsonText(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

async function cronRpc(
  opts: GatewayOpts,
  method: string,
  params?: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      client.stop();
      reject(new Error("gateway connection timed out"));
    }, 15_000);

    const client = new GatewayClient({
      url: opts.url,
      ...(opts.token ? { token: opts.token } : {}),
      mode: "backend" as any,
      clientName: "gateway-client" as any,
      onHelloOk: () => {
        client
          .request(method, params, { timeoutMs: 10_000 })
          .then((result) => {
            clearTimeout(deadline);
            resolve(result);
          })
          .catch((err) => {
            clearTimeout(deadline);
            reject(err);
          })
          .finally(() => {
            client.stop();
          });
      },
      onConnectError: (err: Error) => {
        clearTimeout(deadline);
        client.stop();
        reject(err);
      },
    });
    client.start();
  });
}

function buildRemindTool(gateway: GatewayOpts): AnyAgentTool {
  return {
    name: "chatzoo_remind",
    label: "ChatZoo Remind",
    description:
      "Create, list, or remove ChatZoo reminders. Directly schedules cron jobs on the OpenClaw gateway.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "list", "remove"],
          description: "Operation type.",
        },
        content: {
          type: "string",
          description: "Reminder content (required for action=add).",
        },
        cronExpr: {
          type: "string",
          description:
            "Cron expression for recurring reminders (e.g. '0 9 * * *' for 9am daily).",
        },
        everyMs: {
          type: "number",
          description:
            "Fire after this many milliseconds. Use with deleteAfterRun=true for one-shot reminders.",
        },
        deleteAfterRun: {
          type: "boolean",
          description:
            "Delete the job after it fires once. Default false. Set true for one-shot 'remind me in X' requests.",
        },
        jobId: {
          type: "string",
          description: "Cron job id to remove (required for action=remove).",
        },
        name: {
          type: "string",
          description: "Optional job name.",
        },
        conversationId: {
          type: "string",
          description:
            "ChatZoo conversation id. When present, the reminder reply is sent back in this thread.",
        },
      },
      required: ["action"],
    },
    async execute(_toolCallId: string, params: unknown) {
      const p = (params ?? {}) as RemindParams;
      const action = p.action;

      if (!action) {
        return jsonText({ error: "action is required" });
      }

      if (action === "list") {
        try {
          const jobs = await cronRpc(gateway, "cron.list", {});
          return jsonText({ jobs });
        } catch (err) {
          return jsonText({
            error: `Failed to list reminders: ${String(err)}`,
          });
        }
      }

      if (action === "remove") {
        if (!p.jobId) {
          return jsonText({ error: "jobId is required for action=remove" });
        }
        try {
          await cronRpc(gateway, "cron.remove", { id: p.jobId });
          return jsonText({ removed: true, jobId: p.jobId });
        } catch (err) {
          return jsonText({
            error: `Failed to remove reminder: ${String(err)}`,
          });
        }
      }

      // action === "add"
      if (!p.content || !p.content.trim()) {
        return jsonText({ error: "content is required for action=add" });
      }
      if (!p.cronExpr && !(typeof p.everyMs === "number" && p.everyMs > 0)) {
        return jsonText({
          error: "Provide either cronExpr or everyMs for action=add schedule.",
        });
      }

      const sessionKey = p.conversationId?.trim()
        ? `chatzoo:${p.conversationId.trim()}`
        : undefined;

      const job: Record<string, unknown> = {
        name: p.name ?? "ChatZoo reminder",
        enabled: true,
        schedule: p.cronExpr
          ? { kind: "cron", expr: p.cronExpr }
          : { kind: "interval", everyMs: p.everyMs },
        payload: { kind: "agentTurn", message: p.content.trim() },
        wakeMode: "now",
        sessionTarget: "main",
        deleteAfterRun: p.deleteAfterRun ?? false,
        ...(sessionKey ? { sessionKey } : {}),
      };

      try {
        const created = await cronRpc(gateway, "cron.add", job);
        return jsonText({ scheduled: true, job: created });
      } catch (err) {
        return jsonText({
          error: `Failed to schedule reminder: ${String(err)}`,
        });
      }
    },
  } as AnyAgentTool;
}

function buildChannelInfoTool(): AnyAgentTool {
  return {
    name: "chatzoo_channel_info",
    label: "ChatZoo Channel Info",
    description:
      "Returns ChatZoo channel behavior, session mapping, and media/delivery constraints for planning responses.",
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description:
            "Optional focus area: routing | reminders | media | delivery",
        },
      },
    },
    async execute(_toolCallId: string, params: unknown) {
      const topic =
        typeof (params as { topic?: unknown })?.topic === "string"
          ? ((params as { topic?: string }).topic ?? "").trim()
          : "";

      const base = {
        channelId: "chatzoo",
        sessionKeyFormat: "chatzoo:<conversationId>",
        inboundPath: "POST /webhook/chatzoo",
        reminderEventsPath: "POST /v1/computer/events",
        deliveryFallback: [
          "Try /v1/computer/delivery/message for in-app SSE delivery",
          "Fallback to /v1/computer/notify for persistence + push",
        ],
        media: {
          note: "Media URLs from OpenClaw are rewritten to /v1/computer/media for app-safe access.",
          caveat:
            "Channel outbound currently prioritizes text delivery; use URL-accessible attachments for best compatibility.",
        },
      };

      if (!topic) return jsonText(base);

      if (topic === "routing") {
        return jsonText({
          routing: {
            sessionKeyFormat: base.sessionKeyFormat,
            inboundPath: base.inboundPath,
            reminderEventsPath: base.reminderEventsPath,
          },
        });
      }

      if (topic === "reminders") {
        return jsonText({
          reminders: {
            recommendation:
              "Use chatzoo_remind with the conversationId to keep reminder replies in the same ChatZoo thread.",
            sessionKeyFormat: base.sessionKeyFormat,
          },
        });
      }

      if (topic === "media") {
        return jsonText({ media: base.media });
      }

      if (topic === "delivery") {
        return jsonText({ deliveryFallback: base.deliveryFallback });
      }

      return jsonText(base);
    },
  } as AnyAgentTool;
}

export function registerChatzooTools(api: OpenClawPluginApi): void {
  const config = api.config as any;
  const token = config?.gateway?.auth?.token as string | undefined;
  // Start with default port; update when gateway_start fires with actual port.
  const gateway: GatewayOpts = { url: "ws://127.0.0.1:18789", token };

  api.on("gateway_start", (event: any) => {
    gateway.url = `ws://127.0.0.1:${event.port}`;
  });

  api.registerTool(buildRemindTool(gateway) as any, { name: "chatzoo_remind" });
  api.registerTool(buildChannelInfoTool() as any, {
    name: "chatzoo_channel_info",
  });
}
