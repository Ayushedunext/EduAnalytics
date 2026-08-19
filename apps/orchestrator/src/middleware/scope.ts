/**
 * Scope enforcement -- layer 1 of 2.
 *
 * Contract: Invariant 2 ("Scope is law") · ADR-007 · docs/08 §3.
 *
 * ADR-007 enforces scope twice: here in the orchestrator as business logic, and
 * again independently inside the MCP layer against an allowed set passed
 * out-of-band. Both call isWithinScope from @sap/shared, so they check the same
 * rule rather than two hand-rolled approximations of it -- two *different* checks
 * would be worse than one, because we would trust the pair more than either
 * deserves.
 *
 * This layer is not sufficient on its own and is not meant to be. The threat
 * model includes bugs in exactly this file (docs/08 §3), which is why the MCP
 * check exists and why it takes its allowed set from the session rather than
 * from anything this layer computed.
 */

import type { NextFunction, Request, Response } from 'express';
import {
  ERROR_CODES,
  PlatformError,
  isWithinScope,
  outOfScope,
  scopeViolation,
} from '@sap/shared';
import { auditSink } from '../db/audit.js';
import { effectiveScope } from '@sap/shared';
import { servableSchoolIds } from '../db/registry.js';

/**
 * Resolve which schools this request targets.
 *
 * `school_ids` may be supplied by the client, but only as a NARROWING selection:
 * it is validated as a subset of the session's scope and can never widen it. When
 * absent, the request targets the whole session scope.
 */
export async function resolveRequestedSchools(req: Request): Promise<string[]> {
  const session = req.session;
  if (session === undefined) {
    throw new PlatformError({
      code: ERROR_CODES.SESSION_INVALID,
      message: 'Please open Analytics from the ERP menu.',
      correlationId: req.correlationId,
    });
  }

  const raw = req.query['school_ids'];
  const requested =
    raw === undefined
      ? [...session.school_ids]
      : String(raw)
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '');

  if (!isWithinScope(requested, session.school_ids)) {
    // Audited because docs/08 §3 requires a rejected scope request to be logged:
    // an attempt to reach another school is exactly the event an auditor asks
    // about later.
    await auditSink.write({
      kind: 'scope.violation',
      at: new Date().toISOString(),
      actor_sub: session.sub,
      org_id: session.org_id,
      correlation_id: req.correlationId,
      requested,
      scope: session.school_ids,
      layer: 'orchestrator',
    });
    throw scopeViolation({
      requested,
      scope: session.school_ids,
      correlationId: req.correlationId,
    });
  }

  // docs/02 §6: a school that is missing from the registry or not active is
  // dropped from scope WITH A NOTICE, and the session proceeds for the rest.
  // Returning the dropped ids (rather than filtering silently) is what lets the
  // caller show that notice -- silent filtering is the success-shaped failure
  // CODING_GUIDELINES §10 calls the worst bug class here.
  const { effective, dropped } = effectiveScope(requested, await servableSchoolIds());

  if (effective.length === 0) {
    throw new PlatformError({
      code: ERROR_CODES.TENANT_UNAVAILABLE,
      message: 'None of the selected schools are available for analytics right now.',
      details: { dropped_count: dropped.length },
      diagnostics: { dropped },
      correlationId: req.correlationId,
    });
  }

  return [...effective];
}

/** Ids in a request that fell outside scope -- for logging, never for responses. */
export const outOfScopeIds = outOfScope;

export type ScopeResolver = (req: Request, res: Response, next: NextFunction) => void;
