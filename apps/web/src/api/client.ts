/**
 * The only way this app talks to a server.
 *
 * [MANDATORY] CODING_GUIDELINES §4: components stay presentational; data access
 * goes through a thin API layer that only ever calls the orchestrator. §1: the
 * browser bundle can never contain DB or AI credentials, and there is no
 * dependency path from here to the MCP server or a database driver.
 *
 * Everything this app knows about identity comes from the server. The SPA never
 * supplies a school_id it invented, and never decides what a user may see -- it
 * renders what the orchestrator reports (CODING_GUIDELINES §8). A school
 * selection sent with a request can only NARROW within the session's scope; the
 * orchestrator validates it against the launch token and the MCP server checks
 * it again (ADR-007).
 */

const API_BASE = import.meta.env['VITE_API_BASE'] ?? 'http://localhost:3000';

/** ADR-029 clause 3: the CSRF token is echoed from a cookie into a header. */
const CSRF_COOKIE = 'sap_csrf';
const CSRF_HEADER = 'x-csrf-token';

function readCookie(name: string): string | undefined {
  return document.cookie
    .split('; ')
    .find((c) => c.startsWith(name + '='))
    ?.split('=')[1];
}

/** The structured error shape every endpoint returns (CODING_GUIDELINES §6). */
export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, string | number | boolean | null>;
  correlation_id?: string;
}

export class ApiFailure extends Error {
  readonly code: string;
  readonly status: number;
  readonly correlationId: string | undefined;

  constructor(status: number, error: ApiError) {
    super(error.message);
    this.name = 'ApiFailure';
    this.code = error.code;
    this.status = status;
    this.correlationId = error.correlation_id;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);

  // Only mutating requests need the CSRF token; GET/HEAD are side-effect-free
  // by contract (ADR-029 clause 3).
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const token = readCookie(CSRF_COOKIE);
    if (token !== undefined) headers.set(CSRF_HEADER, token);
    headers.set('content-type', 'application/json');
  }

  const res = await fetch(API_BASE + path, {
    ...init,
    headers,
    // The session is an httpOnly cookie, so it must be sent explicitly on a
    // cross-origin request. httpOnly means this script cannot read it -- which
    // is the point (docs/08 §2).
    credentials: 'include',
  });

  if (!res.ok) {
    let body: ApiError = { code: 'UNKNOWN', message: res.statusText };
    try {
      body = (await res.json()) as ApiError;
    } catch {
      /* a non-JSON error body stays as the status text */
    }
    throw new ApiFailure(res.status, body);
  }

  return (await res.json()) as T;
}

/** What /api/session returns. Mirrors the orchestrator route exactly. */
export interface SessionResponse {
  user: { name: string; role: string };
  org_id: string;
  /** The registry's display name for the org; never invented client-side. */
  org_name: string;
  scope: { school_id: string; school_name: string }[];
  default_school: string;
  perms: string[];
  /** Schools in the token the registry cannot serve (docs/02 §6). Never hidden. */
  dropped_from_scope: string[];
  /** Per-org AI gating state (ADR-017). The server decides; the UI only reflects. */
  ai_status: string;
  /**
   * Whether THIS user could fix an unconfigured org. Also the server's answer,
   * not a role check the client makes for itself — docs/10 §2 gives admins
   * "Set up now →" and everyone else "ask your administrator".
   */
  can_configure_ai: boolean;
}

export function getSession(): Promise<SessionResponse> {
  return request<SessionResponse>('/api/session');
}

// -- Home -------------------------------------------------------------------

/**
 * The hydrated chart-spec (ADR-015). The SPA renders SPECS, never anything the
 * server or a model describes as markup -- CODING_GUIDELINES §4 forbids
 * `dangerouslySetInnerHTML` and rendering model-provided HTML anywhere.
 *
 * Only the widget kinds Home uses are typed here. The full contract lives in
 * `@sap/chart-spec`; when the chart layer lands it imports those types directly
 * rather than this local narrowing.
 */
export interface KpiWidget {
  id: string;
  type: 'kpi';
  label: string;
  value: string;
  delta?: string;
  tone?: 'neutral' | 'positive' | 'warning' | 'negative';
}

