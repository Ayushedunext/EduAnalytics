/**
 * Ask AI — the tool-planning loop and server-side chart-spec hydration.
 *
 * Contract: ADR-030 · docs/05 §2 (query lifecycle) · Invariant 4 (spec-driven
 * rendering) · Invariant 5 (BYOK gating — checked by routes/ai.ts before this
 * runs, not re-checked here) · Invariant 2 (scope — enforced by the enum tool
 * schemas in ai-tools.ts and independently again at the MCP layer).
 *
 * -- What this file does, in order --------------------------------------------
 * 1. Resolve the schema catalog for the scoped schools (one `get_schema` call,
 *    sent to the model as a prompt-cached system block — ADR-026's "the schema
 *    block is the single biggest AI cost/latency lever", applied here exactly
 *    as it already is for the schema/dimension caches on the MCP side).
 * 2. Loop: send the question, execute whatever tool calls the model makes via
 *    `ai-tools.ts` (which redacts every result before it comes back), until the
 *    model calls `emit_report` with a valid chart-spec DRAFT — never data.
 * 3. Hydrate: attach the real, cached rows onto the draft's widgets by
 *    `query_ref`, producing a `ChartSpec` that validates against the same
 *    schema every other serving path uses.
 * 4. Write the `ai.query` audit event (docs/08 §7) with real token usage.
 *
 * The model never receives a school_id, a database name, or a row — only what
 * `ai-tools.ts` chooses to hand back.
 */

import Anthropic from '@anthropic-ai/sdk';
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
import { translate } from './anthropic.js';
import {
  buildToolDefinitions,
  executeTool,
  type CachedResult,
  type SchemaCatalogLite,
} from './ai-tools.js';

export type AskAiEvent =
  | { type: 'status'; step: string }
  | { type: 'result'; spec: ChartSpec }
  | { type: 'error'; code: string; message: string };

export async function runAskAi(args: {
  session: SessionClaims;
  schoolIds: readonly string[];
  question: string;
  correlationId: string;
  onEvent: (event: AskAiEvent) => void;
}): Promise<void> {
  const { session, schoolIds, question, correlationId, onEvent } = args;

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

  const client = new Anthropic({
    apiKey: keyInfo.apiKey,
    timeout: config.AI_CHAT_TIMEOUT_MS,
    maxRetries: 0,
  });

  const tools: Anthropic.Tool[] = buildToolDefinitions(schoolIds).map((t) => ({
    ...t,
    input_schema: t.input_schema as Anthropic.Tool.InputSchema,
  }));
  tools.push({
    name: 'emit_report',
    description:
      'End the turn by answering the question as a chart-spec SKELETON. Widgets reference query_ref, the query_key of a run_query/run_multi call you already made — never put data rows here. A kpi widget is the only type where you write the display value yourself, and only from a value you were shown (a safe single-row aggregate).',
    input_schema: chartSpecDraftJsonSchema(),
  });

  const resultCache = new Map<string, CachedResult>();
  const toolsInvoked: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: question }];
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

    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: keyInfo.model,
        max_tokens: 4096,
        system: [
          { type: 'text', text: buildSystemPrompt(catalog, scope), cache_control: { type: 'ephemeral' } },
        ],
        tools,
        messages,
      });
    } catch (err) {
      const translated = translate(err);
      throw new PlatformError({
        code: ERROR_CODES.AI_PROVIDER_ERROR,
        message: translated.message,
        correlationId,
      });
    }

    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;
    cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;

    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );

    const emitBlock = toolUses.find((b) => b.name === 'emit_report');
    if (emitBlock !== undefined) {
      const shapeCheck = validateChartSpecDraft(emitBlock.input);
      const inlineCheck = shapeCheck.ok ? assertNoInlineData(emitBlock.input) : shapeCheck;
      if (shapeCheck.ok && inlineCheck.ok) {
        draft = shapeCheck.value;
        break;
      }
      const issues = shapeCheck.ok ? (inlineCheck.ok ? [] : inlineCheck.issues) : shapeCheck.issues;
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: emitBlock.id,
            is_error: true,
            content: `That report was invalid: ${formatIssues(issues)}. Fix it and call emit_report again.`,
          },
        ],
      });
      continue;
    }

    if (toolUses.length === 0) {
      // The model answered in plain text instead of calling a tool. Nudge once;
      // if it happens again the iteration cap above ends the turn honestly.
      if (nudged) continue;
      nudged = true;
      messages.push({
        role: 'user',
        content: 'Answer by calling tools, ending with emit_report — not with plain text.',
      });
      continue;
    }

    onEvent({ type: 'status', step: statusFor(toolUses) });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      toolsInvoked.push(use.name);
      try {
        const summary = await executeTool(use.name, use.input as Record<string, unknown>, {
          session,
          correlationId,
          catalog,
          resultCache,
        });
        toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(summary) });
      } catch (err) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          is_error: true,
          content: err instanceof PlatformError ? err.message : err instanceof Error ? err.message : 'That call failed.',
        });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }

  onEvent({ type: 'status', step: 'Building chart' });
  const spec = hydrate(draft, resultCache, scope, correlationId);

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
  });

  onEvent({ type: 'result', spec });
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

function chartSpecDraftJsonSchema(): Anthropic.Tool.InputSchema {
  return zodToJsonSchema(chartSpecDraftSchema, {
    $refStrategy: 'none',
    target: 'jsonSchema7',
  }) as Anthropic.Tool.InputSchema;
}

function statusFor(toolUses: readonly Anthropic.ToolUseBlock[]): string {
  const names = new Set(toolUses.map((t) => t.name));
  if (names.has('get_dimensions')) return 'Checking filter values';
  if (names.has('run_multi')) return 'Running query across schools';
  return 'Running query';
}

function buildSystemPrompt(catalog: SchemaCatalogLite, scope: readonly { school_id: string; school_name: string }[]): string {
  return [
    "You are the Ask AI planner for a school analytics platform. Answer the user's question by planning read-only SQL against the schools in scope, then call emit_report exactly once to end the turn.",
    '',
    `Schools in scope: ${scope.map((s) => `${s.school_id} (${s.school_name})`).join(', ')}.`,
    '',
    'Rules:',
    '- Call get_dimensions for a school before filtering on a text value (class names, fee heads, categories, …) you have not seen verified for that school — never guess a label.',
    '- Use run_query for one school, run_multi for several (at most 25) with the same statement.',
    '- Every run_query/run_multi call needs a unique query_key you choose (e.g. "q1"). You get back row_count, columns and, only for a single safe aggregate row, its value — never full row contents. You cannot see fetched detail rows, so aggregate in SQL (GROUP BY, COUNT, SUM) rather than planning to summarise rows yourself.',
    '- No placeholders, no database qualification, no semicolons, no values you were not shown by get_dimensions or a query result.',
    '- emit_report widgets reference query_ref, the query_key of the run that will fill them — never put data rows into emit_report; the platform attaches real rows itself. A kpi widget is the only type where you write the display `value` string yourself, and only from a value you were shown.',
    '- Prefer the fewest queries that answer the question.',
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
