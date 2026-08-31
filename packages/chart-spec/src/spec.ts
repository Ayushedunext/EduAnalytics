/**
 * The chart-spec contract.
 *
 * Contract source: ADR-015 · docs/05 §1 · docs/06 §4.4 (drill fields) ·
 * Invariant 4 ("spec-driven rendering").
 *
 * -- Why this file is a security boundary, not just a type ------------------
 * Invariant 4: the AI emits structured chart-spec JSON, NEVER renderable code.
 * That is only enforceable if there is a schema to validate against; otherwise
 * "the AI only emits specs" is a hope. CODING_GUIDELINES §4 forbids
 * dangerouslySetInnerHTML, eval, or rendering model-provided markup anywhere;
 * §10 requires model output to be schema-validated before it reaches the
 * renderer or storage. This module is that schema.
 *
 * -- Widget vocabulary is closed and ADR-gated -----------------------------
 * kpi, bar, line, donut, table (+ a top-level narrative), exactly as
 * enumerated in ADR-015. Additions are additive and require an ADR. Notably
 * heatmap is NOT here: whether Attendance Analytics needs one is still an open
 * product question (AUDIT_REPORT A2), and adding it speculatively would put a
 * widget in the contract that no renderer supports.
 *
 * Grouped bars (`bar.series`, added 2026-08-27 for the Fee Collection drill)
 * are NOT an addition to that vocabulary and needed no new ADR: a grouped bar
 * is still a `bar`, so the union, the PDF route and every `switch` over
 * `WidgetType` are untouched. What WOULD need one is a sixth widget type.
 * Stacked bars (`bar.stacked`, added 2026-08-31 for Comparative Analysis'
 * recovery timeline) are the same kind of change for the same reason.
 *
 * -- Two-stage spec: draft (model) then hydrated (renderer) ----------------
 * Decided 2026-08-18 (AUDIT_REPORT C15). A widget's DATA is attached
 * server-side; the model never emits data rows. It emits a ChartSpecDraft
 * whose widgets carry a query_ref naming which query result fills them, and
 * the orchestrator hydrates that into a ChartSpec.
 *
 * Two problems this solves at once:
 *   1. Privacy. Row-level student data never passes through the model, and
 *      under BYOK that traffic would go to the customer's own Anthropic
 *      account. docs/08 governs PII movement everywhere else and was silent
 *      on this path.
 *   2. Feasibility. ADR-008 caps results at 5,000 rows, which cannot
 *      round-trip through model output within any practical limit.
 *
 * Phase 1 uses only ChartSpec: predefined dashboards run vetted SQL and build
 * the hydrated spec directly, with no model involved (ADR-016 keeps the two
 * serving paths separate). ChartSpecDraft is defined now because it is where
 * the decision lives, and the schema is the artifact that enforces it.
 */

import { z } from 'zod';

/** A single cell. Scalars only: a spec carries data, never behaviour. */
export const cellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type Cell = z.infer<typeof cellSchema>;

/**
 * Keys that must never appear in externally-shaped records. Assigning to
 * `__proto__` while building row objects pollutes Object.prototype for the
 * whole process; in a shared orchestrator serving many tenants that is a
 * cross-tenant problem, not a local one.
 *
 * Field names originate in SQL result-set column names, so this is defence in
 * depth rather than a live hole -- but a hand-edited custom report (ADR-019
 * allows `SELECT x AS __proto__`) is a plausible route, which is exactly the
 * kind of thing the read-only plane is not designed to catch.
 */
const DANGEROUS_ROW_KEYS = ['__proto__', 'constructor', 'prototype'];

const safeFieldName = z
  .string()
  .min(1)
  .refine((k) => !DANGEROUS_ROW_KEYS.includes(k), {
    message: 'field name would pollute the prototype chain',
  });

/** One row of a widget's dataset, keyed by field name. */
export const dataRowSchema = z.record(safeFieldName, cellSchema);
export type DataRow = z.infer<typeof dataRowSchema>;

/** Which serving tier answered. The strict three-tier order of ADR-028. */
export const SERVED_FROM = ['cache', 'rollup', 'replica'] as const;
export type ServedFrom = (typeof SERVED_FROM)[number];

