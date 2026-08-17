# 00 — System Overview & Glossary

## 1. Purpose

This platform adds an analytics and automation layer to an existing, in-production school ERP. It was designed under three business constraints that shaped every technical decision:

1. **The ERP is sacred.** 1,500+ schools run their daily operations on it. The analytics module must be *provably incapable* of degrading it — hence the zero-ERP-load data plane (replicas + rollups + cache) and the no-runtime-calls integration model.
2. **Non-technical operators.** Principals, accountants, directors and clerks are the users. Hence: predefined dashboards that work with zero setup, plain-language AI queries, a no-code workflow builder, and logic transparency instead of SQL-first tooling.
3. **AI cost must not sit on the platform's books.** Hence BYOK: each organization connects its own Anthropic account; AI features gate on that key. Predefined dashboards never touch the AI and are free to operate at any volume.

## 2. Actors

| Actor | Scope | Typical use |
|---|---|---|
| **Director** | All schools of an org (trust) | Cross-school dashboards, comparisons, AI questions across schools |
| **Principal** | One school | School dashboards, AI questions, workflow agents |
| **Accountant** | One school, fees domain only | Fee dashboards, fee reminder agents |
| **Class teacher** | Own classes | Attendance/exam views (role-limited) |
| **Org/School admin** | Configuration | BYOK setup, messaging channels, agent management, template approval |
| **Platform operator (us)** | All tenants | Onboarding pipeline, registry, monitoring; never sees BYOK keys in plaintext |

## 3. High-level capability map

```
                          ┌────────────────────────────────┐
   ERP (existing)  ──SSO──►        ANALYTICS PLATFORM       │
   1 menu click            │                                │
                           │  Dashboards ── Predefined (15) │
                           │      │        └ Custom (clone) │
                           │      │        └ Drill-down (3) │
                           │  Ask AI ────── chart-spec      │
                           │      │         artifacts       │
                           │  Agents ────── no-code         │
                           │      │         automations     │
                           │  PDF export ── every report    │
                           └───────────────┬────────────────┘
                                           │ reads only
                            Replicas · Rollup Store · Redis
                                (never ERP primaries)
```

## 4. Glossary — terminology source of truth

Use these terms exactly; several near-synonyms have distinct meanings here.

| Term | Definition |
|---|---|
| **ERP** | The existing school management product schools log into. Owns identity and the master school↔DB configuration. |
| **Org** (organization / trust) | A legal group operating one or more schools. Unit of BYOK key ownership and AI gating. |
| **School** | One campus with its own MySQL database. `school_id` is the tenant key for data access. |
| **Tenant** | Generic term for "the school whose DB a query targets". In multi-school features, requests carry a *set* of school_ids, each resolved as a tenant. |
| **Launch token** | Short-lived (60 s) RS256 JWT the ERP signs when the user opens Analytics. Carries user, role, `org_id`, `school_ids[]`, permissions, one-time nonce. |
| **Scope** | The set of school_ids the current session may query. Comes only from the launch token; immutable within a session. |
| **Tenant Registry** | Platform-owned table mapping school_id → replica host, db name, Secrets Manager ARN, `schema_version`, `org_id`, status. Synced from ERP master config. |
| **Data plane** | The only stores queries touch: ① Redis cache ② read replicas of school RDS instances ③ Rollup Store. |
| **Replica** | RDS/Aurora read replica of an instance hosting school DBs. Per *instance*, not per database. |
| **Rollup Store** | Small platform DB of pre-aggregated per-school daily metrics (no PII). Serves cross-school and drill L1/L2 queries in ms. |
| **Fan-out** | Executing the same SELECT on N school replicas in parallel and merging (`run_multi`). |
| **MCP server** | Stateless service exposing the only tools that can read school data. Enforces scope independently of the orchestrator. |
| **Orchestrator** | Node.js backend: token verification, session, dashboard service, AI agent service, fan-out engine, key vault, PDF renderer. |
| **Chart-spec** | The structured JSON contract describing a report's widgets (KPI/bar/line/donut/table/narrative). The *only* thing the AI emits for rendering. |
| **Artifact** | A rendered chart-spec instance in the Ask-AI canvas. |
| **Report definition** | Persisted JSON describing a report: source, filters, group-by, chart, optional `drill` block; plus its generated `sql_text`. |
| **Logic panel** | The always-available "how this is calculated" view: plain-language chips + generated SQL. |
| **Drill context** | The stack of clicked `{dim, value}` pairs during a drill-down; bound as SQL parameters at each level. |
| **Hierarchy catalog** | Curated map of which dimensions each source exposes and their valid children; constrains drill paths (max 3 levels). |
| **Agent** (workflow agent) | Trigger + Flow + Schedule, stored as a JSON graph, executed once per matched record. |
| **Run** | One execution of an agent's flow for one matched record; a persisted state machine. |
| **Node** | One block in an agent flow (trigger / data / logic / action / end). |
| **Channel** | A school-configured messaging provider: Email (SMTP), SMS (DLT), WhatsApp (BSP). |
| **Template Manager** | Where message templates are created and submitted for DLT/WABA approval; action nodes may only reference approved templates. |
| **BYOK** | Bring Your Own Key — the org's Anthropic API key powering all AI features for its schools. |
| **`ai_status`** | Per-org gating state: `not_configured → pending_validation → active → error`. Server-side check on every `/api/ai/*` call. |
| **Dedup key** | Auto-derived `agent + node + record + date` key preventing duplicate messages for the same event. |

## 5. What this platform is NOT

- Not a write path into school data (no CRUD on school DBs, ever).
- Not a replacement for ERP screens; it launches *from* the ERP and reads what the ERP's operational modules produce.
- Not a general BI tool: sources, dimensions and drill paths are curated (hierarchy catalog), by design, so non-technical users cannot build broken or unsafe reports.

## 6. Design lineage (why the docs read the way they do)

The system was designed iteratively: standalone analytics dashboard → BYOK billing model → 1,500-school multi-tenant MCP design → ERP-embedded SSO + multi-school + zero-load data plane (the "v2" architecture) → workflow agents → report cloning/logic transparency → 3-level drill-down. Later decisions refine, and where stated, supersede earlier ones; these docs record the final agreed state, with rationale preserved in each doc's "Why" sections.
