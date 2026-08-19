/**
 * GET /api/home — the Home screen's data.
 *
 * Contract: docs/10 §2 (Home) · ADR-016 (predefined path; no AI tokens spent) ·
 * CODING_GUIDELINES §6 (resource-oriented under /api; report data returns
 * chart-spec).
 *
 * Scope is resolved by the orchestrator's own check first (middleware/scope.ts,
 * ADR-007 layer 1) and re-checked independently at the MCP layer. A `school_ids`
 * query parameter can only NARROW within the session; it can never widen it, and
 * an id outside the token is a 403 plus an audit row at both layers.
 *
 * Deliberately a GET with no side effects, per ADR-029 clause 3 — GET/HEAD
 * endpoints are side-effect-free by contract, which is what lets the CSRF token
 * be required only on mutating requests.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { ERROR_CODES, PlatformError } from '@sap/shared';
import { resolveRequestedSchools } from '../middleware/scope.js';
import { buildHomeSummary } from '../services/home.js';

export const homeRouter = Router();

homeRouter.get('/api/home', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    const session = req.session;
    if (session === undefined) {
      throw new PlatformError({
        code: ERROR_CODES.SESSION_INVALID,
        message: 'Please open Analytics from the ERP menu.',
        correlationId: req.correlationId,
      });
    }

    const schoolIds = await resolveRequestedSchools(req);

    const summary = await buildHomeSummary({
      session,
      schoolIds,
      correlationId: req.correlationId,
    });

    res.json(summary);
  })().catch(next);
});
