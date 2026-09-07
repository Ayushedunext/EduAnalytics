/**
 * The Dashboard's statements, cached and de-duplicated one QUERY at a time.
 *
 * Contract source: docs/09 §4 (tier ① is the result cache) · ADR-028 (the key
 * carries the caller's permission class) · ADR-011 (a statement that fails is
 * reported, never absorbed) · Invariant 2 (scope comes from the session).
 *
 * -- Why a second cache under the slot cache ---------------------------------
 * `services/overview.ts` caches a built CARD. That is the right unit for a
 * repeat visit and the wrong unit for everything else, because the Dashboard's
 * cards do not own their statements — they share them. Format A alone asks for
 * `fees` three times (rings, top_schools, fee_heads) and `heads_by_month` twice
 * (monthly, fee_heads), each as a separate request, each a separate MCP call,
 * each a separate full scan of a fee table that has no usable index. Measured on
 * the delivered extract (2026-09-06, three schools): 19.9 s of database work per
 * school for Format A, of which 5.2 s is the same two statements run again.
 *
 * A card cache cannot see any of that — the three cards are three keys and all
 * three miss together on a cold load. So the statements are cached under their
 * own keys as well, and a card is assembled from whatever its statements
 * already have. The effect the reader notices is on the layout switch: Format C
 * needs `heads_by_month`, `staff_by_month` and `att_by_month`, which Format A
 * has already paid for, so its `area` card draws from cache even though no
 * `area` card was ever built.
 *
 * -- Why partial results are cached, and the card cache cannot do it ---------
 * `buildOverviewSlot` refuses to cache a card with ANY failure in it, which is
 * correct for a card: half a card cached for ten minutes is a card that stays
 * half-drawn. But it meant the heaviest cards were never cached at all — under a
 * cold load their slowest statement passes the 10 s query timeout (docs/04 §3
 * rail 4), the card is reported blocked, nothing is written, and the next reader
 * pays the whole cost again. `fee_heads` measured 11.4 s on a WARM run for
 * exactly this reason.
 *
 * At this granularity the same rule is not lossy: a statement that answered is
 * cached, a statement that failed is not, and the retry costs only the statement
 * that failed rather than the three that already succeeded beside it.
 *
 * -- In-flight coalescing ----------------------------------------------------
 * The seven cards of a layout arrive within a few milliseconds of each other, so
 * a cache lookup started by one is still in the air when the next asks for the
 * same statement. A shared promise per key closes that window: the first asker
 * owns the fetch and the rest await it. Process-local by design, exactly as
 * `refreshInBackground` is — this is a de-duplication hint, not a lock, and a
 * second orchestrator instance running one more copy of a SELECT is harmless.
 *
 * -- What is NOT cached ------------------------------------------------------
 * A statement is written only when every school in the scope answered it. A
 * fan-out where one school was unreachable would otherwise be frozen into the
 * cache as a smaller total than the trust really has — a number that is wrong
 * rather than missing, which §10 treats as the worse failure of the two.
 */

import { ERROR_CODES, PlatformError } from '@sap/shared';
import type { SessionClaims } from '../auth/session.js';
import { withMcp } from '../mcp/client.js';
import { cacheGet, cacheKey, cacheSet, refreshInBackground } from '../cache/result-cache.js';
import { config } from '../config.js';
import type { PredefinedResult } from './dashboards.js';

/**
 * Declared here rather than in `services/overview.ts` because that module
 * imports this one; `overview.ts` re-exports it so callers keep one import.
 */
export const OVERVIEW_REPORT_ID = 'dashboard-overview';

/** One school's answer to one statement, exactly as `Merged` expects to read it. */
type SchoolQuery = NonNullable<PredefinedResult['schools'][number]['queries']>[number];

/**
 * One statement's outcome across the whole scope — the unit that is cached.
 *
 * The school-level status is carried alongside the per-school answer because a
 * school that could not be reached AT ALL and a school whose statement failed
 * are different facts: the first is `schoolFailures()` on screen ("Noida
 * temporarily unreachable"), the second is a named panel that did not draw.
 * Flattening them here would lose the distinction before `Merged` ever sees it.
 */
interface QuerySlice {
  readonly key: string;
  readonly as_of: string;
  /** The report's own labels, carried so a reassembled result invents neither. */
  readonly title: string;
  readonly source: string;
  readonly schools: readonly {
    readonly school_id: string;
    readonly status: 'ok' | 'failed';
    readonly error?: { code: string; message: string };
    readonly query?: SchoolQuery;
  }[];
}

