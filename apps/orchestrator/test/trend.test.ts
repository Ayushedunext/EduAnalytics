/**
 * Tests for Trend Analysis — the long-view dashboard.
 *
 * What makes this report worth testing at this depth is that almost every wrong
 * answer it could give looks exactly like a right one. A trend is a shape, and a
 * reader has no way to check a shape against the ledger it came from: a line
 * that climbs because a partial year was drawn beside full ones, or because an
 * id collision decayed over a decade, is indistinguishable on screen from a line
 * that climbs because the school grew.
 *
 * So the properties asserted here are the ones nobody could catch by looking:
 *
 *   1. The current academic year is compared LIKE FOR LIKE — against the same
 *      months of the previous year, never against its full total.
 *   2. Students are counted per school and SUMMED, so the ERP's per-school
 *      `studentid` reuse cannot undercount a trust.
 *   3. Class XII completion is excluded from attrition everywhere, and the
 *      exclusion survives a reword of the catalog's CASE arm (asserted against
 *      the real SQL, not a copy of it).
 *   4. The rolling average starts only once a full window exists, and averages
 *      the window rather than everything so far.
 *   5. Enrollment years that are junk, or stranded across a gap, are dropped —
 *      and the page SAYS how many, rather than drawing eleven years as twelve.
 *   6. Stacked shares partition each year exactly once, with the fold-in
 *      category carrying the remainder rather than losing it.
 *   7. The monthly timeline splits per school when there are schools to compare
 *      and keeps its 12-month average when there are not — and a school with no
 *      rows for a month leaves a GAP, never a zero.
 *   8. A report that could read nothing fails loudly rather than rendering an
 *      empty page (CODING_GUIDELINES §10).
 *
 * The MCP client is mocked for the same reason every other dashboard test mocks
 * it: what is under test is how this service shapes an answer, not whether MySQL
 * can add up.
 */

/** FIRST, before anything that reaches `config`. See env-defaults.ts. */
import './env-defaults.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformError } from '@sap/shared';
import type { BarWidget, ChartSpec, KpiWidget, LineWidget, TableWidget } from '@sap/chart-spec';

interface QueryResult {
  key: string;
  description: string;
  sql: string;
  status: 'ok' | 'failed';
  rows?: Record<string, unknown>[];
  error?: { code: string; message: string };
}

let response: Record<string, unknown> = {};
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
  stmarksg: 'World School',
  sacskb: 'Kirti Bagh',
  sacsgb: 'Green Bagh',
  dcsd: 'Dwarka',
};

vi.mock('../src/db/registry.js', () => ({
  schoolNames: (ids: readonly string[]) =>
    Promise.resolve(ids.map((id) => ({ school_id: id, school_name: SCHOOL_NAMES[id] ?? id }))),
}));

const { buildDashboard } = await import('../src/services/dashboards.js');
const { predefinedReports } = await import('../../mcp-server/src/reports/catalog.js');

const SESSION = {
  sub: 'erp-user-1001',
  name: 'A. Rao',
  role: 'DIRECTOR' as const,
  org_id: 'stmarks',
  school_ids: ['stmarksmb', 'stmarksj', 'stmarksg', 'sacskb', 'sacsgb', 'dcsd'],
  default_school: 'stmarksmb',
  perms: ['fees.read', 'students.read', 'staff.read'],
  permission_class: 'test',
};

/** 31 August 2026: five months into 2026-27, and 2026 is an incomplete year. */
const AS_OF = '2026-08-31';

function query(key: string, rows: Record<string, unknown>[]): QueryResult {
  return { key, description: `${key} description`, sql: `SELECT 1 AS ${key}`, status: 'ok', rows };
}

/** Receipts, written as (month, mode, collected, receipts). */
function collection(
  entries: readonly [string, string, number, number?][],
): QueryResult {
  return query(
    'collection_by_month',
    entries.map(([ym, paymenttype, collected, receipts]) => ({
      ym,
      paymenttype,
      collected,
      receipts: receipts ?? 1,
    })),
  );
}

