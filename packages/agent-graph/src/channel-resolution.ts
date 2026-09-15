/**
 * Effective channel resolution (ADR-034): a school's own `school_channels`
 * row wins when present; otherwise the org's `org_channels` default applies.
 * ADR-034 requires "one function, unit-tested" for this — this is that
 * function, shared so the orchestrator (Settings, publish-time flow lint) and
 * apps/agent-runtime (send-time) can never resolve a channel two different
 * ways.
 */

export interface ChannelRowState {
  readonly status: 'connected' | 'not_connected';
  readonly provider: string | null;
  readonly detail: string | null;
}

export interface EffectiveChannel extends ChannelRowState {
  /** Which level this resolved from — surfaced in Settings so an admin isn't
   * left guessing whether "Connected" means the trust default or their own
   * override (docs/07 §4). */
  readonly source: 'school' | 'org' | 'none';
}

export function resolveChannel(
  schoolRow: ChannelRowState | undefined,
  orgRow: ChannelRowState | undefined,
): EffectiveChannel {
  if (schoolRow !== undefined) return { ...schoolRow, source: 'school' };
  if (orgRow !== undefined) return { ...orgRow, source: 'org' };
  return { status: 'not_connected', provider: null, detail: null, source: 'none' };
}

/**
 * The reserved provider name marking a channel as demo/sandbox-only.
 *
 * -- Why this exists -----------------------------------------------------
 * No real BSP/SMTP relationship exists anywhere in this build yet (docs/11
 * §2 items 4/8 — still open, vendor-gated inputs). Without SOME way to reach
 * a genuinely "sent" run, the platform could never demonstrate — to a
 * stakeholder, or to itself in a test — that the guardrail → dedup → branch →
 * send pipeline is correct end to end; every run would dead-end at "provider
 * not connected" forever, which is honest but also untestable.
 *
 * A channel connected with provider `Sandbox` (case-insensitive) is real
 * state in `school_channels`/`org_channels` — same table, same columns, same
 * publish-time flow lint — but at send time apps/agent-runtime writes a
 * `message_log` row with status `sent` and a synthetic `provider_ref`
 * instead of calling a real BSP. It never claims a message left the
 * building: the audit trail's `provider_ref` is prefixed `sandbox-` so a
 * reader of message_log can never mistake one for a real delivery receipt.
 */
export const SANDBOX_PROVIDER = 'Sandbox';

export function isSandboxProvider(provider: string | null): boolean {
  return provider !== null && provider.trim().toLowerCase() === SANDBOX_PROVIDER.toLowerCase();
}
