/**
 * Drill navigation, shared by the two surfaces that drill (ADR-020, docs/06
 * §4.4): a report page's panels and the Dashboard grid's cards.
 *
 * -- Why this is one module and not two implementations -----------------------
 * The Dashboard grid draws each report's drill-ENTRY chart, so a card is a
 * drillable surface in exactly the sense a panel is: same endpoint, same
 * `{widget_id, level, context}` body, same "level is `context.length + 1`"
 * rule, same requirement that a failed level leaves the chart where it was. A
 * second copy of that on the Dashboard would be a second place for the level
 * arithmetic to be wrong, and the first time the two disagreed one of them
 * would render a chart under a breadcrumb naming a slice it is not showing —
 * the success-shaped failure CODING_GUIDELINES §10 names.
 *
 * What is NOT here is anything about layout. The two surfaces present a trail
 * very differently (a panel has a full actions row; a card has about one line),
 * and that is a presentation decision each makes for itself through `compact`.
 *
 * [MANDATORY] ADR-015: nothing here composes a chart, a title or a caveat. The
 * server sends the level's widget, its context labels and its notes; this
 * fetches them and stores them. The one number computed on this side is the
 * level, and it is computed from the context length rather than tracked
 * separately so it cannot drift from the crumbs beside it.
 */

import { useCallback, useState } from 'react';
import { ApiFailure, drillReport, type DrillStep } from '../api/client';

/**
 * Where a drilled surface currently is (ADR-020, docs/06 §4.4).
 *
 * Page state, not spec state. ADR-015 keeps the spec a description of WHAT to
 * draw; which level a reader has navigated to is a property of this session at
 * this moment, and putting it in the spec would mean a saved report or a PDF
 * carried someone else's navigation.
 *
 * Keyed by widget id because a report may hold more than one drillable chart
 * and each drills independently. An ABSENT entry means level 1 — the chart
 * exactly as the dashboard response delivered it, which is why Reset needs no
 * request: level 1 never left.
 */
export interface DrillState {
  readonly widget: unknown;
  readonly context: readonly DrillStep[];
  readonly level: number;
  readonly query: { key: string; description: string; sql: string };
  /** Caveats the SERVER attached to this level — never composed here. */
  readonly notes: readonly string[];
}

export interface DrillNav {
  /** Drilled widgets by widget id. Absent means level 1. */
  readonly drills: Record<string, DrillState>;
  /** The widget id currently fetching, or null. */
  readonly busy: string | null;
  /**
   * Fetch the level reached by `context`, or restore level 1 when it is empty.
   *
   * One function for both a click (context grows by one) and a breadcrumb jump
   * (context is truncated), because they are the same request: the level is
   * always `context.length + 1`. A separate "go back" path would be a second
   * way to compute the same number, and the first time they disagreed the
   * breadcrumb would name a slice the chart is not showing.
   */
  readonly navigate: (widgetId: string, context: readonly DrillStep[]) => void;
  /** Drop every drilled level, without a request. */
  readonly clear: () => void;
}

export function useDrill(args: {
  reportId: string;
  schoolIds: readonly string[];
  academicYear: string | null;
  /**
   * The comparison year the surface is currently showing, for a report that
   * takes one. Passed down so a drilled level is fetched under the SAME filters
   * as the chart it was reached from — a level that arrived under the server's
   * default comparison while the page above it showed another would be two
   * views of two different questions, one of them silently.
   */
  compareYear?: string | undefined;
  /**
   * Where a drill failure is SAID. Passed in rather than owned here because the
   * two surfaces have different places to say it — a page notice above the
   * charts, a line inside one card — and a hook that picked one would be making
   * a layout decision on behalf of both.
   */
  onError: (message: string | null) => void;
}): DrillNav {
  const [drills, setDrills] = useState<Record<string, DrillState>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const { reportId, schoolIds, academicYear, compareYear, onError } = args;

  const clear = useCallback(() => {
    setDrills({});
    setBusy(null);
  }, []);

  const navigate = useCallback(
    (widgetId: string, context: readonly DrillStep[]): void => {
      if (academicYear === null) return;

      /** Level 1 is already in hand — restoring it is a delete, not a fetch. */
      if (context.length === 0) {
        setDrills((current) => {
          const next = { ...current };
          delete next[widgetId];
          return next;
        });
        return;
      }

      setBusy(widgetId);
      onError(null);
      drillReport(
        reportId,
        schoolIds,
        academicYear,
        { widget_id: widgetId, level: context.length + 1, context },
        { compareYear },
      )
        .then((result) => {
          setDrills((current) => ({
            ...current,
            [widgetId]: {
              widget: result.widget,
              context: result.context,
              level: result.level,
              query: result.query,
              notes: result.notes,
            },
          }));
          if (result.degraded.length > 0 || result.degraded_schools.length > 0) {
            onError('That level could not be read for every school in the selection.');
          }
        })
        .catch((err: unknown) => {
          /**
           * The surface stays on the level it was. A failed drill must not
           * leave the chart blank under a breadcrumb claiming it drilled (§10).
           */
          onError(err instanceof ApiFailure ? err.message : 'Could not drill into that value.');
        })
        .finally(() => {
          setBusy((current) => (current === widgetId ? null : current));
        });
    },
    [reportId, schoolIds, academicYear, compareYear, onError],
  );

  return { drills, busy, navigate, clear };
}

