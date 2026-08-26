# 06 — Reporting System: Predefined Catalog, Clone-to-Edit, Logic Transparency, Drill-Down, PDF

## 1. Report definition — one model for everything

Every report — predefined, custom, AI-derived — is a persisted **report definition**:

```
report_definitions(id, owner_user, school_scope, name,
                   base_report_id,      -- NULL for originals (immutable masters)
                   version, def_json,   -- source, filters, group-by, chart, drill{}
                   sql_text,            -- generated SQL (displayed, auditable)
                   shared_flag /* visibility: private | school | trust */,
                   created, updated)
```

*Why one model:* cloning, versioning, logic display, drill-down, PDF and scheduling all operate on the same object; AI answers become permanent dashboards by saving their spec+SQL into this table.

**`school_scope` semantics (2026-08-26, ADR-032 — closes AUDIT_REPORT A8).** The stored value is the *author's* scope at save time, never trusted alone at execution. Effective scope = `school_scope` **∩** the viewer's own token scope — the same "never widen, only narrow" rule Invariant 2 already applies to a request-supplied school selection, applied here to a second source of scope. If the intersection is empty the report refuses to run. The Logic panel's Scope line always shows the *effective* (viewer's) scope, never the author's — showing the author's would leak school names a `trust`-shared report's viewer may not otherwise see. A Principal opening a Director's trust-shared report therefore sees their own school's slice of it, not the whole trust.

**Re-run semantics (2026-08-26, ADR-033 — closes AUDIT_REPORT C17).** Re-run — whether from My Reports or from opening a saved report — always re-executes the persisted `sql_text`/query set deterministically, exactly like a predefined dashboard. It spends no AI tokens and keeps working even when the org's `ai_status` is not `active`, matching ADR-016/017's promise that dashboards stay unaffected by a locked BYOK key. Re-invoking the model to change a saved report is a distinct action — **✎ Refine with AI** (docs/10 §2), BYOK-gated — and is not built yet; saving and re-running are.

**Built (2026-08-26).** Clone-to-edit is live: cloning a predefined report or saving an Ask AI answer both land in **My Reports**, with versioning, one-click rollback, and visibility promotion (private → school/trust, admin-gated). The Visual editor covers filter VALUES (academic year, as-of date) for a predefined clone; the SQL tab is hand-editable for AI-saved reports today, and read-only (but real, and always shown) for a predefined clone until a "materialize to literal SQL" step is built. **✨ Modify with AI** and a from-scratch report builder remain unbuilt.

## 2. Predefined catalog (15)

Enrollment Overview · Attendance Analytics · Fee Collection · Fee Defaulters (aging 30/60/90) · Exam Performance · Subject Deep-Dive · Student Progress · Staff Overview · Transport Analytics · Library & Textbooks · Admissions Funnel · Principal's Snapshot (default single-school landing) · **Director set:** Group Overview · Cross-School Attendance (students AND teachers) · School Comparison.

*Build order note (2026-08-19, extended 2026-08-20):* the catalog above is unchanged, but **Phase 1 ships Enrollment Overview · Fee Collection · Fee Defaulters · Staff Overview · Admissions Funnel** — selected for data availability in the first real ERP dataset, where attendance and exam data were absent. Attendance Analytics and Exam Performance move to Phase 3, conditional on that data existing in the per-school databases (docs/11 §1 and §2 item 6). **Attendance Analytics was built on 2026-08-21** when a second extract delivered the table; its widgets are KPI · line · bar · donut · table, with no heatmap (AUDIT_REPORT Q25 is still open and is not blocked by this). Exam Performance remains without data.

**Three more taken up 2026-08-26 — Principal's Snapshot, Transport Analytics, Library & Textbooks.** Principal's Snapshot needed no new schema: it is the same five numbers Home's KPI strip already computes (services/home.ts), rebuilt as a first-class `report_definitions` entry so it gets a Logic panel, a PDF and a place in My Reports — and it is the first predefined report whose queries span more than one domain (students, fees, staff), which the SQL guard already supported per-table (sql/guard.ts) but which the catalog's own invariant test had never exercised; the test was generalised alongside this report rather than special-cased around it.

