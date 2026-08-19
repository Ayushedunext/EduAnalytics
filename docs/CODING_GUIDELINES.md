# CODING_GUIDELINES.md

> **Audience:** every engineer and every Claude Code session implementing this project.
> **Authority:** these guidelines *derive from* `PROJECT_CONTEXT.md`, `DECISIONS.md` (ADRs), and `docs/00–11`. Where a rule and an ADR appear to conflict, the ADR wins; fix the guideline via PR. Rules marked **[MANDATORY]** protect an invariant or an Accepted ADR — violating one is an architecture change and requires a new ADR *before* the code (see `DECISIONS.md` §Amendment process).
> **Style:** reference the source document instead of restating architecture. "docs/NN" = files in `docs/`; "ADR-0XX" = entries in `DECISIONS.md`.

---

## 1. Repository & folder structure

Default layout, mapped 1:1 to the module boundaries in `docs/01` (layout changes that preserve these boundaries need no ADR; changes that merge boundaries do):

```
/CLAUDE.md                 # session orientation + the six invariants
/PROJECT_CONTEXT.md        # whole-platform understanding
/AUDIT_REPORT.md           # open doc findings + questions awaiting decision
/docs/                     # binding engineering docs
  00-…-11-….md             #   module deep dives
  DECISIONS.md             #   the ADRs (ADR-001…029)
  CODING_GUIDELINES.md     #   this file
/apps/
  web/                     # React SPA (gallery, Ask-AI, editor, agent builder)
  orchestrator/            # Node.js API: sessions, scope, services, PDF, drill endpoint
  mcp-server/              # TypeScript MCP server (the only school-data path)
  agent-runtime/           # scheduler, trigger evaluator, run orchestrator, action workers
/packages/
  chart-spec/              # the chart-spec contract: types + renderer bindings (ADR-015)
  report-defs/             # report-definition types, hierarchy catalog types (ADR-018/020)
  shared/                  # cross-service types (launch-token claims, tenant, errors)
/etl/rollup/               # rollup-store ETL jobs (docs/03 §4.2)
/ops/                      # IaC, deployment, runbooks
```

- **[MANDATORY]** `apps/web` must have no dependency path to `mcp-server`, database drivers, or any secret-bearing package. The browser bundle can never contain DB or AI credentials (Invariant list, `PROJECT_CONTEXT.md` §4; ADR-006).
- Shared contracts (chart-spec, report definitions, token claims) live in `/packages` and are imported — never copy-pasted between services. Duplicated contract types are how drift starts.

## 2. Naming conventions

- Identifiers follow the glossary in `docs/00` **exactly**: `org_id`, `school_id`, `tenant` (resolution context), `launch_token`, `scope`, `chart_spec`, `report_definition`, `drill_context`, `dedup_key`, `ai_status`, `run`, `node`, `channel`. Do not invent synonyms (`client_id`, `branch`, `workspace` are forbidden for these concepts).
- DB/table/column names: `snake_case`, matching the schemas already specified in docs (`tenant_registry`, `tenant_ai_config`, `report_definitions`, `rollup_daily`, `agents`, `agent_runs`, `run_steps`, `message_log`).
- TypeScript/JS: `camelCase` values, `PascalCase` types/components, `SCREAMING_SNAKE_CASE` compile-time constants. File names: `kebab-case.ts`; React components `PascalCase.tsx`.
- MCP tool names are part of the contract (ADR-006): `get_schema`, `get_dimensions`, `run_query`, `run_multi`, `run_rollup`, `run_predefined` — renaming or aliasing is an ADR.

## 3. TypeScript / JavaScript conventions

- `apps/mcp-server` is TypeScript (fixed — `PROJECT_CONTEXT.md` §7). Backend services default to TypeScript with `"strict": true`; the SPA's TS adoption is *not yet decided* (see §23) — whatever is chosen, the rules below apply to all typed code.
- **[MANDATORY] Type safety at trust boundaries:** everything entering a service from outside (HTTP body, token claims, tool arguments, queue payloads, ERP sync rows, LLM output) is `unknown` until validated (see §10). No `as`-casting external input into domain types.
- Chart-spec, report-definition, drill, and agent-graph types come only from `/packages`; services must not re-declare them.
- No `any` in exported signatures. `null`/`undefined` handled explicitly; no non-null assertions (`!`) on external data.
- Async: promises with `async/await`; no floating promises (every promise awaited, returned, or explicitly `void`-ed with a comment).

