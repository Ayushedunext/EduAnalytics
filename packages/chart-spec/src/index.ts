/**
 * @sap/chart-spec -- the single rendering vocabulary (ADR-015).
 *
 * [MANDATORY] CODING_GUIDELINES §4: anything visual coming from the AI is a
 * chart-spec rendered by the shared renderer. Never dangerouslySetInnerHTML,
 * never eval, never render model-provided markup. §22 review checklist item 5:
 * AI output is treated as untrusted data, schema-validated, never markup.
 *
 * One chart layer for everything -- predefined, custom, AI, drill -- per
 * ADR-015/016. A second charting approach for a single feature is drift.
 */

export * from './spec.js';
export * from './validate.js';
