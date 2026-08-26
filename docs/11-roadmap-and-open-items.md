# 11 — Roadmap, Assumptions Register & Open Items

## 1. Phased delivery (agreed plan)

| Phase | Weeks | Scope | Exit criteria |
|---|---|---|---|
| **1 — Foundations** | 1–4 | **`/packages/chart-spec` (contract + formal JSON Schema + renderer) and `/packages/shared` (token claims, error taxonomy) — first deliverables, before any dashboard**; SSO launch flow (POST handoff, ADR-029) + JWKS verify + registry sync from ERP config; replica wiring; MCP server (read-only tool surface, all seven rails); **5 core dashboards — Enrollment Overview · Fee Collection · Fee Defaulters (30/60/90 aging) · Staff Overview · Admissions Funnel** (revised 2026-08-19; Admissions Funnel taken in 2026-08-20, see below); PDF export | A school opens Analytics from the ERP menu and uses those dashboards + PDF, with zero ERP primary traffic |
| **2 — Multi-school** | 5–8 | Rollup Store + incremental ETL; `run_rollup`; school picker; Group Overview + Cross-School Attendance | A Director combines schools; cross-school views ≤ 500 ms |
| **3 — AI + custom reports** | 9–12 | BYOK wizard + key vault + `ai_status` gating; Ask-AI chat + artifact canvas + streaming (rendering onto the Phase-1 chart-spec renderer); `run_multi` fan-out; School Comparison; **clone-to-edit + logic panels + versioning + My Reports**; remaining predefined dashboards; role policies; caching + audit hardening | Chat unlocks only on verified org key; every report shows its logic; clones re-run with fresh data |
| **4 — Agents + drill + hardening** | 13–16 | Workflow Agent engine + builder + channels/Template Manager; **drill-down (hierarchy catalog, `POST /drill`, clickable charts, editor toggle, curated paths ON for predefined)**; tenant theming; scheduled PDF emails; load-test gate | Absence-alert agent live end-to-end on a pilot school; drill on Fees/Attendance; gate metrics below met |

**PDF export shipped 2026-08-21.** Server-side Puppeteer renders the print route from the chart-spec the orchestrator just built, per ADR-021 — branded header, school-scope line, bound filters, generated-on stamp, page numbers on every sheet, and the SQL appendix as an opt-in final page (docs/06 §5). Every export writes a `report.exported` audit event, which is the Export History record. Two decisions worth recording: the spec is **rebuilt server-side from the report id** rather than accepted from the client, because an endpoint that rendered posted JSON would hand anyone arbitrary numbers under the school's letterhead; and the result cache makes that re-read cost ~160 ms for anything recently viewed, so the integrity choice costs nothing in practice. Chart entry animation was turned off globally in the renderer — a PDF is a photograph, and Puppeteer caught a donut mid-draw.

**Custom reports shipped 2026-08-26, ahead of Phase 2.** Clone-to-edit (ADR-018/019) — cloning a predefined dashboard or saving an Ask AI answer into **My Reports**, versioning with one-click rollback, and visibility promotion (private → school/trust, admin-gated) — is built and live, out of Phase 3's sequence, at the product owner's request. It does not depend on the Rollup Store: a predefined clone re-runs the exact vetted `run_predefined` path with its own stored filter values, and an AI-saved report re-runs its persisted statement through `run_query`/`run_multi`, guarded exactly like every other statement on the platform. Two decisions needed to build it were resolved this session — see AUDIT_REPORT A8/C17 and **ADR-032/033**. **Explicitly deferred**, and flagged rather than silently dropped: drill-down (needs the Rollup Store for its documented L1/L2 latency budget — the product owner chose to wait for Phase 2 rather than ship it on a 2–5× slower interim path, per AUDIT_REPORT A7), **✨ Modify with AI** report editing, a from-scratch report builder, and hand-editable SQL for a predefined clone (its SQL tab is real and shown, but read-only until a "materialize to literal SQL" step is built). Remaining predefined dashboards, `run_multi` fan-out/School Comparison and role policies are still Phase 3 as scoped.

