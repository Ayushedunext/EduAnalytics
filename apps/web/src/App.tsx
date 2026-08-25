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
  getSession,
  type HomeResponse,
  type SessionResponse,
} from './api/client';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { Home } from './components/Home';
import { DashboardPage } from './components/DashboardPage';
import { Settings } from './components/Settings';
import { AskAI } from './components/AskAI';

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
  >({ kind: 'home' });

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

  const loadHome = useCallback((schoolIds: string[]) => {
    if (schoolIds.length === 0) return;
    setHomeLoading(true);
    setHomeError(null);
    getHome(schoolIds)
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
    loadHome(selected);
  }, [state.kind, selected, loadHome]);

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
        active={route.kind === 'report' ? route.id : route.kind}
        onNavigate={(id) => {
          setRoute(
            id === 'home'
              ? { kind: 'home' }
              : id === 'settings'
                ? { kind: 'settings' }
                : id === 'ask'
                  ? { kind: 'ask' }
                  : { kind: 'report', id },
          );
        }}
      />
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <Topbar
          session={state.session}
          selected={selected}
          onSelect={setSelected}
          academicYear={home?.academic_year ?? null}
          crumb={
            route.kind === 'home'
              ? 'Home'
              : route.kind === 'settings'
                ? 'Settings'
                : route.kind === 'ask'
                  ? 'Ask AI'
                  : titleOf(route.id)
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
            {...(route.seedQuestion === undefined ? {} : { seedQuestion: route.seedQuestion })}
          />
        ) : route.kind === 'report' ? (
          <DashboardPage
            session={state.session}
            reportId={route.id}
            schoolIds={selected}
            academicYear={home?.academic_year ?? null}
            onBack={() => { setRoute({ kind: 'home' }); }}
            onAskAI={(seedQuestion) => { setRoute({ kind: 'ask', seedQuestion }); }}
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

/** The crumb for a report route, before its spec has loaded. */
function titleOf(id: string): string {
  return id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}