/** Enrollment, written as (academic year label, students, girls, boys). */
function enrollment(
  entries: readonly [string, number, number?, number?][],
): QueryResult {
  return query(
    'enrollment_by_year',
    entries.map(([ay, students, girls, boys]) => ({
      ay,
      students,
      girls: girls ?? 0,
      boys: boys ?? 0,
    })),
  );
}

/** Departures, written as (calendar year, reason, students). */
function exits(entries: readonly [number, string, number][]): QueryResult {
  return query(
    'student_exits',
    entries.map(([y, reason, students]) => ({ y, reason, students })),
  );
}

function result(schools: { school_id: string; queries: QueryResult[] }[]) {
  return {
    report_id: 'trend-analysis',
    title: 'Trend Analysis',
    source: 'fee_collection_data_set · students_data_set · employees_data_set',
    params: {},
    as_of: '2026-08-31T10:00:00.000Z',
    schools: schools.map((s) => ({ school_id: s.school_id, status: 'ok', queries: s.queries })),
  };
}

function build(schoolIds: string[] = ['stmarksmb']) {
  return buildDashboard({
    session: SESSION,
    schoolIds,
    reportId: 'trend-analysis',
    academicYear: '2026-27',
    asOfDate: AS_OF,
    correlationId: 'corr-trend',
  });
}

function kpi(spec: ChartSpec, id: string): KpiWidget | undefined {
  return spec.widgets.find((w): w is KpiWidget => w.type === 'kpi' && w.id === id);
}
function bar(spec: ChartSpec, id: string): BarWidget | undefined {
  return spec.widgets.find((w): w is BarWidget => w.type === 'bar' && w.id === id);
}
function line(spec: ChartSpec, id: string): LineWidget | undefined {
  return spec.widgets.find((w): w is LineWidget => w.type === 'line' && w.id === id);
}
function table(spec: ChartSpec, id: string): TableWidget | undefined {
  return spec.widgets.find((w): w is TableWidget => w.type === 'table' && w.id === id);
}

beforeEach(() => {
  response = {};
  lastCall = null;
});

// ---------------------------------------------------------------------------

describe('the report asks for the filters a trend actually has', () => {
  /**
   * The decision the whole report follows from. `run_predefined` refuses a
   * filter a report does not declare, so sending an academic year here would be
   * an outright failure — but the failure this guards against is the quieter
   * one, where someone "fixes" the report by adding a year filter and collapses
   * every series to a single point while the page still looks like a trend.
   */
  it('sends the as-of date and no academic year', async () => {
    response = result([
      { school_id: 'stmarksmb', queries: [collection([['2026-04', 'Online', 100]])] },
    ]);
    await build();
    expect(lastCall?.args['params']).toEqual({ as_of_date: AS_OF });
  });
});

describe('the current year is compared like for like', () => {
  /**
   * The trap this report exists inside. On 31 August, 2026-27 is five months
   * old. Comparing its ₹500 against a full previous year's ₹1,200 reports a
   * school that has lost half its income; comparing it against the same five
   * months' ₹400 reports the +25% that actually happened.
   */
  it('measures the part-year against the same months of the year before', async () => {
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [
          collection([
            // 2025-26: 400 in its first five months, 1200 across the whole year.
            ['2025-04', 'Online', 100],
            ['2025-05', 'Online', 100],
            ['2025-06', 'Online', 100],
            ['2025-07', 'Online', 50],
            ['2025-08', 'Online', 50],
            ['2025-12', 'Online', 400],
            ['2026-03', 'Online', 400],
            // 2026-27: 500 in the five months elapsed at the as-of date.
            ['2026-04', 'Online', 200],
            ['2026-05', 'Online', 100],
            ['2026-06', 'Online', 100],
            ['2026-07', 'Online', 50],
            ['2026-08', 'Online', 50],
          ]),
        ],
      },
    ]);
    const { spec } = await build();
    const tile = kpi(spec, 'kpi-collected');

    expect(tile?.value).toBe('₹500');
    /** +25% against 400, NOT −58% against 1,200. */
    expect(tile?.delta).toContain('+25.0%');
    expect(tile?.delta).toContain('same months of 2025-26');
    /** Both readings on screen, so neither has to be taken on trust. */
    expect(tile?.breakdown).toEqual([
      { label: 'First 5 months · 2025-26', value: '₹400' },
      { label: 'Full year · 2025-26', value: '₹1,200' },
    ]);
  });

  it('says on the page that the latest year is a part-year', async () => {
    response = result([
      { school_id: 'stmarksmb', queries: [collection([['2026-04', 'Online', 100]])] },
    ]);
    const { logic } = await build();
    expect(logic.notes.some((note) => note.includes('5 months old at 2026-08-31'))).toBe(true);
  });
});