**Build-order note — Settings shipped early (2026-08-20).** The BYOK wizard, the key vault and `ai_status` gating are Phase 3 items above; they were built after the Phase 1 dashboards, ahead of the Ask-AI chat they gate. Nothing about the sequencing rationale changes — gating still ships *before* the chat it gates, which is the property that mattered. What moved is that the gate now exists with nothing behind it yet, which is the harmless direction: `ai_status` is real and read from the vault, every AI surface stays locked because no org has connected a key, and the Settings screen is the place an admin can see why. Messaging channels shipped as **state only** in the same slice — real Connected / Not-connected status per school with a working disconnect, and no provider credential capture, because that needs its own vault and the provider decisions in §2 item 8.

**Load-test gate before GA:** 200 concurrent schools · p95 dashboard < 2 s · p95 AI < 10 s · **ERP primary CPU delta = 0** · agent tick-storm drains with zero duplicate messages.

Sequencing rationale: the chart-spec contract ships first because ADR-021's PDF and CODING_GUIDELINES §4's one-chart-layer rule both require it in Phase 1 — a Phase-3 renderer would force a throwaway second chart path; predefined value ships before any AI setup exists (Phase 1); multi-school precedes AI because it rides rollups, not the LLM (Phase 2); gating ships **before** the chat it gates (Phase 3); agents and drill share Phase 4 because both extend surfaces stabilized in 1–3.

**Phase 1 dashboard selection — revised 2026-08-19.** The original four were Enrollment, Attendance, Fees, Exams. On first contact with real ERP data (the `ai_analysis` extract, St Marks society: 3 schools, 259K student rows, 1.5M fee receipts spanning 2020-04 → 2026-08), **no attendance or exam data was present**. The revised four are chosen for data availability, not architecture — nothing about the catalog, the serving path or the invariants changes:

| Phase 1 dashboard | Backing data | Was |
|---|---|---|
| Enrollment Overview | `students_data_set` — class, section, gender, category, house, religion, joining/leaving | unchanged |
| Fee Collection | `fee_collection_data_set` — 1.5M receipts by month, class, component, payment type | was "Fees" |
| **Fee Defaulters (30/60/90 aging)** | `fee_compile_data_set` — `total_payable_amount`, `paid_amount`, `balance_amount`, period dates | **replaces Attendance** |
| **Staff Overview** | `employees_data_set` — department, designation, staff type, gender, wing, attrition | **replaces Exams** |
| **Admissions Funnel** (added 2026-08-20) | `students_admission_data_set` — enquiry/registration/application/admission numbers, `candidate_statusid`, class | **fifth dashboard** |

**Attendance Analytics — mandatory for the demo, deferred in build order (decided 2026-08-19).** The TL requires it in the demo; the attendance table is being sourced from the cloud team and had not arrived. Decision: **do not block Phase 1 on it, and do not seed synthetic attendance data** — synthetic numbers in a stakeholder demo become a trust problem, and the SQL would be thrown away. Attendance is built as a **fifth dashboard when the real table lands**.

This is safe because dashboards are *additive by construction*: `run_predefined(report_id, …)` (ADR-006) plus the unified `report_definitions` model (ADR-018) make the catalog **data, not screens**. One consequence is binding on Phase 1's build order: **the dashboard catalog is implemented as a registry from the first dashboard, not retrofitted after the fourth.** Four hardcoded dashboard screens would make attendance a refactor; a registry makes it a catalog entry plus a spec sheet. Until it arrives, Attendance renders in the nav as a visible locked entry per the locked-≠-hidden convention (docs/10 §3).

*Owed to the cloud team, and worth specifying before the table is built:* required columns, **grain** (one row per student per day vs period/subject-wise), and how absence is represented. Specifying the shape up front means the table arrives usable rather than starting a schema negotiation on arrival.

**Attendance Analytics — built 2026-08-21.** A second `ai_analysis` extract delivered `student_attendance_data_set` and `employee_attendance_data_set` (plus `books_data_set`, `book_issue_data_set` and `student_transport_data_set`, which are not catalogued and remain out of scope). The dashboard is built and the prediction above held exactly: two entries in the schema catalog, one entry in the report catalog, one builder, one card state changed. No tool shape, no serving path and no invariant moved.

