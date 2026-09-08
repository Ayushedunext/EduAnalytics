/**
 * The per-chart "⋮" menu — one menu, on every chart in the product.
 *
 * Contract source: docs/06 §3 (clone-to-edit, per-widget) · ADR-019 /
 * Invariant 6 (logic transparency, "every report exposes its definition and
 * generated SQL") · CODING_GUIDELINES §17 (a report surface without the
 * standard affordances is incomplete, not minimal).
 *
 * Five actions, in this order, on Dashboard cards, report panels, module
 * preview cards and My View alike:
 *
 *   1. Insights          — the AI explaining this chart in plain words.
 *   2. Clone & customise — the chart (or its report) copied into My Reports.
 *   3. Add to My View    — the reader's own board (myView.ts).
 *   4. Enlarge           — the same chart, drawn big, over the page.
 *   5. View logic        — the statements behind THIS chart's numbers.
 *
 * Insights leads because it answers the question a reader has BEFORE any of the
 * others: what am I looking at. The four below it all assume that is already
 * settled. It is also the one that spends money — the organisation's own AI key
 * (Invariant 5) — so it is the one item whose locked state carries a path to
 * Settings rather than only a reason (docs/10 §3, "locked ≠ hidden").
 *
 * -- Why the actions are disabled rather than hidden --------------------------
 * docs/10 §3's "locked ≠ hidden" rule, applied one level down. A chart the
 * clone endpoint cannot take (a Dashboard card with no report behind it) shows
 * "Clone & customise" greyed with the reason on hover, because a menu that
 * grows and shrinks per card is a menu a reader has to re-read every time. The
 * one thing that never varies is that all four are listed.
 *
 * -- This is page chrome, not spec --------------------------------------------
 * [MANDATORY] ADR-015: nothing here is read out of a chart-spec, and nothing
 * here is written into one. The menu is composed from what the SCREEN knows —
 * which report it is showing, which widgets that report lets you clone, what
 * the server said its logic was — and handed to the renderer through
 * `renderWidgetActions` / a card's own `tools` slot, both of which are
 * explicitly outside the contract.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { WidgetSpecView, type ChartType } from '@sap/chart-spec/react';
import { ApiFailure, cloneReport, getChartInsight, type ChartInsight, type ChartInsightTarget } from '../api/client';
import { chartKey, useMyView, type ChartSource } from '../myView';
import { useChartMenuEnv } from './chartMenuEnv';

export type Bucket = 'week' | 'month' | 'quarter' | 'year';

const BUCKET_LABELS: Record<Bucket, string> = {
  week: 'Week',
  month: 'Month',
  quarter: 'Quarter',
  year: 'Year',
};

/**
 * What "Clone & customise" would copy.
 *
 * The CALLER decides, because only the screen knows: whether the widget is one
 * the server will clone on its own (`reportWidgetClone.ts`, mirroring
 * services/dashboards.ts), which as-of date and comparison year are on screen,
 * and whether a time bucket is meaningful. Absent means the action is offered
 * disabled with `cloneReason`.
 */
export interface CloneTarget {
  readonly baseReportId: string;
  /**
   * The widget the server will build on its own, where this is one. Its
   * presence is what puts the "this chart / the whole report" choice in the
   * dialog; absent, the whole report is the only thing there is to copy.
   */
  readonly widgetId?: string | undefined;
  readonly bucketOptions?: readonly Bucket[] | undefined;
  /** The report's own name, for the "whole report" option's suggested title. */
  readonly reportTitle?: string | undefined;
  readonly asOf?: string | undefined;
  readonly compareYear?: string | undefined;
}

/**
 * One chart's logic, as the SERVER stated it (Invariant 6).
 *
 * Assembled by the caller out of the response it already holds — a report's
 * `logic`, or a Dashboard slot's `queries` and `notes` — never re-derived here.
 * `activeQueryKey` marks the statement that feeds this particular widget where
 * the screen knows which one it is; where it does not, every statement behind
 * the panel is listed, which is the honest answer rather than a guess.
 */
export interface ChartLogic {
  readonly source?: string | undefined;
  readonly scope?: readonly string[] | undefined;
  readonly filters?: readonly { label: string; value: string }[] | undefined;
  readonly groupBy?: readonly string[] | undefined;
  readonly charts?: readonly string[] | undefined;
  readonly servedFrom?: string | undefined;
  readonly asOf?: string | undefined;
  readonly notes: readonly string[];
  readonly queries: readonly { key: string; description: string; sql: string }[];
  readonly activeQueryKey?: string | undefined;
}

