/**
 * Tenant resolution, step 2: credentials.
 *
 * Contract source: docs/03 §2 (Secrets Manager fetch by ARN, ~10 min cache) ·
 * ADR-013 ("the registry stores only the ARN pointer") · CODING_GUIDELINES §12
 * [MANDATORY] (no hard-coded secrets anywhere, including tests and scripts).
 *
 * ADR-013 §Future impact says IAM-token auth "can replace passwords
 * school-by-school inside one resolution function". This is that function. It is
 * the only place in the platform that turns a secret reference into a usable
 * credential, which is what makes the swap a local change rather than a survey
 * of every call site.
 *
 * Local development resolves the `env://NAME` scheme used by the seed data
 * (db/platform/seed/stmarks.sql). Production ARNs (`arn:aws:secretsmanager:…`)
 * are not implemented in this slice and are refused loudly rather than silently
 * falling back to the development credentials — a fallback that "worked" in
 * production would mean every tenant sharing one database user, which is exactly
 * what ADR-013 rejects.
 */

import { ERROR_CODES, PlatformError } from '@sap/shared';
import { config } from '../config.js';

export interface SchoolCredentials {
  readonly user: string;
  readonly password: string;
}

interface CacheEntry {
  credentials: SchoolCredentials;
  loadedAt: number;
}

const cache = new Map<string, CacheEntry>();

const isFresh = (entry: CacheEntry): boolean =>
  (Date.now() - entry.loadedAt) / 1000 < config.SECRET_CACHE_TTL_SECONDS;

/**
 * Never logged, never returned to a caller, never attached to an error. The
 * credential exists between this function and the pool constructor and nowhere
 * else (CODING_GUIDELINES §12/§13).
 */
export async function resolveCredentials(secretArn: string): Promise<SchoolCredentials> {
  const cached = cache.get(secretArn);
  if (cached !== undefined && isFresh(cached)) return cached.credentials;

  const credentials = await fetchCredentials(secretArn);
  cache.set(secretArn, { credentials, loadedAt: Date.now() });
  return credentials;
}

async function fetchCredentials(secretArn: string): Promise<SchoolCredentials> {
  if (secretArn === 'env://SCHOOL_DB_CREDENTIALS') {
    return { user: config.SCHOOL_DB_USER, password: config.SCHOOL_DB_PASSWORD };
  }
  throw new PlatformError({
    code: ERROR_CODES.TENANT_UNAVAILABLE,
    message: 'This school is temporarily unavailable for analytics.',
    diagnostics: {
      reason: 'unsupported secret reference scheme',
      // The ARN itself is a pointer, not a secret, but it names infrastructure;
      // only its scheme is recorded.
      scheme: secretArn.split(':')[0] ?? '<none>',
    },
  });
}

export function clearSecretCache(): void {
  cache.clear();
}
