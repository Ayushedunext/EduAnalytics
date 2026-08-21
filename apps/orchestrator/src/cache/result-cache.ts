/**
 * Tier ① of the three-tier serving order: the Redis result cache.
 *
 * Contract source: docs/09 §4 ("① Redis result cache — key = report + level +
 * drill-context + filters") · docs/06 §2 ("Redis-cached per school-set +
 * filters, TTL 5–15 min") · docs/09 §3 (cache-hit budget 50–200 ms against
 * 0.5–2 s for a replica read) · ADR-028.
 *
 * -- Why this exists, in one number -------------------------------------------
 * Fee Defaulters across three schools takes ~19 s against the real extract: five
 * queries per school, each a full scan of a 1.39M-row table with no usable index
 * (see mcp-server/src/reports/catalog.ts). The index is a change to a SCHOOL
 * database, which this platform may never make (ADR-008/023), so the cache is
 * the only lever on this side of the boundary. It does not make the first read
 * fast; it stops the next fifty readers paying for it again.
 *
 * -- [MANDATORY] the permission class is part of every key --------------------
 * docs/08 §5 states this outright: "Masking is role-dependent (§4.4, doc 04 rail
 * 6) and drill leaves are rights-gated; a key without a permission component
 * would let a privileged user's cache entry be served to a restricted one. A
 * masking rule enforced at query time and discarded at cache time is not
 * enforced." An accountant must never be handed the Principal's unmasked rows
 * out of a cache, and the only structural defence is that they cannot name the
 * same key. `permissionClass` is computed from role + perms in @sap/shared and
 * is already carried on every session.
 *
 * -- Redis being down is a slow day, not an outage ----------------------------
 * Every operation here swallows its own failure and reports a miss. A cache that
 * takes the product down when it is unavailable is worse than no cache: the
 * replica path is complete on its own, and it is what runs today. Failures are
 * logged once per state change rather than per request, so a dead Redis does not
 * also produce a flood.
 */

import Redis from 'ioredis';
import { createHash } from 'node:crypto';
import { config } from '../config.js';

/**
 * `lazyConnect` so importing this module never opens a socket: the orchestrator
 * must boot, and tests must run, with no Redis anywhere. The first get() starts
 * the connection.
 */
const client = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  /**
   * One attempt, then fail the operation. The caller's fallback is a replica
   * read that will succeed; queuing commands or retrying inside the cache would
   * turn "Redis is slow" into "every dashboard is slow", which is the opposite
   * of the point.
   */
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  connectTimeout: 1_000,
  retryStrategy: (times) => Math.min(times * 500, 5_000),
});

let healthy = false;
let started = false;

/** Logged on transitions only — a dead Redis must not also be a log flood. */
client.on('ready', () => {
  if (!healthy) console.log('[orchestrator] result cache connected');
  healthy = true;
});
client.on('error', (err: Error) => {
  if (healthy || !started) {
    console.warn(`[orchestrator] result cache unavailable, serving from replica: ${err.message}`);
  }
  healthy = false;
  started = true;
});

async function connect(): Promise<void> {
  if (started) return;
  started = true;
  try {
    await client.connect();
  } catch {
    // Already reported by the error handler. The caller gets a miss.
  }
}

/**
 * The cache key.
 *
 * Hashed, not concatenated: a school set plus a filter map is unbounded in
 * length and would otherwise produce keys that are awkward to read and easy to
 * collide by accident (a school named `a:b` versus two schools `a` and `b`).
 * JSON with sorted keys makes the input canonical, so the same request always
 * hashes the same way regardless of property order.
 *
 * The prefix carries a VERSION. When the shape of a cached value changes, that
 * digit changes and every old entry becomes unreachable rather than being
 * deserialised into the new code's expectations.
 */
export function cacheKey(parts: {
  kind: string;
  schoolIds: readonly string[];
  /** [MANDATORY] docs/08 §5. Never omit. */
  permissionClass: string;
  filters: Record<string, string | number | null>;
}): string {
  const canonical = JSON.stringify({
    kind: parts.kind,
    schools: [...parts.schoolIds].sort(),
    perms: parts.permissionClass,
    filters: Object.fromEntries(Object.entries(parts.filters).sort(([a], [b]) => a.localeCompare(b))),
  });
  return `sap:v1:${parts.kind}:${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!config.CACHE_ENABLED) return null;
  await connect();
  if (!healthy) return null;
  try {
    const raw = await client.get(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (!config.CACHE_ENABLED) return;
  await connect();
  if (!healthy) return;
  try {
    await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {
    // A failed write is a future miss, which is the same thing as not caching.
  }
}

/** For tests and for a future admin "refresh now" action. */
export async function cacheDrop(prefix: string): Promise<number> {
  await connect();
  if (!healthy) return 0;
  try {
    const keys = await client.keys(`${prefix}*`);
    if (keys.length === 0) return 0;
    return await client.del(...keys);
  } catch {
    return 0;
  }
}

export async function closeCache(): Promise<void> {
  if (!started) return;
  await client.quit().catch(() => undefined);
}