## 4. React / frontend conventions

- Function components + hooks; components stay presentational — data access goes through a thin API layer that only ever calls the orchestrator.
- **[MANDATORY] Render specs, not AI output:** anything visual coming from the AI is a **chart-spec** rendered by the shared renderer in `/packages/chart-spec` (ADR-015). Never `dangerouslySetInnerHTML`, never eval, never render model-provided markup/JSX/HTML. If a new visual is needed, extend the chart-spec widget vocabulary (additive, ADR-gated) — do not special-case one screen.
- One chart layer for everything (predefined, custom, AI, drill) — per ADR-015/016 the visual language must be identical; a second charting approach for a single feature is drift.
- Styling: Tailwind with the design tokens from `docs/10` (Deep Teal `#028090`, Ink `#032E36`, etc.). No hard-coded hex values in components — tokens only; tenant theming (docs/10 §1.3) depends on it.
- UX conventions from `docs/10` §3 are binding: locked ≠ hidden (gated features render with lock + unlock path); scope is always on screen; anything slow streams status (never a bare spinner); destructive actions confirm in plain language.
- The agent builder canvas uses React Flow (fixed, `PROJECT_CONTEXT.md` §7).

## 5. Backend conventions (orchestrator, agent-runtime)

- Node.js services; WebSocket for streaming (AI status steps, `ai_status` broadcasts, agent-run progress).
- Services are stateless (ADR-013 context; docs/01 §5): session state in the signed cookie/JWT, shared state in Redis/platform DB/queues. No in-process state a restart would lose — agent runs are persisted state machines and Waits are delayed queue jobs (ADR-022), never timers or sleeping threads.
- **[MANDATORY]** The orchestrator and agent-runtime reach school data **only through MCP tools** (ADR-006). No `mysql2`/driver import outside `apps/mcp-server` may point at a school database. Platform-owned DBs (registry, report_definitions, agents, rollup store) are accessed by their owning service only.
- Every request/run carries a correlation id propagated through MCP calls, queue messages, and logs.

## 6. API design

- Orchestrator HTTP API: resource-oriented, versioned under `/api/…`; drill endpoint shape is fixed: `POST /api/report/{id}/drill { level, context[] }` (ADR-020). AI endpoints live under `/api/ai/*` — this prefix is load-bearing (see §11).
- Responses that carry report data return **chart-spec**; clients must not receive raw row dumps to re-shape (keeps screen/PDF parity per ADR-021).
- Errors: structured `{ code, message, details? }` with stable machine-readable `code`s; user-facing translation happens in the SPA. Never leak SQL, stack traces, hostnames, or another tenant's identifiers in error payloads.
- Partial failure is a first-class shape: fan-out and multi-school responses include per-school status annotations ("Noida temporarily unreachable") rather than failing whole responses (ADR-011).

## 7. MCP implementation conventions

- TypeScript MCP SDK, streamable HTTP, private network only (docs/04). The six tools and their semantics are contract (ADR-006); additions preserve the invariants (out-of-band scope, SELECT-only, caps).
- **[MANDATORY]** Every tool call receives the session's allowed school set **out-of-band** (transport/context metadata), never inside model-generated content; any `school_id` argument outside the set is a hard error and an audit event (ADR-007).
- **[MANDATORY]** SQL execution path: AST validation (single statement, SELECT-only) → parameter binding → row cap 5,000 → timeout 10 s → replica pool. No code path may skip a step, including "trusted" predefined SQL — the rails apply uniformly (ADR-008).
- Tenant resolution follows docs/03 §2 exactly: registry cache → Secrets Manager cache → lazy LRU pool (`connectionLimit: 3`, ~200-pool LRU, 10-min idle sweep). Pool/limit tuning is config, not code constants.
- Per-school circuit breaker and per-tenant rate limits are implemented here, not in callers.

## 8. Multi-tenant safety

