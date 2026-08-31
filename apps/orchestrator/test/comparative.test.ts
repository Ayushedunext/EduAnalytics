/**
 * Tests for Comparative Analysis — the year-on-year fee recovery dashboard.
 *
 * This report is almost entirely ARITHMETIC, which is what makes it worth
 * testing at this depth. Every other predefined dashboard mostly relabels
 * numbers the database already computed; this one divides, subtracts across two
 * years, and partitions one total five ways. Each of those is a place where a
 * plausible-looking wrong number is indistinguishable from a right one on
 * screen — a school ranked "Excellent" because a zero denominator produced a
 * zero rate reads exactly like a school that is doing well.
 *
 * So the properties asserted here are the ones a reader would have no way to
 * check for themselves:
 *
 *   1. Rates come from SUMMED totals, never from averaged per-school rates.
 *   2. A change in a rate is quoted in percentage POINTS, not percent.
 *   3. The five payment-timing states partition the money exactly once — no
 *      double counting, and they add to 100%.
 *   4. Estimated = Collected + Outstanding wherever the ledger is consistent,
 *      and where it is NOT, the ledger's own balance wins rather than a
 *      recomputed one.
 *   5. An unknowable rate is an em dash, never 0% — and never a red badge.
 *   6. A report that could read nothing fails loudly instead of rendering an
 *      empty page (CODING_GUIDELINES §10).
 *
 * The MCP client is mocked for the same reason the other dashboard tests mock
 * it: what is under test is how this service shapes an answer, not whether
 * MySQL can add up.
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
  sacskb: 'Kirti Bagh',
};

vi.mock('../src/db/registry.js', () => ({
  schoolNames: (ids: readonly string[]) =>
    Promise.resolve(ids.map((id) => ({ school_id: id, school_name: SCHOOL_NAMES[id] ?? id }))),
}));

const { buildDashboard, previousAcademicYear } = await import('../src/services/dashboards.js');

const SESSION = {
  sub: 'erp-user-1001',
  name: 'A. Rao',
  role: 'DIRECTOR' as const,
  org_id: 'stmarks',
  school_ids: ['stmarksmb', 'stmarksj', 'sacskb'],
  default_school: 'stmarksmb',
  perms: ['fees.read', 'students.read', 'staff.read'],
  permission_class: 'test',
};

const YEAR = '2026-27';
const PRIOR = '2025-26';

function query(key: string, rows: Record<string, unknown>[]): QueryResult {
  return { key, description: `${key} description`, sql: `SELECT 1 AS ${key}`, status: 'ok', rows };
}

/**
 * One school's demand rows, written as (year, fee-period month, payable,
 * collected) with outstanding derived — because that is how a consistent ledger
 * behaves, and the tests that care about an INCONSISTENT one pass `outstanding`
 * explicitly.
 *
 * The month is the CALENDAR month the SQL returns (4 = April), not its position
 * in the academic year; turning one into the other is what the builder is being
 * tested on.
 */
function demand(
  entries: readonly [string, number, number, number, number?][],
): QueryResult {
  return query(
    'demand_by_period',
    entries.map(([ay, month, payable, collected, outstanding]) => ({
      ay,
      period_month: month,
      payable,
      collected,
      outstanding: outstanding ?? payable - collected,
    })),
  );
}

function timing(row: Partial<Record<string, number>>): QueryResult {
  return query('timing', [
    {
      advance: 0,
      same_month: 0,
      next_month: 0,
      later: 0,
      undated: 0,
      receipts: 0,
      ...row,
    },
  ]);
}

function result(schools: { school_id: string; queries: QueryResult[] }[]) {
  return {
    report_id: 'fee-comparative',
    title: 'Comparative Analysis',
    source: 'fee_compile_data_set · fee_collection_data_set',
    params: {},
    as_of: '2026-08-31T10:00:00.000Z',
    schools: schools.map((s) => ({ school_id: s.school_id, status: 'ok', queries: s.queries })),
  };
}