interface Props {
  /** The chart's own name — the menu's heading, and My View's label for it. */
  readonly title: string;
  /** Which chart this is, across sessions (myView.ts). */
  readonly source: ChartSource;
  /** The widget to draw when enlarged. Validated by the renderer, as everywhere. */
  readonly widget?: unknown;
  readonly chartType?: ChartType | undefined;
  readonly slot?: number | undefined;
  /**
   * For a card the platform draws itself rather than from a widget — the
   * concentric rings, the gauges. Used by Enlarge in place of `widget`.
   */
  readonly renderLarge?: (() => ReactNode) | undefined;
  readonly clone?: CloneTarget | undefined;
  /** Why Clone is unavailable, where it is. Shown on the disabled item. */
  readonly cloneReason?: string | undefined;
  readonly logic?: ChartLogic | undefined;
  /**
   * For a surface that draws a chart WITHOUT already holding its logic — a
   * module's preview card, which fetches one widget and not the report behind
   * it. The item stays live and the statements are fetched when the reader asks
   * for them, rather than on every card of every module page.
   *
   * Invariant 6 is about what a reader can SEE, not about when it was fetched.
   * Offering the item disabled here would have been a screen deciding a chart
   * has no logic because this component had not been handed any.
   */
  readonly logicLoader?: (() => Promise<ChartLogic>) | undefined;
  /** Why View logic is unavailable, where it is. */
  readonly logicReason?: string | undefined;
  /**
   * The comparison year the screen is showing, for a report that takes one.
   * Insights rebuilds the chart the reader is looking at, and a chart compared
   * against a different year from the page it was opened on would be explained
   * correctly and about something else.
   */
  readonly compareYear?: string | undefined;
  /**
   * For a Dashboard card the platform composes out of several widgets: which
   * widgets, and from which slots. Only Insights reads it — Enlarge redraws the
   * card's own body and My View remembers the card, so neither needs the list.
   */
  readonly insightParts?: readonly { slot: string; widgetId: string }[] | undefined;
}

type Dialog = null | 'clone' | 'enlarge' | 'logic' | 'insights';

/**
 * The chart's identity as `/api/ai/insights` names it (api/client.ts).
 *
 * `parts` is what a composed Dashboard card passes in place of its own
 * synthetic id: `rings` and `gauges-c` name arrangements, not widgets, and the
 * server would rightly find nothing under either. A card that draws one real
 * widget passes nothing and gets a one-part target built from its source, which
 * is the same request with no special case.
 */
function insightTargetOf(
  source: ChartSource,
  parts: readonly { slot: string; widgetId: string }[] | undefined,
): ChartInsightTarget {
  if (source.kind === 'overview') {
    const drawn = parts ?? [{ slot: source.slot, widgetId: source.widgetId }];
    return { kind: 'overview', parts: drawn.map((p) => ({ slot: p.slot, widget_id: p.widgetId })) };
  }
  return {
    kind: source.custom === true ? 'custom' : 'report',
    report_id: source.reportId,
    widget_id: source.widgetId,
  };
}

