/**
 * Orchestrator configuration.
 *
 * CODING_GUIDELINES §12: tunables (pool sizes, TTLs, caps) are
 * environment-driven with the documented defaults -- not magic numbers scattered
 * through the code. Validated once at boot so a misconfigured deployment fails
 * on startup rather than on the first user request.
 *
 * [MANDATORY] §12: no secrets in code. Everything sensitive arrives from the
 * environment here, and in production from Secrets Manager.
 */

import { z } from 'zod';
import 'dotenv/config';

const schema = z.object({
  ORCHESTRATOR_PORT: z.coerce.number().int().positive().default(3000),

  /** Where the SPA runs. Used for CORS and the post-launch redirect. */
  SPA_ORIGIN: z.string().url().default('http://localhost:5173'),

  /**
   * Signs our own session cookie. Distinct from the ERP's signing key: the ERP
   * key is asymmetric and we only ever hold its public half (ADR-003), whereas
   * the session is ours end to end so a symmetric secret is appropriate.
   */
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),

  /** ADR-004: the analytics session deliberately outlives the 60s launch token. */
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(8),

  /** docs/02 §2: verified against the ERP's published JWKS, never a shared secret. */
  ERP_JWKS_URL: z.string().url(),
  ERP_ISSUER: z.string().min(1),

  PLATFORM_DB_HOST: z.string().default('127.0.0.1'),
  PLATFORM_DB_PORT: z.coerce.number().int().positive().default(3306),
  PLATFORM_DB_NAME: z.string().default('analytics_platform'),
  PLATFORM_DB_USER: z.string().min(1),
  PLATFORM_DB_PASSWORD: z.string(),

  /** docs/03 §2: registry lookups are cached ~5 minutes. */
  REGISTRY_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('[orchestrator] invalid configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;

/** True when cookies may be marked Secure (i.e. we are on HTTPS). */
export const isProduction = config.NODE_ENV === 'production';
