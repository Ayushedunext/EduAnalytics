/**
 * The orchestrator's OpenAPI 3.1 description — the document Swagger UI renders
 * at `GET /docs` and machines fetch from `GET /openapi.json`.
 *
 * Contract source: CODING_GUIDELINES §6 (resource-oriented under `/api`,
 * structured `{code, message, details?}` errors) · ADR-029 (POST launch, CSRF on
 * mutations, GET side-effect-free) · Invariant 2 (`school_ids` narrows, never
 * widens) · Invariant 5 (`/api/ai/*` is 403 unless `ai_status === 'active'`) ·
 * Invariant 6 (every report response carries its logic).
 *
 * -- Why a TypeScript module and not a YAML file ------------------------------
 * A hand-kept `openapi.yaml` drifts silently: a route added in `routes/` and
 * forgotten here is a document that lies, which is the success-shaped failure
 * §10 calls the worst class in this repo. As a module it can be imported by
 * `test/openapi.test.ts`, which walks the real Express routers and fails when
 * the two disagree — so the description cannot fall behind the service without
 * the suite going red. It also needs no YAML parser at runtime or in tests.
 *
 * -- What is deliberately loose -----------------------------------------------
 * `widgets` is `array<object>` rather than the full widget union. The
 * authoritative chart-spec contract lives in `@sap/chart-spec` and is validated
 * there on the way out and again in the renderer; a second, hand-written copy of
 * it here would be a weaker check that disagrees with the real one eventually —
 * the same reasoning the SPA's own client types state
 * (apps/web/src/api/client.ts).
 */

export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: Record<string, unknown>;
  readonly servers: readonly Record<string, unknown>[];
  /** Applied to every operation that does not override it with `security: []`. */
  readonly security: readonly Record<string, unknown>[];
  readonly tags: readonly Record<string, unknown>[];
  readonly components: Record<string, unknown>;
  /** `{path: {method: operation}}`, exactly as OpenAPI orders it. */
  readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/** The one error body every endpoint shares (middleware/errors.ts). */
const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ref('WireError') } },
});

/** Repeated on every endpoint that reads school data. */
const COMMON_ERRORS = {
  '400': errorResponse('VALIDATION_FAILED — a parameter was missing or malformed.'),
  '401': errorResponse('SESSION_INVALID — no session cookie, or it expired.'),
  '403': errorResponse(
    'SCOPE_VIOLATION — a school outside the launch token was requested (audited, ADR-007).',
  ),
  '503': errorResponse('TENANT_UNAVAILABLE — none of the selected schools can be served right now.'),
};

const schoolIdsParam = {
  name: 'school_ids',
  in: 'query',
  required: false,
  description:
    'Comma-separated school ids. A NARROWING selection within the session scope — never a widening ' +
    'one. Absent means the whole scope. An id outside the launch token is a 403 plus an audit row, at ' +
    'the orchestrator and again at the MCP layer (Invariant 2, ADR-007).',
  schema: { type: 'string' },
  example: 'sch_001,sch_002',
};

const academicYearParam = (required: boolean) => ({
  name: 'academic_year',
  in: 'query',
  required,
  description:
    'The academic year as the ERP writes it. Bound as a parameter, never concatenated into SQL.',
  schema: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
  example: '2026-27',
});

const asOfParam = {
  name: 'as_of',
  in: 'query',
  required: false,
  description:
    'What "overdue" and "on roll" are measured against. Defaults to today. Supplying it is what makes ' +
    'a report reproducible — the same date gives the same aging bands next month (docs/06 §5). ' +
    'Validated for existence as well as shape: 2026-02-31 is refused.',
  schema: { type: 'string', format: 'date' },
  example: '2026-09-01',
};

const compareYearParam = {
  name: 'compare_year',
  in: 'query',
  required: false,
  description:
    'The comparison year for a year-on-year report. Absent means "the year before", which the service ' +
    'derives. May not equal `academic_year` — that is a request the SQL cannot honour, and it would ' +
    'render as a confident false collapse rather than a blank.',
  schema: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
  example: '2025-26',
};

const logicParam = {
  name: 'logic',
  in: 'query',
  required: false,
  description: 'Print the logic summary as an appendix (docs/06 §5). `1` or `true`.',
  schema: { type: 'string', enum: ['1', 'true'] },
};

const reportIdParam = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'A predefined dashboard id from the served catalog (services/home.ts).',
  schema: { type: 'string' },
  example: 'fee-collection',
};

const customIdParam = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'A custom report id (ADR-018).',
  schema: { type: 'string' },
};

const pdfResponse = {
  '200': {
    description:
      'The rendered PDF. The spec is REBUILT server-side for this request rather than accepted from ' +
      'the caller, so the numbers in the file are always ones this service read (ADR-021).',
    headers: {
      'content-disposition': {
        schema: { type: 'string' },
        description: 'attachment, with a dated filename.',
      },
      'cache-control': {
        schema: { type: 'string' },
        description: 'Always `private, no-store` — the content is school data.',
      },
    },
    content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
  },
  ...COMMON_ERRORS,
};

const customReportResponses = {
  '200': {
    description: 'The report, hydrated, with its logic panel.',
    content: { 'application/json': { schema: ref('CustomReportResponse') } },
  },
  '400': errorResponse('VALIDATION_FAILED.'),
  '401': errorResponse('SESSION_INVALID.'),
  '403': errorResponse(
    'REPORT_DEFINITION_FORBIDDEN — visible to this session, but not owned by it.',
  ),
  '404': errorResponse(
    'REPORT_DEFINITION_NOT_FOUND — no such report, or not one this session can see.',
  ),
};