/**
 * Provenance carried on every spec.
 *
 * scope exists because docs/10 §3 makes "scope is always on screen" binding.
 * The picker chip, the line under the report title, and the scope printed on
 * the PDF all read from here, so screen and PDF cannot disagree.
 *
 * as_of exists because docs/03 assumption 2 accepts seconds-level replica lag
 * on the condition that dashboards are labelled "as of". The label is part of
 * the contract, not a UI nicety.
 *
 * served_from drives the "Answered from rollup store" status step that
 * docs/05 §2 calls a deliberate trust device, and the logic panel's data-path
 * line (docs/06 §3).
 */
export const specMetaSchema = z
  .object({
    scope: z
      .array(z.object({ school_id: z.string().min(1), school_name: z.string().min(1) }).strict())
      .min(1),
    generated_at: z.string().datetime(),
    as_of: z.string().datetime().optional(),
    served_from: z.enum(SERVED_FROM),
    /** Report definition this spec was produced from (ADR-018). */
    report_id: z.string().min(1).optional(),
  })
  .strict();
export type SpecMeta = z.infer<typeof specMetaSchema>;

/** Drill context: the stack of clicked dim/value pairs (docs/00 glossary). */
export const drillContextSchema = z
  .array(z.object({ dim: z.string().min(1), value: z.string() }).strict())
  .max(3);
export type DrillContext = z.infer<typeof drillContextSchema>;

// -- Widgets (hydrated) -----------------------------------------------------

const widgetBase = {
  /** Stable within a spec; the renderer keys on it. */
  id: z.string().min(1),
  title: z.string().optional(),
};

/**
 * What a measure is ABOUT, when that is a fact about the report rather than a
 * taste. Shared with `kpi`, which has carried it since the first dashboard.
 */
export const toneSchema = z.enum(['neutral', 'positive', 'warning', 'negative']);
export type Tone = z.infer<typeof toneSchema>;

/**
 * A KPI tile. value is a pre-formatted display string because currency and
 * number formatting are locale decisions made once, server-side, so the screen
 * and the PDF cannot format the same number differently.
 */
/**
 * One named part of the figure a KPI leads with.
 *
 * `value` is a pre-formatted display string for exactly the reason the KPI's
 * own `value` is: currency and number formatting is a locale decision made
 * once, server-side, so a tile and its PDF cannot format the same number two
 * ways. A part carries no `field` and no raw number — it is not a mini chart
 * and nothing downstream recomputes it.
 *
 * The parts are DESCRIPTIVE, not arithmetic: nothing here requires them to sum
 * to `value`, and the renderer never checks that they do. Two of the first four
 * uses do not sum — a school's staff splits into permanent, not-permanent and a
 * remainder whose employment type the ERP records as an opaque code, and an
 * attendance rate is a quotient whose parts are counts. A schema that insisted
 * on a sum would have forced those to lie.
 */
export const kpiPartSchema = z
  .object({
    label: z.string().min(1),
    value: z.string(),
    tone: toneSchema.optional(),
  })
  .strict();
export type KpiPart = z.infer<typeof kpiPartSchema>;

export const kpiWidgetSchema = z
  .object({
    ...widgetBase,
    type: z.literal('kpi'),
    label: z.string().min(1),
    value: z.string(),
    delta: z.string().optional(),
    tone: toneSchema.optional(),
    /**
     * At least two parts, because one part is not a breakdown — it is a second
     * label for the same number, and a tile that draws one is telling a reader
     * there is a split where none exists. At most three, because the tile is a
     * card in a four-across strip (tokens.css `.kpis`) and a fourth part turns
     * the split into a table nobody can read at that width; a metric needing
     * more parts than that wants a chart, which the spec already has.
     */
    breakdown: z.array(kpiPartSchema).min(2).max(3).optional(),
  })
  .strict();

/**
 * One measure drawn as its own set of bars, beside the others.
 *
 * `field` names a numeric field present on every row of `data`; `label` is what
 * the legend calls it. The label travels in the SPEC rather than being derived
 * from the field name, for the same reason KPI values arrive pre-formatted:
 * `total_payable_amount` is a column, "Fee payable" is a sentence, and the
 * screen and the PDF must not each invent their own translation.
 *
 * Deliberately NOT a colour. Which teal step a series is drawn in is a
 * presentation decision the renderer makes from the docs/10 §1 palette in fixed
 * order (`SERIES` in react/widgets.tsx); a spec that carried hex would let a
 * saved report pin a colour that a later palette audit has to honour.
 */