describe('the April boundary is applied to every series', () => {
  /**
   * February 2026 belongs to 2025-26. Filing it under 2026 would move a third of
   * every year's money into the next one — and it would do so consistently, so
   * the resulting chart would look entirely plausible.
   */
  it('files January to March under the academic year that started the April before', async () => {
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [
          collection([
            ['2026-02', 'Online', 300],
            ['2026-04', 'Online', 700],
          ]),
        ],
      },
    ]);
    const { spec } = await build();
    const rows = table(spec, 'table-year')?.rows ?? [];
    expect(rows.find((r) => r['ay'] === '2025-26')?.['collected_n']).toBe(300);
    expect(rows.find((r) => r['ay'] === '2026-27')?.['collected_n']).toBe(700);
  });

  it('draws the seasonal axis from April, not from January', async () => {
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [
          collection([
            ['2026-04', 'Online', 10],
            ['2026-05', 'Online', 20],
            ['2027-01', 'Online', 30],
          ]),
        ],
      },
    ]);
    const { spec } = await build();
    const months = (line(spec, 'line-seasonality')?.data ?? []).map((row) => row['month']);
    expect(months).toEqual(['Apr', 'May', 'Jan']);
  });
});

describe('students are counted per school and summed', () => {
  /**
   * The ERP reuses `studentid` across schools — ids 1 to 5 exist in all three St
   * Marks databases. Each school's query counts its own distinct students, and
   * the orchestrator must ADD those counts. Anything that de-duplicated across
   * schools here would reproduce the collision the per-school scan avoids, and
   * it would do so in a way that decays over time: the same bug drew 4,226
   * students for 2015-16 against a true 9,560.
   */
  it('adds two schools rolls rather than de-duplicating them', async () => {
    response = result([
      { school_id: 'stmarksmb', queries: [enrollment([['2026-27', 4000, 1800, 2200]])] },
      { school_id: 'stmarksj', queries: [enrollment([['2026-27', 3000, 1400, 1600]])] },
    ]);
    const { spec } = await build(['stmarksmb', 'stmarksj']);
    expect(kpi(spec, 'kpi-students')?.value).toBe('7,000');
    expect(kpi(spec, 'kpi-students')?.breakdown).toEqual([
      { label: 'Girls', value: '3,200' },
      { label: 'Boys', value: '3,800' },
    ]);
  });

  it('states on the page why the counts are added', async () => {
    response = result([
      { school_id: 'stmarksmb', queries: [enrollment([['2026-27', 10]])] },
    ]);
    const { logic } = await build();
    expect(logic.notes.some((note) => note.includes('Student ids repeat across schools'))).toBe(
      true,
    );
  });
});

