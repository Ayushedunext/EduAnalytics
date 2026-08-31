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

**Re-run semantics (2026-08-26, ADR-033 — closes AUDIT_REPORT C17).** Re-run — whether from My Reports or from opening a saved report — always re-executes the persisted `sql_text`/query set deterministically, exactly like a predefined dashboard. It spends no AI tokens and keeps working even when the org's `ai_status` is not `active`, matching ADR-016/017's promise that dashboards stay unaffected by a locked BYOK key. Re-invoking the model to change a saved report is a distinct action — **✎ Refine with AI** (docs/10 §2), BYOK-gated — and is a separate action from saving/re-running, built the same day (below).

**Built (2026-08-26).** Clone-to-edit is live: cloning a predefined report or saving an Ask AI answer both land in **My Reports**, with versioning, one-click rollback, and visibility promotion (private → school/trust, admin-gated). The Visual editor covers filter VALUES (academic year, as-of date) for a predefined clone; the SQL tab is hand-editable for AI-saved reports today. A from-scratch report builder remains unbuilt.

**✎ Refine with AI, per chart (2026-08-26).** Every widget on a custom report — whichever predefined dashboard it was cloned from, or an AI-saved report — carries its own "✦ Ask AI" button (only for the report's owner; locked, not hidden, when the org's `ai_status` isn't `active`), opening a side panel that reuses the exact Ask AI engine (`services/ai-chat.ts`'s `runAskAi`) seeded with that ONE widget's current SQL and chart definition rather than a blank question. A question ("why is X higher than Y") gets answered in the returned narrative; a request for a change (different chart type, filter, grouping, time range) gets a new proposed chart — either way the model still never receives row data (ADR-030 is unchanged by this: refining is a different STARTING POINT for the same planning loop, not a different privacy regime). Nothing is written until the user clicks **Apply as a new version**, which is also the answer to the "materialize to literal SQL" gap named above: an AI-proposed answer is always literal SQL (`run_query`/`run_multi` accept no placeholders), so applying one to a predefined clone (`mode: 'template'`) converts it to `mode: 'raw_sql'` on that save — a one-way door, exactly as `db/platform/migrations/0007_report_definitions.sql`'s header comment anticipated, and reachable ONLY through this AI-authored path (`services/custom-reports.ts`'s `applyRefinement`); the hand-edit SQL tab (`updateReportSql`) still refuses a `template`-mode report outright, unchanged. Because this lives in the shared `ReportEditor`/`ChartSpecView` layer rather than per-dashboard catalog code, it needed no per-dashboard rollout the way per-widget clone's bucket variants do (§3 below) — it already works on every custom report, from every predefined dashboard, the day it shipped.

## 2. Predefined catalog (15)

Enrollment Overview · Attendance Analytics · Fee Collection · Fee Defaulters (aging 30/60/90) · Exam Performance · Subject Deep-Dive · Student Progress · Staff Overview · Transport Analytics · Library & Textbooks · Admissions Funnel · Principal's Snapshot (default single-school landing) · **Director set:** Group Overview · Cross-School Attendance (students AND teachers) · School Comparison.

*Catalog addition (2026-08-31):* **Comparative Analysis** — year-on-year fee recovery, school by school (§4.5b). It sits beside Fee Collection rather than inside it: Fee Collection answers "where did this year's money come from?", this answers "is it better than last year, and which school is behind?". It is a `school`-group card, not a `director` one, even though its page is a school-by-school comparison — the `director` half of the menu is reserved for the screens ADR-010 puts behind the rollup store, and this is served by the same per-school fan-out every other report uses (ADR-011), working for one school as readily as for twenty.

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

**Per-widget clone (2026-08-26).** ⧉ Clone also appears on an individual chart, not only on the dashboard's own header — cloning one widget saves just that chart to My Reports, editable on its own, rather than the whole page. This is the same `report_definitions` model (ADR-018): a widget-scoped clone is still one row, `def_json.mode: 'template'` with an added `widget_scope` naming which widget, executed by asking `run_predefined` for only that widget's own query (`query_keys`, docs/04 §2) rather than the report's full set. A bucketable time-series widget (Fee Collection's "Receipts by month" is the reference implementation) also offers a `bucket` choice — week / month / quarter / year — resolved server-side to one of a small number of pre-vetted alternate statements per widget (`ReportQuery.variants`, mcp-server/src/reports/catalog.ts), never a caller-composed GROUP BY: `run_predefined`'s guarantee that a caller supplies filter values and never SQL is unchanged. `services/dashboards.ts`'s `WIDGET_QUERY_KEYS`/`WIDGET_BUCKET_OPTIONS` tables say which widgets on which report support this; a widget absent from those tables has no per-widget clone button and cannot be cloned on its own even if a request is crafted by hand. **Built for Fee Collection first** (all four of its widgets clone individually; only "Receipts by month" offers a bucket); the remaining 14 dashboards get the same treatment as a tracked follow-up (docs/11), not a redesign — each is a table entry plus, for its own time-series widgets, hand-written and guard-tested bucket variants against that report's real date column.

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
| Fees | month→class→fee_type · school→class→fee_type · fee_type→class→student(top-N) · school→instalment→class *(built; see §4.5b)* |
| Attendance | school→quarter→class *(built; see §4.4)* · month→class→section · school→class→student(<75%) |
| Enrollment | school→class→section · class→section→gender |
| Exams | term→subject→class · subject→class→mark-band |
| Transport | route→stop→student(top-N) |
| Staff | department→designation→teacher |

