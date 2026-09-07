/**
 * The Dashboard's cards (docs/10 §1.5, adopted 2026-09-04).
 *
 * Contract source: ADR-015 (every card is chart-spec widgets, built here and
 * validated before they leave) · ADR-016 (predefined path, no AI) · ADR-011
 * (a card that cannot be built is reported as blocked with its reason) ·
 * Invariant 6 (every card carries the statements behind it).
 *
 * -- One slot, one request ------------------------------------------------------
 * The design lays out three layouts of cards; each card is a SLOT here, named
 * by the queries it needs from the `dashboard-overview` report (mcp-server
 * reports/catalog.ts). The SPA asks for slots one at a time, so the fastest
 * card is on screen while the fee ledger is still being scanned — the same
 * reasoning that split the old preview grid into per-card requests.
 *
 * -- What a slot is allowed to say -----------------------------------------------
 * Widgets only: KPI tiles, bars, lines, donuts and tables from the closed
 * vocabulary. The card chrome the design draws around them — rings, gauges,
 * avatars, an Action button — is the SPA's presentation of these widgets, never
 * something this service invents. Values arrive pre-formatted (rupees, counts,
 * percentages) so the screen and any export cannot format one number two ways.
 */

import {
  widgetSchema,
  type KpiPart,
  type KpiWidget,
  type Widget,
} from '@sap/chart-spec';
import { ERROR_CODES, PlatformError } from '@sap/shared';
import type { SessionClaims } from '../auth/session.js';
import { schoolNames } from '../db/registry.js';
import { cacheGet, cacheKey, cacheSet, refreshInBackground } from '../cache/result-cache.js';
import { coalesce } from '../cache/single-flight.js';
import { config } from '../config.js';
import { Merged } from './dashboards.js';
import { OVERVIEW_REPORT_ID, runOverviewQueries } from './overview-queries.js';

export { OVERVIEW_REPORT_ID };

/**
 * Each slot and the query keys it runs. A slot lists exactly what it draws, so
 * a card costs the scans it needs and no others — the tiles card never scans
 * the collection ledger, the fee-heads card never touches a register.
 */
export const OVERVIEW_SLOTS = {
  tiles: ['roll', 'staff', 'att_today', 'staff_today', 'admissions', 'overdue'],
  rings: ['att_by_month', 'fees', 'staff_by_month'],
  monthly: ['heads_by_month'],
  /**
   * The same `admissions` statement the tiles card already runs, kept per
   * school instead of summed across them -- so this card costs no scan of its
   * own beyond what the Dashboard was already paying (the result cache keys per
   * statement, services/overview-queries.ts). The by-school reading is level 1
   * of the Admissions drill path, which is what the card opens into.
   */
  admissions_by_school: ['admissions'],
  weekly_receipts: ['receipts_by_week'],
  weekly_attendance: ['att_by_week'],
  top_schools: ['fees'],
  fee_heads: ['fees', 'heads', 'heads_by_month', 'pending_by_month'],
  years: ['collected_by_year', 'billed_by_year'],
  students_by_year: ['students_by_year'],
  att_status: ['att_status'],
  top_students: ['top_attendance'],
  gauges: ['roll', 'att_today', 'admissions', 'staff_today'],
  late_payers: ['late_payers', 'pending_students'],
  pending_top: ['pending_students'],
  area: ['heads_by_month', 'staff_by_month', 'att_by_month'],
  modes: ['by_mode'],
  late_weekly: ['late_by_week'],
} as const;

export type OverviewSlotKey = keyof typeof OVERVIEW_SLOTS;

/**
 * The cards a launch warms (services/warm.ts).
 *
 * This is the DEFAULT layout the SPA opens on — Format A in
 * `apps/web/src/components/overview/formats.tsx`, which is what
 * `theme/dashboardTheme.ts` falls back to when the reader has chosen no other.
 * It is duplicated here rather than imported because the browser bundle and this
 * service share no module, and the cost of the two drifting is bounded: a warm
 * for a card nobody opens, or a card that opens cold. Neither is a wrong screen.
 *
 * Deliberately NOT every slot in `OVERVIEW_SLOTS`. Warming all seventeen would
 * scan the fee ledger for two layouts nobody has asked for; the statements the
 * other layouts share with this one are cached per statement
 * (services/overview-queries.ts) and come warm anyway.
 */
export const WARM_SLOTS: readonly OverviewSlotKey[] = [
  'tiles',
  'rings',
  'monthly',
  'admissions_by_school',
  'weekly_receipts',
  'weekly_attendance',
  'top_schools',
  'fee_heads',
];


export function isOverviewSlot(value: string): value is OverviewSlotKey {
  return Object.hasOwn(OVERVIEW_SLOTS, value);
}

export interface OverviewSlot {
  readonly key: OverviewSlotKey;
  /** Validated chart-spec widgets; the SPA validates again before drawing. */
  readonly widgets: Widget[];
  readonly status: 'ok' | 'blocked';
  readonly reason?: string;
  /** Caveats the reader should see beside the card, never composed client-side. */
  readonly notes: string[];
  /** Invariant 6: the statements behind this card. */
  readonly queries: { key: string; description: string; sql: string }[];
  readonly degraded_schools: { school_id: string; message: string }[];
  readonly as_of: string;
}

interface Ctx {
  readonly year: string;
  readonly asOf: string;
  readonly scope: readonly { school_id: string; school_name: string }[];
}

interface Built {
  readonly widgets: Widget[];
  readonly notes?: string[];
}

export interface OverviewSlotArgs {
  readonly session: SessionClaims;
  readonly schoolIds: readonly string[];
  readonly slot: OverviewSlotKey;
  readonly academicYear: string;
  readonly asOfDate: string;
  readonly correlationId: string;
}