/**
 * Breadcrumb, Back and Reset for a drilled surface.
 *
 * In the SCREEN rather than in the renderer, for the same reason the Clone
 * button is: `@sap/chart-spec` draws specs and the PDF uses the identical code
 * path (ADR-021), so an interactive control living there would either print or
 * need a flag to stop it printing. The renderer's only part in this is
 * reporting the click.
 *
 * `compact` is the Dashboard card's shape. A card has roughly one line for this
 * where a panel has a full actions row, so the level counter and Reset are
 * dropped — Back and the crumbs are what a reader actually navigates with, and
 * the crumbs already say which level they are on by how many there are. The
 * NOTES are never dropped at either size: Fee Defaulters' quarter warning is
 * the reason the trail carries them at all, and a caveat that disappears on the
 * smaller surface is a caveat that disappears exactly where charts are read
 * fastest.
 */
export function DrillTrail({
  title,
  state,
  busy,
  compact,
  onJump,
}: {
  title: string;
  state: DrillState;
  busy: boolean;
  compact?: boolean | undefined;
  /** Jump to `depth` steps of context — 0 is level 1, the un-drilled chart. */
  onJump: (depth: number) => void;
}): JSX.Element {
  /*
   * The root crumb is the REPORT's name, not the un-drilled chart's title
   * ("Demand, collection and pending by school"). docs/06 §4.3 writes the trail
   * as `Fee Collection ▸ Apr-26 ▸ Class 9`, and a root that restated the whole
   * chart title would fill the panel head while saying nothing the drilled
   * chart's own title does not already say.
   */
  return (
    <div className={`drillTrail${compact === true ? ' drillTrailCompact' : ''}`}>
      {compact !== true && <span className="drillLevel">Level {state.level} of 3</span>}
      <button
        type="button"
        className="drillCrumb"
        onClick={() => { onJump(0); }}
        disabled={busy}
      >
        {title}
      </button>
      {state.context.map((step, index) => (
        <span key={`${step.dim}:${step.value}`}>
          <span className="drillCrumbSep">▸</span>{' '}
          <button
            type="button"
            className="drillCrumb"
            /* The last crumb is where the reader already is: it names the
               current view rather than offering to navigate to it. */
            disabled={busy || index === state.context.length - 1}
            onClick={() => { onJump(index + 1); }}
          >
            {step.label}
          </button>
        </span>
      ))}
      <button
        type="button"
        className="chipbtn"
        disabled={busy}
        onClick={() => { onJump(state.context.length - 1); }}
      >
        ← Back
      </button>
      {compact !== true && (
        <button type="button" className="chipbtn" disabled={busy} onClick={() => { onJump(0); }}>
          ⟲ Reset
        </button>
      )}
      {busy && <span className="drillBusy">loading…</span>}
      {/* Against the bars it is about, not in the report's notes list three
          screens down. Fee Defaulters' quarter level is why this exists: its
          bars are correct and adding them up is wrong by a factor of three,
          and that is not something to learn after the fact. */}
      {state.notes.map((note) => (
        <p key={note} className="drillNote">
          {note}
        </p>
      ))}
    </div>
  );
}

/**
 * A widget's id, off an `unknown` from the API.
 *
 * `DashboardResponse.spec.widgets` is deliberately `unknown[]` in the client
 * (api/client.ts): the renderer validates against the schema before drawing,
 * and a narrower type here would be a second, weaker copy of that check. A
 * caller needs only the id, to know which surface a drilled level replaces, so
 * it reads exactly that and nothing else.
 */
export function widgetIdOf(widget: unknown): string | null {
  if (typeof widget !== 'object' || widget === null) return null;
  const id = (widget as { id?: unknown }).id;
  return typeof id === 'string' && id !== '' ? id : null;
}
