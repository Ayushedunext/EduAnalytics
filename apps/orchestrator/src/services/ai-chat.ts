/**
 * Ask AI — the tool-planning loop and server-side chart-spec hydration.
 *
 * Contract: ADR-030 (redaction/hydration) · ADR-031 (provider-generic loop) ·
 * docs/05 §2 (query lifecycle) · Invariant 4 (spec-driven rendering) ·
 * Invariant 5 (BYOK gating — checked by routes/ai.ts before this runs, not
 * re-checked here) · Invariant 2 (scope — enforced by the enum tool schemas
 * in ai-tools.ts and independently again at the MCP layer).
 *
 * -- What this file does, in order --------------------------------------------
 * 1. Resolve the schema catalog for the scoped schools (one `get_schema` call,
 *    sent to the model as a prompt-cached system block — ADR-026's "the schema
 *    block is the single biggest AI cost/latency lever", applied here exactly
 *    as it already is for the schema/dimension caches on the MCP side).
 * 2. Loop: send the question through the org's chosen provider's `ModelClient`
 *    (ADR-031), execute whatever tool calls it makes via `ai-tools.ts` (which
 *    redacts every result before it comes back), until it calls `emit_report`
 *    with a valid chart-spec DRAFT — never data.
 * 3. Hydrate: attach the real, cached rows onto the draft's widgets by
 *    `query_ref`, producing a `ChartSpec` that validates against the same
 *    schema every other serving path uses.
 * 4. Write the `ai.query` audit event (docs/08 §7) with real token usage.
 *
 * The model never receives a school_id, a database name, or a row — only what
 * `ai-tools.ts` chooses to hand back. None of this file's logic differs by
 * provider; that is the entire point of routing every SDK call through
 * `ModelClient` (services/ai-providers/types.ts) instead of importing an SDK
 * here directly.
 */

import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  chartSpecSchema,
  chartSpecDraftSchema,
  validateChartSpecDraft,
  assertNoInlineData,
  formatIssues,
  type ChartSpec,
  type ChartSpecDraft,
  type DataRow,
  type Widget,
  type WidgetDraft,
} from '@sap/chart-spec';
import { ERROR_CODES, PlatformError } from '@sap/shared';
import { config } from '../config.js';
import type { SessionClaims } from '../auth/session.js';
import { schoolNames } from '../db/registry.js';
import { withMcp } from '../mcp/client.js';
import { auditSink } from '../db/audit.js';
import { getDecryptedApiKeyForOrg } from './ai-config.js';
import { PROVIDERS, type ProviderTool, type ProviderToolCall, type ProviderToolOutcome } from './ai-providers/index.js';
import {
  buildToolDefinitions,
  executeTool,
  type CachedResult,
  type SchemaCatalogLite,
} from './ai-tools.js';
import type { ReportLogic } from './dashboards.js';

/** One statement Ask AI ran, keyed the same way the widgets reference it. */
export interface AskAiQuery {
  readonly key: string;
  readonly sql: string;
}

export type AskAiEvent =
  | { type: 'status'; step: string }
  /**
   * `queries` carries the literal SQL behind this answer (Invariant 6 — every
   * report exposes its SQL, and Ask AI answers are reports). `draft` is the
   * model's own pre-hydration widget structure — both together are what
   * "Save as report" persists verbatim into `report_definitions` (AUDIT_REPORT
   * C17): the orchestrator already has both the moment the turn ends, so
   * sending them down here means the client never has to reconstruct what it
   * is already looking at.
   */
  | { type: 'result'; spec: ChartSpec; queries: readonly AskAiQuery[]; draft: ChartSpecDraft; logic: ReportLogic }
  | { type: 'error'; code: string; message: string };

/**
 * The 🧠 Logic panel's contents for an Ask AI answer (docs/06 §3, docs/10
 * §3's "🧠 Logic ... present ... on every report surface, including AI
 * artifacts") — the SAME shape `custom-reports.ts`'s `runRawSqlMode` builds
 * once an answer is saved and re-run, so the panel never changes shape (and
 * never drifts) the moment "💾 Save as report" is clicked. `notes` is the one
 * thing that legitimately differs between the two callers — saved vs. not
 * yet saved is a real difference worth stating, everything else here is
 * identical either way.
 */