/** The four filters the overview report declares, for a year and an as-of day. */
export function overviewParams(academicYear: string, asOfDate: string): Record<string, string> {
  const window = academicYearWindow(academicYear);
  return {
    academic_year: academicYear,
    as_of_date: asOfDate,
    from_date: window.from,
    to_date: window.to,
  };
}

function slotCacheKey(args: OverviewSlotArgs, params: Record<string, string>): string {
  return cacheKey({
    kind: `overview:${args.slot}`,
    schoolIds: args.schoolIds,
    permissionClass: args.session.permission_class,
    filters: params,
  });
}

export async function buildOverviewSlot(args: OverviewSlotArgs): Promise<OverviewSlot> {
  const params = overviewParams(args.academicYear, args.asOfDate);
  const key = slotCacheKey(args, params);

  const hit = await cacheGet<OverviewSlot>(key);
  if (hit !== null) {
    /**
     * Served now, rebuilt behind the response — and the rebuild goes to
     * `buildFresh`, NOT back through this function.
     *
     * It used to re-enter here, which meant the rebuild read the same stale
     * entry it was supposed to replace, found a refresh already registered for
     * the key, and returned the stale value as its own result. Nothing failed
     * and nothing was ever refreshed: the entry simply aged out at the end of
     * the stale window, and the reader who arrived after that paid the full cold
     * cost of a card the cache had been holding all along. Serve-stale only
     * works if the rebuild path cannot see the cache.
     */
    if (hit.stale) {
      refreshInBackground(key, async () =>
        buildFresh({ ...args, correlationId: `${args.correlationId}:refresh` }, params, key, {
          requireFresh: true,
        }),
      );
    }
    return hit.value;
  }

  /**
   * A cold key is built ONCE however many readers are waiting on it — the
   * layout's seven simultaneous cards, two browsers opening together, or the
   * reader arriving on top of the launch warm (cache/single-flight.ts).
   */
  return coalesce(key, async () => buildFresh(args, params, key));
}

/**
 * Build the card from its statements and write it to the cache.
 *
 * Never throws: ADR-011, one card at a time — a dead card says why and its
 * neighbours still draw.
 */
async function buildFresh(
  args: OverviewSlotArgs,
  params: Record<string, string>,
  key: string,
  options: { requireFresh?: boolean } = {},
): Promise<OverviewSlot> {
  try {
    const scope = await schoolNames(args.schoolIds);
    if (scope.length === 0) {
      throw new PlatformError({
        code: ERROR_CODES.TENANT_UNAVAILABLE,
        message: 'None of the selected schools are available for analytics right now.',
        correlationId: args.correlationId,
      });
    }
    const queryKeys = [...OVERVIEW_SLOTS[args.slot]];

    const result = await runOverviewQueries(
      {
        session: args.session,
        schoolIds: args.schoolIds,
        params,
        correlationId: args.correlationId,
      },
      queryKeys,
      options,
    );
    const merged = new Merged(result);
    const built = BUILDERS[args.slot](merged, { year: args.academicYear, asOf: args.asOfDate, scope });

    if (built.widgets.length === 0) {
      throw new PlatformError({
        code: merged.allDenied() ? ERROR_CODES.PERMISSION_DENIED : ERROR_CODES.TENANT_UNAVAILABLE,
        message: merged.allDenied()
          ? 'This session does not have permission to view this card.'
          : 'This card could not be produced for the selected schools right now.',
        diagnostics: { slot: args.slot, failures: merged.failures() },
        correlationId: args.correlationId,
      });
    }

    const widgets: Widget[] = [];
    for (const widget of built.widgets) {
      const parsed = widgetSchema.safeParse(widget);
      if (!parsed.success) {
        throw new PlatformError({
          code: ERROR_CODES.INVALID_CHART_SPEC,
          message: 'The card could not be rendered.',
          diagnostics: { slot: args.slot, issues: parsed.error.issues.map((i) => i.path.join('.')) },
          correlationId: args.correlationId,
        });
      }
      widgets.push(parsed.data);
    }

    const outcome: OverviewSlot = {
      key: args.slot,
      widgets,
      status: 'ok',
      notes: [...(built.notes ?? []), ...merged.failures().map((f) => `${f.key} could not be produced: ${f.message}`)],
      queries: merged.definitions(),
      degraded_schools: merged.schoolFailures(),
      as_of: result.as_of,
    };
    if (merged.failures().length === 0 && outcome.degraded_schools.length === 0) {
      await cacheSet(key, outcome, config.CACHE_TTL_SECONDS);
    }
    return outcome;
  } catch (err) {
    /** ADR-011, one card at a time: a dead slot says why; the others still draw. */
    return {
      key: args.slot,
      widgets: [],
      status: 'blocked',
      reason: err instanceof PlatformError ? err.message : 'This card could not be loaded.',
      notes: [],
      queries: [],
      degraded_schools: [],
      as_of: new Date().toISOString(),
    };
  }
}

// -- Builders ---------------------------------------------------------------------

const BUILDERS: Record<OverviewSlotKey, (merged: Merged, ctx: Ctx) => Built> = {
  tiles: buildTiles,
  rings: buildRings,
  monthly: buildMonthly,
  admissions_by_school: buildAdmissionsBySchool,
  weekly_receipts: buildWeeklyReceipts,
  weekly_attendance: buildWeeklyAttendance,
  top_schools: buildTopSchools,
  fee_heads: buildFeeHeads,
  years: buildYears,
  students_by_year: buildStudentsByYear,
  att_status: buildAttStatus,
  top_students: buildTopStudents,
  gauges: buildGauges,
  late_payers: buildLatePayers,
  pending_top: buildPendingTop,
  area: buildArea,
  modes: buildModes,
  late_weekly: buildLateWeekly,
};