- **[MANDATORY] Never trust tenant/school/org ids, roles, or permissions from client input.** The only source is the verified launch token → platform session (ADR-002/003). Request-supplied school selections are validated `⊆ token.school_ids` at the orchestrator *and* re-checked at MCP (ADR-007). The AI model never supplies tenant identifiers.
- **[MANDATORY]** Custom-report scope, drill-context filters, and agent trigger scopes are **injected** server-side; they are displayed read-only (logic panel) and are not editable inputs — including in the advanced SQL tab (ADR-019/020).
- Cache keys, dedup keys, audit rows, and queue messages always embed the school-set/org so cross-tenant cache hits or replays are structurally impossible (docs/09 §4, ADR-025).
- **[MANDATORY]** Result-cache keys additionally embed the caller's `permission_class` — a deterministic digest of effective data visibility (masking state + drill-leaf eligibility from `role`/`perms[]`). Masking is role-dependent (docs/04 rail 6, docs/08 §4.4/§5.1), so a key without it serves one role's unmasked rows to another. Derive it in one shared, unit-tested function; a non-deterministic digest fragments the cache silently (ADR-028).
- Rollup ETL writes aggregates only — code review must reject any PII column entering `rollup_daily` (ADR-010).

## 9. Database access rules

- **[MANDATORY]** School data: replicas only, via MCP. Primary hostnames must never appear in code, config, or the registry (ADR-009 — "unaddressable" is a mechanism).
- **[MANDATORY]** All SQL — vetted, AI-generated, hand-edited, trigger — is parameterized. String-concatenated values into SQL are forbidden everywhere; drill clicks are bound parameters by contract (ADR-020).
- School-DB connections use the per-school `analytics_ro` user from Secrets Manager (ADR-008/013). No shared users, no widened grants "temporarily".
- Platform DBs (registry, reports, agents, rollups) follow the schemas documented in docs/03/06/07; schema changes update the doc in the same PR (§21).
- **The platform DB is MySQL 8** (decided 2026-08-19, `PROJECT_CONTEXT.md` §7) — the same engine as the school DBs and replicas, so there is exactly one SQL dialect in the codebase. Use the JSON column type for `def_json`, `graph_json` and `dims_json`. This is a technology choice, not a contract (§20), so it did not require an ADR; the **Rollup Store** engine remains separately open (§23).
- ORM adoption is *not decided* (§23); until it is, use the driver with parameterized statements.

## 10. Validation & error handling

- Validate at every trust boundary (see §3): HTTP inputs, token claims (signature, `exp`, `jti` replay, claim shape — docs/02), MCP tool args, queue payloads, ERP sync rows, **and LLM output** — a chart-spec from the model is parsed and schema-validated before it touches the renderer or storage; invalid spec → structured error, never partial render.
- Fail loud, degrade soft (`PROJECT_CONTEXT.md` §9.7): bad launch → launch fails with a "reopen from ERP" page; missing registry row → school dropped from scope *with a visible notice*; AI/key failure → `ai_status='error'`, chat re-locks with a fix-it banner, dashboards unaffected (ADR-017); provider failure in an agent → node marked failed with the provider error, Retry available (docs/07 §6). Silent success-shaped failure is the worst bug class in this system.
- Agent guardrail violations (cap reached, quiet hours, unapproved template) are structured, logged outcomes — not throws that kill the run loop.

## 11. Authentication & authorization handling

- **[MANDATORY]** The platform performs no credential handling; identity arrives only via the ERP launch token, verified against the ERP JWKS with nonce replay protection, exchanged for the platform's own 8-h httpOnly Secure session (ADR-002/003/004; docs/02). Never add platform-local login, password storage, or user tables mirroring the ERP.
- **[MANDATORY]** No runtime calls to ERP services for auth or config — config arrives via registry sync only (ADR-005).
- **[MANDATORY]** Every `/api/ai/*` handler re-checks `ai_status === 'active'` (and the org monthly cap) server-side; UI locks are cosmetic (ADR-017). New AI-powered features (chat, Modify-with-AI, describe-to-flow, AI-compose) must route under this gate — no sibling endpoints that "forget" it.
- Domain permissions come from token `perms[]` (docs/02 §3); role-gated behavior (accountant → fees; drill leaf policies) reads those claims, never a platform-local role model (docs/08 §4.5).

## 12. Secrets & configuration management

- **[MANDATORY]** No hard-coded secrets, keys, connection strings, or API keys — anywhere, including tests and scripts. School-DB credentials live in AWS Secrets Manager (registry stores the ARN only); BYOK keys live in the key vault, AES-256 at rest with the KMS master key, decrypted in memory at call time, excluded from all logs, masked in every UI/API response (ADR-013/017).
- **[MANDATORY]** Anthropic calls happen server-side only; no AI or DB credential ever reaches `apps/web` (§1).
- Tunables (pool sizes, TTLs, caps, tick intervals, quiet hours defaults) are environment/config-driven with the documented defaults (docs/03/07/09) — not magic numbers scattered in code.

