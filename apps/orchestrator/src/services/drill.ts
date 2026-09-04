/**
 * Drill-down — one level of a curated drill path (ADR-020, docs/06 §4.4).
 *
 * Contract source: ADR-020 (≤3 levels; every level runs the report's own
 * pre-vetted SQL with a different GROUP BY; clicked values enter as BOUND
 * parameters, so a click can only narrow) · ADR-012/028 (the result-cache key
 * carries level and drill context) · ADR-015 (a level's answer leaves here as a
 * chart-spec widget, never as markup) · docs/08 §7 (every drill click is
 * audited with its context).
 *
 * -- What this module is NOT --------------------------------------------------
 * It is not a second serving path. A level is `run_predefined` with one
 * `query_keys` entry, through the same MCP client, the same guard, the same
 * caps and the same masking as the dashboard it drilled from. What it adds is
 * validation of the CLICK: that the level exists, that the context matches the
 * path's dimensions in order, and that a clicked school is one this session
 * could already see.
 *
 * -- Why the click is re-validated rather than trusted ------------------------
 * The drill context arrives from a browser. `drillPathFor` is the only source
 * of legal dimensions, so a request naming a dimension no level declares is
 * refused rather than turned into a GROUP BY — which is the enforcement half of
 * ADR-020's "valid paths come from a curated Dimension Hierarchy Catalog". A
 * clicked school is checked against the resolved scope for the same reason
 * every other request is: scope is law (Invariant 2), and a drill click is not
 * a special case.
 */

import { widgetSchema, type Widget } from '@sap/chart-spec';
import { ERROR_CODES, PlatformError } from '@sap/shared';
import type { SessionClaims } from '../auth/session.js';
import { withMcp } from '../mcp/client.js';
import { schoolNames } from '../db/registry.js';
import { cacheGet, cacheKey, cacheSet, refreshInBackground } from '../cache/result-cache.js';
import { config } from '../config.js';
import {
  Merged,
  drillPathFor,
  resolveReportParams,
  type DashboardId,
  type DrillLevel,
  type DrillPath,
  type PredefinedResult,
} from './dashboards.js';

/** One clicked `{dim, value}` pair, with the text a breadcrumb shows for it. */
export interface DrillStep {
  readonly dim: string;
  readonly value: string;
  readonly label: string;
}

export interface DrillResult {
  /** The chart that replaces the panel, in place. */
  readonly widget: Widget;
  readonly level: 1 | 2 | 3;
  readonly context: readonly DrillStep[];
  /**
   * The schools this level actually read — narrowed by a school click, and
   * equal to the request's set otherwise. Returned rather than re-derived at
   * the route so the audit trail records the slice that was SERVED: a click
   * into one school logged against all three answers "who saw what?" wrongly.
   */
  readonly school_ids: readonly string[];
  /**
   * The statement behind THIS level. Invariant 6 does not stop applying because
   * a chart was reached by clicking: docs/06 §4.4 wants every level's SQL in the
   * logic panel, and the page appends this to the base report's list.
   */
  readonly query: { readonly key: string; readonly description: string; readonly sql: string };
  readonly group_by: string;
  /**
   * Caveats true at THIS level, shown against the chart rather than in the
   * report's notes list. Fee Defaulters' quarter level is the reason: its bars
   * are honest per-quarter headcounts that must not be added together, and a
   * warning three screens below the chart is a warning nobody reads.
   */
  readonly notes: readonly string[];
  /** Named, never blank (ADR-011) — the same contract the dashboard route has. */
  readonly degraded: readonly { key: string; message: string }[];
  readonly degraded_schools: readonly { school_id: string; message: string }[];
}

/** ADR-020 and `drillContextSchema`: three levels, and the third is a leaf. */
const MAX_LEVELS = 3;