/** Boys and girls, however the school spells them; anything else is named. */
function genderSplit(rows: readonly Record<string, unknown>[]): { boys: number; girls: number; other: number; total: number } {
  let boys = 0;
  let girls = 0;
  let other = 0;
  for (const row of rows) {
    const g = String(row['gender'] ?? '').trim().toLowerCase();
    const n = num(row['students']);
    if (/^(m|boy)/.test(g)) boys += n;
    else if (/^(f|girl)/.test(g)) girls += n;
    else other += n;
  }
  return { boys, girls, other, total: boys + girls + other };
}

/**
 * A register's latest day, across schools. Each school's "today" is its own
 * latest marked day; the counts are summed and the day shown is the latest of
 * them, with a note when the schools disagree — a single figure must not hide
 * that it spans two dates.
 */
function latestDay(
  merged: Merged,
  key: string,
): { day: string | null; marked: number; present: number; absent: number; days: string[] } {
  const rows = merged.concatRows(key);
  const days = [...new Set(rows.map((r) => String(r.row['day'] ?? '')).filter((d) => d !== ''))].sort();
  return {
    day: days[days.length - 1] ?? null,
    marked: rows.reduce((s, r) => s + num(r.row['marked_days']), 0),
    present: rows.reduce((s, r) => s + num(r.row['present_days']), 0),
    absent: rows.reduce((s, r) => s + num(r.row['absent_days']), 0),
    days,
  };
}

function dayNote(label: string, latest: ReturnType<typeof latestDay>): string[] {
  if (latest.day === null) return [`No ${label} register has been marked on or before the as-of date.`];
  const notes = [`${capital(label)} attendance is the register of ${dateLabel(latest.day)}, the latest day marked.`];
  if (latest.days.length > 1) {
    notes.push(`The selected schools last marked ${label} attendance on different days (${latest.days.map(dateLabel).join(', ')}); the figure sums them.`);
  }
  return notes;
}

function buildTiles(merged: Merged, ctx: Ctx): Built {
  const widgets: Widget[] = [];
  const notes: string[] = [];

  if (merged.succeeded('roll')) {
    const split = genderSplit(merged.concatRows('roll').map((r) => r.row));
    widgets.push(kpi('tile-students', 'Total students', count(split.total), {
      breakdown: parts([['Boys', count(split.boys)], ['Girls', count(split.girls)]]),
    }));
  }
  if (merged.succeeded('staff')) {
    const total = merged.sumAll('staff', ['on_roll']);
    widgets.push(kpi('tile-staff', 'Total staff', count(num(total?.['on_roll']))));
  }
  if (merged.succeeded('att_today')) {
    const t = latestDay(merged, 'att_today');
    widgets.push(kpi('tile-attendance', "Today's student attendance", pct(share(t.present, t.marked)), {
      tone: attendanceTone(share(t.present, t.marked)),
      breakdown: parts([['Present', count(t.present)], ['Absent', count(t.absent)], ['Register of', t.day === null ? '—' : dateLabel(t.day)]]),
    }));
    notes.push(...dayNote('student', t));
  }
  if (merged.succeeded('staff_today')) {
    const t = latestDay(merged, 'staff_today');
    widgets.push(kpi('tile-staff-attendance', "Today's staff attendance", pct(share(t.present, t.marked)), {
      tone: attendanceTone(share(t.present, t.marked)),
      breakdown: parts([['Present', count(t.present)], ['Absent', count(t.absent)], ['Register of', t.day === null ? '—' : dateLabel(t.day)]]),
    }));
    notes.push(...dayNote('staff', t));
  }
  /**
   * Counted off the roll, not off the admission funnel -- see the `admissions`
   * query in mcp-server/src/reports/catalog.ts for the measurement that moved
   * it. The breakdown is Boys/Girls rather than the Admitted/Candidates it used
   * to be, because the roll has no notion of a candidate: a student is either on
   * it or is not, and there is no one to have applied and been refused.
   */
  if (merged.succeeded('admissions')) {
    const split = genderSplit(merged.concatRows('admissions').map((r) => r.row));
    widgets.push(kpi('tile-admissions', 'New admissions this year', count(split.total), {
      breakdown: parts([['Boys', count(split.boys)], ['Girls', count(split.girls)]]),
    }));
    notes.push('New admissions counts students the ERP marks as new to the school this academic year, read from the roll. It is not the admission funnel’s conversion count — most schools in this extract leave the funnel’s admission number blank.');
  }
  if (merged.succeeded('overdue')) {
    const o = merged.sumAll('overdue', ['defaulters', 'outstanding']);
    widgets.push(kpi('tile-defaulters', 'Fee defaulter amount', rupees(num(o?.['outstanding'])), {
      tone: 'warning',
      breakdown: parts([['Students overdue', count(num(o?.['defaulters']))], ['As of', dateLabel(ctx.asOf)]]),
    }));
  }
  return { widgets, notes };
}

function buildRings(merged: Merged): Built {
  const widgets: Widget[] = [];
  if (merged.succeeded('att_by_month')) {
    const s = merged.sumAll('att_by_month', ['marked_days', 'present_days']);
    const r = share(num(s?.['present_days']), num(s?.['marked_days']));
    widgets.push(kpi('ring-attendance', 'Student attendance', pct(r), { tone: attendanceTone(r) }));
  }
  if (merged.succeeded('fees')) {
    const f = merged.sumAll('fees', ['payable', 'paid', 'balance']);
    const r = share(num(f?.['paid']), num(f?.['payable']));
    widgets.push(kpi('ring-realisation', 'Fee realisation', pct(r)));
    widgets.push(kpi('ring-total', 'Total fees billed', rupees(num(f?.['payable'])), {
      breakdown: parts([['Collected', rupees(num(f?.['paid'])), 'positive'], ['Pending', rupees(num(f?.['balance'])), 'warning']]),
    }));
  }
  if (merged.succeeded('staff_by_month')) {
    const s = merged.sumAll('staff_by_month', ['marked_days', 'present_days']);
    const r = share(num(s?.['present_days']), num(s?.['marked_days']));
    widgets.push(kpi('ring-staff', 'Staff attendance', pct(r), { tone: attendanceTone(r) }));
  }
  return { widgets };
}

