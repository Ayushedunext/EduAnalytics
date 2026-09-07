/**
 * Tests for the Dashboard's statement cache (services/overview-queries.ts) and
 * the serve-stale contract above it (services/overview.ts).
 *
 * These are cost tests, and they are written as cost tests on purpose: what they
 * assert is which statements reach the data plane, not what any card says. The
 * behaviour they protect is invisible from a screenshot and was measured in tens
 * of seconds:
 *
 *   1. Two cards that share a statement run it ONCE, even when they are
 *      requested in the same tick — which is how a layout requests them.
 *   2. A statement already answered is not asked again, so a layout switch pays
 *      only for what is genuinely new.
 *   3. A stale card's background rebuild actually rebuilds. It used to re-enter
 *      the cached path, read the entry it was meant to replace, and return it —
 *      so nothing was ever refreshed and the entry aged out into a cold read.
 *   4. A statement that fails everywhere leaves the card standing and is named,
 *      and does not report the SCHOOLS as unreachable (ADR-011).
 */

import './env-defaults.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface QueryResult {
  key: string;
  description: string;
  sql: string;
  status: 'ok' | 'failed';
  rows?: Record<string, unknown>[];
  error?: { code: string; message: string };
}

/** Query keys the MCP mock was asked for, one entry per `run_predefined` call. */
let calls: string[][] = [];
/** Keys the mock should answer with `status: 'failed'`. */
let failing = new Set<string>();