function build(schoolIds: string[] = ['stmarksmb'], compareYear?: string) {
  return buildDashboard({
    session: SESSION,
    schoolIds,
    reportId: 'fee-comparative',
    academicYear: YEAR,
    asOfDate: '2026-08-31',
    ...(compareYear === undefined ? {} : { compareYear }),
    correlationId: 'corr-comparative',
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

// -- Filters ------------------------------------------------------------------

describe('the comparison year is a real, bound filter', () => {
  it('derives the preceding year when the caller names none', async () => {
    response = result([
      { school_id: 'stmarksmb', queries: [demand([[YEAR, 4, 100, 90]])] },
    ]);
    const built = await build();
    expect(lastCall?.args['params']).toEqual({
      academic_year: YEAR,
      compare_year: PRIOR,
    });
    /** Invariant 6: the panel states what was BOUND, not what was requested. */
    expect(built.logic.filters).toContainEqual({ label: 'Compare with', value: PRIOR });
  });

  it('binds the year the caller chose instead, when they chose one', async () => {
    response = result([
      { school_id: 'stmarksmb', queries: [demand([[YEAR, 4, 100, 90]])] },
    ]);
    const built = await build(['stmarksmb'], '2023-24');
    expect(lastCall?.args['params']).toEqual({
      academic_year: YEAR,
      compare_year: '2023-24',
    });
    expect(built.logic.filters).toContainEqual({ label: 'Compare with', value: '2023-24' });
  });

  it('reads both academic-year spellings, and refuses to guess at neither', () => {
    expect(previousAcademicYear('2026-27')).toBe('2025-26');
    /** The century rollover: 2000-01 must not become 2000-100. */
    expect(previousAcademicYear('2000-01')).toBe('1999-00');
    expect(previousAcademicYear('2025-2026')).toBe('2024-2025');
    /** Unreadable stays unreadable — the caller refuses it rather than inventing. */
    expect(previousAcademicYear('this year')).toBe('this year');
  });
});

// -- Core metrics -------------------------------------------------------------

describe('recovery, outstanding and the year-on-year change', () => {
  it('computes recovery from summed totals rather than averaging school rates', async () => {
    /**
     * A big school at 92% and a small one at 60%. Money-weighted recovery is
     * 9,320/10,200 = 91.4%; the mean of the two RATES is 76%. The second number
     * is about schools, not about money, and would put the trust two bands
     * lower than it belongs.
     */
    response = result([
      { school_id: 'stmarksmb', queries: [demand([[YEAR, 4, 10_000, 9_200]])] },
      { school_id: 'stmarksj', queries: [demand([[YEAR, 4, 200, 120]])] },
    ]);
    const built = await build(['stmarksmb', 'stmarksj']);
    expect(kpi(built.spec, 'kpi-recovery')?.value).toBe('91.4%');
    /** And the mean IS available — labelled as a mean, where that is the point. */
    const highlights = table(built.spec, 'table-highlights');
    const average = highlights?.rows.find((r) => r['highlight'] === 'Average school recovery');
    expect(average?.['value']).toBe('76.0%');
  });

  it('quotes a change in a RATE in percentage points, not percent', async () => {
    /** 90% last year, 94% this year: four percentage points, +4.4 percent. */
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [
          demand([
            [YEAR, 4, 1_000, 940],
            [PRIOR, 4, 1_000, 900],
          ]),
        ],
      },
    ]);
    const built = await build();
    expect(kpi(built.spec, 'kpi-recovery')?.delta).toBe(`+4.0 pp vs ${PRIOR}`);
    expect(kpi(built.spec, 'kpi-recovery')?.delta).not.toContain('4.0%');
  });

  it('quotes a runaway change as a MULTIPLE, not a five-figure percentage', async () => {
    /**
     * The live extract's shape: arrears at the end of a settled year are near
     * zero, so this year's mid-year arrears against them came out as
     * "+14,435%" — exact, and unreadable. Nobody converts that into a sense of
     * scale.
     */
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [
          demand([
            [YEAR, 4, 1_000, 100, 900],
            [PRIOR, 4, 1_000, 994, 6],
          ]),
        ],
      },
    ]);
    const built = await build();
    const tile = kpi(built.spec, 'kpi-outstanding');
    expect(tile?.delta).toBe(`up 150× on ${PRIOR}`);
    /** And the figure it is a multiple OF is on the tile, or it means nothing. */
    expect(tile?.breakdown?.[0]).toEqual({ label: `Was · ${PRIOR}`, value: '₹6' });
  });

  it('quotes a change in an AMOUNT as a percentage', async () => {
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [
          demand([
            [YEAR, 4, 1_120, 1_000],
            [PRIOR, 4, 1_000, 900],
          ]),
        ],
      },
    ]);
    const built = await build();
    expect(kpi(built.spec, 'kpi-payable')?.delta).toBe(`+12.0% vs ${PRIOR}`);
  });

  it('keeps Estimated = Collected + Outstanding when the ledger is consistent', async () => {
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [
          demand([
            [YEAR, 4, 1_000, 700],
            [YEAR, 7, 500, 500],
          ]),
        ],
      },
    ]);
    const built = await build();
    const row = table(built.spec, 'table-school')?.rows[0];
    expect(row?.['payable_n']).toBe(1_500);
    expect(row?.['collected_n']).toBe(1_200);
    expect(row?.['outstanding_n']).toBe(300);
    expect(Number(row?.['collected_n']) + Number(row?.['outstanding_n'])).toBe(
      Number(row?.['payable_n']),
    );
  });

  it("reports the ledger's own balance where the ledger does NOT tie", async () => {
    /**
     * An over-received fee head: 1,000 demanded, 1,050 collected, and the ledger
     * carries the balance as 0 rather than as −50. Recomputing payable minus
     * collected here would draw a negative bar the ledger never reported.
     */
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [demand([[YEAR, 4, 1_000, 1_050, 0]])],
      },
    ]);
    const built = await build();
    const row = table(built.spec, 'table-school')?.rows[0];
    expect(row?.['outstanding_n']).toBe(0);
    expect(row?.['recovery']).toBe('105.0%');
  });
});

