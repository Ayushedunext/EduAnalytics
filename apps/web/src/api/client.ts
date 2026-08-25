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
}

export interface HomeResponse {
  spec: ChartSpecLike;
  academic_year: string | null;
  /**
   * Metrics that could not be shown, and why. `no_data` means the ERP holds
   * none (AUDIT_REPORT C20); `not_permitted` means this session's perms do not
   * cover the domain (docs/08 §4.5). Never rendered as zero -- a false number
   * is worse than an absent one.
   */
  blocked_metrics: { label: string; reason: string; kind: 'no_data' | 'not_permitted' }[];
  dashboards: DashboardCard[];
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

export function getReport(
  reportId: string,
  schoolIds: readonly string[],
  academicYear: string,
): Promise<DashboardResponse> {
  const query = new URLSearchParams({ academic_year: academicYear });
  if (schoolIds.length > 0) query.set('school_ids', schoolIds.join(','));
  return request<DashboardResponse>(`/api/report/${encodeURIComponent(reportId)}?${query.toString()}`);
}

export function getHome(schoolIds: readonly string[]): Promise<HomeResponse> {
  const query = schoolIds.length > 0 ? `?school_ids=${encodeURIComponent(schoolIds.join(','))}` : '';
  return request<HomeResponse>(`/api/home${query}`);
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
  options: { logic?: boolean } = {},
): string {
  const query = new URLSearchParams({ academic_year: academicYear });
  if (schoolIds.length > 0) query.set('school_ids', schoolIds.join(','));
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

/**
 * The stream this endpoint sends: zero or more `status` steps (docs/05 §2's
 * "Scope confirmed → Planning → Running query → Building chart" trust device),
 * then exactly one `result` or `error`.
 */
export type AskAiEvent =
  | { type: 'status'; step: string }
  | { type: 'result'; spec: AskAiSpec }
  | { type: 'error'; code: string; message: string };

/**
 * Not `request()`: that helper always resolves the whole body as one JSON
 * value, and this endpoint's whole point is to hand events to the caller as
 * they arrive rather than after everything is in. Still the same CSRF-cookie
 * echo and credentialed-fetch pattern as every other mutating call.
 */
export async function askAI(
  question: string,
  schoolIds: readonly string[],
  onEvent: (event: AskAiEvent) => void,
): Promise<void> {
  const query = schoolIds.length > 0 ? `?school_ids=${encodeURIComponent(schoolIds.join(','))}` : '';
  const headers = new Headers({ 'content-type': 'application/json' });
  const token = readCookie(CSRF_COOKIE);
  if (token !== undefined) headers.set(CSRF_HEADER, token);

  const res = await fetch(`${API_BASE}/api/ai/ask${query}`, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify({ question }),
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
