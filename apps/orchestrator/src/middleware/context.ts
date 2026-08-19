/**
 * Request context: session, correlation id, scope.
 *
 * CODING_GUIDELINES §5: every request carries a correlation id propagated
 * through MCP calls, queue messages and logs. It is minted here so a single
 * user action can be traced across services and into the audit trail.
 */

import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ERROR_CODES, PlatformError } from '@sap/shared';
import { SESSION_COOKIE, readSessionToken, type SessionClaims } from '../auth/session.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      correlationId: string;
      session?: SessionClaims;
    }
  }
}

export function withCorrelationId(req: Request, _res: Response, next: NextFunction): void {
  req.correlationId = randomUUID();
  next();
}

/**
 * Require a valid session.
 *
 * [MANDATORY] CODING_GUIDELINES §8: never trust tenant/school/org ids, roles or
 * permissions from client input. The ONLY source is the verified launch token
 * carried into this session. Nothing downstream may read identity from a query
 * string, body or header.
 */
export async function requireSession(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const raw = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
  if (raw === undefined || raw === '') {
    next(
      new PlatformError({
        code: ERROR_CODES.SESSION_INVALID,
        message: 'Please open Analytics from the ERP menu.',
        correlationId: req.correlationId,
      }),
    );
    return;
  }
  try {
    req.session = await readSessionToken(raw);
    next();
  } catch (err) {
    next(err);
  }
}
