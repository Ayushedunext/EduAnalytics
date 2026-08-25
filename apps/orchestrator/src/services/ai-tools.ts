/**
 * Ask-AI tool surface — the Claude-facing tools and how each one reaches MCP.
 *
 * Contract: ADR-030 (server-side spec hydration; no row-level data to the
 * model) · ADR-006/007 (MCP is the only data path; scope is out-of-band) ·
 * docs/05 §2 (tool-choice rule: single school → run_query, several → run_multi).
 *
 * -- Why school_id is an enum, not a free string ------------------------------
 * Invariant 2: the model never supplies a tenant identifier. The tool schemas
 * built here type school_id/school_ids as an enum of the session's
 * ALREADY-RESOLVED scope, so the model can only select among schools the
 * session already holds — the same reconciliation
 * apps/mcp-server/src/tools/run-query.ts's own docstring describes for its own
 * argument: "the argument is the ORCHESTRATOR's injection, and the ALLOWED SET
 * travels out-of-band where nothing the model writes can reach it." MCP's
 * scope.ts still re-verifies independently regardless (ADR-007's second
 * layer stays intact whatever this file does).
 *
 * -- The redaction step (ADR-030) — this is what makes the privacy property real
 * `run_query`/`run_multi` return real rows over MCP. Forwarding them into the
 * model's context would defeat ADR-030 no matter what the model is later asked
 * to emit — the widget-draft schema alone only constrains OUTPUT, not what the
 * model SAW to produce it. So `executeTool` never returns row contents to the
 * model for these two tools: only `{ query_ref, row_count, columns, truncated }`,
 * with the full result cached here (by the model's own chosen `query_key`) for
 * `ai-chat.ts` to hydrate widgets from later. The one exception: a result of
 * exactly one row where no column is tagged `pii` in the schema catalog (the
 * same tagging that already drives masking at the MCP layer) is a safe
 * aggregate scalar, and its value IS included — this is what lets the model
 * write a truthful KPI `value` string, since `kpiWidgetSchema` is reused
 * unchanged in the draft and carries `value` directly, with no query_ref to
 * hydrate from later.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { SessionClaims } from '../auth/session.js';
import { withMcp } from '../mcp/client.js';
import type { RunMultiResult } from '../mcp/client.js';

/** A `query_key` is just a label the model picks; it never touches SQL or scope. */
const queryKeySchema = z
  .string()
  .regex(/^[a-zA-Z0-9_]{1,40}$/, 'query_key must be short and alphanumeric (use "_" for spaces)');

/**
 * Minimal, local mirror of `apps/mcp-server/src/schema/catalog.ts`'s
 * `SchemaCatalog` — parsed from `get_schema`'s JSON response, never trusted as
 * a domain type (§3), the same convention `RunMultiResult` below and
 * `PredefinedResult` in services/dashboards.ts already follow for other MCP
 * tool outputs. Only the fields the redaction rule needs are declared.
 */
export interface SchemaCatalogLite {
  readonly tables: readonly {
    readonly name: string;
    readonly columns: readonly { readonly name: string; readonly pii?: 'students' | 'staff' }[];
  }[];
}

/** What `run_query` returns. Parsed, never trusted as a domain type (§3). */
export interface RunQueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
  readonly truncated: boolean;
  readonly masked_columns: readonly string[];
}

/** A result cached by its model-chosen `query_key`, for hydration later. */
export interface CachedResult {
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
  readonly truncated: boolean;
}

/** What the model sees back for a `run_query`/`run_multi` call — never rows. */
export interface RedactedSummary {
  readonly query_ref: string;
  readonly row_count: number;
  readonly columns: readonly string[];
  readonly truncated: boolean;
  /** Present only for a single-row result with no column tagged `pii`. */
  readonly value?: Record<string, unknown>;
}

/**
 * Case-insensitive: is this column name tagged `pii` on ANY table in the
 * catalog? A flattened result row carries no table provenance by the time it
 * reaches this function, so the check is deliberately conservative — a name
 * that is PII on one table is treated as PII everywhere, which can over-redact
 * a same-named safe column but can never under-redact an unsafe one.
 */
function isPiiColumnName(catalog: SchemaCatalogLite, column: string): boolean {
  const wanted = column.toLowerCase();
  return catalog.tables.some((t) => t.columns.some((c) => c.name.toLowerCase() === wanted && c.pii !== undefined));
}

