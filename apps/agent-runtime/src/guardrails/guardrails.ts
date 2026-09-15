/**
 * Platform-level guardrails (ADR-025) — "non-optional, enforced on every
 * agent", never a per-agent setting. Dedup is enforced separately and earlier,
 * as a database constraint (`agent_runs.uq_agent_run_dedup`, see
 * 0009_agents.sql and evaluator/trigger-evaluator.ts) rather than here — a
 * constraint the database itself refuses to violate is a stronger guarantee
 * than a check a code path could be missed from.
 *
 * [MANDATORY] CODING_GUIDELINES §11: a guardrail hit is a structured, logged
 * outcome, never a thrown error that kills the run loop — callers get a
 * `GuardrailOutcome`, not an exception.
 */

import { eq, and, gte, sql } from 'drizzle-orm';
import * as agentDbSchema from '@sap/agent-graph/db-schema';
import { db } from '../db/client.js';
import { config } from '../config.js';

export type GuardrailOutcome =
  | { readonly blocked: false }
  | { readonly blocked: true; readonly reason: 'quiet_hours' | 'daily_cap' };

/**
 * Quiet hours (default 20:00–07:00, docs/07 §5). Evaluated against the
 * school's own timezone once schools carry one in the registry; until then,
 * `Asia/Kolkata` is the platform-wide default every reference example in the
 * doc set assumes (docs/07 §1's "school TZ" schedules, docs/03).
 */
function isQuietHoursNow(): boolean {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(
      new Date(),
    ),
  );
  const { QUIET_HOURS_START: start, QUIET_HOURS_END: end } = config;
  // Wraps midnight: e.g. start=20, end=7 means quiet from 20:00 through 06:59.
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

async function todaysSentCount(schoolId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(agentDbSchema.messageLog)
    .where(
      and(
        eq(agentDbSchema.messageLog.schoolId, schoolId),
        eq(agentDbSchema.messageLog.status, 'sent'),
        gte(agentDbSchema.messageLog.sentAt, sql`CURDATE()`),
      ),
    );
  return Number(row?.n ?? 0);
}

export async function checkGuardrails(args: { schoolId: string }): Promise<GuardrailOutcome> {
  if (isQuietHoursNow()) return { blocked: true, reason: 'quiet_hours' };

  const sentToday = await todaysSentCount(args.schoolId);
  if (sentToday >= config.DAILY_MESSAGE_CAP_PER_SCHOOL) {
    return { blocked: true, reason: 'daily_cap' };
  }

  return { blocked: false };
}

/**
 * Auto-pause after N consecutive failed RUNS (ADR-025), tracked on the agent
 * row itself so it survives a restart (persisted state, not an in-memory
 * counter — the same reasoning ADR-022 gives for runs generally).
 */
export async function recordRunOutcome(agentId: string, succeeded: boolean): Promise<void> {
  if (succeeded) {
    await db.update(agentDbSchema.agents).set({ consecutiveFailures: 0 }).where(eq(agentDbSchema.agents.id, agentId));
    return;
  }

  const [agent] = await db
    .select({ consecutiveFailures: agentDbSchema.agents.consecutiveFailures })
    .from(agentDbSchema.agents)
    .where(eq(agentDbSchema.agents.id, agentId));
  const next = (agent?.consecutiveFailures ?? 0) + 1;

  await db
    .update(agentDbSchema.agents)
    .set({
      consecutiveFailures: next,
      ...(next >= config.AUTO_PAUSE_AFTER_FAILURES ? { status: 'paused' as const } : {}),
    })
    .where(eq(agentDbSchema.agents.id, agentId));

  if (next >= config.AUTO_PAUSE_AFTER_FAILURES) {
    console.error(`[agent-runtime] agent ${agentId} auto-paused after ${next} consecutive failed runs`);
  }
}