export interface DrillRequest {
  readonly session: SessionClaims;
  /** The scope this request resolved to, already intersected with the token. */
  readonly schoolIds: readonly string[];
  readonly reportId: DashboardId;
  readonly widgetId: string;
  readonly level: number;
  readonly context: readonly DrillStep[];
  readonly academicYear: string;
  readonly asOfDate: string;
  /**
   * The comparison year the parent report was built with. Threaded rather than
   * re-derived for the reason every other filter is: a level that quietly picked
   * its own second year could show a breakdown computed against a different
   * comparison from the chart it was reached by clicking. The drilled LEVELS
   * themselves draw the current year only (see `DRILL_PATHS`), but the year is
   * still a declared parameter of the report and `run_predefined` refuses a
   * declared-and-missing one outright.
   */
  readonly compareYear?: string | undefined;
  readonly correlationId: string;
}

/**
 * Check a click against the catalog and say exactly what it resolves to.
 *
 * Separated from the fetch so the route can refuse an impossible drill before
 * it costs a database connection, and so the check is testable without a
 * database (test/drill-path.test.ts). Every rejection names what was wrong:
 * a drill that silently fell back to level 1 would render the whole-school
 * chart under a breadcrumb claiming a class, which is the success-shaped
 * failure CODING_GUIDELINES §10 names.
 */
export function resolveDrill(args: {
  reportId: DashboardId;
  widgetId: string;
  level: number;
  context: readonly DrillStep[];
  schoolIds: readonly string[];
  correlationId: string;
}): {
  path: DrillPath;
  level: DrillLevel;
  /** The schools this level reads. Narrowed by a `scope` step, else unchanged. */
  schoolIds: readonly string[];
  /** Extra bound filter values this level's context contributes. */
  params: Record<string, string | number>;
} {
  const path = drillPathFor(args.reportId);
  if (path === undefined || path.widget_id !== args.widgetId) {
    throw new PlatformError({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'This chart does not drill down.',
      details: { report_id: args.reportId, widget_id: args.widgetId },
      correlationId: args.correlationId,
    });
  }

  if (!Number.isInteger(args.level) || args.level < 2 || args.level > MAX_LEVELS) {
    throw new PlatformError({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: `A drill level must be between 2 and ${String(MAX_LEVELS)}.`,
      details: { level: args.level },
      correlationId: args.correlationId,
    });
  }

  const level = path.levels[args.level - 1];
  if (level === undefined || level.query === undefined) {
    throw new PlatformError({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'This report has no further level to drill into.',
      details: { level: args.level },
      correlationId: args.correlationId,
    });
  }

  /**
   * The context IS the path, replayed. Level 3 is reached by clicking level 2,
   * which was reached by clicking level 1 — so a level-3 request carries
   * exactly two steps, and they are the two dimensions the first two levels
   * declare, in that order. Anything else is a fabricated context rather than
   * a click, and is refused rather than partially honoured.
   */
  if (args.context.length !== args.level - 1) {
    throw new PlatformError({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'That drill request does not match this report’s drill path.',
      details: { level: args.level, steps: args.context.length },
      correlationId: args.correlationId,
    });
  }

  let schoolIds = args.schoolIds;
  const params: Record<string, string | number> = {};

  for (const [index, step] of args.context.entries()) {
    const from = path.levels[index];
    const into = path.levels[index + 1];
    if (from === undefined || into === undefined || from.drill_dim !== step.dim) {
      throw new PlatformError({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'That is not a dimension this report drills on.',
        details: { position: index + 1, dim: step.dim },
        correlationId: args.correlationId,
      });
    }

    const narrow = into.narrow;
    if (narrow === undefined) continue;

    if (narrow.kind === 'scope') {
      /**
       * [MANDATORY] Invariant 2. The clicked school must be one this request
       * already resolved to — which is itself already intersected with the
       * launch token (middleware/scope.ts). A drill can only ever narrow inside
       * what the reader could already see; the MCP layer checks it again
       * independently (ADR-007).
       */
      if (!args.schoolIds.includes(step.value)) {
        throw new PlatformError({
          code: ERROR_CODES.SCOPE_VIOLATION,
          message: 'That school is not in the current selection.',
          diagnostics: { requested: step.value },
          correlationId: args.correlationId,
        });
      }
      schoolIds = [step.value];
      continue;
    }

    /**
     * A bound value, typed as the catalog declares it. `run_predefined` refuses
     * a string where a number was declared, but the value arrived from a click
     * in a browser and this is the layer that knows which it should be — so a
     * malformed one is a validation error naming the parameter, not a type
     * error four layers down.
     *
     * A string value is bound as it stands. It reaches MySQL as a parameter
     * like every other filter (CODING_GUIDELINES §9), so a class called
     * `'; DROP` is a class that matches nothing, not a statement.
     */
    if (narrow.type === 'string') {
      params[narrow.param] = step.value;
      continue;
    }

    const parsed = Number(step.value);
    if (!Number.isFinite(parsed)) {
      throw new PlatformError({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: `"${step.dim}" must be a number to drill on.`,
        details: { parameter: narrow.param },
        correlationId: args.correlationId,
      });
    }
    params[narrow.param] = parsed;
  }

  return { path, level, schoolIds, params };
}

