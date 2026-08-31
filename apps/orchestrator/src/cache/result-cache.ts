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
 *
 * -- Why entries carry their age, and may be served after expiry --------------
 * A plain TTL makes exactly one reader per period pay the full cost. With Home's
 * ten-minute TTL that is a user every ten minutes waiting out a full scan of the
 * fee tables while everyone behind them is served in milliseconds — the slowest
 * experience on the product, handed to whoever happens to arrive first.
 *
 * So an entry has two lifetimes. It is FRESH for `CACHE_TTL_SECONDS` and is
 * simply returned. It is then STALE for a further `CACHE_SERVE_STALE_SECONDS`,
 * during which it is still returned immediately and a rebuild is started behind
 * the response (`refreshInBackground`). Only past both is it gone, and only then
 * does a reader wait.
 *
 * The refresh runs on the REQUESTING SESSION's own scope and permission class,
 * because it is a closure the caller supplies — never a synthetic background
 * identity. That is not a convenience: "scope is law" (Invariant 2) means the
 * school set traces back to a signed launch token, and a warmer holding a
 * fabricated session would be a second, unsigned source of scope. A refresh can
 * therefore only ever rewrite the exact key the caller was already entitled to
 * read, which is also why it cannot cross the permission-class boundary the key
 * itself encodes.
 *
 * The trade is staleness, and it is bounded and stated: an entry served stale is
 * at most `CACHE_TTL_SECONDS + CACHE_SERVE_STALE_SECONDS` old, it still carries
 * its own `as_of` (the reports label it on screen), and the very next reader
 * gets the rebuilt copy.
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
 *
 * v2 -> v3 (2026-08-27): Fee Collection gained a widget (`bar-school`, the
 * drill-down entry point). Nothing about the KEY changed — same report, same
 * filters, same school set — so a warm cache kept answering with the
 * pre-change dashboard, correctly by its own rules and wrongly by any other
 * measure, for the whole TTL. That is what this version digit is for: adding a
 * widget IS a change to the shape of a cached value, even though no type
 * changed and nothing failed to deserialise.
 *
 * v3 -> v4 (2026-08-29): the same again for Fee Defaulters
 * (`bar-school-defaulters`). Twice in three days is the useful signal here —
 * ANY change to what a builder emits needs this digit, not only a change to a
 * type. The rule to carry forward: if a reader would see something different,
 * bump it.
 *
 * v4 -> v5 (2026-08-29): Fee Defaulters' aging chart gained `tone: 'warning'`,
 * so it draws amber instead of teal. No widget was added and no number moved —
 * which is exactly why this one is worth recording. The rule is about what a
 * READER sees, not about whether the shape changed enough to break anything.
 *
 * v5 -> v6 (2026-08-29): the defaulters quarter AND class drills now keep
 * categories that are not due yet, as zero bars with a note, instead of
 * dropping them. Drill levels are cached under their own keys, so this is the
 * first bump about a DRILL entry rather than a dashboard one — same rule,
 * wider reach.
 *
 * The digit tracks what has SHIPPED, not each step of getting there. Iterating
 * on a branch invalidates local entries by deleting them; bumping per edit
 * would burn a version on work nobody has seen. (Worth saying because this
 * change was written in two passes and the second one was served a stale drill
 * from the first — the cache is quicker to catch you out than it looks.)
 *
 * v6 -> v7 (2026-08-31): Enrollment and Attendance gained drill entry points of
 * their own. Four bumps in five days is not churn, it is the shape of this
 * phase: every dashboard that grows a drill grows a widget, and every widget is
 * a change a reader sees.
 *
 * v7 -> v8 (2026-08-31): the Dashboard revamp. The summary strip was renamed,
 * reordered and given a breakdown under each figure, the fee card changed what
 * its headline MEANS (the year's demand, not the arrears) along with its widget
 * id, and `HomeSummary` grew a `grid` field naming which charts the overview
 * draws and in what order. Every one of those is a reader-visible change and
 * any one alone would have earned the bump.
 *
 * ONE digit for the whole revamp, not one per slice. The header above is
 * explicit that this tracks what has SHIPPED rather than each step of getting
 * there, and the revamp lands as a single PR — so the later slices extend this
 * entry and local entries are deleted while iterating. The Dashboard's PREVIEW
 * cards needed no help either way: their key already carries the query keys
 * (`report:<id>:q=<keys>`, services/dashboards.ts), so pointing a card at its
 * drill-entry statement instead of its lead one lands on a different key by
 * construction.
 *
 * Extended again for the drill paths: Attendance's middle level moved from
 * month to academic quarter. A drill key is
 * `drill:<report>:<widget>:L<level>:<context>` and carries no query name, so a
 * warm level-2 entry from the month version would have been served verbatim
 * under the quarter version -- same report, same widget, same level, same
 * `school=<id>` context. Exactly the case this digit exists for.
 *
 * And once more for Staff Overview and Transport, which each gained a
 * drill-entry widget. Adding a widget to a dashboard is the change that first
 * earned this digit at v2 -> v3, and it is the same change here: the report id,
 * the filters and the school set are all unchanged, so nothing else in the key
 * moves and a warm entry would answer with the pre-change dashboard.
 *
 * And for Staff Attendance joining the grid. The DASHBOARD itself needed no
 * help -- a new report id is a new `kind` and therefore new keys by
 * construction -- but `HomeSummary` carries the grid's membership and order, so
 * the SUMMARY's own cached value changed shape again. The same held when Fee by
 * Student joined it.
 *
 * -- This one was caught by the cache, not by a test -------------------------
 * Worth recording, because the failure was invisible from inside the code. With
 * the new build shipped and the orchestrator hot-reloaded, the screen still drew
 * the OLD four tiles — right down to a "Fees outstanding" label that no longer
 * existed anywhere in the source. `buildHomeSummary` returned a warm v7 entry
 * before it ever reached a builder, so nothing ran and nothing failed. The
 * header above already said this ("a warm cache kept answering with the
 * pre-change dashboard, correctly by its own rules and wrongly by any other
 * measure") and it happened anyway, which is the argument for the digit rather
 * than for remembering to clear Redis: a deploy cannot be asked to remember.
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
  /**
   * v10 (2026-09-01): the served catalog. `/api/home`'s cached value CARRIES the
   * dashboard list (`HomeSummary.dashboards`), which the sidebar renders
   * directly — so `servedDashboards` withholding the unopenable cards changes
   * nothing for a school with a warm key until it expires, and the menu keeps
   * offering four "soon" rows and a ⛔ that the running build no longer serves.
   * The standing rule again: a reader would see something different, so the
   * digit moves. This is the same class of failure as v9's — the entry
   * deserialises perfectly and the screen is simply wrong.
   *
   * v9 (2026-08-31): Comparative Analysis. Two things changed under warm keys:
   * the report's own widget ids and query key were renamed mid-build
   * (`bar-installment`/`demand_by_installment` → `bar-period`/`demand_by_period`)
   * as the comparison axis moved off the school's free-text instalment name, and
   * a warm entry from before that rename deserialises perfectly and draws the old
   * chart under the new title. Nothing fails; the screen is just wrong, which is
   * exactly the failure this digit exists for.
   */
  return `sap:v10:${parts.kind}:${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;
}

/**
 * The stored shape: the value plus the second it was written.
 *
 * The timestamp is what makes staleness answerable without a second round trip
 * — Redis can say an entry exists, not how long it has left, and `TTL` would be
 * a second command per read on the hottest path in the product.
 */
interface Envelope<T> {
  /** Epoch SECONDS. Seconds, not millis: the granularity that is actually used. */
  readonly t: number;
  readonly v: T;
}

export interface CacheEntry<T> {
  readonly value: T;
  /** How old the entry is. Compare against `CACHE_TTL_SECONDS` for freshness. */
  readonly ageSeconds: number;
  /** `true` once past `CACHE_TTL_SECONDS` — serve it, then rebuild behind. */
  readonly stale: boolean;
}

export async function cacheGet<T>(key: string): Promise<CacheEntry<T> | null> {
  if (!config.CACHE_ENABLED) return null;
  await connect();
  if (!healthy) return null;
  try {
    const raw = await client.get(key);
    if (raw === null) return null;
    const envelope = JSON.parse(raw) as Envelope<T>;
    /**
     * An entry written by an older build has no `t`. Treating that as age zero
     * would pin it fresh for a full TTL; treating it as stale rebuilds it once
     * and moves on. The version prefix already makes this unreachable — it is
     * here so that a future prefix bump that someone forgets fails safe.
     */
    if (typeof envelope.t !== 'number') return { value: envelope.v, ageSeconds: Infinity, stale: true };
    const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - envelope.t);
    return { value: envelope.v, ageSeconds, stale: ageSeconds >= config.CACHE_TTL_SECONDS };
  } catch {
    return null;
  }
}

/**
 * Write an entry, fresh from now.
 *
 * The Redis TTL is the FULL lifetime — freshness plus the stale-serving window
 * — because an entry has to outlive its freshness to be servable while it is
 * rebuilt. Freshness is decided on read, from `t`, not by expiry.
 */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (!config.CACHE_ENABLED) return;
  await connect();
  if (!healthy) return;
  const envelope: Envelope<unknown> = { t: Math.floor(Date.now() / 1000), v: value };
  try {
    await client.set(key, JSON.stringify(envelope), 'EX', ttlSeconds + config.CACHE_SERVE_STALE_SECONDS);
  } catch {
    // A failed write is a future miss, which is the same thing as not caching.
  }
}

/**
 * In-flight refreshes, so a burst of readers on one stale key starts ONE
 * rebuild.
 *
 * Without this, the moment an entry goes stale every concurrent reader would
 * launch its own rebuild of the same key — a thundering herd aimed at exactly
 * the expensive query the cache exists to avoid, and worse than simply letting
 * one reader wait. Process-local is the right scope: it is a de-duplication
 * hint, not a lock, and a second orchestrator instance starting one more
 * rebuild of the same key is harmless (they write the same value). A
 * cross-process lock would be a correctness claim this does not need to make.
 */
const refreshing = new Set<string>();

/**
 * Rebuild a stale entry behind the response.
 *
 * Returns immediately; `rebuild` is expected to write the key itself (every
 * caller already ends in `cacheSet`). Deliberately swallows failures: the
 * reader has ALREADY been served a stale-but-valid answer, so a failed refresh
 * is a missed improvement, never an error anyone is waiting on. It is logged,
 * because a refresh that always fails means the key is served stale until it
 * expires and someone should be able to see that in the logs.
 */
export function refreshInBackground(key: string, rebuild: () => Promise<unknown>): void {
  if (!config.CACHE_ENABLED) return;
  if (refreshing.has(key)) return;
  refreshing.add(key);
  void rebuild()
    .catch((err: unknown) => {
      console.warn(
        `[orchestrator] background refresh failed for ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    })
    .finally(() => {
      refreshing.delete(key);
    });
}

/** For tests: how many rebuilds are in flight. */
export function refreshesInFlight(): number {
  return refreshing.size;
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
