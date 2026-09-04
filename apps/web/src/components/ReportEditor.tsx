/**
 * A custom report — view, edit and version history (ADR-018, docs/06 §3).
 *
 * Two edit surfaces, matching what services/custom-reports.ts actually
 * supports for each `mode` (see that file's header for the full reasoning):
 *
 *   'template' (a predefined clone) — the Visual editor: academic year / as-of
 *   date, and the drill path (docs/06 §4.3's "clones may change or disable the
 *   path"). The SQL is real and shown, but read-only — it is the same vetted,
 *   `:param`-templated statement the original dashboard's Logic panel already
 *   shows.
 *
 *   'raw_sql' (an AI-saved report) — the SQL tab is the ONLY editor, and it is
 *   hand-editable: the exact statement(s) behind the chart, guarded by the
 *   same AST validator as everything else before a save is accepted.
 *
 * -- Why editing is a two-column screen (docs/06 §3) --------------------------
 * The contract is "*Visual editor* … with the **SQL regenerating live** beside
 * it". Beside, not below: the point of the panel is that a reader can watch
 * what their choice DID, and an editor stacked under a chart makes the two
 * things it relates impossible to see at once. So opening the editor splits the
 * screen — controls and logic on the left, the report itself on the right,
 * clickable through all three of its levels.
 *
 * Reuses `LogicPanel` and `ChartSpecView` unchanged — a custom report is
 * rendered by the identical layer a predefined dashboard is (ADR-015), and
 * drills through the identical hook a dashboard does (`useDrill`).
 */

import { useCallback, useMemo, useState } from 'react';
import { useEffect } from 'react';
import { ChartSpecView } from '@sap/chart-spec/react';
import type { DrillTarget } from '@sap/chart-spec/react';
import type { Widget } from '@sap/chart-spec';
import {
  ApiFailure,
  customReportPdfUrl,
  deleteReport,
  drillCustomReport,
  getCustomReport,
  listReportVersions,
  rollbackReport,
  setReportVisibility,
  updateReportSql,
  updateReportVisual,
  type CustomReportResponse,
  type DrillChart,
  type ReportDrill,
  type ReportVersionSummary,
  type SessionResponse,
} from '../api/client';
import { DrillTrail, useDrill, widgetIdOf } from './Drill';
import { LogicPanel } from './LogicPanel';
import { AskAiPanel } from './AskAiPanel';

interface Props {
  session: SessionResponse;
  id: string;
  schoolIds: readonly string[];
  /** My Reports' ✎ Edit lands here with the editor already open; its View does not. */
  startEditing?: boolean;
  onBack: () => void;
  onDeleted: () => void;
}