export interface ChartSpecLike {
  spec_version: 1;
  title: string;
  narrative?: string;
  widgets: KpiWidget[];
  meta: {
    scope: { school_id: string; school_name: string }[];
    generated_at: string;
    as_of?: string;
    /** Which of the three serving tiers answered (ADR-028). */
    served_from: 'cache' | 'rollup' | 'replica';
  };
}

export interface DashboardCard {
  id: string;
  title: string;
  blurb: string;
  icon: string;
  group: 'director' | 'school';
  /**
   * `coming` means the serving path is not built; `blocked` means the DATA does
   * not exist. Different problems with different owners, so the UI shows them
   * differently rather than flattening both into a padlock.
   */
  status: 'available' | 'coming' | 'blocked';
  reason?: string;
  /** Which module tiles this report appears under (services/modules.ts). */
  modules: string[];
}

/**
 * One Module Wise Analysis tile, as the SERVER assembles it (services/home.ts,
 * `servedModules`). `report_ids` names the reports inside it, in the order the
 * module screen draws them; the card for each is still read out of
 * `HomeResponse.dashboards`, so there is one description of a report and this is
 * only a grouping of it.
 *
 * `status: 'empty'` means nothing in the module opens and `reason` says why —
 * Exam today, because the ERP extract carries no exam data. The tile renders
 * inert with that reason on it rather than disappearing: seven tiles describe
 * the school's world, and a missing one reads as an oversight where a stated
 * reason reads as a fact.
 */
export interface ModuleCard {
  id: string;
  title: string;
  blurb: string;
  icon: string;
  report_ids: string[];
  status: 'available' | 'empty';
  reason?: string;
}

export interface HomeResponse {
  spec: ChartSpecLike;
  /** The year the app OPENS on. The server's, derived from the data (home.ts). */
  academic_year: string | null;
  /**
   * The years the selected schools hold data for, newest first — the options
   * the topbar's year control offers.
   *
   * Never derived here from `academic_year`. The report-level "Compare with"
   * control does derive its options (DashboardPage.tsx `precedingYears`) and
   * says why: there is no endpoint that lists the years a school's FEE tables
   * hold, and adding a query to find out would cost a scan on every page load.
   * This list has no such excuse — `/api/home` reads the years as a side effect
   * of the KPI strip it was already fetching — so guessing them would be
   * offering a school years it has nothing for while hiding ones it does.
   */
  academic_years: string[];
  /**
   * Metrics that could not be shown, and why. `no_data` means the ERP holds
   * none (AUDIT_REPORT C20); `not_permitted` means this session's perms do not
   * cover the domain (docs/08 §4.5). Never rendered as zero -- a false number
   * is worse than an absent one.
   */
  blocked_metrics: { label: string; reason: string; kind: 'no_data' | 'not_permitted' }[];
  /**
   * Metrics whose figure covers only some of the selected schools, and which
   * schools are missing by name.
   *
   * Schools roll their student roll over at different times, so the year the
   * strip resolved to may be a year some of the selection has no rows for at
   * all. Those schools contribute nothing to the sum, and without this the total
   * looked like a whole-trust figure. Annotated rather than silently reduced,
   * exactly as `degraded_schools` is (ADR-011).
   */
  partial_metrics: { label: string; schools: string[] }[];
  dashboards: DashboardCard[];
  /**
   * Which dashboards the grid draws, in the order it draws them (services/
   * home.ts `DASHBOARD_GRID`). Ids, not cards -- the card itself is still read
   * out of `dashboards`, so there is one description of a dashboard and this is
   * only a ranking of it.
   *
   * The SPA does not decide this and must not re-derive it. What the overview
   * leads with is a product decision the server makes; a filter in the browser
   * would be a second copy of that rule, free to disagree with the first.
   */
  grid: string[];
  /**
   * The Module Wise Analysis tiles, in the server's order. Travels with Home
   * because it is static catalog metadata — no query, no scope — and because
   * the sidebar, the tiles and the report cards must read one answer about what
   * this build can open.
   */
  modules: ModuleCard[];
  /** Schools that failed inside a fan-out. Annotated, never dropped (ADR-011). */
  degraded_schools: { school_id: string; message: string }[];
}