## 13. Logging & audit

- Two streams, never mixed up:
  - **Operational logs:** structured JSON, correlation id, tenant/school-set, no PII beyond ids, and **never** SQL parameter values containing personal data, message bodies, tokens, or keys.
  - **Audit trail [MANDATORY]:** the chokepoint events in docs/08 §7 — every executed SQL (statement, school, caller, rows), drill click + context, report view, PDF export, AI query + per-school token usage, agent per-node step + message_log, config changes (key save/disable, channel connect, agent publish). Audit writes are part of the feature's definition of done, not a follow-up.
- The BYOK key and launch tokens are log-forbidden values; add them to the logger's redaction list before first use.

## 14. Testing

Framework choice is *not decided* (§23). What must be tested is:

- **Invariant tests (highest value, [MANDATORY] before GA):** scope escape attempts rejected at both layers (ADR-007); non-SELECT/multi-statement SQL rejected (ADR-008); `/api/ai/*` returns 403 for every non-`active` `ai_status` (ADR-017); drill context binds as parameters (ADR-020); agent dedup under overlapping ticks produces zero duplicate messages (ADR-025); publishing an agent referencing a disconnected channel is refused (ADR-024).
- Contract tests for `/packages` types: chart-spec parser round-trips; report-definition + drill blocks validate; hierarchy-catalog paths constrain editor options.
- LLM-dependent logic is tested with recorded/stubbed responses (valid spec, invalid spec, refusal, tool-call sequences) — no live API in unit/CI tests, which would also spend org BYOK budgets.
- The GA load-test gate (docs/09 §8, including **ERP primary CPU delta = 0**) is an acceptance test owned by the team, scripted in `/ops`.

## 15. Performance

- Respect the serving order — **cache → rollup → replica**, exactly three tiers — in code structure, not just intent: a report/drill handler asks Redis first, rollups where the dims exist, replicas last (ADR-012/028; docs/09 §4). Cache keys include report + level + drill-context + filters + school-set + `permission_class`. The schema/dimension cache is *not* a tier in this order — it is AI-path metadata (ADR-014) and never answers a report query.
- Fan-out obeys the caps (concurrency ~10, ≤25 schools) and returns partial-failure annotations (ADR-011).
- AI path: schema block positioned for Anthropic prompt caching (ADR-014/026); Haiku default with escalation; stream widgets — first render ~2 s is a product number, not an aspiration (docs/09 §3/§5).
- Never "optimize" by adding a direct DB path around MCP or a primary-DB read "just for this feature" — that is the drift these guidelines exist to prevent.

## 16. Accessibility

Formal WCAG target: *not decided* (§23). Minimum bar from the established UX (docs/10):
- All interactive elements (drill bars, breadcrumbs, picker, builder nodes, switches) keyboard-reachable with visible focus; drill interactions also exposed via the accompanying data table where present.
- Charts always ship with text equivalents (the KPI line, table, or narrative that the chart-spec already carries) — an aria-label naming the chart + the adjacent table satisfies this.
- Color is never the only signal (status dots pair with text: Connected/ON/failed), consistent with the token system's paired labels.

## 17. UI / design-system consistency

- Tokens, type scale, and components from docs/10 are the binding spec; the HTML prototype and deck are references, not sources of truth.
- Every report surface exposes the standard affordances: 🧠 View logic, ⧉ Clone, ⬇ PDF, scope line (docs/10 §3; ADR-018/019). A new report surface missing them is incomplete, not minimal.
- Drill UX elements (chip, hover hint, breadcrumb, Back/Reset, level indicator, slice total) are one shared component set — never re-implemented per dashboard (ADR-020 UX).

## 18. Reusability & component boundaries

- The seams are: `/packages/chart-spec` (all rendering), `/packages/report-defs` (all definitions + catalog), the MCP tool surface (all school data), the action-worker interface (all outbound messages), the `ai_status` gate (all AI). New features compose these seams; creating a parallel mechanism for any of them is an ADR, not a refactor.
- Predefined dashboards and Ask-AI stay separate serving paths converging only on chart-spec rendering (ADR-016) — do not "unify" them into an AI-always path.

