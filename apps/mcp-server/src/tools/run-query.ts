/**
 * `run_query(school_id, sql)` — docs/04 §2.
 *
 * A single-school SELECT against that school's read replica. AST-validated,
 * tenant-filtered, row-capped at 5,000, time-capped at 10 s, rate-limited,
 * masked and audited — all of it in `runScopedSelect`, none of it optional.
 *
 * -- On `school_id` being a tool argument ------------------------------------
 * Invariant 2 says the AI model never supplies tenant identifiers, and this tool
 * takes one. Both are true, and the reconciliation is the point of ADR-007: the
 * argument is the ORCHESTRATOR's injection, and the ALLOWED SET travels
 * out-of-band where nothing the model writes can reach it. So the id in this
 * argument is a selection among schools the session already holds, and the first
 * thing this handler does is prove it against that set. An id the model
 * hallucinated, or one an injected prompt talked it into, fails that proof and
 * becomes a `scope.violation` audit row.
 *
 * -- No parameters, by contract ----------------------------------------------
 * docs/04 §2 gives this tool two arguments. Statements carry their own literal
 * values; bound parameters enter through `run_predefined` and the drill endpoint
 * (ADR-020), whose SQL the platform authors. The guard relies on that — see the
 * note in sql/guard.ts on why every placeholder in the final statement must be
 * one the server injected.
 */

import { z } from 'zod';
import { safeIdSchema } from '@sap/shared';
import { runScopedSelect } from '../query-service.js';
import { requireInScope, type ToolContext } from '../scope.js';
import { ok } from './result.js';

const TOOL = 'run_query';

export const runQueryInput = {
  school_id: safeIdSchema.describe(
    'A school from the session scope. Selects among the schools the session already holds; it cannot reach any other.',
  ),
  sql: z
    .string()
    .min(1)
    .describe(
      'One MySQL SELECT statement against the tables in get_schema. Do not filter on school_db or any database name, do not qualify tables with a database, and do not use placeholders — the server adds the tenant filter and the row cap.',
    ),
} satisfies z.ZodRawShape;

export async function runQuery(
  context: ToolContext,
  args: { school_id: string; sql: string },
): Promise<ReturnType<typeof ok>> {
  const [schoolId] = await requireInScope(context, [args.school_id], TOOL);
  if (schoolId === undefined) throw new Error('unreachable: scope check returned no school');

  const outcome = await runScopedSelect({
    context,
    schoolId,
    sql: args.sql,
    tool: TOOL,
  });

  return ok(outcome);
}
