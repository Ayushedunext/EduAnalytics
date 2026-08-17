# 11 — Roadmap, Assumptions Register & Open Items

## 1. Phased delivery (agreed plan)

| Phase | Weeks | Scope | Exit criteria |
|---|---|---|---|
| **1 — Foundations** | 1–4 | SSO launch flow + JWKS verify + registry sync from ERP config; replica wiring; MCP server (read-only tool surface); 4 core dashboards (Enrollment, Attendance, Fees, Exams); PDF export | A school opens Analytics from the ERP menu and uses 4 dashboards + PDF, with zero ERP primary traffic |
| **2 — Multi-school** | 5–8 | Rollup Store + incremental ETL; `run_rollup`; school picker; Group Overview + Cross-School Attendance | A Director combines schools; cross-school views ≤ 500 ms |
| **3 — AI + custom reports** | 9–12 | BYOK wizard + key vault + `ai_status` gating; Ask-AI chat + artifact canvas (chart-spec renderer); `run_multi` fan-out; School Comparison; **clone-to-edit + logic panels + versioning + My Reports**; remaining predefined dashboards; role policies; caching + audit hardening | Chat unlocks only on verified org key; every report shows its logic; clones re-run with fresh data |
| **4 — Agents + drill + hardening** | 13–16 | Workflow Agent engine + builder + channels/Template Manager; **drill-down (hierarchy catalog, `POST /drill`, clickable charts, editor toggle, curated paths ON for predefined)**; tenant theming; scheduled PDF emails; load-test gate | Absence-alert agent live end-to-end on a pilot school; drill on Fees/Attendance; gate metrics below met |

**Load-test gate before GA:** 200 concurrent schools · p95 dashboard < 2 s · p95 AI < 10 s · **ERP primary CPU delta = 0** · agent tick-storm drains with zero duplicate messages.

Sequencing rationale: predefined value ships before any AI setup exists (Phase 1); multi-school precedes AI because it rides rollups, not the LLM (Phase 2); gating ships **before** the chat it gates (Phase 3); agents and drill share Phase 4 because both extend surfaces stabilized in 1–3.

## 2. Inputs owed by the ERP/infra team (blocking items)

1. **School-info table structure** — the org↔school mapping table (drives registry `org_id`/`school_ids` and the token's ID space).
2. **RDS instance distribution** of the 1,500 school DBs — decides whether the replica layer is ~30 replicas (cheap) or needs consolidation first.
3. **ERP JWKS endpoint** + the menu item + token-signing endpoint (the entire ERP-side build).
4. **WhatsApp BSP and SMS/DLT provider choices** — template-approval timelines gate agent messaging more than any code.
5. ERP event webhooks (school create/update; later admission/fee events) — or approval for the small ERP patch adding them.

## 3. Assumptions register (consolidated; each also stated in its home doc)

| # | Assumption | Home doc | If false |
|---|---|---|---|
| A1 | ~30 RDS instances host the 1,500 DBs | 03/09 | Replica consolidation workstream before GA |
| A2 | 3–5 concurrently-live ERP schema versions | 03/05 | Schema cache per-tenant fallback; prompt-cache efficiency drops |
| A3 | Seconds-level replica lag; 15–30 min rollup staleness acceptable | 03/09 | Tighter ETL cadence; "as of" labeling already covers UX |
| A4 | 8-h session with launch-time role snapshot acceptable (no instant revocation v1) | 02 | Add `user_disabled` webhook + session blacklist |
| A5 | Orgs can hold their own Anthropic Console account (BYOK) | 05 | Hybrid `platform` billing mode already exists |
| A6 | ERP can add menu item + token endpoint + (eventually) webhooks | 02/07 | Polling-only agents; launch unchanged (token endpoint is mandatory) |
| A7 | Channel config school-level v1; trust-level defaults likely | 07 | Early schema decision — see Open decisions |
| A8 | Hierarchy catalog maintained as data by platform team | 06 | — (process assumption) |
| A9 | AI pricing/model names drift; meters are data-driven | 05/09 | — |

## 4. Open product decisions (non-blocking, decide during build)

1. **Custom-report sharing default** — private/school/trust exists; the governance flow for admins promoting reports to the shared gallery needs a one-page policy.
2. **Channel ownership granularity** — trust-level provider accounts with per-school overrides (e.g., one BSP, per-school SMS sender IDs): small schema decision now vs migration later.
3. **Drill "full pack" PDF default** — current-view vs all-visited-levels as the default export.
4. **AI artifacts adopting drill-down** — designed as a config-level step on the chart-spec `drillable` flag; schedule after drill GA.
5. **Compliance review** — formal pass on data retention, audit retention, and messaging (DLT/WABA, unsubscribe) before GA.

## 5. Reference artifacts produced during design

| Artifact | Purpose |
|---|---|
| `school-analytics-architecture-v2.md` (+ `.docx`) | The narrative v2 architecture document these docs decompose |
| `workflow-agent-builder-plan.md` | Original agent feature plan |
| `drill-down-reports-plan.md` | Original drill-down feature plan |
| `School-Analytics-Dashboard-v2-Complete.pptx` (19 slides) | Stakeholder deck: architecture, mockups, design system |
| `school-analytics-prototype.html` | Clickable prototype of every screen with sample data ("Sunrise Trust") |

These are design references; **this `project-docs/` set is the binding engineering documentation.** Amend docs before diverging code.