Transport Analytics and Library & Textbooks are a different case, worth recording precisely. `student_transport_data_set`, `books_data_set` and `book_issue_data_set` were named in the ERP extract back in 2026-08-21 but never catalogued, because — unlike every other table in this system — no sample row for any of the three had reached this repository, only their names. The first cut of both dashboards was built on an inferred column list, an explicit and informed departure from this project's normal rule (the rule that made Attendance wait for its real table rather than be stubbed) — and the inference turned out wrong the moment it was run: Transport Analytics failed outright, Library & Textbooks lost three of its five panels. Both were corrected the same day against `information_schema.columns` read directly off the local `ai_analysis` MySQL instance this dev environment has loaded (`db/platform/seed/stmarks.sql`'s `db_name`), the same verification every other table in the catalog already had. Three traps the correction found, each documented at the site that depends on it (`apps/mcp-server/src/schema/erp-v1.ts`, `apps/mcp-server/src/reports/catalog.ts`): `student_transport_data_set` keys students by `studentprofileid`, not `studentid`, and has neither a `classseq` nor a `deactivation_date`; `books_data_set` is one row per physical copy rather than one row per title with a copies-held/copies-available pair; `book_issue_data_set` carries the same stamped-current-year `academicyearname` trap as both attendance tables and mixes student and staff borrowers. Real data for the library tables exists only for `training_edubac`, none for St Marks — the same distribution Attendance found; the transport table is empty everywhere, for every org, which is a fact about the table rather than an extract gap. Exam Performance, Subject Deep-Dive and Student Progress remain unbuilt for want of any exam/marks data at all (AUDIT_REPORT C20) — a different problem, with a different owner, from the one these two solve.

All three follow the existing pattern with no changes to the catalog's shape: a schema entry (where new), a `PredefinedReport` in `reports/catalog.ts`, a builder in `services/dashboards.ts`, and a card in `services/home.ts`. Group Overview, Cross-School Attendance and School Comparison remain `coming` — they need the Rollup Store (Phase 2), which is unaffected by this work.

*As-of dating (2026-08-20).* Reports whose meaning depends on a date — Fee Defaulters' aging bands, Staff Overview's headcount — take an **`as_of_date` filter**, defaulting to today, rather than reading the server clock. A saved report, a scheduled email and a printed PDF must produce the same numbers when re-run against the same date; a clock-derived one silently produces different numbers under the same title. Note the honest limit: the fee demand ledger holds *current* balances, so `as_of_date` decides what counts as overdue and how deep the band is, and does not reconstruct the ledger as it stood on a past date. The dashboards state that on screen. Staff Overview takes **no academic-year filter** — `employees_data_set` has no academic year — and the logic panel shows only the filters actually bound.

Serving: vetted parameterized SQL + layout JSON; Redis-cached per school-set + filters (TTL 5–15 min); filters (AY, class/section, date range, term) are bound parameters. Zero AI tokens. Director dashboards answer from the Rollup Store (100–500 ms at any school count). Every dashboard carries filter pills, PDF, "🧠 View logic", "⧉ Clone & customize", and "🤖 Ask AI about this data".

## 3. Clone-to-edit & logic transparency

**Model:** originals are **immutable masters**. ⧉ Clone creates an editable, renamed copy in **My Reports** (unlimited per user). Edits create versions with one-click rollback. Visibility: private (default) / school / trust; admins can promote a good custom report to the school's shared gallery.

**Logic is always visible** — the requirement is "in edit mode and after":
- **View mode:** every report has a collapsible **Logic panel**: plain-language chips (Source · Scope · Filters · Group-by · Chart) + the generated SQL, read-only. Scope line states it is injected from the token and cannot be widened.
- **Edit mode (two tabs):** *Visual editor* (source dropdown, filter chips field–operator–value, group-by, chart type) with the **SQL regenerating live** beside it; *SQL tab* always visible, hand-editable behind an "advanced" unlock — passing the identical guardrails as AI SQL (SELECT-only AST, scope injection, caps, replicas).
- **✨ Modify with AI** (BYOK-gated): "add a section-wise split" edits the definition; both tabs immediately show the change.
- **PDF:** the logic summary can print as an appendix.

