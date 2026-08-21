/**
 * Tests for the predefined dashboard presentation layer.
 *
 * Three things are worth testing here and the rest is layout:
 *
 *   1. The FILTERS each report sends. `run_predefined` refuses a report handed a
 *      filter it does not declare, so sending `academic_year` to Staff Overview
 *      — which has no academic year in its table — would 400 every staff
 *      dashboard in production while typechecking perfectly.
 *   2. That people are never summed like money. A child owing across three fee
 *      heads appears in three aging bands, so a defaulter count added up from
 *      the bands counts them three times.
 *   3. That masking and partial failure survive the trip to the screen. A masked
 *      column must arrive labelled as masked (CODING §10: a silently absent
 *      column is a success-shaped failure), and a report that could read nothing
 *      must fail loudly rather than render an empty page.
 *
 * The MCP client is mocked: the thing under test is how this service shapes an
 * answer, not whether MySQL can count. That keeps these runnable with no
 * database and no MCP server.
 */

/**
 * FIRST, before anything that reaches `config` — including the result cache,
 * which these tests must run without. See env-defaults.ts.
 */
import './env-defaults.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformError } from '@sap/shared';
import type { ChartSpec, KpiWidget, TableWidget } from '@sap/chart-spec';

interface QueryResult {
  key: string;
  description: string;
  sql: string;
  status: 'ok' | 'failed';
  rows?: Record<string, unknown>[];
  masked_columns?: string[];
  error?: { code: string; message: string };
}

/** What the mocked `run_predefined` will answer with, per test. */
let response: Record<string, unknown> = {};
/** What the service actually asked for — the assertion target for filters. */
let lastCall: { tool: string; args: Record<string, unknown> } | null = null;

vi.mock('../src/mcp/client.js', () => ({
  withMcp: async (
    _session: unknown,
    _correlationId: string,
    _schoolIds: readonly string[],
    fn: (mcp: {
      call: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
    }) => Promise<unknown>,
  ) =>
    fn({
      call: (tool: string, args: Record<string, unknown>) => {
        lastCall = { tool, args };
        return Promise.resolve(response);
      },
    }),
}));

const SCHOOL_NAMES: Record<string, string> = {
  stmarksmb: 'Meera Bagh',
  stmarksj: 'Janakpuri',
};

vi.mock('../src/db/registry.js', () => ({
  schoolNames: (ids: readonly string[]) =>
    Promise.resolve(ids.map((id) => ({ school_id: id, school_name: SCHOOL_NAMES[id] ?? id }))),
}));

const { buildDashboard, DASHBOARD_IDS } = await import('../src/services/dashboards.js');

const SESSION = {
  sub: 'erp-user-1001',
  name: 'A. Rao',
  role: 'DIRECTOR' as const,
  org_id: 'stmarks',
  school_ids: ['stmarksmb', 'stmarksj'],
  default_school: 'stmarksmb',
  perms: ['fees.read', 'students.read', 'staff.read'],
  permission_class: 'test',
};

function query(key: string, rows: Record<string, unknown>[], masked: string[] = []): QueryResult {
  return {
    key,
    description: `${key} description`,
    sql: `SELECT 1 AS ${key}`,
    status: 'ok',
    rows,
    masked_columns: masked,
  };
}

function result(args: {
  reportId: string;
  title: string;
  schools: { school_id: string; queries: QueryResult[] }[];
}) {
  return {
    report_id: args.reportId,
    title: args.title,
    source: 'a_table',
    params: {},
    as_of: '2026-08-19T10:00:00.000Z',
    schools: args.schools.map((s) => ({ school_id: s.school_id, status: 'ok', queries: s.queries })),
  };
}

function build(reportId: string, schoolIds: string[] = ['stmarksmb']) {
  return buildDashboard({
    session: SESSION,
    schoolIds,
    reportId: reportId as (typeof DASHBOARD_IDS)[number],
    academicYear: '2026-27',
    asOfDate: '2026-08-19',
    correlationId: 'corr-1',
  });
}

/**
 * Widgets are picked out of the union by type, not cast into shape. If a
 * dashboard ever emits a different widget under one of these ids, these helpers
 * stop compiling instead of quietly asserting nothing.
 */
