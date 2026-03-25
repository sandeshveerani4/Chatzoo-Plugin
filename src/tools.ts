import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";

type RemindParams = {
  action?: "add" | "list" | "remove";
  content?: string;
  cronExpr?: string;
  everyMs?: number;
  jobId?: string;
  name?: string;
  conversationId?: string;
};

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

function buildRemindTool(): AnyAgentTool {
  return {
    name: "chatzoo_remind",
    label: "ChatZoo Remind",
    description:
      "Create, list, or remove ChatZoo reminders. Returns cron tool params and ChatZoo session mapping guidance.",
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
          description: "Cron expression for scheduled reminders.",
        },
        everyMs: {
          type: "number",
          description: "Interval schedule in milliseconds.",
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
            "Optional ChatZoo conversation id. When present, maps to sessionKey=chatzoo:<conversationId> for thread sync.",
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
        return jsonText({
          _instruction:
            "Use the cron tool next with action=list to fetch reminders.",
          cronParams: { action: "list" },
        });
      }

      if (action === "remove") {
        if (!p.jobId) {
          return jsonText({ error: "jobId is required for action=remove" });
        }
        return jsonText({
          _instruction:
            "Use the cron tool next with action=remove to delete this reminder.",
          cronParams: { action: "remove", jobId: p.jobId },
        });
      }

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

      return jsonText({
        _instruction:
          "Use the cron tool next with these params. Include sessionKey to keep reminder replies in the same ChatZoo thread.",
        cronParams: {
          action: "add",
          name: p.name ?? "ChatZoo reminder",
          schedule: p.cronExpr
            ? { kind: "cron", expr: p.cronExpr }
            : { kind: "interval", everyMs: p.everyMs },
          payload: { kind: "agentTurn", message: p.content.trim() },
          wakeMode: "now",
          ...(sessionKey ? { sessionKey } : {}),
        },
      });
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
              "Include conversationId or sessionKey on cron events to preserve thread sync in ChatZoo.",
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
  api.registerTool(buildRemindTool() as any, { name: "chatzoo_remind" });
  api.registerTool(buildChannelInfoTool() as any, {
    name: "chatzoo_channel_info",
  });
}
