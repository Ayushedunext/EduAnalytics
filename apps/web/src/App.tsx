/**
 * App shell.
 *
 * States, all explicit: loading, no-session, error, and signed in.
 *
 * The no-session state matters more than it looks. There is NO login screen in
 * this product (docs/10 §2) -- identity arrives only via the ERP launch token
 * (ADR-002). So a visitor without a session is not offered a password box; they
 * are told to open Analytics from the ERP menu. Adding a login form here would
 * contradict CODING_GUIDELINES §11, which forbids platform-local login outright.
 *
 * Two fetches, in sequence and for a reason: `/api/session` establishes WHO the
 * user is and WHICH schools they may see, and only then can `/api/home` be asked
 * for data about a subset of them. The SPA never picks a school before the
 * server has told it which ones exist.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ApiFailure,
  getHome,
  getHomePreview,
  getSession,
  type DashboardCard,
  type HomePreview,
  type HomeResponse,
  type SessionResponse,
} from './api/client';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { Home } from './components/Home';
import { DashboardPage } from './components/DashboardPage';
import { Settings } from './components/Settings';
import { AskAI } from './components/AskAI';
import { MyReports } from './components/MyReports';
import { ModulePage, ModulesIndex } from './components/Modules';
import { ReportEditor } from './components/ReportEditor';

type State =
  | { kind: 'loading' }
  | { kind: 'no-session'; reason: string }
  | { kind: 'error'; message: string; correlationId?: string | undefined }
  | { kind: 'ready'; session: SessionResponse };

export function App(): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [selected, setSelected] = useState<string[]>([]);
  const [home, setHome] = useState<HomeResponse | null>(null);
  const [homeLoading, setHomeLoading] = useState(false);
  const [homeError, setHomeError] = useState<string | null>(null);
  /**
   * The dashboard-preview cards, keyed by dashboard id and filled in one at a
   * time as each card's own request resolves (api/client.ts, `getHomePreview`).
   *
   * ONE map for both screens that draw them — Dashboard's grid and an opened
   * module (components/Modules.tsx). Shared rather than per-screen because they
   * are the same cards of the same reports at the same scope, so a module that
   * kept its own copy would re-query dashboards the grid had already fetched and
   * could go stale against it. What invalidates them is the school selection,
   * and that empties the whole map at once (`loadHome`).
   *
   * A MAP rather than an array because the cards do not arrive together: an id
   * is absent while its request is in flight, which is exactly what
   * `PreviewCard` renders as a skeleton, and present the moment that one
   * dashboard is ready. The previous single-array-or-null shape could only say
   * "none of them yet" or "all of them", which is what made the fastest card
   * wait for the slowest.
   */
  const [previews, setPreviews] = useState<Record<string, HomePreview>>({});
  const [previewsLoading, setPreviewsLoading] = useState(false);
  /**
   * The academic year the reader CHOSE, if they chose one.
   *
   * `null` means "whatever the server resolved" — the same shape, and the same
   * reasoning, as `DashboardPage`'s `compareYear`: the app opens on the server's
   * answer rather than on a year this component picked, so the year on screen is
   * always one the data supports, and a school whose latest year differs sees
   * its own. Overriding is the reader's decision and lives only here.
   *
   * Cleared when the school selection changes, because the options are a
   * property of the SELECTION: a year one school holds may be a year another
   * has never had, and a stale override would silently query a year the new
   * selection has no data for. `effectiveYear` below falls back rather than
   * trusting the override to still be valid.
   */
  const [chosenYear, setChosenYear] = useState<string | null>(null);
  /**
   * Navigation is a single piece of state, not a router.
   *
   * CODING_GUIDELINES §23 leaves the frontend state-management library
   * undecided, and §19 forbids adding a dependency the existing stack already
   * covers. Two screens do not need a router; when deep links and the browser's
   * back button are required — PDF exports and shared report links both want
   * them — that is the moment to choose one deliberately rather than by
   * accident here.
   */
  const [route, setRoute] = useState<
    | { kind: 'home' }
    | { kind: 'report'; id: string }
    | { kind: 'settings' }
    | { kind: 'ask'; seedQuestion?: string }
    | { kind: 'my-reports' }
    /** The Module Wise Analysis tiles, and one module opened. */
    | { kind: 'modules' }
    | { kind: 'module'; id: string }
    /** `edit` opens the editor already expanded — My Reports' ✎ Edit action, versus its View. */
    | { kind: 'report-edit'; id: string; edit?: boolean }
  >({ kind: 'home' });
  /**
   * Which module a report was opened FROM, so ← Back returns there instead of
   * to Dashboard. `null` when the report was reached any other way.
   *
   * Kept beside the route rather than inside it because it is not part of WHERE
   * the user is — it is where they came from, and a report opened from Fees and
   * the same report opened from the sidebar are the same screen showing the same
   * data. Folding it into `{ kind: 'report' }` would have made them two.
   */
  const [cameFromModule, setCameFromModule] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSession()
      .then((session) => {
        if (cancelled) return;
        setState({ kind: 'ready', session });
        // Default to the whole scope: a Director's Home is the trust view.
        setSelected(session.scope.map((s) => s.school_id));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiFailure && err.status === 401) {
          setState({ kind: 'no-session', reason: err.message });
          return;
        }
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Something went wrong.',
          correlationId: err instanceof ApiFailure ? err.correlationId : undefined,
        });
      });
    return () => { cancelled = true; };
  }, []);

  const loadHome = useCallback((schoolIds: string[], academicYear?: string) => {
    if (schoolIds.length === 0) return;
    setHomeLoading(true);
    setHomeError(null);
    // A fresh school selection OR a fresh year invalidates the previous previews
    // immediately, rather than leaving the last ones on screen while new ones
    // load — a card showing 2025-26 under a strip that already says 2026-27 is
    // the page disagreeing with itself, which is worse than a skeleton.
    setPreviews({});
    getHome(schoolIds, academicYear)
      .then((data) => { setHome(data); })
      .catch((err: unknown) => {
        /**
         * Fail loud (§10). A dashboard that renders empty on error tells the
         * user their schools have no students; it must say the query failed.
         */
        setHomeError(err instanceof Error ? err.message : 'Could not load your dashboard.');
      })
      .finally(() => { setHomeLoading(false); });
  }, []);

  useEffect(() => {
    if (state.kind !== 'ready') return;
    // A school change drops the year override before reloading — see `chosenYear`.
    setChosenYear(null);
    loadHome(selected);
  }, [state.kind, selected, loadHome]);

  /**
   * The reader picked a year in the topbar, so the KPI strip is rebuilt for it.
   *
   * The strip HAS to follow the control. The grid's preview cards already take
   * the year as a request parameter, so a strip that stayed on the server's
   * derived year would put next year's charts under last year's totals with
   * nothing on screen admitting the two were about different years — and both
   * would look equally authoritative.
   *
   * `selected` is read but is deliberately NOT a dependency. A school change is
   * the effect above, which clears `chosenYear` first, so this one either never
   * fires for that change or fires having already returned early. Adding the
   * dependency would make every school change load Home twice.
   */
  useEffect(() => {
    if (state.kind !== 'ready' || chosenYear === null) return;
    loadHome(selected, chosenYear);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind, chosenYear, loadHome]);

  /**
   * Fetch the preview cards for a set of dashboards, committing each as IT
   * resolves.
   *
   * Two screens draw these now — Dashboard's grid and a module's report list
   * (components/Modules.tsx) — so the fetching lives here once rather than
   * twice. Ids ALREADY in `previews` are skipped: walking Fees ▸ back ▸ Fees
   * should not re-query five dashboards a reader is looking at, and the map is
   * already emptied wholesale whenever the school selection changes
   * (`loadHome`), which is the only thing that invalidates them.
   *
   * `allSettled` is only here to know when the last one landed, for the
   * "still loading…" labels; every card is on screen before that. A rejected
   * card is deliberately left ABSENT rather than written in as a failure: the
   * server answers 200 with `status: 'blocked'` and a reason for a dashboard it
   * cannot preview (routes/home.ts), so a rejection here means the REQUEST
   * failed — a dropped connection, an expired session — which the card cannot
   * explain and must not invent a reason for. It stays a skeleton.
   */
  const fetchPreviews = useCallback(
    (ids: readonly string[], schoolIds: readonly string[], academicYear: string) => {
      let cancelled = false;
      setPreviewsLoading(true);
      void Promise.allSettled(
        ids.map(async (id) => {
          const preview = await getHomePreview([...schoolIds], academicYear, id);
          if (cancelled) return;
          setPreviews((prev) => ({ ...prev, [id]: preview }));
        }),
      ).finally(() => { if (!cancelled) setPreviewsLoading(false); });
      return () => { cancelled = true; };
    },
    [],
  );

  /**
   * The year every screen actually queries: the reader's choice where they made
   * one, the server's resolved year otherwise.
   *
   * The `includes` check is what makes the override safe rather than merely
   * cleared on selection change. `setChosenYear(null)` in `loadHome` fires when
   * the fetch STARTS; between then and the response landing there is a render
   * where the old `home` is still on screen, and a race that let a year survive
   * it would query a year the new selection may hold nothing for. Falling back
   * to the server's answer whenever the choice is not among the offered years
   * means the invalid state cannot be reached at all, rather than being tidied
   * up after the fact.
   */
  const effectiveYear =
    home === null
      ? null
      : chosenYear !== null && home.academic_years.includes(chosenYear)
        ? chosenYear
        : home.academic_year;

  /**
   * Dashboard's grid. Fires once the KPI strip's fetch has told us the academic
   * year -- the previews endpoint needs it (services/home.ts) and this way it is
   * never re-derived a second time client-side. A session that can read neither
   * students nor fees gets `academic_year: null` (home.ts); there is nothing to
   * preview then, so this is skipped rather than sent with a made-up year.
   *
   * The ids are the ones the SERVER puts on the grid, in ITS order, read off the
   * `/api/home` response rather than listed here -- so the SPA never asks for a
   * dashboard the catalog considers `coming` or `blocked`.
   */
  useEffect(() => {
    if (home === null || effectiveYear === null || selected.length === 0) return;
    if (home.grid.length === 0) return;
    return fetchPreviews(home.grid, selected, effectiveYear);
  }, [home, effectiveYear, selected, fetchPreviews]);

  /**
   * A module's own cards, fetched when the module is OPENED rather than with
   * Home.
   *
   * Deliberately lazy. Every served dashboard is in some module, so warming all
   * of them up front would mean fetching the whole catalog on launch to render a
   * screen of seven tiles -- the cost the Dashboard grid was curated down to
   * eight cards precisely to avoid (services/home.ts). Opening Fees fetches
   * Fees, and the four its grid card already warmed are skipped.
   */
  useEffect(() => {
    if (route.kind !== 'module') return;
    if (home === null || effectiveYear === null || selected.length === 0) return;
    const module = home.modules.find((m) => m.id === route.id);
    if (module === undefined) return;
    const missing = module.report_ids.filter((id) => previews[id] === undefined);
    if (missing.length === 0) return;
    return fetchPreviews(missing, selected, effectiveYear);
    /**
     * `previews` is read but NOT a dependency, and that is the point: adding it
     * would re-run this effect on every card that lands, and each run would see
     * a shorter `missing` list while the requests already in flight are still
     * outstanding -- refetching the tail of the module once per arriving card.
     * The effect only needs the map as it stood when the module was opened.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, home, effectiveYear, selected, fetchPreviews]);

  if (state.kind === 'loading') {
    /** docs/10 §1.4: skeletons and status, never a bare spinner. */
    return (
      <div className="h-full flex items-center justify-center">
        <div className="animate-pulse text-[13px] text-[var(--color-muted)]">
          Loading your session…
        </div>
      </div>
    );
  }

  if (state.kind === 'no-session' || state.kind === 'error') {
    const isNoSession = state.kind === 'no-session';
    return (
      <div className="h-full flex items-center justify-center px-6">
        <div className="card max-w-md p-8">
          <h1 className="text-[18px] font-semibold text-[var(--color-ink)]">
            {isNoSession ? 'Open Analytics from the ERP' : 'Could not load Analytics'}
          </h1>
          <p className="text-[13.5px] text-[var(--color-muted)] mt-2 leading-relaxed">
            {isNoSession
              ? 'There is no sign-in page here by design. Your identity comes from the ERP, so open Analytics from its menu.'
              : state.message}
          </p>
          {isNoSession && (
            <a
              href="http://localhost:4000"
              className="inline-block mt-5 text-[13px] font-medium text-white bg-[var(--color-teal)] px-4 py-2 rounded-md no-underline"
            >
              Go to the ERP →
            </a>
          )}
          {!isNoSession && state.correlationId !== undefined && (
            <p className="text-[11px] text-[var(--color-muted)] mt-4">ref {state.correlationId}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    /**
     * The shell is exactly the viewport and clips; each pane scrolls itself.
     * `min-h-0` on the content column is what lets `<main className="flex-1
     * overflow-y-auto">` actually scroll — a flex child defaults to
     * `min-height: auto` and would otherwise grow to fit its charts and push
     * the whole layout past the bottom of the window.
     */
    <div className="h-full flex overflow-hidden">
      <Sidebar
        orgName={orgLabel(state.session)}
        role={titleCase(state.session.user.role)}
        dashboards={home?.dashboards ?? []}
        aiStatus={state.session.ai_status}
        /**
         * A report opened FROM a module keeps the module row lit, not a row of
         * its own — the report has no row any more, and the reader's place in
         * the menu is the module they walked in through. A report reached any
         * other way still lights its own row where it has one (the two pinned
         * ones), and lights nothing where it does not.
         */
        active={
          route.kind === 'module'
            ? 'modules'
            : route.kind === 'report'
              ? (cameFromModule === null ? route.id : 'modules')
              : route.kind === 'report-edit'
                ? 'my-reports'
                : route.kind
        }
        onNavigate={(id) => {
          setCameFromModule(null);
          setRoute(
            id === 'home'
              ? { kind: 'home' }
              : id === 'settings'
                ? { kind: 'settings' }
                : id === 'ask'
                  ? { kind: 'ask' }
                  : id === 'my-reports'
                    ? { kind: 'my-reports' }
                    : id === 'modules'
                      ? { kind: 'modules' }
                      : { kind: 'report', id },
          );
        }}
      />
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <Topbar
          session={state.session}
          selected={selected}
          onSelect={setSelected}
          academicYear={effectiveYear}
          academicYears={home?.academic_years ?? []}
          onSelectYear={setChosenYear}
          crumb={
            route.kind === 'home'
              ? 'Dashboard'
              : route.kind === 'settings'
                ? 'Settings'
                : route.kind === 'ask'
                  ? 'Ask AI'
                  : route.kind === 'my-reports' || route.kind === 'report-edit'
                    ? 'My Reports'
                    : route.kind === 'modules'
                      ? 'Module Wise Analysis'
                      : route.kind === 'module'
                        ? moduleCrumb(route.id, home?.modules ?? [])
                        : titleOf(route.id, home?.dashboards ?? [])
          }
        />

        {homeError !== null && (
          <div className="px-7 pt-5">
            <div className="notice">{homeError}</div>
          </div>
        )}

        {route.kind === 'settings' ? (
          <Settings
            session={state.session}
            /**
             * The lock on Ask AI is read from the session, so activating a key
             * has to update it here — otherwise an admin finishes setup and the
             * padlock beside "Ask AI" is still there until they reload, which
             * reads as "it didn't work". ADR-017 pushes this over a WebSocket to
             * every user of the org; this is the same update for the one user
             * who caused it.
             */
            onAiStatusChange={(ai_status) => {
              setState({ kind: 'ready', session: { ...state.session, ai_status } });
            }}
          />
        ) : route.kind === 'ask' ? (
          <AskAI
            session={state.session}
            schoolIds={selected}
            onBack={() => { setRoute({ kind: 'home' }); }}
            onSaved={(id) => { setRoute({ kind: 'report-edit', id }); }}
            onSettings={() => { setRoute({ kind: 'settings' }); }}
            {...(route.seedQuestion === undefined ? {} : { seedQuestion: route.seedQuestion })}
          />
        ) : route.kind === 'report' ? (
          <DashboardPage
            session={state.session}
            reportId={route.id}
            schoolIds={selected}
            academicYear={effectiveYear}
            /**
             * Back to where the reader came from. A report reached from the
             * Fees module returns to Fees; one reached from Dashboard or a
             * pinned row returns to Dashboard. Sending both to Dashboard would
             * make ← Back a teleport out of the module a reader is working
             * through.
             */
            onBack={() => {
              setRoute(
                cameFromModule === null
                  ? { kind: 'home' }
                  : { kind: 'module', id: cameFromModule },
              );
            }}
            onAskAI={(seedQuestion) => { setRoute({ kind: 'ask', seedQuestion }); }}
            onCloned={(id) => { setRoute({ kind: 'report-edit', id }); }}
          />
        ) : route.kind === 'modules' ? (
          <ModulesIndex
            modules={home?.modules ?? []}
            dashboards={home?.dashboards ?? []}
            onOpenModule={(id) => { setRoute({ kind: 'module', id }); }}
          />
        ) : route.kind === 'module' ? (
          (() => {
            const module = home?.modules.find((m) => m.id === route.id);
            /**
             * No such module in the served catalog — a stale route after a
             * catalog change, or a build where that module lost its last
             * report. Back to the tiles rather than a blank page: the tiles are
             * the honest answer to "which modules are there", and this screen
             * has nothing true to say about one that is not among them.
             */
            if (module === undefined) {
              return (
                <ModulesIndex
                  modules={home?.modules ?? []}
                  dashboards={home?.dashboards ?? []}
                  onOpenModule={(id) => { setRoute({ kind: 'module', id }); }}
                />
              );
            }
            return (
              <ModulePage
                module={module}
                dashboards={home?.dashboards ?? []}
                previews={previews}
                schoolIds={selected}
                academicYear={effectiveYear}
                onBack={() => { setRoute({ kind: 'modules' }); }}
                onOpen={(id) => {
                  setCameFromModule(module.id);
                  setRoute({ kind: 'report', id });
                }}
              />
            );
          })()
        ) : route.kind === 'my-reports' ? (
          <MyReports
            schoolIds={selected}
            academicYear={effectiveYear}
            onOpen={(id) => { setRoute({ kind: 'report-edit', id }); }}
            onEdit={(id) => { setRoute({ kind: 'report-edit', id, edit: true }); }}
          />
        ) : route.kind === 'report-edit' ? (
          <ReportEditor
            session={state.session}
            id={route.id}
            schoolIds={selected}
            startEditing={route.edit === true}
            onBack={() => { setRoute({ kind: 'my-reports' }); }}
            onDeleted={() => { setRoute({ kind: 'my-reports' }); }}
          />
        ) : home === null ? (
          <div className="flex-1 flex items-start justify-center pt-24">
            <div className="animate-pulse text-[13px] text-[var(--color-muted)]">
              Querying your schools…
            </div>
          </div>
        ) : (
          <Home
            session={state.session}
            home={home}
            loading={homeLoading}
            previews={previews}
            previewsLoading={previewsLoading}
            schoolIds={selected}
            onOpen={(id) => { setRoute({ kind: 'report', id }); }}
            onAskAI={() => { setRoute({ kind: 'ask' }); }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The org's display name, as the REGISTRY holds it (the session route resolves
 * it server-side). Still never invented here: if the registry has no name, the
 * server sends the id back and the sidebar shows that -- a worse label and a
 * true one (CODING_GUIDELINES §8).
 */
function orgLabel(session: SessionResponse): string {
  return session.org_name;
}

/**
 * The crumb for a report route, before its spec has loaded.
 *
 * Read out of the CATALOG the server already sent, so the breadcrumb says what
 * the sidebar item the reader just clicked says. Title-casing the id is only the
 * fallback, and it is a poor one: `fee-comparative` becomes "Fee Comparative"
 * where the report is called "Comparative Analysis", and `fee-by-student`
 * becomes "Fee By Student". A crumb that renames the page a reader arrived on is
 * a small lie about where they are.
 */
function titleOf(id: string, dashboards: readonly DashboardCard[]): string {
  const card = dashboards.find((d) => d.id === id);
  if (card !== undefined) return card.title;
  return id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * The crumb for an open module. Read out of the served catalog for the same
 * reason `titleOf` reads a report's: the tile the reader just clicked said
 * "Fees", and a breadcrumb that title-cased the id into something else would
 * rename the page they arrived on.
 */
function moduleCrumb(id: string, modules: readonly { id: string; title: string }[]): string {
  return modules.find((m) => m.id === id)?.title ?? 'Module Wise Analysis';
}

function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}
