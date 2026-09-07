/**
 * Building the landing screen before it is asked for.
 *
 * Contract source: docs/09 §4 (the result cache is tier ①) · ADR-028 (a cache
 * entry belongs to a permission class) · Invariant 2 (scope is law).
 *
 * -- What this is for --------------------------------------------------------
 * The cache makes the second reader fast and leaves the first one waiting. On
 * this product the first reader is not an edge case: a session lasts eight hours
 * and an entry lives forty minutes, so the person opening Analytics in the
 * morning is nearly always the one who pays. Measured cold on the delivered
 * extract (2026-09-06, three schools): 40.7 s for the KPI strip and 60.2 s for
 * the Dashboard's cards.
 *
 * The launch is the earliest moment the platform knows who is coming and what
 * they may see, and it is followed by a redirect, an SPA boot and a session
 * fetch before the first card is requested. This starts the work in that gap.
 *
 * -- Why it may use this session's scope -------------------------------------
 * `cache/result-cache.ts` is explicit that a refresh runs on the REQUESTING
 * session's own scope and permission class, never a synthetic background
 * identity — "scope is law" means the school set traces back to a signed launch
 * token, and a warmer holding a fabricated session would be a second, unsigned
 * source of scope. This runs inside the launch request, on the session just
 * issued from the verified token, so every key it writes is one that session was
 * already entitled to read. It is the same rule, applied a few seconds earlier.
 *
 * A periodic warmer would NOT be allowed to do this, and that is why there is
 * not one: it would need a stored identity to run as, which is precisely what
 * that rule forbids.
 *
 * -- Why it is fire-and-forget and never fails a launch -----------------------
 * Nothing depends on it. A launch that failed because a cache could not be
 * primed would trade a slow screen for no screen at all.
 */

import type { SessionClaims } from '../auth/session.js';
import { effectiveScope } from '@sap/shared';
import { servableSchoolIds } from '../db/registry.js';
import { config } from '../config.js';
import { buildOverviewSlot, WARM_SLOTS } from './overview.js';
import { buildHomeSummary, resolveAcademicYears } from './home.js';

/**
 * One warm per key at a time, so two launches into the same scope do not each
 * start the same scans. Process-local, like every other de-duplication hint in
 * this service.
 */
const warming = new Set<string>();

export function warmLandingScreen(session: SessionClaims, correlationId: string): void {
  if (!config.CACHE_ENABLED) return;

  const fingerprint = `${session.org_id}:${session.permission_class}:${[...session.school_ids].sort().join(',')}`;
  if (warming.has(fingerprint)) return;
  warming.add(fingerprint);

  void warm(session, correlationId)
    .catch((err: unknown) => {
      /**
       * Logged, not raised. A warm that always fails means every reader pays the
       * cold cost and nobody would otherwise be able to see why.
       */
      console.warn(
        `[orchestrator] launch warm failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    })
    .finally(() => {
      warming.delete(fingerprint);
    });
}

async function warm(session: SessionClaims, correlationId: string): Promise<void> {
  /**
   * The scope the SPA will open with: the whole token scope, minus schools the
   * registry cannot serve. Computed the same way `/api/session` computes it, so
   * the keys this writes are the keys the first request will look for — a warm
   * under a different school set is work nobody reads.
   */
  const { effective } = effectiveScope(session.school_ids, await servableSchoolIds());
  if (effective.length === 0) return;

  const years = await resolveAcademicYears({
    session,
    schoolIds: effective,
    correlationId: `${correlationId}:warm`,
  });
  const academicYear = years.academic_year;
  if (academicYear === null) return;

  const asOfDate = new Date().toISOString().slice(0, 10);

  const card = async (slot: (typeof WARM_SLOTS)[number]): Promise<unknown> =>
    buildOverviewSlot({
      session,
      schoolIds: effective,
      slot,
      academicYear,
      asOfDate,
      correlationId: `${correlationId}:warm`,
    });

  /**
   * The first fold goes first, alone.
   *
   * A school is capped at three replica connections (ADR-013), so seven cards
   * started together do not run seven times faster — they queue, and the card
   * carrying the figures a director opens for waits behind two fee-ledger scans
   * it has no interest in. Starting the tiles while the pool is empty spends the
   * head start on the part of the screen that is read first.
   *
   * Awaited rather than raced: the rest are worth nothing if the first fold is
   * still queued behind them.
   */
  await card('tiles').catch(() => undefined);

  /**
   * Then the strip and the remaining cards. `buildOverviewSlot` and
   * `buildHomeSummary` each check the cache first and coalesce with any build
   * already running, so a reader who has arrived in the meantime is SERVED by
   * this work rather than racing it.
   *
   * `allSettled`: one card failing to warm must not abandon the rest, and none
   * of these outcomes is reported to anyone — the reader's own request reports
   * its own failure, accurately, when it arrives.
   */
  await Promise.allSettled([
    buildHomeSummary({ session, schoolIds: effective, correlationId: `${correlationId}:warm` }),
    ...WARM_SLOTS.filter((slot) => slot !== 'tiles').map(card),
  ]);
}
