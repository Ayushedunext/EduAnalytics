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

  /**
   * The MCP server -- the only path to school data (ADR-006). Private network
   * only (docs/04 §6), so this is a loopback or VPC-internal address and never
   * a public hostname.
   */
  MCP_URL: z.string().url().default('http://127.0.0.1:3100/mcp'),

  /**
   * Signs the out-of-band call context the MCP server verifies (@sap/shared
   * mcp-context.ts). Deliberately distinct from SESSION_SECRET: the session
   * cookie and the MCP call context are different artifacts with different
   * lifetimes and audiences, and one compromised secret should not be two.
   */
  MCP_CONTEXT_SECRET: z.string().min(16, 'MCP_CONTEXT_SECRET must be at least 16 characters'),

  /**
   * The master key the BYOK vault encrypts org API keys under (ADR-017).
   * Base64 of exactly 32 bytes: `openssl rand -base64 32`.
   *
   * A third distinct secret, for the third distinct audience — the session
   * cookie is ours, the MCP context is between two of our services, and this
   * one guards someone else's billable credential. Rotating any of them must
   * not force rotating the others.
   *
   * In production this comes from KMS/Secrets Manager, which is what ADR-017
   * specifies; what matters either way is that it is never in the database that
   * holds the ciphertext.
   */
  AI_KEY_ENCRYPTION_KEY: z
    .string()
    .min(1, 'AI_KEY_ENCRYPTION_KEY is required (base64 of 32 random bytes)'),

  /**
   * How long to wait for the provider while validating a key (docs/05 §4.1's
   * live test call). Short: an admin is watching a spinner, and "we could not
   * reach Anthropic" is a more useful answer at 10 seconds than a correct one
   * at 60.
   */
  AI_VALIDATION_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  /**
   * Tier ① of the serving order (docs/09 §4). Loopback in development; a
   * VPC-internal address in production, never a public one — cached rows are
   * school data.
   */
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),

  /**
   * The print route Puppeteer loads (ADR-021). In development this is the Vite
   * dev server's `print.html`; in production it is the built SPA served from
   * wherever the bundle lives. It is CONFIGURATION, never a request parameter:
   * a caller who could choose the URL could make the platform's browser fetch
   * an arbitrary page and hand back a PDF of it.
   */
  PRINT_URL: z.string().url().default('http://localhost:5174/print.html'),

  /**
   * The whole render budget — navigation, layout and PDF generation each get
   * this long. Generous, because a Fee Defaulters export draws fifty table rows
   * and five charts, and a truncated PDF is worse than a slow one.
   */
  PDF_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  /**
   * docs/06 §2 puts predefined dashboards on a 5–15 minute TTL. Ten minutes is
   * the middle of that band: long enough that a class of readers opening the
   * same dashboard in a morning pay for one replica scan, short enough that a
   * fee collected before lunch shows up after it.
   */
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(600),

  /**
   * An escape hatch for debugging a data question without chasing a stale
   * entry. Off means every read goes to the replica — correct, just slower.
   */
  CACHE_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),

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

export const mcpContextSecret = new TextEncoder().encode(config.MCP_CONTEXT_SECRET);

/** True when cookies may be marked Secure (i.e. we are on HTTPS). */
export const isProduction = config.NODE_ENV === 'production';