/**
 * `schoolIds` narrows the request within the session's scope. It is sent as a
 * selection, not an assertion: the orchestrator checks it against the launch
 * token and the MCP server checks it again, so a tampered value fails twice
 * rather than widening anything.
 */
// -- Reports ----------------------------------------------------------------

export interface ReportLogic {
  source: string;
  scope: { school_id: string; school_name: string }[];
  filters: { label: string; value: string }[];
  group_by: string[];
  charts: string[];
  /** Invariant 6: the statement behind every panel, shown read-only. */
  queries: { key: string; description: string; sql: string }[];
  notes: string[];
}

export interface DashboardResponse {
  /**
   * A full chart-spec. Typed loosely here because the renderer in
   * `@sap/chart-spec/react` validates it against the schema before drawing —
   * narrowing it in the client would be a second, weaker copy of that check.
   */
  spec: {
    spec_version: 1;
    title: string;
    widgets: unknown[];
    meta: {
      scope: { school_id: string; school_name: string }[];
      generated_at: string;
      as_of?: string;
      served_from: 'cache' | 'rollup' | 'replica';
      report_id?: string;
    };
  };
  logic: ReportLogic;
  degraded: { key: string; message: string }[];
  degraded_schools: { school_id: string; message: string }[];
}

/**
 * The comparison year a year-on-year report is measured against.
 *
 * Omitted for every report that does not take one, and omissible even for the
 * one that does: the server derives the preceding year, so the SPA never has to
 * hold an opinion it did not get from the reader. Passing it is what makes the
 * "Compare with" control do something.
 */
export interface ReportFilters {
  compareYear?: string | undefined;
}

function reportQuery(
  schoolIds: readonly string[],
  academicYear: string,
  filters: ReportFilters = {},
): URLSearchParams {
  const query = new URLSearchParams({ academic_year: academicYear });
  if (schoolIds.length > 0) query.set('school_ids', schoolIds.join(','));
  if (filters.compareYear !== undefined && filters.compareYear !== '') {
    query.set('compare_year', filters.compareYear);
  }
  return query;
}

export function getReport(
  reportId: string,
  schoolIds: readonly string[],
  academicYear: string,
  filters: ReportFilters = {},
): Promise<DashboardResponse> {
  const query = reportQuery(schoolIds, academicYear, filters);
  return request<DashboardResponse>(`/api/report/${encodeURIComponent(reportId)}?${query.toString()}`);
}

/** One clicked `{dim, value}` pair, with the text the breadcrumb shows for it. */
export interface DrillStep {
  dim: string;
  value: string;
  label: string;
}

export interface DrillResponse {
  /** Unknown on purpose -- the renderer validates it before drawing (§10). */
  widget: unknown;
  level: 1 | 2 | 3;
  context: DrillStep[];
  /** The schools this level actually read, after a school click narrowed them. */
  school_ids: string[];
  /** Invariant 6: docs/06 §4.4 puts every level's SQL in the logic panel. */
  query: { key: string; description: string; sql: string };
  group_by: string;
  /**
   * Caveats true at THIS level, shown against the chart. Fee Defaulters' quarter
   * bars are the reason: they are honest per-quarter headcounts that must not be
   * added up, and a warning in the report's notes list is one a reader has
   * already scrolled past.
   */
  notes: string[];
  degraded: { key: string; message: string }[];
  degraded_schools: { school_id: string; message: string }[];
}

/**
 * One level of a drill path (ADR-020).
 *
 * A POST, so it carries the CSRF token like every other mutating call --
 * `request` adds it. The click is a read, but it is audited as its own event
 * (docs/08 §7), which is what makes it a POST rather than a link.
 *
 * The filters go in the query string and the drill context in the body: the
 * server validates the filters with the same code the report view and the PDF
 * use, and only the context is new.
 */
export function drillReport(
  reportId: string,
  schoolIds: readonly string[],
  academicYear: string,
  body: { widget_id: string; level: number; context: readonly DrillStep[] },
  filters: ReportFilters = {},
): Promise<DrillResponse> {
  const query = reportQuery(schoolIds, academicYear, filters);
  return request<DrillResponse>(
    `/api/report/${encodeURIComponent(reportId)}/drill?${query.toString()}`,
    { method: 'POST', body: JSON.stringify({ ...body, context: [...body.context] }) },
  );
}

