/**
 * Scope enforcement — layer 2 of 2.
 *
 * Contract source: Invariant 2 ("Scope is law") · ADR-007 · docs/04 §3 rail 3 ·
 * docs/08 §3 · CODING_GUIDELINES §7/§8 [MANDATORY].
 *
 * ADR-007 enforces scope twice: once in the orchestrator as business logic, and
 * again here, independently, against a set that arrived out-of-band. Both call
 * `isWithinScope` from `@sap/shared`, because two *different* checks would be
 * worse than one — you would trust the pair more than either deserves. Same
 * rule, evaluated twice, in two processes, on two independently obtained copies
 * of the truth.
 *
 * What makes this copy independent is worth being precise about. The allowed set
 * is signed by the orchestrator, so this layer is not independent of an
 * orchestrator that lies. It IS independent of every other way the check can
 * fail: a bug in the orchestrator's own comparison, a UI that sends the wrong
 * ids, a report definition with a stale school list, an adversarial prompt that
 * talks the model into naming a school it heard about — none of those touch the
 * signed set, and all of them die here. Those are the failures docs/08 §3 lists,
 * and they are the realistic ones.
 *
 * [MANDATORY] The AI model never supplies tenant identifiers. A `school_id` in a
 * tool argument is the orchestrator's injection, and this module's job is to
 * prove it against the set that travelled outside the model's reach.
 */

import {
  isWithinScope,
  outOfScope,
  scopeViolation,
  ERROR_CODES,
  PlatformError,
  type AuditSink,
  type McpCallContext,
} from '@sap/shared';
import { config } from './config.js';

/**
 * Everything a tool handler is allowed to know about its caller.
 *
 * Built per request from the verified out-of-band context, and passed in rather
 * than read from ambient state: a handler that cannot reach a scope it was not
 * given cannot accidentally use a different one.
 */
export interface ToolContext {
  readonly call: McpCallContext;
  readonly audit: AuditSink;
}

/**
 * The ⊆ check, plus the audit event docs/08 §3 requires for a rejection.
 *
 * Returns the requested ids on success so a caller cannot use the check for its
 * truth value and then go on to use its own unvalidated list — the validated
 * value is the only thing handed back.
 */
export async function requireInScope(
  context: ToolContext,
  requested: readonly string[],
  tool: string,
): Promise<string[]> {
  if (isWithinScope(requested, context.call.school_ids)) return [...requested];

  /**
   * Audited before the throw, and awaited: an attempt to reach another school is
   * exactly the event an auditor asks about later, and a fire-and-forget write
   * racing a thrown error is how such events go missing.
   */
  await context.audit.write({
    kind: 'scope.violation',
    at: new Date().toISOString(),
    actor_sub: context.call.sub,
    org_id: context.call.org_id,
    correlation_id: context.call.correlation_id,
    requested: [...requested],
    scope: [...context.call.school_ids],
    layer: 'mcp',
  });

  console.error(
    JSON.stringify({
      level: 'error',
      event: 'scope.violation',
      layer: 'mcp',
      tool,
      correlation_id: context.call.correlation_id,
      actor_sub: context.call.sub,
      out_of_scope_count: outOfScope(requested, context.call.school_ids).length,
    }),
  );

  /**
   * The offending ids are deliberately absent from the client-visible error:
   * naming another tenant's identifier back to a caller who was not allowed to
   * ask about it is what CODING_GUIDELINES §6 forbids. They are in the audit row
   * and in `diagnostics`, where they belong.
   */
  throw scopeViolation({
    requested,
    scope: context.call.school_ids,
    correlationId: context.call.correlation_id,
  });
}

/**
 * ADR-011: at most 25 schools per fan-out, "beyond which the agent answers from
 * rollups or asks to narrow". The cap is a fleet-protection measure, so it is
 * checked here rather than trusted to the caller that chose the list.
 */
export function requireFanoutWithinCap(schoolIds: readonly string[]): void {
  if (schoolIds.length <= config.FANOUT_MAX_SCHOOLS) return;
  throw new PlatformError({
    code: ERROR_CODES.FANOUT_LIMIT_EXCEEDED,
    message:
      `A single query can span at most ${String(config.FANOUT_MAX_SCHOOLS)} schools. ` +
      'Narrow the selection, or ask for an aggregate.',
    details: { max_schools: config.FANOUT_MAX_SCHOOLS, requested: schoolIds.length },
  });
}
