/**
 * The error boundary.
 *
 * Contract: CODING_GUIDELINES §6 -- structured `{code, message, details?}` with
 * stable machine-readable codes; user-facing translation happens in the SPA.
 *
 * [MANDATORY] §6: "Never leak SQL, stack traces, hostnames, or another tenant's
 * identifiers in error payloads." That is enforced by construction rather than by
 * remembering: PlatformError.toWireError() drops `diagnostics`, and this handler
 * is the only place errors become responses. Diagnostics go to the operational
 * log, where operators need them and tenants cannot see them.
 */

import type { NextFunction, Request, Response } from 'express';
import { toPlatformError } from '@sap/shared';

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const platformError = toPlatformError(err, req.correlationId);

  // Operational log: full detail, including diagnostics. Never sent to a client.
  console.error(
    JSON.stringify({
      level: 'error',
      code: platformError.code,
      status: platformError.httpStatus,
      correlation_id: req.correlationId,
      method: req.method,
      path: req.path,
      actor_sub: req.session?.sub ?? null,
      message: platformError.message,
      diagnostics: platformError.diagnostics ?? null,
    }),
  );

  if (res.headersSent) return;
  res.status(platformError.httpStatus).json(platformError.toWireError());
}

/** 404 as a structured error, so clients never have to parse HTML. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    code: 'NOT_FOUND',
    message: 'No such endpoint.',
    correlation_id: req.correlationId,
  });
}
