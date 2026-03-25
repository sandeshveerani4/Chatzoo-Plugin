---
name: chatzoo-remind
description: ChatZoo reminder workflow. Use when creating, listing, or removing scheduled reminders that should sync back into ChatZoo conversation threads.
metadata:
  {
    "openclaw":
      { "emoji": "⏰", "requires": { "config": ["channels.chatzoo"] } },
  }
---

# ChatZoo Reminders

Use this skill when the user asks for reminders, scheduled jobs, or recurring notifications while using the ChatZoo channel.

## Routing Rules

- Preserve thread sync by using ChatZoo session mapping:
  - `sessionKey = chatzoo:<conversationId>`
- For cron events, include either `conversationId` or `sessionKey` so backend persistence targets the correct conversation.

## Recommended Flow

1. Gather reminder intent:
   - content
   - schedule (`cronExpr` or interval)
   - optional `conversationId`
2. Build cron params.
3. Keep delivery compatible with ChatZoo:
   - include `sessionKey` when conversation is known.

## Notes

- If no conversation is available, reminders can still be created; backend will fall back to a recent computer conversation.
- Prefer clear job names to help users manage reminders later.
