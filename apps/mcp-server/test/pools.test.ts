/**
 * One pool per connection target, however many queries ask for it at once.
 *
 * The bug this guards against was found in local development on 2026-09-08, and
 * it presented as the opposite of a pooling problem: every school reported
 * "temporarily unreachable" and the Dashboard drew empty tiles under a partial-
 * totals notice. MySQL had refused new connections — `ER_CON_COUNT_ERROR`, the
 * server's 151 connection slots all taken, 131 of them held by one MCP process
 * that should have been holding three.
 *
 * The cause was a race in `getPool`, not a leak in the driver. Opening a pool is
 * asynchronous twice over (resolve the credential, then verify the grants on the
 * new pool), and the map entry used to be written only after both. A Dashboard
 * cold-start fires every card's query at once, so all of them missed the map,
 * each opened a pool of its own, and the last write won. The rest were never in
 * the map — nothing evicted them, nothing swept them, nothing closed them — and
 * their connections were held until the process died.
 *
 * `mysql2/promise` is mocked because the thing under test is the bookkeeping,
 * not the driver: a real database would prove nothing here that counting
 * `createPool` calls does not, and would make a unit test need a server.
 */

import './env-defaults.js';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedTenant } from '@sap/shared';

const createPool = vi.fn();

vi.mock('mysql2/promise', () => ({
  default: { createPool: (...args: unknown[]) => createPool(...args) },
}));

/** A pool that answers the grant check as a correctly-restricted user would. */
function fakePool(): { query: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } {
  return {
    query: vi.fn().mockResolvedValue([[{ 'Grants for analytics_ro@%': 'GRANT SELECT ON `x`.* TO `analytics_ro`@`%`' }]]),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

const TENANT: ResolvedTenant = {
  school_id: 'stmarksmb',
  org_id: 'stmarks',
  replica_host: '127.0.0.1',
  db_name: 'ai_analysis',
  schema_version: 'erp-v1',
  tenant_key: null,
};

/** The seed's own scheme — resolved from the environment, never a real ARN. */
const SECRET = 'env://SCHOOL_DB_CREDENTIALS';

let pools: typeof import('../src/db/pools.js');

beforeEach(async () => {
  createPool.mockReset();
  createPool.mockImplementation(() => fakePool());
  vi.resetModules();
  pools = await import('../src/db/pools.js');
});

afterEach(async () => {
  await pools.closeAllPools();
});

describe('getPool', () => {
  it('opens ONE pool for a burst of concurrent callers', async () => {
    const burst = await Promise.all(
      Array.from({ length: 40 }, () => pools.getPool(TENANT, SECRET)),
    );

    expect(createPool).toHaveBeenCalledTimes(1);
    expect(pools.livePoolCount()).toBe(1);
    // Every caller got the same pool, not just the same count of them.
    expect(new Set(burst).size).toBe(1);
  });

  it('shares one pool across schools on the same host, database and credential', async () => {
    // The consolidated local extract: three schools, one database (see the
    // module header). Keying by school_id would open three identical pools.
    const second: ResolvedTenant = { ...TENANT, school_id: 'stmarksj' };
    await Promise.all([pools.getPool(TENANT, SECRET), pools.getPool(second, SECRET)]);

    expect(createPool).toHaveBeenCalledTimes(1);
    expect(pools.livePoolCount()).toBe(1);
  });

  it('does not remember a failed pool, and closes what the failure opened', async () => {
    const refused = fakePool();
    // A user holding INSERT: the grant check must refuse this tenant (ADR-008).
    refused.query.mockResolvedValue([
      [{ 'Grants for app@%': 'GRANT SELECT, INSERT ON `x`.* TO `app`@`%`' }],
    ]);
    createPool.mockImplementationOnce(() => refused);

    await expect(pools.getPool(TENANT, SECRET)).rejects.toThrow();
    expect(refused.end).toHaveBeenCalledTimes(1);
    expect(pools.livePoolCount()).toBe(0);

    // The next query retries rather than inheriting the refusal.
    await pools.getPool(TENANT, SECRET);
    expect(createPool).toHaveBeenCalledTimes(2);
    expect(pools.livePoolCount()).toBe(1);
  });

  it('closes the pool it swept, including one still being opened', async () => {
    const opened = fakePool();
    createPool.mockImplementationOnce(() => opened);
    await pools.getPool(TENANT, SECRET);

    // Everything is idle beyond any window when the cutoff is in the future.
    const swept = await pools.sweepIdlePools(Date.now() + 24 * 60 * 60 * 1000);

    expect(swept).toBe(1);
    expect(opened.end).toHaveBeenCalledTimes(1);
    expect(pools.livePoolCount()).toBe(0);
  });
});
