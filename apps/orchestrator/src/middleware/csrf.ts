/**
 * CSRF protection -- double-submit token.
 *
 * Contract: ADR-029 clause 3 · docs/02 §4 · docs/08 §2.
 *
 * Why not rely on SameSite alone: iframe embedding is a supported mode
 * (docs/02 §4) and it REQUIRES SameSite=None, which removes cookie-based
 * protection in exactly the deployment that most needs it. So the check here is
 * independent of cookie policy -- a value readable by the SPA in a cookie must be
 * echoed in a request header, and an attacker on another origin can do the
 * second but not the first.
 *
 * POST /launch is deliberately EXEMPT. It is a cross-site form POST from the ERP
 * by design (ADR-029 clause 1), so no CSRF token can exist yet -- there is no
 * session. Its protection is different in kind: the request is worthless without
 * a valid, unexpired, single-use, ERP-signed token, which an attacker cannot mint.
 */

import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ERROR_CODES, PlatformError } from '@sap/shared';
import { CSRF_COOKIE, CSRF_HEADER } from '../auth/session.js';

/** GET/HEAD/OPTIONS are side-effect-free by contract (ADR-029 clause 3). */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function equal(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // Length must be compared separately: timingSafeEqual throws on a mismatch.
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function requireCsrfToken(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  const cookie = (req.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];
  const header = req.get(CSRF_HEADER);

  if (cookie === undefined || header === undefined || !equal(cookie, header)) {
    next(
      new PlatformError({
        code: ERROR_CODES.CSRF_CHECK_FAILED,
        message: 'Your request could not be verified. Please refresh and try again.',
        diagnostics: { hasCookie: cookie !== undefined, hasHeader: header !== undefined },
        correlationId: req.correlationId,
      }),
    );
    return;
  }
  next();
}
