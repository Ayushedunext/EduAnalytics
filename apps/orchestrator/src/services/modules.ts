/**
 * The MODULE catalog — the seven subject areas a school's reports group into.
 *
 * Contract: docs/10 §2 (Module Wise Analysis) · docs/06 §2 (the predefined
 * catalog these group). No ADR is touched: a module is a way of ARRANGING the
 * report catalog, not a new serving path. Nothing here queries anything, no
 * module has its own SQL, and opening one still opens the same predefined
 * report through the same `buildDashboard` it always did.
 *
 * -- Why this file imports nothing from home.ts -------------------------------
 * The dependency runs one way on purpose: this file names the modules, and
 * `services/home.ts` says which module each REPORT belongs to (`DashboardCard.
 * modules`) and assembles the two into `servedModules()`. Pointing them at each
 * other would work under ESM and would be a cycle waiting to bite the first
 * time either side needed a value rather than a type from the other.
 *
 * -- Why the set is fixed here and not derived from the reports ---------------
 * A module is a promise about the school's WORLD — fees, staff, attendance,
 * transport, exams, students — not a bucket that exists because some report
 * happened to land in it. Deriving the list from the catalog would make Exam
 * disappear the moment its one report is withheld, and "we have no exam data"
 * is precisely what a school opening that tile needs to be told. So the seven
 * are declared, and a module with nothing to open says why (`servedModules`).
 */

export const MODULE_IDS = [
  'fees',
  'student',
  'staff',
  'attendance',
  'transport',
  'exam',
  'general',
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];

export function isModuleId(value: string): value is ModuleId {
  return (MODULE_IDS as readonly string[]).includes(value);
}

export interface ModuleDefinition {
  readonly id: ModuleId;
  readonly title: string;
  /** One line, on the tile. Says what the module COVERS, not how many reports it has. */
  readonly blurb: string;
  readonly icon: string;
}

/**
 * The seven tiles, in the order the screen draws them.
 *
 * The order is a ranking, the same way `DASHBOARD_GRID` is: money first,
 * because a Director and an Accountant both open Analytics for it; then the two
 * that describe the people in the building; then the operational two; then Exam,
 * which has no data yet; then General, which is deliberately last because it is
 * the "everything else" bucket and a reader should reach it after the named
 * ones, never instead of them.
 *
 * Icons are reused from the report cards they group (`DASHBOARDS`), not invented
 * — a reader who knows ₹ as Fee Collection should meet the same glyph on the
 * tile that contains it.
 */
export const MODULES: readonly ModuleDefinition[] = [
  {
    id: 'fees',
    title: 'Fees',
    blurb: 'Collection, arrears, per-student dues, and how this year compares',
    icon: '₹',
  },
  {
    id: 'student',
    title: 'Student',
    blurb: 'Enrollment and class mix, the admissions funnel, and long-run growth',
    icon: '🎓',
  },
  {
    id: 'staff',
    title: 'Staff',
    blurb: 'Headcount and mix by department, joiners and attrition, staff presence',
    icon: '👥',
  },
  {
    id: 'attendance',
    title: 'Attendance',
    blurb: 'Student and staff presence — monthly trend, class-wise rate, coverage',
    icon: '✅',
  },
  {
    id: 'transport',
    title: 'Transport',
    blurb: 'Route ridership by route, stop and class',
    icon: '🚌',
  },
  {
    id: 'exam',
    title: 'Exam',
    blurb: 'Term averages, subject distribution, toppers',
    icon: '🏅',
  },
  {
    id: 'general',
    title: 'General',
    blurb: 'Cross-module views and everything that belongs to no single subject',
    icon: '🏫',
  },
];

/**
 * One module as the SCREEN receives it: the definition above, plus the ids of
 * the reports in it that this build can actually open.
 *
 * `status` is the module-level answer to the same question `DashboardCard.
 * status` answers per report, and it is decided the same way — on the server,
 * from the catalog, never in the browser:
 *
 *   `available` — at least one report in it opens. `report_ids` is that list, in
 *                 catalog order, and every id on it is `available`.
 *   `empty`     — nothing in it opens, and `reason` says why, quoting the
 *                 withheld reports' own catalog reasons. Exam is the case that
 *                 exists today: the ERP extract carries no exam data
 *                 (AUDIT_REPORT C20), which is a fact about the extract that the
 *                 school reading the tile cannot fix but does need to know.
 *
 * An `empty` module is still SERVED, which is the one place the module screen
 * departs from `servedDashboards`' rule that a menu row must be a place you can
 * go (docs/10 §3). It is not a menu row: it is a tile in a fixed set of seven
 * that describes the school's world, and a set of seven with a hole in it says
 * "we forgot exams" where the tile says "the ERP sends us no exam data". The
 * tile does not click, so it never promises a screen.
 */
export interface ModuleCard extends ModuleDefinition {
  readonly report_ids: readonly string[];
  readonly status: 'available' | 'empty';
  readonly reason?: string;
}
