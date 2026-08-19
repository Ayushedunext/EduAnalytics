# PROJECT_CONTEXT.md
 
> **Read this first.** This document gives complete project understanding before any implementation work. A senior engineer should be able to read this and understand the entire platform without opening code. Deep dives live in `docs/00–11`; binding design decisions with rationale live in `DECISIONS.md`; the six invariants are also summarized in `CLAUDE.md`.
 
---
 
## 1. What are we building?
 
The **School Analytics Platform**: an AI-powered analytics and automation product that lives *inside* an existing school ERP, serving **1,500+ schools** (each with its own MySQL database on AWS), including **trusts operating multiple schools**. It delivers:
 
| Capability | One-line description |
|---|---|
| **Predefined dashboards (~15)** | Enrollment, attendance, fees, defaulters, exams, staff, transport, library, admissions, Principal's snapshot — instant, cached, zero AI cost |
| **Director / multi-school analytics** | A trust director multi-selects schools and sees combined views: school-wise strength, gender split, student & teacher attendance, comparisons |
| **Ask AI** | Plain-language questions ("which students have <75% attendance and pending fees?") answered as live report *artifacts* — chart + table + narrative — in 3–10 s |
| **Custom reports (clone-to-edit)** | Any report — predefined or AI — can be cloned under a new name and edited; the report's logic (definition + SQL) is always visible |
| **Drill-down reports (3 levels)** | Creator-chosen per report; clickable chart values: monthly fees → class-wise for the clicked month → fee-type-wise for the clicked class |
| **Workflow Agents** | No-code automations schools build themselves: "if a student is absent today, at 10:30 WhatsApp the parent; if 3rd consecutive day, also alert the class teacher and escalate" |
| **Branded PDF export** | Every report and drilled view exports print-perfect, with scope, timestamps, and an optional logic appendix |
 
## 2. Why does this product exist? What business problem does it solve?
 
School ERPs are excellent systems of record and poor systems of *insight*. The data exists — attendance, fees, exams — but answering "which school in my trust has the weakest fee recovery?" or "who should I call about absentees today?" requires exports, spreadsheets, and a technical person who doesn't exist at most schools. Concretely, the product solves:
 
1. **Insight gap for non-technical operators.** Principals, accountants and directors get answers in dashboards and plain language — no SQL, no analyst.
2. **The trust visibility gap.** Directors running 3–30 schools have no combined view today. Multi-school analytics is a first-class feature, not an export exercise.
3. **The manual-follow-up tax.** Absence calls, fee reminders, overdue-book nudges are done by hand or not at all. Workflow Agents automate them under strict guardrails.
4. **The AI-cost objection.** AI features bill to **the school's own Anthropic account (BYOK)** — the platform vendor carries zero AI cost, and schools that don't want AI still get full value from predefined dashboards.
5. **The "will it slow our ERP?" objection.** The architecture makes zero ERP load a *mechanism*, not a promise (see §5) — the decisive argument for the ERP vendor and its 1,500 customers.
## 3. How does it integrate with the existing ERP?
 
The ERP contributes exactly two things — **identity** and **configuration** — and is never called at query time for data, configuration, or authorization. (Two sanctioned off-path exceptions exist: outbound ERP-notify from agent action nodes, and inbound ERP event webhooks — ADR-027.)
 
```
┌────────────── EXISTING ERP ──────────────┐
│ 1. User already logged in                │
│ 2. Clicks menu: "📊 Analytics"           │
│ 3. ERP signs a LAUNCH TOKEN              │      LAUNCH TOKEN (JWT, RS256)
│    (60 s, one-time nonce, JWKS-verified) │───►  { sub, name, role, org_id,
│                                          │        school_ids[], default_school,
│ ERP master config + school-info table    │        perms[], iat, exp, jti }
│  (school ↔ DB mapping, org hierarchy)    │
└───────┬──────────────────────────────────┘
        │ background sync: 15-min pull + create/update webhook
        ▼
┌────────────── ANALYTICS PLATFORM ────────┐
│ Verifies token → issues OWN 8-h session  │  ← ERP never contacted again
│ TENANT REGISTRY: school_id → org_id,     │    this session
│  replica_host, db_name, secret_arn,      │
│  schema_version, status                  │
└──────────────────────────────────────────┘
```
 
