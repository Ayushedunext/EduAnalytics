/**
 * Insights — "explain this chart to me, in plain words".
 *
 * Contract: Invariant 5 (BYOK gating — checked by routes/ai.ts before this
 * runs) · **ADR-030** (the model never receives row data; a narrative is
 * written from "aggregates/summary values the orchestrator can safely pass
 * back — count, sum, min/max", which is that ADR's own stated mechanism and
 * exactly what this file implements) · ADR-031 (provider-generic) · Invariant 1
 * (zero ERP load) · Invariant 2 (scope is law).
 *
 * -- What this is, and what it deliberately is not ----------------------------
 * It is NOT Ask AI with a canned question. Ask AI plans tool calls, writes SQL
 * through the MCP server and hydrates a new chart; this asks nothing of the
 * database at all. The reader is already looking at a chart the platform
 * built, so this rebuilds THAT chart through the same cached serving path the
 * screen used (`buildDashboard` / `buildOverviewSlot` / `viewReport`), reduces
 * it to a digest of aggregates, and spends exactly one model turn turning that
 * digest into three or four sentences.
 *
 * Two consequences worth stating, because both are the point:
 *   - **No new query.** The chart is already in Redis under the key the screen
 *     warmed a second ago, so an Insight costs a cache read and a model call —
 *     never a replica scan (Invariant 1). It also cannot show a number the
 *     chart does not, since it is reading the built widget.
 *   - **No model-authored SQL.** There is no tool loop and no MCP call here, so
 *     the read-only data plane (Invariant 3) is not merely enforced for this
 *     path, it is unreachable from it.
 *
 * -- What the model is allowed to see (ADR-030) -------------------------------
 * `digestOf` below is the whole of it. Series are reduced to count, total,
 * min, max, first and last; a donut to its slices' shares; a KPI to the
 * pre-formatted figure the tile already prints. **A table contributes its
 * column names, its row count and per-column numeric aggregates — never a
 * cell.** That asymmetry is deliberate rather than tidy: in this catalog the
 * per-person data (defaulters, students, staff, late payers) is always a
 * TABLE, and the categorical axis of a bar/line/donut is always an
 * institutional dimension — school, class, month, year, status, mode,
 * department, age band. So the rule "labels yes, cells never" is what keeps
 * student names out of the org's provider account while leaving the insight
 * worth reading. A label the masking pipeline already replaced (docs/04 §3
 * rail 6) travels as `[masked]`, which is harmless and honest.
 *
 * -- Why the answer is cached -------------------------------------------------
 * It is spent on the ORG'S OWN key (Invariant 5). Two readers opening the same
 * card on the same day should not be two model calls, and neither should one
 * reader who closes the dialog and opens it again. Keyed by the chart, the
 * scope, the year and the permission class, exactly like the data it describes
 * — so it can never outlive a change of any of them.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ChartSpec, DataRow, Widget } from '@sap/chart-spec';
import { ERROR_CODES, PlatformError } from '@sap/shared';
import type { SessionClaims } from '../auth/session.js';
import { auditSink } from '../db/audit.js';
import { cacheGet, cacheKey, cacheSet } from '../cache/result-cache.js';
import { coalesce } from '../cache/single-flight.js';
import { getDecryptedApiKeyForOrg } from './ai-config.js';
import { PROVIDERS, type ProviderTool } from './ai-providers/index.js';
import { buildDashboard, isDashboardId } from './dashboards.js';
import { buildOverviewSlot, isOverviewSlot } from './overview.js';
import { viewReport } from './custom-reports.js';

/**
 * Which chart the reader has open. Mirrors the SPA's `ChartSource` (myView.ts).
 *
 * A Dashboard card names PARTS rather than one widget, because half of them are
 * arrangements of several: "Attendance and fee realisation" is three rings and
 * a total, and the Data Graphic reads the rings slot and the tiles slot
 * together. Explaining one of those from a single widget would be explaining a
 * chart the reader is not looking at — so the card says exactly which widgets
 * it draws, and the digest covers all of them. A card that draws one widget
 * names one part, which is the same thing with no special case.
 *
 * A report panel is always one widget, so it names one.
 */
