/**
 * Audit sink -- writes the docs/08 §7 chokepoint events to audit_log.
 *
 * [MANDATORY] CODING_GUIDELINES §13: audit writes are part of a feature's
 * definition of done, not a follow-up. Schools answer to parents and boards
 * ("prove the parent was informed at 10:31"; "who looked at this student's fee
 * detail"), so the trail has to exist from the first request the platform
 * serves.
 *
 * Note the two-stream rule (§13): this is the AUDIT stream. Operational logs go
 * to stdout and must never carry PII, SQL parameter values, tokens or keys. The
 * BYOK key and launch tokens are log-forbidden values in both.
 */

import type { AuditEvent, AuditSink } from '@sap/shared';
import { platformDb } from './platform-db.js';

/**
 * Fields promoted to columns for the queries auditors actually ask; the rest of
 * the event goes to `payload` as JSON.
 */
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
       * Deliberate trade-off, stated rather than hidden: an audit write failure
       * is logged loudly but does not fail the user's request.
       *
       * Failing the request would let a platform-DB hiccup take down reporting
       * for every tenant, and a self-inflicted outage is the larger harm. But
       * losing audit silently is also unacceptable, so this path screams. The
       * durable answer is a queue in front of the sink so writes survive the DB
       * being briefly unavailable; that belongs with the agent runtime's queue
       * work rather than being invented here.
       */
      console.error(
        `[audit] FAILED TO WRITE ${kind} for actor=${actor_sub} corr=${correlation_id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  },
};