function kpi(spec: ChartSpec, id: string): KpiWidget | undefined {
  return spec.widgets.find((w): w is KpiWidget => w.type === 'kpi' && w.id === id);
}

function table(spec: ChartSpec, id: string): TableWidget | undefined {
  return spec.widgets.find((w): w is TableWidget => w.type === 'table' && w.id === id);
}

beforeEach(() => {
  response = {};
  lastCall = null;
});

/**
 * The catalog is data, not screens (docs/11 §1), so every id it advertises must
 * be servable. A report id in the union with no builder behind it is a menu
 * entry that 404s.
 */
describe('every advertised dashboard is a real one', () => {
  it.each([...DASHBOARD_IDS])('%s builds from result sets it recognises', async (reportId) => {
    response = result({
      reportId,
      title: reportId,
      // Deliberately unrecognised keys: the builder must not throw on data it
      // does not know, it must produce nothing and let the caller fail loudly.
      schools: [{ school_id: 'stmarksmb', queries: [query('unknown_key', [{ x: 1 }])] }],
    });
    await expect(build(reportId)).rejects.toBeInstanceOf(PlatformError);
  });
});

describe('a report is only sent the filters it declares', () => {
  it('sends the academic year and the as-of date to Fee Defaulters', async () => {
    response = result({
      reportId: 'fee-defaulters',
      title: 'Fee Defaulters',
      schools: [
        {
          school_id: 'stmarksmb',
          queries: [query('totals', [{ defaulters: 12, overdue: 400000 }])],
        },
      ],
    });
    await build('fee-defaulters');
    expect(lastCall?.args['params']).toEqual({
      academic_year: '2026-27',
      as_of_date: '2026-08-19',
    });
  });

  /**
   * The regression this file exists for. `employees_data_set` has no academic
   * year, so the report does not declare one, and `run_predefined` rejects any
   * filter a report did not declare — sending it would break every staff
   * dashboard at runtime and nowhere else.
   */
  it('sends Staff Overview the as-of date and NOT an academic year', async () => {
    response = result({
      reportId: 'staff-overview',
      title: 'Staff Overview',
      schools: [
        {
          school_id: 'stmarksmb',
          queries: [query('movement', [{ on_roll: 120, joined_12m: 14, left_12m: 6 }])],
        },
      ],
    });
    await build('staff-overview');
    expect(lastCall?.args['params']).toEqual({ as_of_date: '2026-08-19' });
  });

  it('sends Admissions Funnel only the academic year', async () => {
    response = result({
      reportId: 'admissions-funnel',
      title: 'Admissions Funnel',
      schools: [
        {
          school_id: 'stmarksmb',
          queries: [
            query('funnel', [
              { candidates: 100, enquiries: 100, registrations: 70, applications: 55, admissions: 40 },
            ]),
          ],
        },
      ],
    });
    await build('admissions-funnel');
    expect(lastCall?.args['params']).toEqual({ academic_year: '2026-27' });
  });

  it('shows on screen only the filters it actually bound', async () => {
    response = result({
      reportId: 'staff-overview',
      title: 'Staff Overview',
      schools: [
        {
          school_id: 'stmarksmb',
          queries: [query('movement', [{ on_roll: 120, joined_12m: 14, left_12m: 6 }])],
        },
      ],
    });
    const built = await build('staff-overview');
    expect(built.logic.filters).toEqual([{ label: 'As of', value: '2026-08-19' }]);
  });
});

/**
 * Attendance Analytics.
 *
 * Everything below is a property that fails SILENTLY if it breaks -- a wrong
 * percentage, a reassuring zero, a filter that narrows nothing -- which is why
 * these are tests and not comments.
 */