export type InsightTarget =
  | { readonly kind: 'overview'; readonly parts: readonly { slot: string; widgetId: string }[] }
  | { readonly kind: 'report'; readonly reportId: string; readonly widgetId: string }
  | { readonly kind: 'custom'; readonly reportId: string; readonly widgetId: string };

export interface ChartInsight {
  /** One sentence: what this chart says. */
  readonly headline: string;
  /** Two to five short observations, in plain words. */
  readonly points: readonly string[];
  /** What the chart does NOT show, where that matters. Often absent. */
  readonly caveat?: string;
  /** So the panel can say where this came from and when. */
  readonly model: string;
  readonly generated_at: string;
  /** True when this answer came back from cache rather than the provider. */
  readonly cached: boolean;
}

/**
 * The model's output shape.
 *
 * A tool rather than free text, for the same reason `emit_report` is one
 * (ai-chat.ts): the provider interface reports tool calls, the platform gets
 * schema validation for free, and a headline and its points can be laid out
 * rather than printed as a paragraph. `min(2)` because one point is not a list
 * — it is the headline said twice.
 */
const insightSchema = z
  .object({
    headline: z.string().min(1).max(300),
    points: z.array(z.string().min(1).max(400)).min(2).max(5),
    caveat: z.string().min(1).max(400).optional(),
  })
  .strict();

const INSIGHT_TOOL: ProviderTool = {
  name: 'emit_insight',
  description:
    'End the turn by explaining the chart. headline is one plain sentence saying what it shows. points are 2-5 short observations a school administrator can act on or repeat in a meeting. caveat names what the figures do NOT cover, only where that matters.',
  inputSchema: zodToJsonSchema(insightSchema, { $refStrategy: 'none', target: 'jsonSchema7' }),
};

/** At most one retry after an invalid tool call, then the turn ends honestly. */
const MAX_TURNS = 3;

/**
 * How long an insight is held.
 *
 * Longer than the chart's own TTL on purpose. The chart is refetched because a
 * reader wants today's number; the SENTENCE about it does not change when a
 * receipt lands, and re-spending the org's key to rewrite "collections are
 * ahead of last year" every ten minutes would be the wrong trade. An hour, so
 * a school working through a morning pays for each card once.
 */
const INSIGHT_TTL_SECONDS = 3600;