Rules: max 3 levels; a dimension once per path; multi-school selections offer *school* as L1; **student-level leaves are top-N capped and role-gated** (a session lacking student-data rights stops at class with a polite notice).

### 4.3 UX

"⌄ Drill-down · 3 levels" chip on the panel; pointer cursor + hover hint ("Click to see Apr-26 by class"); click swaps the chart in place; breadcrumb `Fee Collection ▸ Apr-26 ▸ Class 9` (crumbs clickable) + ← Back + ⟲ Reset + level indicator; KPI/slice-total line recomputed per level; deepest level noted. The Logic panel shows **all level SQLs** with the active one highlighted. "Ask AI about this slice" carries the drill context. Predefined dashboards ship with curated paths ON (Fees month→class→fee_type; Attendance month→class→section; Group Overview school→class→gender); clones may change or disable the path. Levels 2–3 are optional (2-level drills valid).

### 4.4 Serving & engineering

`POST /api/report/{id}/drill {level, context[]}` → rollups for L1/L2 (ETL dims extended to class and fee_type; 100–400 ms), rollup-or-capped-replica for L3 leaves (300 ms–1.5 s); cache key includes level + context + school-set; optional idle prefetch of L2 for the top-3 bars. Chart layer: Chart.js `onClick` → element → push `{dim, value}` onto the drill stack → fetch next level → in-place swap. Chart-spec gains `drillable: true` + `drill_context` — the PDF renderer reads the same spec, so exports match the screen (current view with breadcrumb in header, or a full drill pack of visited levels). Every drill click is audit-logged with its context (who viewed which student-level slice is answerable).

### 4.5 First implementation — Fee Collection (2026-08-27)

The first real drill path, and what building it settled. Nothing above is superseded; this records how §4.1–4.4 came out in code, and where the shipped path differs from the sketch.

**The path is school → academic quarter → class**, on Fee Collection's new "Demand, collection and pending" chart (widget `bar-school`), not the month→class→fee_type of §4.3. All three levels draw the same three measures as **grouped bars** — *Fee payable*, *Fee collected*, *Fee pending* — so a reader compares the same quantities at every depth and only the x-axis changes. The measures come from `fee_compile_data_set`'s own columns (`total_payable_amount`, `paid_amount`, `balance_amount`); *pending* is the ledger's balance, never payable minus collected, so a head that has been over-received does not draw a negative bar the ledger itself does not report. Quarters are **academic** (Q1 = Apr–Jun … Q4 = Jan–Mar), measured from the period a fee was demanded for — the same 1 April boundary `academicYearWindow` already uses, so the two cannot drift.

