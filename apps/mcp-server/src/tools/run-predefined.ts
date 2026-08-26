/**
 * `run_predefined(report_id, school_ids[], params)` — docs/04 §2.
 *
 * The vetted path (ADR-016): a caller names a report from the catalog and
 * supplies filter VALUES. It cannot supply SQL, so this tool's blast radius is
 * bounded by what the catalog authorises rather than by how good the guard is —
 * which is why predefined dashboards can be trusted to run on every school every
 * day while `run_query` is reserved for the AI path.
 *
 * [MANDATORY] CODING_GUIDELINES §7: the rails still apply, uniformly. Every
 * query in a report goes through the same `prepareSelect` and the same executor
 * as a model's SQL — AST-validated, tenant-filtered, capped, rate-limited,
 * masked, audited. "Trusted" changes where the statement came from, never what
 * happens to it.
 *
 * -- One call, several result sets -------------------------------------------
 * A dashboard is several questions about the same slice, so a report carries
 * several named queries and this returns them together. That is one MCP round
 * trip and one tenant resolution instead of five, and it keeps the widgets of a
 * dashboard consistent with each other — they are read at the same moment
 * against the same replica, so a KPI cannot disagree with the chart beneath it.
 *
 * -- Partial failure is reported per query, not per dashboard ----------------
 * If one query fails and four succeed, the four render and the fifth says why
 * (ADR-011's principle applied to widgets rather than schools). A dashboard that
 * blanks entirely because one panel timed out is worse than one that is honest
 * about which panel is missing.
 */

import { z } from 'zod';
import { safeIdSchema } from '@sap/shared';
import { config } from '../config.js';
import { getPredefinedReport, predefinedReportIds } from '../reports/catalog.js';
import { getCatalog } from '../schema/index.js';
import { resolveConnectionTarget, type ConnectionTarget } from '../db/registry.js';
import { executePrepared } from '../db/execute.js';
import { prepareSelect } from '../sql/guard.js';
import { requireFanoutWithinCap, requireInScope, type ToolContext } from '../scope.js';
import { ERROR_CODES, PlatformError } from '@sap/shared';
import { ok } from './result.js';

const TOOL = 'run_predefined';

export const runPredefinedInput = {
  report_id: z
    .string()
    .min(1)
    .describe(`A report from the catalog: ${predefinedReportIds().join(', ')}.`),
  school_ids: z
    .array(safeIdSchema)
    .min(1)
    .describe('Schools from the session scope. At most 25 per call.'),
  /**
   * Filter VALUES only. Scalars, because a filter is a value and anything
   * structured here would be a way to smuggle shape into a statement whose shape
   * is the point of it being predefined.
   */
  params: z
    .record(z.union([z.string(), z.number()]))
    .optional()
    .describe("Filter values the report declares, e.g. { academic_year: '2026-27' }."),
  /**
   * Per-widget clone (docs/06 §3): run only these named queries from the
   * report's catalog entry instead of every query a full dashboard needs.
   * Still no SQL from the caller — a key names one of the report's own
   * pre-vetted queries, nothing else.
   */
  query_keys: z
    .array(z.string().min(1))
    .optional()
    .describe('Limit execution to these named queries from the report (a single-widget clone).'),
} satisfies z.ZodRawShape;

interface QueryOutput {
  key: string;
  description: string;
  /** Invariant 6: every report exposes the SQL that produced it. */
  sql: string;
  status: 'ok' | 'failed';
  columns?: readonly string[];
  rows?: readonly Record<string, unknown>[];
  truncated?: boolean;
  masked_columns?: readonly string[];
  error?: { code: string; message: string };
}