export function buildAskAiLogic(
  scope: readonly { school_id: string; school_name: string }[],
  spec: ChartSpec,
  queries: readonly AskAiQuery[],
  notes: readonly string[],
): ReportLogic {
  return {
    source: 'Ask AI',
    scope,
    filters: [],
    group_by: [],
    charts: spec.widgets.map((w) => w.type),
    queries: queries.map((q) => ({ key: q.key, description: 'Ask AI query', sql: q.sql })),
    notes,
  };
}

/**
 * Seeds a turn with an EXISTING report's current definition — "✎ Refine with
 * AI" (docs/06 §1/§3, ADR-033's explicitly-deferred action, built here).
 * Text only, folded into the system prompt: the model still plans fresh
 * tool calls and still never receives row data (ADR-030 is unchanged by
 * this — refining is not a different privacy regime, just a different
 * starting point for the same planning loop).
 */
export interface RefineSeedContext {
  readonly reportName: string;
  readonly queries: readonly { key: string; sql: string }[];
  /** The widget(s) currently shown, so the model knows the current chart type/fields without being handed row data. */
  readonly widgets: readonly Widget[];
}

export async function runAskAi(args: {
  session: SessionClaims;
  schoolIds: readonly string[];
  question: string;
  correlationId: string;
  onEvent: (event: AskAiEvent) => void;
  seedContext?: RefineSeedContext;
  /** The report being refined, purely for the audit trail — never re-derived from `seedContext` alone since that carries no id. */
  refiningReportId?: string;
}): Promise<void> {
  const { session, schoolIds, question, correlationId, onEvent, seedContext, refiningReportId } = args;

  onEvent({ type: 'status', step: 'Confirming scope' });
  const scope = await schoolNames(schoolIds);
  if (scope.length === 0) {
    throw new PlatformError({
      code: ERROR_CODES.TENANT_UNAVAILABLE,
      message: 'None of the selected schools are available for analytics right now.',
      correlationId,
    });
  }

  /**
   * Every route that reaches this function already checked `ai_status`
   * (routes/ai.ts), so `null` here means the config changed between that check
   * and this call (a race, not the common path) — still refused the same way.
   */
  const keyInfo = await getDecryptedApiKeyForOrg(session.org_id);
  if (keyInfo === null) {
    throw new PlatformError({
      code: ERROR_CODES.AI_NOT_ACTIVE,
      message: 'AI reports are not set up for this organization.',
      correlationId,
    });
  }

  onEvent({ type: 'status', step: 'Reading schema' });
  const catalog = await resolveCatalog(session, schoolIds, correlationId);

  const provider = PROVIDERS[keyInfo.provider];
  const client = provider.createClient({ apiKey: keyInfo.apiKey, model: keyInfo.model });
  const systemPrompt = buildSystemPrompt(catalog, scope, seedContext);

  const tools: ProviderTool[] = buildToolDefinitions(schoolIds).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema,
  }));
  tools.push({
    name: 'emit_report',
    description:
      'End the turn by answering the question as a chart-spec SKELETON. Widgets reference query_ref, the query_key of a run_query/run_multi call you already made — never put data rows here. A kpi widget is the only type where you write the display value yourself, and only from a value you were shown (a safe single-row aggregate).',
    inputSchema: zodToJsonSchema(chartSpecDraftSchema, { $refStrategy: 'none', target: 'jsonSchema7' }),
  });

  const resultCache = new Map<string, CachedResult>();
  const toolsInvoked: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;

  let state = client.initialState(question);
  let draft: ChartSpecDraft | null = null;
  let nudged = false;

  for (let iteration = 0; draft === null; iteration += 1) {
    if (iteration >= config.AI_CHAT_MAX_TOOL_CALLS) {
      throw new PlatformError({
        code: ERROR_CODES.AI_PROVIDER_ERROR,
        message: 'This question needs more steps than Ask AI allows right now. Try narrowing it.',
        correlationId,
      });
    }

    let toolCalls: readonly ProviderToolCall[];
    try {
      const stepResult = await client.step(state, systemPrompt, tools);
      state = stepResult.state;
      toolCalls = stepResult.toolCalls;
      inputTokens += stepResult.usage.inputTokens;
      outputTokens += stepResult.usage.outputTokens;
      cacheReadTokens += stepResult.usage.cacheReadTokens;
    } catch (err) {
      throw new PlatformError({
        code: ERROR_CODES.AI_PROVIDER_ERROR,
        message: err instanceof Error ? err.message : 'The AI provider could not answer that.',
        correlationId,
      });
    }

    const emitCall = toolCalls.find((c) => c.name === 'emit_report');
    if (emitCall !== undefined) {
      const shapeCheck = validateChartSpecDraft(emitCall.args);
      const inlineCheck = shapeCheck.ok ? assertNoInlineData(emitCall.args) : shapeCheck;
      if (shapeCheck.ok && inlineCheck.ok) {
        draft = shapeCheck.value;
        break;
      }
      const issues = shapeCheck.ok ? (inlineCheck.ok ? [] : inlineCheck.issues) : shapeCheck.issues;
      state = client.withToolOutcomes(state, [
        {
          callId: emitCall.id,
          name: 'emit_report',
          error: `That report was invalid: ${formatIssues(issues)}. Fix it and call emit_report again.`,
        },
      ]);
      continue;
    }

    if (toolCalls.length === 0) {
      // The model answered in plain text instead of calling a tool. Nudge once;
      // if it happens again the iteration cap above ends the turn honestly.
      if (nudged) continue;
      nudged = true;
      state = client.withNudge(state, 'Answer by calling tools, ending with emit_report — not with plain text.');
      continue;
    }

    onEvent({ type: 'status', step: statusFor(toolCalls) });

    const outcomes: ProviderToolOutcome[] = [];
    for (const call of toolCalls) {
      toolsInvoked.push(call.name);
      try {
        const summary = await executeTool(call.name, call.args, { session, correlationId, catalog, resultCache });
        outcomes.push({ callId: call.id, name: call.name, output: summary });
      } catch (err) {
        outcomes.push({
          callId: call.id,
          name: call.name,
          error: err instanceof PlatformError ? err.message : err instanceof Error ? err.message : 'That call failed.',
        });
      }
    }
    state = client.withToolOutcomes(state, outcomes);
  }

  onEvent({ type: 'status', step: 'Building chart' });
  const spec = hydrate(draft, resultCache, scope, correlationId);
  const queries: AskAiQuery[] = [...resultCache].map(([key, result]) => ({ key, sql: result.sql }));

  await auditSink.write({
    kind: 'ai.query',
    at: new Date().toISOString(),
    actor_sub: session.sub,
    org_id: session.org_id,
    correlation_id: correlationId,
    school_ids: schoolIds,
    question,
    tools_invoked: [...new Set(toolsInvoked)],
    model: keyInfo.model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    ...(refiningReportId === undefined ? {} : { report_id: refiningReportId }),
  });

  const logic = buildAskAiLogic(scope, spec, queries, [
    'This is a live Ask AI answer — not yet saved. Scope is injected from your launch token and cannot be widened from this screen.',
    'Save it to keep this exact statement re-runnable later, including if your organisation’s AI key is later locked.',
  ]);
  onEvent({ type: 'result', spec, queries, draft, logic });
}