export function ReportEditor({ session, id, schoolIds, startEditing = false, onBack, onDeleted }: Props): JSX.Element {
  const [report, setReport] = useState<CustomReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLogic, setShowLogic] = useState(false);
  /**
   * Only a seed. The editor is still owner-gated by the toggle below, and by
   * the server on every write — arriving with `startEditing` set opens a panel,
   * it does not grant anything.
   */
  const [editing, setEditing] = useState(startEditing);
  const [askAiWidget, setAskAiWidget] = useState<{ id: string; title: string } | null>(null);
  const [showVersions, setShowVersions] = useState(false);

  const load = (): void => {
    setError(null);
    getCustomReport(id, schoolIds)
      .then((data) => { setReport(data); })
      .catch((err: unknown) => {
        setError(err instanceof ApiFailure ? err.message : 'Could not load this report.');
      });
  };

  useEffect(load, [id, schoolIds]);
  useEffect(() => { setAskAiWidget(null); }, [id]);

  /**
   * Drill navigation, through the same hook the Dashboard and its preview cards
   * use (components/Drill.tsx) — one place for the level arithmetic, whatever
   * kind of report is being drilled.
   *
   * `academicYear: null` and an injected `fetchLevel`, because a clone's year is
   * not the topbar's: it drills under the filter values it SAVED, which the
   * server reads from its own definition (ADR-018). Sending a year from here
   * would let a reader change the question a saved report answers.
   */
  const fetchLevel = useCallback(
    (body: { widget_id: string; level: number; context: readonly { dim: string; value: string; label: string }[] }) =>
      drillCustomReport(id, schoolIds, body),
    [id, schoolIds],
  );
  const { drills, busy: drillBusy, navigate: navigateDrill, clear: clearDrills } = useDrill({
    reportId: id,
    schoolIds,
    academicYear: null,
    fetchLevel,
    onError: useCallback((message: string | null) => { setError(message); }, []),
  });

  /**
   * A saved edit re-runs the report server-side and can change its drill path
   * (a level's chart, or the switch itself), so every drilled level on screen
   * is a level of the PREVIOUS version. Dropping them is the same rule
   * DashboardPage applies when its year changes: a chart from one definition
   * under a breadcrumb belonging to another is the success-shaped failure
   * CODING_GUIDELINES §10 names.
   */
  const replaceReport = useCallback(
    (updated: CustomReportResponse): void => {
      clearDrills();
      setReport(updated);
    },
    [clearDrills],
  );

  /**
   * The spec as it should be DRAWN: every drilled widget replaced in place by
   * the level currently on screen. Substituted here rather than by mutating
   * `report`, so level 1 survives for Reset and for the PDF link.
   */
  const shownSpec = useMemo(() => {
    if (report === null) return null;
    if (Object.keys(drills).length === 0) return report.spec;
    return {
      ...report.spec,
      widgets: report.spec.widgets.map((widget) => {
        const wid = widgetIdOf(widget);
        return wid !== null && drills[wid] !== undefined ? drills[wid].widget : widget;
      }),
    };
  }, [report, drills]);

  /**
   * The report's own statements plus the active drill level's, so Invariant 6
   * holds at every level rather than only at the top (docs/06 §4.4).
   */
  const shownReport = useMemo(() => {
    if (report === null) return null;
    const levels = Object.values(drills);
    if (levels.length === 0) return report;
    const known = new Set(report.logic.queries.map((q) => q.key));
    const extra = levels.map((d) => d.query).filter((q) => q.sql !== '' && !known.has(q.key));
    return { ...report, logic: { ...report.logic, queries: [...report.logic.queries, ...extra] } };
  }, [report, drills]);

  const activeDrill = Object.values(drills)[0];

  if (error !== null && report === null) {
    return (
      <main className="flex-1 overflow-y-auto">
        <div className="px-7 py-6 max-w-[1900px]">
          <button type="button" className="backLink" onClick={onBack}>
            ← My Reports
          </button>
          <div className="notice mt-4">{error}</div>
        </div>
      </main>
    );
  }

  if (report === null || shownSpec === null || shownReport === null) {
    return (
      <main className="flex-1 overflow-y-auto">
        <div className="px-7 py-6 max-w-[1900px]">
          <div className="mt-10 text-[13px] text-[var(--color-muted)] animate-pulse">Loading…</div>
        </div>
      </main>
    );
  }

  /** The editor splits the screen only when there is a visual editor to split it FOR. */
  const splitScreen = editing && report.is_owner && report.mode === 'template';

  const chart = (
    <>
      {/* The spec goes in unvalidated on purpose: the renderer validates it
          against the schema before drawing (ADR-015, §10). */}
      <ChartSpecView
        spec={shownSpec}
        /**
         * A click on a drillable chart (ADR-020). The renderer reports WHICH
         * value was clicked; deciding what to fetch is this screen's job,
         * because the drill path is a server-side catalog and the spec carries
         * only the dimension, never a query.
         */
        onDrill={(widget: Widget, target: DrillTarget) => {
          navigateDrill(widget.id, [...(drills[widget.id]?.context ?? []), target]);
        }}
        renderWidgetActions={(widget: Widget) => {
          const drilled = drills[widget.id];
          const askable = report.is_owner;
          if (drilled === undefined && !askable) return undefined;
          return (
            <>
              {drilled !== undefined && (
                <DrillTrail
                  title={report.spec.title}
                  state={drilled}
                  busy={drillBusy === widget.id}
                  /* The preview column is roughly a card's width, not a page's,
                     so the trail takes the compact shape the Dashboard cards
                     use. The NOTES are never dropped at either size. */
                  compact={splitScreen}
                  onJump={(depth) => { navigateDrill(widget.id, drilled.context.slice(0, depth)); }}
                />
              )}
              {askable && (
                <button
                  type="button"
                  className={`askAiWidgetBtn ${session.ai_status === 'active' ? '' : 'disabled'}`}
                  disabled={session.ai_status !== 'active'}
                  title={
                    session.ai_status === 'active'
                      ? `Ask AI about "${widget.title ?? report.name}"`
                      : 'Complete AI setup in Settings to ask about this chart'
                  }
                  onClick={() => {
                    setAskAiWidget({ id: widget.id, title: widget.title ?? report.name });
                  }}
                >
                  ✦ Ask AI
                </button>
              )}
            </>
          );
        }}
      />
    </>
  );

  return (
    <main className="flex-1 overflow-y-auto">
      {/* 1900px, matching DashboardPage.tsx -- this screen renders the same
          `.specPanels` bento grid via ChartSpecView (a cloned report is the
          identical renderer, ADR-015), so it has the same "grid wasted at a
          reading-column width" problem, not the "single reading column"
          shape a 1180px cap fits. */}
      <div className="px-7 py-6 max-w-[1900px]">
        <button type="button" className="backLink" onClick={onBack}>
          ← My Reports
        </button>

        {error !== null && <div className="notice mt-4">{error}</div>}

        <h1 className="page-title mt-3">{report.spec.title}</h1>
        <div className="pageContext">
          <span>{report.logic.scope.map((s) => s.school_name).join(' · ')}</span>
          {report.logic.filters.map((f) => (
            <span key={f.label}>
              <span className="dot">·</span> {f.label} {f.value}
            </span>
          ))}
          {/* docs/06 §4.3's drill chip, on the report it belongs to. A reader
              should be able to tell a clickable chart from an inert one before
              clicking it, not by clicking it. */}
          {report.drill?.available === true && (
            <span>
              <span className="dot">·</span>{' '}
              {report.drill.enabled
                ? `⌄ Drill-down · ${String(report.drill.levels.length)} levels`
                : 'Drill-down off'}
            </span>
          )}
        </div>

        <div className="affordances">
          <button type="button" className="chipbtn" onClick={() => { setShowLogic((v) => !v); }} aria-expanded={showLogic}>
            🧠 {showLogic ? 'Hide logic' : 'View logic'}
          </button>
          {report.is_owner && (
            <button type="button" className="chipbtn" onClick={() => { setEditing((v) => !v); }} aria-expanded={editing}>
              ✎ {editing ? 'Close editor' : 'Edit'}
            </button>
          )}
          <button
            type="button"
            className="chipbtn"
            onClick={() => { setShowVersions((v) => !v); }}
            aria-expanded={showVersions}
          >
            🕘 Versions (v{report.current_version})
          </button>
          <a className="chipbtn" href={customReportPdfUrl(report.id, schoolIds, { logic: true })}>
            ⬇ PDF
          </a>
          <span className="spacer" />
          {report.is_owner && (
            <VisibilityControl
              report={report}
              onChanged={(shared_flag) => { setReport({ ...report, shared_flag }); }}
              onError={setError}
            />
          )}
          {report.is_owner && report.shared_flag === 'private' && (
            <button
              type="button"
              className="chipbtn"
              onClick={() => {
                if (!window.confirm(`Delete "${report.name}"? This cannot be undone.`)) return;
                deleteReport(report.id)
                  .then(onDeleted)
                  .catch((err: unknown) => {
                    setError(err instanceof ApiFailure ? err.message : 'Could not delete this report.');
                  });
              }}
            >
              🗑 Delete
            </button>
          )}
        </div>

        {report.degraded.length > 0 && (
          <div className="notice mb-4">
            Some panels could not be produced: {report.degraded.map((d) => d.key).join(', ')}.
          </div>
        )}
        {report.degraded_schools.length > 0 && (
          <div className="notice mb-4">
            These schools could not be reached: {report.degraded_schools.map((d) => d.school_id).join(', ')}.
          </div>
        )}

        {splitScreen ? (
          <div className="editorGrid">
            <div className="editorCol">
              <VisualEditor report={report} onSaved={replaceReport} onError={setError} />
              {/* docs/06 §3: the SQL sits BESIDE the visual editor while editing,
                  not behind the "View logic" toggle a reader has to remember to
                  open. Same panel, same component — never a second copy. */}
              <LogicPanel report={shownReport} activeQueryKey={activeDrill?.query.key} />
            </div>
            <div className="editorCol">
              <div className="editorPreviewHead">
                <h3 className="specPanelTitle">Live preview</h3>
                <span className="editorPreviewNote">
                  {report.logic.scope.map((s) => s.school_name).join(' · ')}
                  {report.drill?.enabled === true && ' · click through all levels'}
                </span>
              </div>
              {chart}
            </div>
          </div>
        ) : (
          <>
            {chart}
            {showLogic && <LogicPanel report={shownReport} activeQueryKey={activeDrill?.query.key} />}
          </>
        )}

        {askAiWidget !== null && (
          <AskAiPanel
            reportId={report.id}
            widgetTitle={askAiWidget.title}
            schoolIds={schoolIds}
            onApplied={replaceReport}
            onClose={() => { setAskAiWidget(null); }}
          />
        )}

        {showVersions && (
          <VersionHistory
            reportId={report.id}
            onRolledBack={(updated) => {
              replaceReport(updated);
              setShowVersions(false);
            }}
            onError={setError}
          />
        )}

        {editing && report.is_owner && report.mode === 'raw_sql' && (
          <section className="card mt-4 p-4">
            <h3 className="specPanelTitle">SQL editor</h3>
            <SqlEditor report={report} onSaved={replaceReport} onError={setError} />
          </section>
        )}
      </div>
    </main>
  );
}