export const barSeriesSchema = z
  .object({ field: safeFieldName, label: z.string().min(1) })
  .strict();
export type BarSeries = z.infer<typeof barSeriesSchema>;

/**
 * What a chart carries so that clicking it can narrow the report (ADR-020,
 * docs/06 §4.4). Shared by every widget a reader can click, so a drill path
 * means the same thing on a bar as on a donut.
 */
const drillFields = {
  /** Whether clicking a value drills. */
  drillable: z.boolean().optional(),
  /** The stack of clicked pairs that produced THIS view. Empty at level 1. */
  drill_context: drillContextSchema.optional(),
  /**
   * The dimension a click on this chart pushes onto that stack — 'school',
   * 'quarter', 'class'. Required whenever `drillable` is true, because a
   * clicked value is meaningless without the dimension it narrows;
   * `checkWidgetInvariants` below enforces the pair rather than leaving it to
   * each renderer to notice.
   */
  drill_dim: z.string().min(1).optional(),
  /**
   * Which field carries the value to PUSH, when it differs from the field the
   * axis displays. Drilling into a school narrows by `school_id` while the axis
   * reads `school_name`, and binding the display label would make the drill
   * depend on a school's name being unique and unedited. Absent means the
   * category label is also the value.
   */
  drill_value_field: safeFieldName.optional(),
};

/** Fields shared by the data-bound cartesian widgets. */
const cartesian = {
  ...widgetBase,
  ...drillFields,
  /** Field name in data for the category axis. */
  x: z.string().min(1),
  /** Field name in data for the value axis. */
  y: z.string().min(1),
  data: z.array(dataRowSchema),
  /**
   * What this chart's measure is about — added 2026-08-29.
   *
   * The same field `kpi` has always had, and set by the same authority for the
   * same reason: the server knows that "Overdue by age of the debt" is money
   * that is late, and docs/10 §1's token table assigns amber to exactly that
   * ("warnings, fees outstanding"). A KPI tile beside the chart already says so
   * (`kpi-balance` is `tone: 'warning'`); the chart drawing the same fact had
   * no way to.
   *
   * -- Why this is in the CONTRACT and `ChartAccent` is not -------------------
   * They answer different questions and the distinction is load-bearing.
   * `ChartAccent` (react/widgets.tsx) is variety — which teal step a caller
   * paints one of several single-series previews, a property of the page doing
   * the showing. `tone` is meaning: overdue money is amber wherever it is
   * drawn, including on paper. Keeping it out of the spec would mean the SPA
   * and the PDF each look up the colour separately, and the first time one of
   * them forgot, an export would disagree with the screen it was approved
   * from — which is the one thing ADR-021 exists to prevent.
   *
   * Absent means neutral, which is the platform teal every chart has always
   * been, so no existing widget changes.
   */
  tone: toneSchema.optional(),
};

export const barWidgetSchema = z
  .object({
    ...cartesian,
    type: z.literal('bar'),
    /**
     * Several measures side by side — demand, collection and pending for the
     * same school — rather than one bar per category.
     *
     * Grouped bars are NOT a new widget type: ADR-015 closes the vocabulary at
     * kpi/bar/line/donut/table and this stays a `bar`, so nothing that reads the
     * union (the PDF route, the clone form, the AI spec validator) grows a
     * branch. Omitted, a bar is exactly the single-`y` bar it has always been.
     *
     * `series[0].field` must be `y`. One field is the widget's primary measure
     * whether or not there are others — it is what `maxValueIndex`, the Home
     * preview card and any future sort read — and letting `y` name a measure
     * absent from the group would produce a chart whose "main" value is not
     * drawn. Requiring at least two entries keeps `series` meaning "grouped":
     * a one-entry group is a single-series bar with extra ceremony.
     */
    series: z.array(barSeriesSchema).min(2).optional(),
    /**
     * The same measures drawn ON TOP of each other in one bar per category,
     * rather than side by side.
     *
     * Within ADR-015's clarification of 2026-08-27 for exactly the reason
     * grouped bars were: a stacked bar is still a `bar`. The union, the
     * `WidgetType` switch, the PDF route and the AI spec validator are
     * untouched, and a bar without this flag is byte-identically the chart it
     * was before. A sixth widget TYPE would still need a new ADR.
     *
     * It exists because a PARTITION is a different fact from a comparison, and
     * drawing one as the other misreads it. Comparative Analysis' recovery
     * timeline splits a school's payable into advance / same month / next month
     * / later / still pending — five mutually exclusive states that together
     * are the whole of the money. Side by side they read as five independent
     * measures a reader must add up mentally; stacked, the bar IS the payable
     * and each segment is its share.
     *
     * Requires `series`: stacking is a statement about several measures, and a
     * single-measure "stack" is a bar. `checkWidgetInvariants` enforces the
     * pair rather than leaving each renderer to notice.
     *
     * Note what this does NOT claim. The schema cannot know that the segments
     * partition anything — that is the emitter's responsibility, stated on
     * screen in the report's notes, exactly as `kpi.breakdown` refuses to
     * require its parts to sum.
     */
    stacked: z.boolean().optional(),
  })
  .strict();