Key properties (full detail: `docs/02`):
- **No second login.** The launch token carries user, role, org, and the exhaustive `school_ids[]` scope. A Principal's token carries one school; a Director's carries all schools of the trust.
- **No runtime coupling.** Auth happens once at launch; configuration arrives by background sync. An ERP outage doesn't log analytics users out; an analytics surge can't slow the ERP.
- **Same ID space end-to-end.** The ERP's school/org IDs flow through the token, the registry, every query, and every audit record — no mapping layer to drift.
- **New school in the ERP = analytics-ready in one sync cycle,** zero deployments (the sync also provisions the read-only DB user and Secrets Manager entry).
- Embedding: new tab (default) or iframe (CSP `frame-ancestors` + `SameSite=None` cookies).
## 4. Non-negotiable architectural principles (the six invariants)
 
Violating any of these is a design regression requiring an ADR amendment *before* code:
 
1. **Zero ERP load (data path).** Analytics and agents NEVER query an ERP primary database and NEVER call an ERP service for **data, configuration, or authorization** at query time. All reads: replicas + rollups + cache. On the read path the ERP's runtime cost is one ~1 ms JWT signature per session. Sanctioned off-path exceptions — outbound ERP-notify from agent action nodes, inbound ERP event webhooks — are excluded from the zero-load measurement basis (**ADR-027**).
2. **Scope is law.** Every data access is constrained to the token's `school_ids`, enforced at the orchestrator AND independently at the MCP layer (out-of-band allowed set). The AI model never supplies tenant identifiers.
3. **Read-only data plane.** All school-data access is SELECT-only (read-only DB users + AST validation), row/time-capped. Nothing on the platform — including agents and hand-edited custom-report SQL — writes to school databases.
4. **Spec-driven rendering.** The AI emits **chart-spec JSON**, never renderable code. The frontend renders specs; the PDF renderer reads the same specs. One visual language everywhere.
5. **BYOK gating.** AI features run on the org's own Anthropic key. `ai_status != active` → every `/api/ai/*` request returns 403; UI locks are cosmetic on top of that server-side check. Predefined dashboards work regardless.
6. **Logic transparency.** Every report exposes its definition and generated SQL — in view mode, edit mode, and optionally on the PDF. No black boxes.
## 5. Overall system architecture
 
```
┌───────────────────────────── EXISTING ERP ──────────────────────────────┐
│  login → menu → signs launch token          master config ──sync──┐     │
└──────────────────────────────┬─────────────────────────────────────┼────┘
                               ▼                                     ▼
┌────────────────────────── ANALYTICS PLATFORM (own infra) ───────────────┐
│  REACT SPA                                                              │
│   school picker · dashboard gallery · Ask-AI chat + artifact canvas ·   │
│   report editor (clone/drill) · agent builder · My Reports · PDF        │
│        │ REST + WebSocket (streaming)                                   │
│  ORCHESTRATOR (Node.js) — token verify · scope check · sessions         │
│   Dashboard Service (Redis-cached) · AI Agent Service (Claude,          │
│   chart-spec) · Fan-out Engine · BYOK Key Vault (AES-256+KMS) ·         │
│   PDF Renderer (Puppeteer) · drill endpoint                             │
│        │ MCP client (private network only)                              │
│  MCP SERVER (stateless · read-only · second scope check)                │
│   get_schema · get_dimensions · run_query · run_multi · run_rollup ·    │
│   run_predefined                                                        │
│        │                                                                │
│  DATA PLANE — ERP primaries are NEVER touched                           │
│   ① Redis result cache (ms)                                             │
│   ② READ REPLICAS of school RDS instances (~30 for 1,500 DBs)           │
│   ③ ROLLUP STORE (pre-aggregated per-school metrics, no PII;            │
│      cross-school + drill L1/L2 in 100–500 ms)                          │
│                                                                         │
│  WORKFLOW AGENT RUNTIME (shares the data plane)                         │
│   Scheduler → Trigger Evaluator (replica SQL / IMAP / ERP webhooks)     │
│   → Run Orchestrator (queue; runs = persisted state machines; waits =   │
│   delayed jobs; dedup keys) → Action Workers (WhatsApp BSP · SMS DLT ·  │
│   SMTP · ERP-notify · AI-compose)                                       │
│                                                                         │
│  TENANT REGISTRY ◄── 15-min sync + webhooks from ERP master config      │
└──────────────────────────────────────────────────────────────────────────┘
```
 