// -- The recovery timeline ----------------------------------------------------

describe('the payment-timing states partition the money exactly once', () => {
  it('adds to 100% across the five states', async () => {
    /**
     * 800 banked, split across the four paid states, and 200 still owed. Each
     * receipt is in exactly one state, so the five shares must total 100 — a
     * state counted twice would push the stacked bar past its own bar.
     */
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [
          demand([[YEAR, 4, 1_000, 800]]),
          timing({ advance: 200, same_month: 400, next_month: 100, later: 100, receipts: 800 }),
        ],
      },
    ]);
    const built = await build();
    const timeline = bar(built.spec, 'bar-timeline');
    const row = timeline?.data[0] as Record<string, number>;
    const total =
      row['advance']! + row['same_month']! + row['next_month']! + row['later']! + row['pending']!;
    expect(total).toBeCloseTo(100, 5);
    expect(row['advance']).toBe(20);
    expect(row['same_month']).toBe(40);
    expect(row['pending']).toBe(20);
    /** A partition is drawn as a stack, not as five bars side by side. */
    expect(timeline?.stacked).toBe(true);
  });

  it('draws the unclassifiable segment only when there is one', async () => {
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [
          demand([[YEAR, 4, 1_000, 800]]),
          timing({ advance: 200, same_month: 600, receipts: 800 }),
        ],
      },
    ]);
    const clean = await build();
    expect(bar(clean.spec, 'bar-timeline')?.series?.map((s) => s.field)).not.toContain('undated');

    response = result([
      {
        school_id: 'stmarksmb',
        queries: [
          demand([[YEAR, 4, 1_000, 800]]),
          timing({ advance: 200, same_month: 500, undated: 100, receipts: 800 }),
        ],
      },
    ]);
    const dirty = await build();
    const series = bar(dirty.spec, 'bar-timeline')?.series?.map((s) => s.field);
    expect(series).toContain('undated');
    /**
     * And it is appended LAST, after "still pending" — the renderer paints the
     * sixth series in the paler neutral, and giving that to a segment worth half
     * the bar would wash out the one state a reader is looking for.
     */
    expect(series).toEqual(['advance', 'same_month', 'next_month', 'later', 'pending', 'undated']);
  });

  it('drops the timing panels rather than reporting zeroes when the query did not run', async () => {
    response = result([
      { school_id: 'stmarksmb', queries: [demand([[YEAR, 4, 1_000, 800]])] },
    ]);
    const built = await build();
    /**
     * §10: "0% paid in advance" is a strong claim to make on the strength of a
     * query that never ran. The tile and the timeline are absent instead.
     */
    expect(kpi(built.spec, 'kpi-advance')).toBeUndefined();
    expect(bar(built.spec, 'bar-timeline')).toBeUndefined();
    /** Everything the demand ledger CAN answer still renders (ADR-011). */
    expect(kpi(built.spec, 'kpi-recovery')?.value).toBe('80.0%');
  });
});

// -- Edge cases ---------------------------------------------------------------