describe('Attendance Analytics reports what was marked, and nothing more', () => {
  function summary(rows: Record<string, unknown>) {
    return query('summary', [rows]);
  }

  it('binds the academic year AND a date window, because two tables need two filters', async () => {
    response = result({
      reportId: 'attendance-analytics',
      title: 'Attendance Analytics',
      schools: [
        {
          school_id: 'stmarksmb',
          queries: [summary({ marked_days: 10, working_days: 2, expected_days: 20, present_days: 9 })],
        },
      ],
    });
    await build('attendance-analytics');

    /**
     * The window is derived from the year rather than asked for separately: the
     * attendance table stamps every row with the CURRENT academic year, so its
     * own year column cannot carry the filter and `attendancedate` has to. The
     * year is still sent because `students_data_set` -- where the roll count for
     * coverage comes from -- can be trusted with it.
     */
    expect(lastCall?.args['params']).toEqual({
      academic_year: '2026-27',
      from_date: '2026-04-01',
      to_date: '2027-03-31',
    });
  });

  it('shows the dates it computed over, not just the year someone picked', async () => {
    response = result({
      reportId: 'attendance-analytics',
      title: 'Attendance Analytics',
      schools: [
        {
          school_id: 'stmarksmb',
          queries: [summary({ marked_days: 10, working_days: 2, expected_days: 20, present_days: 9 })],
        },
      ],
    });
    const built = await build('attendance-analytics');

    // Invariant 6: a filter pill states what was BOUND. A report filtered by
    // date that showed only a year pill would be claiming the wrong mechanism.
    expect(built.logic.filters).toEqual([
      { label: 'Academic year', value: '2026-27' },
      { label: 'From', value: '2026-04-01' },
      { label: 'To', value: '2027-03-31' },
    ]);
  });

  it('divides summed totals across schools rather than averaging their rates', async () => {
    response = result({
      reportId: 'attendance-analytics',
      title: 'Attendance Analytics',
      schools: [
        {
          // A small school having a very good week.
          school_id: 'stmarksmb',
          queries: [summary({ marked_days: 100, working_days: 5, expected_days: 100, present_days: 100 })],
        },
        {
          // A large one having a bad one.
          school_id: 'stmarksj',
          queries: [summary({ marked_days: 900, working_days: 5, expected_days: 900, present_days: 450 })],
        },
      ],
    });
    const built = await build('attendance-analytics', ['stmarksmb', 'stmarksj']);

    /**
     * 550/1000 = 55.0%. The mean of the two schools' rates is 75%, and that
     * number would weigh a 100-day school the same as a 900-day one -- the exact
     * mistake this module's header forbids.
     */
    expect(kpi(built.spec, 'kpi-attendance-rate')?.value).toBe('55.0%');
  });

  it('says nobody marked the register rather than reporting 0% attendance', async () => {
    response = result({
      reportId: 'attendance-analytics',
      title: 'Attendance Analytics',
      schools: [
        {
          school_id: 'stmarksmb',
          queries: [summary({ marked_days: 0, working_days: 0, expected_days: 0, present_days: 0 })],
        },
      ],
    });
    const built = await build('attendance-analytics');

    // 0% is a claim that every child was absent. Nobody claimed it.
    expect(kpi(built.spec, 'kpi-attendance-rate')?.value).toBe('—');
    expect(kpi(built.spec, 'kpi-days-marked')?.value).toBe('0');
    expect(built.logic.notes[0]).toContain('No attendance has been marked');
  });

  it('does not report zero students below 75% when that query failed', async () => {
    response = result({
      reportId: 'attendance-analytics',
      title: 'Attendance Analytics',
      schools: [
        {
          school_id: 'stmarksmb',
          queries: [
            summary({ marked_days: 100, working_days: 5, expected_days: 100, present_days: 90 }),
            {
              key: 'low_attendance',
              description: 'low',
              sql: 'SELECT 1',
              status: 'failed',
              error: { code: 'QUERY_TIMEOUT', message: 'took too long' },
            },
          ],
        },
      ],
    });
    const built = await build('attendance-analytics');

    /**
     * The most dangerous number this dashboard could print. "0 students below
     * 75%" reads as good news; here it would mean the list never loaded.
     */
    expect(kpi(built.spec, 'kpi-below-75')?.value).toBe('—');
    expect(built.degraded.map((d) => d.key)).toContain('low_attendance');
  });

  it('fails loudly when the summary itself could not be read', async () => {
    response = result({
      reportId: 'attendance-analytics',
      title: 'Attendance Analytics',
      schools: [
        {
          school_id: 'stmarksmb',
          queries: [
            {
              key: 'summary',
              description: 'summary',
              sql: 'SELECT 1',
              status: 'failed',
              error: { code: 'TENANT_UNAVAILABLE', message: 'unreachable' },
            },
          ],
        },
      ],
    });

    // An outage must not arrive wearing the words for an empty register.
    await expect(build('attendance-analytics')).rejects.toBeInstanceOf(PlatformError);
  });

  it('orders classes by the enrolment ordinal, not by their labels', async () => {
    response = result({
      reportId: 'attendance-analytics',
      title: 'Attendance Analytics',
      schools: [
        {
          school_id: 'stmarksmb',
          queries: [
            summary({ marked_days: 30, working_days: 3, expected_days: 30, present_days: 27 }),
            query('by_class', [
              { classname: 'X', marked_days: 10, present_days: 9 },
              { classname: 'IX', marked_days: 10, present_days: 8 },
              { classname: 'Nursery', marked_days: 10, present_days: 10 },
            ]),
            query('class_order', [
              { classname: 'Nursery', seq: 1 },
              { classname: 'IX', seq: 9 },
              { classname: 'X', seq: 10 },
            ]),
          ],
        },
      ],
    });
    const built = await build('attendance-analytics');
    const bar = built.spec.widgets.find((w) => w.id === 'bar-class');

    // Sorted as text, X comes before IX and Nursery comes last. The ordinal
    // lives in the enrolment table because the attendance table has none.
    expect(bar?.type === 'bar' ? bar.data.map((r) => r['classname']) : []).toEqual([
      'Nursery',
      'IX',
      'X',
    ]);
  });

  it('labels a masked student column as masked rather than dropping it', async () => {
    response = result({
      reportId: 'attendance-analytics',
      title: 'Attendance Analytics',
      schools: [
        {
          school_id: 'stmarksmb',
          queries: [
            summary({ marked_days: 10, working_days: 5, expected_days: 10, present_days: 4 }),
            query(
              'low_attendance',
              [
                {
                  studentname: '***',
                  enrollmentno: '***',
                  classname: 'IX',
                  sectionname: 'A',
                  marked_days: 10,
                  present_days: 4,
                },
              ],
              ['studentname', 'enrollmentno'],
            ),
          ],
        },
      ],
    });
    const built = await build('attendance-analytics');
    const rows = table(built.spec, 'table-low-attendance');

    expect(rows?.columns.find((c) => c.field === 'studentname')?.masked).toBe(true);
    expect(rows?.columns.find((c) => c.field === 'classname')?.masked).toBeUndefined();
    // 4 present of 10 marked. The percentage is computed here, not in SQL.
    expect(rows?.rows[0]?.['attendance_pct']).toBe(40);
  });
});

