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
import type { KpiWidget, TableWidget, DonutWidget } from '@sap/chart-spec';
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

describe('a card that cannot be built is blocked, not thrown', () => {
  it('answers blocked with a reason when nothing it needs succeeded', async () => {
    response = result([{ school_id: 'a', queries: [{ key: 'by_mode', description: 'x', sql: 'x', status: 'failed', error: { code: 'PERMISSION_DENIED', message: 'no' } }] }]);
    const card = await build('modes', ['a']);
    expect(card.status).toBe('blocked');
    expect(card.reason).toMatch(/permission/i);
    expect(card.widgets).toEqual([]);
  });
});
