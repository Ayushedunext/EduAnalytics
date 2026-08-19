/**
 * Chart-spec validation: the enforcement point for Invariant 4.
 *
 * Contract source: CODING_GUIDELINES §10 -- "a chart-spec from the model is
 * parsed and schema-validated before it touches the renderer or storage;
 * invalid spec -> structured error, never partial render." Also §4: render
 * specs, not AI output.
 *
 * Design note: these functions RETURN a result and never throw. A half-rendered
 * dashboard is the worst outcome here, and an exception thrown mid-render
 * produces exactly that. The caller decides whether an invalid spec is a 500
 * (our vetted SQL produced nonsense) or a retry (the model did).
 */

import {
  chartSpecSchema,
  chartSpecDraftSchema,
  type ChartSpec,
  type ChartSpecDraft,
  type Widget,
} from './spec.js';

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

function issuesFrom(error: { issues: { path: (string | number)[]; message: string }[] }) {
  return error.issues.map((i) => ({
    path: i.path.length === 0 ? '<root>' : i.path.join('.'),
    message: i.message,
  }));
}

/**
 * Validate a renderable spec. Call this on every spec before it reaches the
 * renderer, the PDF route, or persistence -- including specs the platform built
 * itself from vetted SQL. The rails apply uniformly (CODING §7's principle
 * applied to rendering): a bug in our own dashboard builder should surface as a
 * structured error, not a broken screen.
 */
export function validateChartSpec(input: unknown): ValidationResult<ChartSpec> {
  const parsed = chartSpecSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, issues: issuesFrom(parsed.error) };
}

/**
 * Validate a model-emitted draft. This is the boundary where untrusted model
 * output becomes a typed object; nothing downstream should accept an unvalidated
 * draft. Rejects data-bearing keys outright -- see assertNoInlineData.
 */
export function validateChartSpecDraft(input: unknown): ValidationResult<ChartSpecDraft> {
  const parsed = chartSpecDraftSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, issues: issuesFrom(parsed.error) };
}

/**
 * Defence in depth for the C15 decision: a model must never supply data rows.
 *
 * The draft schema is .strict(), so an unknown `data` or `rows` key already
 * fails parsing. This function exists so the *reason* is explicit and testable
 * rather than an incidental consequence of strictness -- if someone later
 * relaxes the schema, the invariant test built on this function fails loudly
 * instead of the privacy property quietly disappearing.
 */
export function assertNoInlineData(input: unknown): ValidationResult<true> {
  const forbidden = ['data', 'rows'];
  const issues: ValidationIssue[] = [];

  if (typeof input === 'object' && input !== null && 'widgets' in input) {
    const widgets = (input as { widgets: unknown }).widgets;
    if (Array.isArray(widgets)) {
      widgets.forEach((w, idx) => {
        if (typeof w !== 'object' || w === null) return;
        for (const key of forbidden) {
          if (key in w) {
            issues.push({
              path: `widgets.${idx}.${key}`,
              message: `model-emitted specs must not carry inline data; use query_ref (AUDIT_REPORT C15)`,
            });
          }
        }
      });
    }
  }

  return issues.length === 0 ? { ok: true, value: true } : { ok: false, issues };
}

/** Widget ids must be unique within a spec -- the renderer keys on them. */
export function findDuplicateWidgetIds(widgets: readonly Widget[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const w of widgets) {
    if (seen.has(w.id)) dupes.add(w.id);
    seen.add(w.id);
  }
  return [...dupes];
}

/** Render a result's issues as one log-safe line. Carries no data values. */
export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues.map((i) => `${i.path}: ${i.message}`).join('; ');
}