export async function buildChartInsight(args: {
  session: SessionClaims;
  schoolIds: readonly string[];
  target: InsightTarget;
  academicYear: string;
  asOfDate: string;
  compareYear?: string | undefined;
  correlationId: string;
}): Promise<ChartInsight> {
  const { session, schoolIds, target, correlationId } = args;

  const widgets = await loadWidgets(args);
  const digests = widgets.map(digestOf);
  /* One chart is sent as itself; a composed card as the parts it draws, so the
     model is told it is looking at one card rather than several charts. */
  const digest = digests.length === 1 ? digests[0] : { card: cardTitleOf(digests), parts: digests };

  const key = cacheKey({
    kind: `ai:insight:${targetKey(target)}`,
    schoolIds,
    permissionClass: session.permission_class,
    filters: {
      academic_year: args.academicYear,
      as_of: args.asOfDate,
      compare_year: args.compareYear ?? null,
    },
  });

  const hit = await cacheGet<Omit<ChartInsight, 'cached'>>(key);
  if (hit !== null) return { ...hit.value, cached: true };

  /**
   * Single-flight, not merely cached. Two readers opening the same card at the
   * same moment is the ordinary case on a shared screen, and without this it is
   * two charges on the org's key for one answer.
   */
  return coalesce(key, async () => {
    const again = await cacheGet<Omit<ChartInsight, 'cached'>>(key);
    if (again !== null) return { ...again.value, cached: true };

    /**
     * routes/ai.ts already checked `ai_status` (Invariant 5); `null` here means
     * the config changed between that check and this call — refused the same way.
     */
    const keyInfo = await getDecryptedApiKeyForOrg(session.org_id);
    if (keyInfo === null) {
      throw new PlatformError({
        code: ERROR_CODES.AI_NOT_ACTIVE,
        message: 'AI reports are not set up for this organization.',
        correlationId,
      });
    }

    const provider = PROVIDERS[keyInfo.provider];
    const client = provider.createClient({ apiKey: keyInfo.apiKey, model: keyInfo.model });

    let state = client.initialState(
      `Explain this chart to the person looking at it.\n\n${JSON.stringify(digest, null, 2)}`,
    );
    let parsed: z.infer<typeof insightSchema> | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;

    for (let turn = 0; parsed === null && turn < MAX_TURNS; turn += 1) {
      let calls;
      try {
        const step = await client.step(state, SYSTEM_PROMPT, [INSIGHT_TOOL]);
        state = step.state;
        calls = step.toolCalls;
        inputTokens += step.usage.inputTokens;
        outputTokens += step.usage.outputTokens;
        cacheReadTokens += step.usage.cacheReadTokens;
      } catch (err) {
        throw new PlatformError({
          code: ERROR_CODES.AI_PROVIDER_ERROR,
          message: err instanceof Error ? err.message : 'The AI provider could not explain this chart.',
          correlationId,
        });
      }

      const call = calls.find((c) => c.name === 'emit_insight');
      if (call === undefined) {
        /* Answered in prose, or called nothing. Nudged rather than accepted:
           the panel lays out a headline and points, and a paragraph is not one. */
        state = client.withNudge(state, 'Answer by calling emit_insight, not with plain text.');
        continue;
      }
      const check = insightSchema.safeParse(call.args);
      if (check.success) {
        parsed = check.data;
        break;
      }
      state = client.withToolOutcomes(state, [
        {
          callId: call.id,
          name: 'emit_insight',
          error: `That was not a valid insight: ${check.error.issues.map((i) => i.message).join('; ')}. Call emit_insight again.`,
        },
      ]);
    }

    if (parsed === null) {
      throw new PlatformError({
        code: ERROR_CODES.AI_PROVIDER_ERROR,
        message: 'The AI could not put this chart into words. Try again in a moment.',
        correlationId,
      });
    }

    /**
     * The same `ai.query` event Ask AI writes (docs/08 §7), not a new kind:
     * what an auditor is asking is "what did this org spend its key on, and
     * about what data", and a second event shape would mean two queries to
     * answer it. `question` records which chart was explained.
     */
    await auditSink.write({
      kind: 'ai.query',
      at: new Date().toISOString(),
      actor_sub: session.sub,
      org_id: session.org_id,
      correlation_id: correlationId,
      school_ids: schoolIds,
      question: `Insight: ${cardTitleOf(digests)} (${targetKey(target)})`,
      tools_invoked: ['emit_insight'],
      model: keyInfo.model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens,
      ...(target.kind === 'overview' ? {} : { report_id: target.reportId }),
    });

    const value: Omit<ChartInsight, 'cached'> = {
      headline: parsed.headline,
      points: parsed.points,
      ...(parsed.caveat === undefined ? {} : { caveat: parsed.caveat }),
      model: keyInfo.model,
      generated_at: new Date().toISOString(),
    };
    await cacheSet(key, value, INSIGHT_TTL_SECONDS);
    return { ...value, cached: false };
  });
}

const SYSTEM_PROMPT = `You explain one chart from a school analytics platform to the person looking at it — usually a principal, an accountant or a trust director. They can see the chart. They want to know what it means.

Rules, all of them binding:
- Plain words. Short sentences. No jargon, no statistics vocabulary, no "leverage", "delta", "YoY" or "trend line". Write the way a good colleague would explain it across a desk.
- Use ONLY the figures in the digest you are given. Never estimate, extrapolate or invent a number, a cause or a comparison that is not in it. If something is not there, do not mention it.
- Quote figures exactly as they are written in the digest. They are already formatted for this country (₹, Cr, L, %); rewriting them would make the words disagree with the chart beside them.
- Say what changed and where the extremes are, because that is what a reader cannot see at a glance. Do not simply list the values back.
- Never guess WHY something happened. You have numbers, not causes. "Collections in December are the highest of the year" is yours to say; "because of the fee deadline" is not.
- If the digest says the chart covers few categories, a short period, or that data was partial, say so in the caveat rather than writing confident sentences over a thin base.
- Nobody is named. If a label reads "[masked]", refer to it as a masked entry and do not speculate about who it is.

Call emit_insight exactly once.`;

