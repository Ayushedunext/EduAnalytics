/**
 * Which SQL statement (or statements) feeds which panel of each predefined
 * report — the single source both `CLONEABLE_WIDGETS` (below) and the
 * per-chart "View logic" highlight (ChartMenu.tsx) read.
 *
 * Mirrors `WIDGET_QUERY_KEYS` in apps/orchestrator/src/services/dashboards.ts
 * — the server is the actual authority (it validates every clone request
 * against its own copy again), this is only which "⧉" buttons the SCREEN
 * offers and which statement View logic marks as "this chart". A widget
 * missing here simply gets no clone button and no highlight; it is never a
 * security boundary, so the two tables drifting apart fails safe (a button
 * that 404s, never a clone the server should have refused).
 *
 * A widget's entry is one query key, or (2026-09-16) an array where the panel
 * folds several result sets together — a per-widget clone then asks for all
 * of them, so it renders exactly as completely as it does on the base page.
 * Every report and widget id here was checked against services/dashboards.ts'
 * own BUILDERS functions: which `merged.sumBy`/`sumAll`/`sumPerSchool`/
 * `concatRows` calls a widget actually reads, not just which panel looks like
 * it should be single-query. A panel absent here reads more than that (e.g.
 * `table-late-payers`'s late_payers+pending_students fold is present WITH its
 * two keys; a genuinely inseparable multi-source panel like Trend Analysis'
 * `bar-school` for `collection_by_month` alone is present with just the one).
 */
export const WIDGET_QUERY_KEYS: Partial<Record<string, Readonly<Record<string, string | readonly string[]>>>> = {
  'enrollment-overview': {
    'bar-school-roll': 'by_class',
    'bar-class': 'by_class',
    'donut-gender': 'by_gender',
    'donut-category': 'by_category',
    'table-section': 'by_section',
  },
  'trend-analysis': {
    'line-collection': 'collection_by_month',
    'line-seasonality': 'collection_by_month',
    'bar-mode': 'collection_by_month',
    'bar-school': 'collection_by_month',
    'bar-enrollment': 'enrollment_by_year',
    'bar-exits': 'student_exits',
    'bar-staff': ['staff_joins', 'staff_exits'],
    'table-year': ['collection_by_month', 'enrollment_by_year'],
    'table-highlights': ['collection_by_month', 'enrollment_by_year', 'student_exits'],
    'line-years': ['collected_by_year', 'billed_by_year'],
    'bar-years': 'students_by_year',
  },
  'fee-comparative': {
    'bar-period': 'demand_by_period',
    'line-recovery': 'demand_by_period',
    'bar-outstanding': 'demand_by_period',
    'bar-school': 'demand_by_period',
    'table-schools': 'demand_by_period',
    'bar-timeline': ['demand_by_period', 'timing'],
    'table-school': ['demand_by_period', 'timing'],
    'table-highlights': ['demand_by_period', 'timing'],
  },
  'fee-collection': {
    'line-month': 'by_month',
    'bar-class': 'by_class',
    'donut-mode': 'by_mode',
    'table-component': 'by_component',
    'line-week-receipts': 'receipts_by_week',
    'bar-school': 'by_component',
    'donut-heads': ['by_component', 'heads'],
    'line-received': 'heads_by_month',
    'line-late': 'heads_by_month',
    'line-transport': 'heads_by_month',
    'line-pending': 'pending_by_month',
    'table-realisation': 'by_component',
  },
  'fee-defaulters': {
    'bar-school-defaulters': 'totals',
    'bar-aging': 'aging',
    'table-aging': 'aging',
    'bar-class': 'by_class',
    'table-component': 'by_component',
    'table-defaulters': 'top_defaulters',
    'table-pending': 'pending_students',
    'line-late-week': 'late_by_week',
    'table-late-payers': ['late_payers', 'pending_students'],
  },
  'fee-by-student': {
    'bar-school-fee-student': 'dues',
    'bar-class': 'by_class',
    'table-students': 'students',
  },
  'staff-overview': {
    'bar-school-staff': 'by_department',
    'bar-department': 'by_department',
    'bar-stafftype': 'by_stafftype',
    'donut-gender': 'by_gender',
    'table-designation': 'by_designation',
    'table-reasons': 'leavers_by_reason',
  },
  'student-staff-ratio': {
    'bar-school-ratio': 'ratio',
    'table-ratio': 'ratio',
  },
  'staff-attendance': {
    'bar-school-staff-attendance': 'summary',
    'line-month': 'by_month',
    'bar-department': 'by_department',
    'table-status': 'by_status',
    'table-attendance-rate': 'summary',
  },
  'admissions-funnel': {
    'bar-school-admissions': 'new_by_class',
    'bar-new-class': 'new_by_class',
    'bar-funnel': 'funnel',
    'bar-class': 'by_class',
    'table-class': 'by_class',
    'donut-gender': 'by_gender',
    'table-status': 'by_status',
  },
  'attendance-analytics': {
    'bar-school-attendance': 'summary',
    'line-month': 'by_month',
    'bar-class': 'by_class',
    'donut-status': 'by_status',
    'table-low-attendance': 'low_attendance',
    'line-week-attendance': 'att_by_week',
    'table-attendance-rate': 'summary',
  },
  'principal-snapshot': {
    'bar-class': 'by_class',
  },
  'transport-analytics': {
    'bar-school-transport': 'by_pickup_route',
    'bar-route': 'by_pickup_route',
    'bar-class': 'by_class',
    'donut-mode': 'by_mode',
  },
  'library-textbooks': {
    'line-month': 'issues_by_month',
    'table-category': 'by_category',
    'table-low-stock': 'low_stock',
    'donut-issue-type': 'by_issue_type',
  },
};

/**
 * Which predefined-dashboard widgets can be cloned on their own (docs/06 §3,
 * per-widget "⧉ Clone & customize") — every widget `WIDGET_QUERY_KEYS` names,
 * and nothing else. Kept as its own export (rather than inlining
 * `Object.keys` at each call site) because `reportChartClone()` asks "can
 * this widget clone alone" as a yes/no question, independent of which
 * statement answers it.
 */
export const CLONEABLE_WIDGETS: Partial<Record<string, ReadonlySet<string>>> = Object.fromEntries(
  Object.entries(WIDGET_QUERY_KEYS).map(([reportId, widgets]) => [reportId, new Set(Object.keys(widgets ?? {}))]),
);

export const WIDGET_BUCKET_OPTIONS: Partial<Record<string, Readonly<Record<string, readonly ('week' | 'month' | 'quarter' | 'year')[]>>>> = {
  'fee-collection': {
    'line-month': ['week', 'month', 'quarter', 'year'],
  },
};
