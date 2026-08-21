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

## 2. Predefined catalog (15)

Enrollment Overview · Attendance Analytics · Fee Collection · Fee Defaulters (aging 30/60/90) · Exam Performance · Subject Deep-Dive · Student Progress · Staff Overview · Transport Analytics · Library & Textbooks · Admissions Funnel · Principal's Snapshot (default single-school landing) · **Director set:** Group Overview · Cross-School Attendance (students AND teachers) · School Comparison.

*Build order note (2026-08-19, extended 2026-08-20):* the catalog above is unchanged, but **Phase 1 ships Enrollment Overview · Fee Collection · Fee Defaulters · Staff Overview · Admissions Funnel** — selected for data availability in the first real ERP dataset, where attendance and exam data were absent. Attendance Analytics and Exam Performance move to Phase 3, conditional on that data existing in the per-school databases (docs/11 §1 and §2 item 6). **Attendance Analytics was built on 2026-08-21** when a second extract delivered the table; its widgets are KPI · line · bar · donut · table, with no heatmap (AUDIT_REPORT Q25 is still open and is not blocked by this). Exam Performance remains without data.

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