// -- Loading the chart the reader is looking at ---------------------------------

/**
 * The widgets the reader is looking at, rebuilt through the SAME cached path
 * the screen used — so this can never describe a number the screen does not
 * show, and costs a cache read rather than a scan (Invariant 1).
 */
async function loadWidgets(args: {
  session: SessionClaims;
  schoolIds: readonly string[];
  target: InsightTarget;
  academicYear: string;
  asOfDate: string;
  compareYear?: string | undefined;
  correlationId: string;
}): Promise<Widget[]> {
  const { target, correlationId } = args;

  if (target.kind === 'overview') {
    /* Each slot fetched once however many parts name it — the Data Graphic's
       two parts share the rings slot, and asking for it twice would be two
       cache reads for one card. */
    const bySlot = new Map<string, readonly Widget[]>();
    const found: Widget[] = [];
    for (const part of target.parts) {
      let widgets = bySlot.get(part.slot);
      if (widgets === undefined) {
        widgets = await loadSlot(args, part.slot);
        bySlot.set(part.slot, widgets);
      }
      const widget = widgets.find((w) => w.id === part.widgetId);
      if (widget !== undefined) found.push(widget);
    }
    if (found.length === 0) {
      /* Fail loud (§10): a card whose widgets have all been renamed must say
         so, not come back as an insight about whatever else the slot holds. */
      throw new PlatformError({
        code: ERROR_CODES.REPORT_DEFINITION_NOT_FOUND,
        message: 'That card no longer draws the charts this was asked about.',
        correlationId,
      });
    }
    return found;
  }

  const spec = await loadReportSpec(args);
  const widget = spec.find((w) => w.id === target.widgetId);
  if (widget === undefined) {
    throw new PlatformError({
      code: ERROR_CODES.REPORT_DEFINITION_NOT_FOUND,
      message: 'That chart is not part of this report any more.',
      correlationId,
    });
  }
  return [widget];
}

async function loadSlot(
  args: { session: SessionClaims; schoolIds: readonly string[]; academicYear: string; asOfDate: string; correlationId: string },
  slot: string,
): Promise<readonly Widget[]> {
  if (!isOverviewSlot(slot)) {
    throw new PlatformError({
      code: ERROR_CODES.REPORT_DEFINITION_NOT_FOUND,
      message: 'That dashboard card does not exist.',
      correlationId: args.correlationId,
    });
  }
  const card = await buildOverviewSlot({
    session: args.session,
    schoolIds: args.schoolIds,
    slot,
    academicYear: args.academicYear,
    asOfDate: args.asOfDate,
    correlationId: args.correlationId,
  });
  if (card.status !== 'ok') {
    throw new PlatformError({
      code: ERROR_CODES.REPORT_DEFINITION_NOT_FOUND,
      message: card.reason ?? 'That card could not be built, so there is nothing to explain.',
      correlationId: args.correlationId,
    });
  }
  return card.widgets;
}