describe('rates that cannot be computed are not computed', () => {
  it('shows an em dash, not 0%, for a school that raised no demand', async () => {
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [demand([[PRIOR, 4, 1_000, 900]])],
      },
    ]);
    const built = await build();
    const row = table(built.spec, 'table-school')?.rows[0];
    expect(row?.['recovery']).toBe('—');
    /**
     * And it is NOT graded. A red "Needs attention" badge on a school that has
     * done nothing wrong is worse than no badge at all.
     */
    expect(row?.['status']).toBe('No demand raised');
    expect(row?.['recovery_prev']).toBe('90.0%');
  });

  it('omits a year-on-year delta when there is no comparison year to divide by', async () => {
    response = result([
      { school_id: 'stmarksmb', queries: [demand([[YEAR, 4, 1_000, 900]])] },
    ]);
    const built = await build();
    expect(kpi(built.spec, 'kpi-recovery')?.delta).toBeUndefined();
    expect(kpi(built.spec, 'kpi-payable')?.delta).toBeUndefined();
  });

  it('fails loudly when nothing could be read at all', async () => {
    response = result([{ school_id: 'stmarksmb', queries: [query('demand_by_period', [])] }]);
    /** An empty page would read as "these schools raised no fees this year". */
    await expect(build()).rejects.toBeInstanceOf(PlatformError);
  });

  it('ignores a year the report did not ask for', async () => {
    /**
     * The statement filters to two years, so a third is impossible — but a row
     * is external data until it has been read, and folding an unexpected year
     * into the current one would inflate every figure on the page.
     */
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [
          demand([
            [YEAR, 4, 1_000, 900],
            ['2019-20', 4, 9_999_999, 9_999_999],
          ]),
        ],
      },
    ]);
    const built = await build();
    expect(kpi(built.spec, 'kpi-payable')?.value).toBe('₹1,000');
  });
});

// -- Shape of the page --------------------------------------------------------