The grain question above was *not* answered up front and the answer matters: the table is **one row per student per day**, with **no period and no subject**, and it is **not unique on (student, date)** — one student carries six rows for a single date. Whether that is re-marking history or flattened period-wise rows that lost the period is still open, and it is the first thing to ask the ERP team, because Subject Deep-Dive needs the period-level table regardless.

Three properties of the delivered data shape the report and are documented at each site that depends on them:

| What was delivered | Consequence |
|---|---|
| `academicyearname` carries the **current** academic year on every row, not the row's — rows dated Aug 2024 are labelled `2026-27`, contradicted by the row's own `academicyearfromdate` | Attendance cannot be filtered by academic year. The year selector is resolved to an April–March **date window** and `attendancedate` carries the filter. The year is still bound, but only against `students_data_set` for the roll count |
| `statusid` is **not consistent between the two attendance tables** — 5 is `Suspend` for a student and `Absent` for an employee; 1 and 6 both mean `Present` | All bucketing reads `statusname`. No canonical status list was supplied — it joins the owed inputs in §2 item 6 — so unrecognised values are shown as recorded rather than assumed to mean absent |
| No school calendar, holiday list or timetable exists anywhere in the extract | "Attendance rate" is present student-days over **marked** student-days. A **marking-coverage** tile is published beside it, because that denominator flatters a school with poor marking discipline and the weakness belongs on the screen rather than in a comment |

**The data is not demo-grade and the numbers are not validated.** Attendance exists for exactly one school — `training_edubac`, a training society of the ERP — and for **none** of the St Marks schools: 49 student rows across 5 students and 32 dates, and 445 employee rows in which 41 of 44 employees are marked absent every single day. `db/platform/seed/premium-test.sql` registers that org as a development tenant so the serving path can be exercised end to end; it is not a basis for any claim about a school. The St Marks schools open the dashboard on a named empty state ("no attendance has been marked for this period"), which is the correct answer for them.

**Staff attendance is deliberately not a dashboard.** `employee_attendance_data_set` is catalogued, so Ask AI can reach it and Cross-School Attendance has its source registered, but the only staff-attendance entry in docs/06 §2's catalog is the Director's Cross-School Attendance, which is Phase 2 and needs the rollup store. Adding a school-level staff dashboard would be a new catalog entry, not an implementation of an existing one.

*Still owed on attendance:* the canonical `statusname` list per table; confirmation of the `academicyearname` stamping behaviour; whether the duplicate student-days are history or lost period rows; and an attendance extract for the schools the demo actually uses. Exam data remains absent (AUDIT_REPORT C20).

*Admissions Funnel* (`students_admission_data_set`: enquiry → registration → application → admission, plus `candidate_statusid`) **was taken as the fifth Phase-1 dashboard on 2026-08-20** — it is the only other catalog entry whose data exists in the extract, and the registry made it a catalog entry rather than a screen. Its stages are *inferred* from which number the ERP issued a candidate (there is no stage column and no stage dates); the dashboard says so, and publishes the ERP's own `candidate_statusid` counts beside the inferred funnel so the two can be compared. The status lookup remains an owed input (§2 item 6). **Attendance Analytics and Exam Performance move to Phase 3** with the remaining predefined dashboards, conditional on that data existing in the per-school databases — an open question against the ERP team (§2 item 6). *(Attendance was answered and built on 2026-08-21; see below. Exams are still absent.)* The full 15-dashboard catalog in docs/06 §2 is unchanged; only the Phase 1 subset moved.

**Note on Phase 1 and the owed inputs:** most of Phase 1 is buildable without §2's inputs — the packages, the MCP server and all seven rails, the orchestrator core, session/scope enforcement, the invariant test suite, IaC and the SPA shell need nothing external, and a stub ERP (local RS256 keypair + JWKS endpoint + token signer) unblocks the full launch→session→scope path while doubling as the staging harness. What is **not** buildable is the four dashboards' vetted SQL (needs input 6, the school-DB schema) and Phase 1's exit criterion itself, which requires a real ERP menu, real token, real school DB and real replica. Phase 1 can be built ahead of the inputs; it cannot be closed without them.

