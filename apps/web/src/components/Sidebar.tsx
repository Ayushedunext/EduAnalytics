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
  /**
   * The org's gating state (ADR-017), straight from the session. The padlock
   * beside Ask AI is derived from it rather than assumed — when an admin
   * connects a key in Settings, this prop changes and the lock goes with it.
   */
  aiStatus: string;
  active: string;
  onNavigate: (id: string) => void;
}

const TRAIL: Record<'available' | 'coming' | 'blocked', string> = {
  available: '',
  coming: 'SOON',
  blocked: '⛔',
};

export function Sidebar({
  orgName,
  role,
  dashboards,
  aiStatus,
  active,
  onNavigate,
}: Props): JSX.Element {
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

        {/**
         * Two different reasons Ask AI is not available, and it must show the
         * one that is true right now. Before a key: 🔒, and Settings is where
         * that is fixed. After a key: the lock is GONE — leaving it would tell
         * an admin their setup failed — and the trail becomes SOON, because the
         * chat screen itself is not written yet. Same entry, honest at both
         * moments (docs/10 §3's three states).
         */}
        <li
          className="muted"
          title={
            aiStatus === 'active'
              ? 'AI is unlocked for this org — the chat screen is not built yet'
              : 'Complete AI setup in Settings'
          }
        >
          <span className="w-4 text-center opacity-80">🤖</span>
          <span className="flex-1">Ask AI</span>
          <span className="trail">{aiStatus === 'active' ? 'SOON' : '🔒'}</span>
        </li>
        {/*
          Agents carries NO padlock at any ai_status, and that is not an
          oversight. The agent runtime is a later phase (ADR-022) and most of an
          agent — triggers, if/else flows, message actions — never touches the
          model at all; only "describe your workflow" and the AI-compose node are
          key-gated (docs/05 §4.4). Connecting a key therefore cannot unlock
          this: there is nothing built behind it to unlock.
        */}
        <li className="muted" title="Agent runtime is a later phase (ADR-022)">
          <span className="w-4 text-center opacity-80">⚡</span>
          <span className="flex-1">Agents</span>
          <span className="trail">SOON</span>
        </li>
        <li className="muted" title="Saved reports need the report store (ADR-018)">
          <span className="w-4 text-center opacity-80">💾</span>
          <span className="flex-1">My Reports</span>
          <span className="trail">SOON</span>
        </li>
        {/* Real, and reachable by everyone: what a non-admin sees there is the
            "contact your admin" state, which is information they need. Hiding
            the page from them would hide the reason AI is locked. */}
        <li
          className={`clickable ${active === 'settings' ? 'active' : ''}`}
          onClick={() => { onNavigate('settings'); }}
        >
          <span className="w-4 text-center opacity-80">⚙️</span>
          <span className="flex-1">Settings</span>
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
