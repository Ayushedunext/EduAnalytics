/**
 * Tests for the Dashboard's cards (services/overview.ts, `buildOverviewSlot`).
 *
 * What a card PROMISES, not any one school's numbers:
 *
 *   1. A slot runs exactly the queries it names, against the overview report,
 *      with the four filters the report declares — so the tiles card never
 *      pays for a fee-ledger scan and a renamed key fails here, not in a
 *      browser.
 *   2. Every slot's queries exist in the MCP catalog (the same "catalog is
 *      data" rule drill.test.ts holds for drill paths).
 *   3. The merges are right where they are subtle: "today" sums schools and
 *      names the day; late payers join two ledgers by enrolment and rank
 *      "late and unpaid" first; the fee-heads donut partitions billed money.
 *   4. A card that cannot be built is `blocked` with its reason, never thrown.
 */

import './env-defaults.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import type { KpiWidget, LineWidget, TableWidget, DonutWidget } from '@sap/chart-spec';
import { predefinedReports } from '../../mcp-server/src/reports/catalog.js';

interface QueryResult {
  key: string;
  description: string;
  sql: string;
  status: 'ok' | 'failed';
  rows?: Record<string, unknown>[];
  masked_columns?: string[];
  error?: { code: string; message: string };
}

let response: Record<string, unknown> = {};
let lastCall: { tool: string; args: Record<string, unknown> } | null = null;