/**
 * The schema version for this question, resolved from the first school in
 * scope. A scope spanning schools on different schema versions is a Phase-3
 * simplification this slice does not handle — the same simplification
 * `services/dashboards.ts`'s predefined path does not need to make, because it
 * never sends a raw schema block to a model in the first place.
 */
async function resolveCatalog(
  session: SessionClaims,
  schoolIds: readonly string[],
  correlationId: string,
): Promise<SchemaCatalogLite> {
  const [primary] = schoolIds;
  if (primary === undefined) {
    throw new PlatformError({
      code: ERROR_CODES.TENANT_UNAVAILABLE,
      message: 'No school is available to answer this question.',
      correlationId,
    });
  }
  return withMcp(session, correlationId, [primary], async (mcp) => {
    const dims = await mcp.call<{ schema_version: string }>('get_dimensions', { school_id: primary });
    return mcp.call<SchemaCatalogLite>('get_schema', { schema_version: dims.schema_version });
  });
}

function statusFor(toolCalls: readonly ProviderToolCall[]): string {
  const names = new Set(toolCalls.map((t) => t.name));
  if (names.has('get_dimensions')) return 'Checking filter values';
  if (names.has('run_multi')) return 'Running query across schools';
  return 'Running query';
}

/** Exported for ai-chat-hydrate.test.ts's coverage of the Refine seed text. */
export function buildSystemPrompt(
  catalog: SchemaCatalogLite,
  scope: readonly { school_id: string; school_name: string }[],
  seedContext?: RefineSeedContext,
): string {
  return [
    "You are the Ask AI planner for a school analytics platform. Answer the user's question by planning read-only SQL against the schools in scope, then call emit_report exactly once to end the turn.",
    '',
    `Schools in scope: ${scope.map((s) => `${s.school_id} (${s.school_name})`).join(', ')}.`,
    '',
    ...(seedContext === undefined
      ? []
      : [
          `You are REFINING an existing report the user has open, called "${seedContext.reportName}". Its current chart(s):`,
          JSON.stringify(seedContext.widgets, null, 2),
          '',
          'Its current SQL:',
          seedContext.queries.map((q) => `-- ${q.key}\n${q.sql}`).join('\n\n'),
          '',
          "If the user is asking a QUESTION about this chart (e.g. \"why is X higher than Y\"), answer it in the report's narrative and you may re-emit essentially the same chart (same fields, same grouping) with fresh numbers — do not invent a different chart shape just because you were asked something. If the user is asking for a CHANGE (a different chart type, a different filter, a different grouping, a different time range), produce an updated report reflecting that change. Unless the user explicitly asks to add more charts, keep the answer to the SAME NUMBER of widgets as shown above — refining one chart should not turn it into a multi-chart dashboard.",
          '',
        ]),
    'Rules:',
    '- Call get_dimensions for a school before filtering on a text value (class names, fee heads, categories, …) you have not seen verified for that school — never guess a label.',
    '- Use run_query for one school, run_multi for several (at most 25) with the same statement.',
    '- Every run_query/run_multi call needs a unique query_key you choose (e.g. "q1"). You get back row_count, columns and, only for a single safe aggregate row, its value — never full row contents. You cannot see fetched detail rows, so aggregate in SQL (GROUP BY, COUNT, SUM) rather than planning to summarise rows yourself.',
    '- No placeholders, no database qualification, no semicolons, no values you were not shown by get_dimensions or a query result.',
    '- This is MySQL 8. MySQL rejects a LIMIT inside a subquery used with IN/ALL/ANY/SOME ("doesn\'t yet support LIMIT & IN/ALL/ANY/SOME subquery") — for "the most recent N periods" style filters, wrap the limited subquery in a derived table instead: `... IN (SELECT x FROM (SELECT x FROM t ORDER BY x DESC LIMIT n) AS sub)`.',
    '- GROUP BY only real columns or expressions you are grouping by, never the alias of an aggregate function (e.g. `MIN(MONTH(d)) AS mo` cannot itself appear in GROUP BY) — MySQL rejects it ("Can\'t group on...") and grouping by an aggregate\'s own output is not meaningful anyway.',
    '- If a run_query/run_multi call comes back with an error, do not silently fall back to an earlier, differently-scoped query that happened to succeed — fix the SQL that failed and re-run it, or the chart you emit will answer a different question than the one asked.',
    '- emit_report widgets reference query_ref, the query_key of the run that will fill them — never put data rows into emit_report; the platform attaches real rows itself. A kpi widget is the only type where you write the display `value` string yourself, and only from a value you were shown.',
    '- Prefer the fewest queries that answer the question.',
    '- If you ran more than one query while narrowing down an answer (a probe, then a corrected version), the query_ref you put in emit_report MUST be the one whose SQL actually matches every filter the user asked for (e.g. "last two years") — never a broader or exploratory query you ran earlier on the way there.',
    '- A bar or donut widget has ONE flat category axis: every row you attach to it must have a distinct `x` (or `label_field`) value, because the renderer draws one bar/slice per row with no way to tell two identically-labelled rows apart. If comparing the SAME categories across multiple periods or groups (e.g. this year vs last year, month by month), GROUP BY producing one row per category is wrong — use a line widget instead, with `x` as the category and `series` set to the grouping field (e.g. academic year); the renderer draws one coloured line per series value on a shared category axis, which is the only widget type that supports more than one value per category.',
    '',
    'Schema:',
    JSON.stringify(catalog, null, 2),
  ].join('\n');
}