/** `heads_by_month` rows summed across schools, in academic order (April first). */
function monthlyHeads(merged: Merged): Record<string, unknown>[] {
  return merged
    .sumBy('heads_by_month', 'fee_month', ['received', 'late_fee', 'transport'], 'mo')
    .sort((a, b) => academicOrder(num(a['mo'])) - academicOrder(num(b['mo'])))
    .map((row) => ({ ...row, month: shortMonth(String(row['fee_month'] ?? '')) }));
}

function buildMonthly(merged: Merged): Built {
  if (!merged.succeeded('heads_by_month')) return { widgets: [] };
  return {
    widgets: [
      { id: 'bar-month', type: 'bar', title: 'Fee receipts by month', x: 'month', y: 'received', x_title: 'Month', y_title: 'Fee received (₹)', data: monthlyHeads(merged).map((r) => ({ month: r['month'] as string, received: num(r['received']) })) },
    ],
  };
}

/**
 * New admissions, one bar per school -- level 1 of the Admissions drill path
 * (services/dashboards.ts `DRILL_PATHS`), drawn on the Dashboard beside the
 * receipts it shares a column with.
 *
 * -- Why it re-groups rather than re-queries ---------------------------------
 * `admissions` is already on the wire for the tiles card, grouped by gender. A
 * school's bar is that school's rows summed; the tile is every school's rows
 * summed. Same statement, two groupings, one scan -- which is what ADR-020
 * means by a drill entry being a re-grouping.
 *
 * -- What it does NOT do -----------------------------------------------------
 * It does not drill IN PLACE. The Dashboard's slot API has no drill endpoint --
 * drilling lives on the report page (routes/report.ts) -- so the card is drawn
 * without `drillable`, and clicking it opens Admissions Funnel where all three
 * levels work. Marking it drillable here would invite a click nothing on this
 * screen can answer.
 */
function buildAdmissionsBySchool(merged: Merged, ctx: Ctx): Built {
  if (!merged.succeeded('admissions')) return { widgets: [] };
  const perSchool = merged.sumPerSchool('admissions', ['students']);
  if (perSchool.length === 0) return { widgets: [] };
  const schoolName = new Map(ctx.scope.map((entry) => [entry.school_id, entry.school_name]));
  return {
    widgets: [
      {
        id: 'bar-school-admissions',
        type: 'bar',
        title: 'New admissions by school',
        x: 'school_name',
        y: 'students',
        x_title: 'School',
        y_title: 'New admissions',
        data: perSchool.map((entry) => ({
          school_name: schoolName.get(entry.school_id) ?? entry.school_id,
          students: entry.totals['students'] ?? 0,
        })),
      },
    ],
    notes: ['Students the ERP marks as new to the school this academic year, read from the roll. Open the report to break a school down by class and then by section.'],
  };
}

function weekly(merged: Merged, key: string, fields: string[]): Record<string, unknown>[] {
  return merged.sumBy(key, 'week', fields, 'seq');
}

function buildWeeklyReceipts(merged: Merged): Built {
  if (!merged.succeeded('receipts_by_week')) return { widgets: [] };
  const raw = weekly(merged, 'receipts_by_week', ['received']);
  const rows = raw.map((r) => ({ week: weekLabel(String(r['week'])), received: num(r['received']) }));
  const lastWeek = raw[raw.length - 1];
  const last = rows[rows.length - 1];
  return {
    widgets: [
      kpi('kpi-week-receipts', 'Weekly receipts', rupees(last === undefined ? 0 : last.received), {
        breakdown: parts([['Week of', lastWeek === undefined ? '—' : weekLabel(String(lastWeek['week']), true)], ['Weeks recorded', count(rows.length)]]),
      }),
      { id: 'line-week-receipts', type: 'line', title: 'Receipts by week', x: 'week', y: 'received', x_title: 'Week starting', y_title: 'Fee received (₹)', data: rows },
    ],
  };
}

function buildWeeklyAttendance(merged: Merged): Built {
  if (!merged.succeeded('att_by_week')) return { widgets: [] };
  const raw = weekly(merged, 'att_by_week', ['marked_days', 'present_days']);
  const rows = raw.map((r) => ({
    week: weekLabel(String(r['week'])),
    rate: pctValue(share(num(r['present_days']), num(r['marked_days']))),
  }));
  const lastWeek = raw[raw.length - 1];
  const last = rows[rows.length - 1];
  return {
    widgets: [
      kpi('kpi-week-attendance', 'Weekly attendance', last === undefined ? '—' : `${String(last.rate)}%`, {
        breakdown: parts([['Week of', lastWeek === undefined ? '—' : weekLabel(String(lastWeek['week']), true)], ['Weeks marked', count(rows.length)]]),
      }),
      { id: 'line-week-attendance', type: 'line', title: 'Student attendance by week, %', x: 'week', y: 'rate', x_title: 'Week starting', y_title: 'Students present (%)', data: rows },
    ],
  };
}