Query serving order (strict): **Redis → Rollup Store → replica**. Cross-school questions: aggregates from rollups (one indexed query for 3 or 300 schools); fresh row-level detail via parallel **fan-out** across replicas (≤25 schools, partial-failure annotated). Latency budget (binding, `docs/09`): cached dashboards 50–200 ms · Director cross-school 100–500 ms · drill clicks 100 ms–1.5 s · AI 3–10 s (streaming, first widgets ~2 s) · PDF 2–4 s.
 
## 6. Major modules
 
| Module | Home doc | Essence |
|---|---|---|
| ERP Integration & Auth | 02 | Launch token, session, registry sync |
| Tenant & Data Plane | 03 | Registry, Secrets Manager, lazy LRU pools, replicas, rollup ETL, schema versioning |
| MCP Server | 04 | The only data path; 6 tools; 7 independent safety rails |
| AI Report Engine | 05 | Chart-spec contract, tool-choice rules, Haiku-first + prompt caching, BYOK vault + `ai_status` gating |
| Reporting System | 06 | Predefined catalog, clone-to-edit, logic panels, 3-level drill-down, PDF |
| Workflow Agents | 07 | Trigger+Flow+Schedule, state-machine runs, school-owned channels, Template Manager, guardrails |
| Security | 08 | Double scope check, PII minimisation, audit chokepoints, blast-radius limits |
| UI/Design System | 10 | Teal token system, screen inventory, UX conventions (locked ≠ hidden; scope always on screen) |
 
## 7. What technologies are fixed?
 
| Layer | Fixed choice | Notes |
|---|---|---|
| Frontend | React SPA + Tailwind; Recharts/Chart.js-class chart layer rendering chart-spec; React Flow for the agent canvas | |
| Backend | Node.js orchestrator; WebSocket streaming | |
| Data access | **MCP server (TypeScript SDK, streamable HTTP)** — the only path to school data | Invariant-adjacent |
| Databases | Schools' existing MySQL on AWS RDS/Aurora (given); **platform DB: MySQL 8** (registry, report definitions, agents, runs, message log) — decided 2026-08-19; **Rollup Store** (Aurora MySQL or ClickHouse — **this choice is still open**, see CODING_GUIDELINES §23; resolve by ADR before Phase 2) | Platform-DB engine chosen for dialect consistency: school DBs, read replicas and the platform DB are then all MySQL — one driver, one SQL dialect, one set of ops knowledge, and no second dialect in the AST validator's blast radius. MySQL 8's JSON type covers `def_json` / `graph_json` / `dims_json`. |
| Caching | Redis | |
| Secrets | AWS Secrets Manager (+ KMS master key for BYOK vault) | |
| AI | Anthropic API (Claude; Haiku-first, Sonnet escalation), prompt caching, BYOK keys | Bedrock/Vertex adapters are a planned extension, not v1 |
| PDF | Puppeteer server-side from the persisted spec | |
| Agent runtime | Queue-backed (SQS/BullMQ-class) persisted state machines; per-agent cron scheduling | |
| Messaging | School-owned SMTP · SMS via DLT-registered provider · WhatsApp via BSP; approved templates only | Provider *choice* is an open input, the model is fixed |
 
## 8. What must never change without architectural discussion?
 
Any of the following requires a new ADR in `DECISIONS.md` (Proposed → reviewed against the invariants → Accepted) **before** implementation:
 
- The six invariants (§4), verbatim.
- The launch-token contract and the no-runtime-ERP-calls rule (ADR-003/004/005).
- The MCP tool surface semantics and its out-of-band scope check (ADR-006/007).
- Replica-only addressing (the registry never stores primary hosts) (ADR-009).
- The Rollup Store's "aggregates only, no PII" rule (ADR-010).
- The chart-spec contract (widget vocabulary changes are additive and ADR-gated) (ADR-015).
- Immutable predefined masters; clone-to-edit; visible logic (ADR-018/019).
- Drill parameters as bound values; the hierarchy catalog as the only source of drill paths; the 3-level cap (ADR-020).
- Agents' read-only nature and the platform-level guardrails (dedup, quiet hours, caps) (ADR-023/025).
- Approved-template-only messaging on regulated channels (ADR-024).
- Server-side `ai_status` gating of every AI endpoint (ADR-017).
## 9. Implementation philosophy
 
