import type { DashboardCard } from '../api/client';

/**
 * The main navigation.
 *
 * docs/10 §2 fixes the inventory; the labels and order follow the UX prototype
 * (docs/11, Artifacts) so the built screen matches the design.
 *
 * [MANDATORY] docs/10 §3, "locked != hidden": gated features render with a lock
 * and a path to unlock rather than disappearing, because an admin who cannot see
 * a feature cannot discover that setting up a key would unlock it.
 *
 * -- Three states, not one -----------------------------------------------
 * A padlock is a claim about PERMISSION, and using it for everything unbuilt
 * tells an admin to go looking for a setting that does not exist. So:
 *
 *   locked  🔒  — really gated. Ask AI is gated on `ai_status` (ADR-017), and
 *                 that lock is cosmetic on top of a genuine server-side 403.
 *   soon        — the serving path is not built yet. Nothing to unlock.
 *   blocked  ⛔ — the DATA does not exist (AUDIT_REPORT C20). Not our setting
 *                 to change; it needs the ERP team.
 *
 * The distinction is the point: "you can't see this", "we haven't built this"
 * and "this data doesn't exist" send a user to three different places.
 */

interface Props {
  orgName: string;
  role: string;
  /** The catalog, with each entry's state decided by the server. */
  dashboards: readonly DashboardCard[];
  active: string;
  onNavigate: (id: string) => void;
}

const TRAIL: Record<'available' | 'coming' | 'blocked', string> = {
  available: '',
  coming: 'SOON',
  blocked: '⛔',
};

export function Sidebar({ orgName, role, dashboards, active, onNavigate }: Props): JSX.Element {
  /**
   * Which dashboards appear, and whether they are reachable, is the SERVER's
   * answer (services/home.ts), not a list maintained here. A sidebar with its
   * own opinion drifts from what the API will actually serve, and the drift
   * shows up as a menu item that 404s.
   */
  const items = dashboards.filter((d) => d.group === 'school' || d.group === 'director');

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="mark">📊</div>
        <div>
          <b>Analytics</b>
          <span>{orgName}</span>
        </div>
      </div>

      <ul className="nav">
        <li
          className={`clickable ${active === 'home' ? 'active' : ''}`}
          onClick={() => { onNavigate('home'); }}
        >
          <span className="w-4 text-center opacity-80">🏠</span>
          <span className="flex-1">Home</span>
        </li>

        {items.map((item) => {
          const enabled = item.status === 'available';
          return (
            <li
              key={item.id}
              className={
                enabled ? `clickable ${active === item.id ? 'active' : ''}` : 'muted'
              }
              title={item.reason ?? item.blurb}
              aria-disabled={!enabled}
              onClick={() => {
                if (enabled) onNavigate(item.id);
              }}
            >
              <span className="w-4 text-center opacity-80">{item.icon}</span>
              <span className="flex-1">{item.title}</span>
              {TRAIL[item.status] !== '' && <span className="trail">{TRAIL[item.status]}</span>}
            </li>
          );
        })}

        {/*
          Gated rather than unbuilt, and the distinction matters: Ask AI is
          locked by `ai_status` (ADR-017) and the padlock is cosmetic on top of a
          real server-side 403. Everything above is simply not written yet, which
          is a different message to a different person.
        */}
        <li className="muted" title="Complete AI setup in Settings">
          <span className="w-4 text-center opacity-80">🤖</span>
          <span className="flex-1">Ask AI</span>
          <span className="trail">🔒</span>
        </li>
        <li className="muted" title="Agent runtime is a later phase">
          <span className="w-4 text-center opacity-80">⚡</span>
          <span className="flex-1">Agents</span>
          <span className="trail">SOON</span>
        </li>
        <li className="muted" title="Saved reports need the report store (ADR-018)">
          <span className="w-4 text-center opacity-80">💾</span>
          <span className="flex-1">My Reports</span>
          <span className="trail">SOON</span>
        </li>
        <li className="muted" title="Not built yet">
          <span className="w-4 text-center opacity-80">⚙️</span>
          <span className="flex-1">Settings</span>
          <span className="trail">SOON</span>
        </li>
      </ul>

      {/*
        docs/10 §3: the user can always see where their identity came from and
        what they may do with it. Read-only is a property of the architecture
        (ADR-008), not a per-user setting, so it is stated as fact.
      */}
      <div className="foot">
        Signed in via the ERP
        <br />
        Role: {role} · read-only data
      </div>
    </aside>
  );
}