function buildTopSchools(merged: Merged, ctx: Ctx): Built {
  if (!merged.succeeded('fees')) return { widgets: [] };
  const names = new Map(ctx.scope.map((s) => [s.school_id, s.school_name]));
  const rows = merged
    .sumPerSchool('fees', ['payable', 'paid', 'balance'])
    .sort((a, b) => (b.totals['paid'] ?? 0) - (a.totals['paid'] ?? 0))
    .map((s) => ({
      school: names.get(s.school_id) ?? s.school_id,
      school_id: s.school_id,
      collected: rupees(s.totals['paid'] ?? 0),
      collected_raw: s.totals['paid'] ?? 0,
      realisation: pct(share(s.totals['paid'] ?? 0, s.totals['payable'] ?? 0)),
      realisation_raw: pctValue(share(s.totals['paid'] ?? 0, s.totals['payable'] ?? 0)),
    }));
  return {
    widgets: [
      {
        id: 'table-schools',
        type: 'table',
        title: 'Schools by fee collected',
        columns: [
          { field: 'school', label: 'School' },
          { field: 'collected', label: 'Collected', align: 'right', sort_field: 'collected_raw' },
          { field: 'realisation', label: 'Realised', align: 'right', sort_field: 'realisation_raw' },
        ],
        rows,
      },
    ],
  };
}

function buildFeeHeads(merged: Merged): Built {
  const widgets: Widget[] = [];
  const notes: string[] = [];
  const fees = merged.succeeded('fees') ? merged.sumAll('fees', ['payable', 'paid', 'balance']) : null;
  const heads = merged.succeeded('heads') ? merged.sumAll('heads', ['received', 'late_fee', 'transport']) : null;
  if (fees !== null) {
    widgets.push(kpi('kpi-billed', 'Billed till date', rupees(num(fees['payable'])), {
      breakdown: parts([['Received', rupees(num(fees['paid'])), 'positive'], ['Pending', rupees(num(fees['balance'])), 'warning']]),
    }));
  }
  if (heads !== null && fees !== null) {
    const received = num(heads['received']);
    const late = num(heads['late_fee']);
    const transport = num(heads['transport']);
    widgets.push({
      id: 'donut-heads',
      type: 'donut',
      title: 'Where the year’s fee money stands',
      label_field: 'head',
      value_field: 'amount',
      data: [
        { head: 'Fee received', amount: Math.max(0, received - late - transport) },
        { head: 'Late fee collected', amount: late },
        { head: 'Transport fee collected', amount: transport },
        { head: 'Pending', amount: num(fees['balance']) },
      ],
    });
    notes.push(
      'Received, late fee and transport fee are read from the collection ledger; billed and pending from the demand ledger. The two ledgers are kept by different ERP modules and can differ by a few days of posting.',
      "Transport fee is the heads 'Transport Fee', 'Transport Fees', 'Bus Fee', 'TPT1/2/3 FEE' and 'TR.C'; late fee is the head 'Late Fee'.",
    );
  }
  if (merged.succeeded('heads_by_month')) {
    const months = monthlyHeads(merged);
    /**
     * These four draw side by side under one "Fee activity by month" heading
     * (cards.tsx `FeeHeadsCard`), in a column about 120px wide. So the measure
     * is named short — it is the mini's only label — and no `x_title` repeats
     * "Month" four times under a heading that already says it; the first and
     * last month still print under each line.
     */
    const series = (id: string, title: string, field: string, measure: string): Widget => ({
      id, type: 'line', title, x: 'month', y: field,
      y_title: measure,
      data: months.map((r) => ({ month: r['month'] as string, [field]: num(r[field]) })),
    });
    widgets.push(series('line-received', 'Received by month', 'received', 'Received (₹)'));
    widgets.push(series('line-late', 'Late fee by month', 'late_fee', 'Late fee (₹)'));
    widgets.push(series('line-transport', 'Transport fee by month', 'transport', 'Transport (₹)'));
  }
  if (merged.succeeded('pending_by_month')) {
    const rows = merged.sumBy('pending_by_month', 'ym', ['pending']).sort((a, b) => String(a['ym']).localeCompare(String(b['ym'])));
    widgets.push({
      id: 'line-pending', type: 'line', title: 'Pending by month demanded for', x: 'month', y: 'pending',
      /* The one mini whose months are NOT the months money arrived in. */
      x_title: 'Month demanded', y_title: 'Pending (₹)',
      data: rows.map((r) => ({ month: ymLabel(String(r['ym'])), pending: num(r['pending']) })),
    });
  }
  return { widgets, notes };
}

/** Academic-year labels sorted by their starting year; unreadable labels are dropped. */
function byYear(rows: readonly Record<string, unknown>[], field: string, limit = 8): { year: string; value: number }[] {
  const parsed = rows
    .map((r) => ({ year: String(r['ay'] ?? ''), start: yearStart(String(r['ay'] ?? '')), value: num(r[field]) }))
    .filter((r): r is { year: string; start: number; value: number } => r.start !== null);
  parsed.sort((a, b) => a.start - b.start);
  return parsed.slice(-limit).map(({ year, value }) => ({ year, value }));
}

function buildYears(merged: Merged): Built {
  if (!merged.succeeded('collected_by_year') && !merged.succeeded('billed_by_year')) return { widgets: [] };
  const collected = byYear(merged.sumBy('collected_by_year', 'ay', ['collected']), 'collected');
  const billed = byYear(merged.sumBy('billed_by_year', 'ay', ['payable']), 'payable');
  const years = [...new Set([...billed.map((r) => r.year), ...collected.map((r) => r.year)])].sort((a, b) => (yearStart(a) ?? 0) - (yearStart(b) ?? 0)).slice(-8);
  const rows: Record<string, string | number>[] = [];
  for (const year of years) {
    const b = billed.find((r) => r.year === year);
    const c = collected.find((r) => r.year === year);
    if (b !== undefined) rows.push({ year, measure: 'Billed', amount: b.value });
    if (c !== undefined) rows.push({ year, measure: 'Collected', amount: c.value });
  }
  return {
    widgets: [{ id: 'line-years', type: 'line', title: 'Billed and collected, year by year', x: 'year', y: 'amount', series: 'measure', x_title: 'Academic year', y_title: 'Amount (₹)', data: rows }],
    notes: ['Billed comes from the demand ledger, which the extract holds from 2024-25; collected comes from the receipt ledger, which reaches further back.'],
  };
}