export interface OverviewQueryArgs {
  readonly session: SessionClaims;
  readonly schoolIds: readonly string[];
  readonly params: Record<string, string>;
  readonly correlationId: string;
}

/**
 * Shared fetches, keyed by the same cache key the statement is stored under.
 *
 * Keyed by the CACHE key rather than the query name so the scope, the filters
 * and the permission class are all part of the identity — two readers of
 * different schools must never share a fetch, and the key already says so
 * (ADR-028).
 */
const inFlight = new Map<string, Promise<QuerySlice>>();

/** For tests: how many statement fetches are in flight. */
export function inFlightQueryCount(): number {
  return inFlight.size;
}

function keyFor(args: OverviewQueryArgs, query: string): string {
  return cacheKey({
    kind: `overview:q:${query}`,
    schoolIds: args.schoolIds,
    permissionClass: args.session.permission_class,
    filters: args.params,
  });
}

/**
 * Run (or reuse) the named statements and return them in the shape
 * `run_predefined` would have.
 *
 * The return type is deliberately `PredefinedResult` and not something new:
 * `Merged` is the one reader of these results and it is shared with every other
 * dashboard, so a second shape here would be a second thing for a builder to
 * understand and a second thing to keep in step.
 */
export interface OverviewQueryOptions {
  /**
   * Refuse stale statements and fetch them again.
   *
   * Set by a CARD's background rebuild. Without it the rebuild reassembled the
   * card from the same stale statements it was triggered by, wrote it back with
   * a fresh timestamp, and so published old figures under a new one — a card
   * that claims to be current and is not is worse than a card that admits its
   * age. A statement that is genuinely fresh is still reused, so two stale cards
   * sharing a statement refresh it once between them rather than twice.
   */
  readonly requireFresh?: boolean;
}

export async function runOverviewQueries(
  args: OverviewQueryArgs,
  queryKeys: readonly string[],
  options: OverviewQueryOptions = {},
): Promise<PredefinedResult> {
  const wanted = [...new Set(queryKeys)];

  /**
   * Claiming is SYNCHRONOUS, before any await.
   *
   * The whole point is to catch siblings that arrive in the same tick, and a
   * cache lookup is a network round trip — so a claim made after `await
   * cacheGet` would lose every race it exists to win.
   */
  const pending = new Map<string, Promise<QuerySlice>>();
  const owned = new Map<string, (outcome: { ok: QuerySlice } | { err: unknown }) => void>();

  for (const query of wanted) {
    const key = keyFor(args, query);
    const existing = inFlight.get(key);
    if (existing !== undefined) {
      pending.set(query, existing);
      continue;
    }
    let settle!: (outcome: { ok: QuerySlice } | { err: unknown }) => void;
    const promise = new Promise<QuerySlice>((resolve, reject) => {
      settle = (outcome) => {
        if ('ok' in outcome) resolve(outcome.ok);
        else reject(outcome.err instanceof Error ? outcome.err : new Error(String(outcome.err)));
      };
    });
    /**
     * Nothing awaits this promise until the gather at the bottom, and an
     * unhandled rejection in between would take the process down. The real
     * handling is there; this only marks it as spoken for.
     */
    promise.catch(() => undefined);
    owned.set(query, settle);
    inFlight.set(key, promise);
    pending.set(query, promise);
  }

  if (owned.size > 0) {
    void produce(args, [...owned.keys()], owned, options.requireFresh === true).finally(() => {
      for (const query of owned.keys()) inFlight.delete(keyFor(args, query));
    });
  }

  const slices = await Promise.all(wanted.map(async (query) => pending.get(query)!));
  return assemble(args, slices);
}

/**
 * Resolve the statements this call owns: cache first, then one MCP call for
 * whatever the cache could not answer.
 *
 * One call for all the misses rather than one per statement, because a report is
 * several questions about the same slice and `run_predefined` was built to
 * answer them together — one tenant resolution, one connection, and the answers
 * read against the same replica at the same moment (mcp-server/src/tools/
 * run-predefined.ts).
 */
