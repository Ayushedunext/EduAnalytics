/**
 * `WIDGET_QUERY_KEYS` (services/dashboards.ts) names, per predefined report,
 * which catalog query key(s) a per-widget clone should re-run. It is hand
 * maintained and never checked against the catalog itself — a misspelled or
 * renamed query key would not fail to typecheck (both sides are plain
 * strings), it would just make that widget's clone come back empty the day
 * someone tries it. This guards against exactly that, the same way
 * reportWidgetClone.ts's own comment says the FRONTEND mirror is allowed to
 * drift from the server (fails safe, no button) — the server's own table has
 * no such safety net, so it gets a test instead.
 */
import './env-defaults.js';
import { describe, expect, it } from 'vitest';
import { predefinedReports } from '@sap/mcp-server/src/reports/catalog.js';
import { WIDGET_QUERY_KEYS } from '../src/services/dashboards.js';

describe('WIDGET_QUERY_KEYS names only real query keys', () => {
  const queryKeysByReport = new Map(predefinedReports().map((report) => [report.id, new Set(report.queries.map((q) => q.key))]));

  for (const [reportId, widgets] of Object.entries(WIDGET_QUERY_KEYS)) {
    it(`${reportId} is a real predefined report`, () => {
      expect(queryKeysByReport.has(reportId)).toBe(true);
    });

    const validKeys = queryKeysByReport.get(reportId) ?? new Set<string>();
    for (const [widgetId, entry] of Object.entries(widgets ?? {})) {
      const keys = typeof entry === 'string' ? [entry] : entry;
      it(`${reportId}'s "${widgetId}" names query key(s) that exist on the report`, () => {
        for (const key of keys) expect(validKeys.has(key)).toBe(true);
      });
    }
  }
});
