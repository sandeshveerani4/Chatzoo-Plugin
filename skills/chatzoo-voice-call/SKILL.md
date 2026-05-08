---
name: chatzoo-voice-call
description: Voice call guide for ChatZoo. Use whenever making or managing phone calls — outbound calls, conversation loops, speaking to the user, and ending calls correctly.
metadata:
  {
    "openclaw":
      {
        "emoji": "📞",
        "requires": { "config": ["plugins.entries.voice-call.enabled"] },
      },
  }
---

# Voice Call Guide

Use this skill whenever you need to call someone or manage an active phone call.

## Making an outbound call

Use the `voice_call` tool throughout. A phone conversation requires a loop — `initiate_call` only starts the call and says the opening message. You must drive every subsequent turn with `continue_call`.

### Full conversation loop

```
1. initiate_call  → starts call, speaks opening message, returns callId
2. continue_call  → speaks your message AND waits (blocks) for the user to speak
                    returns { transcript } — what the user said
3. Repeat step 2 until the conversation is finished
4. end_call       → hangs up
```

### Example

```
voice_call({ action: "initiate_call", to: "+15550001234", message: "Hi, this is your assistant calling." })
→ { callId: "abc123" }

voice_call({ action: "continue_call", callId: "abc123", message: "How can I help you today?" })
→ { transcript: "I wanted to ask about my appointment." }

voice_call({ action: "continue_call", callId: "abc123", message: "Of course, let me check that for you..." })
→ { transcript: "Thanks, that's all I needed." }

voice_call({ action: "end_call", callId: "abc123" })
```

## Critical rules

- **Always loop `continue_call`** — after `initiate_call` the call is silent until you call `continue_call`. The user cannot be heard without it.
- **`continue_call` blocks until the user finishes speaking** — it speaks your message, then listens, then returns the transcript. Do not call it again until the previous call returns.
- **Keep responses short** — 1-2 sentences. Polly TTS truncates long responses.
- **End every call** — always call `end_call` when the conversation is finished. Abandoned calls stay open until they time out.
- **One active call at a time** — do not initiate a second call while one is in progress.

## Other actions

- `speak_to_user(callId, message)` — speak without waiting for a response (one-way announcement)
- `get_status(callId)` — check if the call is still active before continuing
