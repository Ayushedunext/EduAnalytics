/**
 * agent-runtime configuration. Same pattern as apps/orchestrator/src/config.ts
 * (CODING_GUIDELINES §12: env-driven tunables, validated once at boot).
 */

import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

const schema = z.object({
  PLATFORM_DB_HOST: z.string().default('127.0.0.1'),
  PLATFORM_DB_PORT: z.coerce.number().int().positive().default(3306),
  PLATFORM_DB_NAME: z.string().default('analytics_platform'),
  PLATFORM_DB_USER: z.string().min(1),
  PLATFORM_DB_PASSWORD: z.string(),

  /** Same private-network MCP endpoint the orchestrator calls (ADR-006). */
  MCP_URL: z.string().url().default('http://127.0.0.1:3100/mcp'),

  /** Must match the orchestrator's MCP_CONTEXT_SECRET — both sides sign/verify
   * the same out-of-band context artifact (@sap/shared mcp-context.ts). */
  MCP_CONTEXT_SECRET: z.string().min(16, 'MCP_CONTEXT_SECRET must be at least 16 characters'),

  /** BullMQ connection (CODING_GUIDELINES §23, decided 2026-09-15) — the
   * platform's existing Redis, a separate logical use from the result cache. */
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),

  /**
   * Default guardrails (ADR-025). Product-visible defaults, per-org/school
   * overrides are a later Settings screen (docs/07 §6 "per-agent settings");
   * these are the platform floor every agent inherits until then.
   */
  QUIET_HOURS_START: z.coerce.number().int().min(0).max(23).default(20),
  QUIET_HOURS_END: z.coerce.number().int().min(0).max(23).default(7),
  DAILY_MESSAGE_CAP_PER_SCHOOL: z.coerce.number().int().positive().default(2000),
  AUTO_PAUSE_AFTER_FAILURES: z.coerce.number().int().positive().default(5),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('[agent-runtime] invalid configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;

export const mcpContextSecret = new TextEncoder().encode(config.MCP_CONTEXT_SECRET);
