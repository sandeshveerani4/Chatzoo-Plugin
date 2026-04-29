---
name: chatzoo-schedule
description: ChatZoo task scheduler. Use when creating, listing, or removing scheduled or recurring tasks — reminders, browser actions, scripts, or any future work — that should run at a specific time and optionally reply back in a ChatZoo conversation thread.
metadata:
  {
    "openclaw":
      { "emoji": "🗓️", "requires": { "config": ["channels.chatzoo"] } },
  }
---

# ChatZoo Scheduler

Use this skill when the user asks to schedule any future task — reminders, browser automation, recurring jobs, or anything to be done later.

## Tool

Use `chatzoo_schedule` with `action: "add"`.

## Recommended Flow

1. Gather the task intent:
   - `content` — the **full task instruction** the agent will execute at run time. Write it as a direct instruction, not a reminder note (e.g. `"Go to linkedin.com and post the weekly update"`).
   - `schedule` — either `cronExpr` (e.g. `"0 9 * * 1"` for Monday 9am) or `everyMs` (milliseconds from now for a one-shot delay).
   - `conversationId` — include whenever available so the reply lands in the same thread.
   - `deleteAfterRun` — defaults `true` for one-shot (`everyMs`), `false` for recurring (`cronExpr`). Override if needed.
2. Call `chatzoo_schedule` with `action: "add"`.
3. Confirm to the user with the schedule time and job name.

## Listing / Removing Jobs

- `action: "list"` — returns all scheduled jobs.
- `action: "remove"` — requires `jobId` from the list response.

## Notes

- The scheduled agent executes `content` literally — it can use any tool available to it (browser, bash, files, etc.).
- If no conversation is available, jobs can still be created; the backend falls back to the most recent computer conversation.
- Prefer clear `name` values so users can identify jobs when listing them later.