describe('Fee Defaulters counts people once and money once', () => {
  /** `seq` is the band ordinal the catalog emits: 0/1 context, 2–5 overdue. */
  const aging = [
    { bucket: 'Not yet due', seq: 1, students: 30, outstanding: 500000 },
    { bucket: '1-30 days', seq: 2, students: 20, outstanding: 200000 },
    { bucket: '31-60 days', seq: 3, students: 15, outstanding: 150000 },
    { bucket: '90+ days', seq: 5, students: 10, outstanding: 300000 },
  ];

  beforeEach(() => {
    response = result({
      reportId: 'fee-defaulters',
      title: 'Fee Defaulters',
      schools: [
        {
          school_id: 'stmarksmb',
          queries: [
            query('totals', [{ defaulters: 35, overdue: 650000 }]),
            query('aging', aging),
            query('by_class', [{ classname: 'XII', seq: 12, students: 9, outstanding: 250000 }]),
            query('by_component', [{ componentname: 'Tuition Fee', students: 30, outstanding: 600000 }]),
          ],
        },
      ],
    });
  });

  it('takes the defaulter count from its own query, not from the aging bands', async () => {
    const built = await build('fee-defaulters');
    // The bands add up to 45 students; 35 distinct children carry the debt.
    expect(kpi(built.spec, 'kpi-defaulters')?.value).toBe('35');
  });

  it('excludes dues that are not yet due from the overdue total', async () => {
    const built = await build('fee-defaulters');
    // ₹6.5L overdue, not the ₹11.5L that includes the not-yet-due band.
    expect(kpi(built.spec, 'kpi-overdue')?.value).toBe('₹6.5L');
  });

  /**
   * Selected by the band ordinal rather than by matching its label, so renaming
   * a band in the catalog cannot silently empty the tile a school escalates on.
   */
  it('reads the 90+ tile from the band ordinal, not its name', async () => {
    const built = await build('fee-defaulters');
    expect(kpi(built.spec, 'kpi-90plus')?.value).toBe('₹3.0L');
  });

  /**
   * The chart plots the escalation; not-yet-due demand is a tile beside it.
   * In a mid-year school it is two orders of magnitude larger, and on the same
   * axis it renders every overdue band as an invisible sliver.
   */
  it('keeps not-yet-due demand off the aging chart but on the page', async () => {
    const built = await build('fee-defaulters');
    expect(kpi(built.spec, 'kpi-not-due')?.value).toBe('₹5.0L');

    const chart = built.spec.widgets.find((w) => w.id === 'bar-aging');
    const bands =
      chart?.type === 'bar' ? chart.data.map((row) => String(row['bucket'])) : [];
    expect(bands).toEqual(['1-30 days', '31-60 days', '90+ days']);

    // …and the table still accounts for every band, context ones included.
    expect(table(built.spec, 'table-aging')?.rows.map((r) => String(r['bucket']))).toContain(
      'Not yet due',
    );
  });

  it('shows a dash rather than dividing by zero when nobody has defaulted', async () => {
    response = result({
      reportId: 'fee-defaulters',
      title: 'Fee Defaulters',
      schools: [
        {
          school_id: 'stmarksmb',
          queries: [query('totals', [{ defaulters: 0, overdue: 0 }]), query('aging', [])],
        },
      ],
    });
    const built = await build('fee-defaulters');
    expect(kpi(built.spec, 'kpi-average')?.value).toBe('—');
  });
});