**The Dimension Hierarchy Catalog is `DRILL_PATHS`** in `apps/orchestrator/src/services/dashboards.ts`, and it is enforcement, not documentation: `services/drill.ts` validates a click against it and refuses a dimension no level declares, a context whose depth does not match the level, or one whose dimensions arrive out of order. There is no path by which a browser can name a GROUP BY.

**A clicked school narrows SCOPE, not a filter.** It never reaches the SQL. The clicked id is checked against the request's already-token-intersected school set and then becomes the school set for that level, so the MCP layer checks it again independently (ADR-007) and Invariant 2 needs no drill-specific rule. Non-school dimensions bind as §4.1 says: the clicked quarter travels as `:drill_quarter`, declared numeric and refused if it is not.

**Level 1 costs no query.** It re-groups the `by_component` rows the dashboard already fetched — per school instead of summed across schools — rather than running a by-school statement. On tables with no usable index that is seconds, not milliseconds (mcp-server/src/reports/catalog.ts). Levels 2 and 3 are marked **`drill_only`** in the catalog: `run_predefined` leaves them out of a default run, so opening the dashboard never pays for a drill nobody clicked, while naming one explicitly still runs it. The flag decides who pays, never who may ask.

**Serving is replica-with-cache, not rollups.** §4.4's L1/L2 rollup tier depends on ETL dims that are not built (assumption 2 of §6 anticipated exactly this), so every level is a capped replica read behind the tier-① result cache, whose key carries level + drill context + narrowed school set + permission class (ADR-012 as amended by ADR-028). The top-3 idle prefetch of §4.4 is not built.

**UX as shipped:** pointer cursor and a hover hint on a drillable chart; click swaps it in place; breadcrumb with clickable crumbs, ← Back, ⟲ Reset and a "Level *n* of 3" indicator, rendered by the page into the panel's actions slot beside ⧉ Clone — drill navigation is page state, never part of the spec, so a PDF cannot inherit one reader's navigation. The Logic panel gains the active level's SQL, highlighted, per §4.3. Not yet built: per-slice KPI recompute, "Ask AI about this slice" carrying the context, and drill-aware PDF export (the export still prints level 1). Chart-spec carries `drillable` + `drill_context` as §4.4 says, plus `drill_dim` (the dimension a click pushes) and `drill_value_field` (where a school reads as a name and drills on an id) — a `drillable` widget without a `drill_dim` now fails schema validation, so a chart cannot advertise a click that has nowhere to go.

### 4.5b Comparative Analysis (2026-08-31) — school → instalment → class

A third predefined report and a third drill path, added for management rather than for a bursar: **is recovery better or worse than last year, and which school is dragging it.** Every measure arrives twice, this year and a comparison year, and nothing is summed across schools without also being available per school.

**The comparison year is a real filter,** not a boolean "versus last year": `compare_year`, declared by the report, bound like `academic_year`, shown on the logic panel and recorded in the audit trail. It defaults to the preceding year, derived server-side, so a reader who has no opinion expresses none; the screen offers the four preceding years. The route refuses a comparison year equal to the academic year — both halves of the SQL would then select the same rows and the comparison side of every chart would come back empty, which renders as a total collapse in recovery against a year with no data.

**The comparison axis is the MONTH a fee was demanded for, never `installmentname`,** and this is the report's one non-obvious decision. That column is free text a school types: read across eight live schools on 2026-08-31, one writes "APR 2025-26" one year and "April 2026-27" the next, another "Apr", a third "APL (2025-26)", a fourth mixes "Apr-2026" with "April-June 2026" and "1st Installment" in the same year. Grouping a comparison on that string puts the two years in *disjoint* categories — every bar carries one year and a gap where the other should be, which reads as a school that raised no fees last year rather than as a bug. `MONTH(periodfromdate)` means the same thing in every school and every year, and it is the only dimension that survives the ERP's date staleness (one school's `periodfromdate` still carries 2023 in both years' rows; the month is right even though the year is not). The academic ordering — April first, March last — is applied by the orchestrator against the same 1 April boundary the quarters use. A reader who wants their school's own instalment names clicks into it: **level 2 is grouped by exactly those**, inside the one school and year where they are consistent.