function buildStudentsByYear(merged: Merged): Built {
  if (!merged.succeeded('students_by_year')) return { widgets: [] };
  const rows = byYear(merged.sumBy('students_by_year', 'ay', ['students']), 'students');
  return { widgets: [{ id: 'bar-years', type: 'bar', title: 'Students on roll, year by year', x: 'year', y: 'students', x_title: 'Academic year', y_title: 'Students on roll', data: rows.map((r) => ({ year: r.year, students: r.value })) }] };
}

function buildAttStatus(merged: Merged): Built {
  if (!merged.succeeded('att_status')) return { widgets: [] };
  const rows = merged.sumBy('att_status', 'statusname', ['days']).map((r) => ({ status: label(r['statusname']), days: num(r['days']) }));
  return { widgets: [{ id: 'donut-status', type: 'donut', title: 'What the register recorded', label_field: 'status', value_field: 'days', data: rows }] };
}

function buildTopStudents(merged: Merged): Built {
  if (!merged.succeeded('top_attendance')) return { widgets: [] };
  const masked = merged.maskedColumns('top_attendance');
  const rows = merged
    .concatRows('top_attendance')
    .map(({ row }) => {
      const marked = num(row['marked_days']);
      const present = num(row['present_days']);
      return {
        student: label(row['studentname']),
        enrollment: label(row['enrollmentno']),
        class: `${label(row['classname'])}${row['sectionname'] === null || row['sectionname'] === undefined || row['sectionname'] === '' ? '' : `-${String(row['sectionname'])}`}`,
        attendance: pct(share(present, marked)),
        attendance_raw: pctValue(share(present, marked)),
        marked,
      };
    })
    .sort((a, b) => b.attendance_raw - a.attendance_raw || b.marked - a.marked)
    .slice(0, 4);
  return {
    widgets: [
      {
        id: 'table-top-attendance',
        type: 'table',
        title: 'Highest attendance this year',
        columns: [
          { field: 'student', label: 'Student', ...(masked.has('studentname') ? { masked: true } : {}) },
          { field: 'enrollment', label: 'Enrolment', ...(masked.has('enrollmentno') ? { masked: true } : {}) },
          { field: 'class', label: 'Class' },
          { field: 'attendance', label: 'Attendance', align: 'right', sort_field: 'attendance_raw' },
          { field: 'marked', label: 'Days marked', align: 'right' },
        ],
        rows,
      },
    ],
    notes: ['Only students with at least 20 marked days are ranked, so a rate is never a handful of days.'],
  };
}

function buildGauges(merged: Merged): Built {
  const widgets: Widget[] = [];
  const notes: string[] = [];
  if (merged.succeeded('roll')) {
    const s = genderSplit(merged.concatRows('roll').map((r) => r.row));
    widgets.push(kpi('gauge-students-rate', 'Boys share of the roll', pct(share(s.boys, s.total))));
    widgets.push(kpi('gauge-students', 'Students', count(s.total), { breakdown: parts([['Male', count(s.boys)], ['Female', count(s.girls)]]) }));
  }
  if (merged.succeeded('att_today')) {
    const t = latestDay(merged, 'att_today');
    widgets.push(kpi('gauge-attendance-rate', 'Students present today', pct(share(t.present, t.marked)), { tone: attendanceTone(share(t.present, t.marked)) }));
    widgets.push(kpi('gauge-attendance', "Today's student attendance", count(t.present), { breakdown: parts([['Present', count(t.present)], ['Absent', count(t.absent)]]) }));
    notes.push(...dayNote('student', t));
  }
  /**
   * The rate is new admissions as a share of the ROLL, replacing an
   * enquiry-to-admission conversion that no longer has a denominator: the
   * funnel's candidate count left with the funnel (see `buildTiles`). Both
   * numbers come from the same merge, so the share is over the same schools
   * that contributed the numerator -- a school whose roll query failed
   * contributes to neither.
   */
  if (merged.succeeded('admissions')) {
    const a = genderSplit(merged.concatRows('admissions').map((r) => r.row));
    if (merged.succeeded('roll')) {
      const roll = genderSplit(merged.concatRows('roll').map((r) => r.row));
      widgets.push(kpi('gauge-admissions-rate', 'New share of the roll', pct(share(a.total, roll.total))));
    }
    widgets.push(kpi('gauge-admissions', 'New student enrolment', count(a.total), { breakdown: parts([['Boys', count(a.boys)], ['Girls', count(a.girls)]]) }));
  }
  if (merged.succeeded('staff_today')) {
    const t = latestDay(merged, 'staff_today');
    widgets.push(kpi('gauge-staff-rate', 'Staff present today', pct(share(t.present, t.marked)), { tone: attendanceTone(share(t.present, t.marked)) }));
    widgets.push(kpi('gauge-staff', "Today's staff attendance", count(t.present), { breakdown: parts([['Present', count(t.present)], ['Absent', count(t.absent)]]) }));
    notes.push(...dayNote('staff', t));
  }
  return { widgets, notes };
}