describe('the page a reader gets', () => {
  it('ranks the school table by outstanding, largest first', async () => {
    response = result([
      { school_id: 'stmarksmb', queries: [demand([[YEAR, 4, 1_000, 900]])] },
      { school_id: 'stmarksj', queries: [demand([[YEAR, 4, 1_000, 100]])] },
      { school_id: 'sacskb', queries: [demand([[YEAR, 4, 1_000, 500]])] },
    ]);
    const built = await build(['stmarksmb', 'stmarksj', 'sacskb']);
    const rows = table(built.spec, 'table-school')?.rows ?? [];
    expect(rows.map((r) => r['school_name'])).toEqual(['Janakpuri', 'Kirti Bagh', 'Meera Bagh']);
    expect(rows.map((r) => r['rank'])).toEqual([1, 2, 3]);
    /** Shares are of the selection's total, and add to 100%. */
    expect(rows.map((r) => r['payable_share'])).toEqual(['33.3%', '33.3%', '33.3%']);
  });

  it('names the best and worst recovering schools, and the largest arrears', async () => {
    response = result([
      { school_id: 'stmarksmb', queries: [demand([[YEAR, 4, 1_000, 950]])] },
      { school_id: 'stmarksj', queries: [demand([[YEAR, 4, 500, 100]])] },
    ]);
    const built = await build(['stmarksmb', 'stmarksj']);
    const rows = table(built.spec, 'table-highlights')?.rows ?? [];
    const by = (highlight: string) => rows.find((r) => r['highlight'] === highlight);
    expect(by('Best recovery')?.['school_name']).toBe('Meera Bagh');
    expect(by('Best recovery')?.['value']).toBe('95.0%');
    expect(by('Lowest recovery')?.['school_name']).toBe('Janakpuri');
    expect(by('Largest outstanding')?.['school_name']).toBe('Janakpuri');
  });

  it('orders fee periods by the ACADEMIC year, not the calendar', async () => {
    /**
     * An Indian school year runs April to March, so January is the tenth month
     * of the year a reader is looking at, not the first. A raw sort on the month
     * number would open the axis on three months that are the END of the year.
     */
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [
          demand([
            [YEAR, 1, 100, 50],
            [YEAR, 4, 100, 90],
            [PRIOR, 7, 100, 80],
          ]),
        ],
      },
    ]);
    const built = await build();
    expect(bar(built.spec, 'bar-period')?.data.map((r) => r['period'])).toEqual([
      'Apr',
      'Jul',
      'Jan',
    ]);
  });

  it('puts the two years on the SAME period category, whatever each is called', async () => {
    /**
     * The bug this axis exists to prevent. In the live extract one school writes
     * "APR 2025-26" one year and "April 2026-27" the next; grouping on that
     * string gives every category one year's bar and a gap where the other's
     * should be, which reads as a school that raised no fees last year. Grouping
     * on the month the fee was demanded FOR is what makes the pair a pair.
     */
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [
          demand([
            [YEAR, 4, 1_000, 900],
            [PRIOR, 4, 800, 600],
          ]),
        ],
      },
    ]);
    const built = await build();
    expect(bar(built.spec, 'bar-period')?.data).toEqual([
      { period: 'Apr', payable: 1_000, collected: 900, collected_prev: 600 },
    ]);
  });

  it('names a period the ledger did not record, and files it last', async () => {
    /**
     * It carries real money, so dropping it would shrink the chart below the KPI
     * tile that sums the same rows — and a reader comparing the two would have
     * no way to tell which was wrong.
     */
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [
          query('demand_by_period', [
            { ay: YEAR, period_month: null, payable: 50, collected: 10, outstanding: 40 },
            { ay: YEAR, period_month: 4, payable: 100, collected: 90, outstanding: 10 },
          ]),
        ],
      },
    ]);
    const built = await build();
    expect(bar(built.spec, 'bar-period')?.data.map((r) => r['period'])).toEqual([
      'Apr',
      'No period recorded',
    ]);
    /** And it is inside the totals, which is the point of drawing it. */
    expect(kpi(built.spec, 'kpi-payable')?.value).toBe('₹150');
  });

  it('gives the recovery trend one point per year per period, and none where there is no demand', async () => {
    response = result([
      {
        school_id: 'stmarksmb',
        queries: [
          demand([
            [YEAR, 4, 1_000, 900],
            [PRIOR, 4, 1_000, 800],
            [YEAR, 7, 1_000, 500],
          ]),
        ],
      },
    ]);
    const built = await build();
    const trend = line(built.spec, 'line-recovery');
    expect(trend?.series).toBe('ay');
    /**
     * July has no comparison-year demand, so it contributes NO second point —
     * a zero would draw last year's line diving to the floor in a month nobody
     * billed in.
     */
    expect(trend?.data).toEqual([
      { period: 'Apr', ay: YEAR, recovery: 90 },
      { period: 'Apr', ay: PRIOR, recovery: 80 },
      { period: 'Jul', ay: YEAR, recovery: 50 },
    ]);
  });

  it('makes the school chart the drill entry, keyed on the id and not the name', async () => {
    response = result([
      { school_id: 'stmarksmb', queries: [demand([[YEAR, 4, 1_000, 900]])] },
    ]);
    const built = await build();
    const chart = bar(built.spec, 'bar-school');
    expect(chart?.drillable).toBe(true);
    expect(chart?.drill_dim).toBe('school');
    expect(chart?.drill_value_field).toBe('school_id');
    expect(chart?.data[0]?.['school_id']).toBe('stmarksmb');
  });

  it('carries a raw sort key beside every formatted figure in the school table', async () => {
    /**
     * The displayed cell is "₹9.5 L"; sorting that as text files it under
     * "₹2.4 Cr". Every numeric column therefore names a sibling field holding
     * the comparable number — and that field must actually be on the rows.
     */
    response = result([
      { school_id: 'stmarksmb', queries: [demand([[YEAR, 4, 1_000, 900]])] },
    ]);
    const built = await build();
    const widget = table(built.spec, 'table-school');
    const row = widget?.rows[0] ?? {};
    for (const column of widget?.columns ?? []) {
      if (column.sort_field === undefined) continue;
      expect(typeof row[column.sort_field]).toBe('number');
    }
  });

  it('stays linear on a large selection', async () => {
    /**
     * Twenty schools with twelve instalments across two years is 480 rows, which
     * is a realistic trust. The point is not the timing — it is that nothing in
     * the builder is quadratic in the school count, which a nested scan over
     * `schools` inside the row loop would quietly make it.
     */
    const schools = Array.from({ length: 20 }, (_unused, index) => ({
      school_id: `school-${String(index)}`,
      queries: [
        demand(
          Array.from({ length: 12 }, (_x, i) => i + 1).flatMap((month) => [
            [YEAR, month, 1_000, 900] as [string, number, number, number],
            [PRIOR, month, 900, 800] as [string, number, number, number],
          ]),
        ),
        timing({ advance: 100, same_month: 800, receipts: 900 }),
      ],
    }));
    response = result(schools);
    const built = await build(schools.map((s) => s.school_id));
    expect(table(built.spec, 'table-school')?.rows).toHaveLength(20);
    expect(bar(built.spec, 'bar-timeline')?.data).toHaveLength(20);
  });
});