**Payment timing is measured in MONTHS, from the receipt ledger.** `PERIOD_DIFF` between the month a receipt was banked and the month its instalment closed: before it is "paid in advance", the same month is on time, the next month is late, later still is later. Months and not days, because a school's fee calendar is monthly — a circular says "October instalment", a parent pays "in October" — and days would file a payment made on the 31st as on time and one made on 1 November as four weeks late. It also makes the states an exact partition, which days would not: measured against the live extract, the five sums tie to the receipt total to the rupee. A receipt whose instalment records no closing date is counted separately as "timing not recorded" rather than flattering or libelling the school.

**The two ledgers do not tie, and the report says so.** The paid states come from the receipt ledger (the only one that records *when* money arrived) and "still pending" from the demand ledger (the only one that records what is *still owed*), so the timeline is drawn as a share of receipts plus outstanding demand rather than of demand raised — which is what makes the stacked bar reach exactly 100%.

**Two statements for the whole left-hand side.** The demand ledger is scanned once for both years (the year joins the GROUP BY rather than becoming a second statement) and the receipt ledger once for the timing states; every KPI is a column sum of those rows and the school breakdown is the same rows grouped by the school that returned them. Level 1 therefore costs no query of its own, exactly as Fee Collection's does. Levels 2 and 3 are `drill_only` and draw the **current year only** — said at the level where it stops being true, not in the report's notes.

**The caveat that decides how everything else reads, and it is first in the notes:** the two years are not like for like until the current one has finished. Fee demand is raised for the whole year up front while collection is still arriving, so a mid-year total always looks far behind a completed year — in the live extract, three schools five months into 2026-27 show ~52% recovery against ~99% for the closed 2025-26, which the status bands then grade "Needs attention" for every school at once. That is a year in progress, not a school in trouble. The per-period charts are the like-for-like read, because each month is compared against the same month.

### 4.6 Second path — Fee Defaulters (2026-08-29), and what a COUNT changes

The same three levels — school → academic quarter → class — on a **single** measure: how many students carry overdue fees. One bar per school, drilling to one bar per quarter, then one per class. Adding it was a catalog entry (`DRILL_PATHS['fee-defaulters']`), two `drill_only` queries and a level-1 widget; no new screens, no new endpoint, no change to the drill service's control flow. That was the point of §4.5's shape.

**One measure is a plain bar, not a group of one.** `DrillPath.measures` holds one or more; two or more become a grouped bar with a legend, one stays a single-series bar keeping the gradient and tallest-bar highlight that only mean something when a chart compares within itself. The spec enforces the floor: `bar.series` requires at least two entries, so a one-entry group cannot be built even by mistake.

**Counting people is not counting money, and the levels prove it in opposite directions.** A defaulter is a person, so:

- **classes within a quarter DO sum to the quarter** — a student sits in one class, so the classes partition it exactly (verified: sacskb Q1, 1,056 = 1,056 across 14 classes; Q2, 4,551 = 4,551 across 15);
- **quarters within a school DO NOT sum to the school** — a student overdue on a Q1 instalment and a Q3 instalment is one defaulter and two bars. Measured 2026-08-29: sacskb has 5,155 distinct defaulters against quarter bars of 1,056 / 4,551 / 4,870 / 4,890, summing to 15,367. Three times the truth.