## 19. Dependency management

- **[MANDATORY]** Do not add a dependency when an existing project dependency or the fixed stack already solves the problem (`PROJECT_CONTEXT.md` §7). In particular: no second chart library, no second flow-canvas library, no alternate HTTP/WebSocket stack, no ad-hoc crypto (KMS/Secrets Manager patterns only), no additional LLM SDKs.
- New dependencies require: written need, why existing deps don't cover it, license check, maintenance status — in the PR description. Anything touching a contract seam (§18) additionally needs an ADR.
- Pin versions via lockfiles; upgrades are deliberate PRs, not side effects.

## 20. Documentation requirements

- **[MANDATORY] Do not change an architectural contract silently.** Contracts = the six invariants, MCP tool surface, chart-spec vocabulary, launch-token claims, report-definition/drill schema, agent graph schema, channel/template rules, `ai_status` machine. Change path: ADR (Proposed → Accepted) → update the owning `docs/NN` → implement — in that order (`DECISIONS.md` §Amendment).
- Non-contract behavior changes update the owning doc **in the same PR** (docs lead, code follows — `PROJECT_CONTEXT.md` §9.1).
- Code comments explain *why* (link the ADR/doc section); the docs explain the system. Don't restate architecture in comments — link it.

## 21. Git & commit conventions

No branching/commit standard has been established for this project yet (see §23). Until one is decided, the minimum: small, single-purpose commits; imperative subject lines; reference the ADR/doc touched (`ADR-020`, `docs/06`) in the body when relevant; never commit secrets, `.env` files, or recorded LLM fixtures containing real school data.

## 22. Code review / self-review expectations

Before requesting review (or, for Claude Code, before declaring a task complete), verify against this checklist — it is the invariant list in executable form:

1. No school-data access outside MCP tools; no primary-DB hostnames anywhere (ADR-006/009).
2. Any tenant/school/org id in this change traces to the verified token, checked at both layers (ADR-002/007).
3. All SQL parameterized; SELECT-only path intact; caps applied (ADR-008/020).
4. No secret in code, config, logs, or client bundle; redaction list covers new sensitive values (§12–13).
5. AI output treated as untrusted data: schema-validated chart-spec, never rendered as markup (ADR-015; §4/§10).
6. Every new `/api/ai/*` surface behind the `ai_status` gate (ADR-017).
7. Predefined/AI path separation preserved (ADR-016).
8. Audit events written for every chokepoint this change touches (§13).
9. Contract changes have their ADR + doc update in the same change set (§20).
10. Errors fail loud / degrade soft per §10; partial failure annotated, not swallowed.
11. UX affordances (logic, clone, scope, locked-state) present on any new report surface (§17).
12. No new dependency that duplicates the fixed stack (§19).

## 23. Intentionally unspecified (not yet decided — do not assume)

These require a project decision (small ones in a PR touching this file; contract-adjacent ones via ADR) before adoption:

- Frontend TypeScript adoption level for `apps/web` (backend TS is set; SPA not formally decided).
- Linter/formatter tooling (ESLint/Prettier config not chosen).
- Test framework(s) and coverage thresholds (§14 defines *what*, not *with what*).
- ORM vs raw parameterized driver for platform DBs (§9).
- Frontend state-management library.
- Git branching model and commit-message standard (§21 holds the minimum meanwhile).
- Formal accessibility target (WCAG level) and localization approach beyond message-template language options.
- Monorepo tooling (workspaces/turbo/nx) — the §1 layout is tool-agnostic.
- Choice of queue (SQS vs BullMQ), WhatsApp BSP, and SMS/DLT provider — architecture fixes the *model*; vendors are open inputs (docs/11 §2).
- **Rollup Store technology — Aurora MySQL vs ClickHouse.** Listed among the "fixed" choices in `PROJECT_CONTEXT.md` §7 but never resolved; ADR-010 says only "a small platform DB". The two differ materially for the ETL, `dims_json` access patterns and ops load. Resolve by ADR before Phase 2 builds on it.
- Validation library for the trust-boundary parsing required by §3/§10, and the JSON Schema artifact for chart-spec (§18 seam) — one choice should serve both; it touches a contract seam, so §19 makes it ADR-gated.