export const lineWidgetSchema = z
  .object({
    ...cartesian,
    type: z.literal('line'),
    /** Optional field name to split into multiple series. */
    series: z.string().min(1).optional(),
  })
  .strict();

export const donutWidgetSchema = z
  .object({
    ...widgetBase,
    ...drillFields,
    type: z.literal('donut'),
    label_field: z.string().min(1),
    value_field: z.string().min(1),
    data: z.array(dataRowSchema),
  })
  .strict();

export const tableColumnSchema = z
  .object({
    field: safeFieldName,
    label: z.string().min(1),
    align: z.enum(['left', 'right', 'center']).optional(),
    /**
     * Marks a column as masked so the renderer shows it as masked rather than
     * hiding it silently. Masking is role-dependent (docs/04 §3 rail 6), and a
     * silently absent column is a success-shaped failure (CODING §10).
     */
    masked: z.boolean().optional(),
    /**
     * A sibling field on each row carrying this column's RAW value, for sorting.
     *
     * Amounts and rates reach a table pre-formatted — "₹2.4 Cr", "93.4%" —
     * because currency and locale are decided once, server-side, so a screen and
     * its PDF cannot format the same number two ways (see `kpi.value`). The cost
     * is that the displayed cell is a string, and sorting strings puts "₹9.8 L"
     * above "₹2.4 Cr". This names where the comparable number lives instead.
     *
     * Not a widget type and not a new widget: an optional attribute on a column,
     * exactly like `align` and `masked` beside it. Absent means the column sorts
     * on what it displays, which is right for text.
     *
     * Sorting itself is INTERACTIVE and therefore presentation: the emitted row
     * order is the report's own answer (the emitter ranks rows for a reason), a
     * reader may re-sort on screen, and the PDF prints the emitted order.
     */
    sort_field: safeFieldName.optional(),
  })
  .strict();

export const tableWidgetSchema = z
  .object({
    ...widgetBase,
    type: z.literal('table'),
    columns: z.array(tableColumnSchema).min(1),
    rows: z.array(dataRowSchema),
    /** True when the ADR-008 row cap truncated the result. Never silent. */
    truncated: z.boolean().optional(),
  })
  .strict();

/**
 * The individual widget types, exported so a renderer can take exactly the
 * widget it draws rather than the whole union plus a cast.
 */
export type KpiWidget = z.infer<typeof kpiWidgetSchema>;
export type BarWidget = z.infer<typeof barWidgetSchema>;
export type LineWidget = z.infer<typeof lineWidgetSchema>;
export type DonutWidget = z.infer<typeof donutWidgetSchema>;
export type TableWidget = z.infer<typeof tableWidgetSchema>;

/**
 * Cross-field rules that a `.strict()` object cannot state on its own.
 *
 * They live on the UNION rather than on each member because
 * `z.discriminatedUnion` requires plain objects: a member wrapped in `.refine`
 * is a ZodEffects and the union stops narrowing by `type`, which would cost
 * every consumer of `Widget` its discriminated narrowing to buy two checks.
 * Applied here, the checks are identical and the union is unchanged.
 */