export const openApiDocument: OpenApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'School Analytics Platform — Orchestrator API',
    version: '0.0.0',
    summary: 'The only server the SPA talks to.',
    description: [
      'The orchestrator owns session issuance, scope enforcement, the predefined report catalog, custom',
      'reports, BYOK settings, Ask AI and PDF. It never reaches a school database directly: school data',
      'arrives only through MCP tools, which is what keeps one audit chokepoint over every read',
      '(docs/01 §3).',
      '',
      '### Authentication',
      '',
      'There is no login here. The ERP signs a single-use launch token and POSTs it to `/launch`; the',
      'orchestrator verifies it against the ERP JWKS, burns the nonce and issues its own 8-hour session',
      'as an httpOnly `sap_session` cookie, alongside a readable `sap_csrf` cookie (ADR-003, ADR-004,',
      'ADR-029). After that the ERP is not contacted again for the session.',
      '',
      '### CSRF',
      '',
      'GET and HEAD are side-effect-free by contract (ADR-029 clause 3) and need no token. Every other',
      'method must echo the `sap_csrf` cookie in an `x-csrf-token` header. `POST /launch` is the one',
      'exemption — it is a cross-site form POST by design and no token can exist yet; its protection is',
      'the signed, single-use, 60-second token itself.',
      '',
      '### Scope',
      '',
      'Every request is constrained to the `school_ids` in the verified launch token. A `school_ids`',
      'query parameter can only narrow within that; anything else is a 403 and an audit row, checked at',
      'the orchestrator and independently again at the MCP layer.',
      '',
      '### Errors',
      '',
      'One shape everywhere: `{code, message, details?, correlation_id}` with stable machine-readable',
      'codes (packages/shared/src/errors.ts). SQL, stack traces, hostnames and other tenants’',
      'identifiers never appear in a response body — they go to the operational log.',
      '',
      '### Partial success is not failure',
      '',
      'A multi-school read whose fan-out lost a school answers 200 with that school named in',
      '`degraded_schools`, and a metric with no data is listed in `blocked_metrics` rather than rendered',
      'as zero. Silent filtering is the failure mode this platform treats as the worst one (ADR-011).',
    ].join('\n'),
  },
  servers: [{ url: 'http://localhost:3000', description: 'Local development' }],
  /**
   * The default for every operation: a session cookie, plus the CSRF header that
   * only mutating methods actually require. `/launch` and the two probe paths
   * override it with `security: []` — the first has no session yet by
   * definition, and the kubelet calling the others holds no token at all.
   */
  security: [{ sessionCookie: [], csrfToken: [] }],
  tags: [
    { name: 'Launch & session', description: 'The SSO handshake and who the caller is.' },
    {
      name: 'Home',
      description: 'The overview screen: KPI strip, catalog, module tiles, preview cards.',
    },
    {
      name: 'Reports',
      description: 'Predefined dashboards, drill-down and PDF (ADR-016, ADR-020, ADR-021).',
    },
    { name: 'Custom reports', description: 'Clone-to-edit and AI-saved reports, versioned (ADR-018).' },
    { name: 'Ask AI', description: 'Natural-language questions, streamed (ADR-030). BYOK-gated.' },
    { name: 'Settings', description: 'Org AI configuration and school messaging channels.' },
    { name: 'Operations', description: 'Container probes and this document.' },
  ],
  components: {
    securitySchemes: {
      sessionCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: 'sap_session',
        description:
          'The 8-hour session issued by `/launch`. httpOnly, so no script can read it — which is the ' +
          'point (docs/08 §2). Browsers attach it automatically; "Try it out" below works once you ' +
          'have launched from the ERP in this browser.',
      },
      csrfToken: {
        type: 'apiKey',
        in: 'header',
        name: 'x-csrf-token',
        description: 'The `sap_csrf` cookie, echoed. Required on every method except GET and HEAD.',
      },
    },
    schemas: {
      HealthReport: {
        type: 'object',
        title: 'health report',
        required: ['status', 'service', 'uptime_seconds', 'started_at', 'checks'],
        properties: {
          status: { type: 'string', enum: ['ok'] },
          service: { type: 'string', enum: ['orchestrator'] },
          uptime_seconds: { type: 'integer', description: 'Whole seconds since this process started.' },
          started_at: { type: 'string', format: 'date-time' },
          checks: {
            type: 'string',
            enum: ['process-only'],
            description:
              'Named in the payload so a green response is not read as a green system: no ' +
              'dependency is contacted to produce it.',
          },
        },
      },
      WireError: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: {
            type: 'string',
            description:
              'A stable machine-readable code. The SPA translates it; it is not display text.',
            enum: [
              'LAUNCH_TOKEN_INVALID',
              'LAUNCH_TOKEN_EXPIRED',
              'LAUNCH_TOKEN_REPLAYED',
              'JWKS_UNAVAILABLE',
              'SESSION_INVALID',
              'CSRF_CHECK_FAILED',
              'WEBHOOK_SIGNATURE_INVALID',
              'SCOPE_VIOLATION',
              'PERMISSION_DENIED',
              'SQL_REJECTED',
              'ROW_CAP_EXCEEDED',
              'QUERY_TIMEOUT',
              'RATE_LIMITED',
              'TENANT_NOT_FOUND',
              'TENANT_UNAVAILABLE',
              'FANOUT_LIMIT_EXCEEDED',
              'PARTIAL_FAILURE',
              'REPORT_NOT_FOUND',
              'INVALID_CHART_SPEC',
              'DRILL_PATH_INVALID',
              'DRILL_DEPTH_EXCEEDED',
              'REPORT_DEFINITION_NOT_FOUND',
              'REPORT_DEFINITION_FORBIDDEN',
              'REPORT_VERSION_NOT_FOUND',
              'AI_NOT_ACTIVE',
              'AI_QUOTA_EXCEEDED',
              'AI_PROVIDER_ERROR',
              'TEMPLATE_NOT_APPROVED',
              'CHANNEL_NOT_CONNECTED',
              'GUARDRAIL_BLOCKED',
              'VALIDATION_FAILED',
              'INTERNAL',
              'NOT_FOUND',
            ],
          },
          message: { type: 'string', description: 'Plain language, safe to show a user.' },
          details: {
            type: 'object',
            description: 'Scalars only. Never another tenant’s identifiers, never SQL.',
            additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
          },
          correlation_id: {
            type: 'string',
            description:
              'Quote this when reporting a problem; it joins the request to its log line.',
          },
        },
      },
      SchoolRef: {
        type: 'object',
        required: ['school_id', 'school_name'],
        description:
          'A school with its registry name resolved server-side. The SPA never invents one.',
        properties: { school_id: { type: 'string' }, school_name: { type: 'string' } },
      },
      SpecMeta: {
        type: 'object',
        required: ['scope', 'generated_at', 'served_from'],
        properties: {
          scope: {
            type: 'array',
            items: ref('SchoolRef'),
            description: 'Printed under every title and on every PDF (docs/10 §3).',
          },
          generated_at: { type: 'string', format: 'date-time' },
          as_of: { type: 'string', format: 'date' },
          served_from: {
            type: 'string',
            enum: ['cache', 'rollup', 'replica'],
            description:
              'Which of the three serving tiers answered (ADR-028). Never an ERP primary (Invariant 1).',
          },
          report_id: { type: 'string' },
        },
      },
      ChartSpec: {
        type: 'object',
        required: ['spec_version', 'title', 'widgets', 'meta'],
        description:
          'A hydrated chart-spec (ADR-015, Invariant 4). The frontend renders specs and the PDF ' +
          'renderer reads the same ones; no endpoint ever returns renderable code.',
        properties: {
          spec_version: { type: 'integer', enum: [1] },
          title: { type: 'string' },
          narrative: { type: 'string' },
          widgets: {
            type: 'array',
            items: { type: 'object', additionalProperties: true },
            description:
              'The authoritative widget union lives in `@sap/chart-spec` and is validated there — see ' +
              'the module note in src/docs/openapi.ts.',
          },
          meta: ref('SpecMeta'),
        },
      },
      ChartSpecDraft: {
        type: 'object',
        required: ['spec_version', 'title', 'widgets'],
        description: 'A spec before hydration — what Ask AI produced and what re-executes later.',
        properties: {
          spec_version: { type: 'integer', enum: [1] },
          title: { type: 'string' },
          narrative: { type: 'string' },
          widgets: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      NamedQuery: {
        type: 'object',
        required: ['key', 'sql'],
        description:
          'One statement behind a panel. SELECT-only, AST-validated on execution (Invariant 3).',
        properties: { key: { type: 'string' }, sql: { type: 'string' } },
      },
      ReportLogic: {
        type: 'object',
        required: ['source', 'scope', 'filters', 'group_by', 'charts', 'queries', 'notes'],
        description:
          'Invariant 6: the definition and generated SQL behind the report. Present in view mode, edit ' +
          'mode and the PDF appendix.',
        properties: {
          source: { type: 'string' },
          scope: { type: 'array', items: ref('SchoolRef') },
          filters: {
            type: 'array',
            items: {
              type: 'object',
              required: ['label', 'value'],
              properties: { label: { type: 'string' }, value: { type: 'string' } },
            },
          },
          group_by: { type: 'array', items: { type: 'string' } },
          charts: { type: 'array', items: { type: 'string' } },
          queries: {
            type: 'array',
            items: {
              type: 'object',
              required: ['key', 'description', 'sql'],
              properties: {
                key: { type: 'string' },
                description: { type: 'string' },
                sql: { type: 'string' },
              },
            },
          },
          notes: { type: 'array', items: { type: 'string' } },
        },
      },
      DegradedQuery: {
        type: 'object',
        required: ['key', 'message'],
        description: 'A panel that could not be built. Annotated, never dropped (ADR-011).',
        properties: { key: { type: 'string' }, message: { type: 'string' } },
      },
      DegradedSchool: {
        type: 'object',
        required: ['school_id', 'message'],
        description:
          'A school that failed inside a fan-out. Named, so a smaller answer never passes for a ' +
          'complete one.',
        properties: { school_id: { type: 'string' }, message: { type: 'string' } },
      },
      SessionResponse: {
        type: 'object',
        required: [
          'user',
          'org_id',
          'org_name',
          'scope',
          'default_school',
          'perms',
          'dropped_from_scope',
          'ai_status',
          'can_configure_ai',
        ],
        properties: {
          user: {
            type: 'object',
            required: ['name', 'role'],
            properties: { name: { type: 'string' }, role: { type: 'string' } },
          },
          org_id: { type: 'string' },
          org_name: {
            type: 'string',
            description: 'The registry’s name, so no screen has to display an id.',
          },
          scope: { type: 'array', items: ref('SchoolRef') },
          default_school: { type: 'string' },
          perms: {
            type: 'array',
            items: { type: 'string' },
            description: 'Domain permissions, so the SPA can render locked states honestly.',
          },
          dropped_from_scope: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Schools in the token the registry cannot currently serve. Surfaced with a notice, never ' +
              'silently filtered (docs/02 §6).',
          },
          ai_status: {
            type: 'string',
            enum: ['not_configured', 'pending_validation', 'active', 'error'],
            description:
              'The org’s real gating state (ADR-017). UI locks built on it stay cosmetic — every ' +
              '`/api/ai/*` endpoint re-checks server-side.',
          },
          can_configure_ai: {
            type: 'boolean',
            description:
              'Whether THIS user can fix an unconfigured org. Decided on the server; the client does ' +
              'not interpret roles.',
          },
        },
      },
      DashboardCard: {
        type: 'object',
        required: ['id', 'title', 'blurb', 'icon', 'group', 'status', 'modules'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          blurb: { type: 'string' },
          icon: { type: 'string' },
          group: { type: 'string', enum: ['director', 'school'] },
          status: {
            type: 'string',
            enum: ['available', 'coming', 'blocked'],
            description:
              '`coming` = the serving path is not built. `blocked` = the DATA does not exist. Different ' +
              'problems with different owners, so the UI shows them differently.',
          },
          reason: { type: 'string' },
          modules: {
            type: 'array',
            items: { type: 'string' },
            description: 'Which module tiles this report appears under (services/modules.ts).',
          },
        },
      },
      ModuleCard: {
        type: 'object',
        required: ['id', 'title', 'blurb', 'icon', 'report_ids', 'status'],
        description:
          'One Module Wise Analysis tile. A grouping of the catalog, not a second description of it — ' +
          'each card is still read from `dashboards`.',
        properties: {
          id: {
            type: 'string',
            enum: ['fees', 'student', 'staff', 'attendance', 'transport', 'exam', 'general'],
          },
          title: { type: 'string' },
          blurb: { type: 'string' },
          icon: { type: 'string' },
          report_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'In the order the module screen draws them.',
          },
          status: { type: 'string', enum: ['available', 'empty'] },
          reason: {
            type: 'string',
            description:
              'Why an empty module is empty. It renders inert with the reason on it rather than ' +
              'disappearing: a missing tile reads as an oversight, a stated reason reads as a fact.',
          },
        },
      },
      HomeResponse: {
        type: 'object',
        required: [
          'spec',
          'academic_year',
          'academic_years',
          'blocked_metrics',
          'partial_metrics',
          'dashboards',
          'grid',
          'modules',
          'degraded_schools',
        ],
        properties: {
          spec: ref('ChartSpec'),
          academic_year: {
            type: ['string', 'null'],
            description:
              'The year this summary resolved to — what the topbar OPENS on. Feed it back to ' +
              '`/api/home/preview/{id}`.',
          },
          academic_years: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Every year the selected schools hold data for, newest first — the options behind the ' +
              'topbar year control. Derived from rows already read for the KPI strip, so it costs no ' +
              'extra query against a school database. Contains `academic_year` whenever that is not ' +
              'null. Empty when no metric could be read.',
          },
          blocked_metrics: {
            type: 'array',
            description:
              'Metrics that could not be shown, and why. Never rendered as zero — a false number is ' +
              'worse than an absent one.',
            items: {
              type: 'object',
              required: ['label', 'reason', 'kind'],
              properties: {
                label: { type: 'string' },
                reason: { type: 'string' },
                kind: { type: 'string', enum: ['no_data', 'not_permitted'] },
              },
            },
          },
          partial_metrics: {
            type: 'array',
            description:
              'Metrics whose figure covers only some of the selected schools, with the missing ones ' +
              'named. Schools roll their student roll over at different times, so the resolved year ' +
              'may be one that part of the selection has no rows for; those schools contribute ' +
              'nothing to the sum. Annotated rather than silently reduced (ADR-011).',
            items: {
              type: 'object',
              required: ['label', 'schools'],
              properties: {
                label: { type: 'string', example: 'Students' },
                schools: { type: 'array', items: { type: 'string' }, example: ['World School'] },
              },
            },
          },
          dashboards: { type: 'array', items: ref('DashboardCard') },
          grid: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Which dashboards the overview grid draws, in order. A product decision the server makes; ' +
              'the SPA must not re-derive it.',
          },
          modules: { type: 'array', items: ref('ModuleCard') },
          degraded_schools: { type: 'array', items: ref('DegradedSchool') },
        },
      },
      HomePreview: {
        type: 'object',
        required: ['id', 'title', 'icon', 'widget', 'status'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          icon: { type: 'string' },
          widget: {
            type: ['object', 'null'],
            additionalProperties: true,
            description: 'One lead widget. Validated by the renderer before it is drawn.',
          },
          status: { type: 'string', enum: ['ok', 'blocked'] },
          reason: {
            type: 'string',
            description: 'Why a blocked card is blocked — no permission, or no data for this period.',
          },
        },
      },
      DashboardResponse: {
        type: 'object',
        required: ['spec', 'logic', 'degraded', 'degraded_schools'],
        properties: {
          spec: ref('ChartSpec'),
          logic: ref('ReportLogic'),
          degraded: { type: 'array', items: ref('DegradedQuery') },
          degraded_schools: { type: 'array', items: ref('DegradedSchool') },
        },
      },
      DrillStep: {
        type: 'object',
        required: ['dim', 'value', 'label'],
        description: 'One clicked pair, with the text the breadcrumb shows for it.',
        properties: {
          dim: { type: 'string', maxLength: 64 },
          value: { type: 'string', maxLength: 128 },
          label: { type: 'string', maxLength: 128 },
        },
      },
      DrillRequest: {
        type: 'object',
        required: ['widget_id', 'level', 'context'],
        additionalProperties: false,
        properties: {
          widget_id: { type: 'string', minLength: 1, maxLength: 64 },
          level: { type: 'integer', description: 'Which level to produce. Capped at three (ADR-020).' },
          context: {
            type: 'array',
            maxItems: 3,
            items: ref('DrillStep'),
            description: 'The stack of clicks so far.',
          },
        },
      },
      DrillResponse: {
        type: 'object',
        required: [
          'widget',
          'level',
          'context',
          'school_ids',
          'query',
          'group_by',
          'notes',
          'degraded',
          'degraded_schools',
        ],
        properties: {
          widget: { type: 'object', additionalProperties: true },
          level: { type: 'integer', enum: [1, 2, 3] },
          context: { type: 'array', items: ref('DrillStep') },
          school_ids: {
            type: 'array',
            items: { type: 'string' },
            description:
              'The schools this level actually read, after a school click narrowed them. This is what ' +
              'the audit row records.',
          },
          query: {
            type: 'object',
            required: ['key', 'description', 'sql'],
            description: 'Invariant 6: every level’s SQL is in the logic panel (docs/06 §4.4).',
            properties: {
              key: { type: 'string' },
              description: { type: 'string' },
              sql: { type: 'string' },
            },
          },
          group_by: { type: 'string' },
          notes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Caveats true at THIS level, shown against the chart.',
          },
          degraded: { type: 'array', items: ref('DegradedQuery') },
          degraded_schools: { type: 'array', items: ref('DegradedSchool') },
        },
      },
      ReportSource: {
        type: 'object',
        required: ['report_id', 'title', 'blurb', 'icon', 'group', 'filters'],
        description:
          'One thing a new custom report can be built from ("＋ New custom report", docs/06 §3).',
        properties: {
          report_id: { type: 'string' },
          title: { type: 'string' },
          blurb: { type: 'string' },
          icon: { type: 'string' },
          group: { type: 'string', enum: ['director', 'school'] },
          filters: {
            type: 'object',
            required: ['academic_year', 'as_of'],
            properties: { academic_year: { type: 'boolean' }, as_of: { type: 'boolean' } },
          },
        },
      },
      CustomReportSummary: {
        type: 'object',
        required: [
          'id',
          'name',
          'source_kind',
          'base_report_id',
          'base_report_title',
          'school_scope',
          'current_version',
          'shared_flag',
          'is_owner',
          'updated_at',
        ],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          source_kind: { type: 'string', enum: ['predefined_clone', 'ai_saved'] },
          base_report_id: { type: ['string', 'null'] },
          base_report_title: {
            type: ['string', 'null'],
            description: 'Resolved server-side; null for AI-saved reports.',
          },
          school_scope: { type: 'array', items: ref('SchoolRef') },
          current_version: { type: 'integer' },
          shared_flag: { type: 'string', enum: ['private', 'school', 'trust'] },
          is_owner: { type: 'boolean' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      CustomReportResponse: {
        type: 'object',
        required: [
          'id',
          'name',
          'source_kind',
          'base_report_id',
          'shared_flag',
          'mode',
          'current_version',
          'is_owner',
          'can_promote',
          'spec',
          'logic',
          'degraded',
          'degraded_schools',
        ],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          source_kind: { type: 'string', enum: ['predefined_clone', 'ai_saved'] },
          base_report_id: { type: ['string', 'null'] },
          shared_flag: { type: 'string', enum: ['private', 'school', 'trust'] },
          mode: {
            type: 'string',
            enum: ['template', 'raw_sql'],
            description:
              'How it executes. A `template` clone still runs the platform’s statement; `raw_sql` runs ' +
              'its own, guarded the same way.',
          },
          current_version: { type: 'integer' },
          is_owner: { type: 'boolean' },
          can_promote: { type: 'boolean' },
          spec: ref('ChartSpec'),
          logic: ref('ReportLogic'),
          degraded: { type: 'array', items: ref('DegradedQuery') },
          degraded_schools: { type: 'array', items: ref('DegradedSchool') },
        },
      },
      ReportVersionSummary: {
        type: 'object',
        required: ['version', 'edited_by', 'edited_at'],
        properties: {
          version: { type: 'integer' },
          edited_by: { type: 'string' },
          edited_at: { type: 'string', format: 'date-time' },
        },
      },
      AiConfig: {
        type: 'object',
        required: [
          'ai_status',
          'provider',
          'model',
          'billing_mode',
          'monthly_query_cap',
          'key_hint',
          'last_validated_at',
          'last_error',
        ],
        description:
          'Note what is absent: the API key. It can be written and never read back — `key_hint` is the ' +
          'only key-derived value that crosses this boundary, which is what makes ADR-017 true of the ' +
          'API and not only of the database.',
        properties: {
          ai_status: {
            type: 'string',
            enum: ['not_configured', 'pending_validation', 'active', 'error'],
          },
          provider: { type: 'string', enum: ['anthropic', 'gemini'] },
          model: { type: 'string' },
          billing_mode: { type: 'string', enum: ['byok', 'platform'] },
          monthly_query_cap: { type: 'integer' },
          key_hint: { type: ['string', 'null'], example: 'sk-ant-…1G4a' },
          last_validated_at: { type: ['string', 'null'], format: 'date-time' },
          last_error: { type: ['string', 'null'] },
        },
      },
      ProviderMeta: {
        type: 'object',
        required: ['id', 'label', 'console_url', 'key_placeholder', 'key_prefix', 'models'],
        description:
          'A provider’s model catalog and console URL are the platform’s facts, not the client’s (ADR-031).',
        properties: {
          id: { type: 'string', enum: ['anthropic', 'gemini'] },
          label: { type: 'string' },
          console_url: { type: 'string', format: 'uri' },
          key_placeholder: { type: 'string' },
          key_prefix: { type: ['string', 'null'] },
          models: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'label'],
              properties: { id: { type: 'string' }, label: { type: 'string' } },
            },
          },
        },
      },
      ChannelRow: {
        type: 'object',
        required: [
          'school_id',
          'school_name',
          'channel',
          'title',
          'icon',
          'status',
          'detail',
          'requirement',
        ],
        properties: {
          school_id: { type: 'string' },
          school_name: { type: 'string' },
          channel: { type: 'string', enum: ['email', 'sms', 'whatsapp'] },
          title: { type: 'string' },
          icon: { type: 'string' },
          status: { type: 'string', enum: ['connected', 'not_connected'] },
          detail: { type: ['string', 'null'] },
          requirement: { type: 'string' },
        },
      },
      SettingsResponse: {
        type: 'object',
        required: [
          'org_id',
          'org_name',
          'school_count',
          'ai',
          'can_configure',
          'contact_admin',
          'providers',
          'channels',
        ],
        properties: {
          org_id: { type: 'string' },
          org_name: { type: 'string' },
          school_count: { type: 'integer' },
          ai: ref('AiConfig'),
          can_configure: {
            type: 'boolean',
            description:
              'The server’s answer to "may this person configure AI?", which the SPA renders rather ' +
              'than deciding.',
          },
          contact_admin: {
            type: 'string',
            description:
              'The platform’s wording for a non-admin, so the screen and the 403 body agree.',
          },
          providers: { type: 'array', items: ref('ProviderMeta') },
          channels: { type: 'array', items: ref('ChannelRow') },
        },
      },
      AiSaveResponse: {
        type: 'object',
        required: ['ai', 'error'],
        properties: {
          ai: ref('AiConfig'),
          error: {
            type: ['string', 'null'],
            description:
              'The PROVIDER’s verdict in plain language, not a transport error. A rejected key is a ' +
              'fact about the org’s account, so it arrives as 200 with this set — the request itself ' +
              'was well-formed.',
          },
        },
      },
      AskAiRequest: {
        type: 'object',
        required: ['question'],
        properties: {
          question: { type: 'string', minLength: 1, maxLength: 2000 },
          report_id: {
            type: 'string',
            description:
              '"✎ Refine with AI" (docs/06 §1) — seeds this turn from a saved report’s current ' +
              'definition. Owner-gated on its own: a report this session cannot see 404s before a ' +
              'token is spent.',
          },
          seed: {
            type: 'object',
            required: ['report_name', 'queries', 'widgets'],
            description:
              'Refining an Ask AI answer that has not been saved yet — the same seed, echoed from this ' +
              'session’s own previous `result` event. Mutually exclusive with `report_id`.',
            properties: {
              report_name: { type: 'string', minLength: 1, maxLength: 255 },
              queries: { type: 'array', minItems: 1, items: ref('NamedQuery') },
              widgets: {
                type: 'array',
                minItems: 1,
                items: { type: 'object', additionalProperties: true },
              },
            },
          },
        },
      },
      AskAiEvent: {
        oneOf: [
          {
            type: 'object',
            title: 'status',
            required: ['type', 'step'],
            description:
              'Zero or more, in order — docs/05 §2’s "Scope confirmed → Planning → Running query → ' +
              'Building chart" trust device.',
            properties: { type: { type: 'string', enum: ['status'] }, step: { type: 'string' } },
          },
          {
            type: 'object',
            title: 'result',
            required: ['type', 'spec', 'queries', 'draft', 'logic'],
            properties: {
              type: { type: 'string', enum: ['result'] },
              spec: ref('ChartSpec'),
              queries: { type: 'array', items: ref('NamedQuery') },
              draft: ref('ChartSpecDraft'),
              logic: ref('ReportLogic'),
            },
          },
          {
            type: 'object',
            title: 'error',
            required: ['type', 'code', 'message'],
            description:
              'The stream IS this endpoint’s error channel once a chunked response is in flight — a ' +
              'failure there cannot become an HTTP status.',
            properties: {
              type: { type: 'string', enum: ['error'] },
              code: { type: 'string' },
              message: { type: 'string' },
            },
          },
        ],
      },
    },
  },
  paths: {
    '/HealthCheckAWS': {
      get: {
        tags: ['Operations'],
        summary: 'Container probe (startup, liveness and readiness).',
        description: [
          'The path all three Kubernetes probes call. It checks NOTHING — no database, no Redis, no',
          'MCP — and answers from memory.',
          '',
          'That is deliberate. One path serves liveness, whose only remedy is a restart, so a',
          'dependency check here would turn a database blip into a cluster-wide restart loop that',
          'cannot fix the database. Dependency health belongs on metrics and alarms, not on a probe',
          'that reboots pods.',
          '',
          'A 200 asserts: this process is up, its event loop is turning, and it is accepting on its',
          'port — which also implies it reached the platform database at boot, because the server',
          'awaits that check before it listens at all.',
        ].join('\n'),
        security: [],
        responses: {
          '200': {
            description: 'The process is up. Says nothing about the platform database or Redis.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthReport' },
              },
            },
          },
        },
      },
    },
    '/healthz': {
      get: {
        tags: ['Operations'],
        summary: 'Container probe — alias of /HealthCheckAWS.',
        description:
          'The original name, kept so existing callers (compose stack, local scripts, the MCP ' +
          'server’s own equivalent) keep working. Same handler, same zero-cost answer.',
        security: [],
        responses: {
          '200': {
            description: 'The process is up. Says nothing about the platform database or Redis.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthReport' },
              },
            },
          },
        },
      },
    },
    '/launch': {
      post: {
        tags: ['Launch & session'],
        summary: 'The SSO handshake.',
        description: [
          'Verify the ERP-signed token against the published JWKS, check `exp`, consume the one-time',
          'nonce, issue an 8-hour session, redirect to the SPA (docs/02 §2, ADR-003/004/029).',
          '',
          'The token arrives in a form body, never a query parameter — a token in a URL ends up in',
          'access logs, browser history and referrers. A query-string token is refused outright.',
          '',
          'CSRF-exempt by design: this is a cross-site form POST and no session exists yet. Its',
          'protection is that the request is worthless without a valid, unexpired, single-use,',
          'ERP-signed token.',
        ].join('\n'),
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/x-www-form-urlencoded': {
              schema: {
                type: 'object',
                required: ['token'],
                properties: {
                  token: { type: 'string', description: 'The ERP’s 60-second launch JWT.' },
                },
              },
            },
          },
        },
        responses: {
          '303': {
            description:
              'Verified. Sets `sap_session` (httpOnly) and `sap_csrf`, then redirects to the SPA with ' +
              'GET so the token leaves the history.',
            headers: {
              location: { schema: { type: 'string' } },
              'set-cookie': { schema: { type: 'string' } },
            },
          },
          '401': {
            description:
              'Invalid, expired or already-used token. An HTML failure page, not JSON — this is a ' +
              'top-level browser navigation and the user needs something legible (docs/02 §6).',
            content: { 'text/html': { schema: { type: 'string' } } },
          },
        },
      },
    },
    '/api/session': {
      get: {
        tags: ['Launch & session'],
        summary: 'Who is this, and what may they see?',
        description:
          'The SPA’s first call after launch. Identity, role, and the school scope WITH NAMES resolved ' +
          'from the registry — which is what lets docs/10 §3’s "scope is always on screen" hold without ' +
          'the client ever inventing a school identity.',
        responses: {
          '200': {
            description: 'The session.',
            content: { 'application/json': { schema: ref('SessionResponse') } },
          },
          '401': errorResponse('SESSION_INVALID.'),
        },
      },
    },
    '/api/home': {
      get: {
        tags: ['Home'],
        summary: 'The Home screen’s KPI strip, catalog and module tiles.',
        description:
          'Predefined path — no AI tokens are spent (ADR-016). Returns the summary spec plus the static ' +
          'catalog metadata the sidebar, the module tiles and the report cards must all read one answer ' +
          'from.',
        parameters: [schoolIdsParam],
        responses: {
          '200': {
            description: 'The overview.',
            content: { 'application/json': { schema: ref('HomeResponse') } },
          },
          ...COMMON_ERRORS,
        },
      },
    },
    '/api/home/preview/{id}': {
      get: {
        tags: ['Home'],
        summary: 'ONE live dashboard-preview card.',
        description: [
          'One dashboard per request, deliberately. This was `/api/home/previews`, which built every',
          'card and returned them together — which made the screen only as fast as its slowest card:',
          'against the real extract `enrollment-overview` was ready in 146 ms and sat invisible for',
          'another 6.5 s while the fee scans finished, because one `Promise.all` cannot answer early.',
          '',
          'Call it once per card, with the `academic_year` that `/api/home` resolved. A dashboard that',
          'cannot be previewed answers 200 with `status: "blocked"` and a reason — one unavailable card',
          'is not a failed request. An id that is not a previewable dashboard IS an error: that is a',
          'caller bug, not a state.',
        ].join('\n'),
        parameters: [reportIdParam, academicYearParam(true), asOfParam, schoolIdsParam],
        responses: {
          '200': {
            description: 'The card, ready or blocked with a reason.',
            content: { 'application/json': { schema: ref('HomePreview') } },
          },
          ...COMMON_ERRORS,
          '404': errorResponse('REPORT_DEFINITION_NOT_FOUND — not a previewable dashboard.'),
        },
      },
    },
    '/api/report/{id}': {
      get: {
        tags: ['Reports'],
        summary: 'A predefined dashboard.',
        description:
          'Cached, vetted SQL — the deterministic path, spending no AI tokens (ADR-016). The response ' +
          'carries its logic panel because Invariant 6 makes that part of the report rather than an ' +
          'extra (ADR-019). Audited as a `report.viewed` chokepoint event with the user, school set, ' +
          'report id and filters.',
        parameters: [
          reportIdParam,
          academicYearParam(true),
          asOfParam,
          compareYearParam,
          schoolIdsParam,
        ],
        responses: {
          '200': {
            description: 'The dashboard.',
            content: { 'application/json': { schema: ref('DashboardResponse') } },
          },
          ...COMMON_ERRORS,
          '404': errorResponse('REPORT_NOT_FOUND.'),
        },
      },
    },
    '/api/report/{id}/drill': {
      post: {
        tags: ['Reports'],
        summary: 'One level of a drill path.',
        description:
          'Up to three levels (ADR-020). A POST where the report itself is a GET: the click is a read, ' +
          'but it carries a context in a body and is audited as its own event — docs/08 §7 requires ' +
          '"who viewed which student-level slice" to be answerable. The filters travel in the query ' +
          'string so the same code validates them for the view, the PDF and this.',
        parameters: [
          reportIdParam,
          academicYearParam(true),
          asOfParam,
          compareYearParam,
          schoolIdsParam,
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: ref('DrillRequest') } },
        },
        responses: {
          '200': {
            description: 'The level.',
            content: { 'application/json': { schema: ref('DrillResponse') } },
          },
          ...COMMON_ERRORS,
          '404': errorResponse('REPORT_NOT_FOUND.'),
        },
      },
    },
    '/api/report/{id}/export.pdf': {
      get: {
        tags: ['Reports'],
        summary: 'Branded PDF of a predefined dashboard.',
        description:
          'The spec is rebuilt here rather than accepted from the caller: a PDF carries the school’s ' +
          'name and the platform’s branding and will be forwarded, printed and filed long after the ' +
          'session that made it. An endpoint that rendered a posted spec would let anyone receive ' +
          'arbitrary numbers back looking official (ADR-021).',
        parameters: [
          reportIdParam,
          academicYearParam(true),
          asOfParam,
          compareYearParam,
          logicParam,
          schoolIdsParam,
        ],
        responses: pdfResponse,
      },
    },
    '/api/reports': {
      get: {
        tags: ['Custom reports'],
        summary: 'My Reports.',
        responses: {
          '200': {
            description: 'Every custom report this session can see.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['reports'],
                  properties: { reports: { type: 'array', items: ref('CustomReportSummary') } },
                },
              },
            },
          },
          '401': errorResponse('SESSION_INVALID.'),
        },
      },
    },
    '/api/reports/sources': {
      get: {
        tags: ['Custom reports'],
        summary: 'What a new custom report can be built from.',
        responses: {
          '200': {
            description: 'The clonable catalog.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['sources'],
                  properties: { sources: { type: 'array', items: ref('ReportSource') } },
                },
              },
            },
          },
          '401': errorResponse('SESSION_INVALID.'),
        },
      },
    },
    '/api/reports/clone': {
      post: {
        tags: ['Custom reports'],
        summary: 'Clone a PREDEFINED dashboard into an editable report.',
        description:
          'Clone-to-edit (ADR-018, docs/06 §3). Takes a catalog id and refuses anything else — ' +
          'duplicating a custom report is `POST /api/reports/{id}/duplicate`, a separate door on ' +
          'purpose. `widget_id` clones just one chart.',
        parameters: [schoolIdsParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['base_report_id', 'name', 'academic_year'],
                properties: {
                  base_report_id: { type: 'string' },
                  name: { type: 'string', minLength: 1, maxLength: 255 },
                  academic_year: { type: 'string', example: '2026-27' },
                  as_of: { type: 'string', format: 'date' },
                  compare_year: {
                    type: 'string',
                    description:
                      'Dropping it would save a report that quietly compares against something else.',
                  },
                  widget_id: { type: 'string' },
                  bucket: {
                    type: 'string',
                    enum: ['week', 'month', 'quarter', 'year'],
                    description: 'Time-grouping override — only meaningful with `widget_id`.',
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'The new report.',
            content: { 'application/json': { schema: ref('CustomReportResponse') } },
          },
          ...COMMON_ERRORS,
        },
      },
    },
    '/api/reports/from-ai': {
      post: {
        tags: ['Custom reports'],
        summary: '"Save as report" from Ask AI.',
        description:
          'The SQL is not trusted from the client as final: it is re-run through the same guarded MCP ' +
          'path any execution takes before anything is persisted, so a tampered body fails loudly ' +
          'rather than saving an unsafe or non-functioning report.',
        parameters: [schoolIdsParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'queries', 'draft'],
                properties: {
                  name: { type: 'string', minLength: 1, maxLength: 255 },
                  queries: { type: 'array', minItems: 1, items: ref('NamedQuery') },
                  draft: ref('ChartSpecDraft'),
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'The saved report.',
            content: { 'application/json': { schema: ref('CustomReportResponse') } },
          },
          ...COMMON_ERRORS,
        },
      },
    },
    '/api/reports/{id}': {
      get: {
        tags: ['Custom reports'],
        summary: 'View a custom report.',
        parameters: [customIdParam, schoolIdsParam],
        responses: customReportResponses,
      },
      delete: {
        tags: ['Custom reports'],
        summary: 'Delete a custom report.',
        parameters: [customIdParam],
        responses: {
          '204': { description: 'Deleted.' },
          '401': errorResponse('SESSION_INVALID.'),
          '403': errorResponse('REPORT_DEFINITION_FORBIDDEN — not this session’s report.'),
          '404': errorResponse('REPORT_DEFINITION_NOT_FOUND.'),
        },
      },
    },
    '/api/reports/{id}/duplicate': {
      post: {
        tags: ['Custom reports'],
        summary: 'A private copy of a report you can already see.',
        description:
          '"⧉ Clone" on a My Reports row. `POST /api/reports/clone` is the other, unrelated door: that ' +
          'one clones a PREDEFINED dashboard by its catalog id and refuses anything else.',
        parameters: [customIdParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string', minLength: 1, maxLength: 255 } },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'The copy.',
            content: { 'application/json': { schema: ref('CustomReportResponse') } },
          },
          '400': errorResponse('VALIDATION_FAILED.'),
          '401': errorResponse('SESSION_INVALID.'),
          '403': errorResponse('REPORT_DEFINITION_FORBIDDEN.'),
          '404': errorResponse('REPORT_DEFINITION_NOT_FOUND.'),
        },
      },
    },
    '/api/reports/{id}/visual': {
      put: {
        tags: ['Custom reports'],
        summary: 'Edit the presentation — filters and chart types.',
        description:
          'The visual half of clone-to-edit: no SQL changes hands, so a `template` report stays a ' +
          'template.',
        parameters: [customIdParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['academic_year'],
                properties: {
                  academic_year: { type: 'string', example: '2026-27' },
                  as_of: { type: 'string', format: 'date' },
                  chart_overrides: {
                    type: 'object',
                    additionalProperties: { type: 'string', enum: ['bar', 'line'] },
                  },
                },
              },
            },
          },
        },
        responses: customReportResponses,
      },
    },
    '/api/reports/{id}/sql': {
      put: {
        tags: ['Custom reports'],
        summary: 'Hand-edit the SQL (the SQL tab).',
        description:
          'Hand-edit only, for `raw_sql` reports. The AI-authored path is ' +
          '`PUT /api/reports/{id}/refine`.',
        parameters: [customIdParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['queries', 'draft'],
                properties: {
                  queries: { type: 'array', minItems: 1, items: ref('NamedQuery') },
                  draft: ref('ChartSpecDraft'),
                },
              },
            },
          },
        },
        responses: customReportResponses,
      },
    },
    '/api/reports/{id}/refine': {
      put: {
        tags: ['Custom reports'],
        summary: '"Apply" an AI-proposed refinement as the next version.',
        description:
          'The only endpoint that may materialize a predefined clone (`mode: "template"`) into literal ' +
          'SQL (docs/06 §1, "✎ Refine with AI").',
        parameters: [customIdParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['queries', 'draft'],
                properties: {
                  queries: { type: 'array', minItems: 1, items: ref('NamedQuery') },
                  draft: ref('ChartSpecDraft'),
                },
              },
            },
          },
        },
        responses: customReportResponses,
      },
    },
    '/api/reports/{id}/versions': {
      get: {
        tags: ['Custom reports'],
        summary: 'Version history.',
        parameters: [customIdParam],
        responses: {
          '200': {
            description: 'Every saved version.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['versions'],
                  properties: { versions: { type: 'array', items: ref('ReportVersionSummary') } },
                },
              },
            },
          },
          '401': errorResponse('SESSION_INVALID.'),
          '404': errorResponse('REPORT_DEFINITION_NOT_FOUND.'),
        },
      },
    },
    '/api/reports/{id}/rollback': {
      post: {
        tags: ['Custom reports'],
        summary: 'Roll back to an earlier version.',
        parameters: [customIdParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['version'],
                properties: { version: { type: 'integer', minimum: 1 } },
              },
            },
          },
        },
        responses: {
          ...customReportResponses,
          '404': errorResponse('REPORT_VERSION_NOT_FOUND — or no such report.'),
        },
      },
    },
    '/api/reports/{id}/visibility': {
      put: {
        tags: ['Custom reports'],
        summary: 'Share a report, or stop sharing it.',
        parameters: [customIdParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['shared_flag'],
                properties: {
                  shared_flag: { type: 'string', enum: ['private', 'school', 'trust'] },
                },
              },
            },
          },
        },
        responses: {
          '204': { description: 'Changed.' },
          '400': errorResponse('VALIDATION_FAILED.'),
          '401': errorResponse('SESSION_INVALID.'),
          '403': errorResponse('REPORT_DEFINITION_FORBIDDEN — not this session’s report to share.'),
          '404': errorResponse('REPORT_DEFINITION_NOT_FOUND.'),
        },
      },
    },
    '/api/reports/{id}/export.pdf': {
      get: {
        tags: ['Custom reports'],
        summary: 'Branded PDF of a custom report.',
        parameters: [customIdParam, logicParam, schoolIdsParam],
        responses: pdfResponse,
      },
    },
    '/api/ai/ask': {
      post: {
        tags: ['Ask AI'],
        summary: 'Ask a question in natural language.',
        description: [
          'Streams newline-delimited JSON: zero or more `status` events, then exactly one `result` or',
          '`error` (ADR-030). Not WebSocket and not SSE — no WS infrastructure exists in this codebase',
          'and `EventSource` cannot carry a POST body, so a plain chunked response avoids a new',
          'dependency entirely.',
          '',
          'Gated on `ai_status === "active"` here, on every request, independent of what the UI shows',
          '(Invariant 5) — the locked entry points in the SPA are cosmetic on top of this check.',
          '',
          'A POST because it spends the org’s own AI budget, which is exactly what CSRF exists to',
          'protect regardless of what it writes to our own database.',
        ].join('\n'),
        parameters: [schoolIdsParam],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: ref('AskAiRequest') } },
        },
        responses: {
          '200': {
            description: 'The event stream. One JSON object per line.',
            content: {
              'application/x-ndjson': {
                schema: ref('AskAiEvent'),
                example:
                  '{"type":"status","step":"Scope confirmed"}\n' +
                  '{"type":"status","step":"Running query"}\n' +
                  '{"type":"result","spec":{},"queries":[],"draft":{},"logic":{}}',
              },
            },
          },
          '400': errorResponse(
            'VALIDATION_FAILED — empty question, over 2000 characters, or a malformed seed.',
          ),
          '401': errorResponse('SESSION_INVALID.'),
          '403': errorResponse(
            'AI_NOT_ACTIVE — the org has no working key (Invariant 5). Also SCOPE_VIOLATION.',
          ),
        },
      },
    },
    '/api/settings': {
      get: {
        tags: ['Settings'],
        summary: 'AI configuration and messaging channels.',
        responses: {
          '200': {
            description: 'The org’s settings. Never the API key.',
            content: { 'application/json': { schema: ref('SettingsResponse') } },
          },
          '401': errorResponse('SESSION_INVALID.'),
        },
      },
    },
    '/api/settings/ai': {
      put: {
        tags: ['Settings'],
        summary: 'Save the org’s own AI key (BYOK).',
        description: [
          'Admin-only — enforced in the service so a future route that forgets cannot reach it',
          '(ADR-017).',
          '',
          'PUT because saving a key is idempotent by nature: the same key, model and cap sent twice',
          'leaves the org in the same state, and an admin who double-clicks "Test & Save" should get',
          'one activated org, not two of anything.',
          '',
          'The key goes one way. It is written to the vault and never returned by any endpoint, for any',
          'role; `key_hint` is all that comes back.',
        ].join('\n'),
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['api_key'],
                properties: {
                  provider: { type: 'string', enum: ['anthropic', 'gemini'], default: 'anthropic' },
                  api_key: {
                    type: 'string',
                    description: 'Never logged, never echoed, never stored client-side.',
                  },
                  model: { type: 'string', description: 'One of that provider’s offered models.' },
                  monthly_query_cap: { type: 'integer', default: 1500 },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description:
              'The saved configuration. A key the PROVIDER rejected also arrives here, as `error` — ' +
              'the request was well-formed and the platform did what was asked; what failed is a fact ' +
              'about the org’s account.',
            content: { 'application/json': { schema: ref('AiSaveResponse') } },
          },
          '400': errorResponse('VALIDATION_FAILED — unknown provider, unknown model, or no key.'),
          '401': errorResponse('SESSION_INVALID.'),
          '403': errorResponse(
            'PERMISSION_DENIED — not an admin. The body carries the same wording the screen shows.',
          ),
        },
      },
    },
    '/api/settings/ai/disable': {
      post: {
        tags: ['Settings'],
        summary: 'Turn AI off for the org.',
        description:
          'Admin-only. Returns the org to a state where every `/api/ai/*` endpoint answers 403.',
        responses: {
          '200': {
            description: 'The configuration after disabling.',
            content: { 'application/json': { schema: ref('AiSaveResponse') } },
          },
          '401': errorResponse('SESSION_INVALID.'),
          '403': errorResponse('PERMISSION_DENIED — not an admin.'),
        },
      },
    },
    '/api/settings/channels/{schoolId}/{channel}/disconnect': {
      post: {
        tags: ['Settings'],
        summary: 'Disconnect a school’s messaging channel.',
        description:
          'Scope layer 1 applied to a platform-database row, because the row is ABOUT a school: a ' +
          'session may only touch channels for schools its launch token carries (ADR-007).',
        parameters: [
          { name: 'schoolId', in: 'path', required: true, schema: { type: 'string' } },
          {
            name: 'channel',
            in: 'path',
            required: true,
            schema: { type: 'string', enum: ['email', 'sms', 'whatsapp'] },
          },
        ],
        responses: {
          '200': {
            description: 'The channel rows after the change.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['channels'],
                  properties: { channels: { type: 'array', items: ref('ChannelRow') } },
                },
              },
            },
          },
          '400': errorResponse('VALIDATION_FAILED — not a channel this product supports.'),
          '401': errorResponse('SESSION_INVALID.'),
          '403': errorResponse('SCOPE_VIOLATION — that school is not in this session’s scope.'),
        },
      },
    },
  },
};
