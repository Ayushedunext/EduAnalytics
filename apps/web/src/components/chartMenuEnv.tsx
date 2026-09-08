/**
 * The three things every per-chart menu needs and no chart knows: the scope and
 * year in force, and where a clone should land.
 *
 * A context rather than three props threaded through every card, because the
 * menu is now on a dozen components that otherwise have no business knowing
 * about routing — `GaugeCard` should not take an `onCloned` callback so that a
 * menu three levels inside it can navigate. Scope and year are the same two
 * values the whole app already agrees on (App.tsx), read here rather than
 * re-derived, so a chart's menu can never clone under a scope the page is not
 * showing (Invariant 2).
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';

export interface ChartMenuEnv {
  readonly schoolIds: readonly string[];
  /** Null until the server has resolved one — the menu's Clone waits for it. */
  readonly academicYear: string | null;
  /**
   * The schools in the selection, by name, for the logic panel's scope line.
   * Names rather than ids because the line is read by a person, and it is the
   * one line that states what the SQL beside it was constrained to.
   */
  readonly scopeNames: readonly string[];
  /**
   * Whether Ask AI is unlocked for this organisation (Invariant 5, BYOK).
   *
   * Read here so the "Insights" item can say what it is waiting for. It is
   * COSMETIC and known to be: `/api/ai/insights` re-checks `ai_status` on every
   * request and 403s regardless of what this says, exactly as `/api/ai/ask`
   * does for the three locked entry points in the nav.
   */
  readonly aiActive: boolean;
  /** docs/10 §3's "locked ≠ hidden": a lock must come with the way to open it. */
  readonly onOpenSettings: () => void;
  /** A clone landed: open it. */
  readonly onCloned: (reportId: string) => void;
}

const FALLBACK: ChartMenuEnv = {
  schoolIds: [],
  academicYear: null,
  scopeNames: [],
  aiActive: false,
  onOpenSettings: () => { /* no route to send them to */ },
  onCloned: () => { /* no route to send it to */ },
};

const Context = createContext<ChartMenuEnv>(FALLBACK);

export function ChartMenuProvider({
  schoolIds,
  academicYear,
  scopeNames,
  aiActive,
  onOpenSettings,
  onCloned,
  children,
}: ChartMenuEnv & { children: ReactNode }): JSX.Element {
  const value = useMemo(
    () => ({ schoolIds, academicYear, scopeNames, aiActive, onOpenSettings, onCloned }),
    [schoolIds, academicYear, scopeNames, aiActive, onOpenSettings, onCloned],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useChartMenuEnv(): ChartMenuEnv {
  return useContext(Context);
}
