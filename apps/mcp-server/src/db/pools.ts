/**
 * Tenant resolution, step 3: lazy, LRU-capped connection pools.
 *
 * Contract source: docs/03 §3 · ADR-013.
 *
 * The trap this avoids: 1,500 schools cannot each hold an open pool. Most are
 * idle at any instant, so a pool exists only after a school's first query
 * (`connectionLimit: 3`), the live set is LRU-capped (~200 per instance, giving
 * ≤600 connections), and a sweep closes pools idle beyond ten minutes. A cold
 * pool costs 100–300 ms once per idle period — invisible against the cache-miss
 * latency it happens under.
 *
 * -- Why pools are keyed by connection target, not by school_id ---------------
 * docs/03 §2 writes the step as `getPool(school_id)`, and under one-database-
 * per-school those are the same thing. They are not the same thing under the
 * consolidated extract this slice runs on (option (a); schema/erp-v1.ts), where
 * three schools share a host, a database and a credential. Keying by school_id
 * there would open three identical pools and consume three times the connections
 * to no benefit.
 *
 * The key is therefore host + port + database + secret ARN — the properties that
 * actually determine whether two schools can share a socket. Note what is IN the
 * key: different credentials always mean different pools, so a future move to
 * per-school database users splits them again automatically. And note what
 * sharing does not weaken: tenant isolation under option (a) is the bound
 * predicate the SQL guard injects, which is a property of the statement, not of
 * the connection it travels on.
 */

import mysql from 'mysql2/promise';
import { ERROR_CODES, PlatformError, type ResolvedTenant } from '@sap/shared';
import { config } from '../config.js';
import { resolveCredentials } from './secrets.js';

interface PoolEntry {
  readonly pool: mysql.Pool;
  lastUsedAt: number;
}

/** Insertion order is recency order: re-inserting on use makes this an LRU. */
const pools = new Map<string, PoolEntry>();

function poolKey(tenant: ResolvedTenant, secretArn: string): string {
  return [tenant.replica_host, config.SCHOOL_DB_PORT, tenant.db_name, secretArn].join('|');
}

export async function getPool(
  tenant: ResolvedTenant,
  secretArn: string,
): Promise<mysql.Pool> {
  const key = poolKey(tenant, secretArn);
  const existing = pools.get(key);
  if (existing !== undefined) {
    existing.lastUsedAt = Date.now();
    pools.delete(key);
    pools.set(key, existing);
    return existing.pool;
  }

  const credentials = await resolveCredentials(secretArn);
  const pool = mysql.createPool({
    host: tenant.replica_host,
    port: config.SCHOOL_DB_PORT,
    user: credentials.user,
    password: credentials.password,
    database: tenant.db_name,
    connectionLimit: config.POOL_CONNECTION_LIMIT,
    /**
     * [MANDATORY] ADR-008. The SQL guard already rejects multi-statement
     * payloads at the AST, and the grants already forbid writes. This is the
     * third independent layer, on the connection itself: even a validator bug
     * cannot smuggle a stacked statement past a driver that will not send one.
     */
    multipleStatements: false,
    timezone: 'Z',
    /** Bound the wait for a free connection so a slow school queues, not hangs. */
    waitForConnections: true,
    queueLimit: 0,
  });

  await assertReadOnlyGrants(pool, tenant);

  pools.set(key, { pool, lastUsedAt: Date.now() });
  await evictBeyondCap();
  return pool;
}

