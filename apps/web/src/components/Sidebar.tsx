import type { DashboardCard } from '../api/client';

/**
 * The main navigation.
 *
 * docs/10 §2 fixes the inventory; the labels and order follow the UX prototype
 * (docs/11, Artifacts) so the built screen matches the design.
 *
 * [MANDATORY] docs/10 §3, "locked ≠ hidden": a GATED feature renders with a
 * lock and a path to unlock rather than disappearing, because an admin who
 * cannot see a feature cannot discover that setting up a key would unlock it.
 * Ask AI below is that case, and the only one left in this menu.
 *
 * -- What a menu row promises (amended 2026-09-01) ---------------------------
 * The rule above is about a SIGNPOST. 🔒 points at Settings; the admin walks
 * there and the feature opens. It was being stretched to cover two states that
 * point nowhere — `coming` (the serving path is not built: the rollup store,
 * ADR-010, and the agent runtime, ADR-022) and `blocked` (the ERP extract has
 * no such data, AUDIT_REPORT C20) — and no role, key or setting opens either.
 *
 * So they are not here. The server withholds them (`servedDashboards` in
 * services/home.ts), which is why this file no longer needs a trail glyph and
 * no longer hand-writes an "Agents · SOON" row of its own: every row in this
 * list, apart from a key-less Ask AI, is a place you can go. The reasons live
 * on in the catalog, where the people who can act on them read them, and a card
 * returns to this menu by turning `available` — not by anyone editing here.
 *
 * -- One row where twelve used to be (amended 2026-09-01) --------------------
 * Every predefined report had its own row here. That is the list this menu was
 * designed around when there were four of them; at twelve it had become the
 * thing a reader scrolls past, and it grew by one every time a dashboard was
 * built — an inventory, sorted by nothing a reader cares about, where a menu
 * should be a small set of places.
 *
 * So the reports now live behind **Module Wise Analysis** (components/
 * Modules.tsx), grouped by the part of the school they are about. Nothing became
 * unreachable: a report opens from its module, from a Dashboard grid card, and
 * from Home's "More dashboards" strip.
 *
 * TREND ANALYSIS and COMPARATIVE ANALYSIS keep rows of their own, and the
 * exception is deliberate rather than a leftover. Both are cross-cutting reads
 * — six years of collection against twelve of enrollment, this year's recovery
 * against last — that a Director opens as a habit rather than as "the fee
 * report I want today"; filing them one level down would put a routine
 * destination behind a category. They are also still IN their modules, because
 * a reader who goes looking under Fees should find them there too. A shortcut,
 * not a second copy.
 *
 * Both rows are read out of the catalog by id (`PINNED` below) rather than
 * typed here, so their titles and icons remain the server's words — a report
 * renamed in the catalog renames itself in this menu, and one withheld drops
 * out of it without leaving a row that goes nowhere.
 */

/**
 * The reports that keep a menu row of their own, in the order they appear.
 *
 * Ids, not cards: the row's title, icon and very existence still come from the
 * served catalog. An id here that the server does not serve simply renders
 * nothing, which is the correct behaviour for a report that has been withheld —
 * the shortcut disappears with the destination.
 */
const PINNED: readonly string[] = ['trend-analysis', 'fee-comparative'];

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

