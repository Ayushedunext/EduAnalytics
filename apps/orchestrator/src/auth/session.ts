/**
 * The platform's own session.
 *
 * Contract: docs/02 §2 step ③ · ADR-004 (independent 8-hour session) ·
 * ADR-029 clause 3 (cookie flags) · docs/08 §2.
 *
 * ADR-004: after verification the platform issues its own session and never
 * contacts the ERP again for its lifetime. That is the zero-load rule applied to
 * auth -- an ERP outage must not log analytics users out mid-analysis, and no
 * user request may put the ERP in the latency path.
 *
 * Stateless by design (docs/01 §5): the session is a signed JWT in an httpOnly
 * cookie, so any orchestrator instance can serve any request and a restart logs
 * nobody out. The trade-off ADR-004 accepts explicitly: a role change in the ERP
 * takes effect at next launch, and instant revocation is out of scope for v1
 * (assumption A4; the extensibility path is a `user_disabled` webhook).
 */

import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { ERROR_CODES, PlatformError, ROLES, permissionClass } from '@sap/shared';
import type { LaunchTokenClaims } from '@sap/shared';
import { config, isProduction } from '../config.js';

export const SESSION_COOKIE = 'sap_session';
/** Readable by JS on purpose -- the double-submit half of ADR-029 clause 3. */
export const CSRF_COOKIE = 'sap_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const secret = new TextEncoder().encode(config.SESSION_SECRET);

/**
 * What we carry in the session.
 *
 * A launch-time snapshot of identity and scope. Note `permission_class` is
 * computed once here rather than per request: it must be identical for every
 * request in a session or cache entries would fragment (ADR-028), and deriving
 * it in one place is what guarantees that.
 */
const sessionClaimsSchema = z
  .object({
    sub: z.string().min(1),
    name: z.string().min(1),
    role: z.enum(ROLES),
    org_id: z.string().min(1),
    /** Immutable for the session -- scope comes only from the token (docs/00). */
    school_ids: z.array(z.string().min(1)).min(1),
    default_school: z.string().min(1),
    perms: z.array(z.string()),
    permission_class: z.string().min(1),
  })
  .strict();

export type SessionClaims = z.infer<typeof sessionClaimsSchema>;

export function sessionFromLaunchToken(claims: LaunchTokenClaims): SessionClaims {
  return {
    sub: claims.sub,
    name: claims.name,
    role: claims.role,
    org_id: claims.org_id,
    school_ids: [...claims.school_ids],
    default_school: claims.default_school,
    perms: [...claims.perms],
    permission_class: permissionClass(claims),
  };
}

export async function issueSessionToken(session: SessionClaims): Promise<string> {
  return new SignJWT({ ...session })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(`${config.SESSION_TTL_HOURS}h`)
    .sign(secret);
}

export async function readSessionToken(raw: string): Promise<SessionClaims> {
  try {
    const { payload } = await jwtVerify(raw, secret, { algorithms: ['HS256'] });
    // Strip the JWT envelope. iat/exp/nbf/iss/aud/sub-as-jwt-claim are the
    // transport's own fields, verified by jwtVerify above; they are not part of
    // our session contract, and the schema is .strict() precisely so an unknown
    // claim is refused rather than silently carried into the session.
    const {
      iat: _iat,
      exp: _exp,
      nbf: _nbf,
      iss: _iss,
      aud: _aud,
      ...sessionFields
    } = payload as Record<string, unknown>;
    const parsed = sessionClaimsSchema.safeParse(sessionFields);
    if (!parsed.success) {
      throw new PlatformError({
        code: ERROR_CODES.SESSION_INVALID,
        message: 'Your session is no longer valid. Please reopen Analytics from the ERP.',
        diagnostics: { issues: parsed.error.issues.map((i) => i.path.join('.')) },
      });
    }
    return parsed.data;
  } catch (err) {
    if (err instanceof PlatformError) throw err;
    throw new PlatformError({
      code: ERROR_CODES.SESSION_INVALID,
      message: 'Your session is no longer valid. Please reopen Analytics from the ERP.',
      diagnostics: { reason: err instanceof Error ? err.message : String(err) },
      cause: err,
    });
  }
}

/**
 * Cookie options per ADR-029 clause 3 and docs/08 §2.
 *
 * SameSite=Lax suits the default new-tab embedding. Iframe embedding forces
 * SameSite=None (docs/02 §4), which is precisely why CSRF protection here does
 * NOT rely on cookie policy: the double-submit token below is independent of it,
 * so the iframe mode is not a security regression.
 *
 * `secure` is conditional only because http://localhost cannot set Secure
 * cookies. Any deployed environment is production and gets Secure.
 */
export function sessionCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: config.SESSION_TTL_HOURS * 60 * 60 * 1000,
  };
}

/** Readable by the SPA, which must echo it in a header. Not httpOnly by design. */
export function csrfCookieOptions(): {
  httpOnly: false;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: false,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: config.SESSION_TTL_HOURS * 60 * 60 * 1000,
  };
}