export async function runPredefined(
  context: ToolContext,
  args: {
    report_id: string;
    school_ids: string[];
    params?: Record<string, string | number> | undefined;
    query_keys?: string[] | undefined;
  },
): Promise<ReturnType<typeof ok>> {
  const schoolIds = await requireInScope(context, args.school_ids, TOOL);
  requireFanoutWithinCap(schoolIds);

  const report = getPredefinedReport(args.report_id);
  if (report === undefined) {
    throw new PlatformError({
      code: ERROR_CODES.REPORT_NOT_FOUND,
      message: 'That report is not in the catalog.',
      details: { available: predefinedReportIds().join(', ') },
    });
  }

  /**
   * [MANDATORY] CODING_GUIDELINES §3: tool arguments are `unknown` until
   * validated. A declared-but-missing filter is refused rather than bound as
   * NULL — `WHERE academicyearname = NULL` matches nothing and would render an
   * empty dashboard that looks like a school with no data.
   */
  const supplied = args.params ?? {};
  const bound: Record<string, string | number | null> = {};
  for (const param of report.params) {
    const value = supplied[param.name];
    if (value === undefined || value === '') {
      if (param.required) {
        throw new PlatformError({
          code: ERROR_CODES.VALIDATION_FAILED,
          message: `This report needs a value for "${param.name}".`,
          details: { parameter: param.name, description: param.description },
        });
      }
      bound[param.name] = null;
      continue;
    }
    if (param.type === 'number' && typeof value !== 'number') {
      throw new PlatformError({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: `"${param.name}" must be a number.`,
        details: { parameter: param.name },
      });
    }
    bound[param.name] = value;
  }
  for (const name of Object.keys(supplied)) {
    if (!report.params.some((p) => p.name === name)) {
      // Silently ignoring an unknown filter would let a caller believe a report
      // was narrowed when it was not.
      throw new PlatformError({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: `This report does not accept a filter called "${name}".`,
        details: { parameter: name },
      });
    }
  }

  const queryKeys = args.query_keys;
  if (queryKeys !== undefined) {
    const known = new Set(report.queries.map((q) => q.key));
    for (const key of queryKeys) {
      if (!known.has(key)) {
        throw new PlatformError({
          code: ERROR_CODES.VALIDATION_FAILED,
          message: `This report has no query called "${key}".`,
          details: { query_key: key },
        });
      }
    }
  }

  const perSchool = await Promise.all(
    schoolIds.map(async (schoolId) => runForSchool(context, report.id, schoolId, bound, queryKeys)),
  );

  return ok({
    report_id: report.id,
    title: report.title,
    source: report.source,
    school_ids: schoolIds,
    params: bound,
    schools: perSchool,
    as_of: new Date().toISOString(),
  });
}