vi.mock('../src/mcp/client.js', () => ({
  withMcp: async (
    _session: unknown,
    _correlationId: string,
    schoolIds: readonly string[],
    fn: (mcp: { call: (tool: string, args: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>,
  ) =>
    fn({
      call: (_tool: string, args: Record<string, unknown>) => {
        const keys = args['query_keys'] as string[];
        calls.push([...keys]);
        return Promise.resolve({
          report_id: 'dashboard-overview',
          title: 'Dashboard',
          source: 'tables',
          params: args['params'],
          as_of: '2026-09-06T10:00:00.000Z',
          schools: schoolIds.map((id) => ({
            school_id: id,
            status: 'ok',
            queries: keys.map((key): QueryResult =>
              failing.has(key)
                ? {
                    key,
                    description: `${key} description`,
                    sql: `SELECT 1 AS ${key}`,
                    status: 'failed',
                    error: { code: 'QUERY_TIMEOUT', message: 'took too long' },
                  }
                : {
                    key,
                    description: `${key} description`,
                    sql: `SELECT 1 AS ${key}`,
                    status: 'ok',
                    rows: rowsFor(key),
                  },
            ),
          })),
        });
      },
    }),
}));

vi.mock('../src/db/registry.js', () => ({
  schoolNames: (ids: readonly string[]) =>
    Promise.resolve(ids.map((id) => ({ school_id: id, school_name: id.toUpperCase() }))),
}));

/** A cache that behaves like the real one: entries exist, and they go stale. */
const store = new Map<string, unknown>();
let stale = new Set<string>();
let refreshes: { key: string; rebuild: () => Promise<unknown> }[] = [];

vi.mock('../src/cache/result-cache.js', () => ({
  cacheKey: (parts: unknown) => JSON.stringify(parts),
  cacheGet: (key: string) =>
    Promise.resolve(
      store.has(key) ? { value: store.get(key), ageSeconds: 1, stale: stale.has(key) } : null,
    ),
  cacheSet: (key: string, value: unknown) => {
    store.set(key, value);
    return Promise.resolve();
  },
  refreshInBackground: (key: string, rebuild: () => Promise<unknown>) => {
    refreshes.push({ key, rebuild });
  },
}));

const { buildOverviewSlot } = await import('../src/services/overview.js');

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

/**
 * Enough of a row for each statement that the builders under test produce at
 * least one widget — a card with no widgets is `blocked` by design, which would
 * make every assertion below pass for the wrong reason.
 */
function rowsFor(key: string): Record<string, unknown>[] {
  switch (key) {
    case 'fees':
      return [{ payable: 1000, paid: 800, balance: 200 }];
    case 'att_by_month':
      return [{ ym: '2026-08', marked: 100, present: 90 }];
    case 'staff_by_month':
      return [{ ym: '2026-08', present_days: 40 }];
    default:
      return [{ n: 1 }];
  }
}

function build(slot: 'rings' | 'top_schools' | 'monthly', schoolIds: string[] = ['a', 'b']) {
  return buildOverviewSlot({
    session: SESSION,
    schoolIds,
    slot,
    academicYear: '2026-27',
    asOfDate: '2026-09-06',
    correlationId: 'corr-1',
  });
}

/** Every query key the data plane was asked for, across all calls. */
function requested(): string[] {
  return calls.flat();
}

beforeEach(() => {
  calls = [];
  failing = new Set();
  store.clear();
  stale = new Set();
  refreshes = [];
});

describe('a statement shared by two cards runs once', () => {
  it('two cards requested together ask for `fees` once between them', async () => {
    /**
     * `rings` and `top_schools` both draw from `fees`. Requested in the same
     * tick, as a layout requests them — the second must join the first's fetch
     * rather than starting its own, and the cache cannot help because the first
     * one's lookup has not returned yet.
     */
    const [rings, top] = await Promise.all([build('rings'), build('top_schools')]);

    expect(rings.status).toBe('ok');
    expect(top.status).toBe('ok');
    expect(requested().filter((key) => key === 'fees')).toHaveLength(1);
  });

  it('a card asked for after another has answered runs no statement at all', async () => {
    await build('rings');
    const before = calls.length;

    await build('top_schools');

    // `fees` was cached by the rings build, and `top_schools` needs nothing else.
    expect(calls.length).toBe(before);
  });

  it('a card sharing only SOME of its statements pays only for the rest', async () => {
    await build('rings');
    calls = [];

    /**
     * The card cache cannot answer this — no `monthly` card was ever built — so
     * this is the statement cache doing the work a layout switch depends on.
     */
    await build('monthly');
    expect(requested()).toEqual(['heads_by_month']);
  });
});

describe('one build per key, however many readers are waiting', () => {
  it('the same card asked for twice at once is built once', async () => {
    const [first, second] = await Promise.all([build('rings'), build('rings')]);

    expect(first.status).toBe('ok');
    expect(second).toEqual(first);
    /**
     * This is what makes the launch warm a head start rather than a competitor:
     * the reader's own request joins the build already running for their scope
     * instead of racing it for the same three replica connections.
     */
    expect(calls).toHaveLength(1);
  });
});

describe('a stale card is rebuilt behind the response', () => {
  it('the registered rebuild reaches the data plane instead of returning the stale value', async () => {
    await build('rings');
    const cardKey = [...store.keys()].find((key) => key.includes('overview:rings'));
    expect(cardKey).toBeDefined();

    // Everything now stale: the card, and the statements underneath it.
    stale = new Set(store.keys());
    calls = [];
    refreshes = [];

    const served = await build('rings');
    expect(served.status).toBe('ok');
    // Served from cache — the reader waited for nothing.
    expect(calls).toHaveLength(0);
    expect(refreshes.map((r) => r.key)).toContain(cardKey);

    // ...and the rebuild that was registered must actually rebuild.
    const refresh = refreshes.find((r) => r.key === cardKey);
    await refresh?.rebuild();
    expect(requested()).toEqual(expect.arrayContaining(['fees']));
  });
});

describe('a statement that fails does not take the card or the schools with it', () => {
  it('the card still draws, names the failure, and reports no unreachable school', async () => {
    failing = new Set(['staff_by_month']);

    const rings = await build('rings');

    expect(rings.status).toBe('ok');
    expect(rings.notes.join(' ')).toContain('staff_by_month');
    /**
     * ADR-011: the statement failed, the SCHOOLS answered. Reporting them as
     * degraded would send someone chasing an outage that is not happening.
     */
    expect(rings.degraded_schools).toEqual([]);
  });

  it('the statements that succeeded beside it are still cached', async () => {
    failing = new Set(['staff_by_month']);
    await build('rings');
    calls = [];

    failing = new Set();
    await build('rings');

    /**
     * Only the failed statement is retried. Before the statement cache existed,
     * a card with any failure in it was not cached at all, so the heaviest cards
     * — the ones whose slowest statement is the one that times out — paid their
     * full cost on every single request.
     */
    expect(requested()).toEqual(['staff_by_month']);
  });
});