export async function buildDrill(args: DrillRequest): Promise<DrillResult> {
  const resolved = resolveDrill({
    reportId: args.reportId,
    widgetId: args.widgetId,
    level: args.level,
    context: args.context,
    schoolIds: args.schoolIds,
    correlationId: args.correlationId,
  });
  const { path, level, schoolIds, params: drillParams } = resolved;
  const queryKey = level.query;
  if (queryKey === undefined) throw new Error('unreachable: resolveDrill requires a query');

  const scope = await schoolNames(schoolIds);
  if (scope.length === 0) {
    throw new PlatformError({
      code: ERROR_CODES.TENANT_UNAVAILABLE,
      message: 'That school is not available for analytics right now.',
      correlationId: args.correlationId,
    });
  }

  /**
   * The base report's own filter values, plus whatever this level's context
   * binds. Reusing `resolveReportParams` rather than assembling params here is
   * what keeps a drilled view on the SAME filters as the report it came from —
   * a level that quietly re-derived the academic year could show a class
   * breakdown of a different year under the parent chart's heading.
   */
  const { params: baseParams } = resolveReportParams(args.reportId, {
    academicYear: args.academicYear,
    asOfDate: args.asOfDate,
    compareYear: args.compareYear,
  });
  const params: Record<string, string | number> = { ...baseParams, ...drillParams };

  /**
   * [MANDATORY] ADR-012 as amended by ADR-028: the key is report + LEVEL +
   * drill-context + filters + school-set + permission class. Level and context
   * are in the kind, the narrowed school set is the school set, and the
   * permission class is what stops a Principal's warmed entry from being served
   * to a reader whose masking differs.
   */
  const key = cacheKey({
    kind: `drill:${args.reportId}:${args.widgetId}:L${String(args.level)}:${contextKey(args.context)}`,
    schoolIds,
    permissionClass: args.session.permission_class,
    filters: params,
  });

  const hit = await cacheGet<DrillResult>(key);
  if (hit !== null) {
    /**
     * A stale entry is served NOW and rebuilt behind the response, exactly as
     * the dashboard path does it (cache/result-cache.ts). The rebuild is this
     * same call with the same arguments, so it runs on this session's scope and
     * permission class and can only rewrite the key this reader could read.
     */
    if (hit.stale) {
      refreshInBackground(key, async () =>
        buildDrill({ ...args, correlationId: `${args.correlationId}:refresh` }),
      );
    }
    return hit.value;
  }

  const result = await withMcp(args.session, args.correlationId, schoolIds, async (mcp) =>
    mcp.call<PredefinedResult>('run_predefined', {
      report_id: args.reportId,
      school_ids: [...schoolIds],
      params,
      query_keys: [queryKey],
    }),
  );

  const merged = new Merged(result);
  const fields = path.measures.map((m) => m.field);
  /**
   * The pending marker is summed alongside the measures so it survives the
   * per-school merge, then dropped before the widget is built — it decides what
   * the note says, and is never a bar.
   */
  const pending = level.pending;
  const summed = pending === undefined ? fields : [...fields, pending.field];
  /**
   * Summed across the level's school set, which after a school click is one
   * school. Ordered by the level's own `seq` where it has one — quarters and
   * classes both have a right order that is not "biggest first", and sorting
   * class labels as text puts X before IX.
   */
  const rows = merged.sumBy(queryKey, level.x, summed, 'seq');

  /**
   * Categories that exist but cannot carry a value yet, in the order the axis
   * draws them, so the sentence reads the way the chart does.
   */
  if (pending !== undefined && !merged.returnsColumn(queryKey, pending.field)) {
    /**
     * [MANDATORY] §10. The alternative is a note that confidently names every
     * category as not-yet-due because a column went missing — a wrong answer
     * wearing the shape of a right one, which is worse than no chart at all.
     */
    throw new PlatformError({
      code: ERROR_CODES.INVALID_CHART_SPEC,
      message: 'That level of the report could not be produced.',
      diagnostics: { query: queryKey, missing_column: pending.field },
      correlationId: args.correlationId,
    });
  }

  const pendingLabels =
    pending === undefined
      ? []
      : rows
          .filter((row) => numberOr(row[pending.field], 0) === 0)
          .map((row) => String(row[level.x] ?? '').trim())
          .filter((label) => label !== '');

  const widget: Widget = {
    id: args.widgetId,
    type: 'bar',
    title: level.title.replace('{context}', breadcrumb(args.context)),
    x: level.x,
    y: fields[0] ?? 'value',
    /**
     * `series` only when there really are several. The spec requires at least
     * two entries, and a one-entry "group" would draw a legend that restates
     * the chart's own title while costing the single-series bar its gradient
     * and tallest-bar highlight (react/widgets.tsx). One measure is a plain
     * bar, which is what Fee Defaulters wants and what the schema enforces.
     */
    ...(path.measures.length > 1 ? { series: [...path.measures] } : {}),
    data: rows.map((row) => {
      const out: Record<string, string | number> = { [level.x]: String(row[level.x] ?? '—') };
      /**
       * The drill VALUE travels as its own field when it is not the axis label
       * — a quarter reads "Q2" and drills on 2 — so the next click binds the
       * number the SQL expects rather than the string the axis shows.
       */
      if (level.drill_value_field !== undefined && level.drill_value_field !== level.x) {
        out[level.drill_value_field] = numberOr(row[level.drill_value_field], 0);
      }
      for (const field of fields) out[field] = numberOr(row[field], 0);
      /** `pending.field` is deliberately absent: bookkeeping, not a measure. */
      return out;
    }),
    /** The leaf declares no `drill_dim`, so its chart renders inert. */
    ...(level.drill_dim === undefined
      ? { drillable: false }
      : { drillable: true, drill_dim: level.drill_dim, ...(level.drill_value_field === undefined ? {} : { drill_value_field: level.drill_value_field }) }),
    drill_context: args.context.map((step) => ({ dim: step.dim, value: step.value })),
  };

  /**
   * [MANDATORY] CODING_GUIDELINES §10: the widget is schema-validated before it
   * leaves, for the same reason `ChartSpecView` validates one before drawing.
   * A drilled widget is assembled from a catalog table and a result set, and
   * "assembled by our own code" is not a substitute for a check.
   */
  const parsed = widgetSchema.safeParse(widget);
  if (!parsed.success) {
    throw new PlatformError({
      code: ERROR_CODES.INVALID_CHART_SPEC,
      message: 'That level of the report could not be rendered.',
      diagnostics: { issues: parsed.error.issues.map((i) => i.path.join('.')) },
      correlationId: args.correlationId,
    });
  }

  const definition = merged.definitions().find((d) => d.key === queryKey);
  const outcome: DrillResult = {
    widget: parsed.data,
    level: args.level as 1 | 2 | 3,
    context: args.context,
    school_ids: [...schoolIds],
    query: definition ?? {
      key: queryKey,
      description: 'This level could not be read.',
      sql: '',
    },
    group_by: level.group_by,
    notes: [
      ...(level.note === undefined ? [] : [level.note]),
      ...(pending === undefined || pendingLabels.length === 0
        ? []
        : [
            (pendingLabels.length === rows.length && pending.note_all !== undefined
              ? pending.note_all
              : pending.note
            )
              .replace('{categories}', listOf(pendingLabels))
              .replace('{as_of}', args.asOfDate),
          ]),
    ],
    degraded: merged.failures(),
    degraded_schools: merged.schoolFailures(),
  };

  /**
   * Only a complete answer is cached, exactly as `buildDashboard` decides it:
   * caching a level whose one query timed out would freeze that failure for the
   * whole TTL, and a drill click is precisely the interaction a reader retries.
   */
  if (outcome.degraded.length === 0 && outcome.degraded_schools.length === 0) {
    await cacheSet(key, outcome, config.CACHE_TTL_SECONDS);
  }

  return outcome;
}