describe('the named defaulter list', () => {
  function withList(masked: string[]) {
    return result({
      reportId: 'fee-defaulters',
      title: 'Fee Defaulters',
      schools: [
        {
          school_id: 'stmarksmb',
          queries: [
            query('totals', [{ defaulters: 2, overdue: 30000 }]),
            query(
              'top_defaulters',
              [
                {
                  enrollmentno: 'E-1',
                  studentname: 'A. Sharma',
                  classname: 'XII',
                  sectionname: 'A',
                  outstanding: 20000,
                  days_overdue: 95,
                },
              ],
              masked,
            ),
          ],
        },
        {
          school_id: 'stmarksj',
          queries: [
            query('totals', [{ defaulters: 1, overdue: 50000 }]),
            query(
              'top_defaulters',
              [
                {
                  enrollmentno: 'E-9',
                  studentname: 'R. Iyer',
                  classname: 'X',
                  sectionname: 'B',
                  outstanding: 50000,
                  days_overdue: 40,
                },
              ],
              masked,
            ),
          ],
        },
      ],
    });
  }

  it('re-ranks across schools and names the school each child belongs to', async () => {
    response = withList([]);
    const built = await build('fee-defaulters', ['stmarksmb', 'stmarksj']);
    const list = table(built.spec, 'table-defaulters');
    expect(list?.rows.map((r) => r['outstanding'])).toEqual([50000, 20000]);
    expect(list?.rows[0]?.['school']).toBe('Janakpuri');
  });

  it('omits the school column when there is only one school', async () => {
    response = result({
      reportId: 'fee-defaulters',
      title: 'Fee Defaulters',
      schools: [
        {
          school_id: 'stmarksmb',
          queries: [
            query('totals', [{ defaulters: 1, overdue: 20000 }]),
            query('top_defaulters', [
              {
                enrollmentno: 'E-1',
                studentname: 'A. Sharma',
                classname: 'XII',
                sectionname: 'A',
                outstanding: 20000,
                days_overdue: 95,
              },
            ]),
          ],
        },
      ],
    });
    const built = await build('fee-defaulters');
    expect(table(built.spec, 'table-defaulters')?.columns.map((c) => c.field)).not.toContain('school');
  });

  /**
   * docs/04 §3 rail 6 masks identities for a session without student-data
   * rights. The column must arrive LABELLED as masked: a column that quietly
   * reads "[masked]" with no explanation looks like broken data.
   */
  it('labels masked identity columns as masked', async () => {
    response = withList(['studentname', 'enrollmentno']);
    const built = await build('fee-defaulters', ['stmarksmb', 'stmarksj']);
    const columns = table(built.spec, 'table-defaulters')?.columns ?? [];
    expect(columns.find((c) => c.field === 'studentname')?.masked).toBe(true);
    expect(columns.find((c) => c.field === 'enrollmentno')?.masked).toBe(true);
    // The amounts are not masked, and must not be labelled as if they were.
    expect(columns.find((c) => c.field === 'outstanding')?.masked).toBeUndefined();
  });
});

