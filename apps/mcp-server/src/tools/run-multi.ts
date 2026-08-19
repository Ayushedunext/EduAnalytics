/**
 * `run_multi(school_ids[], sql, merge)` — docs/04 §2, ADR-011.
 *
 * The same SELECT on each selected school's replica in parallel, rows tagged
 * with `school_id`, merged. Latency is the slowest single school rather than the
 * sum, which is what makes a trust-wide row-level question feel like a
 * single-school one.
 *
 * -- The caps are the point --------------------------------------------------
 * ADR-011 fixes concurrency at ~10 and the fan-out at ≤25 schools, and both are
 * fleet protection rather than tuning. A 300-school row-level scan is exactly the
 * query the Rollup Store exists to answer instead (ADR-010), so beyond the cap
 * the honest answer is a refusal that says so, not a slow success.
 *
 * -- Partial failure is a result, not an error -------------------------------
 * ADR-011 and CODING_GUIDELINES §6 both make this a first-class shape: one
 * unreachable school annotates the response ("Noida temporarily unreachable")
 * and the rest of the report renders. Failing the whole request because one
 * replica is slow would make a trust's dashboard only as available as its least
 * available school. The annotation is explicit in the payload rather than an
 * absent row, so a Director sees "3 of 4 schools" rather than a total that
 * quietly shrank — the §10 rule about success-shaped failures.
 *
 * Scope is checked ONCE for the whole set, before any work starts. Checking per
 * school inside the fan-out would let an out-of-scope id fail late, after the
 * in-scope ones had already been queried.
 */

import { z } from 'zod';
import { safeIdSchema, toPlatformError } from '@sap/shared';
import { config } from '../config.js';
import type { QueryOutcome } from '../db/execute.js';
import { runScopedSelect } from '../query-service.js';
import { requireFanoutWithinCap, requireInScope, type ToolContext } from '../scope.js';
import { ok } from './result.js';

const TOOL = 'run_multi';

export const runMultiInput = {
  school_ids: z
    .array(safeIdSchema)
    .min(1)
    .describe('Schools from the session scope. At most 25 per call.'),
  sql: z
    .string()
    .min(1)
    .describe(
      'One MySQL SELECT, run unchanged against each school. Same rules as run_query: no tenant filter, no database qualification, no placeholders.',
    ),
  /**
   * Present because docs/04 §2 names it. One mode is implemented: rows tagged
   * with their school and concatenated. Server-side aggregate merges belong with
   * the Rollup Store work (ADR-010), and offering a mode that silently degraded
   * to concatenation would be worse than not offering it.
   */
  merge: z
    .enum(['tagged_union'])
    .optional()
    .describe('How results combine. Only tagged_union is available: each row carries its school_id.'),
} satisfies z.ZodRawShape;

interface SchoolStatus {
  readonly school_id: string;
  readonly status: 'ok' | 'failed';
  readonly rows?: number;
  readonly truncated?: boolean;
  readonly duration_ms?: number;
  readonly error?: { readonly code: string; readonly message: string };
}

export async function runMulti(
  context: ToolContext,
  args: { school_ids: string[]; sql: string; merge?: 'tagged_union' | undefined },
): Promise<ReturnType<typeof ok>> {
  const schoolIds = await requireInScope(context, args.school_ids, TOOL);
  requireFanoutWithinCap(schoolIds);

  const settled = await mapWithConcurrency(schoolIds, config.FANOUT_CONCURRENCY, async (schoolId) =>
    runScopedSelect({ context, schoolId, sql: args.sql, tool: TOOL }),
  );

  const rows: Record<string, unknown>[] = [];
  const perSchool: SchoolStatus[] = [];
  const maskedColumns = new Set<string>();
  let columns: readonly string[] = [];
  let truncated = false;

  for (const [index, result] of settled.entries()) {
    const schoolId = schoolIds[index]!;
    if (result.ok) {
      const outcome: QueryOutcome = result.value;
      if (columns.length === 0) columns = outcome.columns;
      for (const column of outcome.masked_columns) maskedColumns.add(column);
      // Tagged, so a merged table can always say which school a row came from
      // (ADR-011). Written first so a colliding result column cannot hide it.
      for (const row of outcome.rows) rows.push({ school_id: schoolId, ...row });
      truncated ||= outcome.truncated;
      perSchool.push({
        school_id: schoolId,
        status: 'ok',
        rows: outcome.rows.length,
        truncated: outcome.truncated,
        duration_ms: outcome.duration_ms,
      });
      continue;
    }

    const platformError = toPlatformError(result.error, context.call.correlation_id);
    console.error(
      JSON.stringify({
        level: 'error',
        service: 'mcp',
        tool: TOOL,
        event: 'fanout.partial_failure',
        school_id: schoolId,
        code: platformError.code,
        correlation_id: context.call.correlation_id,
        diagnostics: platformError.diagnostics ?? null,
      }),
    );
    perSchool.push({
      school_id: schoolId,
      status: 'failed',
      // The wire error only — diagnostics carry hostnames and driver text.
      error: { code: platformError.code, message: platformError.message },
    });
  }

  /**
   * The merged cap. Each school was already capped individually; without this a
   * 25-school fan-out could return 125,000 rows and blow every downstream
   * budget the 5,000-row cap exists to protect.
   */
  const mergedTruncated = rows.length > config.ROW_CAP;

  return ok({
    school_ids: schoolIds,
    merge: args.merge ?? 'tagged_union',
    columns: columns.length === 0 ? [] : ['school_id', ...columns],
    rows: mergedTruncated ? rows.slice(0, config.ROW_CAP) : rows,
    truncated: truncated || mergedTruncated,
    masked_columns: [...maskedColumns],
    /** Always present, even when everything succeeded, so callers render it. */
    per_school: perSchool,
    schools_succeeded: perSchool.filter((s) => s.status === 'ok').length,
    schools_failed: perSchool.filter((s) => s.status === 'failed').length,
    as_of: new Date().toISOString(),
  });
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * A bounded worker pool rather than `Promise.all`.
 *
 * `Promise.all` over 25 schools would open 25 connections at once, which is the
 * noisy-neighbour behaviour docs/08 §8 exists to prevent — and it rejects on the
 * first failure, which would discard the results of schools that answered fine.
 * Failures are captured per item instead and reported as partial success.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<Settled<R>[]> {
  const results = new Array<Settled<R>>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await worker(items[index]!) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });

  await Promise.all(runners);
  return results;
}
