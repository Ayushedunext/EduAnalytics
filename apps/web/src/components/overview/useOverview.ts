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
 */

import { useEffect, useState } from 'react';
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

  useEffect(() => {
    setStates({});
    if (academicYear === null || schoolIds.length === 0) return undefined;
    let cancelled = false;
    for (const slot of slots) {
      getOverviewSlot(schoolIds, academicYear, slot)
        .then((result) => {
          if (!cancelled) setStates((current) => ({ ...current, [slot]: { kind: 'ready', slot: result } }));
        })
        .catch((err: unknown) => {
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
  }, [schoolsKey, slotsKey, academicYear]);

  return states;
}
