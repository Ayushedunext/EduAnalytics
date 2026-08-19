# AUDIT_REPORT.md — Documentation Consistency & Architecture Audit

> **Revision 2 — 2026-08-17.** Rev 1 findings are preserved with their original IDs and wording; each now carries a **Status**. New findings from the Rev 2 pass continue the same numbering (A5–A11, C13–C17) plus a new Section E.
>
> **Scope:** the 16 files of the binding doc set — `CLAUDE.md`, `PROJECT_CONTEXT.md`, `docs/DECISIONS.md`, `docs/CODING_GUIDELINES.md`, `docs/00–11`.
>
> **Method difference between revisions (important).** Rev 1 audited the docs *against the design conversation* as source of truth. Rev 2 had no access to that conversation; it audited **the files as they exist on disk, against each other**. Consequences:
> - Rev 2 can confirm or refute claims about *what the documents say*. Two Rev 1 findings did not survive that check (see A2, A3).
> - Rev 2 **cannot** re-verify claims about what was or wasn't agreed verbally (B1–B6 are largely of this kind). Those are left intact and marked *not re-verifiable in this pass* — absence of confirmation here is not evidence against them.
>
> **Rule followed during the audit passes:** Rev 1 and Rev 2 modified nothing outside this file — every finding was recorded for explicit decision rather than fixed.
>
> **⚠️ This no longer describes the file's current state.** On **2026-08-17** the TL decided the nine Phase-1-blocking questions, and those decisions *were* applied across the doc set via ADR-027/028/029 — see the Resolution log immediately below for the ADRs, the closed findings, and the full list of changed files. Findings still marked `OPEN` remain untouched in the docs.
>
> **Classifications:** CONFIRMED · ASSUMPTION · OPEN QUESTION · CONTRADICTION · MISSING · HYGIENE.
> **Statuses:** `OPEN` (stands, undecided) · `RESOLVED` (fixed in the docs since Rev 1) · `REVISED` (Rev 1 claim corrected here) · `TRACKED` (owned by an existing open item).
>
> **Overall verdict (Rev 2).** The set remains internally consistent on all six invariants and every ADR-level decision — no document contradicts an invariant's *intent*. However, Rev 2 found that **Invariant 1's literal wording is contradicted by two sanctioned agent features** (A5), and that three security- and privacy-relevant surfaces are entirely unspecified (C13, C14, C15). Rev 2 tally as first recorded: **10 contradictions/tensions · 4 unconfirmed assumptions (1 resolved, 1 informational) · 16 missing items (1 tracked elsewhere) · 4 hygiene items · 1 Rev 1 finding reclassified to an open product question.**
>
> ---
>
> ## Resolution log — 2026-08-17
>
> Nine decisions were taken by the TL and applied to the doc set. Three new ADRs carry them; the amendment process was followed (ADR first, then the owning docs), and no ADR history was rewritten.
>
> | New ADR | Carries | Closes |
> |---|---|---|
> | **ADR-027** — Invariant 1 scope: no ERP on the data path | Decision 1 | A5 |
> | **ADR-028** — Result-cache contract: permission class in the key; three-tier serving order (amends ADR-012) | Decisions 2, 7 | C14, A9 |
> | **ADR-029** — Launch transport (POST), webhook auth (HMAC + replay window), CSRF (double-submit) | Decisions 3, 4, 5 | C3, C4, C5 |
>
> Also applied without needing an ADR: **A1** (agent data path — confirms existing ADR-006), **A11** (chart-spec into Phase 1 — roadmap sequencing), **E1/E2** (doc root standardized on `docs/`; CLAUDE.md's map completed), **E3** partially (Rollup Store technology now *tracked* in CODING_GUIDELINES §23, still undecided).
>
> **Two new findings** were opened by this pass: **C18** (the per-school ERP database schema was never an owed input — now docs/11 §2 item 6, and the root cause of C8) and **C19** (per-school DLT/WABA provisioning at 1,500-school scale is uncosted — now docs/11 §2 item 8).
>
> **Files changed:** CLAUDE.md · PROJECT_CONTEXT.md *(renamed from `.MD`)* · docs/DECISIONS.md · docs/CODING_GUIDELINES.md · docs/01 · docs/02 · docs/03 · docs/04 · docs/07 · docs/08 · docs/09 · docs/11 · this file.
>
> **Deliberately left open** (deciding them now would pre-empt architecture): A2, A3, A4, A6, A7, A8, A10, B2–B6, C1, C2, C6–C13, C15, C16, C17, C18, C19, E3's technology choice. Running tally after this pass: **6 contradictions/tensions open · 4 unconfirmed assumptions · 14 missing items · 1 hygiene item partially open.**

---

## Section A — Contradictions

**A1 — Agent runtime's data path: "MCP-style layer" vs "MCP tools only"**
- **Status:** `RESOLVED` 2026-08-17 — decided (agents call MCP tools directly for all school-data reads; IMAP/webhook ingestion explicitly outside the rule). docs/07 §3 retires "MCP-style"; docs/07 §3 design rule 1 and docs/04 §7 updated (the latter promoted from assumption to rule). No ADR needed — confirms existing ADR-006. · **Severity:** High (would violate ADR-006 if built wrong)
- **Document:** docs/07 §3 vs docs/04 §7-A3 and CODING_GUIDELINES §5.
- **Issue:** docs/07 says trigger evaluation runs "SQL on READ REPLICA via the MCP-style read-only layer"; docs/04 assumes agents use "this same tool surface … no second data path"; CODING_GUIDELINES mandates agent-runtime reaches school data "only through MCP tools". "MCP-style" leaves room for a parallel read-only layer, which would violate ADR-006 if built.
- **Classification:** CONTRADICTION.
- **Evidence:** the phrase "MCP-style" originates in the standalone workflow-agent plan written before ADR-006 was formalized; docs/04 and the guidelines reflect the later, stricter position. *(Rev 2: confirmed the three wordings still diverge on disk. Note docs/07 §3 also shows the Trigger Evaluator owning IMAP polling and the webhook receiver — those are legitimately outside the MCP tool surface, so the amended wording must scope "MCP tools only" to school-data reads specifically.)*
- **Recommended action:** decide (expected answer: agents call the MCP server tools directly for all school-data reads); amend docs/07 wording; if a separate layer is genuinely intended, that is a new ADR.

**A2 — Chart-spec widget vocabulary vs promised heatmaps** — **RECLASSIFIED**
- **Status:** `REVISED` → now an OPEN QUESTION, not a contradiction · **Severity:** Low
- **Rev 1 claim (preserved verbatim):** *"the chart-spec vocabulary enumerates kpi · bar · line · donut · table (+ narrative), but the predefined catalog promises a 'class-wise heatmap' for Attendance Analytics (also shown in the deck). A promised widget type does not exist in the rendering contract."*
- **Rev 2 finding:** the premise is not supported by the current doc set. The string *heatmap* appears **nowhere in docs/06**. Its only occurrence in all 16 files is docs/05 §7, which lists heatmap as a *future additive* widget type — which is exactly what ADR-015 prescribes. There is no contradiction between the catalog and the contract as written; the claim most likely derives from the deck or prototype (declared non-binding references by docs/11 §5), or from the design conversation Rev 2 cannot see.
- **What survives:** the underlying **product** question. docs/06 §2 describes Attendance Analytics without specifying its widgets, so "is a heatmap required in v1?" is genuinely unanswered — it is simply a scoping question, not a documentation defect. If the answer is yes, ADR-015 needs an additive amendment before Phase 1 builds that dashboard.
- **Recommended action:** answer the v1 scoping question. Do **not** record a doc contradiction. Note the wider lesson: the deck and prototype are declared non-binding, so findings sourced from them should be labelled as such (see A4).

**A3 — Role enumeration and the missing ADMIN carrier** — **CORRECTED AND NARROWED**
- **Status:** `REVISED` · **Severity:** Medium
- **Rev 1 claim (preserved verbatim):** *"The launch-token contract's role set does not clearly define how admin-ness is carried (a role value? a perm?). Documents assume 'admin' exists without a claim-level definition."* Evidence given: *"token example lists operational roles; admin behavior appears only as UI copy."*
- **Rev 2 correction:** docs/02 §3 **does** define the carrier — the role enum comment reads `DIRECTOR | PRINCIPAL | TEACHER | ACCOUNTANT | ADMIN`. `ADMIN` is a defined role value. Rev 1's statement that no claim-level definition exists is inaccurate.
- **The real gap (narrower, still open) — three parts:**
  1. **`role` is a scalar.** A Principal who is also the org's admin cannot hold both values. Every school in the pilot will hit this: the person configuring BYOK and channels is usually also the person using dashboards.
  2. **No admin capability lives in `perms[]`.** docs/02 §8 and docs/08 §10 both name `perms[]` as *the* extension point for new permission domains, and CODING_GUIDELINES §11 requires role-gated behavior to read those claims — yet admin gating has no `perms` value (e.g. `org.admin`), so it must be inferred from `role`, inconsistently with every other capability.
  3. **Org-admin vs school-admin is undistinguished.** docs/00 §2 defines a single "Org/School admin" actor spanning org-level duties (BYOK, which ADR-017 fixes at org level) and school-level duties (messaging channels, which ADR-024 fixes at school level). One `ADMIN` value cannot express which schools an admin may configure.
- **Recommended action:** decide the carrier for admin capability (recommend `perms[]` values for consistency with ADR-002's "never platform-local role tables"), and decide whether org-admin and school-admin are distinct. Then propagate to docs/02/05/07/10. Part of the RBAC matrix (C1).

**A4 — Reference artifacts lag the binding docs**
- **Status:** `OPEN` (no action required) · **Severity:** Low
- **Document:** docs/11 §5 (artifacts) vs deck/prototype content.
- **Issue:** the deck's roadmap slide omits drill-down; the prototype renders messaging channels on a trust-level settings page while ADR-024/assumption A7 say school-level v1.
- **Classification:** CONTRADICTION (low severity — docs are declared binding and artifacts declared references).
- **Evidence:** docs/11 already states artifacts are "design references, not production code."
- **Recommended action:** no doc change required; optionally add one line to docs/11 noting artifacts are point-in-time and may lag. Do not "fix" artifacts to match docs. *(Rev 2: A2 and B1 both appear to have originated in these artifacts, so this note has more value than Rev 1 credited it with.)*

---

**A5 — Invariant 1's literal wording is contradicted by two sanctioned agent features** *(new in Rev 2)*
- **Status:** `RESOLVED` 2026-08-17 by **ADR-027** — Invariant 1 now governs the data/read path, with outbound ERP-notify and inbound ERP webhooks named as sanctioned off-path exceptions excluded from the zero-load measurement. Wording updated in CLAUDE.md, PROJECT_CONTEXT §3/§4, docs/01 §2, docs/09 §2. **Contingency stands:** exception 1 presumes the ERP notification API exists (B5, docs/11 §2 item 7). · **Severity:** High — this is the platform's headline invariant
- **Document:** CLAUDE.md §Invariants #1 and PROJECT_CONTEXT.MD §3/§4 vs ADR-023 and docs/07 §2/§3.
- **Issue:** the invariant is stated absolutely. CLAUDE.md: *"NEVER call ERP services at query time… The ERP's only runtime involvement is signing one launch JWT per session."* PROJECT_CONTEXT §3: *"never called at query time"*; §4 repeats *"The ERP's runtime cost is one ~1 ms JWT signature per session."* But two accepted features require runtime ERP interaction:
  1. **ADR-023 sanctions an outbound ERP call.** Its decision text names "ERP app notifications via ERP APIs" as an agent output, and its Alternatives section makes this explicit: *"the ERP-notify API is the sanctioned channel for anything the ERP should record."* docs/07 §2 lists 🔔 ERP app notification in the action palette.
  2. **docs/07 §2/§3 accept inbound ERP webhooks at runtime** — ⚡ ERP event is a trigger type, with a webhook receiver in the execution architecture. docs/02 §5 and ADR-005 also rely on create/update webhooks.
- **Why this matters beyond wording:** the invariant is quoted verbatim in four places and is the decisive commercial argument to the ERP vendor. A future engineer citing it literally can kill the 🔔 node; one reading it loosely can justify a read-path ERP call. Both failure modes are live.
- **Classification:** CONTRADICTION (invariant text vs Accepted ADR).
- **Recommended action:** amend the invariant to say what it actually protects — no ERP involvement **on the data/read path**, with outbound notifications and inbound webhooks named as the sanctioned exceptions and explicitly excluded from the "zero load" claim's measurement basis. Requires an ADR amendment (PROJECT_CONTEXT §8 lists the no-runtime-ERP-calls rule as ADR-gated). Interacts with B5: the exception may reference an API that does not exist.

**A6 — Drill L3 "rollup-or-capped-replica" is impossible for student-level leaves** *(new in Rev 2)*
- **Status:** `OPEN` · **Severity:** Medium (will produce a wrong implementation)
- **Document:** docs/06 §4.4 vs docs/06 §4.2 and ADR-010/docs/08 §5.
- **Issue:** docs/06 §4.4 says L3 leaves serve from "rollup-or-capped-replica". But the hierarchy catalog in §4.2 puts `student(top-N)` at L3 on four of six sources (Fees, Attendance, Transport, and by extension Exams' mark-band), and ADR-010 forbids PII in the Rollup Store — a rule docs/08 §5 elevates into the platform's data-minimisation argument. Student-level leaves can therefore **only** come from a replica; no rollup path exists or may exist.
- **Classification:** CONTRADICTION.
- **Recommended action:** amend docs/06 §4.4 to state the rule explicitly — non-PII L3 dims (fee_type, section, gender, mark-band) may serve from rollups; student-level leaves are replica-only, top-N capped, role-gated, and audited. No ADR change needed; this sharpens ADR-010/020 rather than altering them.

**A7 — Drill L2 replica fallback breaks the latency budget it claims to honour** *(new in Rev 2)*
- **Status:** `OPEN` · **Severity:** Low-Medium
- **Document:** docs/06 §6 assumption 2 vs docs/09 §3.
- **Issue:** docs/06 assumes rollup dims (class, fee_type) land in the ETL before drill GA, and that "until then **L2 may fall back to replicas within the same latency budget**". docs/09 §3 budgets drill L1/L2 at 100–400 ms *from the Rollup Store*, and prices a replica cache-miss at 0.5–2 s. The fallback is 2–5× outside the budget it invokes.
- **Classification:** CONTRADICTION (a doc's self-justification contradicted by the binding budget table).
- **Recommended action:** either state the degraded budget honestly for the interim period, or make the ETL dim extension a hard precondition of drill GA (docs/11 Phase 4). Prefer the latter — docs/09 §3 targets are declared binding.

**A8 — `report_definitions.school_scope` vs "scope comes only from the token"** *(new in Rev 2)*
- **Status:** `OPEN` · **Severity:** Medium (tenant-isolation adjacent)
- **Document:** docs/06 §1 vs docs/00 glossary, ADR-007, docs/08 §3, CODING_GUIDELINES §8.
- **Issue:** the report-definition schema persists a `school_scope` column per report. Everywhere else, scope is defined as *token-derived and immutable within a session* (docs/00 glossary), *injected server-side and displayed read-only* (CODING_GUIDELINES §8, ADR-019), and *not widenable* (docs/06 §3). What a stored `school_scope` means at execution time is never stated. The case is not hypothetical: ADR-018 supports `trust` visibility, so a Director's 12-school report will be opened by a Principal whose token carries one school.
- **Open sub-questions:** is the stored value intersected with token scope, or is a mismatch an error? Is it a *default selection* for the picker rather than a scope at all? Does a shared report re-run under the *viewer's* scope (correct per ADR-007) while displaying the *author's* scope in its logic panel (confusing, and a possible information leak — the school names of a trust the viewer cannot see)?
- **Classification:** CONTRADICTION (ambiguity in a security-relevant contract).
- **Recommended action:** define the semantics in docs/06 §1 — recommend intersection with token scope at execution, with the logic panel showing the *effective* scope, never the author's. Confirm against ADR-007 before the report-definition schema is built (Phase 3).

**A9 — The cache tier order, declared "law", is stated three different ways** *(new in Rev 2)*
- **Status:** `RESOLVED` 2026-08-17 by **ADR-028** — three result-serving tiers are canonical (Redis → Rollup → Replica); the schema/dimension cache is documented separately as AI-path metadata. Updated in docs/03 §4, docs/09 §4, CODING_GUIDELINES §15. · **Severity:** Medium
- **Document:** docs/03 §4 vs docs/09 §4 and ADR-012 vs CODING_GUIDELINES §15.
- **Issue:** four statements of one contract:
  - docs/03 §4 — ① Redis ② Rollup Store ③ Read replica *(3 tiers)*
  - docs/09 §4 — ① Redis ② Rollup Store ③ **Schema/dimension cache** ④ Replica *(4 tiers)*
  - ADR-012 — *"Tier order is law:"* ① Redis ② Rollup ③ **schema/dimension caches** ④ replica *(4 tiers)*
  - CODING_GUIDELINES §15 — "cache → rollup → replica" *(3 tiers)*
- Beyond the mismatch, placing the schema/dimension cache *in the result-serving order* is a category error: per docs/04 and ADR-014, it serves schema metadata for AI SQL generation and never answers a report query. It cannot sit between the rollup store and the replica in a serving sequence, because it is not on that sequence at all.
- **Classification:** CONTRADICTION (in a clause explicitly designated "law", which engineers are told in CODING_GUIDELINES §15 to reflect "in code structure, not just intent").
- **Recommended action:** make docs/03 §4's three-tier statement canonical for result serving; describe the schema/dimension cache separately as AI-path metadata caching. Amend ADR-012's decision text accordingly (it is the ADR, so it leads).

**A10 — Fan-out cap (25) vs latency budget (10) vs trust size (up to 30)** *(new in Rev 2)*
- **Status:** `OPEN` · **Severity:** Medium
- **Document:** ADR-011 and docs/03 §4.3 and docs/04 §2 vs docs/09 §3 vs PROJECT_CONTEXT.MD §1/§2.
- **Issue:** three numbers that don't reconcile:
  - The cap is **≤25 schools** per fan-out, concurrency ~10 (ADR-011, docs/03 §4.3, docs/04 §2).
  - docs/09 §3's latency table budgets only *"AI query · fan-out **≤10 schools** (row-level) — 5–10 s"*. Fan-outs of 11–25 schools are permitted by contract but have **no budget**, and since latency ≈ slowest school with concurrency ~10, a 25-school fan-out is roughly three sequential waves — likely outside the 10 s AI ceiling and outside the GA gate's p95 AI < 10 s.
  - PROJECT_CONTEXT §1/§2 sizes trusts at **3–30 schools**. The largest trusts exceed the cap outright, so every row-level cross-school question from them falls back to rollups or a "narrow your selection" prompt. That behaviour is specified (docs/03 §4.3) but never surfaced as a *product* limitation, and docs/10 has no UX for it.
- **Classification:** CONTRADICTION (contract permits what the budget doesn't cover; product sizing exceeds both).
- **Recommended action:** decide the real cap, budget it in docs/09 §3, and specify the >cap UX in docs/10 (what a 30-school Director sees when asking a row-level question). If 25 stands, state the expected latency at 25.

**A11 — Phase 1 requires the chart-spec renderer that the roadmap delivers in Phase 3** *(new in Rev 2)*
- **Status:** `RESOLVED` 2026-08-17 — `/packages/chart-spec` (contract + JSON Schema + renderer) and `/packages/shared` are now Phase 1's first deliverables, ahead of the 4 dashboards; Phase 3 keeps only the artifact canvas and streaming. docs/11 §1 updated, with the sequencing rationale recorded. No ADR needed (roadmap sequencing is not ADR-gated). · **Severity:** Medium (sequencing; cheap now, rework later)
- **Document:** docs/11 §1 Phase 1 vs Phase 3, against ADR-015/021 and CODING_GUIDELINES §1/§4.
- **Issue:** Phase 1 ships 4 dashboards **and PDF export**. ADR-021 requires the PDF to render "the same persisted spec" as the screen, and CODING_GUIDELINES §4 mandates *one* chart layer via `/packages/chart-spec` for predefined, custom, AI and drill alike ("a second charting approach for a single feature is drift"). But docs/11 lists "chart-spec renderer" as a **Phase 3** deliverable, bundled with the Ask-AI artifact canvas. Phase 1 as scoped either builds a throwaway second chart path — the exact drift §4 forbids — or silently pulls the package forward.
- **Related:** C9 (no formal chart-spec JSON Schema exists yet) makes this the critical-path item, not a formality.
- **Classification:** CONTRADICTION (roadmap vs binding guideline).
- **Recommended action:** move `/packages/chart-spec` (contract + JSON Schema + renderer) explicitly into Phase 1 as its first deliverable, ahead of the 4 dashboards. Phase 3 then adds only the artifact canvas and streaming.

## Section B — Assumptions presented as decided

> **Rev 2 note:** these findings rest on what was or wasn't confirmed in the design conversation, which Rev 2 could not access. Except where a doc-level check was possible (B1), they are carried forward unmodified and remain owed a human answer.

**B1 — ERP product name "MoveNext ERP"** — **RESOLVED**
- **Status:** `RESOLVED` (fixed in the docs between Rev 1 and Rev 2)
- **Rev 1 issue (preserved):** *"the ERP is named 'MoveNext ERP' as fact. The name came from prototype branding, not from an explicit statement in this project's discussion."*
- **Rev 2 verification:** the string `MoveNext` appears in **none** of the 16 files. CLAUDE.md now reads *"an existing school ERP (hereafter the ERP)"* — Rev 1's recommended genericization was applied. No further doc action.
- **Residual:** the *product* question is still unanswered and now has no home in the docs — the real ERP name is still needed for tenant theming and PDF branding (docs/10 §1.3). Carried into the TL questions as a product input, not a doc defect.

**B2 — BYOK key granularity is org-level**
- **Status:** `OPEN` · Not re-verifiable in this pass · **Severity:** Medium (blocks the key-vault schema)
- **Document:** ADR-017, docs/05 §4.
- **Issue:** the original requirement was "client provides their subscription details". Org-level (one key per trust) was a design refinement introduced with multi-school support and never explicitly confirmed. Independent single schools are orgs-of-one, which works — but school-level keys inside a trust (e.g., per-campus budgets) were never ruled in or out.
- **Classification:** ASSUMPTION (documented as Accepted ADR).
- **Recommended action:** confirm org-level with the TL; if per-school keys are required, ADR-017 needs an amendment before the key-vault schema is built. *(Rev 2: note the schema `tenant_ai_config(org_id, …)` in docs/05 §4.1 keys on `org_id`, and per-school **metering** already exists on top — so per-school budgets are a smaller change than per-school keys. Worth offering as a middle option.)*

**B3 — Numeric parameters presented as fixed**
- **Status:** `OPEN` · **Severity:** Low (technical) / Medium (product-visible subset)
- **Document:** docs/02/03/04/07/09; DECISIONS various.
- **Issue:** 60-s token expiry, 8-h session, 15-min sync, cache TTLs, 5,000-row/10-s caps, 200×3 pool envelope, ≤25-school fan-out, 5-min agent ticks, 2,000 msgs/day, quiet hours 8 PM–7 AM — all designer defaults, none individually confirmed.
- **Classification:** ASSUMPTION (engineering defaults; CODING_GUIDELINES §12 already requires them to be config, which is the correct mitigation).
- **Recommended action:** no doc change for the purely technical ones; explicitly confirm the **product-visible** ones with the TL: quiet hours, daily message cap, tick cadence, session length. *(Rev 2: the ≤25-school fan-out cap is no longer purely technical — see A10 — and should be decided with the product-visible set.)*

**B4 — Mail trigger mechanism is IMAP polling**
- **Status:** `OPEN` · Not re-verifiable in this pass · **Severity:** Medium (Phase 4)
- **Document:** docs/07 §2/§3.
- **Issue:** "watch a mailbox" is a confirmed requirement ("condition to be met in DB or Mail"); *IMAP, polled every ~2 min* is the assumed mechanism. Schools on Google Workspace/Microsoft 365 may require API-based access instead.
- **Classification:** ASSUMPTION.
- **Recommended action:** survey school mail systems; decide IMAP vs provider APIs before Phase 4.

**B5 — An ERP notification API exists for the 🔔 action**
- **Status:** `OPEN` · Not re-verifiable in this pass · **Severity:** High (now compounded — see A5)
- **Document:** docs/07 (action node "ERP app notification"), ADR-023.
- **Issue:** agents' sanctioned way to make the ERP record/show anything is "the ERP-notify API" — whose existence was assumed, never confirmed, and which is absent from the owed-inputs list.
- **Classification:** ASSUMPTION.
- **Recommended action:** add to docs/11 owed inputs; confirm with the ERP team (existence, auth, rate limits). If none exists, the 🔔 node moves to the ERP-patch scope or is cut from v1. *(Rev 2: A5 raises the stakes — ADR-023 names this API as the **sanctioned alternative** to write-back, so if it doesn't exist, ADR-023's rejection of whitelisted write-backs loses its stated escape hatch and the trade-off needs re-examining, not just the node.)*

**B6 — Vendor names used in examples**
- **Status:** `OPEN` (informational; no action) · **Severity:** Low
- **Document:** docs/07, deck, prototype (Gupshup, MSG91, SQS/BullMQ).
- **Issue:** vendors appear illustratively; correctly flagged open in docs/11 and CODING §23, but a reader could take examples as choices.
- **Classification:** CONFIRMED (as open) — recorded to prevent misreading.
- **Recommended action:** none required; keep the "provider choice is an open input" framing.

## Section C — Missing information

**C1 — RBAC matrix** — `OPEN` · MISSING. No single table maps roles → capabilities (who configures BYOK/channels, publishes agents, promotes shared reports, sees student-level drill leaves). Evidence: role behavior scattered across 02/05/06/07/08/10. Action: add an RBAC matrix to docs/08 (or a new docs/12) once A3 is decided.

**C2 — Teacher class-level scoping mechanism** — `OPEN` · MISSING. docs/08 §4.5 promises "teacher → own classes" but the token carries `school_ids` only; no `class_ids` claim, no alternative mechanism. Action: decide carrier (token claim from ERP vs dropping class-scoping v1); update docs/02/08. *(Rev 2: confirmed on disk — no class-level claim exists anywhere in the token contract. Note docs/06 §4.2's drill leaf policies also assume a class-level notion of "own", so this blocks drill role-gating too, not just docs/08.)*

**C3 — Launch-token transport risk** — `RESOLVED` 2026-08-17 by **ADR-029** clause 1: auto-submitting POST form, never a query parameter, plus `Referrer-Policy: no-referrer` on the launch route. docs/02 §2 (flow + rationale), §7 assumption 1, docs/08 §2 updated. Note the ERP-side consequence: their menu item performs a form POST, not a link navigation — must reach them before they build (docs/11 §2 item 3). *Original finding:* MISSING (security). docs/02 §2 shows `…/launch?token=…`; tokens in query strings can land in server/proxy logs and Referer headers. 60-s + single-use narrows but does not eliminate exposure, and no mitigation (POST form, fragment transport, `Referrer-Policy`) is documented. Action: choose a mitigation; amend docs/02/08. *(Rev 2: confirmed. CODING_GUIDELINES §13 makes launch tokens a log-forbidden value, which the query-string design actively undermines — the platform cannot redact what an upstream proxy logs.)*

**C4 — Webhook authentication (ERP → platform)** — `RESOLVED` 2026-08-17 by **ADR-029** clause 2: `X-Signature` HMAC-SHA256 + `X-Timestamp`, constant-time comparison, 5-minute window, replay-rejected, secret in Secrets Manager with rotation overlap. New docs/02 §5.1; docs/08 §2. The design records *why* the failure mode is safe: webhooks stay advisory because the 15-min sync covers every event, so rejection costs freshness, not correctness. *Original finding:* MISSING. Sync and future event webhooks (docs/02 §5, docs/07 §2) specify no auth (e.g., HMAC signature + replay window). Action: specify in docs/02. *(Rev 2: confirmed — the inbound webhook receiver is an unauthenticated internet-facing surface that can write to the Tenant Registry, i.e. the store that decides which replica a school's queries hit. Severity is higher than "missing spec" suggests.)*

**C5 — CSRF posture** — `RESOLVED` 2026-08-17 by **ADR-029** clause 3: `SameSite=Lax` new-tab / `None` iframe, plus a double-submit CSRF token on every state-changing request **independently of cookie policy** — which is what makes iframe mode's mandatory `SameSite=None` not a regression. docs/02 §4, docs/08 §2. *Original finding:* MISSING. Cookie-based 8-h session with state-changing POSTs (drill, save report, publish agent) has no documented CSRF defense. Action: document the standard (SameSite + token) in docs/08. *(Rev 2: confirmed, and note the iframe embedding mode forces `SameSite=None` per docs/02 §4 and docs/08 §2 — which removes the default protection precisely in the deployment mode that needs it most. The two documents make this decision jointly; neither notices it.)*

**C6 — Rollup metric/dimension taxonomy** — `OPEN` · MISSING. `rollup_daily.metric` values exist only as examples; drill L1/L2 and Director dashboards depend on a canonical registry. Action: create the taxonomy as data + a short doc section (docs/03 appendix), owned like the hierarchy catalog (A8 in the assumptions register).

**C7 — `run_multi` merge semantics and error-code taxonomy** — `OPEN` · MISSING. The `merge` parameter's strategies and the platform-wide `{code,…}` error codes (CODING §6) are undefined. Action: specify both during Phase 1 API design; record in docs/04/06.

**C8 — Per-dashboard specification sheets** — `OPEN` · MISSING. The 15 predefined dashboards are named with widget summaries, but their vetted SQL, filters, and layout JSON are documented nowhere. Action: Phase-1 deliverable — one spec sheet per dashboard (source of the "vetted" claim). *(Rev 2: this is also where A2's heatmap question gets answered per-dashboard.)*

**C9 — Formal chart-spec JSON Schema** — `OPEN` · MISSING · **now critical-path**. ADR-015 fixes the philosophy; only example JSON exists. `/packages/chart-spec` needs a field-level schema (also the validation target per CODING §10, which requires model output to be schema-validated before it reaches the renderer or storage). Action: author the schema as the package's first artifact, in **Phase 1** per A11; reference from docs/05.

**C10 — Prototype UI items absent from docs/10** — `OPEN` · MISSING (minor). Export History screen has no spec row; "pin to Home" for saved/custom reports (present in the v1 design) was dropped without decision; the launch handoff interstitial content is unspecified. Action: add to docs/10 or explicitly descope pinning.

**C11 — Retention periods** — `TRACKED` (docs/11 open item #5) · listed for completeness: audit, message_log, export retention durations await the compliance review. *(Rev 2: C14 adds Redis result-cache retention to the same review.)*

**C12 — Multi-environment story** — `OPEN` · MISSING (minor). No statement on ERP-staging ↔ analytics-staging token/JWKS/registry wiring. Action: one paragraph in docs/02 or /ops runbook.

---

**C13 — The `ai_status` gate has no defined enforcement point for non-HTTP AI paths** *(new in Rev 2)*
- **Status:** `OPEN` · **Severity:** High (BYOK gating is Invariant 5)
- **Document:** ADR-017 and CODING_GUIDELINES §11 vs docs/07 §6 and docs/05 §4.4.
- **Issue:** the gate is specified exclusively in HTTP terms — *"every `/api/ai/*` request re-checks `ai_status == 'active'`"*, with CODING_GUIDELINES §11 calling the prefix load-bearing and forbidding "sibling endpoints that 'forget' it". But docs/05 §4.4 lists four gated AI features, and two of them do not run over that surface:
  - **AI-compose** executes inside an `agent-runtime` **queue worker** (docs/07 §2 action palette, §3 action workers) — no HTTP request, no `/api/ai/*` prefix, no documented check.
  - **"Describe your workflow"** flow-drafting is a builder feature whose transport is unspecified.
- **Unanswered consequences:** (a) where does a queue worker read `ai_status`, and at enqueue time or execution time (a run can wait until 2 PM per docs/07 §2, so the key may fail in between)? (b) Do agent AI calls count against the org **monthly query cap** in ADR-017 — and if the cap is hit mid-run, is that a guardrail outcome per CODING_GUIDELINES §10 or a failed node? (c) ADR-017's error path says key failure "auto-relocks with a fix-it banner" — what happens to in-flight and scheduled agent runs holding AI-compose nodes?
- **Classification:** MISSING (enforcement mechanism for an invariant).
- **Recommended action:** specify the gate as a *service-layer* check in the AI provider interface (which docs/05 §7 already posits for Bedrock/Vertex adapters), not an HTTP middleware — so every caller inherits it. Amend ADR-017's decision text and CODING_GUIDELINES §11. Decide cap accounting and in-flight-run behaviour.

**C14 — Redis is the only store where row-level PII leaves a school DB, and no policy covers it** *(new in Rev 2)*
- **Status:** `RESOLVED` 2026-08-17 by **ADR-028** — PII permitted in the cache under an explicit policy (encrypted at rest/in transit, private subnets, log-excluded, TTL-bounded, retention into the compliance review), **and `permission_class` added to the cache key** so callers with different effective visibility can never share an entry. New docs/08 §5.1; docs/03 §4, docs/09 §4, CODING_GUIDELINES §8 (new `[MANDATORY]` rule) and §15. · **Severity:** High (privacy + a cross-role leak shape)
- **Document:** ADR-012 and docs/09 §4 vs docs/08 §5 and docs/04 §3 rail 6, plus CODING_GUIDELINES §8.
- **Issue, two parts:**
  1. **No PII policy on the cache.** docs/08 §5's data-minimisation argument rests entirely on the Rollup Store holding no PII — but the **Redis result cache** holds rendered report *results* for 5–15 minutes, and those include Fee Defaulters rows, `student(top-N)` drill leaves, and fan-out row-level output: names, phone numbers, amounts. Redis is not mentioned once in docs/08. Nothing specifies encryption at rest, network placement, eviction/flush guarantees, or retention (cf. C11).
  2. **The documented cache key cannot express role-dependent masking.** ADR-012 and docs/09 §4 fix the key as `report + level + drill-context + filters + school-set`; CODING_GUIDELINES §8 requires only "the school-set/org" to be embedded. But docs/04 rail 6 applies **PII masking per session role**, and docs/08 §4.5 gates drill leaves on student-data rights. Two users of the *same school* with different `perms[]` therefore collide on the same key — the first caller's masking state is served to the second. A Principal warming the cache would serve unmasked rows to a class teacher on the identical key.
- **Classification:** MISSING (policy) / latent CONTRADICTION (cache-key contract vs masking rules).
- **Recommended action:** decide whether the cache may hold PII (if yes: encryption, retention, and Redis added to docs/08 §5), and **amend the cache-key contract in ADR-012 to include the caller's effective permission/masking class**. This is a change to a clause designated "law" and to a `[MANDATORY]` guideline, so it is ADR work, not implementation detail — and it must land before Phase 1 builds the Dashboard Service.

**C15 — Chart-specs carry their own data: PII through the LLM, and no path for large results** *(new in Rev 2)*
- **Status:** `OPEN` · **Severity:** High (privacy posture + a feasibility gap)
- **Document:** docs/05 §1 vs docs/08 §5, ADR-008 caps, ADR-015.
- **Issue:** the chart-spec example in docs/05 §1 embeds its own payload — `"data": [...]` on the bar widget and `"rows": [...]` on the table. Since ADR-015 makes the spec the *only* thing the AI emits for rendering, the model must receive result rows and re-emit them. Two consequences, neither addressed anywhere:
  1. **Privacy.** Row-level student data would pass through the model — and under BYOK that traffic goes to the *customer's* Anthropic account. docs/08 governs PII movement meticulously everywhere else (rollups, masking, minimisation, audit) and is silent on the single largest data egress in the design. Whether this is acceptable is a **decision**, not an oversight to patch — but it must be stated, especially given Indian school-data compliance is already an open item (docs/11 #5).
  2. **Feasibility.** ADR-008 caps results at 5,000 rows. A 5,000-row table cannot round-trip through model output within any practical limit, so either the AI path has a much lower effective row cap than the documented one, or specs must be *hydrated server-side* from the query result rather than emitted whole by the model. The documents describe no such mechanism, and docs/05 §3's "oversized result → auto-aggregate and retry once" addresses a different problem (result size, not spec size).
- **Classification:** MISSING (both a privacy decision and a core mechanism of the AI path).
- **Recommended action:** decide the data-flow model — recommend the model emits a spec *skeleton* (widgets, encodings, narrative) with the orchestrator attaching data server-side from the MCP result, which resolves both problems and preserves ADR-015. Then state the PII-to-provider posture explicitly in docs/08 §5. Both belong in docs/05 §1 and the chart-spec JSON Schema (C9), i.e. before Phase 3.

**C16 — The rollup ETL has no capacity budget** *(new in Rev 2)*
- **Status:** `OPEN` · **Severity:** Medium (Phase 2 risk; GA-gate blind spot)
- **Document:** docs/03 §4.2 and ADR-010 vs docs/09 (all sections).
- **Issue:** incremental ETL reads **1,500 databases every 15–30 minutes** for attendance/fees (nightly for slow metrics) — the platform's largest sustained data-plane workload, and the only one that is continuous rather than user-driven. docs/09 gives it no throughput estimate, no concurrency cap, no batch-window budget, and no analysis of contention with interactive queries, which hit the *same ~30 replica instances*. Every other data path in docs/09 is explicitly capped (10 s queries, 5,000 rows, ~10 fan-out concurrency, 200×3 pools); the ETL is capped by nothing.
- **GA-gate consequence:** docs/09 §8 and docs/11 §1 measure **ERP primary CPU delta = 0** — correct and necessary, but the gate has no criterion for *replica* headroom under simultaneous ETL and peak interactive load. The load test as specified could pass while the replica fleet is saturated.
- **Classification:** MISSING.
- **Recommended action:** size the ETL in docs/09 (rows/interval, concurrency cap, batch window, off-peak skew), and add a replica-saturation criterion to the GA gate alongside the primary-delta measurement.

**C17 — "Re-run" semantics for saved AI reports are undefined (billing + gating consequence)** *(new in Rev 2)*
- **Status:** `OPEN` · **Severity:** Medium
- **Document:** docs/10 §2 (My Reports: "AI snapshots (AI badge, Re-run/PDF)") vs ADR-018, ADR-016, ADR-017.
- **Issue:** ADR-018 saves AI artifacts into `report_definitions` with their spec **and** `sql_text`, and docs/11's Phase 3 exit criterion is "clones re-run with fresh data". It is never stated whether Re-run (a) re-executes the persisted `sql_text` through the deterministic path — free, no tokens, and crucially **still working when `ai_status` is not active** — or (b) re-invokes the model — billable, and locked the moment the org's key fails.
- **Why it matters:** the answer determines whether a school that loses its Anthropic key also loses every report it built with AI. ADR-016's promise that "the product is fully functional with AI locked" and ADR-017's "dashboards unaffected" both imply (a), but neither says so, and docs/10's separate "AI snapshot" badge and Re-run affordance imply the opposite. This is a customer-visible BYOK-value question sitting in a documentation gap.
- **Classification:** MISSING.
- **Recommended action:** state the semantics in docs/06 §1 and docs/10 §2 — recommend (a), with re-invoking the model exposed as the distinct, gated "✎ Refine" action that docs/10 already lists. Confirm against ADR-016/017.

**C18 — The per-school ERP database schema was not an owed input** *(new 2026-08-17)*
- **Status:** `OPEN` — added to docs/11 §2 as item 6; awaiting the ERP team · **Severity:** Highest of the owed inputs
- **Document:** docs/11 §2 (absent) vs docs/04 §2, docs/06 §2, docs/03 §4.2, ADR-014/026.
- **Issue:** all five originally-owed inputs concern the ERP's *master config* and infrastructure. Nobody asked for the DDL of the **school databases the product actually queries** — students, attendance, fees, exams, staff, transport, library — per live `schema_version`. Without it: the 4 core dashboards' vetted SQL cannot be written (Phase 1's principal deliverable); `get_schema` has no fixtures to cache per version, which is exactly what ADR-014's per-version caching and ADR-026's prompt-caching lever depend on; `get_dimensions` has no tables to read; and the rollup ETL has no source mapping (Phase 2).
- **It is also the root cause of C8.** The 15 dashboards' "vetted SQL" could never have been documented, because the schema it would query was never in hand.
- **Why it is the sharpest item on the list:** it is the only owed input that **cannot usefully be stubbed** — an invented schema makes all four dashboards' SQL throwaway — while being the cheapest to supply (`mysqldump --no-data` against one school DB per live version).
- **Classification:** MISSING (owed input).
- **Recommended action:** request today. Until it lands, Phase 1 work proceeds on everything schema-independent (packages, MCP rails, orchestrator core, invariant tests, IaC, SPA shell, stub ERP) — recorded as a note under docs/11 §1.

**C19 — Per-school channel provisioning at 1,500-school scale is uncosted** *(new 2026-08-17)*
- **Status:** `OPEN` · **Severity:** Medium-High (Phase 4 schedule, and possibly an A7 dependency)
- **Document:** ADR-024 and docs/07 §4 vs docs/11 §2 item 4 and assumption A7.
- **Issue:** ADR-024 makes messaging channels **school-owned**, which is legally correct — sender reputation, DLT attribution and WABA quality ratings belong to the school. The unexamined consequence is that channel onboarding is *per school*: each of 1,500 schools needs its own DLT entity and header registration, its own WABA setup and business verification, and its own template approvals — each with rejection-and-retry loops and initially-throttled messaging tiers. That is calendar time no engineering effort compresses, and it is an **operations programme, not a platform feature**. docs/11 treats only provider *choice* as the open input; the provisioning burden is costed nowhere.
- **Two consequences:**
  1. **A new owed input** (now docs/11 §2 item 8): does the ERP already send SMS/WhatsApp today? School ERPs usually do. An existing provider relationship, DLT entity registration or approved template library would turn this from a programme into a configuration exercise. Highest-value unknown in the messaging area.
  2. **Assumption A7 may be a prerequisite, not an evolution.** Trust-level provider accounts with per-school overrides may be the only mechanism that makes this tractable at scale — in which case it gates agent GA rather than being a "later schema decision".
- **Classification:** MISSING (operational scope).
- **Recommended action:** answer the ERP-already-sends question first; then decide whether A7 moves ahead of Phase 4. Recorded in docs/07 §4 and against A7 in docs/11 §3.

**C20 — Attendance and exam data absent from the first real ERP dataset** *(new 2026-08-19)*
- **Status:** `OPEN` — question added to docs/11 §2 item 6; Phase 1 dashboards revised around it · **Severity:** Medium (product scope, not architecture)
- **Document:** docs/06 §2 and docs/11 §1 vs the `ai_analysis` extract.
- **Issue:** first contact with real ERP data (St Marks society — 3 schools, 259K student rows, 1.5M fee receipts, 2020-04 → 2026-08) shows **no attendance and no exam tables**. Both are load-bearing in the product narrative well beyond a dashboard: PROJECT_CONTEXT §1's Ask-AI example is *"which students have <75% attendance and pending fees?"*; the Director set includes Cross-School Attendance (students **and** teachers); docs/07's canonical workflow agent is the absence-alert; and docs/06 §4.2's hierarchy catalog defines attendance and exam drill paths. If this data is not reachable, more than two dashboards are affected.
- **What is not yet known:** whether attendance/exam data exists in the **per-school** databases (`stmarksmb`, `stmarksj`, `stmarksg`) and was simply not carried into this extract, or whether it is not captured by the ERP at all. Those are very different answers — the first is an extract gap, the second is a product-scope problem.
- **Interim decision (recorded, not a workaround):** Phase 1's four dashboards become Enrollment Overview · Fee Collection · Fee Defaulters · Staff Overview; Attendance Analytics and Exam Performance move to Phase 3. Architecture, catalog, serving path and invariants are untouched — only the build order moved.
- **Classification:** MISSING (data availability).
- **Recommended action:** confirm with the ERP team whether attendance and exam tables exist in the per-school databases. If they do, this is an extract gap and Phase 3 proceeds as planned. If they do not, the absence-alert agent, the Cross-School Attendance dashboard, the attendance drill paths and the flagship Ask-AI example all need re-scoping — and that is an ADR-level conversation, not a roadmap tweak.

## Section D — Checks that passed

- **ERP integration, SSO, tenant resolution, MCP contracts, predefined flow, AI flow, cross-school querying, security boundaries, performance requirements, PDF workflow:** present, mutually consistent, and correctly cross-referenced (docs/02–09; ADR-001…026). *(Rev 2 amendment: this still holds for the **read/query** path. Rev 2's A5 narrows the claim — no invariant is contradicted in **intent** anywhere in the set, but Invariant 1's literal text is contradicted by ADR-023's ERP-notify action and docs/07's ERP webhooks.)*
- **Roadmap vs architecture:** phases sequence dependencies correctly (gating before chat; rollups before Director views; agents/drill after stabilized surfaces). No roadmap item contradicts an ADR. *(Rev 2 amendment: one sequencing defect found — A11, chart-spec renderer scheduled in Phase 3 but required by Phase 1's PDF and one-chart-layer rule.)*
- **Assumption hygiene:** A1–A9 in docs/11 §3 are consistently labeled with "if false" consequences and cross-referenced from their home docs — with the exceptions promoted to Section B. *(Rev 2: re-verified. The register itself is the strongest part of the doc set. One gap: the Rollup Store technology choice is not in it — see E3.)*
- **ADR internal consistency (Rev 2, new check):** all 26 ADRs carry the full required format (Context · Decision · Reasoning · Alternatives · Trade-offs · Future impact · Status); the index matches the entries; no ADR is orphaned, duplicated, or silently superseded; the amendment process is stated. ADR-009's `Accepted (pending A1)` is the only conditional status and is correctly cross-referenced.
- **Terminology discipline (Rev 2, new check):** *org* / *school* / *tenant* / *scope* / *run* / *node* / *channel* are used consistently with the docs/00 §4 glossary across all 16 files. No forbidden synonyms (`client_id`, `branch`, `workspace`) appear. CODING_GUIDELINES §2's naming rules match the schemas actually documented in docs/03/06/07.

## Section E — Repository & document-set hygiene *(new in Rev 2)*

> Not architecture, but these are the navigation instructions every new engineer and every Claude Code session follows first. All four are cheap to fix and none requires an architectural decision.

**E1 — The documented folder layout does not match the repository** — `RESOLVED` 2026-08-17 · HYGIENE
- **Decision:** `docs/` is the doc root (matching reality, not the documented intent). CODING_GUIDELINES §1's tree corrected and expanded to show `docs/DECISIONS.md` and `docs/CODING_GUIDELINES.md` in place; `project-docs/` references replaced in PROJECT_CONTEXT §9.1 and docs/11 §5; `PROJECT_CONTEXT.MD` renamed to `.md` via a two-step `git mv` (Windows is case-insensitive, so a direct rename would not be recorded).
- *Original finding below.*
- CODING_GUIDELINES §1 shows `/CLAUDE.md  /PROJECT_CONTEXT.md  /DECISIONS.md  /CODING_GUIDELINES.md` at the repo root. In fact **`DECISIONS.md` and `CODING_GUIDELINES.md` live in `docs/`**, alongside 00–11.
- PROJECT_CONTEXT.MD §9.1 and docs/11 §5 both refer to a **`project-docs/`** directory that does not exist ("`project-docs/` is the single source of truth"; "this `project-docs/` set is the binding engineering documentation").
- `PROJECT_CONTEXT.MD` has an **uppercase extension** on disk but is referenced as `PROJECT_CONTEXT.md` in CLAUDE.md, DECISIONS.md, CODING_GUIDELINES.md and its own header. This resolves on Windows and **breaks on Linux/CI**.
- **Action:** one documentation PR correcting all three; decide whether the doc root is `docs/` (current reality) or `project-docs/` (documented intent), and rename the file to `.md`.

**E2 — CLAUDE.md's document map omits the two most authoritative documents** — `RESOLVED` 2026-08-17 · HYGIENE
- **Fixed:** the map now carries `docs/DECISIONS.md` ("the binding ADRs — read before proposing anything"), `docs/CODING_GUIDELINES.md`, and `AUDIT_REPORT.md`.
- *Original finding below.*
- CLAUDE.md's "read in this order for full context" table lists **only docs/00–11**. `DECISIONS.md` (the 26 binding ADRs) and `CODING_GUIDELINES.md` (the `[MANDATORY]` rules) are absent, as is this audit. A session following CLAUDE.md literally reads neither the decisions it must not contradict nor the rules it must follow — the two documents that exist specifically to prevent drift.
- CLAUDE.md §Ground rules does say "these docs are the single source of truth" but never names them.
- **Action:** add both to the map (and a pointer to this file with its status), in the reading order PROJECT_CONTEXT.MD §Companion documents already implies.

**E3 — The Rollup Store technology is undecided but listed among fixed choices** — `PARTIALLY RESOLVED` 2026-08-17 · HYGIENE (borderline architectural)
- **Tracked, not decided:** added to CODING_GUIDELINES §23's undecided register, and PROJECT_CONTEXT §7 now marks the choice open with "resolve by ADR before Phase 2". The technology decision itself remains open and is TL question 10. (§23 also gained the validation-library / JSON-Schema choice, which §19 makes ADR-gated because it touches a contract seam.)
- *Original finding below.*
- PROJECT_CONTEXT.MD §7 ("What technologies are fixed?") lists the Rollup Store as "**Aurora MySQL or ClickHouse**" — an unresolved choice inside the fixed-technology table. ADR-010 likewise says only "a small platform DB".
- CODING_GUIDELINES §23, the canonical register of undecided items, does **not** list it — while listing smaller open choices (linter, test framework, ORM, state management, queue).
- The two options differ materially for the ETL design, `dims_json` query patterns, and ops load — and Phase 2 builds on it.
- **Action:** add to §23 now, and resolve by ADR before Phase 2. Note this is the only entry in a "fixed" table that isn't.

**E4 — This audit had no status tracking, and had already gone stale** — `OPEN` (addressed by this revision) · HYGIENE
- Rev 1 was referenced from no other document, had no per-finding status, and no owner. B1 had been **fixed in the docs without any record of the decision** — discoverable only by re-reading the files, which is precisely the drift the ADR process exists to prevent.
- **Action:** the `Status` field introduced in this revision is the minimum. Recommend: link this file from CLAUDE.md (E2), and route every finding's resolution through the DECISIONS.md amendment process so the decision is recorded where it binds — marking the finding `RESOLVED` here as a pointer, never as the record itself.

---

## Questions for the Technical Lead

> Reordered in Rev 2 by **the phase they block**, since docs/11's Phase 1 begins in weeks 1–4. Items 1–9 change contracts that Phase 1 either builds or hard-codes; deciding them later means rework in the security-critical layer. Rev 1 question numbers are noted where they map.

### ~~Blocking Phase 1~~ — ✅ ALL NINE DECIDED 2026-08-17

> Answered by the TL and applied via ADR-027/028/029 plus doc updates — see the Resolution log at the top. Retained below as the record of what was asked and why.

1. **Invariant 1 wording.** Does "zero ERP load" mean *no ERP involvement on the data/read path* (permitting the 🔔 ERP-notify action and inbound event webhooks), or literally *nothing but JWT signing*? The invariant is quoted verbatim in four places and is the commercial argument to the ERP vendor. *(A5 — new)*
2. **Redis PII and the cache-key contract.** May the result cache hold row-level PII? And must the cache key include the caller's effective permission/masking class to prevent one role serving another's unmasked rows? This amends ADR-012, which designates the key contract "law". *(C14 — new)*
3. **Launch-token transport.** Accept query-param launch with mitigations (`Referrer-Policy`, log scrubbing), or switch to POST/fragment? The ERP team builds this endpoint once. *(C3 — Rev 1 Q7)*
4. **Webhook authentication.** Approve an HMAC-signature + replay-window scheme for ERP→platform webhooks — the receiver writes to the Tenant Registry, which decides which replica a school's queries hit. *(C4 — Rev 1 Q8)*
5. **CSRF posture**, decided jointly with the iframe embedding mode, since that mode forces `SameSite=None` and removes the default protection. *(C5 — new emphasis)*
6. **Chart-spec into Phase 1.** Approve moving `/packages/chart-spec` — contract, formal JSON Schema, renderer — to Phase 1's first deliverable, ahead of the 4 dashboards. *(A11, C9 — new)*
7. **Cache tier canon.** Confirm the three-tier result-serving order (Redis → Rollup → Replica) and remove the schema/dimension cache from that sequence, describing it separately as AI-path metadata caching. Amends ADR-012. *(A9 — new)*
8. **Agent data path.** Confirm agents call MCP server tools directly for all school-data reads — no parallel read-only layer — with IMAP/webhook ingestion explicitly outside that rule. *(A1 — Rev 1 Q3)*
9. **Doc-set hygiene.** Approve the mechanical corrections: folder layout, `project-docs/` vs `docs/`, `PROJECT_CONTEXT.MD` → `.md`, and adding DECISIONS.md + CODING_GUIDELINES.md to CLAUDE.md's map. *(E1, E2 — new)*

### Blocking Phase 2

10. **Rollup Store technology** — Aurora MySQL or ClickHouse? Currently listed as "fixed" while unresolved, and absent from the undecided register. *(E3 — new)*
11. **Rollup ETL capacity budget**, plus whether the GA gate needs a replica-saturation criterion alongside ERP-primary-delta = 0. *(C16 — new)*
12. **Rollup metric/dimension taxonomy** — needed before the ETL; constrains drill L1/L2. *(C6 — Rev 1)*
13. **Fan-out cap.** Confirm ≤25 schools, budget it in docs/09 (only ≤10 is budgeted today), and specify what a 30-school Director sees when a row-level question exceeds it. *(A10 — new)*

### Blocking Phase 3

14. **PII through the LLM.** Are row-level student rows permitted in model context and in model-emitted chart-specs — under BYOK, on the customer's own Anthropic account? If not, approve server-side spec hydration (model emits the skeleton, orchestrator attaches data). This also resolves how a 5,000-row result becomes a table widget. *(C15 — new)*
15. **RBAC matrix**, including how admin capability is carried given `role` is a scalar — a Principal who is also the org admin cannot hold both today — and whether org-admin and school-admin are distinct. Recommend `perms[]` values for consistency with ADR-002. *(A3 revised, C1 — Rev 1 Q5)*
16. **Teacher class-scoping.** Will the ERP token carry `class_ids`, or is class-level scoping dropped from v1? Blocks docs/08 §4.5 *and* drill leaf role-gating. *(C2 — Rev 1 Q6)*
17. **BYOK granularity.** Org-level confirmed, or per-school keys inside a trust? Middle option available: keep one org key, add per-school **budgets** on the metering that already exists. *(B2 — Rev 1 Q2)*
18. **`report_definitions.school_scope` semantics** — intersect with token scope at execution, or reject on mismatch? And does a trust-shared report's logic panel show the author's scope or the viewer's effective scope? *(A8 — new)*
19. **Saved AI report "Re-run"** — re-executes persisted SQL (free, survives key loss) or re-invokes the model (billable, locks with the key)? Determines whether losing an Anthropic key costs a school every report it built with AI. *(C17 — new)*

### Blocking Phase 4

20. **`ai_status` enforcement for the agent runtime** — where a queue worker checks the gate, whether agent AI calls count against the org monthly cap, and what happens to scheduled/in-flight runs when a key fails. Recommend moving the gate into the AI provider interface rather than HTTP middleware. *(C13 — new)*
21. **ERP notification API** — does it exist? If not, ADR-023's rejection of write-backs loses its stated sanctioned alternative, so the trade-off needs re-examining, not just the 🔔 node. Add to docs/11 owed inputs either way. *(B5 — Rev 1 Q10)*
22. **Drill L3 serving** — confirm student-level leaves are replica-only (rollups cannot hold PII per ADR-010), and whether the ETL dim extension is a hard precondition of drill GA. *(A6, A7 — new)*
23. **Mail triggers** — is IMAP sufficient, or are Google/Microsoft APIs required? *(B4 — Rev 1 Q9)*
24. **Product-visible defaults** — quiet hours (8 PM–7 AM), per-school daily message cap (2,000), agent tick cadence (5 min), 8-hour session with launch-time role snapshot. *(B3 — Rev 1 Q11)*
25. **Attendance Analytics widgets** — is a heatmap required in v1? If yes, approve an additive ADR-015 amendment. Reclassified from a doc contradiction to a scoping question. *(A2 revised — Rev 1 Q4)*

### Standing product & external inputs

> **Sent-today set (2026-08-17):** docs/11 §2 items 2, 3, 6 to the ERP tech lead and infra — the RDS instance distribution (one command, and the answer can reshape the schedule if A1 is wrong), the ERP-side auth build including the ADR-029 POST handoff, and **item 6, the per-school database schema (C18)** — the only owed input that cannot be stubbed and the one that gates the four Phase-1 dashboards.

26. **ERP product name** — still needed for tenant theming and PDF branding (docs/10 §1.3); the placeholder was genericized out of the docs, so it is no longer tracked anywhere. *(B1 — Rev 1 Q1)*
27. **Owed inputs (docs/11 §2)** — school-info table structure · RDS instance distribution of the 1,500 DBs · ERP JWKS endpoint + menu item + token-signing endpoint · WhatsApp BSP and SMS/DLT provider choices · ERP event webhooks — **plus** the ERP notification API added by Rev 1. *(Rev 1 Q12)*

*Process note: answers land as ADR amendments/additions in `DECISIONS.md` and updates to the owning docs — per the amendment process — before the affected component is built. Mark the corresponding finding `RESOLVED` here with a pointer to the ADR; this file is an index of open questions, never the record of a decision (E4).*