async function produce(
  args: OverviewQueryArgs,
  queries: readonly string[],
  owned: Map<string, (outcome: { ok: QuerySlice } | { err: unknown }) => void>,
  requireFresh: boolean,
): Promise<void> {
  const misses: string[] = [];

  await Promise.all(
    queries.map(async (query) => {
      const key = keyFor(args, query);
      const hit = await cacheGet<QuerySlice>(key);
      if (hit === null || (requireFresh && hit.stale)) {
        misses.push(query);
        return;
      }
      owned.get(query)?.({ ok: hit.value });
      /**
       * Served now, rebuilt behind the response — the same trade the card cache
       * makes (cache/result-cache.ts), applied one statement lower so a stale
       * `fees` is refreshed once for every card that shares it.
       */
      if (hit.stale) {
        refreshInBackground(key, async () =>
          fetchSlices({ ...args, correlationId: `${args.correlationId}:refresh` }, [query]),
        );
      }
    }),
  );

  if (misses.length === 0) return;

  try {
    const fetched = await fetchSlices(args, misses);
    for (const query of misses) {
      const slice = fetched.get(query);
      owned.get(query)?.(
        slice === undefined
          ? {
              /**
               * The report ran and this statement is not in the answer. That is
               * not a slow day, it is a catalog that no longer matches the slot
               * definition, and it must not be reported as an empty card.
               */
              err: new PlatformError({
                code: ERROR_CODES.REPORT_DEFINITION_NOT_FOUND,
                message: 'This card asks for a statement the report no longer has.',
                diagnostics: { query },
                correlationId: args.correlationId,
              }),
            }
          : { ok: slice },
      );
    }
  } catch (err) {
    for (const query of misses) owned.get(query)?.({ err });
  }
}

/**
 * One MCP call, split into per-statement slices and written to the cache.
 *
 * Also the background-refresh entry point, which is why it writes the cache
 * itself rather than leaving that to the caller: `refreshInBackground` expects
 * the rebuild to store its own result.
 */
async function fetchSlices(
  args: OverviewQueryArgs,
  queries: readonly string[],
): Promise<Map<string, QuerySlice>> {
  const result = await withMcp(args.session, args.correlationId, args.schoolIds, async (mcp) =>
    mcp.call<PredefinedResult>('run_predefined', {
      report_id: OVERVIEW_REPORT_ID,
      school_ids: [...args.schoolIds],
      params: args.params,
      query_keys: [...queries],
    }),
  );

  const slices = new Map<string, QuerySlice>();
  for (const query of queries) {
    const schools = result.schools.map((school) => {
      const answer = (school.queries ?? []).find((q) => q.key === query);
      return {
        school_id: school.school_id,
        status: school.status,
        ...(school.error === undefined ? {} : { error: school.error }),
        ...(answer === undefined ? {} : { query: answer }),
      };
    });
    const slice: QuerySlice = {
      key: query,
      as_of: result.as_of,
      title: result.title,
      source: result.source,
      schools,
    };
    slices.set(query, slice);

    /**
     * Written only when the whole scope answered. See the header: a fan-out
     * missing a school is a wrong total, not a missing one, and freezing it into
     * the cache would keep it wrong for the length of the TTL.
     */
    const complete =
      schools.length > 0 &&
      schools.every((s) => s.status === 'ok' && s.query !== undefined && s.query.status === 'ok');
    if (complete) await cacheSet(keyFor(args, query), slice, config.CACHE_TTL_SECONDS);
  }
  return slices;
}

/**
 * Slices back into the one shape `Merged` reads.
 *
 * `as_of` is the OLDEST slice's, not the newest: a card is only as current as
 * its stalest statement, and every dashboard prints this timestamp as the "as
 * of" the reader is invited to trust.
 */
function assemble(args: OverviewQueryArgs, slices: readonly QuerySlice[]): PredefinedResult {
  const schools = args.schoolIds.map((schoolId) => {
    const entries = slices.map((slice) => slice.schools.find((s) => s.school_id === schoolId));
    const queries = entries.flatMap((entry) => (entry?.query === undefined ? [] : [entry.query]));
    /**
     * The school failed only if it failed for EVERY statement. One statement
     * timing out is a panel that did not draw (`failures()`); the school itself
     * is still reachable and its other cards are still true.
     */
    const failed = entries.length > 0 && entries.every((entry) => entry === undefined || entry.status === 'failed');
    const error = entries.find((entry) => entry?.error !== undefined)?.error;
    return {
      school_id: schoolId,
      status: (failed ? 'failed' : 'ok') as 'ok' | 'failed',
      ...(failed && error !== undefined ? { error } : {}),
      queries,
    };
  });

  const asOf = slices.map((slice) => slice.as_of).sort()[0] ?? new Date().toISOString();

  const first = slices[0];
  return {
    report_id: OVERVIEW_REPORT_ID,
    title: first?.title ?? OVERVIEW_REPORT_ID,
    source: first?.source ?? OVERVIEW_REPORT_ID,
    params: { ...args.params },
    as_of: asOf,
    schools,
  };
}
