/**
 * MCP server configuration.
 *
 * CODING_GUIDELINES §12: tunables (pool sizes, TTLs, caps, rate limits) are
 * environment-driven with the documented defaults -- "not magic numbers
 * scattered in code" -- and §7 adds specifically that "pool/limit tuning is
 * config, not code constants". Validated once at boot so a misconfigured
 * deployment fails on startup rather than on the first tenant's first query.
 *
 * [MANDATORY] §12: no secrets in code. School-DB credentials arrive from AWS
 * Secrets Manager in production (see db/secrets.ts); the environment variables
 * here are the local development resolver for the registry's `env://` ARNs.
 */

import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import dotenv from 'dotenv';

/**
 * The repo-root `.env`, named explicitly.
 *
 * `import 'dotenv/config'` resolves `.env` against the process working
 * directory, and `npm run -w <workspace>` runs a script FROM the workspace
 * directory — so the bare import silently finds nothing and the service dies at
 * boot claiming every variable is unset. Naming the file relative to this module
 * makes local startup independent of where it was started from. Production
 * configuration comes from the environment and Secrets Manager, where there is
 * no `.env` to find and this is a no-op.
 */
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

const schema = z.object({
  /** docs/04 §6: private network only. Bound to loopback by default. */
  MCP_PORT: z.coerce.number().int().positive().default(3100),
  MCP_BIND_HOST: z.string().default('127.0.0.1'),

  /**
   * Shared with the orchestrator, which signs the out-of-band call context
   * (@sap/shared mcp-context.ts). Distinct from SESSION_SECRET: the session
   * cookie and the MCP context are different artifacts with different
   * lifetimes and audiences, and one compromised secret should not be two.
   */
  MCP_CONTEXT_SECRET: z.string().min(16, 'MCP_CONTEXT_SECRET must be at least 16 characters'),

  /** The platform DB -- registry reads and audit writes. Never school data. */
  PLATFORM_DB_HOST: z.string().default('127.0.0.1'),
  PLATFORM_DB_PORT: z.coerce.number().int().positive().default(3306),
  PLATFORM_DB_NAME: z.string().default('analytics_platform'),
  PLATFORM_DB_USER: z.string().min(1),
  PLATFORM_DB_PASSWORD: z.string(),

  /**
   * Local resolver for the registry's `env://SCHOOL_DB_CREDENTIALS` secret
   * reference (db/platform/seed/stmarks.sql). In production the registry holds
   * a real Secrets Manager ARN and these are unset.
   *
   * [MANDATORY] ADR-008: this must be the per-school read-only user. The server
   * verifies its own grants at boot (db/execute.ts) rather than trusting the
   * name -- "analytics_ro" in a variable proves nothing.
   */
  SCHOOL_DB_USER: z.string().min(1),
  SCHOOL_DB_PASSWORD: z.string(),
  SCHOOL_DB_PORT: z.coerce.number().int().positive().default(3306),

  /** docs/03 §2: registry cache ~5 min, secrets cache ~10 min. */
  REGISTRY_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  SECRET_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(600),

  /** docs/03 §3: connectionLimit 3, ~200-pool LRU, 10-min idle sweep. */
  POOL_CONNECTION_LIMIT: z.coerce.number().int().positive().default(3),
  POOL_LRU_MAX: z.coerce.number().int().positive().default(200),
  POOL_IDLE_SWEEP_SECONDS: z.coerce.number().int().positive().default(600),

  /** ADR-008 caps. Changing these is an architecture change, not a tuning knob. */
  ROW_CAP: z.coerce.number().int().positive().default(5000),
  QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  /** ADR-011 fan-out caps. */
  FANOUT_MAX_SCHOOLS: z.coerce.number().int().positive().default(25),
  FANOUT_CONCURRENCY: z.coerce.number().int().positive().default(10),

  /** docs/04 §3 rail 4: per-tenant rate limit. docs/03 §6: fairness. */
  RATE_LIMIT_QUERIES_PER_MINUTE: z.coerce.number().int().positive().default(120),

  /** docs/04 §3 rail 5: fail fast for 60 s on a down/slow school. */
  BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  BREAKER_OPEN_SECONDS: z.coerce.number().int().positive().default(60),

  /** docs/03 §5: dimension metadata is per school, daily TTL. */
  DIMENSIONS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('[mcp] invalid configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;

export const contextSecret = new TextEncoder().encode(config.MCP_CONTEXT_SECRET);