vi.mock('../src/mcp/client.js', () => ({
  withMcp: async (
    _session: unknown,
    _correlationId: string,
    _schoolIds: readonly string[],
    fn: (mcp: { call: (tool: string, args: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>,
  ) =>
    fn({
      call: (tool: string, args: Record<string, unknown>) => {
        lastCall = { tool, args };
        return Promise.resolve(response);
      },
    }),
}));

vi.mock('../src/db/registry.js', () => ({
  schoolNames: (ids: readonly string[]) =>
    Promise.resolve(ids.map((id) => ({ school_id: id, school_name: id === 'a' ? 'Alpha' : 'Beta' }))),
}));

vi.mock('../src/cache/result-cache.js', () => ({
  cacheGet: () => Promise.resolve(null),
  cacheSet: () => Promise.resolve(),
  cacheKey: (parts: unknown) => JSON.stringify(parts),
  refreshInBackground: () => undefined,
}));

const { buildOverviewSlot, OVERVIEW_SLOTS, OVERVIEW_REPORT_ID } = await import('../src/services/overview.js');

const SESSION = {
  sub: 'erp-user-1001',
  name: 'A. Rao',
  role: 'DIRECTOR' as const,
  org_id: 'org',
  school_ids: ['a', 'b'],
  default_school: 'a',
  perms: ['fees.read', 'students.read', 'staff.read'],
  permission_class: 'test',
};

function query(key: string, rows: Record<string, unknown>[], masked: string[] = []): QueryResult {
  return { key, description: `${key} description`, sql: `SELECT 1 AS ${key}`, status: 'ok', rows, masked_columns: masked };
}

function result(schools: { school_id: string; queries: QueryResult[] }[]) {
  return {
    report_id: OVERVIEW_REPORT_ID,
    title: 'Dashboard',
    source: 'tables',
    params: {},
    as_of: '2026-09-04T10:00:00.000Z',
    schools: schools.map((s) => ({ school_id: s.school_id, status: 'ok', queries: s.queries })),
  };
}

function build(slot: keyof typeof OVERVIEW_SLOTS, schoolIds: string[] = ['a', 'b']) {
  return buildOverviewSlot({
    session: SESSION,
    schoolIds,
    slot,
    academicYear: '2026-27',
    asOfDate: '2026-09-04',
    correlationId: 'corr-1',
  });
}

beforeEach(() => {
  response = {};
  lastCall = null;
});

describe('every slot names real queries of the overview report', () => {
  const report = predefinedReports().find((r) => r.id === OVERVIEW_REPORT_ID);
  it('the report exists', () => {
    expect(report).toBeDefined();
  });
  it.each(Object.entries(OVERVIEW_SLOTS))('%s', (_slot, keys) => {
    const known = new Set(report?.queries.map((q) => q.key));
    for (const key of keys) expect(known.has(key), `unknown query ${key}`).toBe(true);
  });
});

describe('a slot runs only its own queries, with the four declared filters', () => {
  it('tiles asks for its six keys and nothing from the fee ledger', async () => {
    response = result([{ school_id: 'a', queries: [] }]);
    await build('tiles');
    expect(lastCall?.tool).toBe('run_predefined');
    expect(lastCall?.args['report_id']).toBe(OVERVIEW_REPORT_ID);
    expect(lastCall?.args['query_keys']).toEqual([...OVERVIEW_SLOTS.tiles]);
    expect(lastCall?.args['params']).toEqual({
      academic_year: '2026-27',
      as_of_date: '2026-09-04',
      from_date: '2026-04-01',
      to_date: '2027-03-31',
    });
  });
});

describe('today sums the schools and names the day', () => {
  it('reports the latest marked day and notes when schools differ', async () => {
    response = result([
      { school_id: 'a', queries: [query('att_today', [{ day: '2026-07-21', marked_days: 100, present_days: '90', absent_days: '10' }])] },
      { school_id: 'b', queries: [query('att_today', [{ day: '2026-07-20', marked_days: 50, present_days: '30', absent_days: '20' }])] },
    ]);
    const card = await build('tiles');
    expect(card.status).toBe('ok');
    const tile = card.widgets.find((w): w is KpiWidget => w.type === 'kpi' && w.id === 'tile-attendance');
    expect(tile?.value).toBe('80.0%');
    expect(tile?.breakdown?.map((p) => p.value)).toEqual(['120', '30', '21 Jul 2026']);
    expect(card.notes.some((n) => n.includes('different days'))).toBe(true);
  });
});

/**
 * The staff tile was the only one on the card standing on a bare number while
 * every neighbour carried its parts, which reads as a tile whose detail failed
 * to load rather than as one with no detail to give. It carries the same
 * permanent / not-permanent split the Dashboard's KPI strip prints, from the
 * same classification (services/staff-types.ts) — so the two screens cannot
 * disagree about what "permanent" counts.
 *
 * The second case is the one worth locking in: `stafftype` is opaque codes for
 * most tenants in the extract, and a tile that answered "Permanent 0, Not
 * permanent 0, Unclassified 228" would be reporting the column's shape as if it
 * were the school's staffing.
 */
describe('the staff tile carries its employment split, and only where the ERP names one', () => {
  it('sums the schools and splits permanent, not permanent and the rest', async () => {
    response = result([
      {
        school_id: 'a',
        queries: [
          query('staff', [
            { stafftype: 'CONFIRMATION', on_roll: 120 },
            { stafftype: 'CONTRACTUAL', on_roll: 40 },
            { stafftype: 'S0011', on_roll: 35 },
          ]),
        ],
      },
      {
        school_id: 'b',
        queries: [
          query('staff', [
            { stafftype: 'PROBATION', on_roll: 18 },
            { stafftype: 'S004AD', on_roll: 15 },
          ]),
        ],
      },
    ]);
    const card = await build('tiles');
    const tile = card.widgets.find((w): w is KpiWidget => w.type === 'kpi' && w.id === 'tile-staff');
    /** The headcount is unchanged by the grouping: every row still counts. */
    expect(tile?.value).toBe('228');
    expect(tile?.breakdown).toEqual([
      { label: 'Permanent', value: '120' },
      { label: 'Not permanent', value: '58' },
      { label: 'Unclassified', value: '50' },
    ]);
  });

  it('shows the headcount alone when the column is codes and nothing else', async () => {
    response = result([
      {
        school_id: 'a',
        queries: [query('staff', [{ stafftype: 'S0011', on_roll: 200 }, { stafftype: 'S004AD', on_roll: 28 }])],
      },
    ]);
    const card = await build('tiles');
    const tile = card.widgets.find((w): w is KpiWidget => w.type === 'kpi' && w.id === 'tile-staff');
    expect(tile?.value).toBe('228');
    expect(tile?.breakdown).toBeUndefined();
  });
});

/**
 * The tile read 0 for eleven of the thirteen tenants in the extract until
 * 2026-09-07, because it counted admission numbers in a funnel table most
 * schools never fill in. It counts the roll now -- see the `admissions` query
 * in mcp-server/src/reports/catalog.ts. Locked in here because the failure it
 * replaces was success-shaped: a zero is a perfectly plausible answer to "how
 * many admissions this year", and nothing on screen said otherwise.
 */
describe('new admissions is counted off the roll and splits by gender', () => {
  it('sums the schools and breaks the tile down boys and girls', async () => {
    response = result([
      { school_id: 'a', queries: [query('admissions', [{ gender: 'Girl', students: 162 }, { gender: 'Boy', students: 135 }])] },
      { school_id: 'b', queries: [query('admissions', [{ gender: 'Girl', students: 138 }, { gender: 'Boy', students: 135 }])] },
    ]);
    const card = await build('tiles');
    const tile = card.widgets.find((w): w is KpiWidget => w.type === 'kpi' && w.id === 'tile-admissions');
    expect(tile?.value).toBe('570');
    expect(tile?.breakdown?.map((p) => p.value)).toEqual(['270', '300']);
    /** The reader is told which of the two possible definitions this is. */
    expect(card.notes.some((n) => n.includes('new to the school this academic year'))).toBe(true);
  });

  it('rates the gauge against the roll, not against a candidate count', async () => {
    response = result([
      {
        school_id: 'a',
        queries: [
          query('roll', [{ gender: 'Girl', students: 2000 }, { gender: 'Boy', students: 2000 }]),
          query('admissions', [{ gender: 'Girl', students: 500 }, { gender: 'Boy', students: 500 }]),
        ],
      },
    ]);
    const card = await build('gauges');
    const rate = card.widgets.find((w): w is KpiWidget => w.type === 'kpi' && w.id === 'gauge-admissions-rate');
    expect(rate?.label).toBe('New share of the roll');
    expect(rate?.value).toBe('25.0%');
  });

  it('omits the rate rather than inventing a denominator when the roll did not answer', async () => {
    response = result([
      { school_id: 'a', queries: [query('admissions', [{ gender: 'Girl', students: 500 }])] },
    ]);
    const card = await build('gauges');
    expect(card.widgets.some((w) => w.id === 'gauge-admissions-rate')).toBe(false);
    const total = card.widgets.find((w): w is KpiWidget => w.type === 'kpi' && w.id === 'gauge-admissions');
    expect(total?.value).toBe('500');
  });
});

/**
 * The Dashboard card added 2026-09-07. It re-groups the SAME `admissions`
 * statement the tiles card runs, so the thing worth locking in is that it stays
 * a re-grouping: a second statement here would be a scan the Dashboard did not
 * used to pay for, on the layout the launch warms.
 */
describe('new admissions by school re-groups the tile’s own statement', () => {
  it('sums each school’s rows separately and names the school', async () => {
    response = result([
      { school_id: 'a', queries: [query('admissions', [{ gender: 'Girl', students: 162 }, { gender: 'Boy', students: 135 }])] },
      { school_id: 'b', queries: [query('admissions', [{ gender: 'Girl', students: 138 }, { gender: 'Boy', students: 135 }])] },
    ]);
    const card = await build('admissions_by_school');
    const bar = card.widgets.find((w) => w.id === 'bar-school-admissions') as { data: Record<string, unknown>[] };
    /** 162 + 135 within a school; never 297 + 273 across them. */
    expect(bar.data).toEqual([
      { school_name: 'Alpha', students: 297 },
      { school_name: 'Beta', students: 273 },
    ]);
  });

  it('costs the tile’s statement and nothing else', async () => {
    response = result([{ school_id: 'a', queries: [] }]);
    await build('admissions_by_school');
    expect(lastCall?.args['query_keys']).toEqual(['admissions']);
  });

  it('is not marked drillable — the Dashboard has no drill endpoint', async () => {
    response = result([
      { school_id: 'a', queries: [query('admissions', [{ gender: 'Boy', students: 10 }])] },
    ]);
    const card = await build('admissions_by_school');
    const bar = card.widgets.find((w) => w.id === 'bar-school-admissions');
    expect((bar as { drillable?: unknown }).drillable).toBeUndefined();
  });
});

describe('late payers join the two ledgers by enrolment', () => {
  it('ranks late-and-unpaid first and keeps the masked flag on names', async () => {
    response = result([
      {
        school_id: 'a',
        queries: [
          query('late_payers', [
            { studentname: '[masked]', enrollmentno: '1', classname: 'X', sectionname: 'A', receipts: 10, late_payments: '4' },
            { studentname: '[masked]', enrollmentno: '2', classname: 'IX', sectionname: 'B', receipts: 6, late_payments: '2' },
          ], ['studentname']),
          query('pending_students', [
            { studentname: '[masked]', enrollmentno: '2', classname: 'IX', sectionname: 'B', balance: 50000, overdue: 20000 },
            { studentname: '[masked]', enrollmentno: '3', classname: 'V', sectionname: 'A', balance: 90000, overdue: 90000 },
            { studentname: '[masked]', enrollmentno: '4', classname: 'V', sectionname: 'A', balance: 1000, overdue: 0 },
          ], ['studentname']),
        ],
      },
    ]);
    const card = await build('late_payers', ['a']);
    const table = card.widgets.find((w): w is TableWidget => w.type === 'table');
    expect(table).toBeDefined();
    expect(table?.columns.find((c) => c.field === 'student')?.masked).toBe(true);
    expect(table?.rows.map((r) => [r['enrollment'], r['status']])).toEqual([
      ['2', 'Late & unpaid'],
      ['1', 'Pays late'],
      ['3', 'Unpaid'],
    ]);
  });
});

describe('the attendance ranking states the floor it actually applied', () => {
  /**
   * The floor is the school's, not this service's: it arrives as a column
   * because a register four weeks old and a register a year old cannot share
   * one. These tests hold the card to reporting what came back rather than
   * what the catalog used to hardcode.
   */
  function ranked(school: string, floor: number, students: [string, number, number][]) {
    return {
      school_id: school,
      queries: [
        query(
          'top_attendance',
          students.map(([enrollmentno, marked, present]) => ({
            studentname: `Student ${enrollmentno}`,
            enrollmentno,
            classname: 'X',
            sectionname: 'B',
            marked_days: marked,
            present_days: String(present),
            min_marked_days: String(floor),
          })),
        ),
      ],
    };
  }

  it('names the one floor when the scope agrees on it', async () => {
    response = result([ranked('a', 6, [['1', 12, 12]])]);
    const card = await build('top_students', ['a']);
    expect(card.status).toBe('ok');
    expect(card.notes.join(' ')).toContain('at least 6 marked days');
  });

  it('names a range when two schools applied different floors', async () => {
    response = result([ranked('a', 5, [['1', 11, 11]]), ranked('b', 6, [['2', 12, 12]])]);
    const card = await build('top_students');
    expect(card.notes.join(' ')).toContain('at least 5–6 marked days');
  });

  it('ranks by rate, then by days marked, and keeps four', async () => {
    response = result([
      ranked('a', 5, [
        ['1', 12, 9],
        ['2', 6, 6],
        ['3', 12, 12],
        ['4', 10, 9],
        ['5', 11, 11],
      ]),
    ]);
    const card = await build('top_students', ['a']);
    const table = card.widgets.find((w): w is TableWidget => w.type === 'table');
    expect(table?.rows.map((r) => r['enrollment'])).toEqual(['3', '5', '2', '4']);
    expect(table?.rows[0]?.['marked']).toBe(12);
  });

  /**
   * The card that started this: every student below the floor, so the ranking
   * is empty and says so. It must stay `ok` -- an empty ranking is an answer,
   * and `blocked` would put a failure message where a true one belongs.
   */
  it('is an empty ranking, not a blocked card, when no student clears the floor', async () => {
    response = result([{ school_id: 'a', queries: [query('top_attendance', [])] }]);
    const card = await build('top_students', ['a']);
    expect(card.status).toBe('ok');
    const table = card.widgets.find((w): w is TableWidget => w.type === 'table');
    expect(table?.rows).toEqual([]);
    expect(card.notes).toEqual([]);
  });
});

describe('the fee-heads donut partitions the money', () => {
  it('nets late fee and transport out of received and adds pending', async () => {
    response = result([
      {
        school_id: 'a',
        queries: [
          query('fees', [{ payable: 1000, paid: 700, balance: 300 }]),
          query('heads', [{ received: 700, late_fee: 50, transport: 150 }]),
          query('heads_by_month', []),
          query('pending_by_month', []),
        ],
      },
    ]);
    const card = await build('fee_heads', ['a']);
    const donut = card.widgets.find((w): w is DonutWidget => w.type === 'donut');
    expect(donut?.data.map((r) => [r['head'], r['amount']])).toEqual([
      ['Fee received', 500],
      ['Late fee collected', 50],
      ['Transport fee collected', 150],
      ['Pending', 300],
    ]);
  });
});

describe('a week is named by the day it started, and both axes say what they are', () => {
  it('turns the ISO week into its Monday and titles the axes', async () => {
    response = result([
      {
        school_id: 'a',
        queries: [query('receipts_by_week', [
          { week: '2026-W14', seq: 202614, received: 420000 },
          { week: '2026-W36', seq: 202636, received: 681000 },
        ])],
      },
    ]);
    const card = await build('weekly_receipts', ['a']);
    const line = card.widgets.find((w): w is LineWidget => w.type === 'line');
    /* ISO week 14 of 2026 begins Monday 30 March; week 36 begins Monday 31 August. */
    expect(line?.data.map((r) => r['week'])).toEqual(['30 Mar', '31 Aug']);
    expect(line?.x_title).toBe('Week starting');
    expect(line?.y_title).toBe('Fee received (₹)');
    const tile = card.widgets.find((w): w is KpiWidget => w.type === 'kpi');
    expect(tile?.breakdown?.[0]).toEqual({ label: 'Week of', value: '31 Aug 2026' });
  });
});

describe('a card that cannot be built is blocked, not thrown', () => {
  it('answers blocked with a reason when nothing it needs succeeded', async () => {
    response = result([{ school_id: 'a', queries: [{ key: 'by_mode', description: 'x', sql: 'x', status: 'failed', error: { code: 'PERMISSION_DENIED', message: 'no' } }] }]);
    const card = await build('modes', ['a']);
    expect(card.status).toBe('blocked');
    expect(card.reason).toMatch(/permission/i);
    expect(card.widgets).toEqual([]);
  });
});
