/**
 * The audit sink — docs/04 §3 rail 7, docs/08 §7.
 *
 * [MANDATORY] CODING_GUIDELINES §13: the audit trail is part of a feature's
 * definition of done, not a follow-up. The MCP server is the chokepoint every
 * school-data read passes through (ADR-006), which makes it the only place where
 * "every executed SQL — statement, school_id, caller, rows returned, duration"
 * can be recorded once and completely. If this layer does not write it, no
 * layer can.
 *
 * Two events originate here:
 *   `sql.executed`    — one per statement actually run against a school replica
 *   `scope.violation` — one per request for a school outside the allowed set,
 *                       tagged `layer: 'mcp'` so the two independent checks of
 *                       ADR-007 are distinguishable in the trail. A violation
 *                       reaching THIS layer means the orchestrator's check did
 *                       not fire, which is a materially different incident from
 *                       one caught upstream, and the trail has to be able to say
 *                       which happened.
 *
 * The statement recorded is the REWRITTEN one — what actually ran, including the
 * injected tenant filter and the cap. An audit of the text a caller submitted
 * would not answer the question an auditor is really asking, which is what the
 * database was asked to do.
 *
 * Two streams, never mixed (§13). This is the AUDIT stream. Operational logs go
 * to stdout and carry no PII, no SQL parameter values, no tokens, no keys.
 */

import type { AuditEvent, AuditSink } from '@sap/shared';
import { platformDb } from './db/platform-db.js';

function schoolIdsOf(event: AuditEvent): string[] | null {
  if ('school_ids' in event) return [...event.school_ids];
  if ('school_id' in event) return [event.school_id];
  if (event.kind === 'scope.violation') return [...event.requested];
  return null;
}

export const auditSink: AuditSink = {
  async write(event: AuditEvent): Promise<void> {
    const { at, actor_sub, org_id, correlation_id, kind, ...rest } = event;
    try {
      await platformDb.execute(
        `INSERT INTO audit_log (at, kind, actor_sub, org_id, correlation_id, school_ids, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          new Date(at),
          kind,
          actor_sub,
          org_id,
          correlation_id,
          JSON.stringify(schoolIdsOf(event)),
          JSON.stringify(rest),
        ],
      );
    } catch (err) {
      /**
       * Same deliberate trade-off the orchestrator's sink states, and stated
       * again rather than assumed: a failed audit write is screamed about but
       * does not fail the user's request, because a platform-DB hiccup taking
       * reporting down for every tenant is the larger harm. The durable answer
       * is a queue in front of the sink; it belongs with the agent runtime's
       * queue work rather than being invented here.
       */
      console.error(
        `[mcp:audit] FAILED TO WRITE ${kind} for actor=${actor_sub} corr=${correlation_id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  },
};