function VisibilityControl({
  report,
  onChanged,
  onError,
}: {
  report: CustomReportResponse;
  onChanged: (flag: CustomReportResponse['shared_flag']) => void;
  onError: (message: string) => void;
}): JSX.Element {
  if (!report.can_promote) {
    return (
      <span className="chipbtn disabled" title="Only an admin can share a report beyond your own view of it">
        {report.shared_flag === 'private' ? 'Private' : `Shared · ${report.shared_flag}`}
      </span>
    );
  }
  return (
    <select
      className="chipbtn"
      value={report.shared_flag}
      onChange={(e) => {
        const flag = e.target.value as CustomReportResponse['shared_flag'];
        setReportVisibility(report.id, flag)
          .then(() => { onChanged(flag); })
          .catch((err: unknown) => {
            onError(err instanceof ApiFailure ? err.message : 'Could not change visibility.');
          });
      }}
    >
      <option value="private">Private</option>
      <option value="school">Shared · school</option>
      <option value="trust">Shared · trust</option>
    </select>
  );
}

function VersionHistory({
  reportId,
  onRolledBack,
  onError,
}: {
  reportId: string;
  onRolledBack: (updated: CustomReportResponse) => void;
  onError: (message: string) => void;
}): JSX.Element {
  const [versions, setVersions] = useState<ReportVersionSummary[] | null>(null);

  useEffect(() => {
    listReportVersions(reportId)
      .then((data) => { setVersions(data.versions); })
      .catch((err: unknown) => {
        onError(err instanceof ApiFailure ? err.message : 'Could not load version history.');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId]);

  return (
    <section className="card mt-4 p-4">
      <h3 className="specPanelTitle">Version history</h3>
      {versions === null ? (
        <p className="text-[13px] text-[var(--color-muted)]">Loading…</p>
      ) : (
        <ul className="list-none p-0 m-0 flex flex-col gap-2">
          {versions.map((v) => (
            <li key={v.version} className="flex items-center gap-3 text-[13px]">
              <span className="font-medium">v{v.version}</span>
              <span className="text-[var(--color-muted)]">
                {v.edited_by} · {new Date(v.edited_at).toLocaleString()}
              </span>
              <button
                type="button"
                className="chipbtn"
                onClick={() => {
                  rollbackReport(reportId, v.version)
                    .then(onRolledBack)
                    .catch((err: unknown) => {
                      onError(err instanceof ApiFailure ? err.message : 'Could not roll back to that version.');
                    });
                }}
              >
                ⟲ Rollback to this version
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The visual editor (docs/06 §3): the filter values a clone owns, and the drill
 * path it may change or switch off (§4.3).
 *
 * What is NOT here is as deliberate as what is. The data source is shown and
 * not chosen, because changing it would make this a clone of a different report
 * rather than an edit of this one — "＋ New custom report" is where a source is
 * picked (MyReports.tsx). The drill DIMENSIONS are shown and not chosen,
 * because they are the curated hierarchy catalog's (ADR-020) and an editor that
 * offered a dimension the server would refuse is an editor offering a lie.
 * Scope is shown and not chosen because it is injected from the launch token
 * (Invariant 2, CODING_GUIDELINES §14).
 */
function VisualEditor({
  report,
  onSaved,
  onError,
}: {
  report: CustomReportResponse;
  onSaved: (updated: CustomReportResponse) => void;
  onError: (message: string) => void;
}): JSX.Element {
  const currentYear = report.logic.filters.find((f) => f.label === 'Academic year')?.value ?? '';
  const currentAsOf = report.logic.filters.find((f) => f.label === 'As of')?.value ?? '';
  const [academicYear, setAcademicYear] = useState(currentYear);
  const [asOf, setAsOf] = useState(currentAsOf);
  const [saving, setSaving] = useState(false);
  const hasAsOf = currentAsOf !== '';

  const drill = report.drill;
  const [drillEnabled, setDrillEnabled] = useState(drill?.enabled ?? false);
  /** Level number -> chart, seeded from what the server says this report draws. */
  const [charts, setCharts] = useState<Record<string, DrillChart>>(() =>
    Object.fromEntries((drill?.levels ?? []).map((l) => [String(l.n), l.chart])),
  );

  /**
   * Whether anything on this panel differs from the version on screen.
   *
   * Said out loud because the preview beside it is the SAVED report: it re-runs
   * against real school databases, so it cannot follow a half-finished edit
   * keystroke by keystroke the way the prototype's sample-data canvas did.
   * Leaving that unsaid would be worse than the limitation — a reader would
   * change a level's chart, see no change, and reasonably conclude the control
   * does nothing.
   */
  const dirty =
    academicYear !== currentYear ||
    (hasAsOf && asOf !== currentAsOf) ||
    (drill !== null && drill.available && drillEnabled !== drill.enabled) ||
    (drill?.levels ?? []).some((l) => charts[String(l.n)] !== l.chart);

  return (
    <section className="card p-4 editorCard">
      <h3 className="specPanelTitle">Report logic — visual editor</h3>

      <p className="editorHint">
        This report runs the same vetted statement as the dashboard it was cloned from — only the
        values below are yours to change. The SQL beneath shows exactly what will run.
      </p>

      <FieldRow label="Data source">
        <span className="editorReadonly" title="Changing the source would make this a clone of a different report — use ＋ New custom report for that.">
          {report.logic.source}
        </span>
      </FieldRow>

      <FieldRow label="Academic year">
        <input
          className="editorInput"
          value={academicYear}
          placeholder="2026-27"
          onChange={(e) => { setAcademicYear(e.target.value); }}
        />
      </FieldRow>

      {hasAsOf && (
        <FieldRow label="As of">
          <input
            type="date"
            className="editorInput"
            value={asOf}
            onChange={(e) => { setAsOf(e.target.value); }}
          />
        </FieldRow>
      )}

      <DrillEditor
        drill={drill}
        enabled={drillEnabled}
        charts={charts}
        onToggle={setDrillEnabled}
        onChart={(n, chart) => { setCharts((c) => ({ ...c, [String(n)]: chart })); }}
      />

      <label className="editorLocked">
        <input type="checkbox" checked disabled />
        Scope: {report.logic.scope.map((s) => s.school_name).join(' · ')} — injected from your token,
        not editable
      </label>

      <div className="editorActions">
        <button
          type="button"
          className="chipbtn chipbtn--ai"
          disabled={saving || academicYear.trim() === ''}
          onClick={() => {
            setSaving(true);
            updateReportVisual(report.id, {
              academic_year: academicYear.trim(),
              ...(hasAsOf && asOf !== '' ? { as_of: asOf } : {}),
              ...(drill !== null && drill.available
                ? { drill: { enabled: drillEnabled, charts } }
                : {}),
            })
              .then(onSaved)
              .catch((err: unknown) => {
                onError(err instanceof ApiFailure ? err.message : 'Could not save these changes.');
              })
              .finally(() => { setSaving(false); });
          }}
        >
          {saving ? 'Saving…' : '💾 Save as a new version'}
        </button>
        {dirty && (
          <span className="editorDirty">
            The preview shows v{report.current_version} — save to run these changes.
          </span>
        )}
      </div>
    </section>
  );
}

/**
 * "Report type: Simple | Drill-down" and the drill path (docs/06 §4, §4.1).
 *
 * Renders a reason rather than nothing when a report has no curated path: a
 * missing control reads as a broken feature, where "this source has no drill
 * path yet" reads as the roadmap item it is (CODING_GUIDELINES §18).
 */
function DrillEditor({
  drill,
  enabled,
  charts,
  onToggle,
  onChart,
}: {
  drill: ReportDrill | null;
  enabled: boolean;
  charts: Record<string, DrillChart>;
  onToggle: (enabled: boolean) => void;
  onChart: (n: number, chart: DrillChart) => void;
}): JSX.Element {
  if (drill === null || !drill.available) {
    return (
      <>
        <div className="editorLabel">Report type</div>
        <div className="editorRadios">
          <label className="editorRadio">
            <input type="radio" checked readOnly /> Simple report
          </label>
          <label className="editorRadio disabled">
            <input type="radio" disabled /> ⌄ Drill-down
          </label>
        </div>
        <p className="editorHint">
          Drill paths come from the curated hierarchy catalog, and this source has none yet — so
          there is no path to switch on here.
        </p>
      </>
    );
  }

  /** L1 · High, L2 · Mid, L3 · Low — docs/06 §4's own naming for the three levels. */
  const RANK = ['High', 'Mid', 'Low'];

  return (
    <>
      <div className="editorLabel">Report type</div>
      <div className="editorRadios">
        <label className="editorRadio">
          <input
            type="radio"
            name={`report-type-${drill.widget_id}`}
            checked={!enabled}
            onChange={() => { onToggle(false); }}
          />{' '}
          Simple report
        </label>
        <label className="editorRadio">
          <input
            type="radio"
            name={`report-type-${drill.widget_id}`}
            checked={enabled}
            onChange={() => { onToggle(true); }}
          />{' '}
          ⌄ Drill-down ({drill.levels.length} levels)
        </label>
      </div>

      {enabled && (
        <>
          <div className="editorLabel">
            Drill path — from the hierarchy catalog; clicked values become bound filters
          </div>
          <div className="drillPath">
            {drill.levels.map((level, index) => (
              <div key={level.n} className="drillPathRow">
                <span className={`drillPathRank drillPathRank--${String(index + 1)}`}>
                  L{level.n} · {RANK[index] ?? 'Leaf'}
                </span>
                {/* Read-only, and disabled rather than hidden: the path is what
                    a reader most needs to SEE, and it is the one thing on this
                    panel they may not change (ADR-020). */}
                <span className="drillPathDim" title={`Groups by ${level.dim}`}>
                  {level.dim}
                </span>
                <select
                  className="editorInput drillPathChart"
                  aria-label={`Chart for level ${String(level.n)}`}
                  value={charts[String(level.n)] ?? level.chart}
                  onChange={(e) => { onChart(level.n, e.target.value as DrillChart); }}
                >
                  {level.chart_options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <p className="editorHint">
            Every level runs this report&rsquo;s own vetted statement with a different GROUP BY, and a
            click narrows it as a bound parameter — it can never widen what you can see. The last
            level is the leaf, so its chart need not be clickable.
          </p>
        </>
      )}
    </>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="editorField">
      <span className="editorLabel">{label}</span>
      {children}
    </div>
  );
}

function SqlEditor({
  report,
  onSaved,
  onError,
}: {
  report: CustomReportResponse;
  onSaved: (updated: CustomReportResponse) => void;
  onError: (message: string) => void;
}): JSX.Element {
  const initialQueries = report.logic.queries.map((q) => ({ key: q.key, sql: q.sql }));
  const [queries, setQueries] = useState(initialQueries);
  const [saving, setSaving] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-[var(--color-muted)]">
        Hand-edited SQL passes the same guard every statement on this platform does — SELECT-only, no
        placeholders, your school scope injected automatically. A statement that fails validation is
        refused before anything is saved.
      </p>
      {queries.map((q, i) => (
        <div key={q.key} className="flex flex-col gap-1">
          <div className="text-[12px] font-medium text-[var(--color-muted)]">{q.key}</div>
          <textarea
            className="border rounded-md px-3 py-2 text-[13px] font-mono"
            rows={6}
            value={q.sql}
            onChange={(e) => {
              const next = [...queries];
              next[i] = { key: q.key, sql: e.target.value };
              setQueries(next);
            }}
          />
        </div>
      ))}
      <div>
        <button
          type="button"
          className="chipbtn chipbtn--ai"
          disabled={saving || queries.some((q) => q.sql.trim() === '')}
          onClick={() => {
            setSaving(true);
            // The chart's widget/field structure does not change from an
            // editor session; only the SQL producing its rows does. The
            // draft already stored on the report is resubmitted unchanged.
            updateReportSql(report.id, {
              queries: queries.map((q) => ({ key: q.key, sql: q.sql.trim() })),
              draft: { spec_version: 1, title: report.name, widgets: draftWidgetsFrom(report) },
            })
              .then(onSaved)
              .catch((err: unknown) => {
                onError(err instanceof ApiFailure ? err.message : 'That statement was rejected.');
              })
              .finally(() => { setSaving(false); });
          }}
        >
          {saving ? 'Validating & saving…' : 'Save as a new version'}
        </button>
      </div>
    </div>
  );
}

/**
 * Reconstructs a widget draft (query_ref, no data) from the currently
 * hydrated spec. Every raw_sql report has exactly one query per widget today
 * (services/custom-reports.ts's runRawSqlMode), so the widget's own field
 * names map straight back onto the draft shape the server re-hydrates from.
 */
function draftWidgetsFrom(report: CustomReportResponse): unknown[] {
  const key = report.logic.queries[0]?.key ?? 'q1';
  return report.spec.widgets.map((w) => {
    const widget = w as { id: string; type: string; title?: string; [k: string]: unknown };
    const base = { id: widget.id, type: widget.type, ...(widget.title === undefined ? {} : { title: widget.title }) };
    switch (widget.type) {
      case 'kpi':
        return widget;
      case 'bar':
      case 'line':
        return { ...base, x: widget['x'], y: widget['y'], query_ref: key };
      case 'donut':
        return { ...base, label_field: widget['label_field'], value_field: widget['value_field'], query_ref: key };
      case 'table':
        return { ...base, columns: widget['columns'], query_ref: key };
      default:
        return widget;
    }
  });
}