async function loadReportSpec(args: {
  session: SessionClaims;
  schoolIds: readonly string[];
  target: InsightTarget;
  academicYear: string;
  asOfDate: string;
  compareYear?: string | undefined;
  correlationId: string;
}): Promise<readonly Widget[]> {
  const { session, schoolIds, target, correlationId } = args;

  if (target.kind === 'overview') return [];

  if (target.kind === 'report') {
    if (!isDashboardId(target.reportId)) {
      throw new PlatformError({
        code: ERROR_CODES.REPORT_DEFINITION_NOT_FOUND,
        message: 'That report does not exist.',
        correlationId,
      });
    }
    const built = await buildDashboard({
      session,
      schoolIds,
      reportId: target.reportId,
      academicYear: args.academicYear,
      asOfDate: args.asOfDate,
      ...(args.compareYear === undefined ? {} : { compareYear: args.compareYear }),
      correlationId,
    });
    return built.spec.widgets;
  }

  /**
   * A report of the reader's own. `viewReport` is owner/visibility gated and
   * intersects the stored scope with the token's (ADR-032) on its own, so a
   * tampered id fails here exactly as it does on the screen that draws it —
   * before a single token is spent.
   */
  const view = await viewReport({
    session,
    correlationId,
    id: target.reportId,
    requestedSchoolIds: schoolIds,
  });
  return (view.spec satisfies ChartSpec).widgets;
}

function targetKey(target: InsightTarget): string {
  return target.kind === 'overview'
    ? `overview:${target.parts.map((p) => `${p.slot}.${p.widgetId}`).join('+')}`
    : `${target.kind}:${target.reportId}:${target.widgetId}`;
}

/** What to call a card built from several widgets: its parts, in order. */
function cardTitleOf(digests: readonly { title: string }[]): string {
  return digests.map((d) => d.title).join(' · ');
}

// -- The digest: ADR-030's "aggregates the orchestrator can safely pass back" ----

/** At most this many category labels. A model does not read the 400th month. */
const MAX_LABELS = 60;

interface SeriesDigest {
  readonly name: string;
  readonly points: number;
  readonly total: number | null;
  readonly highest: { readonly label: string; readonly value: number } | null;
  readonly lowest: { readonly label: string; readonly value: number } | null;
  readonly first: { readonly label: string; readonly value: number } | null;
  readonly last: { readonly label: string; readonly value: number } | null;
}

interface Digest {
  readonly title: string;
  readonly chart: string;
  readonly x_means?: string;
  readonly y_means?: string;
  readonly categories?: readonly string[];
  readonly categories_total?: number;
  readonly series?: readonly SeriesDigest[];
  readonly slices?: readonly { label: string; share_pct: number }[];
  readonly figure?: { readonly label: string; readonly value: string; readonly parts?: readonly { label: string; value: string }[] };
  readonly table?: {
    readonly columns: readonly string[];
    readonly masked_columns: readonly string[];
    readonly row_count: number;
    readonly truncated: boolean;
    readonly numeric_columns: readonly { label: string; total: number; highest: number; lowest: number }[];
  };
  readonly caveats: readonly string[];
}

/**
 * One widget → what the model may see.
 *
 * [MANDATORY] ADR-030: nothing returned from here is a result ROW. A table
 * contributes shape and column aggregates and never a cell — see the header
 * for why that asymmetry is the load-bearing part of this feature's privacy
 * posture, not an omission.
 */