describe('junk and stranded academic years are dropped, and said to be', () => {
  it('rejects labels that are not an academic year', async () => {
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [
          enrollment([
            ['2025-26', 100],
            ['2026-27', 110],
            ['2010-11 New', 2015],
            ['Demo_Palak_2030-2031', 1],
            ['04', 32],
          ]),
        ],
      },
    ]);
    const { spec, logic } = await build();
    const years = (bar(spec, 'bar-enrollment')?.data ?? []).map((row) => row['ay']);
    expect(years).toEqual(['2025-26', '2026-27']);
    expect(logic.notes.some((note) => note.includes('could not read'))).toBe(true);
  });

  /**
   * A single 1995-96 row followed by a decade of nothing is not the start of the
   * series — it is a stray. Drawn literally it makes a thirty-year axis carrying
   * one point at the far left and squeezes the real trend into the right-hand
   * third.
   */
  it('keeps only the run of years contiguous with the most recent', async () => {
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [
          enrollment([
            ['1995-96', 1],
            ['2024-25', 100],
            ['2025-26', 110],
            ['2026-27', 120],
          ]),
        ],
      },
    ]);
    const { spec, logic } = await build();
    const years = (bar(spec, 'bar-enrollment')?.data ?? []).map((row) => row['ay']);
    expect(years).toEqual(['2024-25', '2025-26', '2026-27']);
    expect(logic.notes.some((note) => note.includes('not contiguous'))).toBe(true);
  });

  it('rejects a two-digit suffix that does not follow its century', async () => {
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [enrollment([['2026-27', 100], ['2025-99', 5]])],
      },
    ]);
    const { spec } = await build();
    const years = (bar(spec, 'bar-enrollment')?.data ?? []).map((row) => row['ay']);
    expect(years).toEqual(['2026-27']);
  });
});

describe('graduation is not attrition', () => {
  /**
   * The single most consequential decision on the page. Class XII completion is
   * 58% of all departures in the delivered extract; folding it into churn
   * reports every school as losing a sixth of its roll every March, which is the
   * school working exactly as intended.
   */
  it('excludes Class XII completion from the attrition tile and counts it beside', async () => {
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [
          exits([
            [2025, 'Completed Class XII', 600],
            [2025, 'At the family request', 300],
            [2025, 'Fees unpaid', 100],
            [2024, 'At the family request', 200],
          ]),
        ],
      },
    ]);
    const { spec } = await build();
    const tile = kpi(spec, 'kpi-attrition');
    /** 400 early leavers, not the 1,000 total departures. */
    expect(tile?.label).toBe('Left before finishing · 2025');
    expect(tile?.value).toBe('400');
    expect(tile?.breakdown?.[0]).toEqual({ label: 'Completed Class XII', value: '600' });
    expect(tile?.breakdown?.[1]).toEqual({
      label: 'Of all departures',
      value: '40.0%',
      tone: 'warning',
    });
  });

  it('leaves graduation off the departures chart entirely', async () => {
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [
          exits([
            [2025, 'Completed Class XII', 600],
            [2025, 'At the family request', 300],
            [2025, 'Fees unpaid', 100],
          ]),
        ],
      },
    ]);
    const { spec } = await build();
    const labels = (bar(spec, 'bar-exits')?.series ?? []).map((s) => s.label);
    expect(labels).not.toContain('Completed Class XII');
    expect(labels).toEqual(['At the family request', 'Fees unpaid']);
  });

  /**
   * A stack needs two segments (`bar.series` is `min(2)`). A school whose
   * departures all carry one reason still has a departure trend, so the chart
   * degrades to a plain single-series bar — it must not vanish, which is what an
   * unguarded `series` would have made it do.
   */
  it('degrades to a plain bar when only one departure reason is on file', async () => {
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [
          exits([
            [2025, 'Completed Class XII', 600],
            [2025, 'At the family request', 300],
            [2024, 'At the family request', 200],
          ]),
        ],
      },
    ]);
    const { spec } = await build();
    const widget = bar(spec, 'bar-exits');

    expect(widget).toBeDefined();
    expect(widget?.series).toBeUndefined();
    expect(widget?.stacked).toBeUndefined();
    expect(widget?.title).toContain('At the family request');
    expect(widget?.data.map((row) => row['reason_0'])).toEqual([200, 300]);
  });

  /**
   * The attrition figures are defined by a STRING this module shares with the
   * MCP server's SQL, and there is no shared enum to import — the buckets exist
   * only as arms of a CASE. So the coupling is checked against the real catalog
   * rather than a copy of it: reword the arm and this fails, instead of every
   * attrition number on the page silently tripling.
   */
  it('matches the bucket the catalog SQL actually emits', () => {
    const report = predefinedReports().find((entry) => entry.id === 'trend-analysis');
    const sql = report?.queries.find((q) => q.key === 'student_exits')?.sql ?? '';
    expect(sql).toContain("'Completed Class XII'");
  });

  /** A partial calendar year would report a collapse in attrition every January. */
  it('reports the last COMPLETE calendar year, not the current one', async () => {
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [
          exits([
            [2026, 'At the family request', 5],
            [2025, 'At the family request', 300],
          ]),
        ],
      },
    ]);
    const { spec } = await build();
    expect(kpi(spec, 'kpi-attrition')?.label).toBe('Left before finishing · 2025');
  });
});

