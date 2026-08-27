/**
 * Tests for stale-while-revalidate in the result cache (cache/result-cache.ts).
 *
 * -- Why this file sets up more than the others -------------------------------
 * env-defaults.ts forces `CACHE_ENABLED=false` for the whole suite, for a good
 * reason it states there: with a real Redis running, one test's canned response
 * leaked into the next. This file is the exception that has to switch it back
 * on, because the behaviour under test IS the cache — so it stands up its own
 * in-memory Redis instead of a real one. Nothing here touches a server, and the
 * rest of the suite still runs with the cache off.
 *
 * -- What is actually worth holding -------------------------------------------
 * The freshness BOUNDARY (an entry one second before the TTL is fresh; one
 * second after is stale but still served), that a stale entry is served rather
 * than dropped, and that a burst of readers on one stale key starts exactly ONE
 * rebuild. That last one is the whole point: without de-duplication, going stale
 * would aim every concurrent reader at the same expensive query at the same
 * moment — a thundering herd pointed straight at the scan the cache exists to
 * avoid, which is worse than simply letting one reader wait.
 */

import './env-defaults.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The one setting env-defaults.ts pins; this file needs the opposite. */
process.env['CACHE_ENABLED'] = 'true';
process.env['CACHE_TTL_SECONDS'] = '600';
process.env['CACHE_SERVE_STALE_SECONDS'] = '1800';

/**
 * An in-memory stand-in for ioredis: enough surface for result-cache.ts and
 * nothing more. TTLs are not simulated — the tests move the WRITE TIME instead,
 * which is what the code actually reads, and expiry is Redis's job rather than
 * this module's.
 */
const store = new Map<string, string>();
let lastTtl = 0;

vi.mock('ioredis', () => {
  class FakeRedis {
    private handlers = new Map<string, () => void>();
    on(event: string, handler: () => void): this {
      this.handlers.set(event, handler);
      return this;
    }
    async connect(): Promise<void> {
      // The real client emits 'ready' on a successful connect, and that is
      // where result-cache.ts flips `healthy`. Without it every read reports a
      // miss and none of the behaviour below is reachable.
      this.handlers.get('ready')?.();
    }
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    }
    async set(key: string, value: string, _ex: string, ttl: number): Promise<'OK'> {
      store.set(key, value);
      lastTtl = ttl;
      return 'OK';
    }
    async quit(): Promise<'OK'> {
      return 'OK';
    }
  }
  return { default: FakeRedis };
});

const { cacheGet, cacheSet, refreshInBackground, refreshesInFlight } = await import(
  '../src/cache/result-cache.js'
);

/**
 * `healthy` only flips on the client's 'ready' event, which the stub above does
 * not emit. Rather than reach into module internals, each test writes the
 * envelope into the store directly and reads it back through `cacheGet` — the
 * read path is what is under test, and it is exercised in full.
 */
function seed(key: string, value: unknown, writtenSecondsAgo: number): void {
  store.set(key, JSON.stringify({ t: Math.floor(Date.now() / 1000) - writtenSecondsAgo, v: value }));
}

beforeEach(() => {
  store.clear();
  lastTtl = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an entry knows how old it is', () => {
  it('is fresh just inside the TTL', async () => {
    seed('k', { n: 1 }, 599);
    const hit = await cacheGet<{ n: number }>('k');
    expect(hit?.stale).toBe(false);
    expect(hit?.value).toEqual({ n: 1 });
  });

  it('is stale just outside the TTL -- and is still SERVED', async () => {
    seed('k', { n: 1 }, 601);
    const hit = await cacheGet<{ n: number }>('k');
    expect(hit?.stale).toBe(true);
    // The point of the whole mechanism: stale is not a miss.
    expect(hit?.value).toEqual({ n: 1 });
  });

  it('treats an entry with no write time as stale rather than fresh', async () => {
    // A value written by an older build. Fresh-by-default would pin it for a
    // full TTL; stale rebuilds it once and moves on.
    store.set('k', JSON.stringify({ v: { n: 1 } }));
    const hit = await cacheGet<{ n: number }>('k');
    expect(hit?.stale).toBe(true);
    expect(hit?.value).toEqual({ n: 1 });
  });

  it('reports a miss for a key that is not there', async () => {
    expect(await cacheGet('absent')).toBeNull();
  });

  it('survives a corrupted entry as a miss, not a throw', async () => {
    store.set('k', 'not json');
    expect(await cacheGet('k')).toBeNull();
  });
});

describe('a written entry outlives its freshness', () => {
  it('sets a Redis TTL of freshness PLUS the stale window', async () => {
    await cacheSet('k', { n: 1 }, 600);
    // Or the entry would expire the moment it went stale and could never be
    // served while it was rebuilt -- the mechanism would be dead code.
    expect(lastTtl).toBe(600 + 1800);
  });

  it('stamps the write time, so the next read can date it', async () => {
    await cacheSet('k', { n: 1 }, 600);
    const raw = JSON.parse(store.get('k') ?? '{}') as { t: number; v: unknown };
    expect(typeof raw.t).toBe('number');
    expect(raw.v).toEqual({ n: 1 });
  });
});

describe('a stale key starts exactly one rebuild', () => {
  it('[MANDATORY] de-duplicates a burst of readers into a single refresh', async () => {
    let started = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });

    const rebuild = async (): Promise<void> => {
      started += 1;
      await blocked;
    };

    // Ten concurrent readers all find the same key stale.
    for (let i = 0; i < 10; i += 1) refreshInBackground('hot-key', rebuild);

    expect(started).toBe(1);
    expect(refreshesInFlight()).toBe(1);

    release();
    await blocked;
    await Promise.resolve();
    await Promise.resolve();
    expect(refreshesInFlight()).toBe(0);
  });

  it('allows a new refresh once the previous one finished', async () => {
    let started = 0;
    const rebuild = async (): Promise<void> => { started += 1; };

    refreshInBackground('k', rebuild);
    await vi.waitFor(() => { expect(refreshesInFlight()).toBe(0); });

    refreshInBackground('k', rebuild);
    expect(started).toBe(2);
  });

  it('different keys refresh independently', async () => {
    // Released at the end rather than left hanging: an in-flight refresh that
    // never settles would still be counted by the NEXT test in this file.
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const rebuild = async (): Promise<void> => { await blocked; };

    refreshInBackground('a', rebuild);
    refreshInBackground('b', rebuild);
    expect(refreshesInFlight()).toBe(2);

    release();
    await vi.waitFor(() => { expect(refreshesInFlight()).toBe(0); });
  });

  it('a failed rebuild is logged and released, never thrown at the reader', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The reader has ALREADY been served a stale-but-valid answer, so a failed
    // refresh is a missed improvement -- not an error anyone is waiting on.
    refreshInBackground('k', async () => { throw new Error('replica down'); });

    await vi.waitFor(() => { expect(refreshesInFlight()).toBe(0); });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('replica down'));
  });
});