function checkWidgetInvariants(widget: Widget, ctx: z.RefinementCtx): void {
  /**
   * ADR-020 makes a clicked value a `{dim, value}` pair bound as a parameter. A
   * widget that says "clicking me drills" without saying INTO WHAT leaves the
   * renderer to guess the dim from the title, or the caller to hardcode it per
   * report -- either of which is a drill path living somewhere other than the
   * curated catalog the ADR requires.
   */
  if ('drillable' in widget && widget.drillable === true && widget.drill_dim === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'a drillable widget must name the dimension a click drills on (drill_dim)',
      path: ['drill_dim'],
    });
  }

  /**
   * One field is a bar's primary measure whether or not there are others -- it
   * is what `maxValueIndex`, the Home preview card and any future sort read --
   * so letting `y` name a measure absent from the group would produce a chart
   * whose "main" value is not among the bars drawn.
   */
  if (widget.type === 'bar' && widget.series !== undefined && widget.series[0]?.field !== widget.y) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "the first series must be the widget's y field",
      path: ['series', 0, 'field'],
    });
  }

  /**
   * Stacking says "these measures are parts of one whole". One measure has no
   * other part to sit on, so a stacked single-series bar is a bar drawn with a
   * claim it cannot support -- and the renderer would silently draw it as an
   * ordinary one, which is the success-shaped failure §10 names.
   */
  if (widget.type === 'bar' && widget.stacked === true && widget.series === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'a stacked bar must name the measures it stacks (series)',
      path: ['series'],
    });
  }
}

const widgetUnion = z.discriminatedUnion('type', [
  kpiWidgetSchema,
  barWidgetSchema,
  lineWidgetSchema,
  donutWidgetSchema,
  tableWidgetSchema,
]);
export type Widget = z.infer<typeof widgetUnion>;

export const widgetSchema = widgetUnion.superRefine(checkWidgetInvariants);
export type WidgetType = Widget['type'];

/** The renderable contract. Read identically by the SPA and the PDF (ADR-021). */
export const chartSpecSchema = z
  .object({
    /** Contract version, so a persisted spec stays readable (ADR-018). */
    spec_version: z.literal(1),
    title: z.string().min(1),
    narrative: z.string().optional(),
    widgets: z.array(widgetSchema).min(1),
    meta: specMetaSchema,
  })
  .strict();
export type ChartSpec = z.infer<typeof chartSpecSchema>;

// -- Draft (model-facing) ---------------------------------------------------

/**
 * The model-facing spec. Identical in structure except that data-bound widgets
 * name a query_ref instead of carrying rows. See the two-stage note at the top
 * of this file. Phase 3 surface; no Phase 1 code path produces one.
 *
 * -- No drill fields, on purpose (2026-08-27) ---------------------------------
 * A draft cannot declare `drillable`. docs/06 §4.4 closes with AI artifacts
 * adopting drill-down being "explicitly designed as a later config-level step"
 * against the Dimension Hierarchy Catalog — so today a model asking for a
 * drillable chart is asking for something no path can serve. It used to be
 * offered here and copied through hydration (services/ai-chat.ts), which since
 * `drillable` began requiring a `drill_dim` would have produced a hydrated spec
 * the renderer rejects: the model would have been able to make its own answer
 * un-renderable. A field the contract cannot honour is worse than no field.
 */
const draftCartesian = {
  ...widgetBase,
  x: z.string().min(1),
  y: z.string().min(1),
  /** Names the query result the orchestrator will attach. Never data. */
  query_ref: z.string().min(1),
};

export const widgetDraftSchema = z.discriminatedUnion('type', [
  kpiWidgetSchema,
  z.object({ ...draftCartesian, type: z.literal('bar') }).strict(),
  z
    .object({
      ...draftCartesian,
      type: z.literal('line'),
      series: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      ...widgetBase,
      type: z.literal('donut'),
      label_field: z.string().min(1),
      value_field: z.string().min(1),
      query_ref: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...widgetBase,
      type: z.literal('table'),
      columns: z.array(tableColumnSchema).min(1),
      query_ref: z.string().min(1),
    })
    .strict(),
]);
export type WidgetDraft = z.infer<typeof widgetDraftSchema>;

export const chartSpecDraftSchema = z
  .object({
    spec_version: z.literal(1),
    title: z.string().min(1),
    narrative: z.string().optional(),
    widgets: z.array(widgetDraftSchema).min(1),
  })
  .strict();
export type ChartSpecDraft = z.infer<typeof chartSpecDraftSchema>;
