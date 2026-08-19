/**
 * POST /launch -- the SSO handshake.
 *
 * Contract: docs/02 §2 · ADR-003 (token) · ADR-004 (session) · ADR-029 (POST
 * transport) · docs/02 §6 (failure table).
 *
 * The four documented steps, in order:
 *   ① verify the signature against the ERP JWKS
 *   ② check exp, then consume the one-time nonce
 *   ③ issue our own 8-hour session
 *   ④ redirect to the SPA
 *
 * After this, the ERP is not contacted again for the session (ADR-004).
 */

import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { ERROR_CODES, PlatformError } from '@sap/shared';
import { config } from '../config.js';
import { verifyLaunchToken } from '../auth/jwks.js';
import { consumeNonce } from '../auth/nonce.js';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  csrfCookieOptions,
  issueSessionToken,
  sessionCookieOptions,
  sessionFromLaunchToken,
} from '../auth/session.js';

export const launchRouter = Router();

/**
 * A failure page rather than raw JSON.
 *
 * docs/02 §6: a bad launch is rejected with a "return to the ERP and reopen"
 * page. This is a top-level browser navigation, not an API call, so the user
 * needs something legible. "Fail loud, degrade soft" (PROJECT_CONTEXT §9.7) --
 * loud here, because a launch we cannot verify must never half-work.
 */
function failurePage(message: string, correlationId: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<title>Could not open Analytics</title>',
    '<style>body{font-family:system-ui,sans-serif;background:#f1f5f9;color:#032e36;',
    'display:flex;align-items:center;justify-content:center;height:100vh;margin:0}',
    '.card{background:#fff;border-radius:8px;padding:32px 36px;max-width:460px;',
    'box-shadow:0 1px 3px rgba(3,46,54,.12)}h1{font-size:18px;margin:0 0 10px}',
    'p{font-size:14px;line-height:1.55;color:#334155;margin:0 0 8px}',
    'code{font-size:11px;color:#64748b}</style></head><body><div class="card">',
    '<h1>Could not open Analytics</h1><p>' + esc(message) + '</p>',
    '<p>Please return to the ERP and open Analytics again.</p>',
    '<code>ref ' + esc(correlationId) + '</code>',
    '</div></body></html>',
  ].join('');
}

launchRouter.post('/launch', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      // ADR-029 clause 1: the token arrives in a form POST body, never a query
      // parameter. Reject a query-string token outright rather than accepting it
      // "just this once" -- accepting it would reintroduce the log exposure the
      // ADR exists to remove.
      if (req.query['token'] !== undefined) {
        throw new PlatformError({
          code: ERROR_CODES.LAUNCH_TOKEN_INVALID,
          message: 'Launch tokens must be sent by POST, not in the URL.',
          diagnostics: { reason: 'token supplied as query parameter' },
          correlationId: req.correlationId,
        });
      }

      const raw = (req.body as Record<string, unknown> | undefined)?.['token'];
      if (typeof raw !== 'string' || raw === '') {
        throw new PlatformError({
          code: ERROR_CODES.LAUNCH_TOKEN_INVALID,
          message: 'No launch token was supplied.',
          correlationId: req.correlationId,
        });
      }

      // ① signature + issuer + expiry, then ② claim-shape validation
      const { claims, expiresAt } = await verifyLaunchToken(raw);

      // ② one-time nonce. Consumed AFTER verification so an unverifiable token
      // cannot burn a nonce, and BEFORE the session is issued so a replay can
      // never produce a session.
      const fresh = await consumeNonce(claims.jti, expiresAt);
      if (!fresh) {
        throw new PlatformError({
          code: ERROR_CODES.LAUNCH_TOKEN_REPLAYED,
          message: 'This launch link has already been used.',
          diagnostics: { jti: claims.jti },
          correlationId: req.correlationId,
        });
      }

      // ③ our own session, plus the CSRF token the SPA will echo back
      const session = sessionFromLaunchToken(claims);
      const sessionToken = await issueSessionToken(session);
      const csrfToken = randomBytes(24).toString('base64url');

      res.cookie(SESSION_COOKIE, sessionToken, sessionCookieOptions());
      res.cookie(CSRF_COOKIE, csrfToken, csrfCookieOptions());

      console.log(
        JSON.stringify({
          level: 'info',
          event: 'launch.ok',
          correlation_id: req.correlationId,
          actor_sub: session.sub,
          org_id: session.org_id,
          role: session.role,
          school_count: session.school_ids.length,
        }),
      );

      // ④ 303 so the browser follows with GET and the token leaves the history
      res.redirect(303, config.SPA_ORIGIN);
    } catch (err) {
      const platformError =
        err instanceof PlatformError
          ? err
          : new PlatformError({
              code: ERROR_CODES.LAUNCH_TOKEN_INVALID,
              message: 'This launch link is not valid.',
              diagnostics: { reason: err instanceof Error ? err.message : String(err) },
              correlationId: req.correlationId,
            });

      console.error(
        JSON.stringify({
          level: 'warn',
          event: 'launch.rejected',
          code: platformError.code,
          correlation_id: req.correlationId,
          diagnostics: platformError.diagnostics ?? null,
        }),
      );

      res
        .status(platformError.httpStatus)
        .type('html')
        .send(failurePage(platformError.message, req.correlationId));
    }
  })().catch(next);
});
