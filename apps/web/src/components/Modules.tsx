/**
 * Module Wise Analysis (docs/10 §2) — the reports of this platform arranged by
 * the part of the school they are about, rather than as one flat list.
 *
 * Two screens in one file, because they are two halves of one idea and neither
 * is meaningful without the other:
 *
 *   `ModulesIndex` — the seven tiles: Fees, Student, Staff, Attendance,
 *                    Transport, Exam, General.
 *   `ModulePage`   — one module opened: every report in it, drawn as the SAME
 *                    live preview card the Dashboard grid uses.
 *
 * -- Why the reports here are live cards and not a list of links --------------
 * "All the fee-related analysis" is a promise about ANALYSIS, and a page of
 * five names with arrows is a menu. The card is what the platform already has
 * that answers it: one vetted query, the report's own drill-entry chart, and a
 * click through to the full report — so a reader who opens Fees can read the
 * collection curve, the aging bands and the per-student dues without opening
 * anything, and descends into whichever one has the answer. It is the same
 * `PreviewCard` Dashboard draws, deliberately: a module is an ARRANGEMENT of
 * the catalog, and a card that behaved differently in here would make it look
 * like a different product.
 *
 * -- Why this screen owns no catalog of its own -------------------------------
 * Which modules exist, which reports are in each, and in what order, all arrive
 * on `/api/home` (`modules`, `dashboards` — services/home.ts, `servedModules`).
 * Nothing is derived here from `status`, and nothing is listed here by hand.
 * That is the same rule Home.tsx and Sidebar.tsx follow for the grid and the
 * menu, and it is what stops three screens from holding three opinions about
 * what this build can open.
 *
 * -- The Exam tile is the interesting one -------------------------------------
 * It is served `empty`, with the reason from its own report card: the ERP
 * extract carries no exam data (AUDIT_REPORT C20). It renders, unclickable,
 * saying so. That is not the "locked ≠ hidden" padlock — there is no key and no
 * setting that opens it — it is a set of seven tiles describing a school, where
 * a hole would read as "exams were forgotten" and the tile reads as "the ERP
 * sends us nothing to analyse". It promises no screen, because it does not open.
 */

import type { DashboardCard, HomePreview, ModuleCard } from '../api/client';
import { PreviewCard } from './PreviewCard';

/** The tiles. */
export function ModulesIndex({
  modules,
  dashboards,
  onOpenModule,
}: {
  modules: readonly ModuleCard[];
  dashboards: readonly DashboardCard[];
  onOpenModule: (moduleId: string) => void;
}): JSX.Element {
  const byId = new Map(dashboards.map((card) => [card.id, card]));

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="px-7 py-6 max-w-[1900px]">
        <h1 className="page-title">Module Wise Analysis</h1>
        <div className="pageContext mb-5">
          <span>Pick the part of the school you want to look at</span>
        </div>

        <div className="mgrid">
          {modules.map((module) => {
            const open = module.status === 'available';
            /**
             * The report NAMES, on the tile. A count ("5 reports") would tell a
             * reader how much is behind the tile but not whether the thing they
             * came for is; the names answer the actual question, which is
             * "where do I find defaulters".
             */
            const names = module.report_ids.flatMap((id) => {
              const card = byId.get(id);
              return card === undefined ? [] : [card.title];
            });

            return (
              <div
                key={module.id}
                className={`card mtile${open ? ' clickable' : ' mtileEmpty'}`}
                role={open ? 'button' : undefined}
                tabIndex={open ? 0 : undefined}
                aria-disabled={!open}
                onClick={() => {
                  if (open) onOpenModule(module.id);
                }}
                onKeyDown={(event) => {
                  if (open && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    onOpenModule(module.id);
                  }
                }}
              >
                <div className="mtileHead">
                  <span className="mtileIc" aria-hidden="true">{module.icon}</span>
                  <b>{module.title}</b>
                  {open && <span className="mtileGo" aria-hidden="true">→</span>}
                </div>
                <p className="mtileBlurb">{module.blurb}</p>

                {open ? (
                  <div className="mtileList">
                    {names.map((name) => (
                      <span key={name} className="mtileItem">{name}</span>
                    ))}
                  </div>
                ) : (
                  /**
                   * The reason, on the tile and not in a `title` attribute. A
                   * tooltip is not an answer for a school wondering why its
                   * exam analytics are missing — and it is invisible to anyone
                   * who never hovers, which includes everyone reading a
                   * screenshot of this page.
                   */
                  <p className="mtileReason">
                    <span className="pill nodata">no data</span> {module.reason}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <p className="text-[11.5px] text-[var(--color-muted)] mt-7 leading-relaxed">
          A module groups the reports this platform already serves; it runs no query of its own.
          Every report inside one is the same predefined report, read-only and scoped to the schools
          in your launch token.
        </p>
      </div>
    </main>
  );
}

/** One module, opened: its reports as live cards. */
export function ModulePage({
  module,
  dashboards,
  previews,
  schoolIds,
  academicYear,
  onBack,
  onOpen,
}: {
  module: ModuleCard;
  dashboards: readonly DashboardCard[];
  /** Keyed by report id, filled one at a time as each card's request lands (App.tsx). */
  previews: Record<string, HomePreview>;
  schoolIds: readonly string[];
  academicYear: string | null;
  onBack: () => void;
  onOpen: (reportId: string) => void;
}): JSX.Element {
  const byId = new Map(dashboards.map((card) => [card.id, card]));
  const cards = module.report_ids.flatMap((id) => {
    const card = byId.get(id);
    return card === undefined ? [] : [card];
  });
  const outstanding = cards.filter((card) => previews[card.id] === undefined).length;

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="px-7 py-6 max-w-[1900px]">
        <button type="button" className="backLink" onClick={onBack}>
          ← Module Wise Analysis
        </button>

        <h1 className="page-title mt-3">
          <span className="mr-2" aria-hidden="true">{module.icon}</span>
          {module.title}
        </h1>
        <div className="pageContext mb-5">
          <span>{module.blurb}</span>
          <span className="dot">·</span>
          <span>
            {cards.length} {cards.length === 1 ? 'report' : 'reports'}
          </span>
          {outstanding > 0 && (
            <>
              <span className="dot">·</span>
              <span>{`${String(outstanding)} still loading…`}</span>
            </>
          )}
        </div>

        {cards.length === 0 ? (
          /**
           * Reachable only if a module's every report is withheld between the
           * tile screen rendering and this one opening — the tiles do not open
           * an `empty` module. Stated rather than left blank, per
           * CODING_GUIDELINES §10: an empty page is a bug's favourite disguise.
           */
          <div className="notice">
            {module.reason ?? 'No reports in this module can be opened right now.'}
          </div>
        ) : (
          <div className="pgallery">
            {cards.map((card) => (
              <PreviewCard
                key={card.id}
                card={card}
                preview={previews[card.id]}
                schoolIds={schoolIds}
                academicYear={academicYear}
                onOpen={onOpen}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
