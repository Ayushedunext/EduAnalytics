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
 * A KPI tile. value is a pre-formatted display string because currency and
 * number formatting are locale decisions made once, server-side, so the screen
 * and the PDF cannot format the same number differently.
 */
export const kpiWidgetSchema = z
  .object({
    ...widgetBase,
    type: z.literal('kpi'),
    label: z.string().min(1),
    value: z.string(),
    delta: z.string().optional(),
    tone: z.enum(['neutral', 'positive', 'warning', 'negative']).optional(),
  })
  .strict();

/** Fields shared by the data-bound cartesian widgets. */
const cartesian = {
  ...widgetBase,
  /** Field name in data for the category axis. */
  x: z.string().min(1),
  /** Field name in data for the value axis. */
  y: z.string().min(1),
  data: z.array(dataRowSchema),
  /** ADR-020 and docs/06 §4.4: whether clicking a value drills. */
  drillable: z.boolean().optional(),
  drill_context: drillContextSchema.optional(),
};

export const barWidgetSchema = z.object({ ...cartesian, type: z.literal('bar') }).strict();

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
    type: z.literal('donut'),
    label_field: z.string().min(1),
    value_field: z.string().min(1),
    data: z.array(dataRowSchema),
    drillable: z.boolean().optional(),
    drill_context: drillContextSchema.optional(),
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

export const widgetSchema = z.discriminatedUnion('type', [
  kpiWidgetSchema,
  barWidgetSchema,
  lineWidgetSchema,
  donutWidgetSchema,
  tableWidgetSchema,
]);
export type Widget = z.infer<typeof widgetSchema>;
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
 */
const draftCartesian = {
  ...widgetBase,
  x: z.string().min(1),
  y: z.string().min(1),
  /** Names the query result the orchestrator will attach. Never data. */
  query_ref: z.string().min(1),
  drillable: z.boolean().optional(),
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
      drillable: z.boolean().optional(),
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
