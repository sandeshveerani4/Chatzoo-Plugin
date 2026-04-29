---
name: chatzoo-channel
description: ChatZoo channel behavior guide. Use for message routing, delivery semantics, media constraints, scheduling, and screen control when reasoning about ChatZoo conversations.
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

## Scheduling Tasks

- Use the `chatzoo_schedule` tool (`action: "add"`) to schedule any future or recurring task.
- Pass the full task instruction as `content` — the scheduled agent will execute it literally.
- Include `conversationId` so replies land in the correct thread.

## Media Constraints

- OpenClaw localhost media links should be rewritten to gateway media proxy paths for app consumption.
- URL-accessible attachments are most reliable for cross-system delivery.

## Screen Control (Take Control)

When the browser requires user interaction that cannot be automated — login walls, CAPTCHAs, two-factor auth prompts, cookie consent that blocks the page, or any situation where the browser is blocked and cannot proceed — inform the user and suggest they use **Take Control**:

> "I'm blocked and need you to step in. Tap the **⋯ (three dots)** menu in the top-right corner of the chat and choose **Take Control** to see the browser and interact directly. Hand control back when you're done and I'll continue."

**When to suggest Take Control:**
- Login / sign-in pages where stored credentials are missing or invalid.
- CAPTCHA or bot-detection challenges.
- Two-factor authentication prompts.
- Cookie / privacy consent dialogs blocking the page.
- Any modal or overlay that cannot be dismissed programmatically.
- Situations where user judgement or manual input is required before the task can proceed.

**After the user hands back control**, resume the task from where it was blocked — do not start over.