1. **Docs lead, code follows.** `docs/` is the single source of truth; if code and docs disagree, the doc wins until amended. Amendments happen via ADRs.
2. **Deterministic before intelligent.** Ship and harden the cached/vetted-SQL path first; the AI path layers on top and is always optional (the product must be excellent with AI locked).
3. **Guardrails are mechanisms, not policies.** Prefer designs where the wrong thing is *unaddressable* (replica-only hosts, out-of-band scope, template-only sending) over designs that rely on discipline.
4. **One model, many features.** Reuse the unified report definition, the chart-spec, and the MCP tool surface rather than minting parallel paths — that reuse is why clone/drill/PDF/AI compose into each other.
5. **Everything user-visible is explainable.** Logic panels, scope lines, streaming status steps, agent run replays: if the system did something, a user can see why.
6. **Audit as you build, not after.** Every query, drill click, export, AI call, agent node execution and config change logs at its chokepoint from day one.
7. **Fail loud, degrade soft.** Bad launch tokens fail the launch; a missing school drops from scope with a notice; fan-out annotates unreachable schools; key failures re-lock AI with a fix-it banner — never silent wrongness.
8. **Phased value.** Build order (docs/11): Foundations (SSO, MCP, 4 dashboards, PDF) → Multi-school (rollups, picker, Director views) → AI + custom reports (BYOK gate ships *before* the chat it gates) → Agents + drill-down + hardening. GA gate: 200 concurrent schools, p95 dashboard < 2 s, p95 AI < 10 s, **measured ERP primary CPU delta = 0**.
## 10. Assumptions (register with consequences in docs/11)
 
- **A1** ~30 RDS instances host the 1,500 school DBs → replica economics; if false, consolidate before GA.
- **A2** 3–5 concurrently-live ERP schema versions → schema + prompt caching efficiency.
- **A3** Seconds-level replica lag and 15–30 min rollup staleness are acceptable ("as of" labeling).
- **A4** 8-h sessions with launch-time role snapshot; instant revocation is v2 (webhook path reserved).
- **A5** Orgs can hold their own Anthropic Console account (hybrid platform-billing mode exists as fallback).
- **A6** The ERP can add the menu item + token endpoint (mandatory) and eventually webhooks (optional; polling covers the gap).
- **A7** Channel config is school-level v1; trust-level defaults with per-school overrides is the expected evolution — early schema decision.
- **A8** The Dimension Hierarchy Catalog is maintained as data by the platform team as schemas evolve.
- **A9** AI pricing/model names drift; selectors and cost meters are data-driven, never hard-coded.
**Open inputs owed by the ERP/infra team (blocking):** school-info table structure (org↔school mapping) · RDS instance distribution · ERP JWKS endpoint · WhatsApp BSP and SMS/DLT provider choices · ERP event webhooks (or approval to patch).
 
## 11. What does success look like?
 
**For a school:** the Principal opens Analytics from the ERP menu with zero setup and uses 15 dashboards on day one; the accountant clones Fee Collection into "Senior Wing Fee Watch" and can show an auditor exactly how it's calculated; the absence-alert agent messages parents at 10:31 every school day and no parent is ever double-messaged.
 
**For a trust:** the Director selects all schools and gets strength, gender split, and student & teacher attendance across them in under half a second; drills Apr-26 → Class 9 → fee types in three clicks; asks "which school has the lowest teacher attendance this month?" and gets a chart in seconds — billed to the trust's own AI account at rupees per question.
 
**For the ERP vendor (us):** measurable ERP primary CPU delta of **zero** under full analytics load; onboarding a school is a sync cycle, not a project; AI cost sits on org accounts with per-school metering; every data access, message and export is auditable.
 
**Measurable acceptance (GA gate, docs/09/11):** 200 concurrent schools · p95 dashboard < 2 s (cache-hit p95 < 300 ms) · Director cross-school p95 < 500 ms · p95 AI < 10 s with first widgets ~2 s · agent tick-storm drains with zero duplicate messages · ERP primary delta = 0.
 
---
 
*Companion documents: `CLAUDE.md` (session orientation + invariants) · `DECISIONS.md` (ADRs — the why behind everything here) · `docs/00–11` (module deep dives).*