async function runForSchool(
  context: ToolContext,
  reportId: string,
  schoolId: string,
  bound: Record<string, string | number | null>,
  queryKeys: string[] | undefined,
): Promise<{
  school_id: string;
  status: 'ok' | 'failed';
  queries?: QueryOutput[];
  error?: { code: string; message: string };
}> {
  const report = getPredefinedReport(reportId);
  if (report === undefined) throw new Error(`unreachable: report ${reportId} vanished`);

  let target: ConnectionTarget;
  try {
    target = await resolveConnectionTarget(schoolId);
  } catch (err) {
    return { school_id: schoolId, status: 'failed', error: wireOf(err) };
  }

  const catalog = getCatalog(target.tenant.schema_version);
  if (catalog === undefined) {
    return {
      school_id: schoolId,
      status: 'failed',
      error: {
        code: ERROR_CODES.TENANT_UNAVAILABLE,
        message: 'Analytics has no schema document for this school yet.',
      },
    };
  }
  if (catalog.schema_version !== report.schema_version) {
    /**
     * The report's SQL was written against a different schema version. Refusing
     * is the honest answer: ADR-014 accepts that a school may be on another
     * version, and running a statement written for a schema this school does not
     * have would fail as a confusing query error rather than a config problem.
     */
    return {
      school_id: schoolId,
      status: 'failed',
      error: {
        code: ERROR_CODES.TENANT_UNAVAILABLE,
        message: 'This report is not available for this school’s schema version.',
      },
    };
  }

  /**
   * A per-widget clone (docs/06 §3) asks for one query instead of the whole
   * report — filtered here, once, rather than in every caller of
   * `run_predefined`, so a single-widget clone pays for one query's cost, not
   * the full dashboard's. `runPredefined` above already proved every key in
   * `queryKeys` names a real query, so an empty result here is unreachable.
   */
  const selectedQueries =
    queryKeys === undefined ? report.queries : report.queries.filter((q) => queryKeys.includes(q.key));

  /**
   * A report's queries run concurrently, bounded by the school's pool size.
   *
   * Sequentially they cost the SUM of their times, which on the fee tables (no
   * usable index; see reports/catalog.ts) was ~20 s for one dashboard. The bound
   * is `POOL_CONNECTION_LIMIT` and not something larger on purpose: ADR-013 caps
   * a school at three connections precisely so one tenant's dashboard cannot
   * take a share of the replica that its neighbours need. Faster, within the
   * same blast radius.
   */
  const queries: QueryOutput[] = new Array<QueryOutput>(selectedQueries.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(config.POOL_CONNECTION_LIMIT, selectedQueries.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= selectedQueries.length) return;
        queries[index] = await runQuery(selectedQueries[index]!);
      }
    },
  );
  await Promise.all(workers);

  return { school_id: schoolId, status: 'ok', queries };

  async function runQuery(query: {
    key: string;
    description: string;
    sql: string;
    variants?: Readonly<Record<string, string>>;
  }): Promise<QueryOutput> {
    if (catalog === undefined) throw new Error('unreachable: catalog checked above');

    /**
     * `bucket` is a SELECTOR among the query's own pre-vetted statements
     * (reports/catalog.ts), never SQL text from the caller: the guard below
     * never sees the value, only whichever fixed statement was chosen for it.
     * A query with no `variants` (everything but a bucketed clone's own
     * query) ignores `bucket` entirely.
     */
    const bucket = bound['bucket'];
    let sqlToRun = query.sql;
    if (typeof bucket === 'string' && query.variants !== undefined) {
      const variant = query.variants[bucket];
      if (variant === undefined) {
        return {
          key: query.key,
          description: query.description,
          sql: query.sql,
          status: 'failed',
          error: {
            code: ERROR_CODES.VALIDATION_FAILED,
            message: `"${bucket}" is not a time grouping this widget supports.`,
          },
        };
      }
      sqlToRun = variant;
    }

    try {
      const prepared = prepareSelect({
        sql: sqlToRun,
        catalog,
        tenantKey: target.tenant.tenant_key,
        perms: context.call.perms,
        rowCap: config.ROW_CAP,
        declaredParams: bound,
      });

      const outcome = await executePrepared({
        schoolId,
        prepared,
        catalog,
        tool: TOOL,
        perms: context.call.perms,
        audit: context.audit,
        actorSub: context.call.sub,
        orgId: context.call.org_id,
        correlationId: context.call.correlation_id,
      });

      return {
        key: query.key,
        description: query.description,
        // The DEFINITION's SQL that actually ran, which is what a reader is
        // being asked to trust (ADR-019) — the bucket variant when one was
        // selected, never the default text a different statement replaced.
        sql: sqlToRun,
        status: 'ok',
        columns: outcome.columns,
        rows: outcome.rows,
        truncated: outcome.truncated,
        masked_columns: outcome.masked_columns,
      };
    } catch (err) {
      return {
        key: query.key,
        description: query.description,
        sql: sqlToRun,
        status: 'failed',
        error: wireOf(err),
      };
    }
  }
}

function wireOf(err: unknown): { code: string; message: string } {
  if (err instanceof PlatformError) return { code: err.code, message: err.message };
  return { code: ERROR_CODES.INTERNAL, message: 'The query could not be completed.' };
}