/**
 * The drill context as a cache-key fragment.
 *
 * Only `dim` and `value` — never `label`. The label is display text that can
 * differ for the same slice (a school renamed in the registry between two
 * sessions), and letting it into the key would split the cache on a string that
 * changes nothing about the rows returned.
 */
function contextKey(context: readonly DrillStep[]): string {
  return context.map((step) => `${step.dim}=${step.value}`).join('|');
}

/** "St Mark's · Q2" — what the level's title interpolates. */
function breadcrumb(context: readonly DrillStep[]): string {
  return context.map((step) => step.label).join(' · ');
}

/**
 * "Q3 and Q4", "Q2, Q3 and Q4" — an Oxford-comma-free list, because the note is
 * a sentence a bursar reads rather than a serialisation.
 */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

function numberOr(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

// -- The editor's view of a drill path (docs/06 §4.1/§4.2, ADR-020) ----------

/**
 * The chart types a drill LEVEL may be drawn as.
 *
 * Not the full widget vocabulary, and the gap is not an oversight:
 *
 *   `bar` and `line` are both Recharts cartesian charts over the level's own
 *   rows, so a click on category N means the same thing on either and
 *   `drillTargetAt` reads the identical row (react/widgets.tsx). A level that
 *   drills can therefore be either.
 *
 *   `donut` is a Pie. It carries no category axis to click, and its subject is
 *   proportion — parts of one whole. So it is offered ONLY at a leaf level
 *   (nothing to click) whose path draws ONE measure (there is a whole for the
 *   slices to be parts of). A donut of Fee Collection's demand/collected/
 *   pending would draw three overlapping totals as if they summed to something.
 *
 * `table` is absent because a drilled level's rows already print under every
 * chart, and `kpi` because a level is a breakdown, not a single figure.
 */
export type DrillChart = 'bar' | 'line' | 'donut';

/** One row of the editor's "Drill path" control (docs/06 §4.1). */
export interface DrillLevelView {
  /** 1-based, as docs/06 §4.1's definition model numbers them. */
  readonly n: number;
  /** What this level GROUPS BY — the catalog's `group_by`, shown read-only. */
  readonly dim: string;
  /** The dimension a click at this level pushes; `null` at the leaf. */
  readonly drills_on: string | null;
  /** The dimensions already bound by the time this level is reached. */
  readonly inherit: readonly string[];
  readonly chart: DrillChart;
  /** What this level may be switched to — see `DrillChart`. */
  readonly chart_options: readonly DrillChart[];
}

/**
 * A report's drill path as the report EDITOR needs it (docs/06 §3's visual
 * editor, §4.2's "editor level-pickers offer only valid children of the level
 * above").
 *
 * The dimensions are read-only on purpose, and that is the enforcement half of
 * ADR-020's curated catalog rather than a simplification of it: `DRILL_PATHS`
 * is the only source of a legal path, `resolveDrill` refuses anything else, and
 * an editor that let a reader type a dimension would be offering a choice the
 * server exists to reject. What a clone genuinely owns is docs/06 §4.3's
 * "clones may change or disable the path": the `enabled` switch, and how each
 * level is DRAWN.
 */
export interface DrillView {
  /** The one widget of the report that drills. */
  readonly widget_id: string;
  /** Does the base report have a curated path at all? */
  readonly available: boolean;
  /** Is it switched on for this clone? Always false when `available` is false. */
  readonly enabled: boolean;
  /** Empty when `available` is false. */
  readonly levels: readonly DrillLevelView[];
}

/**
 * A level's stored chart choice, keyed by level number as a string.
 *
 * A record and not an array because it is a SPARSE statement of divergence: a
 * clone that changed only its leaf stores only its leaf, and every level the
 * reader left alone keeps whatever the catalog draws rather than a stored copy
 * of it that would freeze on the day the catalog changed.
 */
export type DrillCharts = Readonly<Partial<Record<string, DrillChart>>>;

/** The request shape for a stored block, before it is checked against the catalog. */
export interface DrillSelection {
  readonly enabled: boolean;
  readonly charts?: DrillCharts | undefined;
}

/**
 * What a level is drawn as, absent a stored choice.
 *
 * `bar` at every level, because that is what `buildDrill` actually emits — read
 * off the emitter's behaviour rather than declared beside it, so the editor
 * cannot show a reader a default the server does not draw.
 */
const DEFAULT_LEVEL_CHART: DrillChart = 'bar';

function chartOptionsFor(level: DrillLevel, measures: number): readonly DrillChart[] {
  /** A level that drills must stay clickable, and only cartesian charts are. */
  if (level.drill_dim !== undefined) return ['bar', 'line'];
  return measures === 1 ? ['bar', 'line', 'donut'] : ['bar', 'line'];
}

/**
 * Resolve the catalog's path plus a clone's stored choices into the block the
 * editor renders and the client sends back.
 *
 * Returns a view with `available: false` — never `null` — when the base report
 * has no curated path, so the editor can say WHY the drill-down option is off
 * instead of silently omitting the control and leaving a reader to conclude the
 * feature is broken (CODING_GUIDELINES §18).
 */
export function describeDrillPath(args: {
  reportId: DashboardId;
  /** A widget-scoped clone drills only if it kept the widget that drills. */
  widgetScope?: string | undefined;
  enabled: boolean;
  charts?: DrillCharts | undefined;
}): DrillView {
  const path = drillPathFor(args.reportId);
  if (path === undefined || (args.widgetScope !== undefined && args.widgetScope !== path.widget_id)) {
    return { widget_id: path?.widget_id ?? '', available: false, enabled: false, levels: [] };
  }

  const measures = path.measures.length;
  const levels: DrillLevelView[] = path.levels.map((level, index) => {
    const options = chartOptionsFor(level, measures);
    const stored = args.charts?.[String(index + 1)];
    return {
      n: index + 1,
      dim: level.group_by,
      drills_on: level.drill_dim ?? null,
      /**
       * The dimensions bound on the way here — every level above this one that
       * pushes a value. docs/06 §4.1 prints these as `inherit` beside the
       * level, and the editor shows them so a reader can see that a click
       * narrows the same query rather than starting a different one.
       */
      inherit: path.levels
        .slice(0, index)
        .map((above) => above.drill_dim)
        .filter((dim): dim is string => dim !== undefined),
      /**
       * A stored choice this level cannot honour is DROPPED rather than shown.
       * The catalog can change under a saved report — a level that gains a
       * second measure stops being a legal donut — and echoing the stored value
       * back would put an option in the select that the server would refuse on
       * the next save.
       */
      chart: stored !== undefined && options.includes(stored) ? stored : DEFAULT_LEVEL_CHART,
      chart_options: options,
    };
  });

  return { widget_id: path.widget_id, available: true, enabled: args.enabled, levels };
}

/**
 * Draw a produced level as something other than the bar `buildDrill` emits.
 *
 * Applied to the level's finished widget rather than threaded into its
 * construction because the choice is presentation and nothing else: the same
 * rows, the same GROUP BY, the same statement in the logic panel (ADR-015).
 *
 * The drill fields travel across the swap, for the reason `applyChartOverride`
 * in services/custom-reports.ts carries them: `drillable` without `drill_dim`
 * is an invalid widget, so dropping half the pair would turn a chart-type
 * choice into an unrenderable report.
 *
 * An unhonourable request returns the widget UNCHANGED rather than throwing. A
 * reader who saved a donut leaf before the catalog grew a second measure should
 * get their level drawn as a bar, not an error where a chart was — and
 * `describeDrillPath` is already showing them a bar in the editor.
 */
export function applyLevelChart(args: {
  widget: Widget;
  chart: DrillChart | undefined;
  measures: number;
  correlationId: string;
}): Widget {
  const { widget, chart, measures } = args;
  if (chart === undefined || widget.type !== 'bar' || widget.type === chart) return widget;

  const swapped = swap(widget, chart, measures);
  if (swapped === widget) return widget;

  /**
   * [MANDATORY] CODING_GUIDELINES §10, for the same reason `buildDrill`
   * validates the widget it assembled: this one is assembled too, and
   * "assembled by our own code" is not a substitute for a check. Validating
   * here rather than at the call site means no caller can skip it.
   */
  const parsed = widgetSchema.safeParse(swapped);
  if (!parsed.success) {
    throw new PlatformError({
      code: ERROR_CODES.INVALID_CHART_SPEC,
      message: 'That level could not be drawn as the chart this report asks for.',
      diagnostics: { chart, issues: parsed.error.issues.map((i) => i.path.join('.')) },
      correlationId: args.correlationId,
    });
  }
  return parsed.data;
}

function swap(widget: Widget, chart: DrillChart, measures: number): Widget {
  if (widget.type !== 'bar') return widget;

  if (chart === 'donut') {
    /** Parts of a whole, or nothing: see `DrillChart`. */
    if (measures !== 1 || widget.drillable === true) return widget;
    return {
      id: widget.id,
      type: 'donut',
      ...(widget.title === undefined ? {} : { title: widget.title }),
      label_field: widget.x,
      value_field: widget.y,
      data: widget.data,
      ...(widget.drill_context === undefined ? {} : { drill_context: widget.drill_context }),
    };
  }

  return {
    id: widget.id,
    type: 'line',
    ...(widget.title === undefined ? {} : { title: widget.title }),
    x: widget.x,
    y: widget.y,
    data: widget.data,
    /**
     * `series` is deliberately not carried: `bar.series` is a list of measures
     * drawn side by side and `line.series` is a field name that splits one
     * measure into several lines — the same word for two different things
     * (services/custom-reports.ts says the same where it swaps a whole widget).
     * A multi-measure level drawn as a line therefore draws its FIRST measure,
     * which is `y`.
     */
    ...(widget.drillable === undefined ? {} : { drillable: widget.drillable }),
    ...(widget.drill_context === undefined ? {} : { drill_context: widget.drill_context }),
    ...(widget.drill_dim === undefined ? {} : { drill_dim: widget.drill_dim }),
    ...(widget.drill_value_field === undefined ? {} : { drill_value_field: widget.drill_value_field }),
  };
}

/** The measure count of a report's path — what `applyLevelChart` needs to judge a donut. */
export function drillMeasureCount(reportId: DashboardId): number {
  return drillPathFor(reportId)?.measures.length ?? 0;
}