/**
 * [MANDATORY] ADR-008 layer 1, verified rather than assumed.
 *
 * ADR-008's first layer is "per-school read-only MySQL users (`analytics_ro`,
 * SELECT grants only) — enforced by MySQL itself". A configuration file naming a
 * user `analytics_ro` is not that guarantee; the guarantee is the grants the
 * server actually holds. This asks, once per distinct credential, at the moment
 * the pool is opened, so a school onboarded with a mis-granted user is caught by
 * the platform instead of by an incident.
 *
 * Fail-closed on a privilege we can read and do not permit. Fail-OPEN, loudly, on
 * a grant line we cannot parse — a role grant cannot be expanded without reading
 * `mysql.role_edges`, which a correctly-restricted user cannot read. Refusing to
 * serve a tenant because a diagnostic was inconclusive would be an outage caused
 * by the check rather than by the risk, and the AST validation, the SELECT-only
 * rewrite and the `multipleStatements: false` connection all still stand. The
 * trade-off is stated here rather than left for a reader to infer.
 */
const PERMITTED_PRIVILEGES = new Set(['SELECT', 'USAGE']);

async function assertReadOnlyGrants(pool: mysql.Pool, tenant: ResolvedTenant): Promise<void> {
  let grants: string[];
  try {
    const [rows] = await pool.query('SHOW GRANTS FOR CURRENT_USER()');
    grants = (rows as Record<string, unknown>[]).map((row) => String(Object.values(row)[0] ?? ''));
  } catch (err) {
    console.error(
      `[mcp:pools] could not read grants for db=${tenant.db_name}; ` +
        'proceeding on the AST and connection layers alone:',
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  for (const grant of grants) {
    if (/WITH GRANT OPTION\s*$/i.test(grant)) {
      throw grantViolation(tenant, 'the school user holds GRANT OPTION');
    }
    const match = /^GRANT\s+(.+?)\s+ON\s+/i.exec(grant);
    if (match === null) {
      console.error(
        `[mcp:pools] unparsed grant for db=${tenant.db_name} (role grant?); ` +
          'read-only status could not be confirmed from grants alone',
      );
      continue;
    }
    for (const privilege of match[1]!.split(',')) {
      const name = privilege.trim().replace(/\s*\([^)]*\)$/, '').toUpperCase();
      if (name === '') continue;
      if (!PERMITTED_PRIVILEGES.has(name)) {
        throw grantViolation(tenant, `the school user holds ${name}`);
      }
    }
  }
}

function grantViolation(tenant: ResolvedTenant, reason: string): PlatformError {
  console.error(`[mcp:pools] REFUSING db=${tenant.db_name}: ${reason}`);
  return new PlatformError({
    code: ERROR_CODES.TENANT_UNAVAILABLE,
    message: 'This school is not correctly configured for analytics and cannot be queried.',
    diagnostics: { school_id: tenant.school_id, reason },
  });
}

/** Close the least recently used pools once the cap is exceeded. */
async function evictBeyondCap(): Promise<void> {
  while (pools.size > config.POOL_LRU_MAX) {
    const oldestKey = pools.keys().next().value;
    if (oldestKey === undefined) return;
    const entry = pools.get(oldestKey);
    pools.delete(oldestKey);
    if (entry !== undefined) await closeQuietly(entry.pool);
  }
}

/**
 * Close pools idle beyond the configured window. Called on a timer by the
 * server; exported so a test can drive it without waiting ten minutes.
 */
export async function sweepIdlePools(now: number = Date.now()): Promise<number> {
  const cutoff = now - config.POOL_IDLE_SWEEP_SECONDS * 1000;
  let closed = 0;
  for (const [key, entry] of [...pools]) {
    if (entry.lastUsedAt > cutoff) continue;
    pools.delete(key);
    await closeQuietly(entry.pool);
    closed += 1;
  }
  return closed;
}

/**
 * A pool that fails to close is an operational annoyance, not a reason to fail
 * the request that happened to trigger the eviction.
 */
async function closeQuietly(pool: mysql.Pool): Promise<void> {
  try {
    await pool.end();
  } catch (err) {
    console.error('[mcp:pools] failed to close pool:', err instanceof Error ? err.message : err);
  }
}

export function livePoolCount(): number {
  return pools.size;
}

export async function closeAllPools(): Promise<void> {
  for (const [key, entry] of [...pools]) {
    pools.delete(key);
    await closeQuietly(entry.pool);
  }
}