*Why transparency is a feature, not debug output:* trust ("where does this number come from?" must always be answerable by a Principal), education (the live SQL teaches users what their clicks mean), and audit (the executed statement is stored with the definition).

## 4. Drill-down reports (3 levels: High → Mid → Low)

**Creator's choice per report:** `Report type: Simple | Drill-down`. When drill-down, chart values are clickable.

### 4.1 Definition model

```json
"drill": { "enabled": true, "levels": [
  { "n": 1, "dim": "month",    "chart": "bar" },
  { "n": 2, "dim": "class",    "chart": "bar",   "inherit": ["month"] },
  { "n": 3, "dim": "fee_type", "chart": "donut", "inherit": ["month","class"] }
]}
```

**Execution rule:** every level runs the *same base query* with a different GROUP BY and a WHERE built from the **drill context** (stack of clicked values), **bound as parameters, never concatenated** — a click can only narrow the query. Token scope injects at every level.

```
L1: SELECT month,    SUM(amount_paid) …                         GROUP BY month
L2: SELECT class,    SUM(amount_paid) … WHERE month=:m          GROUP BY class
L3: SELECT fee_type, SUM(amount_paid) … WHERE month=:m AND class=:c GROUP BY fee_type
```

### 4.2 Dimension Hierarchy Catalog

Curated per source so invalid paths cannot be built; editor level-pickers offer only valid children of the level above.

| Source | Example paths |
|---|---|
| Fees | month→class→fee_type · school→class→fee_type · fee_type→class→student(top-N) |
| Attendance | month→class→section · school→class→student(<75%) |
| Enrollment | school→class→section · class→section→gender |
| Exams | term→subject→class · subject→class→mark-band |
| Transport | route→stop→student(top-N) |
| Staff | department→designation→teacher |

Rules: max 3 levels; a dimension once per path; multi-school selections offer *school* as L1; **student-level leaves are top-N capped and role-gated** (a session lacking student-data rights stops at class with a polite notice).

### 4.3 UX

"⌄ Drill-down · 3 levels" chip on the panel; pointer cursor + hover hint ("Click to see Apr-26 by class"); click swaps the chart in place; breadcrumb `Fee Collection ▸ Apr-26 ▸ Class 9` (crumbs clickable) + ← Back + ⟲ Reset + level indicator; KPI/slice-total line recomputed per level; deepest level noted. The Logic panel shows **all level SQLs** with the active one highlighted. "Ask AI about this slice" carries the drill context. Predefined dashboards ship with curated paths ON (Fees month→class→fee_type; Attendance month→class→section; Group Overview school→class→gender); clones may change or disable the path. Levels 2–3 are optional (2-level drills valid).

### 4.4 Serving & engineering

`POST /api/report/{id}/drill {level, context[]}` → rollups for L1/L2 (ETL dims extended to class and fee_type; 100–400 ms), rollup-or-capped-replica for L3 leaves (300 ms–1.5 s); cache key includes level + context + school-set; optional idle prefetch of L2 for the top-3 bars. Chart layer: Chart.js `onClick` → element → push `{dim, value}` onto the drill stack → fetch next level → in-place swap. Chart-spec gains `drillable: true` + `drill_context` — the PDF renderer reads the same spec, so exports match the screen (current view with breadcrumb in header, or a full drill pack of visited levels). Every drill click is audit-logged with its context (who viewed which student-level slice is answerable).

## 5. PDF export

Server-side Puppeteer renders the same React print route from the persisted spec: school/trust branding, school-scope line, generated-on timestamp, page numbers; optional logic appendix; drill exports as above. A lightweight client-side quick-export path may exist for casual use; official documents use the server path. Exports are logged (Export History).

## 6. Assumptions

1. The hierarchy catalog is maintained by the platform team as schema versions evolve; it is data, not code.
2. Rollup dims (class, fee_type) are added to the ETL before drill GA; until then L2 may fall back to replicas within the same latency budget.

## 7. Extensibility

- New sources/dimensions extend the catalog (data change).
- AI-generated artifacts adopting drill-down = emitting `drillable` widgets referencing catalog paths — explicitly designed as a later config-level step.
- Scheduled report emails re-run definitions and attach PDFs; no new report semantics required.