## 2. Inputs owed by the ERP/infra team (blocking items)

1. **School-info table structure** — the org↔school mapping table (drives registry `org_id`/`school_ids` and the token's ID space).
2. **RDS instance distribution** of the 1,500 school DBs — decides whether the replica layer is ~30 replicas (cheap) or needs consolidation first.
3. **ERP JWKS endpoint** + the menu item + token-signing endpoint (the entire ERP-side build).
4. **WhatsApp BSP and SMS/DLT provider choices** — template-approval timelines gate agent messaging more than any code.
5. ERP event webhooks (school create/update; later admission/fee events) — or approval for the small ERP patch adding them. Authentication scheme is settled (HMAC + 5-min replay window, ADR-029); what is owed is whether the ERP can emit outbound HTTP at all.
6. **The per-school ERP database schema** — DDL (`mysqldump --no-data` per live `schema_version`) for the school databases the product actually queries: students, attendance, fees, exams, staff, transport, library. **Added 2026-08-17; the most blocking item on this list and the cheapest to supply.** Without it the 4 core dashboards' vetted SQL cannot be written (Phase 1's main deliverable), `get_schema` has no fixtures to cache per version — which is what ADR-014/026's prompt-caching lever depends on — `get_dimensions` has no tables to read, and the rollup ETL has no source mapping (Phase 2). It is also the root cause of the missing per-dashboard spec sheets (AUDIT_REPORT C8). Unlike every other item here, it cannot usefully be stubbed: an invented schema makes all four dashboards' SQL throwaway.
7. **Does an ERP notification API exist** for the agent 🔔 action node — and if so, its auth model, rate limits and targeting granularity. ADR-023 names it as the sanctioned alternative to database write-backs and ADR-027 names it as a sanctioned exception to the zero-load invariant, so if it does not exist, both decisions need re-examining rather than just the node.
8. **Does the ERP already send SMS or WhatsApp today?** If an existing provider relationship, DLT entity registration or approved template library exists, per-school channel provisioning (docs/07 §4) changes from an operations programme into a configuration exercise. Highest-value unknown in the messaging area.

## 3. Assumptions register (consolidated; each also stated in its home doc)

| # | Assumption | Home doc | If false |
|---|---|---|---|
| A1 | ~30 RDS instances host the 1,500 DBs | 03/09 | Replica consolidation workstream before GA |
| A2 | 3–5 concurrently-live ERP schema versions | 03/05 | Schema cache per-tenant fallback; prompt-cache efficiency drops |
| A3 | Seconds-level replica lag; 15–30 min rollup staleness acceptable | 03/09 | Tighter ETL cadence; "as of" labeling already covers UX |
| A4 | 8-h session with launch-time role snapshot acceptable (no instant revocation v1) | 02 | Add `user_disabled` webhook + session blacklist |
| A5 | Orgs can hold their own Anthropic Console account (BYOK) | 05 | Hybrid `platform` billing mode already exists |
| A6 | ERP can add menu item + token endpoint + (eventually) webhooks | 02/07 | Polling-only agents; launch unchanged (token endpoint is mandatory) |
| A7 | Channel config school-level v1; trust-level defaults likely | 07 | Early schema decision — see Open decisions. **Possibly a prerequisite rather than an evolution:** trust-level provider accounts may be the only thing that makes per-school DLT/WABA onboarding tractable at 1,500 schools (docs/07 §4) |
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

These are design references; **this `docs/` set is the binding engineering documentation.** Amend docs before diverging code. Note that these artifacts are point-in-time and may lag the binding docs (the deck's roadmap slide omits drill-down; the prototype shows trust-level channel settings against ADR-024's school-level v1) — do not "fix" the artifacts to match, and treat findings sourced from them as needing verification against `docs/` first.
