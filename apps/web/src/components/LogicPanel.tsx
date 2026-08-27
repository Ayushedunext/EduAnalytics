/**
 * The Logic panel — Invariant 6 on screen, shared across every report surface.
 *
 * Contract source: docs/06 §3 ("plain-language chips (Source · Scope ·
 * Filters · Group-by · Chart) + the generated SQL, read-only. Scope line
 * states it is injected from the token and cannot be widened.") ·
 * CODING_GUIDELINES §17 ("UX affordances (logic, clone, scope, locked-state)
 * present on any new report surface").
 *
 * Extracted from DashboardPage.tsx so predefined dashboards AND custom
 * reports (ReportEditor.tsx) render the identical panel — a second, drifted
 * copy for custom reports would be exactly the kind of surface
 * CODING_GUIDELINES §17 exists to prevent.
 */

import type { ReportLogic } from '../api/client';

interface ReportForLogic {
  logic: ReportLogic;
  spec: { meta: { served_from: 'cache' | 'rollup' | 'replica' } };
}

export function LogicPanel({
  report,
  activeQueryKey,
}: {
  report: ReportForLogic;
  /**
   * docs/06 §4.4: a drill report "shows all level SQLs with the active one
   * highlighted". The caller decides which one is active because it owns the
   * drill state (DashboardPage.tsx); this panel only knows how to mark it.
   */
  activeQueryKey?: string | undefined;
}): JSX.Element {
  const { logic } = report;
  return (
    <section className="card logicPanel" aria-label="Report logic">
      <h3 className="specPanelTitle">Report logic</h3>

      <dl className="logicChips">
        <Chip label="Source" value={logic.source} />
        <Chip
          label="Scope"
          value={`${logic.scope.map((s) => s.school_name).join(', ')} — injected from your launch token, read-only`}
        />
        <Chip label="Filters" value={logic.filters.map((f) => `${f.label}: ${f.value}`).join(' · ')} />
        <Chip label="Group by" value={logic.group_by.join(' · ')} />
        <Chip label="Charts" value={[...new Set(logic.charts)].join(' · ')} />
        <Chip label="Served from" value={`${report.spec.meta.served_from} (three-tier order)`} />
      </dl>

      {logic.notes.map((note) => (
        <p key={note} className="logicNote">
          {note}
        </p>
      ))}

      <h4 className="logicSqlHeading">Generated SQL</h4>
      {logic.queries.map((query) => (
        <div
          key={query.key}
          className={`logicQuery${query.key === activeQueryKey ? ' logicQuery--active' : ''}`}
        >
          <div className="logicQueryTitle">
            {query.key} — {query.description}
            {query.key === activeQueryKey && <span className="logicQueryFlag">active level</span>}
          </div>
          {/* Rendered as text, never as markup (§4). */}
          <pre className="logicSql">{query.sql}</pre>
        </div>
      ))}
    </section>
  );
}

function Chip({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="logicChip">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