describe('the rolling average is an average of its window', () => {
  /**
   * Two failures are possible and both draw a plausible line: starting the
   * average before a full window exists opens the chart with a climb that is
   * only the window filling up, and averaging everything-so-far turns a flat
   * series into a rising one.
   */
  it('emits nothing until a full twelve months exist, then averages exactly twelve', async () => {
    /** 13 months: twelve at 100, then one at 1,300. */
    const entries: [string, string, number][] = [];
    for (let month = 4; month <= 12; month += 1) {
      entries.push([`2025-${String(month).padStart(2, '0')}`, 'Online', 100]);
    }
    for (let month = 1; month <= 3; month += 1) {
      entries.push([`2026-${String(month).padStart(2, '0')}`, 'Online', 100]);
    }
    entries.push(['2026-04', 'Online', 1300]);

    response = result([{ school_id: 'stmarksmb', queries: [collection(entries)] }]);
    const { spec } = await build();
    const averages = (line(spec, 'line-collection')?.data ?? []).filter(
      (row) => row['measure'] === '12-month average',
    );

    /** 13 months in, so exactly two windows are complete. */
    expect(averages).toHaveLength(2);
    expect(averages[0]?.['collected']).toBe(100);
    /** (11 x 100 + 1300) / 12 = 200 — the window, not the whole series. */
    expect(averages[1]?.['collected']).toBe(200);
  });
});

describe('stacked shares partition each year exactly once', () => {
  it('folds the modes past the palette into a labelled remainder that carries the rest', async () => {
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [
          collection([
            ['2026-04', 'Online', 500],
            ['2026-04', 'Cash', 200],
            ['2026-04', 'Cheque', 150],
            ['2026-04', 'DD', 100],
            ['2026-04', 'Payment in Bank', 30],
            ['2026-04', 'NA', 20],
          ]),
        ],
      },
    ]);
    const { spec } = await build();
    const widget = bar(spec, 'bar-mode');
    const row = widget?.data[0] ?? {};

    expect(widget?.stacked).toBe(true);
    /** Four named plus one fold-in, so the palette is never exhausted. */
    expect(widget?.series).toHaveLength(5);
    expect(widget?.series?.[4]?.label).toBe('Other (2 modes)');

    const total = (widget?.series ?? []).reduce(
      (sum, s) => sum + Number(row[s.field] ?? 0),
      0,
    );
    /** The segments are the whole of the year's money, to a rounding tenth. */
    expect(total).toBeCloseTo(100, 1);
  });

  it('draws the gender split only as far as it is recorded, and keeps the roll whole', async () => {
    response = result([
      { school_id: 'stmarksmb', queries: [enrollment([['2026-27', 1000, 500, 480]])] },
    ]);
    const { spec } = await build();
    const widget = bar(spec, 'bar-enrollment');
    expect(widget?.series?.map((s) => s.label)).toEqual(['Girls', 'Boys', 'Gender not recorded']);
    /** 500 + 480 + 20 = the 1,000 on roll; the bar height is the roll. */
    expect(widget?.data[0]?.['unrecorded']).toBe(20);
  });

  it('omits the unrecorded segment when every student has a gender', async () => {
    response = result([
      { school_id: 'stmarksmb', queries: [enrollment([['2026-27', 1000, 520, 480]])] },
    ]);
    const { spec } = await build();
    expect(bar(spec, 'bar-enrollment')?.series?.map((s) => s.label)).toEqual(['Girls', 'Boys']);
  });
});

