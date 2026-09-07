/**
 * One build per key at a time.
 *
 * The result cache stops the SECOND reader paying for a scan. It does nothing
 * for the second reader who arrives while the first is still waiting — and on
 * this product that is most of them, for three reasons that all land at once:
 * a layout fires every card together, several people open Analytics at the same
 * time of day, and a launch starts building the landing screen a second or two
 * before the browser asks for it (services/warm.ts).
 *
 * Without this, the launch warm was not a head start but a competitor: it and
 * the reader's own first request ran the same statements against the same three
 * replica connections, so priming the cache made the first screen SLOWER. With
 * it, the reader's request joins the warm already in progress and is served by
 * it. Measured on the delivered extract (2026-09-06): `/api/home/years` 3,077 ms
 * racing the warm, 421 ms joining it.
 *
 * -- Process-local, and a hint rather than a lock -----------------------------
 * The same scope `refreshInBackground` uses, for the same reason: two
 * orchestrator instances each running one copy of a SELECT is harmless, and a
 * cross-process lock would be a correctness claim this does not need to make.
 *
 * -- Why the key must be the CACHE key ---------------------------------------
 * Everything that separates two readers' answers lives in it — the school set,
 * the filters, and [MANDATORY] the permission class (ADR-028). Coalescing on
 * anything less would hand one reader another reader's rows, which is precisely
 * the failure that key exists to prevent.
 */

const inFlight = new Map<string, Promise<unknown>>();

export async function coalesce<T>(key: string, build: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing as Promise<T>;

  const started = build().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, started);
  return started;
}

/** For tests: how many builds are in flight. */
export function inFlightCount(): number {
  return inFlight.size;
}