describe('Staff Overview', () => {
  beforeEach(() => {
    response = result({
      reportId: 'staff-overview',
      title: 'Staff Overview',
      schools: [
        {
          school_id: 'stmarksmb',
          queries: [
            query('movement', [{ on_roll: 90, joined_12m: 12, left_12m: 10 }]),
            query('by_department', [{ departmentname: 'Science', staff: 20 }]),
            query('by_stafftype', [{ stafftype: 'Teaching', staff: 70 }]),
          ],
        },
      ],
    });
  });

  it('reports attrition against everyone employed in the window', async () => {
    const built = await build('staff-overview');
    // 10 leavers out of 100 who were on the payroll at some point in the year.
    expect(kpi(built.spec, 'kpi-attrition')?.value).toBe('10.0%');
  });

  it('says on screen that staff records carry no academic year', async () => {
    const built = await build('staff-overview');
    expect(built.logic.notes.join(' ')).toContain('no academic year');
  });
});

describe('Admissions Funnel', () => {
  it('states that the stages are inferred rather than recorded', async () => {
    response = result({
      reportId: 'admissions-funnel',
      title: 'Admissions Funnel',
      schools: [
        {
          school_id: 'stmarksmb',
          queries: [
            query('funnel', [
              { candidates: 200, enquiries: 200, registrations: 150, applications: 120, admissions: 80 },
            ]),
          ],
        },
      ],
    });
    const built = await build('admissions-funnel');
    expect(kpi(built.spec, 'kpi-conversion')?.value).toBe('40.0%');
    expect(built.logic.notes.join(' ')).toMatch(/reading of the data rather than a field in it/);
  });
});

/**
 * ADR-011 at panel granularity: one failed query does not blank the dashboard,
 * and a dashboard that could read NOTHING is an error rather than an empty page
 * (CODING §10 — the success-shaped failure this codebase shipped once already).
 */
describe('partial and total failure', () => {
  it('renders the panels that worked and names the one that did not', async () => {
    response = result({
      reportId: 'fee-defaulters',
      title: 'Fee Defaulters',
      schools: [
        {
          school_id: 'stmarksmb',
          queries: [
            query('totals', [{ defaulters: 5, overdue: 100000 }]),
            {
              key: 'aging',
              description: 'aging',
              sql: 'SELECT 1',
              status: 'failed',
              error: { code: 'QUERY_TIMEOUT', message: 'the query took too long' },
            },
          ],
        },
      ],
    });
    const built = await build('fee-defaulters');
    expect(kpi(built.spec, 'kpi-overdue')).toBeDefined();
    expect(built.degraded).toEqual([{ key: 'aging', message: 'the query took too long' }]);
  });

  it('fails loudly when every query was refused, rather than rendering nothing', async () => {
    response = result({
      reportId: 'staff-overview',
      title: 'Staff Overview',
      schools: [
        {
          school_id: 'stmarksmb',
          queries: [
            {
              key: 'movement',
              description: 'movement',
              sql: 'SELECT 1',
              status: 'failed',
              error: {
                code: 'PERMISSION_DENIED',
                message: 'This session does not have access to staff data.',
              },
            },
          ],
        },
      ],
    });
    await expect(build('staff-overview')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
