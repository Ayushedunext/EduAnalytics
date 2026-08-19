/**
 * Home (docs/10 §2), laid out to match the UX prototype (docs/11, Artifacts).
 *
 * -- Every number here is real -----------------------------------------------
 * The KPI row renders a hydrated chart-spec built by the orchestrator from live
 * replica data: SPA -> orchestrator -> MCP -> read replica. Nothing on this
 * screen is a placeholder figure. That matters more than it sounds: a dashboard
 * that looks finished and shows invented numbers is worse than one that admits
 * it has none, because only the second kind gets fixed.
 *
 * [MANDATORY] ADR-015 / CODING_GUIDELINES §4: the app renders SPECS. Values
 * arrive pre-formatted from the server precisely so the screen and the PDF
 * cannot format the same number differently, and nothing here is ever rendered
 * as markup.
 *
 * -- The locked ask-bar is load-bearing --------------------------------------
 * It renders locked whenever `ai_status !== 'active'` (ADR-017). The lock is
 * cosmetic on top of a real server-side 403 -- every `/api/ai/*` endpoint
 * re-checks the gate regardless of what this UI shows. It stays visible because
 * docs/10 §3 wants gated features discoverable: an admin who cannot see it
 * cannot learn that adding a key would unlock it.
 *
 * -- Three card states, deliberately distinct --------------------------------
 * `available` is built. `coming` means the serving path is not written yet.
 * `blocked` means the DATA does not exist -- attendance, exams, transport and
 * library have no tables in the ERP extract at all (AUDIT_REPORT C20). The
 * server decides which is which; this component only renders the verdict. They
 * look different because they need different people to fix them.
 */

import type { HomeResponse, SessionResponse, DashboardCard } from '../api/client';

interface Props {
  session: SessionResponse;
  home: HomeResponse;
  loading: boolean;
  onOpen: (reportId: string) => void;
}

export function Home({ session, home, loading, onOpen }: Props): JSX.Element {
  const aiActive = session.ai_status === 'active';
  const scopeNames = home.spec.meta.scope.map((s) => s.school_name).join(' · ');
  const director = home.dashboards.filter((c) => c.group === 'director');
  const school = home.dashboards.filter((c) => c.group === 'school');

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="px-7 py-6 max-w-[1180px]">
        <h1 className="page-title">
          {greeting()}, {session.user.role === 'DIRECTOR' ? 'Director ' : ''}
          {surname(session.user.name)}
        </h1>

        {/* docs/10 §3: scope line under the title, and an "as of" label because
            docs/03 assumption 2 accepts replica lag only if it is stated. */}
        <div className="page-sub">
          Scope: {scopeNames} · data as of {asOf(home.spec.meta.as_of ?? home.spec.meta.generated_at)}
          {loading && ' · refreshing…'}
        </div>

        {/* docs/02 §6: a school dropped from scope is surfaced, never silently
            filtered. */}
        {session.dropped_from_scope.length > 0 && (
          <div className="notice mb-4">
            {session.dropped_from_scope.length} school(s) in your token are not available for
            analytics right now and have been left out of your scope.
          </div>
        )}

        {/* ADR-011: a school that failed inside a fan-out is annotated, not
            dropped -- otherwise a total quietly shrinks. */}
        {home.degraded_schools.length > 0 && (
          <div className="notice mb-4">
            Some schools could not be reached, so these totals are partial:{' '}
            {home.degraded_schools.map((d) => d.school_id).join(', ')}.
          </div>
        )}

        <div className={`askbar mb-5 ${aiActive ? '' : 'locked'}`}>
          <div className="bot">🤖</div>
          <div className="ph">
            {aiActive
              ? 'Ask anything about your schools… e.g. “school-wise strength, gender-wise”'
              : '🔒 AI reports are locked — complete AI setup in Settings (predefined dashboards work now)'}
          </div>
          <div className="go">{aiActive ? 'Ask AI' : 'Locked'}</div>
        </div>

        <div className="kpis">
          {home.spec.widgets.map((widget) => (
            <div key={widget.id} className="card kpi">
              <b style={{ color: toneColour(widget.tone) }}>{widget.value}</b>
              <span>{widget.label}</span>
            </div>
          ))}

          {/*
            A metric the design calls for that has no source. Shown rather than
            omitted, with the reason: a tile quietly missing reads as an oversight,
            and "0%" would be actively false (CODING_GUIDELINES §10).
          */}
          {home.blocked_metrics.map((metric) => (
            <div key={metric.label} className="card kpi unavailable" title={metric.reason}>
              <b>—</b>
              <span>
                {metric.label}{' '}
                <span className="pill nodata ml-1">
                  {metric.kind === 'not_permitted' ? 'no access' : 'no data'}
                </span>
              </span>
            </div>
          ))}
        </div>

        <div className="sect">Director dashboards</div>
        <div className="gallery">
          {director.map((card) => (
            <Card key={card.id} card={card} tier="dir" onOpen={onOpen} />
          ))}
        </div>

        <div className="sect">School dashboards</div>
        <div className="gallery">
          {school.map((card) => (
            <Card key={card.id} card={card} tier="school" onOpen={onOpen} />
          ))}
        </div>

        <p className="text-[11.5px] text-[var(--color-muted)] mt-7 leading-relaxed">
          Scope comes from the launch token the ERP signed. It cannot be widened from this browser,
          every query is constrained to it, and all school data is read-only.
        </p>
      </div>
    </main>
  );
}

function Card({
  card,
  tier,
  onOpen,
}: {
  card: DashboardCard;
  tier: 'dir' | 'school';
  onOpen: (reportId: string) => void;
}): JSX.Element {
  const enabled = card.status === 'available';
  return (
    <div
      className={`card dcard ${enabled ? 'enabled' : 'disabled'}`}
      title={card.reason ?? card.blurb}
      onClick={() => {
        if (enabled) onOpen(card.id);
      }}
    >
      <div className={`ic ${tier === 'dir' ? 'dir' : ''}`}>{card.icon}</div>
      <div className="min-w-0">
        <b>
          {card.title}
          {card.status === 'coming' && <span className="pill soon ml-2">soon</span>}
          {card.status === 'blocked' && <span className="pill nodata ml-2">no data</span>}
        </b>
        <span className="blurb">{card.blurb}</span>
        {/* The reason is on the card, not only in a tooltip: "why can't I open
            this?" should not require hovering. */}
        {!enabled && card.reason !== undefined && <span className="why">{card.reason}</span>}
      </div>
    </div>
  );
}

/** docs/10 §1: colour is never the only signal, so tone pairs with the label. */
function toneColour(tone: string | undefined): string {
  switch (tone) {
    case 'warning':
      return 'var(--color-amber)';
    case 'negative':
      return 'var(--color-red)';
    case 'positive':
      return 'var(--color-mint)';
    default:
      return 'var(--color-teal)';
  }
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function surname(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1] ?? name;
}

function asOf(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return sameDay ? `today, ${time}` : date.toLocaleString();
}