/**
 * Attach real, cached rows onto the draft's widgets by query_ref. Never the
 * model's output. Exported for ai-chat-hydrate.test.ts.
 */
export function hydrate(
  draft: ChartSpecDraft,
  cache: ReadonlyMap<string, CachedResult>,
  scope: readonly { school_id: string; school_name: string }[],
  correlationId: string,
): ChartSpec {
  const widgets: Widget[] = draft.widgets.map((w) => hydrateWidget(w, cache, correlationId));

  const spec = {
    spec_version: 1 as const,
    title: draft.title,
    ...(draft.narrative === undefined ? {} : { narrative: draft.narrative }),
    widgets,
    meta: {
      scope,
      generated_at: new Date().toISOString(),
      served_from: 'replica' as const,
    },
  };

  const parsed = chartSpecSchema.safeParse(spec);
  if (!parsed.success) {
    throw new PlatformError({
      code: ERROR_CODES.INVALID_CHART_SPEC,
      message: 'Ask AI could not build a valid report from that answer.',
      diagnostics: { issues: parsed.error.issues.map((i) => i.path.join('.')) },
      correlationId,
    });
  }
  return parsed.data;
}

export function hydrateWidget(
  widget: WidgetDraft,
  cache: ReadonlyMap<string, CachedResult>,
  correlationId: string,
): Widget {
  if (widget.type === 'kpi') return widget;

  const result = cache.get(widget.query_ref);
  if (result === undefined) {
    throw new PlatformError({
      code: ERROR_CODES.INVALID_CHART_SPEC,
      message: `Ask AI referenced a query result ("${widget.query_ref}") that was never run.`,
      correlationId,
    });
  }

  const rows = toDataRows(result.rows);

  switch (widget.type) {
    case 'bar':
      return {
        id: widget.id,
        ...(widget.title === undefined ? {} : { title: widget.title }),
        type: 'bar',
        x: widget.x,
        y: widget.y,
        data: rows,
        ...(widget.drillable === undefined ? {} : { drillable: widget.drillable }),
      };
    case 'line':
      return {
        id: widget.id,
        ...(widget.title === undefined ? {} : { title: widget.title }),
        type: 'line',
        x: widget.x,
        y: widget.y,
        data: rows,
        ...(widget.series === undefined ? {} : { series: widget.series }),
        ...(widget.drillable === undefined ? {} : { drillable: widget.drillable }),
      };
    case 'donut':
      return {
        id: widget.id,
        ...(widget.title === undefined ? {} : { title: widget.title }),
        type: 'donut',
        label_field: widget.label_field,
        value_field: widget.value_field,
        data: rows,
        ...(widget.drillable === undefined ? {} : { drillable: widget.drillable }),
      };
    case 'table':
      return {
        id: widget.id,
        ...(widget.title === undefined ? {} : { title: widget.title }),
        type: 'table',
        columns: widget.columns,
        rows,
        truncated: result.truncated,
      };
  }
}

/**
 * MCP results arrive as `Record<string, unknown>` (parsed JSON, never trusted
 * as a domain type — §3), but a hydrated widget's `data`/`rows` are typed as
 * `DataRow[]`. The cast is load-bearing only for TypeScript: the actual
 * enforcement is `chartSpecSchema.safeParse` in `hydrate`, which rejects any
 * cell that is not a scalar `dataRowSchema` allows, same as every other
 * serving path that builds a spec from a raw query result.
 */
function toDataRows(rows: readonly Record<string, unknown>[]): DataRow[] {
  return [...rows] as DataRow[];
}