/** Exported for ai-tools-redact.test.ts — the enforcement point ADR-030 relies on. */
export function redact(queryKey: string, result: CachedResult, catalog: SchemaCatalogLite): RedactedSummary {
  const summary: RedactedSummary = {
    query_ref: queryKey,
    row_count: result.rows.length,
    columns: result.columns,
    truncated: result.truncated,
  };
  if (result.rows.length !== 1) return summary;
  const row = result.rows[0]!;
  const safe = result.columns.every((c) => !isPiiColumnName(catalog, c));
  return safe ? { ...summary, value: row } : summary;
}

/** Build the Anthropic-facing tool definitions for one question's scope. */
export function buildToolDefinitions(
  schoolIds: readonly string[],
): { name: string; description: string; input_schema: object }[] {
  const schoolIdEnum = z.enum(schoolIds as [string, ...string[]]);
  const jsonSchema = (schema: z.ZodTypeAny): object =>
    zodToJsonSchema(schema, { $refStrategy: 'none', target: 'jsonSchema7' });

  return [
    {
      name: 'get_dimensions',
      description:
        "One school's real filter values: academic years, classes, sections, fee heads, departments. Use these exact strings in WHERE clauses rather than guessing at labels.",
      input_schema: jsonSchema(
        z.object({ school_id: schoolIdEnum.describe('A school from the current scope.') }),
      ),
    },
    {
      name: 'run_query',
      description:
        'Run one SELECT against one school. You will NOT see the rows back — only a row count, the column names, and (for a single safe aggregate row) its value. Aggregate in SQL rather than fetching detail to summarise yourself.',
      input_schema: jsonSchema(
        z.object({
          school_id: schoolIdEnum.describe('A school from the current scope.'),
          sql: z
            .string()
            .min(1)
            .describe(
              'One MySQL SELECT against the tables in the schema above. No placeholders, no database qualification, no semicolons.',
            ),
          query_key: queryKeySchema.describe(
            'A short id you choose for this query, e.g. "q1" — reference it later from a widget via query_ref.',
          ),
        }),
      ),
    },
    {
      name: 'run_multi',
      description:
        'Run the same SELECT across several schools (at most 25) and merge the rows, each tagged with school_id. Same no-rows-back rule as run_query.',
      input_schema: jsonSchema(
        z.object({
          school_ids: z.array(schoolIdEnum).min(1).describe('Schools from the current scope.'),
          sql: z.string().min(1).describe('One MySQL SELECT, run unchanged against each school.'),
          query_key: queryKeySchema.describe('A short id you choose for this query.'),
        }),
      ),
    },
  ];
}

export interface ToolExecContext {
  readonly session: SessionClaims;
  readonly correlationId: string;
  readonly catalog: SchemaCatalogLite;
  /** Full results by query_key, populated here and read by ai-chat.ts's hydration step. */
  readonly resultCache: Map<string, CachedResult>;
}

/** Dispatch one Claude tool call to MCP, and redact its result before returning. */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<unknown> {
  switch (name) {
    case 'get_dimensions': {
      const schoolId = String(args['school_id']);
      return withMcp(ctx.session, ctx.correlationId, [schoolId], (mcp) =>
        mcp.call('get_dimensions', { school_id: schoolId }),
      );
    }

    case 'run_query': {
      const schoolId = String(args['school_id']);
      const sql = String(args['sql']);
      const queryKey = String(args['query_key']);
      if (ctx.resultCache.has(queryKey)) {
        throw new Error(`query_key "${queryKey}" was already used in this turn — choose a different one.`);
      }
      const outcome = await withMcp(ctx.session, ctx.correlationId, [schoolId], (mcp) =>
        mcp.call<RunQueryResult>('run_query', { school_id: schoolId, sql }),
      );
      ctx.resultCache.set(queryKey, outcome);
      return redact(queryKey, outcome, ctx.catalog);
    }

    case 'run_multi': {
      const schoolIds = (args['school_ids'] as unknown[]).map(String);
      const sql = String(args['sql']);
      const queryKey = String(args['query_key']);
      if (ctx.resultCache.has(queryKey)) {
        throw new Error(`query_key "${queryKey}" was already used in this turn — choose a different one.`);
      }
      const outcome = await withMcp(ctx.session, ctx.correlationId, schoolIds, (mcp) =>
        mcp.call<RunMultiResult>('run_multi', { school_ids: schoolIds, sql }),
      );
      ctx.resultCache.set(queryKey, outcome);
      return redact(queryKey, outcome, ctx.catalog);
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