/**
 * `academicYear` is omitted on the first load and sent once the reader picks one
 * in the topbar. Omitting it is not the same as sending the year the server last
 * resolved: absent means "work it out from the data", which is what makes the
 * app open on a year each school actually has, and what keeps the response
 * cacheable under the key every user of that school shares.
 */
export function getHome(
  schoolIds: readonly string[],
  academicYear?: string,
): Promise<HomeResponse> {
  const query = new URLSearchParams();
  if (schoolIds.length > 0) query.set('school_ids', schoolIds.join(','));
  if (academicYear !== undefined) query.set('academic_year', academicYear);
  const suffix = query.toString();
  return request<HomeResponse>(`/api/home${suffix === '' ? '' : `?${suffix}`}`);
}

/**
 * One dashboard's lead widget, for the Home overview's preview cards.
 * `status: 'blocked'` covers both "no permission" and "no data for this
 * period" -- either way there is nothing to show, and `reason` says why.
 */
export interface HomePreview {
  id: string;
  title: string;
  icon: string;
  /** Unknown on purpose -- WidgetSpecView validates it before it is drawn (§10). */
  widget: unknown;
  status: 'ok' | 'blocked';
  reason?: string;
}

/**
 * ONE preview card, fetched on its own.
 *
 * Fetched separately from `/api/home` and only once the academic year it needs
 * is known (services/home.ts explains why): Home's KPI strip renders from
 * `getHome` immediately, and each card fills in as its own request resolves.
 *
 * One request per card rather than one for all of them, because a single
 * response can only be as fast as its slowest dashboard — the fee scans used to
 * hold back cards that had been ready for six seconds (routes/home.ts).
 */
export function getHomePreview(
  schoolIds: readonly string[],
  academicYear: string,
  reportId: string,
): Promise<HomePreview> {
  const query = new URLSearchParams({ academic_year: academicYear });
  if (schoolIds.length > 0) query.set('school_ids', schoolIds.join(','));
  return request<HomePreview>(
    `/api/home/preview/${encodeURIComponent(reportId)}?${query.toString()}`,
  );
}

// -- Custom reports (ADR-018) -------------------------------------------------

export interface CustomReportSummary {
  id: string;
  name: string;
  source_kind: 'predefined_clone' | 'ai_saved';
  base_report_id: string | null;
  /** The base dashboard's display title, resolved server-side; null for AI-saved reports. */
  base_report_title: string | null;
  /** Resolved names, not ids — the Scope column shows these verbatim. */
  school_scope: { school_id: string; school_name: string }[];
  current_version: number;
  shared_flag: 'private' | 'school' | 'trust';
  is_owner: boolean;
  updated_at: string;
}

/** One thing a new custom report can be built from ("＋ New custom report", docs/06 §3). */
export interface ReportSource {
  report_id: string;
  title: string;
  blurb: string;
  icon: string;
  group: 'director' | 'school';
  filters: { academic_year: boolean; as_of: boolean };
}

export function listReportSources(): Promise<{ sources: ReportSource[] }> {
  return request<{ sources: ReportSource[] }>('/api/reports/sources');
}