describe('staff joining and leaving are two counts, never a total', () => {
  it('groups rather than stacks, because 60 arrivals on 55 departures is not 115', async () => {
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [
          query('staff_joins', [{ y: 2025, staff: 60 }, { y: 2026, staff: 30 }]),
          query('staff_exits', [{ y: 2025, staff: 55 }, { y: 2026, staff: 40 }]),
        ],
      },
    ]);
    const { spec } = await build();
    const widget = bar(spec, 'bar-staff');
    expect(widget?.stacked).toBeUndefined();
    expect(widget?.series?.map((s) => s.label)).toEqual(['Joined', 'Left']);
    expect(kpi(spec, 'kpi-staff')?.value).toBe('+5');
  });

  it('signs a net loss rather than losing the minus', async () => {
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [
          query('staff_joins', [{ y: 2025, staff: 10 }]),
          query('staff_exits', [{ y: 2025, staff: 40 }]),
        ],
      },
    ]);
    const { spec } = await build();
    const tile = kpi(spec, 'kpi-staff');
    expect(tile?.value).toBe('−30');
    expect(tile?.tone).toBe('warning');
  });
});

describe('the school bar is the drill entry', () => {
  it('carries the school id to push and the name to read', async () => {
    response = result([
      { school_id: 'stmarksmb', queries: [collection([['2026-04', 'Online', 900]])] },
      { school_id: 'stmarksj', queries: [collection([['2026-04', 'Online', 300]])] },
    ]);
    const { spec } = await build(['stmarksmb', 'stmarksj']);
    const widget = bar(spec, 'bar-school');

    expect(widget?.drillable).toBe(true);
    expect(widget?.drill_dim).toBe('school');
    expect(widget?.drill_value_field).toBe('school_id');
    /** Largest first, so the school that matters is the first bar read. */
    expect(widget?.data.map((row) => row['school_name'])).toEqual(['Meera Bagh', 'Janakpuri']);
    /** One measure, so no legend restating the title. */
    expect(widget?.series).toBeUndefined();
  });
});

describe('the year-by-year table mixes no calendar year into an academic one', () => {
  /**
   * Enrollment is academic, departures and staff movements are calendar-dated.
   * A 2025 exit count in a row headed 2025-26 would silently re-date a quarter
   * of it, so those columns are deliberately absent.
   */
  it('carries only the measures that are themselves academic', async () => {
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [
          collection([['2026-04', 'Online', 100]]),
          enrollment([['2026-27', 50, 25, 25]]),
          exits([[2025, 'Fees unpaid', 9]]),
          query('staff_joins', [{ y: 2025, staff: 3 }]),
        ],
      },
    ]);
    const { spec } = await build();
    const fields = (table(spec, 'table-year')?.columns ?? []).map((c) => c.field);
    expect(fields).toContain('students');
    expect(fields).toContain('collected');
    expect(fields).not.toContain('joins');
    expect(fields).not.toContain('exits');
  });

  it('prints an em dash where a year has money but no roll on file', async () => {
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [collection([['2021-04', 'Online', 100], ['2026-04', 'Online', 100]])],
      },
    ]);
    const { spec } = await build();
    const row = (table(spec, 'table-year')?.rows ?? []).find((r) => r['ay'] === '2021-22');
    /** Not "0 students" — a roll nobody reported is not a roll of nobody. */
    expect(row?.['students']).toBe('—');
  });
});

describe('a report that could read nothing fails loudly', () => {
  /**
   * CODING_GUIDELINES §10. An empty Trend Analysis would render as a school with
   * no history at all — the success-shaped failure this codebase names first.
   */
  it('throws rather than rendering an empty page', async () => {
    response = result([{ school_id: 'stmarksmb', queries: [query('unknown_key', [{ x: 1 }])] }]);
    await expect(build()).rejects.toBeInstanceOf(PlatformError);
  });

  it('builds from the fee ledger alone when the other sources are absent', async () => {
    response = result([
      { school_id: 'stmarksmb', queries: [collection([['2026-04', 'Online', 100]])] },
    ]);
    const { spec } = await build();
    /** Every widget guards its own inputs, so a partial fetch is a partial page. */
    expect(line(spec, 'line-collection')).toBeDefined();
    expect(bar(spec, 'bar-enrollment')).toBeUndefined();
    expect(kpi(spec, 'kpi-students')).toBeUndefined();
  });
});