export function ChartMenu({
  title,
  source,
  widget,
  chartType,
  slot,
  renderLarge,
  clone,
  cloneReason,
  logic,
  logicLoader,
  logicReason,
  compareYear,
  insightParts,
}: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [fetched, setFetched] = useState<ChartLogic | null>(null);
  const [logicError, setLogicError] = useState<string | null>(null);
  /**
   * Held for the life of this chart's menu, so closing the panel and opening it
   * again is free. The SERVER caches it too, for an hour and across readers
   * (ai-insights.ts); this is the same saving one step earlier, and it is what
   * makes reopening feel instant rather than merely cheap.
   */
  const [insight, setInsight] = useState<ChartInsight | null>(null);
  const [insightError, setInsightError] = useState<string | null>(null);
  const [insightBusy, setInsightBusy] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const env = useChartMenuEnv();
  const myView = useMyView();
  const saved = myView.charts.some((c) => c.id === chartKey(source));

  /**
   * A click anywhere else closes it, and so does Escape. Both listeners are
   * mounted only while the menu is open: a dozen charts on a page would
   * otherwise be a dozen document listeners running on every click in the app.
   */
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent): void => {
      if (wrap.current !== null && !wrap.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const canClone = clone !== undefined && env.academicYear !== null;
  const canEnlarge = widget !== undefined || renderLarge !== undefined;
  const shownLogic = logic ?? fetched;
  const canShowLogic = logic !== undefined || logicLoader !== undefined;

  const run = useCallback((next: Dialog) => {
    setOpen(false);
    setDialog(next);
  }, []);

  const loadInsight = (): void => {
    if (env.academicYear === null) {
      setInsightError('The academic year is still loading. Try again in a moment.');
      return;
    }
    setInsightBusy(true);
    setInsightError(null);
    getChartInsight({
      target: insightTargetOf(source, insightParts),
      schoolIds: env.schoolIds,
      academicYear: env.academicYear,
      ...(compareYear === undefined ? {} : { compareYear }),
    })
      .then((answer) => { setInsight(answer); })
      .catch((err: unknown) => {
        /* Fail loud (§10): silence here would read as "this chart has nothing
           worth saying", which is a different claim from "the call failed". */
        setInsightError(err instanceof ApiFailure ? err.message : 'The AI could not explain this chart.');
      })
      .finally(() => { setInsightBusy(false); });
  };

  return (
    <div className="chartMenuWrap" ref={wrap}>
      <button
        type="button"
        className="kebab chartMenuBtn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${title}`}
        title={`Actions for ${title}`}
        onClick={() => { setOpen((v) => !v); }}
      >
        ⋮
      </button>

      {open && (
        <div className="chartMenu" role="menu" aria-label={`${title} actions`}>
          <div className="chartMenuHead">{title}</div>
          <MenuItem
            icon="✦"
            label="Insights"
            hint={
              env.aiActive
                ? 'Have the AI explain this chart in plain words'
                : 'Needs your organisation’s AI key — open Settings'
            }
            /**
              * Never disabled, even when AI is locked. The other four items say
              * why they cannot run and stop there; this one opens and offers
              * the way to unlock it, because "complete AI setup in Settings" is
              * an instruction and a greyed row is not (docs/10 §3).
              */
            onClick={() => {
              run('insights');
              if (env.aiActive && insight === null && !insightBusy) loadInsight();
            }}
          />
          <MenuItem
            icon="⧉"
            label="Clone and customise"
            hint={
              clone?.widgetId === undefined
                ? 'Copies the whole report into My Reports, editable'
                : 'Copies this chart — or its whole report — into My Reports'
            }
            disabled={!canClone}
            disabledReason={
              clone === undefined
                ? cloneReason ?? 'This chart is not part of a report that can be cloned.'
                : 'The academic year is still loading.'
            }
            onClick={() => { run('clone'); }}
          />
          <MenuItem
            icon={saved ? '★' : '☆'}
            label={saved ? 'Remove from My View' : 'Add to My View'}
            hint={saved ? 'Take it off your own board' : 'Keep this chart on your own board'}
            onClick={() => {
              setOpen(false);
              if (saved) myView.remove(source);
              else myView.add({ title, source });
            }}
          />
          <MenuItem
            icon="⤢"
            label="Enlarge"
            hint="Open this chart big, over the page"
            disabled={!canEnlarge}
            disabledReason="This chart has not loaded yet."
            onClick={() => { run('enlarge'); }}
          />
          <MenuItem
            icon="🧠"
            label="View logic"
            hint="The source, the filters and the SQL behind these numbers"
            disabled={!canShowLogic}
            disabledReason={logicReason ?? 'The logic for this chart has not loaded yet.'}
            onClick={() => {
              run('logic');
              if (logic === undefined && fetched === null && logicLoader !== undefined) {
                setLogicError(null);
                logicLoader()
                  .then((loaded) => { setFetched(loaded); })
                  .catch((err: unknown) => {
                    /* Fail loud (§10): "could not be read" is a different
                       statement from "there is nothing behind this chart". */
                    setLogicError(err instanceof Error ? err.message : 'This chart\u2019s logic could not be read.');
                  });
              }
            }}
          />
        </div>
      )}

      {dialog === 'insights' && (
        <Modal title={`Insights — ${title}`} onClose={() => { setDialog(null); }}>
          <InsightsBody
            aiActive={env.aiActive}
            busy={insightBusy}
            insight={insight}
            error={insightError}
            onOpenSettings={() => {
              setDialog(null);
              env.onOpenSettings();
            }}
            onRetry={() => {
              setInsight(null);
              loadInsight();
            }}
          />
        </Modal>
      )}

      {dialog === 'enlarge' && (
        <Modal title={title} onClose={() => { setDialog(null); }} wide>
          <div className="chartEnlargeBody">
            {widget !== undefined ? (
              <WidgetSpecView widget={widget} chartType={chartType} slot={slot} />
            ) : (
              renderLarge?.()
            )}
          </div>
        </Modal>
      )}

      {dialog === 'logic' && (
        <Modal title={`Logic — ${title}`} onClose={() => { setDialog(null); }} wide>
          {logicError !== null ? (
            <div className="notice">{logicError}</div>
          ) : shownLogic === null ? (
            <p className="chartModalHint">Reading this chart’s definition…</p>
          ) : (
            /* The scope line is the app's, not the panel's: every caller would
               otherwise have to remember to attach the same sentence, and the
               one that forgot would show a reader SQL with nothing saying what
               it was constrained to (Invariant 2). */
            <ChartLogicBody logic={shownLogic} fallbackScope={env.scopeNames} />
          )}
        </Modal>
      )}

      {dialog === 'clone' && clone !== undefined && env.academicYear !== null && (
        <Modal title={`Clone — ${title}`} onClose={() => { setDialog(null); }}>
          <CloneForm
            title={title}
            target={clone}
            academicYear={env.academicYear}
            schoolIds={env.schoolIds}
            onCancel={() => { setDialog(null); }}
            onCloned={(id) => {
              setDialog(null);
              env.onCloned(id);
            }}
          />
        </Modal>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  hint,
  disabled,
  disabledReason,
  onClick,
}: {
  icon: string;
  label: string;
  hint: string;
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      className="chartMenuItem"
      disabled={disabled === true}
      title={disabled === true ? disabledReason : hint}
      onClick={onClick}
    >
      <span className="chartMenuIc" aria-hidden="true">{icon}</span>
      <span className="chartMenuText">
        <b>{label}</b>
        <small>{disabled === true ? disabledReason : hint}</small>
      </span>
    </button>
  );
}

/**
 * The overlay every dialog in this menu uses.
 *
 * Portaled to `document.body` so a card's own rounded, clipped box cannot cut
 * the corner off an enlarged chart, and styled from the `--color-*` tokens
 * rather than the `.skin` variables, which are scoped to the shell it is now
 * outside of ([MANDATORY] CODING_GUIDELINES §4: tokens, never hexes).
 */
function Modal({
  title,
  wide,
  onClose,
  children,
}: {
  title: string;
  wide?: boolean | undefined;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, [onClose]);

  return createPortal(
    <div
      className="chartModalScrim"
      role="presentation"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className={`chartModal${wide === true ? ' chartModal--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="chartModalHead">
          <h3>{title}</h3>
          <button type="button" className="chartModalClose" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="chartModalBody">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * What the AI made of this chart.
 *
 * Three states and no fourth: locked (the org has no AI key, and the way to fix
 * that is a click away), working, and answered. There is deliberately no "empty"
 * state — a chart with nothing to say still gets a headline saying so, written
 * by the model from the digest's own caveats (ai-insights.ts), because a blank
 * panel and a chart with no data look identical to a reader.
 */
function InsightsBody({
  aiActive,
  busy,
  insight,
  error,
  onOpenSettings,
  onRetry,
}: {
  aiActive: boolean;
  busy: boolean;
  insight: ChartInsight | null;
  error: string | null;
  onOpenSettings: () => void;
  onRetry: () => void;
}): JSX.Element {
  if (!aiActive) {
    return (
      <div className="insightsLocked">
        <p>
          Insights run on your organisation’s own AI key, so nothing here is sent anywhere until an
          administrator sets one up.
        </p>
        <p className="chartModalHint">
          Everything else on this chart — the logic, the SQL, cloning it, keeping it on your view —
          works without it.
        </p>
        <button type="button" className="chipbtn chipbtn--ai" onClick={onOpenSettings}>
          Open Settings →
        </button>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="insightsBody">
        <div className="notice">{error}</div>
        <button type="button" className="chipbtn" onClick={onRetry}>Try again</button>
      </div>
    );
  }

  if (insight === null || busy) {
    return (
      <div className="insightsBody">
        <p className="chartModalHint">Reading this chart and putting it into words…</p>
        <div className="skeleton insightsSkeleton" />
      </div>
    );
  }

  return (
    <div className="insightsBody">
      <p className="insightsHeadline">{insight.headline}</p>
      <ul className="insightsPoints">
        {insight.points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      {insight.caveat !== undefined && <p className="insightsCaveat">{insight.caveat}</p>}
      {/**
        * Said, not hidden. These sentences were written by a model from the
        * figures on this chart, and a reader deciding something on them is
        * entitled to know that — and to know that the numbers themselves came
        * from the platform's own vetted SQL, which the View logic item beside
        * this one will show them.
        */}
      <p className="insightsFine">
        Written by {insight.model} from the figures on this chart, using your organisation’s own AI
        key. It reads totals and extremes, never individual records. Check anything you act on
        against the chart and its ⋮ → View logic.
      </p>
    </div>
  );
}

/**
 * Invariant 6 for ONE chart: the same chips and the same read-only SQL the
 * report-wide panel shows (LogicPanel.tsx), narrowed to the statements behind
 * this panel. Every field is optional because the two sources differ in what
 * they can say — a Dashboard slot has queries and notes but no group-by — and
 * an absent field is left out rather than printed empty.
 */
function ChartLogicBody({ logic, fallbackScope }: { logic: ChartLogic; fallbackScope: readonly string[] }): JSX.Element {
  const chips: { label: string; value: string }[] = [];
  if (logic.source !== undefined) chips.push({ label: 'Source', value: logic.source });
  const scope = logic.scope ?? fallbackScope;
  if (scope.length > 0) {
    chips.push({
      label: 'Scope',
      value: `${scope.join(', ')} — injected from your launch token, read-only`,
    });
  }
  if (logic.filters !== undefined && logic.filters.length > 0) {
    chips.push({ label: 'Filters', value: logic.filters.map((f) => `${f.label}: ${f.value}`).join(' · ') });
  }
  if (logic.groupBy !== undefined && logic.groupBy.length > 0) {
    chips.push({ label: 'Group by', value: logic.groupBy.join(' · ') });
  }
  if (logic.charts !== undefined && logic.charts.length > 0) {
    chips.push({ label: 'Charts', value: [...new Set(logic.charts)].join(' · ') });
  }
  if (logic.servedFrom !== undefined) {
    chips.push({ label: 'Served from', value: `${logic.servedFrom} (three-tier order)` });
  }
  if (logic.asOf !== undefined) chips.push({ label: 'Data as of', value: logic.asOf });

  return (
    <div className="logicPanel logicPanel--inModal">
      <dl className="logicChips">
        {chips.map((chip) => (
          <div className="logicChip" key={chip.label}>
            <dt>{chip.label}</dt>
            <dd>{chip.value}</dd>
          </div>
        ))}
      </dl>

      {logic.notes.map((note) => (
        <p key={note} className="logicNote">{note}</p>
      ))}

      <h4 className="logicSqlHeading">Generated SQL</h4>
      {logic.queries.length === 0 ? (
        <p className="logicNote">
          The server returned no statement for this panel, so there is nothing to show here rather
          than a statement made up to fill the space.
        </p>
      ) : (
        logic.queries.map((query) => (
          <div
            key={query.key}
            className={`logicQuery${query.key === logic.activeQueryKey ? ' logicQuery--active' : ''}`}
          >
            <div className="logicQueryTitle">
              {query.key} — {query.description}
              {query.key === logic.activeQueryKey && <span className="logicQueryFlag">this chart</span>}
            </div>
            {/* Rendered as text, never as markup (§4). */}
            <pre className="logicSql">{query.sql}</pre>
          </div>
        ))
      )}
    </div>
  );
}

/**
 * The clone form.
 *
 * Was `WidgetCloneButton`'s inline popover; it is a dialog now because the same
 * form is reached from a Dashboard card, a report panel and a module preview
 * card, and a popover anchored inside a 150px-tall card had nowhere to open.
 * The fields and the request are unchanged.
 */
function CloneForm({
  title,
  target,
  academicYear,
  schoolIds,
  onCancel,
  onCloned,
}: {
  title: string;
  target: CloneTarget;
  academicYear: string;
  schoolIds: readonly string[];
  onCancel: () => void;
  onCloned: (id: string) => void;
}): JSX.Element {
  /**
   * What to copy.
   *
   * The choice exists because the page-level "⧉ Clone & customise" button is
   * gone (docs/10 §1.6): on a report whose every panel the server will build on
   * its own — Fee Collection is exactly that, all four of its panels are in
   * `CLONEABLE_WIDGETS` — a chart-only clone would have been the ONLY clone
   * left, and copying the whole report would have become unreachable from
   * anywhere in the product.
   *
   * Defaults to the chart, because that is what the reader opened the menu on.
   */
  const canPickWidget = target.widgetId !== undefined;
  const [what, setWhat] = useState<'widget' | 'report'>(canPickWidget ? 'widget' : 'report');
  const reportName = target.reportTitle ?? title;
  const suggested = (choice: 'widget' | 'report'): string =>
    `${choice === 'widget' ? title : reportName} (copy)`;
  const [name, setName] = useState(suggested(canPickWidget ? 'widget' : 'report'));
  /**
   * Once the reader has typed a name it is theirs; switching what to copy
   * re-suggests one only while they have not. Overwriting a name someone
   * chose is the more annoying of the two failures.
   */
  const [named, setNamed] = useState(false);
  const [year, setYear] = useState(academicYear);
  const [bucket, setBucket] = useState<Bucket>('month');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asWidget = what === 'widget' && target.widgetId !== undefined;
  const buckets = asWidget ? target.bucketOptions ?? [] : [];

  return (
    <div className="cloneForm">
      {canPickWidget && (
        <div className="cloneWhat" role="group" aria-label="What to copy">
          {(['widget', 'report'] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              className={what === choice ? 'on' : ''}
              aria-pressed={what === choice}
              onClick={() => {
                setWhat(choice);
                if (!named) setName(suggested(choice));
              }}
            >
              {choice === 'widget' ? 'This chart' : 'The whole report'}
            </button>
          ))}
        </div>
      )}

      <p className="chartModalHint">
        {asWidget
          ? `Saves just “${title}” to My Reports, editable on its own.`
          : `Saves ${canPickWidget ? `all of “${reportName}”` : 'the whole report'} to My Reports, with the filters this screen is showing — rename it, edit them, and its SQL stays visible.`}
      </p>

      {error !== null && <div className="widgetClonePopoverError">{error}</div>}

      <label className="widgetCloneField">
        Name
        <input
          value={name}
          onChange={(e) => { setName(e.target.value); setNamed(true); }}
        />
      </label>

      <label className="widgetCloneField">
        Academic year
        <input value={year} onChange={(e) => { setYear(e.target.value); }} placeholder="2026-27" />
      </label>

      {buckets.length > 0 && (
        <label className="widgetCloneField">
          Group by
          <select value={bucket} onChange={(e) => { setBucket(e.target.value as Bucket); }}>
            {buckets.map((b) => (
              <option key={b} value={b}>{BUCKET_LABELS[b]}</option>
            ))}
          </select>
        </label>
      )}

      <div className="widgetClonePopoverActions">
        <button type="button" className="chipbtn" onClick={onCancel} disabled={saving}>Cancel</button>
        <button
          type="button"
          className="chipbtn chipbtn--ai"
          disabled={saving || name.trim() === '' || year.trim() === ''}
          onClick={() => {
            setSaving(true);
            setError(null);
            cloneReport({
              base_report_id: target.baseReportId,
              name: name.trim(),
              academic_year: year.trim(),
              school_ids: schoolIds,
              ...(asWidget && target.widgetId !== undefined ? { widget_id: target.widgetId } : {}),
              ...(target.asOf === undefined ? {} : { as_of: target.asOf }),
              ...(target.compareYear === undefined ? {} : { compare_year: target.compareYear }),
              ...(asWidget && buckets.length > 0 && bucket !== 'month' ? { bucket } : {}),
            })
              .then((cloned) => { onCloned(cloned.id); })
              .catch((err: unknown) => {
                setError(err instanceof ApiFailure ? err.message : 'Could not clone this chart.');
              })
              .finally(() => { setSaving(false); });
          }}
        >
          {saving ? 'Cloning…' : 'Clone'}
        </button>
      </div>
    </div>
  );
}