Counting each student once — in their earliest overdue quarter, say — would make the bars add up and would answer a question nobody asked; "how many students are overdue for Q3" is the number a bursar chasing Q3 needs. So the honest count stays and the **level carries its own note**, rendered against the bars rather than in the report's notes list. `DrillLevel.note` is new for this: a caveat that is true at one level and not the others belongs where the misreading would happen, not three screens below it. The class level carries the converse note, because "these ones do add up" is equally worth knowing.

**Two date columns, two jobs.** The overdue test stays `periodtodate < :as_of_date` — the same test every other query in the report uses, so a drill cannot quietly redefine what a defaulter is. The quarter BUCKET is `periodfromdate`, matching Fee Collection, so "Q2" means the same instalment on both dashboards. They disagree only for a period straddling a quarter boundary: 4,158 of 333,598 rows at sacskb (1.2%), 25 at premium_test, none at all in the four St Marks schools.

**Cache versioning is now a standing rule, not an incident.** `sap:v3` → `sap:v4`. Adding a widget changes the shape of a cached value even when no type changes and nothing fails to deserialise, and the key is otherwise identical — so a warm cache serves the pre-change dashboard for the whole TTL. That happened on Fee Collection (found by running it, not by reasoning) and would have happened again here. The rule: **if a reader would see something different, bump the digit.**

### 4.7 Enrollment and Attendance (2026-08-31) — the rollout, and what it cost

Two more paths, added as catalog entries. No endpoint, no service control flow and no UI route changed; the generic drill tests picked both up on their own, which is the property §4.6 predicted and this is the confirmation of it.

**Enrollment: school → class → section.** Levels 1 and 2 introduce **no SQL at all** — level 1 keeps `by_class` per school instead of summing it across schools, and level 2 *is* `by_class`, the statement the dashboard's own bar chart already runs. Only the leaf needed writing, because narrowing to one class has to happen in the database rather than by filtering a full result in the orchestrator. Verified: Meera Bagh's 3,930 on roll split into 14 classes summing to 3,930, and class IX's 304 split into eight sections summing to 304. Every level partitions the one above exactly — a student is on one roll, in one class, in one section — so this path carries **no note and no `pending` marker**, and that absence is deliberate rather than an oversight.

**Attendance: school → academic quarter → class**, drawn as **counts** (present and absent student-days), never the attendance rate the dashboard's tiles lead with. A rate is a quotient and quotients do not survive the merge: adding two schools' rates, or two quarters', produces a number belonging to neither, which `services/dashboards.ts` has warned about since the first dashboard. Counts add correctly at every level and the ratio is legible in the two bars anyway. The quarter level carries a note that these are *marked* student-days — a day nobody marked is missing from the bars rather than counted as an absence, so a thin quarter may mean poor marking rather than good attendance. **Amended 2026-08-31: the middle level was `month` until this date.** Fees and Defaulters both descend school → quarter → class, and an attendance path whose middle level was a month made that level mean something different on one card out of four — a reader comparing "Q2 fees" against "July attendance" is comparing two windows without having been told. The quarter is the same Apr–Mar boundary the fee ledger uses; one `academicQuarter` helper in the report catalog produces both, so the two cannot drift into disagreeing about when the school year starts. No monthly view was lost: the dashboard's own `by_month` line chart still draws the trend on the report page, which is where month-level detail was actually read. A school with nothing marked is **omitted** rather than drawn as a pair of zero bars, because zero present and zero absent reads as "nobody came" when the true statement is "nobody marked the register".

**Fee by student: school → academic quarter → class**, added 2026-08-31 with the `fee-by-student` dashboard. One measure — the amount outstanding — drawn as a plain bar. Every level's statement also returns a student count and it is deliberately **not** a second bar: a count of 500 and an amount of ₹5,000,000 share an axis only in the sense that both are numbers, so the count would be an invisible sliver and the axis would be labelled for neither. The count lives on the report's own tiles, at a scale of its own.

