/**
 * What the per-chart menu (components/ChartMenu.tsx) should offer for ONE panel
 * of a report — assembled once, here, because four screens draw report panels
 * and all four have to offer the same menu for the same chart.
 *
 * Those screens are the predefined dashboard (DashboardPage.tsx), a custom
 * report (ReportEditor.tsx), a module's preview card (PreviewCard.tsx) and My
 * View (overview/MyViewBoard.tsx). Before this, "which widgets can be cloned"
 * was answered in one of them and "which SQL is this panel's" in none, so the
 * same chart offered different actions depending on where a reader met it.
 *
 * Nothing here queries anything. Both helpers read a response the caller
 * already holds, plus the two mirror tables in `reportWidgetClone.ts` — the
 * server is still the authority on what a clone may take and validates every
 * request again (Invariant 2 double-enforcement is unaffected: these decide
 * which BUTTONS are live, never what a query may read).
 */

import type { ChartLogic, CloneTarget } from './components/ChartMenu';
import type { ReportLogic } from './api/client';
import { CLONEABLE_WIDGETS, WIDGET_BUCKET_OPTIONS, WIDGET_QUERY_KEYS } from './reportWidgetClone';

/** The part of a report response these helpers read — predefined or custom alike. */
export interface ReportLike {
  readonly logic: ReportLogic;
  readonly spec: { readonly meta: { readonly served_from: 'cache' | 'rollup' | 'replica'; readonly as_of?: string | undefined } };
}

/**
 * Invariant 6 for one panel: the report's own statements, with the one that
 * feeds THIS widget marked where the screen knows which it is
 * (`WIDGET_QUERY_KEYS`). Every statement is listed either way — the highlight
 * is emphasis, never a filter, so a panel missing from that table still shows
 * a reader everything behind it.
 */
export function reportChartLogic(report: ReportLike, reportId: string | null, widgetId: string): ChartLogic {
  const active = reportId === null ? undefined : WIDGET_QUERY_KEYS[reportId]?.[widgetId];
  return {
    source: report.logic.source,
    scope: report.logic.scope.map((s) => s.school_name),
    filters: report.logic.filters,
    groupBy: report.logic.group_by,
    charts: report.logic.charts,
    servedFrom: report.spec.meta.served_from,
    notes: report.logic.notes,
    queries: report.logic.queries,
    ...(active === undefined ? {} : { activeQueryKey: active }),
  };
}

/**
 * What "Clone and customise" would copy for this panel.
 *
 * A widget the server will build on its own (`CLONEABLE_WIDGETS`, mirroring
 * services/dashboards.ts) clones ALONE — that is docs/06 §3's per-widget
 * customization, and it is the one a reader means when they open the menu on a
 * chart. Any other panel clones the WHOLE report instead of offering nothing:
 * a panel that reads three result sets together cannot be cut out of its
 * report without silently losing two of them, but the reader can still have an
 * editable copy of the thing they were looking at. Where the widget IS
 * cloneable the dialog offers both, because since the page-level clone button
 * was removed (docs/10 §1.6) this is the only way left to copy a whole report
 * — and Fee Collection, whose every panel is individually cloneable, would
 * otherwise have had no way at all.
 *
 * `null` where there is no predefined report behind the screen at all — an
 * AI-saved report has no `base_report_id`, so there is nothing for the clone
 * endpoint to take.
 */
export function reportChartClone(
  reportId: string | null,
  widgetId: string,
  filters: {
    asOf?: string | undefined;
    compareYear?: string | undefined;
    /** The report's own name, for the dialog's "whole report" suggestion. */
    reportTitle?: string | undefined;
  } = {},
): CloneTarget | undefined {
  if (reportId === null) return undefined;
  const perWidget = CLONEABLE_WIDGETS[reportId]?.has(widgetId) === true;
  const buckets = WIDGET_BUCKET_OPTIONS[reportId]?.[widgetId];
  return {
    baseReportId: reportId,
    ...(perWidget ? { widgetId } : {}),
    ...(perWidget && buckets !== undefined ? { bucketOptions: buckets } : {}),
    ...(filters.reportTitle === undefined ? {} : { reportTitle: filters.reportTitle }),
    ...(filters.asOf === undefined ? {} : { asOf: filters.asOf }),
    ...(filters.compareYear === undefined ? {} : { compareYear: filters.compareYear }),
  };
}

/** Why Clone is unavailable, where it is — shown on the disabled menu item. */
export const NO_CLONE_REASON =
  'This report was saved from Ask AI rather than cloned from a predefined one, so there is no base report for the clone endpoint to copy.';
