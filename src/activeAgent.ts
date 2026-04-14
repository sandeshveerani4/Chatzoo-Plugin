/**
 * Holds the active agent soul for this OpenClaw instance.
 *
 * Set by the inbound webhook handler whenever the gateway includes an
 * `activeSoulMd` field in the request body.
 * Read by the `before_prompt_build` hook to override the system prompt so
 * the active agent persona takes effect without any SOUL.md file writes.
 */

let _activeSoulMd: string | null = null;

export function setActiveSoulMd(soul: string | null): void {
  _activeSoulMd = soul ?? null;
}

export function getActiveSoulMd(): string | null {
  return _activeSoulMd;
}