describe('the monthly timeline splits by school when there are schools to compare', () => {
  /**
   * A single summed line cannot be asked the question a trust opens this page
   * with. Three schools moving in opposite directions and one moving steadily
   * produce the same total, so the aggregate is not a weaker answer — it is a
   * different one, and it hides exactly the divergence a director is looking for.
   */
  it('draws one line per school, in the months order the axis reads', async () => {
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [collection([['2026-04', 'Online', 700], ['2026-05', 'Online', 300]])],
      },
      {
        school_id: 'stmarksj',
        queries: [collection([['2026-04', 'Online', 400], ['2026-05', 'Online', 200]])],
      },
    ]);
    const { spec } = await build(['stmarksmb', 'stmarksj']);
    const widget = line(spec, 'line-collection');

    expect(widget?.series).toBe('school');
    expect(widget?.title).toContain('by school');
    expect(widget?.data).toEqual([
      { month: 'Apr 2026', school: 'Meera Bagh', collected: 700 },
      { month: 'Apr 2026', school: 'Janakpuri', collected: 400 },
      { month: 'May 2026', school: 'Meera Bagh', collected: 300 },
      { month: 'May 2026', school: 'Janakpuri', collected: 200 },
    ]);
  });

  /**
   * With one school there is no comparison to draw, so the axis is better spent
   * on the twelve-month average — which is what separates a real trend from the
   * April spike that recurs every year.
   */
  it('keeps the aggregate and its 12-month average for a single school', async () => {
    response = result([
      { school_id: 'stmarksmb', queries: [collection([['2026-04', 'Online', 700]])] },
    ]);
    const { spec } = await build(['stmarksmb']);
    const widget = line(spec, 'line-collection');

    expect(widget?.series).toBe('measure');
    expect(widget?.title).not.toContain('by school');
    expect(widget?.data[0]?.['measure']).toBe('Collected in the month');
  });

  /**
   * A school that was not yet on the platform must leave a GAP. A zero would
   * claim it banked nothing that month, which on a line chart reads as a
   * collapse rather than an absence — and the renderer draws the gap for free,
   * because `pivotSeries` simply has no key for a pair that was never emitted.
   */
  it('omits a month a school has no rows for rather than writing a zero', async () => {
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [collection([['2026-04', 'Online', 700], ['2026-05', 'Online', 300]])],
      },
      { school_id: 'stmarksj', queries: [collection([['2026-05', 'Online', 200]])] },
    ]);
    const { spec } = await build(['stmarksmb', 'stmarksj']);
    const rows = line(spec, 'line-collection')?.data ?? [];

    const april = rows.filter((r) => r['month'] === 'Apr 2026');
    expect(april.map((r) => r['school'])).toEqual(['Meera Bagh']);
    expect(april.some((r) => r['collected'] === 0)).toBe(false);
  });

  /**
   * A trust can hold more schools than the palette has colours. The smallest are
   * summed into one labelled line rather than drawn in a repeated colour that a
   * reader would attribute to a named school.
   */
  it('names the four largest and folds the rest into one labelled line', async () => {
    const ids = ['stmarksmb', 'stmarksj', 'stmarksg', 'sacskb', 'sacsgb', 'dcsd'];
    const amounts = [600, 500, 400, 300, 20, 10];
    response = result(
      ids.map((school_id, i) => ({
        school_id,
        queries: [collection([['2026-04', 'Online', amounts[i] ?? 0]])],
      })),
    );
    const { spec, logic } = await build(ids);
    const rows = line(spec, 'line-collection')?.data ?? [];
    const drawn = rows.map((r) => r['school']);

    expect(drawn).toEqual([
      'Meera Bagh',
      'Janakpuri',
      'World School',
      'Kirti Bagh',
      'Other schools (2)',
    ]);
    /** The fold is a SUM and is drawn, so no school's money leaves the chart. */
    expect(rows.find((r) => r['school'] === 'Other schools (2)')?.['collected']).toBe(30);
    expect(logic.notes.some((n) => n.includes('sums the remaining 2'))).toBe(true);
  });
});
