/**
 * The Dashboard's cards, fetched one slot at a time (api/client.ts
 * `getOverviewSlot`, services/overview.ts).
 *
 * A MAP keyed by slot, filled as each request resolves — the same shape the old
 * preview grid used and for the same reason: the tiles are ready in tens of
 * milliseconds while the fee ledger takes seconds, and a card must not wait for
 * its slowest neighbour. A slot absent from the map is loading; present with
 * `status: 'blocked'` it explains itself; a rejected REQUEST (a dropped
 * connection, an expired session) is recorded as an error so the card can say
 * so rather than sit as a skeleton forever.
 *
 * Emptied whenever the school selection or the year changes: a card showing
 * last year's receipts under a heading that already says this year is the page
 * disagreeing with itself, which is worse than a skeleton.
 *
 * -- Why a card already fetched is not fetched again -------------------------
 * The layout switcher changes WHICH cards are on screen, not what any of them
 * says. `tiles` and `rings` belong to two layouts, and switching to the other
 * one used to clear the map and re-request every card in the new list — the two
 * shared ones included, under the same scope and the same year, for an answer
 * the browser was already holding. The server made that cheap (its cache
 * answers in about 20 ms) and it was still a round trip per card and a skeleton
 * flash on cards that never changed.
 *
 * So results are kept in a ref, keyed by slot AND by the scope and year they
 * were fetched under. A layout switch redraws the shared cards from memory and
 * requests only what is genuinely new. The key is what makes it safe: a result
 * can never be reused for a scope or year it was not fetched for, so the "page
 * disagreeing with itself" rule above still holds — a change of either still
 * clears everything, because nothing under the new key has been fetched yet.
 */

import { useEffect, useRef, useState } from 'react';
import { getOverviewSlot, type OverviewSlot } from '../../api/client';

export type SlotState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly slot: OverviewSlot }
  | { readonly kind: 'failed'; readonly message: string };

export function useOverview(
  slots: readonly string[],
  schoolIds: readonly string[],
  academicYear: string | null,
): Record<string, SlotState> {
  const [states, setStates] = useState<Record<string, SlotState>>({});
  const schoolsKey = schoolIds.join(',');
  const slotsKey = slots.join(',');
  /**
   * Kept in a ref rather than in state: writing to it must not itself cause a
   * render, and the effect below reads it at the moment it runs rather than as
   * it stood when the component last rendered.
   */
  const cache = useRef<Record<string, SlotState>>({});
  const cacheKey = `${schoolsKey}|${academicYear ?? ''}`;
  const cacheKeyRef = useRef(cacheKey);

  useEffect(() => {
    /**
     * A different scope or year invalidates everything held. Done here rather
     * than in the effect body's dependency list because the ref survives the
     * re-render that a dependency change causes.
     */
    if (cacheKeyRef.current !== cacheKey) {
      cache.current = {};
      cacheKeyRef.current = cacheKey;
    }

    if (academicYear === null || schoolIds.length === 0) {
      setStates({});
      return undefined;
    }

    /** Draw immediately from what is already held, then fill in the rest. */
    const known: Record<string, SlotState> = {};
    for (const slot of slots) {
      const held = cache.current[slot];
      if (held !== undefined) known[slot] = held;
    }
    setStates(known);

    let cancelled = false;
    const fetchedUnder = cacheKey;
    const record = (slot: string, state: SlotState): void => {
      /**
       * Held only if the scope and year it was fetched under are still the ones
       * in force. An answer that lands after the reader changed schools belongs
       * to a key nobody is looking at, and writing it into the current one would
       * put another school's figures on screen.
       */
      if (cacheKeyRef.current === fetchedUnder) cache.current[slot] = state;
      if (!cancelled) setStates((current) => ({ ...current, [slot]: state }));
    };

    for (const slot of slots) {
      if (known[slot] !== undefined) continue;
      getOverviewSlot(schoolIds, academicYear, slot)
        .then((result) => {
          /**
           * A BLOCKED card is shown but not held: it is a card that could not be
           * produced this time, and a layout switch is a natural moment to try
           * again. Only an answer is worth keeping.
           */
          const state: SlotState = { kind: 'ready', slot: result };
          if (result.status === 'blocked') {
            if (!cancelled) setStates((current) => ({ ...current, [slot]: state }));
            return;
          }
          record(slot, state);
        })
        .catch((err: unknown) => {
          /**
           * A failed request is NOT held: the next layout switch should retry it
           * rather than redraw the error. Only answers are worth keeping.
           */
          if (!cancelled) {
            setStates((current) => ({
              ...current,
              [slot]: { kind: 'failed', message: err instanceof Error ? err.message : 'This card could not be loaded.' },
            }));
          }
        });
    }
    return () => { cancelled = true; };
    // `schoolIds` and `slots` are read through their joined keys so a new array
    // with the same members does not refetch every card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolsKey, slotsKey, academicYear, cacheKey]);

  return states;
}