export function Sidebar({
  orgName,
  role,
  dashboards,
  aiStatus,
  active,
  onNavigate,
}: Props): JSX.Element {
  /**
   * The pinned reports' cards, in `PINNED` order and skipping any the server did
   * not serve.
   *
   * Which dashboards exist and whether they are reachable is still the SERVER's
   * answer (services/home.ts), never a list maintained here. What this file now
   * decides is only which TWO of them get a shortcut, which is a navigation
   * decision and belongs to the navigation.
   */
  const pinned = PINNED.flatMap((id) => {
    const card = dashboards.find((d) => d.id === id);
    return card === undefined ? [] : [card];
  });

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
        {/**
         * "Dashboard", not "Home" (renamed 2026-08-31). The screen is the
         * overview a user lands on; what sits BELOW it leads to the predefined
         * reports, which docs/00's glossary and this codebase's own identifiers
         * call "dashboards" (DASHBOARD_IDS, DashboardPage.tsx, buildDashboard).
         * Both senses share one menu, so the plural is deliberately never a nav
         * label here: a "Dashboards" group listed under a "Dashboard" item reads
         * as a typo rather than a hierarchy.
         *
         * Only the LABEL moved. The route key, `/api/home` and Home.tsx keep
         * their names — `Dashboard*` is already taken across the orchestrator for
         * the predefined reports, and renaming into that collision would make
         * the code less clear, not more.
         *
         * 📈 and not 📊: the bar-chart glyph is the brand mark three rows
         * above (`.mark`), and a nav item wearing the product’s own logo reads as
         * a second brand rather than a destination. 🏠 went with the "Home"
         * label — it named where the screen sat in the nav, and the screen is now
         * named for what it shows.
         */}
        <li
          className={`clickable ${active === 'home' ? 'active' : ''}`}
          onClick={() => { onNavigate('home'); }}
        >
          <span className="w-4 text-center opacity-80">📈</span>
          <span className="flex-1">Dashboard</span>
        </li>

        {pinned.map((item) => {
          /**
           * The server serves only `available` cards, so this is always true
           * today. It is still asked, rather than assumed: `status` is data off
           * the wire and the type still carries three values, so a card that
           * somehow arrives unopenable renders inert with its reason on hover
           * instead of routing to a screen that 404s. What it will NOT do is
           * decorate itself — a trail glyph here would be a second, quieter
           * place for the withheld states to come back.
           */
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
            </li>
          );
        })}

        {/**
         * Every other predefined report, one level down and grouped by subject
         * (components/Modules.tsx). The row stays `active` while a module or a
         * report opened FROM one is on screen (App.tsx decides that), so a
         * reader three clicks into Fees ▸ Fee Defaulters ▸ a drill level can
         * still see which part of the menu they are standing in.
         *
         * 🧩 rather than a subject glyph of its own: the two rows above are
         * reports and wear their reports' icons, and the row that is a CONTAINER
         * for the other eleven should not dress as a twelfth report.
         */}
        <li
          className={`clickable ${active === 'modules' ? 'active' : ''}`}
          title="All reports, grouped by fees, students, staff, attendance, transport and exams"
          onClick={() => { onNavigate('modules'); }}
        >
          <span className="w-4 text-center opacity-80">🧩</span>
          <span className="flex-1">Module Wise Analysis</span>
        </li>

        {/**
         * Two different reasons Ask AI could be unreachable, and it must show
         * the one that is true right now. Before a key: 🔒, and Settings is
         * where that is fixed — the item stays `muted` and unclickable. After a
         * key: the lock is GONE — leaving it would tell an admin their setup
         * failed — and the item becomes `clickable` like any other real screen,
         * because the chat screen is built now (docs/10 §3's three states).
         */}
        <li
          className={aiStatus === 'active' ? `clickable ${active === 'ask' ? 'active' : ''}` : 'muted'}
          title={aiStatus === 'active' ? 'Ask AI about your schools' : 'Complete AI setup in Settings'}
          onClick={() => {
            if (aiStatus === 'active') onNavigate('ask');
          }}
        >
          <span className="w-4 text-center opacity-80">🤖</span>
          <span className="flex-1">Ask AI</span>
          {aiStatus !== 'active' && <span className="trail">🔒</span>}
        </li>
        <li
          className={`clickable ${active === 'my-reports' ? 'active' : ''}`}
          title="Your cloned dashboards and saved Ask AI reports"
          onClick={() => { onNavigate('my-reports'); }}
        >
          <span className="w-4 text-center opacity-80">💾</span>
          <span className="flex-1">My Reports</span>
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