/** "⧉ Clone" on a My Reports row — a private copy of a report you can already see. */
export function duplicateReport(id: string, name: string): Promise<CustomReportResponse> {
  return request<CustomReportResponse>(`/api/reports/${encodeURIComponent(id)}/duplicate`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

/**
 * Same shape as `DashboardResponse`, plus the fields that make it a custom
 * report rather than a predefined one: `mode` (how it executes — see
 * services/custom-reports.ts), `current_version` and the ownership/promotion
 * flags a My Reports screen needs to decide what to show.
 */
export interface CustomReportResponse {
  id: string;
  name: string;
  source_kind: 'predefined_clone' | 'ai_saved';
  base_report_id: string | null;
  shared_flag: 'private' | 'school' | 'trust';
  mode: 'template' | 'raw_sql';
  current_version: number;
  is_owner: boolean;
  can_promote: boolean;
  spec: DashboardResponse['spec'];
  logic: ReportLogic;
  degraded: { key: string; message: string }[];
  degraded_schools: { school_id: string; message: string }[];
}

export interface ReportVersionSummary {
  version: number;
  edited_by: string;
  edited_at: string;
}

export function listMyReports(): Promise<{ reports: CustomReportSummary[] }> {
  return request<{ reports: CustomReportSummary[] }>('/api/reports');
}

export function cloneReport(body: {
  base_report_id: string;
  name: string;
  academic_year: string;
  as_of?: string;
  /** The comparison year on screen, for a year-on-year report (see `getReport`). */
  compare_year?: string;
  school_ids: readonly string[];
  /** Per-widget clone (docs/06 §3): clone just this one chart. */
  widget_id?: string;
  /** Time-grouping override — only meaningful together with `widget_id`. */
  bucket?: 'week' | 'month' | 'quarter' | 'year';
}): Promise<CustomReportResponse> {
  const query = new URLSearchParams();
  if (body.school_ids.length > 0) query.set('school_ids', body.school_ids.join(','));
  return request<CustomReportResponse>(`/api/reports/clone?${query.toString()}`, {
    method: 'POST',
    body: JSON.stringify({
      base_report_id: body.base_report_id,
      name: body.name,
      academic_year: body.academic_year,
      ...(body.compare_year === undefined ? {} : { compare_year: body.compare_year }),
      ...(body.as_of === undefined ? {} : { as_of: body.as_of }),
      ...(body.widget_id === undefined ? {} : { widget_id: body.widget_id }),
      ...(body.bucket === undefined ? {} : { bucket: body.bucket }),
    }),
  });
}

export function saveAiReportAsCustom(body: {
  name: string;
  school_ids: readonly string[];
  queries: readonly AskAiQuery[];
  draft: AskAiDraft;
}): Promise<CustomReportResponse> {
  const query = new URLSearchParams();
  if (body.school_ids.length > 0) query.set('school_ids', body.school_ids.join(','));
  return request<CustomReportResponse>(`/api/reports/from-ai?${query.toString()}`, {
    method: 'POST',
    body: JSON.stringify({ name: body.name, queries: body.queries, draft: body.draft }),
  });
}

export function getCustomReport(id: string, schoolIds: readonly string[]): Promise<CustomReportResponse> {
  const query = schoolIds.length > 0 ? `?school_ids=${encodeURIComponent(schoolIds.join(','))}` : '';
  return request<CustomReportResponse>(`/api/reports/${encodeURIComponent(id)}${query}`);
}

export function updateReportVisual(
  id: string,
  body: { academic_year: string; as_of?: string; chart_overrides?: Record<string, 'bar' | 'line'> },
): Promise<CustomReportResponse> {
  return request<CustomReportResponse>(`/api/reports/${encodeURIComponent(id)}/visual`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export function updateReportSql(
  id: string,
  body: { queries: { key: string; sql: string }[]; draft: AskAiDraft },
): Promise<CustomReportResponse> {
  return request<CustomReportResponse>(`/api/reports/${encodeURIComponent(id)}/sql`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

/** "Apply" in the Ask AI side panel — persists an AI-proposed answer as this report's next version (docs/06 §1's "✎ Refine with AI"). */
export function applyRefinement(
  id: string,
  body: { queries: { key: string; sql: string }[]; draft: AskAiDraft },
): Promise<CustomReportResponse> {
  return request<CustomReportResponse>(`/api/reports/${encodeURIComponent(id)}/refine`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export function listReportVersions(id: string): Promise<{ versions: ReportVersionSummary[] }> {
  return request<{ versions: ReportVersionSummary[] }>(`/api/reports/${encodeURIComponent(id)}/versions`);
}

export function rollbackReport(id: string, version: number): Promise<CustomReportResponse> {
  return request<CustomReportResponse>(`/api/reports/${encodeURIComponent(id)}/rollback`, {
    method: 'POST',
    body: JSON.stringify({ version }),
  });
}

export function setReportVisibility(
  id: string,
  sharedFlag: 'private' | 'school' | 'trust',
): Promise<void> {
  return request<void>(`/api/reports/${encodeURIComponent(id)}/visibility`, {
    method: 'PUT',
    body: JSON.stringify({ shared_flag: sharedFlag }),
  });
}

export function deleteReport(id: string): Promise<void> {
  return request<void>(`/api/reports/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function customReportPdfUrl(
  id: string,
  schoolIds: readonly string[],
  options: { logic?: boolean } = {},
): string {
  const query = new URLSearchParams();
  if (schoolIds.length > 0) query.set('school_ids', schoolIds.join(','));
  if (options.logic === true) query.set('logic', '1');
  return `${API_BASE}/api/reports/${encodeURIComponent(id)}/export.pdf?${query.toString()}`;
}

// -- Settings ----------------------------------------------------------------

/** ADR-031: an org picks one provider at a time; `provider` says which. */
export type AiProviderId = 'anthropic' | 'gemini';

/**
 * Everything Settings needs to know about one provider — server-supplied, not
 * hardcoded here, for the same reason `models` always was: a provider's model
 * catalog and console URL are the platform's facts, not the client's.
 */
export interface ProviderMeta {
  id: AiProviderId;
  label: string;
  console_url: string;
  key_placeholder: string;
  /** A reliable prefix real keys start with, or null when the provider has none worth asserting on. */
  key_prefix: string | null;
  models: { id: string; label: string }[];
}

/**
 * The AI configuration as the SERVER reports it.
 *
 * Note what is absent: the API key. It can be written and never read back —
 * `key_hint` (e.g. `sk-ant-…1G4a`) is the only key-derived value that crosses
 * this boundary, which is what makes ADR-017's "operators cannot read tenant
 * keys in plaintext" true of the API and not only of the database.
 */
export interface AiConfig {
  ai_status: 'not_configured' | 'pending_validation' | 'active' | 'error';
  provider: AiProviderId;
  model: string;
  billing_mode: 'byok' | 'platform';
  monthly_query_cap: number;
  key_hint: string | null;
  last_validated_at: string | null;
  last_error: string | null;
}

export interface ChannelRow {
  school_id: string;
  school_name: string;
  channel: 'email' | 'sms' | 'whatsapp';
  title: string;
  icon: string;
  status: 'connected' | 'not_connected';
  detail: string | null;
  requirement: string;
}

export interface SettingsResponse {
  org_id: string;
  org_name: string;
  school_count: number;
  ai: AiConfig;
  /** Server-decided: may this session configure the key at all? */
  can_configure: boolean;
  /** The platform's wording for a non-admin, so screen and 403 body agree. */
  contact_admin: string;
  providers: ProviderMeta[];
  channels: ChannelRow[];
}

/** `error` is the PROVIDER's verdict in plain language, not a transport error. */
export interface AiSaveResponse {
  ai: AiConfig;
  error: string | null;
}

export function getSettings(): Promise<SettingsResponse> {
  return request<SettingsResponse>('/api/settings');
}

/**
 * The key leaves the browser exactly once, over the same credentialed request
 * as everything else, and is never stored client-side — not in state that
 * outlives the submit, not in localStorage, not in the URL.
 */
export function saveAiKey(body: {
  provider: AiProviderId;
  api_key: string;
  model: string;
  monthly_query_cap: number;
}): Promise<AiSaveResponse> {
  return request<AiSaveResponse>('/api/settings/ai', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export function disableAi(): Promise<AiSaveResponse> {
  return request<AiSaveResponse>('/api/settings/ai/disable', { method: 'POST' });
}

export function disconnectChannel(
  schoolId: string,
  channel: string,
): Promise<{ channels: ChannelRow[] }> {
  return request<{ channels: ChannelRow[] }>(
    `/api/settings/channels/${encodeURIComponent(schoolId)}/${encodeURIComponent(channel)}/disconnect`,
    { method: 'POST' },
  );
}

/**
 * The PDF is fetched by the BROWSER following a link, not by this module.
 *
 * A `fetch` here would have to buffer a multi-megabyte binary into memory and
 * then re-offer it as a blob, which is more code and a worse download: no
 * progress, no resume, and a filename this script would have to invent. The
 * server already sets `Content-Disposition`, so a plain navigation does the
 * right thing -- and the session cookie rides along with it.
 */
export function reportPdfUrl(
  reportId: string,
  schoolIds: readonly string[],
  academicYear: string,
  options: { logic?: boolean } & ReportFilters = {},
): string {
  const query = reportQuery(schoolIds, academicYear, options);
  if (options.logic === true) query.set('logic', '1');
  return `${API_BASE}/api/report/${encodeURIComponent(reportId)}/export.pdf?${query.toString()}`;
}

// -- Ask AI (ADR-030) ---------------------------------------------------------

/**
 * A fully hydrated chart-spec, same as a report's — Ask AI shares the one
 * rendering vocabulary (ADR-015). Typed loosely for the same reason
 * `DashboardResponse['spec']` is: `ChartSpecView` validates against the real
 * schema in `@sap/chart-spec` before drawing, so narrowing it again here would
 * be a second, weaker copy of that check.
 */
export interface AskAiSpec {
  spec_version: 1;
  title: string;
  narrative?: string;
  widgets: unknown[];
  meta: {
    scope: { school_id: string; school_name: string }[];
    generated_at: string;
    as_of?: string;
    served_from: 'cache' | 'rollup' | 'replica';
  };
}

/** One statement Ask AI ran — what "Save as report" persists (AUDIT_REPORT C17). */
export interface AskAiQuery {
  key: string;
  sql: string;
}

/**
 * The model-facing draft (before hydration) — carried down so "Save as
 * report" can persist exactly what re-executes later, matching what
 * services/ai-chat.ts already validates server-side. Typed loosely for the
 * same reason `AskAiSpec` is: the server is the source of truth for its shape.
 */
export interface AskAiDraft {
  spec_version: 1;
  title: string;
  narrative?: string;
  widgets: unknown[];
}

/**
 * The stream this endpoint sends: zero or more `status` steps (docs/05 §2's
 * "Scope confirmed → Planning → Running query → Building chart" trust device),
 * then exactly one `result` or `error`.
 */
export type AskAiEvent =
  | { type: 'status'; step: string }
  | { type: 'result'; spec: AskAiSpec; queries: AskAiQuery[]; draft: AskAiDraft; logic: ReportLogic }
  | { type: 'error'; code: string; message: string };

/**
 * Not `request()`: that helper always resolves the whole body as one JSON
 * value, and this endpoint's whole point is to hand events to the caller as
 * they arrive rather than after everything is in. Still the same CSRF-cookie
 * echo and credentialed-fetch pattern as every other mutating call.
 */
/** "✎ Refine" on an Ask AI answer that has not been saved yet — the same seed shape a saved report's `report_id` produces server-side, just echoed straight from the turn already on screen (docs/06 §1). */
export interface AskAiInlineSeed {
  reportName: string;
  queries: readonly AskAiQuery[];
  widgets: readonly unknown[];
}

export async function askAI(
  question: string,
  schoolIds: readonly string[],
  onEvent: (event: AskAiEvent) => void,
  /** "✎ Refine with AI" (docs/06 §1): seeds this turn from an existing report's current definition instead of a blank question. */
  reportId?: string,
  /** Mutually exclusive with `reportId` — set only when refining an unsaved turn, which has no report id yet. */
  inlineSeed?: AskAiInlineSeed,
): Promise<void> {
  const query = schoolIds.length > 0 ? `?school_ids=${encodeURIComponent(schoolIds.join(','))}` : '';
  const headers = new Headers({ 'content-type': 'application/json' });
  const token = readCookie(CSRF_COOKIE);
  if (token !== undefined) headers.set(CSRF_HEADER, token);

  const res = await fetch(`${API_BASE}/api/ai/ask${query}`, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify({
      question,
      ...(reportId === undefined ? {} : { report_id: reportId }),
      ...(inlineSeed === undefined
        ? {}
        : { seed: { report_name: inlineSeed.reportName, queries: inlineSeed.queries, widgets: inlineSeed.widgets } }),
    }),
  });

  if (!res.ok) {
    let body: ApiError = { code: 'UNKNOWN', message: res.statusText };
    try {
      body = (await res.json()) as ApiError;
    } catch {
      /* a non-JSON error body stays as the status text */
    }
    throw new ApiFailure(res.status, body);
  }

  const reader = res.body?.getReader();
  if (reader === undefined) {
    throw new Error('Streaming is not supported in this browser.');
  }
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      onEvent(JSON.parse(line) as AskAiEvent);
    }
  }
  if (buffer.trim() !== '') onEvent(JSON.parse(buffer) as AskAiEvent);
}