export function digestOf(widget: Widget): Digest {
  const caveats: string[] = [];
  const title = widget.title ?? widget.id;

  if (widget.type === 'kpi') {
    return {
      title,
      chart: 'a single figure',
      figure: {
        label: widget.label,
        value: widget.value,
        ...(widget.breakdown === undefined ? {} : { parts: widget.breakdown.map((p) => ({ label: p.label, value: p.value })) }),
      },
      caveats,
    };
  }

  if (widget.type === 'table') {
    const numeric = widget.columns.flatMap((column) => {
      const values = widget.rows.map((row) => numberOf(row[column.field])).filter((n): n is number => n !== null);
      /* A column is "numeric" only if most of it parsed — one stray number in a
         column of names is not a measure, and summing it would be a fiction. */
      if (values.length < Math.max(2, Math.ceil(widget.rows.length * 0.8))) return [];
      return [{
        label: column.label,
        total: round(values.reduce((sum, n) => sum + n, 0)),
        highest: round(Math.max(...values)),
        lowest: round(Math.min(...values)),
      }];
    });
    if (widget.truncated === true) caveats.push('This table was cut off at the platform row cap, so it is not the whole list.');
    if (widget.rows.length === 0) caveats.push('This table has no rows for the current selection.');
    return {
      title,
      chart: 'a table',
      table: {
        columns: widget.columns.map((c) => c.label),
        masked_columns: widget.columns.filter((c) => c.masked === true).map((c) => c.label),
        row_count: widget.rows.length,
        truncated: widget.truncated === true,
        numeric_columns: numeric,
      },
      caveats,
    };
  }

  if (widget.type === 'donut') {
    const slices = widget.data.flatMap((row) => {
      const value = numberOf(row[widget.value_field]);
      const label = labelOf(row[widget.label_field]);
      return value === null ? [] : [{ label, value }];
    });
    const total = slices.reduce((sum, s) => sum + s.value, 0);
    if (slices.length === 0) caveats.push('This chart has no slices for the current selection.');
    return {
      title,
      chart: 'a donut showing how a total splits up',
      slices: slices.map((s) => ({ label: s.label, share_pct: total === 0 ? 0 : round((s.value / total) * 100) })),
      caveats,
    };
  }

  /* bar and line share one shape: categories on x, one or more measures on y. */
  const rows = widget.data;
  const labels = rows.map((row) => labelOf(row[widget.x]));
  const measures: { field: string; name: string }[] =
    widget.type === 'bar' && widget.series !== undefined
      ? widget.series.map((s) => ({ field: s.field, name: s.label }))
      : [{ field: widget.y, name: widget.y_title ?? widget.y }];

  if (rows.length === 0) caveats.push('This chart has nothing to plot for the current selection.');
  if (rows.length > 0 && rows.length < 3) caveats.push('This chart covers only a couple of points, which is a thin base for any comparison.');
  if (labels.length > MAX_LABELS) caveats.push(`Only the first ${String(MAX_LABELS)} of ${String(labels.length)} categories are listed here.`);

  return {
    title,
    chart: widget.type === 'bar' ? 'a bar chart' : 'a line chart over time',
    ...(widget.x_title === undefined ? {} : { x_means: widget.x_title }),
    ...(widget.y_title === undefined ? {} : { y_means: widget.y_title }),
    categories: labels.slice(0, MAX_LABELS),
    categories_total: labels.length,
    series: measures.map(({ field, name }) => summarise(name, labels, rows.map((row) => numberOf(row[field])))),
    caveats,
  };
}

function summarise(name: string, labels: readonly string[], values: readonly (number | null)[]): SeriesDigest {
  const points = values.flatMap((value, index) =>
    value === null ? [] : [{ label: labels[index] ?? String(index), value }],
  );
  if (points.length === 0) {
    return { name, points: 0, total: null, highest: null, lowest: null, first: null, last: null };
  }
  let highest = points[0] as { label: string; value: number };
  let lowest = highest;
  let total = 0;
  for (const point of points) {
    total += point.value;
    if (point.value > highest.value) highest = point;
    if (point.value < lowest.value) lowest = point;
  }
  return {
    name,
    points: points.length,
    total: round(total),
    highest: { label: highest.label, value: round(highest.value) },
    lowest: { label: lowest.label, value: round(lowest.value) },
    first: rounded(points[0]),
    last: rounded(points[points.length - 1]),
  };
}

function rounded(point: { label: string; value: number } | undefined): { label: string; value: number } | null {
  return point === undefined ? null : { label: point.label, value: round(point.value) };
}

/** Two decimals is more than any figure on these charts is quoted to. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * `DataRow` is a `z.record`, so indexing it yields `Cell | undefined` — a row
 * genuinely may not carry the field a widget names. Both readers take the
 * wider type rather than being called through a non-null assertion: a missing
 * field is a point with no value, which `summarise` already skips, and a
 * missing label is an em dash, which is what the chart itself draws.
 */
function numberOf(cell: DataRow[string] | undefined): number | null {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null;
  return null;
}

function labelOf(cell: DataRow[string] | undefined): string {
  return cell === null || cell === undefined ? '—' : String(cell);
}