This report reads the **whole year's book, due or not**, which is what separates it from Fee Defaulters — every one of *that* report's statements filters `periodtodate < :as_of_date`. The same child appears in both with different numbers, correctly: a family owing ₹80,000 for the year of which ₹20,000 has fallen due is a ₹20,000 defaulter and an ₹80,000 payer. The quarter level says so against its own bars, because a bursar comparing the two totals must not read the gap as an error. It declares **no `as_of` filter** for the same reason: nothing here depends on what has fallen due, and a filter that appeared to move the numbers without moving them is worse than an absent one.

**It names children.** The `students` table selects `studentname` and `enrollmentno`, both `pii: 'students'`, so a session without `students.read` receives the amounts against `[masked]` — applied at the MCP layer by rail 6 from MySQL's own column origins, without the statement knowing. **`fees.read` alone is not enough to see a child's name**, which is the platform's existing policy rather than a rule this report invents. Capped at the 200 largest balances (docs/06 §4.2's top-N rule), re-sorted and re-capped after the per-school merge — a merge of several ranked lists is not itself ranked.

**Staff attendance: school → academic quarter → department**, added 2026-08-31 with the `staff-attendance` dashboard itself. A quarter IS available here where Staff Overview had none, and the difference is the data rather than a preference: `employee_attendance_data_set` carries a real per-row date, so bucketing is arithmetic; headcount had nothing to bucket. Department is the leaf for the same reason Staff Overview stops there. The bars are **present and absent staff-days** — counts, never a rate — and **half-day leave is in neither**, which the level says on its own face rather than letting two bars imply they account for every marked day.

**Staff: school → department → designation** and **Transport: school → pickup route → class**, both added 2026-08-31 so that every chart on the Dashboard grid descends. Neither has a quarter level and neither should: staff headcount is a point-in-time question (`employees_data_set` has no year or term at all, which is why the report declares no year filter), and ridership is a standing arrangement recorded with no date column to bucket. Quarter where the data supports it, the natural hierarchy where it does not. Staff stops at designation because the only level below it is naming individuals — a different report with a different PII posture. Transport's class level is ordered by **number of riders, not class ordinal**, and says so on the chart: `student_transport_data_set` carries no `classseq`, a drill level fetches one statement, and sorting class labels as text puts X before IX. Transport's drill inherits the dashboard's **unverified-schema** caveat, since it reads the same columns; a column named differently fails loudly at the guard rather than drawing something plausible.

**A drill dimension can be a string.** `drill_class` is the one that is; `drill_quarter` is a number. (`drill_month` was a second string dimension until 2026-08-31, when Attendance moved to quarters and the parameter was removed rather than left declared and unread.) The value is bound like every other filter (CODING_GUIDELINES §9), so a class named `'; DROP TABLE students; --` is a class that matches no rows rather than a statement — asserted in `test/drill.test.ts`, so that a future "sanitise the drill value" is recognisable as the wrong fix at the wrong layer.

**Attendance is verifiable only against 49 rows.** The extract holds attendance for one training society and none of the St Marks schools (docs/11), so the path is proven end to end — school → 2026-07 → class 8 → 12 present, 3 absent — on data too small to be a demonstration of anything. The plumbing is right; the numbers are not evidence about a school.

**Four dashboards drill; eleven do not.** The remaining ones are catalog entries, not new screens.

## 5. PDF export

Server-side Puppeteer renders the same React print route from the persisted spec: school/trust branding, school-scope line, generated-on timestamp, page numbers; optional logic appendix; drill exports as above. A lightweight client-side quick-export path may exist for casual use; official documents use the server path. Exports are logged (Export History).

## 6. Assumptions

1. The hierarchy catalog is maintained by the platform team as schema versions evolve; it is data, not code.
2. Rollup dims (class, fee_type) are added to the ETL before drill GA; until then L2 may fall back to replicas within the same latency budget.

## 7. Extensibility

- New sources/dimensions extend the catalog (data change).
- AI-generated artifacts adopting drill-down = emitting `drillable` widgets referencing catalog paths — explicitly designed as a later config-level step.
- Scheduled report emails re-run definitions and attach PDFs; no new report semantics required.
