/**
 * Launch-token verification against the ERP's published JWKS.
 *
 * Contract: docs/02 §2 step ① · ADR-003.
 *
 * Asymmetric signing means the platform holds only the ERP's PUBLIC key, so
 * nothing this service stores can forge a launch token. Key selection is by
 * `kid`, which is what makes ERP key rotation a non-event for us.
 *
 * docs/02 §6 on failure: retry against the cached JWKS (keys cached with
 * rotation grace); if a cold cache fails, the launch fails LOUDLY -- never
 * "verify later". A token we could not verify is a token we must not trust, and
 * degrading to acceptance here would defeat the entire identity model.
 */

import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import {
  ERROR_CODES,
  PlatformError,
  parseLaunchTokenClaims,
  type LaunchTokenClaims,
} from '@sap/shared';
import { config } from '../config.js';

/**
 * jose caches the fetched key set and refetches when it sees an unknown `kid`,
 * which is exactly the rotation-grace behaviour docs/02 §6 asks for.
 */
const jwks = createRemoteJWKSet(new URL(config.ERP_JWKS_URL), {
  cooldownDuration: 30_000,
  timeoutDuration: 5_000,
});

export interface VerifiedLaunchToken {
  claims: LaunchTokenClaims;
  /** Token expiry, used to bound how long its nonce must be remembered. */
  expiresAt: Date;
}

/**
 * Verify a raw launch token and return validated claims.
 *
 * Two distinct checks, deliberately separate:
 *   1. jose verifies the SIGNATURE, issuer and expiry -- is this really from the
 *      ERP, and is it still live?
 *   2. parseLaunchTokenClaims validates the CONTENT against the shared contract.
 *
 * A signature proves authenticity, never content (CODING_GUIDELINES §3: external
 * input is `unknown` until validated). A correctly-signed token carrying a
 * malformed school_id is still a token we must refuse -- which is also what stops
 * an injected identifier from entering the system on the strength of a valid
 * signature.
 */
export async function verifyLaunchToken(raw: string): Promise<VerifiedLaunchToken> {
  let payload: Record<string, unknown>;
  let exp: number | undefined;

  try {
    const result = await jwtVerify(raw, jwks, {
      issuer: config.ERP_ISSUER,
      algorithms: ['RS256'],
      // Tolerate a little clock skew: ADR-003 notes the 60-second window must
      // survive it, and a demo machine's clock is not NTP-perfect.
      clockTolerance: 5,
    });
    payload = result.payload as Record<string, unknown>;
    exp = result.payload.exp;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      throw new PlatformError({
        code: ERROR_CODES.LAUNCH_TOKEN_EXPIRED,
        message: 'This launch link has expired. Return to the ERP and open Analytics again.',
        diagnostics: { reason: 'jwt expired' },
      });
    }
    if (err instanceof joseErrors.JWKSNoMatchingKey || err instanceof joseErrors.JWKSTimeout) {
      throw new PlatformError({
        code: ERROR_CODES.JWKS_UNAVAILABLE,
        message: 'Could not reach the ERP to verify your sign-in. Please try again.',
        diagnostics: { reason: err.constructor.name },
        cause: err,
      });
    }
    throw new PlatformError({
      code: ERROR_CODES.LAUNCH_TOKEN_INVALID,
      message: 'This launch link is not valid. Return to the ERP and open Analytics again.',
      diagnostics: { reason: err instanceof Error ? err.message : String(err) },
      cause: err,
    });
  }

  // `iss` is verified above but is not part of our claim contract; strip it so
  // the strict schema does not reject an otherwise valid token.
  const { iss: _iss, ...claims } = payload;

  const parsed = parseLaunchTokenClaims(claims);
  if (!parsed.ok) {
    throw new PlatformError({
      code: ERROR_CODES.LAUNCH_TOKEN_INVALID,
      message: 'This launch link is not valid. Return to the ERP and open Analytics again.',
      // The issues name claim paths, not values -- a malformed claim may be
      // hostile, and §6 forbids echoing another tenant's identifiers.
      diagnostics: { issues: parsed.issues },
    });
  }

  if (exp === undefined) {
    throw new PlatformError({
      code: ERROR_CODES.LAUNCH_TOKEN_INVALID,
      message: 'This launch link is not valid. Return to the ERP and open Analytics again.',
      diagnostics: { reason: 'missing exp' },
    });
  }

  return { claims: parsed.claims, expiresAt: new Date(exp * 1000) };
}