function buildLatePayers(merged: Merged): Built {
  if (!merged.succeeded('late_payers') && !merged.succeeded('pending_students')) return { widgets: [] };
  const masked = new Set([...merged.maskedColumns('late_payers'), ...merged.maskedColumns('pending_students')]);
  interface Row { student: string; enrollment: string; class: string; late: number; balance: number; overdue: number }
  const byEnrolment = new Map<string, Row>();
  const seed = (row: Record<string, unknown>): Row => {
    const id = label(row['enrollmentno']);
    let entry = byEnrolment.get(id);
    if (entry === undefined) {
      entry = {
        student: label(row['studentname']),
        enrollment: id,
        class: `${label(row['classname'])}${row['sectionname'] === null || row['sectionname'] === undefined || row['sectionname'] === '' ? '' : `-${String(row['sectionname'])}`}`,
        late: 0,
        balance: 0,
        overdue: 0,
      };
      byEnrolment.set(id, entry);
    }
    return entry;
  };
  for (const { row } of merged.concatRows('late_payers')) seed(row).late += num(row['late_payments']);
  for (const { row } of merged.concatRows('pending_students')) {
    const entry = seed(row);
    entry.balance += num(row['balance']);
    entry.overdue += num(row['overdue']);
  }
  const rows = [...byEnrolment.values()]
    .filter((r) => r.late >= 2 || r.overdue > 0)
    .map((r) => ({
      student: r.student,
      enrollment: r.enrollment,
      class: r.class,
      late_payments: r.late,
      pending: rupees(r.balance),
      pending_raw: r.balance,
      status: r.late >= 2 && r.overdue > 0 ? 'Late & unpaid' : r.late >= 2 ? 'Pays late' : 'Unpaid',
      rank: (r.late >= 2 && r.overdue > 0 ? 2 : 1),
    }))
    .sort((a, b) => b.rank - a.rank || b.late_payments - a.late_payments || b.pending_raw - a.pending_raw)
    .slice(0, 20)
    .map(({ rank: _rank, ...row }) => row);
  return {
    widgets: [
      {
        id: 'table-late-payers',
        type: 'table',
        title: 'Students paying late or not paying',
        columns: [
          { field: 'student', label: 'Student', ...(masked.has('studentname') ? { masked: true } : {}) },
          { field: 'enrollment', label: 'Enrolment', ...(masked.has('enrollmentno') ? { masked: true } : {}) },
          { field: 'class', label: 'Class' },
          { field: 'late_payments', label: 'Late payments', align: 'right' },
          { field: 'pending', label: 'Pending', align: 'right', sort_field: 'pending_raw' },
          { field: 'status', label: 'Status' },
        ],
        rows,
      },
    ],
    notes: [
      'A payment is late when the receipt date falls after the instalment it settles ended; a student is listed at two or more late payments this year, or with an overdue balance as of the date.',
      'The list holds the 50 latest payers and the 50 largest balances per school before ranking, so a very large school may have more such students than are shown.',
    ],
  };
}

function buildPendingTop(merged: Merged): Built {
  if (!merged.succeeded('pending_students')) return { widgets: [] };
  const masked = merged.maskedColumns('pending_students');
  const rows = merged
    .concatRows('pending_students')
    .map(({ row }) => ({
      student: label(row['studentname']),
      enrollment: label(row['enrollmentno']),
      class: `${label(row['classname'])}${row['sectionname'] === null || row['sectionname'] === undefined || row['sectionname'] === '' ? '' : `-${String(row['sectionname'])}`}`,
      pending: rupees(num(row['balance'])),
      pending_raw: num(row['balance']),
      overdue: rupees(num(row['overdue'])),
    }))
    .sort((a, b) => b.pending_raw - a.pending_raw)
    .slice(0, 10);
  return {
    widgets: [
      {
        id: 'table-pending',
        type: 'table',
        title: 'Largest pending fees',
        columns: [
          { field: 'student', label: 'Student', ...(masked.has('studentname') ? { masked: true } : {}) },
          { field: 'enrollment', label: 'Enrolment', ...(masked.has('enrollmentno') ? { masked: true } : {}) },
          { field: 'class', label: 'Class' },
          { field: 'pending', label: 'Pending', align: 'right', sort_field: 'pending_raw' },
          { field: 'overdue', label: 'Of which overdue', align: 'right' },
        ],
        rows,
      },
    ],
  };
}

function buildArea(merged: Merged): Built {
  const widgets: Widget[] = [];
  if (merged.succeeded('heads_by_month')) {
    widgets.push({ id: 'line-receipts', type: 'line', title: 'Fee receipts', x: 'month', y: 'received', x_title: 'Month', y_title: 'Fee received (₹)', data: monthlyHeads(merged).map((r) => ({ month: r['month'] as string, received: num(r['received']) })) });
  }
  if (merged.succeeded('staff_by_month')) {
    const rows = merged.sumBy('staff_by_month', 'month', ['marked_days', 'present_days'], 'seq');
    widgets.push({ id: 'line-staff', type: 'line', title: 'Present staff-days', x: 'month', y: 'present', x_title: 'Month', y_title: 'Staff-days present', data: rows.map((r) => ({ month: ymLabel(String(r['month'])), present: num(r['present_days']) })) });
  }
  if (merged.succeeded('att_by_month')) {
    const rows = merged.sumBy('att_by_month', 'month', ['marked_days', 'present_days'], 'seq');
    widgets.push({ id: 'line-attendance', type: 'line', title: 'Student attendance, %', x: 'month', y: 'rate', x_title: 'Month', y_title: 'Students present (%)', data: rows.map((r) => ({ month: ymLabel(String(r['month'])), rate: pctValue(share(num(r['present_days']), num(r['marked_days']))) })) });
  }
  return { widgets };
}

function buildModes(merged: Merged): Built {
  if (!merged.succeeded('by_mode')) return { widgets: [] };
  const rows = merged.sumBy('by_mode', 'paymenttype', ['collected']).map((r) => ({ mode: label(r['paymenttype']), collected: num(r['collected']) }));
  return { widgets: [{ id: 'donut-mode', type: 'donut', title: 'Payment modes', label_field: 'mode', value_field: 'collected', data: rows }] };
}

