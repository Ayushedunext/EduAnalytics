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

describe('Fee Defaulters counts people once and money once', () => {
  const aging = [
    { bucket: 'Not yet due', seq: -20, students: 30, outstanding: 500000 },
    { bucket: '1-30 days', seq: 3, students: 20, outstanding: 200000 },
    { bucket: '31-60 days', seq: 34, students: 15, outstanding: 150000 },
    { bucket: '90+ days', seq: 121, students: 10, outstanding: 300000 },
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
   * Selected by days overdue rather than by matching the band's label, so
   * renaming a band in the catalog cannot silently empty the tile a school
   * escalates on.
   */
  it('reads the 90+ tile from the band’s age, not its name', async () => {
    const built = await build('fee-defaulters');
    expect(kpi(built.spec, 'kpi-90plus')?.value).toBe('₹3.0L');
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
