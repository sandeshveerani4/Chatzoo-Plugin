---
name: chatzoo-channel
description: ChatZoo channel behavior guide. Use for message routing, delivery semantics, and media constraints when reasoning about ChatZoo conversations.
metadata:
  {
    "openclaw":
      { "emoji": "📡", "requires": { "config": ["channels.chatzoo"] } },
  }
---

# ChatZoo Channel Guide

Use this skill for ChatZoo-specific channel behavior.

## Session Mapping

- ChatZoo conversation to OpenClaw session mapping:
  - `sessionKey = chatzoo:<conversationId>`

## Delivery Path

- Preferred in-app path:
  - `/v1/computer/delivery/message` (SSE delivery when app is active)
- Fallback path:
  - `/v1/computer/notify` (persist + push)

## Reminders and Events

- Cron events should include `sessionKey` or `conversationId` for thread-safe persistence.
- Missing context may fall back to latest computer conversation.

## Media Constraints

- OpenClaw localhost media links should be rewritten to gateway media proxy paths for app consumption.
- URL-accessible attachments are most reliable for cross-system delivery.