function buildLateWeekly(merged: Merged): Built {
  if (!merged.succeeded('late_by_week')) return { widgets: [] };
  const raw = weekly(merged, 'late_by_week', ['students']);
  const rows = raw.map((r) => ({ week: weekLabel(String(r['week'])), students: num(r['students']) }));
  const lastWeek = raw[raw.length - 1];
  const last = rows[rows.length - 1];
  return {
    widgets: [
      kpi('kpi-late-week', 'Students paying late', count(last === undefined ? 0 : last.students), { tone: 'warning', breakdown: parts([['Week of', lastWeek === undefined ? '—' : weekLabel(String(lastWeek['week']), true)], ['Weeks with late receipts', count(rows.length)]]) }),
      { id: 'line-late-week', type: 'line', title: 'Students paying late, by week', x: 'week', y: 'students', x_title: 'Week starting', y_title: 'Students paying late', data: rows },
    ],
    notes: ['A student is counted in the week a receipt was taken after its instalment had ended. The same student can appear in several weeks.'],
  };
}

// -- Small helpers ------------------------------------------------------------------

function kpi(
  id: string,
  labelText: string,
  value: string,
  extra: { tone?: KpiWidget['tone']; breakdown?: KpiPart[] | undefined; delta?: string } = {},
): KpiWidget {
  return {
    id,
    type: 'kpi',
    label: labelText,
    value,
    ...(extra.tone === undefined ? {} : { tone: extra.tone }),
    ...(extra.delta === undefined ? {} : { delta: extra.delta }),
    ...(extra.breakdown === undefined || extra.breakdown.length < 2 ? {} : { breakdown: extra.breakdown.slice(0, 3) }),
  };
}

function parts(entries: readonly (readonly [string, string] | readonly [string, string, KpiPart['tone']])[]): KpiPart[] {
  return entries.map(([l, v, tone]) => ({ label: l, value: v, ...(tone === undefined ? {} : { tone }) }));
}

export function academicYearWindow(year: string): { from: string; to: string } {
  const start = yearStart(year);
  if (start === null) {
    throw new PlatformError({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'That academic year could not be read as a date range.',
      diagnostics: { academic_year: year },
    });
  }
  return { from: `${String(start)}-04-01`, to: `${String(start + 1)}-03-31` };
}

function yearStart(labelText: string): number | null {
  const m = /^(\d{4})\s*-\s*(\d{2}|\d{4})\b/.exec(labelText.trim());
  if (m === null) return null;
  const start = Number(m[1]);
  return Number.isInteger(start) ? start : null;
}

/** April first: the order an Indian academic year is read in. */
function academicOrder(month: number): number {
  return (month + 8) % 12;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function shortMonth(name: string): string {
  const short = name.trim().slice(0, 3);
  const found = MONTHS.find((m) => m.toLowerCase() === short.toLowerCase());
  return found ?? (name.trim() === '' ? '—' : name.trim());
}

function ymLabel(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (m === null) return ym;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${(m[1] ?? '').slice(2)}`;
}

/**
 * `2026-W18` → `27 Apr`: the Monday the week began.
 *
 * It used to render `W18`, which is what the ISO string carries and what
 * nobody outside a finance team reads. A reader hovering the weekly sparkline
 * was told "W14" and had no way to turn that into a date; the week's own start
 * date needs no key. `full` adds the year, for the one place that states a
 * single week rather than a run of them (the KPI line under the figure), where
 * an academic year crossing January makes `5 Jan` ambiguous on its own.
 */
function weekLabel(week: string, full = false): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (m === null) return week;
  const start = isoWeekStart(Number(m[1]), Number(m[2]));
  const day = String(start.getUTCDate());
  const month = MONTHS[start.getUTCMonth()] ?? '';
  return full ? `${day} ${month} ${String(start.getUTCFullYear())}` : `${day} ${month}`;
}

/**
 * The Monday of ISO week `week` in ISO year `year`, in UTC.
 *
 * ISO week 1 is the week holding 4 January (the definition MySQL's
 * `DATE_FORMAT(..., '%x-W%v')` emits), so the year's first Monday is 4 January
 * minus its own weekday, and week N starts N-1 weeks after that.
 */
function isoWeekStart(year: number, week: number): Date {
  const DAY = 86_400_000;
  const jan4 = Date.UTC(year, 0, 4);
  const weekday = new Date(jan4).getUTCDay(); /* 0 = Sunday */
  const monday1 = jan4 - ((weekday === 0 ? 7 : weekday) - 1) * DAY;
  return new Date(monday1 + (week - 1) * 7 * DAY);
}

function dateLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m === null) return iso;
  return `${String(Number(m[3]))} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function label(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return text === '' ? '—' : text;
}

function share(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function pctValue(value: number | null): number {
  return value === null ? 0 : Number((value * 100).toFixed(1));
}

function attendanceTone(value: number | null): 'neutral' | 'positive' | 'warning' {
  if (value === null) return 'neutral';
  if (value >= 0.9) return 'positive';
  return value < 0.75 ? 'warning' : 'neutral';
}

function count(value: number): string {
  return new Intl.NumberFormat('en-IN').format(Math.round(value));
}

function rupees(value: number): string {
  const rounded = Math.round(value);
  if (Math.abs(rounded) >= 10_000_000) return `₹${(rounded / 10_000_000).toFixed(1)}Cr`;
  if (Math.abs(rounded) >= 100_000) return `₹${(rounded / 100_000).toFixed(1)}L`;
  return `₹${new Intl.NumberFormat('en-IN').format(rounded)}`;
}
