# DECISIONS.md — Architecture Decision Record

> **Purpose:** the permanent record of why this system is shaped the way it is, to prevent architectural drift.
> **Rule:** code that contradicts an Accepted ADR is wrong until the ADR is amended (new ADR superseding the old — never edit history).
> **Format:** every entry carries ID · Title · Context · Decision · Reasoning · Alternatives Considered · Trade-offs · Future Impact · Status.
> Terminology per `docs/00-overview.md`.

## Index

| ID | Title | Status |
|---|---|---|
| ADR-001 | Analytics is a separate platform, embedded via the ERP menu | Accepted |
| ADR-002 | The ERP owns authentication and authorization | Accepted |
| ADR-003 | Launch Token architecture (RS256, 60 s, one-time nonce) | Accepted |
| ADR-004 | Independent 8-hour analytics session after token verification | Accepted |
| ADR-005 | Configuration inheritance via background registry sync, never runtime ERP calls | Accepted |
| ADR-006 | MCP server is the only data-access layer | Accepted |
| ADR-007 | Scope enforced twice: orchestrator + MCP, out-of-band | Accepted |
| ADR-008 | Read-only data plane: `analytics_ro` users + SELECT-only AST validation | Accepted |
| ADR-009 | Read-replica strategy — ERP primaries are unaddressable | Accepted (pending A1) |
| ADR-010 | Rollup Store for cross-school aggregates (no PII) | Accepted |
| ADR-011 | Fan-out querying (`run_multi`) for cross-school row-level detail | Accepted |
| ADR-012 | Redis result caching as tier 1 of a strict cache order | Accepted (amended by ADR-028) |
| ADR-013 | Multi-tenant model: Tenant Registry + Secrets Manager + lazy LRU pools | Accepted |
| ADR-014 | Schema versioning: cache per `schema_version`, not per school | Accepted |
| ADR-015 | Chart-Spec JSON — spec-driven rendering; the AI never emits code | Accepted |
| ADR-016 | Dashboards and AI are separate serving paths | Accepted |
| ADR-017 | BYOK at org level with server-side `ai_status` gating | Accepted |
| ADR-018 | Unified report-definition model; clone-to-edit with immutable masters | Accepted |
| ADR-019 | Logic transparency: definition + SQL visible on every report | Accepted |
| ADR-020 | Drill-down: max 3 levels, bound parameters, curated hierarchy catalog | Accepted |
| ADR-021 | PDF rendering server-side from the same persisted spec | Accepted |
| ADR-022 | Workflow agents: JSON graph + runs as persisted state machines | Accepted |
| ADR-023 | Agents are read-only; messages are the only side effects | Accepted |
| ADR-024 | Messaging channels are school-owned; approved-template-only sending | Accepted |
| ADR-025 | Idempotency and guardrails are platform-level, not per-agent options | Accepted |
| ADR-026 | Model strategy: Haiku-first with Sonnet escalation + prompt caching | Accepted |
| ADR-027 | Invariant 1 scope: no ERP on the data path | Accepted |
| ADR-028 | Result-cache contract: permission class in the key; three-tier serving order | Accepted (amends ADR-012) |
| ADR-029 | Launch transport, webhook authentication, CSRF posture | Accepted |
| ADR-030 | Ask-AI chart-specs are hydrated server-side; the model never receives or emits row data | Accepted |
| ADR-031 | BYOK is multi-provider: Anthropic or Google Gemini, admin's choice | Accepted (amends ADR-017) |
| ADR-032 | `report_definitions.school_scope` is intersected with the viewer's token scope at execution | Accepted |
| ADR-033 | Saved AI reports re-run the persisted statement, never the model | Accepted |
| ADR-034 | Channel ownership: trust-level default, per-school override | Accepted (amends ADR-024) |
| ADR-035 | Email sends through a configured SMTP transport; the transport is deployment config | Accepted (extends ADR-024/034) |
| ADR-036 | A message action node carries its own recipient when the record cannot supply one | Accepted |
| ADR-037 | Scheduled report delivery is server-owned; a schedule is persisted scope, re-validated at send time | Accepted |

---

## ADR-001 — Analytics is a separate platform, embedded via the ERP menu

**Context.** The ERP runs daily operations for 1,500+ schools. The analytics/automation module needed a home: inside the ERP codebase, or as its own system.
**Decision.** Build analytics as an independently deployed platform (own SPA, orchestrator, MCP server, data plane, agent runtime), launched from an ERP menu item.
**Reasoning.** Load isolation (an analytics surge or bug cannot consume ERP resources), release independence (analytics iterates weekly; the ERP is conservative), and technology freedom (Claude API, MCP, Puppeteer, queues) without touching the ERP stack.
**Alternatives considered.** (a) ERP module in the same codebase — rejected: couples load, releases and failure domains; (b) fully standalone product with its own login — rejected: schools will not maintain a second identity, and duplicate school↔DB config would drift.
**Trade-offs.** Two systems to operate; an SSO handoff to build; config must be synced (ADR-005).
**Future impact.** Any new heavy feature (agents, drill, exports) defaults into the platform, never into the ERP.
**Status.** Accepted.

## ADR-002 — The ERP owns authentication and authorization

**Context.** Users already log into the ERP; it knows roles and which schools each user may see (including trust hierarchies).
**Decision.** The platform performs no credential handling. Identity, role, org and school scope arrive only via the ERP-signed launch token.
**Reasoning.** One identity source prevents permission drift; schools get "no second login"; the platform's attack surface excludes passwords entirely.
**Alternatives considered.** Platform-native accounts mirrored from the ERP — rejected: synchronizing users/roles is a standing consistency bug; separate login was an explicit product non-goal.
**Trade-offs.** The platform trusts token claims; role changes apply at next launch (see ADR-004 trade-off).
**Future impact.** New permission domains are new `perms[]` claim values honored by the platform — never platform-local role tables.
**Status.** Accepted.

## ADR-003 — Launch Token architecture

**Context.** The menu click must transfer identity to a different origin securely.
**Decision.** ERP signs a JWT: RS256, 60-second expiry, one-time nonce (`jti`), verified against the ERP's published JWKS; claims: `sub, name, role, org_id, school_ids[], default_school, perms[], iat, exp, jti`.
**Reasoning.** Short-lived + single-use makes interception nearly worthless; asymmetric signing means the platform holds no shared secret; JWKS gives key rotation; carrying scope in the token removes any runtime "what can this user see?" call (ADR-005's principle applied to authz).
**Alternatives considered.** (a) Shared session cookie across domains — rejected: couples session lifecycles and breaks on cookie policy; (b) OAuth authorization-code flow — rejected as over-engineered for a first-party, single-IdP handoff; (c) long-lived token — rejected: replay risk.
**Trade-offs.** The ERP team must build a signing endpoint + JWKS (their entire build for launch); clock skew must be tolerated within the 60 s window.
**Future impact.** A second ERP product can integrate by signing the same token shape.
**Status.** Accepted.

## ADR-004 — Independent 8-hour analytics session

**Context.** The launch token lives 60 seconds; users analyze for hours.
**Decision.** After verification the platform issues its own session (httpOnly Secure cookie / 8 h JWT) and never contacts the ERP again for the session.
**Reasoning.** Availability isolation (ERP outage ≠ analytics logout) and zero per-request ERP traffic (the zero-load rule applied to auth).
**Alternatives considered.** Re-validating against the ERP per request or per N minutes — rejected: reintroduces runtime coupling and latency.
**Trade-offs.** Role/permission changes take effect only at next launch; instant revocation is out of scope v1 (assumption A4; extensibility path: ERP `user_disabled` webhook + session blacklist).
**Future impact.** Any future revocation feature is a webhook consumer, not a per-request check.
**Status.** Accepted.

## ADR-005 — Configuration inheritance via background registry sync

**Context.** The ERP knows every school's DB and the org hierarchy (school-info table). The platform needs that topology.
**Decision.** A background job (15-min pull + create/update webhook push) copies ERP master config into the platform's Tenant Registry; onboarding steps (create `analytics_ro`, write Secrets Manager entry, health-check) run in the sync. The platform never calls ERP config APIs at query time.
**Reasoning.** Availability, latency and load isolation; "a new school in the ERP is analytics-ready in one sync cycle with zero deployments" — the registry *is* the configuration.
**Alternatives considered.** Runtime config API calls — rejected: puts the ERP in the hot path and its outages into ours; manual per-school onboarding — rejected at 1,500-school scale.
**Trade-offs.** Up to 15 min staleness for topology changes (webhook closes the gap); a sync job to operate and monitor.
**Future impact.** Per-tenant capabilities (feature flags, residency class) ride the registry, not deployments.
**Status.** Accepted.

## ADR-006 — MCP server is the only data-access layer

**Context.** Many consumers read school data: predefined dashboards, AI-generated SQL, custom reports, drill levels, agent triggers.
**Decision.** One stateless, read-only, private-network MCP server exposes the only tools that touch school databases (`get_schema, get_dimensions, run_query, run_multi, run_rollup, run_predefined`). No other component holds DB connectivity to school data.
**Reasoning.** (a) It is the model-facing tool surface — the AI's entire world is these contracts; (b) a separate process with hard rules means orchestrator bugs cannot become data leaks; (c) one audit and rate-limit chokepoint; (d) reusable by other MCP clients without new data-access code.
**Alternatives considered.** DB library inside the orchestrator — rejected: collapses the security boundary between business logic and data access; per-feature data services — rejected: N places to re-implement scope, caps and validation.
**Trade-offs.** One extra network hop (private, negligible); the MCP server becomes critical path (mitigated: stateless, horizontally scaled).
**Future impact.** Every new data need is a new tool preserving the same invariants — never a bypass.
**Status.** Accepted.

## ADR-007 — Scope enforced twice, out-of-band

**Context.** Threats include adversarial prompts steering AI SQL, UI bugs, and orchestrator logic errors.
**Decision.** Requested school_ids are checked ⊆ token scope at the orchestrator, and again at the MCP layer against an allowed set passed **out-of-band** with every call. The AI model never supplies tenant identifiers.
**Reasoning.** No single compromised layer can cross tenant boundaries; keeping tenant identity out of model-generated content makes prompt injection structurally unable to address another school.
**Alternatives considered.** Single enforcement point (orchestrator only) — rejected: one bug from a cross-tenant leak; row-level security in MySQL — rejected: 1,500 separate DBs make per-DB policy management the drift risk.
**Trade-offs.** Duplicated checks to keep in sync (cheap; the MCP check is a set-membership test).
**Future impact.** Custom-report SQL, drill contexts and agent triggers all inherit this for free because they flow through the same layer.
**Status.** Accepted.

## ADR-008 — Read-only data plane

**Context.** The platform must be provably incapable of corrupting school data.
**Decision.** All school-data access uses per-school read-only MySQL users (`analytics_ro`, SELECT grants only) **and** SQL AST validation rejecting anything non-SELECT or multi-statement, plus 5,000-row / 10 s caps. Applies equally to AI SQL, hand-edited custom-report SQL, and agent trigger queries.
**Reasoning.** Belt-and-braces: DB-enforced grants survive validator bugs; the validator survives grant misconfiguration. Caps bound the blast radius of any pathological query.
**Alternatives considered.** Trusting vetted SQL only (no AI/hand-edited SQL) — rejected: kills the product's core features; write access for agents — rejected (see ADR-023).
**Trade-offs.** Some legitimate analytics patterns (temp tables) are impossible — accepted deliberately.
**Future impact.** Any future write need (e.g., saving reports) lands in platform-owned storage, never school DBs.
**Status.** Accepted.

## ADR-009 — Read-replica strategy

**Context.** Hard requirement: zero load on the ERP; 1,500 school DBs consolidated many-per-RDS-instance (~30 instances, assumption A1).
**Decision.** All raw SQL runs on read replicas, provisioned per RDS **instance** (not per database). The Tenant Registry stores replica hosts only — primaries are unaddressable from platform code.
**Reasoning.** Replication is storage/binlog-level, so replica load never becomes primary CPU; per-instance replicas make cost ~30 replicas, near-zero marginal on Aurora readers. Making primaries unaddressable turns the zero-load rule from policy into mechanism.
**Alternatives considered.** Querying primaries off-hours — rejected: the product is interactive; per-database replicas — not a thing in MySQL RDS and would be cost-absurd anyway; full ETL of everything into a warehouse — rejected as the sole path: loses row-level freshness for single-school queries (the Rollup Store, ADR-010, covers the aggregate case instead).
**Trade-offs.** Seconds-level replica lag ("as of" labeling accepted, assumption A3); replica fleet to operate.
**Future impact.** If A1 is false (fragmented instances), a consolidation workstream precedes GA — the decision stands, the count changes.
**Status.** Accepted (pending A1 confirmation from infra).

## ADR-010 — Rollup Store

**Context.** Cross-school questions ("school-wise strength across my trust") are physically N queries against N databases; Directors expect ms answers.
**Decision.** A small platform DB of pre-aggregated per-school daily metrics (`rollup_daily(school_id, date, metric, dims_json, value)`), filled by incremental ETL from replicas (15–30 min; nightly for slow metrics), extended with class and fee_type dims for drill L1/L2. **Aggregates only — no student PII.**
**Reasoning.** One indexed query answers for 3 or 300 schools alike (100–500 ms); ETL reads replicas so zero ERP load holds; excluding PII means Director-level cross-school views never move row-level personal data out of school DBs — a privacy decision as much as performance.
**Alternatives considered.** Fan-out for everything — rejected: latency scales with school count and wastes replica capacity on repeated aggregates; a full warehouse (Redshift et al.) — rejected v1: the data is small (schools × daily metrics) and a warehouse adds ops weight without need.
**Trade-offs.** 15–30 min staleness for aggregates (assumption A3); an ETL to own; a second copy of derived data.
**Future impact.** New metrics/dims are ETL data changes, not schema changes; rollup-threshold agent triggers become possible.
**Status.** Accepted.

## ADR-011 — Fan-out querying (`run_multi`)

**Context.** Some cross-school questions need fresh row-level data the rollups don't carry ("list today's absent teachers in all 3 schools").
**Decision.** Execute the same SELECT on each selected school's replica in parallel (concurrency ~10), tag rows with school_id, merge; cap 25 schools per fan-out; annotate partial failures ("Noida temporarily unreachable") instead of failing the report. The AI's tool-choice rule: aggregate → rollup; fresh row-level → fan-out; single school → `run_query`.
**Reasoning.** Latency ≈ slowest single school (~1–2 s) for realistic trust sizes; the cap plus rollup fallback protects the fleet from 300-school row-level scans.
**Alternatives considered.** Sequential querying — rejected: latency scales linearly; centralizing all row-level data — rejected: violates the data-minimisation stance of ADR-010.
**Trade-offs.** Merge semantics live in the platform; cross-school row-level answers are capped by design.
**Future impact.** Drill leaves and agent triggers across multi-school deployments reuse the same engine and caps.
**Status.** Accepted.

## ADR-012 — Redis result caching, strict tier order

**Context.** Predefined dashboards repeat heavily; drill clicks repeat within sessions; the latency budget promises 50–200 ms cache hits.
**Decision.** Tier order is law: ① Redis result cache (key = report + level + drill-context + filters + school-set; TTL 5–15 min) → ② Rollup Store → ③ schema/dimension caches → ④ replica. Nothing skips ahead to a lower tier when a higher one can answer.
**Reasoning.** Repeat views in ms; replica capacity reserved for genuinely new queries; drill-context in the key makes drill navigation feel instant on revisits.
**Alternatives considered.** No result cache (rollups only) — rejected: single-school dashboard repeats would hit replicas needlessly; long TTLs — rejected: staleness beyond the "as of" framing.
**Trade-offs.** Cache invalidation is TTL-based, not event-based (acceptable at these TTLs); Redis becomes operationally required.
**Future impact.** Prefetch features (drill top-3 bars) are cache warmers, not new paths.
**Status.** Accepted — **amended by ADR-028**: the cache key gains the caller's permission class, and the tier list is corrected to three result-serving tiers (the schema/dimension caches are not tiers in that order). Everything else in this ADR stands.

## ADR-013 — Multi-tenant model: registry + secrets + lazy LRU pools

**Context.** One platform, 1,500 tenant databases; cannot hold 1,500 open pools; credentials must not live in config tables.
**Decision.** Per-call tenant resolution: Tenant Registry lookup (cached ~5 min) → Secrets Manager fetch by ARN (cached ~10 min) → lazy pool (`connectionLimit: 3`), LRU-capped ~200 pools/instance, idle-swept at 10 min. RDS Proxy is the recommended hardening (multiplexing, failover, optional IAM auth removing stored passwords).
**Reasoning.** Most schools are idle at any instant; lazy+LRU bounds memory and connections (≤600/instance) while cold-pool cost (~100–300 ms) hides under cache-miss latency. Secrets in a purpose-built store give rotation and IAM-scoped audit.
**Alternatives considered.** Pool-per-school always-open — rejected: resource exhaustion; credentials in the registry — rejected: wrong store for secrets; one shared DB user across schools — rejected: destroys per-school revocation and audit.
**Trade-offs.** First query after idleness pays pool warm-up; two caches whose TTLs bound topology-change propagation.
**Future impact.** IAM-token auth can replace passwords school-by-school inside one resolution function.
**Status.** Accepted.

## ADR-014 — Schema versioning

**Context.** 1,500 databases would naïvely mean 1,500 schema introspections and 1,500 distinct AI prompts.
**Decision.** Schema metadata is cached per `schema_version` (registry column; 3–5 concurrently-live versions, assumption A2). Only `get_dimensions` (classes, fee heads, AYs) is per-school (daily TTL).
**Reasoning.** All schools run the vendor's ERP schema; versioning collapses schema work to ~5 documents and makes Anthropic prompt caching structurally effective — the single biggest AI cost/latency lever (ADR-026).
**Alternatives considered.** Per-tenant introspection — rejected: cost without benefit while A2 holds.
**Trade-offs.** A school on a hotfixed schema must be assigned a version honestly; drift between claimed and actual schema surfaces as query errors (health checks mitigate).
**Future impact.** ERP schema migrations = flipping a registry value per school; caches key on it.
**Status.** Accepted.

## ADR-015 — Chart-Spec JSON: spec-driven rendering

**Context.** The AI must produce visual reports; letting it produce renderable code (HTML/JS/React) is fast to demo and dangerous to ship.
**Decision.** The AI emits only **chart-spec JSON** (title, narrative, widgets: kpi/bar/line/donut/table; later `drillable` flags). The platform's own chart layer renders it; the PDF renderer reads the identical spec.
**Reasoning.** Safety (no AI-authored code executes in clients), brand consistency (one visual language across predefined/custom/AI/PDF), speed (native rendering, progressive streaming), reproducibility (a saved spec re-runs with fresh data), portability (any surface that renders the spec gets every report type).
**Alternatives considered.** AI-generated HTML/React artifacts — rejected: XSS surface, inconsistent output, unprintable, unreproducible; image generation — rejected: not interactive, not data-bound.
**Trade-offs.** New visual ideas require a widget type added to the contract (deliberate gate); the AI is constrained to the vocabulary we define.
**Future impact.** AI artifacts adopting drill-down is a spec-level config (`drillable` + hierarchy catalog), not a rebuild. This ADR is the seam for mobile/email surfaces.
**Status.** Accepted. *Clarified 2026-08-27 (not amended): grouped bars are within this ADR, not an addition to the widget vocabulary it closes. `bar` gained an optional `series[{field,label}]` listing the measures drawn side by side (Fee Collection's payable/collected/pending) — the union, the `WidgetType` switch, the PDF route and the AI spec validator are unchanged, and a bar without it is byte-identically the single-`y` bar it always was. A sixth widget TYPE would still need a new ADR. Series colours are assigned by the renderer from the docs/10 §1 palette in fixed order and are never carried in a spec, so a saved report cannot pin a colour a later palette audit has to honour. In the same change the model-facing draft LOST `drillable`: docs/06 §4.4 defers AI artifacts adopting drill-down to a config-level step against the Dimension Hierarchy Catalog, so a draft that could ask for it could only produce a spec the renderer rejects.*

*Clarified again 2026-08-31 (not amended), for Comparative Analysis, and on the same test: does the union, the `WidgetType` switch, the PDF route or the AI spec validator change? Neither addition touches any of them.*

*(1) `bar.stacked` — the measures drawn on top of each other in one bar rather than beside each other. A stacked bar is still a `bar`. It exists because a PARTITION is a different fact from a comparison: the recovery timeline splits a school's payable into advance / same month / next month / later / still pending, five mutually exclusive states that together are the whole of the money, and side by side they read as five independent measures a reader must add up. It requires `series` (a single-measure "stack" is a bar, enforced in `checkWidgetInvariants`), and the schema deliberately does NOT assert that the segments partition anything — that is the emitter's responsibility, stated in the report's own notes, exactly as `kpi.breakdown` refuses to require its parts to sum.*

*(2) `tableColumn.sort_field` — names a sibling field on each row carrying that column's raw value, so a reader can sort a column whose displayed cell is a pre-formatted string ("₹2.4 Cr" sorts under "₹9.8 L" as text). An optional attribute on a column, like `align` and `masked` beside it, not a widget. Sorting itself stays presentation: the emitted row order is the report's own answer, a reader may re-sort on screen, and the PDF prints the emitted order — so an export still matches what was approved.*

*One palette consequence, recorded because it is a design-system fact rather than a contract one: a stacked bar can carry more segments than the four-step categorical palette, and two adjacent segments folded into the same neutral are one segment as far as a reader can tell. The renderer's fold-in colour is therefore a PAIR of existing neutral tokens that alternate (`SERIES_NEUTRALS`), not a fifth generated hue — the palette is still four steps plus neutrals, and anything past six deliberately repeats.*

## ADR-016 — Dashboards and AI are separate serving paths

**Context.** Predefined dashboards must be free to operate, instant, and available before any AI setup; the AI must be gateable per org.
**Decision.** Predefined/custom dashboards run vetted parameterized SQL through cache/rollups/replicas — zero AI tokens. Ask-AI is a distinct path through the AI Agent Service. The product is fully functional with AI locked.
**Reasoning.** Cost control (unlimited dashboard usage costs no AI money), resilience (AI/key outages never brick reporting), and the BYOK sales motion (value on day one, AI as the upgrade).
**Alternatives considered.** AI-generating even predefined reports — rejected: cost, latency, nondeterminism for the 90% repeat case.
**Trade-offs.** Two code paths converging on the same chart-spec renderer (the shared spec keeps them visually identical).
**Future impact.** "Ask AI about this data/slice" is the deliberate bridge from the deterministic path into the AI path with context.
**Status.** Accepted.

## ADR-017 — BYOK at org level with server-side `ai_status` gating

**Context.** AI usage cost must not sit on the platform's books; trusts administer centrally; access control must not be a UI convention.
**Decision.** Each org connects its own Anthropic API key (Console account, their billing). Keys: AES-256 at rest, KMS master key, decrypted in memory at call time, never logged, masked in UI. Gating state machine `not_configured → pending_validation → active → error`; **every** `/api/ai/*` request re-checks `ai_status == active` (+ monthly cap); UI locks are cosmetic on top of the 403; status changes push over WebSocket. Hybrid `billing_mode='platform'` exists for bundled pricing. Key failure/credit exhaustion auto-relocks with a fix-it banner; dashboards unaffected.
**Reasoning.** Zero AI cost on our books with per-school usage metering on top; org-level matches how trusts buy; server-side gating because UI locks are not security; visible-but-locked drives setup better than hiding.
**Alternatives considered.** Platform-paid AI baked into pricing — kept only as the hybrid mode, not the default (unbounded cost exposure); school-level keys — rejected: N billing relationships per trust; using consumer Claude subscriptions — rejected: not permitted or technically applicable for API usage.
**Trade-offs.** Onboarding friction (a 10-minute admin task; mitigated by the 3-step wizard + PDF guide); the platform must translate someone else's billing errors into plain language.
**Future impact.** Bedrock/Vertex credentials become provider adapters behind the same vault and gate. All AI features (chat, Modify-with-AI, describe-to-flow, AI-compose) hang off this one gate.
**Status.** Accepted.

## ADR-018 — Unified report-definition model; clone-to-edit

**Context.** Users must clone predefined or AI reports under new names and edit them; originals must stay trustworthy.
**Decision.** One persisted model for every report (`report_definitions`: def_json, sql_text, base_report_id, version, visibility private/school/trust). Originals are **immutable masters**; ⧉ Clone creates an editable, versioned copy in My Reports with one-click rollback; AI artifacts save/clone into the same model.
**Reasoning.** One model means cloning, versioning, logic display, drill, PDF and future scheduling are built once; immutable masters guarantee that "Fee Collection (predefined)" means the same thing in every school forever.
**Alternatives considered.** Editing originals in place — rejected: destroys the shared baseline; a separate model for AI snapshots — rejected: forks every downstream feature.
**Trade-offs.** Users can proliferate near-duplicate customs (mitigated by visibility scoping and admin promotion to shared galleries).
**Future impact.** Scheduled email reports re-run definitions; nothing new to model.
**Extended 2026-09-16 (not amended):** A Home/My View Dashboard card may itself carry a `reportId`+`widgetId` and offer Clone exactly as that report's own page does — but ONLY once the card's numbers have been checked, statement for statement, against that widget's real query and found identical (`verifiedReportWidget`, `apps/web/src/components/overview/cards.tsx`). A Dashboard slot id that merely resembles a report widget is not enough: Home keeps offering whole-report clone (or none, where there is no report at all) exactly as before. No new clone path — the same `base_report_id`/`widget_id` request, same server validation against `WIDGET_QUERY_KEYS`; only which SCREENS can reach it changes.
**Extended 2026-09-16, second (not amended):** `WIDGET_QUERY_KEYS` (`services/dashboards.ts`) had, before this date, registered per-widget clone for only 18 of roughly 72 clonable panels across the 14 predefined reports — every other panel offered whole-report clone only, regardless of whether it read one statement or several, because the table happened not to have been extended past the reports it was first written for. Audited and completed: every panel that reads exactly one query is now registered; a panel reading several together (e.g. Fee Defaulters' `table-late-payers`, folding `late_payers` and `pending_students`) is registered against an ARRAY of query keys rather than excluded, since `run_predefined`'s `query_keys` parameter already accepted an array end-to-end — the one-key-per-widget shape in the table was a simplification the mechanism never required. `apps/orchestrator/test/widget-query-keys.test.ts` checks every entry names a real query key on its report, so the table cannot silently drift the way a hand-maintained mirror otherwise would.
**Status.** Accepted.

## ADR-019 — Logic transparency

**Context.** Requirement: "the logic of the report should be displayed to the user on edit mode and after." Principals must answer "where does this number come from?"
**Decision.** Every report exposes a Logic panel: plain-language chips (Source · Scope · Filters · Group-by · Chart) + the generated SQL — in view mode, in the editor (SQL regenerating live beside the visual editor; hand-editable behind an advanced unlock under ADR-008 guardrails), and optionally as a PDF appendix. Scope is displayed read-only as token-injected.
**Reasoning.** Trust and auditability; the live SQL teaches users what their clicks mean; storing `sql_text` with the definition makes every report's execution reviewable.
**Alternatives considered.** Logic visible only in edit mode — rejected: the requirement and the trust argument both demand view-mode visibility; hiding SQL from non-technical users entirely — rejected: chips serve them, SQL serves power users, both coexist.
**Trade-offs.** Exposed SQL invites copy-paste misuse elsewhere (harmless: it's SELECT on their own scoped data).
**Future impact.** Drill reports show all level SQLs with the active one highlighted — same panel, extended.
**Status.** Accepted.

## ADR-020 — Drill-down: 3 levels, bound parameters, curated catalog

**Context.** Requirement: clickable charts drilling High→Mid→Low (monthly fees → class-wise for the clicked month → fee-type-wise for the clicked class), creator-chosen per report.
**Decision.** A `drill` block in the report definition (≤3 levels; per-level dim + chart + inherited filters). Every level runs the same base query with a different GROUP BY; clicked values enter as **bound parameters** — a click can only narrow. Valid paths come from a curated **Dimension Hierarchy Catalog** (per source; dimension once per path; school offered as L1 for multi-school; student-level leaves top-N capped and role-gated). UX: chip + hover hints, in-place swap, breadcrumb + Back/Reset, per-slice KPI recompute. Serving: rollups for L1/L2, rollup-or-capped-replica for L3; `POST /api/report/{id}/drill {level, context[]}`; drill clicks audit-logged with context.
**Reasoning.** Parameter binding keeps the security model identical at depth; the catalog gives flexibility without letting non-technical users build broken or unsafe paths; rollup serving keeps clicks in the 100–400 ms class.
**Alternatives considered.** Free-form drill on any column — rejected: nonsense paths, PII leaks, unbounded queries; pre-rendering all levels eagerly — rejected: N×M×K query waste (top-3 prefetch is the measured middle ground); a separate "drill report" type — rejected: it's a property of a report, and clones must inherit it.
**Trade-offs.** Max 3 levels is a hard product cap; catalog maintenance is an ongoing data task (assumption A8).
**Future impact.** AI artifacts adopt drilling via the spec `drillable` flag against the same catalog (post-GA config step).
**Status.** Accepted. *First implementation 2026-08-27 (Fee Collection), which settled three things this ADR left open and one it got slightly wrong. (1) The Dimension Hierarchy Catalog is `DRILL_PATHS` in services/dashboards.ts and the drill request is validated against it — a dimension no level declares is refused, never turned into a GROUP BY. (2) A clicked SCHOOL is a scope narrowing, not a bound parameter: it goes through the same token intersection every request makes and never reaches the SQL, so "school as L1 for multi-school" costs no new enforcement. Non-school dimensions bind as this ADR says. (3) The fee path reads school→quarter→class rather than the month→class→fee_type sketched above, because the demand ledger buckets by the period money was owed FOR and a school reads that in academic quarters — same shape, one bucket coarser; a `drill_only` flag keeps those levels out of a default dashboard run so an unclicked drill costs no scan. Serving is replica-with-cache: the Rollup Store's class and fee_type dims (ADR-010) are still not built, which docs/06 §6 already anticipated as the interim.*

*Second path 2026-08-29 (Fee Defaulters, school→quarter→class on a defaulter headcount), which added one thing this ADR did not anticipate: a **per-level note**. A drill level can carry a caveat that is true at that level and false at the others, shown against the chart rather than in the report's notes. It exists because a count of PEOPLE does not behave like a sum of money — classes within a quarter add up to the quarter, but quarters within a school add up to roughly three times the school's own distinct defaulter count, since a student overdue in two quarters is one person and two bars. Both readings are correct and only one is intuitive, so the chart that can be misread says so where it is read. Adding the path itself was a catalog entry plus two `drill_only` queries: no endpoint, no service control flow and no UI route changed, which is the evidence that ADR-020's "curated catalog" is data rather than code.*

## ADR-021 — PDF rendering server-side from the persisted spec

**Context.** Every report must export as a branded, print-perfect PDF that matches the screen — including drilled views.
**Decision.** Puppeteer renders a print-optimized route fed by the same persisted chart-spec/report definition (never a re-query through a different path): school/trust branding, scope line, timestamps, page numbers; optional logic appendix; drill exports as current-view (breadcrumb in header) or full pack of visited levels. Exports logged in Export History. A client-side quick-export may exist for casual use; official documents use the server path.
**Reasoning.** Same-spec rendering guarantees screen/PDF parity; server-side gives pixel-perfect, brandable output and an auditable export event.
**Extended 2026-09-15 (not amended):** `export.pdf` takes an optional `widget_id`, narrowing the same rebuilt spec to one widget before it reaches the print route (`narrowToWidget`, `services/pdf.ts`) — the per-chart **Print** item on `ChartMenu` (docs/10 §1.6). Same rebuild-from-id rule, same renderer, same audit event; only which widgets of the already-rebuilt spec are drawn differs. No new query path and no client-supplied spec, so the ADR's own decision is unchanged by it.
**Extended 2026-09-16 (not amended):** A Home/My View Dashboard card may pass its own `reportId`+`widgetId` into the same per-widget `export.pdf` above, so Print appears there too — gated the same way as ADR-018's addendum above (`verifiedReportWidget`): only once the card is confirmed to run the exact same statement as that report widget, never merely a similarly-named one. Screen/PDF parity (this ADR's own reasoning) would otherwise be a lie for any card whose Dashboard query and report query happened to differ. No change to the render path or the widget-narrowing rule itself.
**Alternatives considered.** Client-only (html2canvas/jsPDF) as the sole path — rejected: fidelity and branding limits, no server-side audit; a bespoke PDF layout engine — rejected: duplicates the renderer.
**Trade-offs.** Headless-browser fleet to operate; 2–4 s export latency.
**Future impact.** Scheduled email digests attach PDFs produced by this exact path.
**Status.** Accepted.

## ADR-022 — Workflow agents: JSON graph + persisted state-machine runs

**Context.** Schools build unlimited if/then/else automations visually; flows include waits ("until 2 PM") and must survive restarts and overlapping ticks.
**Decision.** An agent = Trigger + Flow + Schedule stored as a versioned JSON graph (React Flow canvas in the builder; publish pins a version). Execution: scheduler ticks → trigger evaluator (replica SQL / IMAP / ERP webhooks) → one **run per matched record**, walked as a **persisted state machine**; Wait nodes are delayed queue jobs, not threads. Full per-node run logs; runs replay visually on the same flowchart; dry-run test mode renders exact messages without sending.
**Reasoning.** Persisted state machines make restarts lossless and waits cheap at fleet scale; per-record runs give clean audit ("prove the parent was informed at 10:31"); version pinning means editing an agent never mutates in-flight runs.
**Alternatives considered.** Long-running worker threads per flow — rejected: fragile, unscalable with waits; adopting a general workflow engine (n8n/Temporal) wholesale — rejected v1: multi-tenant school-scoped guardrails, template compliance and replica-only reads are the product; the engine core is small next to that (re-evaluate if flow semantics balloon).
**Trade-offs.** We own an execution engine; tick-based triggers have up-to-tick latency (webhooks cover instant cases).
**Future impact.** New node types register against the graph schema; new triggers register with the evaluator.
**Status.** Accepted.

## ADR-023 — Agents are read-only; messages are the only side effects

**Context.** Automations that write to operational school data can corrupt it at machine speed.
**Decision.** Agents read via the same replica/MCP-style layer as reports; their only outputs are messages (WhatsApp/SMS/Email), ERP app notifications via ERP APIs, staff notifications, webhooks and logs. No writes to school databases, ever.
**Reasoning.** An agent bug becomes an annoying message, never corrupted fees; zero ERP load extends to automation; the ADR-008 read-only plane stays universal.
**Alternatives considered.** Whitelisted write-back actions (e.g., mark "parent informed" in the ERP DB) — rejected: state changes belong to the ERP; the ERP-notify API is the sanctioned channel for anything the ERP should record.
**Trade-offs.** Some desirable automations require future ERP APIs rather than direct writes.
**Status.** Accepted. *Clarified 2026-08-17 (not amended): this ADR's phrase "the same replica/MCP-style layer" predates ADR-006's formalization and must be read as "the MCP server's tool surface" — there is no parallel read-only layer, and none may be built (docs/04 §7, docs/07 §3). The outbound ERP-notify call sanctioned here is a named off-read-path exception to Invariant 1 under ADR-027, and remains contingent on that API existing (docs/11 §2 item 7).*

## ADR-024 — Messaging channels are school-owned; approved-template-only

**Context.** Requirement: schools configure Mail/SMS/WhatsApp themselves and choose channels per message. India compliance: SMS needs DLT-registered senders and approved templates; WhatsApp needs BSP/WABA-approved templates.
**Decision.** Channels (SMTP, SMS provider + DLT sender ID, WhatsApp BSP) are configured per school in Settings with Connected status. Every message node selects among **connected** channels (first checked = PRIMARY) with an optional delivery-failure fallback. Publishing an agent referencing a disconnected channel is refused; later disconnects flag dependent agents. A **Template Manager** owns create → submit → approved templates; message nodes reference approved templates only — free text cannot be sent on regulated channels.
**Reasoning.** Sender reputation, DLT registration and WABA quality ratings legally and practically belong to the school; template-only sending makes compliance structural rather than procedural; connection-gated selection prevents silently dead agents.
**Alternatives considered.** Platform-owned pooled senders — rejected: shared reputation risk, DLT/WABA attribution problems; free-text with best-effort compliance — rejected: regulator-facing risk.
**Trade-offs.** Onboarding includes provider setup and template-approval lead times (the provider choice gates timelines more than code — open input #4); v1 config is school-level, with trust-level defaults + per-school overrides flagged as an early schema decision (assumption A7).
**Status.** Accepted.

## ADR-025 — Idempotency and guardrails are platform-level

**Context.** Overlapping scheduler ticks, retries and school-authored flows could spam parents at scale.
**Decision.** Non-optional, platform-enforced on every agent: auto-derived **dedup keys** (agent+node+record+date), quiet hours (default 8 PM–7 AM; bounded per-node overrides), per-school daily message caps, auto-pause after consecutive failures, unsubscribe handling, per-agent kill switch, full per-node audit.
**Reasoning.** A parent double-messaged about the same absence is a product-killing failure; schools should not be able to configure their way into it. Guardrails as platform law also bound the blast radius of the "unlimited agents" promise.
**Alternatives considered.** Per-agent opt-in guardrails — rejected: the schools least likely to enable them are the ones most likely to need them.
**Trade-offs.** Rare legitimate re-sends require an explicit override path rather than "run it again."
**Status.** Accepted.

## ADR-026 — Model strategy: Haiku-first + prompt caching

**Context.** AI answers must land in 3–10 s and cost single-digit rupees per question on the org's own bill.
**Decision.** Default to the economical model (Haiku) with escalation to Sonnet for complex analysis (org-selectable default in BYOK settings). Anthropic **prompt caching** on the schema block (viable because of ADR-014's 3–5 shared schema versions). Streaming so first widgets appear ~2 s. Conversation guardrails: one clarifying chip-question on ambiguity; auto-aggregate-and-retry once on oversized results.
**Reasoning.** Most school questions are simple SQL planning; caching the shared schema prompt is the largest single cost/latency lever; streaming converts a 6-second answer into a 2-second experience.
**Alternatives considered.** Always-Sonnet — rejected: cost/latency on the org's bill without proportional quality gain for typical queries; fine-tuned/self-hosted models — out of scope and against the BYOK model.
**Trade-offs.** Escalation heuristics to tune; model names/prices drift (assumption A9 — meters and selectors are data-driven).
**Status.** Accepted.

## ADR-027 — Invariant 1 scope: no ERP on the data path

**Context.** Invariant 1 is stated absolutely in `CLAUDE.md` and `PROJECT_CONTEXT.md` §3/§4: analytics and agents "NEVER call ERP services at query time", and "the ERP's only runtime involvement is signing one launch JWT per session." Two Accepted decisions contradict that literal text. ADR-023 sanctions **outbound ERP-notify API calls** as an agent action — explicitly, as the alternative to database write-backs ("the ERP-notify API is the sanctioned channel for anything the ERP should record"). ADR-005 and docs/07 §2 accept **inbound ERP event webhooks** (school create/update; later admission and fee events). The invariant is quoted verbatim in four documents and is the decisive commercial argument to the ERP vendor, so both failure modes are live: a literal reading cuts the 🔔 action node, while a loose reading licenses a read-path ERP call.

**Decision.** Invariant 1 governs **the data/read path**. Restated: no component of the platform may query an ERP primary database, and no component may call an ERP service to obtain **data, configuration, or authorization at query time**. Two runtime interactions are sanctioned exceptions, neither on the read path:

1. **Outbound ERP-notify** — agent action nodes may call the ERP's notification API to raise an in-app notification (ADR-023), subject to the ADR-025 guardrails.
2. **Inbound ERP webhooks** — the platform may receive ERP-originated events, authenticated per ADR-029. An inbound event never *satisfies* a read: it invalidates cache or enqueues work, and the data is then read from the data plane.

Both exceptions are excluded from the "zero ERP load" measurement basis. The GA gate's `ERP primary CPU delta = 0` measures the read path; notification-API load is measured separately against limits the ERP team specifies.

**Reasoning.** The invariant exists to make it impossible for analytics to degrade ERP primaries or to put the ERP in the latency path of a user's query. Neither exception does either: ERP-notify is asynchronous, queued and guardrailed, off the query path entirely; inbound webhooks cost the platform, not the ERP. Stating the boundary precisely protects the *mechanism*. The absolute wording protected only the slogan — and left two Accepted ADRs contradicting the text of the invariant they were reviewed against.

**Alternatives considered.** (a) Keep the absolute wording and cut ERP-notify plus event webhooks — rejected: removes ADR-023's sanctioned alternative to write-backs and reduces agents to polling only, for no isolation gain. (b) Leave the wording and treat the exceptions as understood — rejected: the invariant is quoted in four documents as a hard rule, and undocumented exceptions to hard rules are precisely how drift begins. (c) Route everything through messaging channels and never touch the ERP — rejected: some events belong in the ERP's own record, which is ADR-023's reasoning.

**Trade-offs.** The invariant is no longer expressible in one sentence; readers carry a two-clause rule. The notification path introduces an ERP dependency inside agent action workers, so an ERP outage degrades the 🔔 node — a logged, retryable node failure per docs/07 §6, not a platform failure.

**Future impact.** Every *new* ERP interaction must be classified against this ADR before it is built: on the read path it is forbidden; off it, it requires an ADR naming it as an exception. Note that exception 1 is contingent on the ERP notification API existing at all — still an unconfirmed input (docs/11 §2). If it does not exist, ADR-023's rejection of write-backs loses its stated alternative and that trade-off must be re-examined, not merely the node.

**Status.** Accepted. Amends the Invariant 1 wording in `CLAUDE.md`, `PROJECT_CONTEXT.md` §3/§4, `docs/01` §2, and `docs/09` §2. Touches an invariant, so it carries the explicit sign-off the amendment process requires; recorded as given.

## ADR-028 — Result-cache contract: permission class in the key; three-tier serving order

**Context.** ADR-012 fixes the result-cache key as `report + level + drill-context + filters + school-set` and declares the tier order law. Two defects surfaced in the documentation audit:

- **Masking is role-dependent, the key is not.** PII masking is applied per session role (docs/04 §3 rail 6) and drill leaves are gated on student-data rights (docs/08 §4.5), but the key carries no permission component. Two users of the same school with different `perms[]` therefore collide: a Principal warming the cache would serve unmasked rows to a class teacher on an identical key.
- **The tier order was stated four ways** — docs/03 §4 (three tiers), docs/09 §4 and ADR-012 (four, inserting the schema/dimension cache), CODING_GUIDELINES §15 (three). Placing the schema/dimension cache inside the *result-serving* order is a category error: per ADR-014 it serves schema metadata for AI SQL generation and never answers a report query.

Separately, the Redis result cache is the only store where row-level PII leaves a school database, and docs/08 did not mention it — while ADR-010's no-PII rule for the Rollup Store carried the entire data-minimisation argument.

**Decision.**

1. **Cache key.** The result-cache key is `report + level + drill-context + filters + school-set + permission_class`, where `permission_class` is a deterministic digest of the caller's effective data-visibility rights — masking state and drill-leaf eligibility as derived from token `role` and `perms[]`. Callers with different effective visibility can never share a cache entry.
2. **Serving order.** Exactly three result-serving tiers: ① Redis result cache → ② Rollup Store → ③ read replica. The schema and dimension caches are AI-path metadata caches (docs/03 §5, ADR-014), documented separately and never part of this order.
3. **Cache PII policy.** The result cache may hold row-level PII. It is therefore encrypted at rest and in transit; on private subnets, never internet-reachable; TTL-bounded 5–15 min as already specified; excluded from operational logs; and in scope for the compliance review's retention decisions (docs/11 §4.5) alongside audit and message_log.

**Reasoning.** A masking rule enforced at query time and discarded at cache time is not enforced at all. Making `permission_class` part of the key keeps the two consistent structurally rather than by discipline — the guardrails-as-mechanism principle (PROJECT_CONTEXT §9.3). Correcting the tier list removes an instruction CODING_GUIDELINES §15 requires engineers to mirror "in code structure, not just intent", and which would have produced a nonsensical lookup. Naming Redis in the PII policy closes the one gap in an otherwise complete data-minimisation story.

**Alternatives considered.** (a) Cache only fully-masked results and re-resolve masking per request — rejected: forfeits the cache for privileged users, who are the heaviest dashboard users. (b) Key by user id — rejected: destroys hit rates for no additional safety, since what varies is visibility, not identity. (c) Forbid PII in the cache entirely, mirroring ADR-010 — rejected: excludes Fee Defaulters and every drill leaf from caching, breaking the 50–200 ms budget for the reports schools use most; the permission-class key achieves the isolation that rule was reaching for.

**Trade-offs.** Marginally lower hit rates where a school's users hold heterogeneous permissions. `permission_class` must be derived deterministically or entries fragment silently — one function, unit-tested. Redis becomes in-scope for the compliance review.

**Future impact.** Any future per-user visibility feature (finer PII policies via `perms[]`, per-domain redaction) extends `permission_class` rather than the key's structure. Cache-warming and drill prefetch must warm per permission class, not per school.

**Status.** Accepted — amends ADR-012, which otherwise stands. Updates docs/03 §4, docs/08 §5, docs/09 §4, CODING_GUIDELINES §8/§15.

## ADR-029 — Launch transport, webhook authentication, CSRF posture

**Context.** Three security surfaces were unspecified across the doc set:

- **Launch transport.** docs/02 §2 showed the token in a URL query string (`/launch?token=…`). Query strings land in proxy and server logs and in `Referer` headers, which the platform cannot redact upstream — while CODING_GUIDELINES §13 declares launch tokens a log-forbidden value. The 60-second single-use window narrows the exposure but does not remove it.
- **Webhook authentication.** The ERP→platform webhooks of docs/02 §5 and docs/07 §2 specified no authentication, although the receiver writes to the Tenant Registry — the table that determines which replica a school's queries reach.
- **CSRF.** ADR-004's 8-hour cookie session fronts state-changing POSTs (drill, save report, publish agent) with no documented defense, and iframe embedding forces `SameSite=None` (docs/02 §4, docs/08 §2), removing the default protection in exactly the mode that most needs it.

**Decision.**

1. **Launch transport.** The launch token is delivered by an **auto-submitting POST form** to `https://analytics.<domain>/launch`, body parameter `token` — never as a URL query parameter. The handler responds with a redirect to the SPA, so the token never enters a URL, a history entry, or a `Referer` header. `Referrer-Policy: no-referrer` is set on the launch route regardless.
2. **Webhook authentication.** ERP→platform webhooks carry `X-Signature: HMAC-SHA256(body, shared_secret)` and `X-Timestamp`. The platform rejects signatures failing constant-time comparison, timestamps outside a 5-minute window, and replayed `(timestamp, signature)` pairs within that window. The shared secret lives in Secrets Manager and rotates with an overlap period. Webhooks remain advisory: every event they carry is also reachable via the 15-minute sync, so a rejected webhook degrades freshness, never correctness.
3. **CSRF.** Session cookies are `httpOnly; Secure; SameSite=Lax` in new-tab mode and `SameSite=None` in iframe mode. **Independently of cookie policy**, every state-changing request carries a double-submit CSRF token — a cookie-readable value echoed in a request header and compared server-side. GET/HEAD endpoints are side-effect-free by contract.

**Reasoning.** Each measure removes a class of exposure rather than narrowing it. POST transport makes the token unloggable upstream instead of trusting a 60-second window against unknown log retention. HMAC plus a replay window makes registry writes unforgeable rather than merely obscure. A cookie-policy-independent CSRF token means iframe mode's mandatory `SameSite=None` is not a security regression. All three are conventional and cheap — and cheapest *before* the ERP team builds its side.

**Alternatives considered.** (a) Query string plus `Referrer-Policy` and log scrubbing — rejected: the platform cannot scrub the ERP's or an intermediary's logs. (b) Fragment transport (`#token=`) — rejected: keeps the token out of logs but moves verification into client-side JavaScript, contradicting ADR-002's no-credential-handling-in-the-browser posture. (c) mTLS or IP allowlisting for webhooks instead of HMAC — rejected as the sole mechanism (brittle across ERP deployments and NAT changes); available later as defense in depth. (d) `SameSite=Strict` with no CSRF token — rejected: incompatible with iframe embedding, a supported mode.

**Trade-offs.** POST launch means the ERP builds a form-post handoff rather than a link — marginally more work on their side, and it must be specified before they build (docs/11 §2 item 3). A shared webhook secret is one more rotatable credential to operate. The CSRF token adds a header to every mutating request in the SPA's API layer.

**Future impact.** A second ERP integrating under ADR-003's contract inherits the POST handoff and HMAC scheme unchanged. A future `user_disabled` revocation webhook (ADR-004, docs/02 §8) authenticates under clause 2 with no new mechanism.

**Status.** Accepted. Updates docs/02 §2/§4/§5 and docs/08 §2, and adds the transport requirement to the ERP-side build in docs/11 §2.

## ADR-030 — Ask-AI chart-specs are hydrated server-side; the model never receives or emits row data

**Context.** AUDIT_REPORT C15 (High). docs/05 §1's chart-spec example has the model emitting its own payload — `"data": [...]` on a bar widget, `"rows": [...]` on a table. Under ADR-017's BYOK model that traffic transits the *customer's own* Anthropic account, so this is not an internal engineering detail but row-level student data — names, fee amounts, contact numbers — leaving the school's control boundary through the model. docs/08 governs PII movement meticulously everywhere else (§5's Rollup Store no-PII rule, ADR-028's cache encryption and `permission_class` key) and was silent on the single largest data egress in the design. It is also infeasible as specified: ADR-008 caps results at 5,000 rows, and no result near that size can round-trip through model output within any practical latency or token budget.

**Decision.** The model emits a chart-spec **skeleton only** — widget types, encodings (`x`/`y`/`group` field names), the narrative text, and table column definitions. It never receives result rows in its context beyond what `get_dimensions` needs for planning, and it never emits `data`/`rows` values. The orchestrator's AI Agent Service runs the MCP tool calls the model plans (`run_query` / `run_multi` / `run_rollup`), then **hydrates** the skeleton server-side: it binds each query result onto the widget the model specified, in the same step that already applies row-level masking (docs/04 §3 rail 6, docs/08 §4.4) before anything reaches the client. A spec that fails to hydrate — a field name the model invented that isn't in the result columns — is a `INVALID_CHART_SPEC` and the model gets one retry with the actual column list, never a partially-populated widget.

**Reasoning.** This is the same shape as every other data-plane rule in the doc set (ADR-006, ADR-008, ADR-011): the model plans, the platform's own code touches school rows. It resolves both C15 problems at once — no row-level PII crosses to the provider under any billing mode, and the widget carries however many rows the query actually returned, independent of any model context limit. It also makes masking uniform: today masking is applied once, at query time, for every rendering path (predefined, custom, AI) instead of needing a second enforcement point for whatever the model chooses to echo back.

**Alternatives considered.** (a) Model emits full rows as docs/05 §1 currently shows — rejected: the PII-egress and row-cap-feasibility problems this ADR exists to close. (b) Client-side hydration (SPA fetches raw rows separately and merges onto the streamed skeleton) — rejected: duplicates the masking/scope check the orchestrator already owns, and reopens the "does the client ever see an unmasked row" question ADR-028 closed for the cache. (c) Truncate rows to a small sample before sending to the model — rejected: still egresses real student PII per question asked, just less of it, and does not fix the row-cap infeasibility for the table widget.

**Trade-offs.** The model cannot describe individual data points in its narrative from direct inspection — "narrative" is written from aggregates/summary values the orchestrator can safely pass back in a second turn (count, sum, min/max), not raw rows. Streaming becomes two phases (skeleton, then hydrated widgets) rather than one; docs/05 §2's "widgets render progressively" still holds, it progresses per-widget-hydrated rather than per-token-streamed.

**Future impact.** This is the mechanism ADR-015 always needed but never specified; ADR-015 itself is unchanged; “the model never produces renderable code” now also reads “the model never produces the data such code would render.” Any future AI surface built on chart-spec (Modify-with-AI, AI-compose in workflow agents) inherits hydration for free — it is a property of the spec pipeline, not of the chat feature.

**Status.** Accepted. Amends docs/05 §1 (example + a new §1.1 on the hydration step) and docs/08 §5 (new §5.2 stating the no-PII-to-provider posture explicitly). Resolves AUDIT_REPORT C15 and docs/11 §2 Phase-3-blocking item 14.

## ADR-031 — BYOK is multi-provider: Anthropic or Google Gemini, admin's choice

**Context.** ADR-017 fixed BYOK to "each org connects its own **Anthropic** API key" — a real decision, not an oversight, made when Ask AI had one provider to build against. Two things changed that: some schools/trusts already hold a Google Cloud relationship rather than an Anthropic one, and a free-tier Gemini option lowers the evaluation barrier for a school deciding whether Ask AI is worth a paid account at all — Anthropic's API has no equivalent free tier. Both providers were built and driven end-to-end against the real pipeline before this ADR was written (including live MCP tool execution and a real hydrated chart-spec answered by each), so this is not a speculative extension.

**Decision.** An admin picks **one** provider per org — Anthropic or Google Gemini — at BYOK setup time, and can switch later (the switch overwrites the stored key exactly like "Replace Key" already does for a same-provider swap; `tenant_ai_config` keeps `PRIMARY KEY (org_id)`, one active provider at a time, not both simultaneously). Everything provider-specific — the model catalog, live key validation, SDK error translation, and the tool-planning loop's actual message format — sits behind one interface (`services/ai-providers/`: `ProviderMeta` for configuration/validation, `ModelClient` for the conversation loop). ADR-030's redaction (`ai-tools.ts`), hydration, MCP tool execution, and the `ai.query` audit event are written once, provider-agnostically, and never change based on which provider answered.

**Reasoning.** Anthropic's `tool_use`/`tool_result` blocks and Gemini's `functionCall`/`functionResponse` parts are genuinely different shapes — this was confirmed by hand, building both, not assumed going in. A provider interface at the conversation-turn level (`initialState`/`step`/`withToolOutcomes`/`withNudge`) is the smallest seam that absorbs that difference without leaking it into the redaction/hydration logic ADR-030 already got right, which is the part that must never fork per provider. Model ids are declared as "latest" aliases where the provider offers one (`gemini-flash-lite-latest`, `gemini-flash-latest`) rather than dated ids — `gemini-2.0-flash` was retired mid-development, live, which is exactly the drift docs/05's assumption #2 already names for Anthropic and generalizes here.

**Alternatives considered.** (a) Keep BYOK Anthropic-only, offer Gemini as an unofficial escape hatch — rejected: this was tried first, as an env-var bypass that skipped the vault, Settings, and the audit trail entirely, and was explicitly marked never-to-ship; a real feature needs the real gate. (b) Let an org hold both providers' keys simultaneously (composite `PRIMARY KEY (org_id, provider)`), switching per question — rejected as unnecessary complexity for what was asked: an admin picks the provider the org is going to use, not a per-question router, and the schema change would ripple further than the feature needs. (c) One mega-parameterized `validateApiKey(provider, args)`/`translate(provider, err)` function instead of two provider modules — rejected: Anthropic's and Gemini's SDK error shapes (typed classes vs. a JSON error body) have no shared vocabulary worth abstracting, and forcing one would produce a function that is mostly a switch statement anyway.

**Trade-offs.** Two model catalogs and two error-translation paths that will independently drift as each provider ships new models — the "latest" alias convention mitigates but does not eliminate this. Gemini's key-shape check is deliberately loose (non-empty, no whitespace, minimum length) rather than a prefix regex, because a real Gemini key observed during development (`AQ.Ab8RN6...`) does not match the commonly-assumed `AIza...` pattern — a wrong strict regex would reject real keys, which is worse than a permissive check that defers to the live validation call anyway.

**Future impact.** A third provider (Bedrock/Vertex, per docs/05 §7's original extensibility note) is a new `services/ai-providers/*.ts` file implementing `ProviderMeta`, one registry-map entry, and nothing else — Settings, the vault, `ai-chat.ts`'s loop, and the redaction/hydration/audit chain need no changes. Per-school provider budgets, if ever needed, extend `ProviderMeta`/the vault row rather than restructuring either.

**Status.** Accepted. Amends ADR-017's provider clause. Updates docs/05 §4 (BYOK section generalized from "the organization's own Anthropic account") and §5 (the 3-step wizard's step ① becomes provider-conditional), and docs/08 §6 ("Anthropic API key" wording generalized to "the org's AI provider key" — the vault's crypto needed no changes, since it was already provider-agnostic). Migration `db/platform/migrations/0006_tenant_ai_config_provider.sql`.

## ADR-032 — `report_definitions.school_scope` is intersected with the viewer's token scope at execution

**Context.** AUDIT_REPORT A8: ADR-018 persists a `school_scope` column on every report definition, but nowhere states what that value means at execution time once ADR-018's own `trust`-visibility clause lets a report cross session boundaries — a Director's 12-school clone opened later by a Principal whose token carries one school. Left undefined, this is a tenant-isolation-adjacent ambiguity: does the stored scope widen the viewer's session, does a mismatch error out and break every shared report for anyone but its author, or something else? Raised as Phase-3-blocking TL question 18 and decided this session, ahead of building `services/custom-reports.ts`.

**Decision.** At execution, **effective scope = the definition's stored `school_scope` ∩ the viewer's own token scope** — never the stored scope alone, and never widened by it. The Logic panel's Scope chip always shows the *effective* (viewer's) scope, never the author's original one. If the intersection is empty, the report refuses to run (`TENANT_UNAVAILABLE`) rather than falling back to either set alone. Implemented in `services/custom-reports.ts`'s `effectiveScope()`, exercised by `test/custom-reports.test.ts`'s AUDIT_REPORT A8 suite.

**Reasoning.** Intersection is the only reading consistent with Invariant 2 ("scope is law", token-derived, never widened by anything a client or a stored value supplies) applied to a SECOND source of scope: a stored column cannot be allowed to grant a session more than its own launch token did, by the same logic ADR-007 already applies to a request-supplied `school_ids` parameter. Showing the effective (not the author's) scope in the Logic panel closes a second issue the audit named in passing: displaying the author's original scope to a viewer who cannot see all of it would leak school names outside their grant.

**Alternatives considered.** Reject on any mismatch between stored and token scope — rejected: it would break every `trust`-shared report for anyone whose token scope isn't an exact superset of the author's, defeating the point of ADR-018's `trust` visibility tier the moment it is used across roles, which is its whole use case (a Director sharing to Principals). Store no scope at all, resolving purely from the viewer's token at every run — rejected: a report authored for "my 3 schools" would silently answer for whichever schools the CURRENT viewer happens to hold, changing what a shared report means depending on who opens it, which is a worse and quieter failure than the intersection rule.

**Trade-offs.** A Principal opening a trust-shared, multi-school report sees a narrower answer than its author did — expected and correct, but worth stating: "your school's slice of the Director's report", not "the Director's report". No UI currently explains this distinction on the report itself; a future pass could add a note when the effective scope is narrower than the stored one.

**Future impact.** Drill-down (deferred to Phase 2/4 per docs/11) inherits this rule for free once built on the same `report_definitions` row — a drill click narrows within the already-intersected effective scope, never the stored one.

**Status.** Accepted. Updates docs/06 §1 (school_scope semantics stated explicitly). Implemented in `services/custom-reports.ts`; no schema change to the `report_definitions.school_scope` column itself, which continues to record only the author's scope at save time.

## ADR-033 — Saved AI reports re-run the persisted statement, never the model

**Context.** AUDIT_REPORT C17: ADR-018 saves an AI answer's chart-spec and `sql_text` into `report_definitions`, and docs/11's Phase 3 exit criterion is "clones re-run with fresh data" — but nothing stated whether "Re-run" re-executes the persisted SQL (free, deterministic) or re-invokes the model (billable, and locked the instant the org's `ai_status` leaves `active`). ADR-016's "dashboards unaffected [by a locked AI key]" and ADR-017's "the product is fully functional with AI locked" both imply the former without saying so; docs/10's "AI snapshot" badge and Re-run affordance read ambiguously either way. Raised as Phase-3-blocking TL question 19 and decided this session, ahead of building the save/re-run path.

**Decision.** Opening or re-running a saved AI report **always re-executes its persisted statement(s) through the deterministic `run_query`/`run_multi` path** — no token spent, no dependency on `ai_status`, identical to how a predefined dashboard or a template-mode clone re-runs. A distinct, separately-gated **"✎ Refine with AI"** action (re-invoking the model to change the report) is real per docs/10 but is **not built in this slice** — deferred, and explicitly flagged as such rather than silently dropped. Implemented in `services/custom-reports.ts`'s `runRawSqlMode` (used by both `saveAiReport` and every subsequent `viewReport` call on that report); proven in `test/custom-reports.test.ts`'s AUDIT_REPORT C17 case, which asserts the re-run path never imports `services/ai-chat.ts`'s model-calling loop.

**Reasoning.** This is the reading that makes ADR-016/017's promises literally true rather than aspirational: a school whose Anthropic/Gemini key lapses must not also lose every report it already built with AI, the same way it does not lose its predefined dashboards. Persisting `sql_text` (ADR-018) already captured everything needed to answer again without the model; the only question was whether the product would actually use that fact.

**Alternatives considered.** Re-invoke the model on every open — rejected: costs tokens for a view action that changed nothing about the question being asked, and turns a locked BYOK key into a data-loss event for every AI-derived report the org has ever saved, contradicting ADR-017's stated failure mode ("dashboards unaffected"). Ask the user each time (re-run SQL vs. re-ask the model) — rejected as unnecessary friction: the two are different ACTIONS with different costs and different names (Re-run vs. Refine), not two settings on one button.

**Trade-offs.** A saved AI report's numbers go stale in the same way a predefined dashboard's do (replica lag only, `served_from`/`as_of` labelled) but never picks up a genuinely different answer to the original question the way re-asking the model might (e.g., a smarter model noticing a better query). That upgrade path is exactly what the deferred "✎ Refine" action is for.

**Future impact.** "✎ Refine with AI" is additive: a new `ai_status`-gated endpoint that re-invokes the model seeded with the current definition and, on success, calls the same `updateReportSql`-style save path already built — no change to the re-run/view path this ADR fixes.

**Status.** Accepted. Updates docs/06 §1 (Re-run semantics stated explicitly) and docs/10 §2 (My Reports' Re-run affordance). Implemented in `services/custom-reports.ts`; "✎ Refine with AI" remains unbuilt and tracked in docs/11.

---

## ADR-034 — Channel ownership: trust-level default, per-school override

**Context.** ADR-024 fixed messaging-channel configuration as school-level v1, with docs/07 §4 flagging trust-level provider accounts as the anticipated evolution (assumption A7) — then going further to note A7 "may be a prerequisite rather than an evolution": DLT and WABA onboarding at 1,500-school scale is a per-school operations programme (its own entity registration, business verification and template-approval lead time), not a configuration step, and school-level-only would mean starting that programme 1,500 times before any agent can send a message anywhere. Workflow Agents (ADR-022/023) is the first feature that actually depends on a channel existing, which forces the question ADR-024 deferred.

**Decision.** A channel's effective configuration resolves from two tables: `org_channels` (one row per org+channel — the trust-level default) and `school_channels` (unchanged shape from ADR-024 — a school-level row that, when present, overrides the org default for that one school). Resolution order, computed by one function (`effectiveChannel`, mirroring the determinism discipline ADR-028 required of `permission_class`): a `school_channels` row wins when present; otherwise the `org_channels` default applies; a school with neither is not connected. Both tables keep ADR-024's no-credentials-here posture — state only (status/provider/detail), never a secret. Publish-time and send-time checks always read the *resolved* channel, never the org default in isolation, so a school that has explicitly overridden or disconnected its own channel is never silently routed through the trust account.

**Reasoning.** A trust-level BSP/DLT/SMTP relationship is the one mechanism that makes onboarding tractable for a trust's schools from day one — one DLT entity and one WABA account can back every school in the trust immediately, deferring per-school registration to schools that actually need their own sender identity (a large school with its own brand reputation to protect, say). This is the same shape as ADR-013's tenant-registry-plus-per-school-secrets model: a shared default with a named override path, not a forced choice between them.

**Alternatives considered.** (a) Keep school-level-only (ADR-024 as originally written) — rejected: makes per-school provisioning a precondition of Workflow Agents GA rather than a parallel-track improvement, which is exactly the risk A7 flagged. (b) Trust-level only, no school override — rejected: a school with its own existing DLT/WABA registration would be forced onto the shared trust sender, discarding a real asset and, for SMS specifically, potentially violating the school's own registered-sender obligations.

**Trade-offs.** Two tables instead of one, and the resolution function is now load-bearing — every message-send and publish-time check must call it rather than reading either table directly, or a school-level override could be silently ignored. The Settings screen must show *which level* a school's active channel resolved from, so an admin isn't left guessing whether "Connected" means the trust's account or their own.

**Future impact.** The Template Manager (docs/07 §4) inherits this shape unchanged: a trust-level provider account implies a trust-level approved-template library by default, with the same override point for a school running its own account. A third ownership level (e.g., a regional grouping) would be a third resolution step in the same function, not a new mechanism.

**Status.** Accepted. Amends ADR-024's school-level-v1 clause (everything else in ADR-024 — approved-template-only sending, connection-gated publish, per-school disconnect flagging dependent agents — stands unchanged). Updates docs/07 §4 and resolves docs/11 assumption A7 and open decision §4 item 2.

---

## ADR-035 — Email sends through a configured SMTP transport; the transport is deployment config, never stored channel credentials

**Context.** ADR-024 fixed messaging channels as state-only rows (`status`/`provider`/`detail`, never a secret) and ADR-034 fixed how those rows resolve, but neither said how a message actually leaves the building. The consequence is visible in `apps/agent-runtime/src/runner/run-orchestrator.ts`: every real send dead-ends at `messaging provider not yet connected (docs/11 §2 items 4/8)`, and the only path that ever reaches `sent` is the `Sandbox` provider, which by construction never delivers anything. That was the correct posture while all three channels looked alike. They do not: items 4 and 8 gate **SMS and WhatsApp** — DLT entity registration, an approved sender ID, a BSP account, a verified WABA, template-approval lead times — and gate **email not at all**. Email needs a host, a port and a from-address. Treating it as equally blocked meant the platform could not demonstrate, to a stakeholder or to itself, that the guardrail → dedup → branch → template → send pipeline ends in a message a human receives.

**Decision.** The email channel gains a real transport, with the credential boundary drawn at a different place from the channel row:

1. **Which schools may send on email** stays exactly where ADR-024/034 put it — `school_channels`/`org_channels`, resolved by `resolveChannel`, state only. A row's `provider` column names *which transport applies* (`SMTP`), never how to reach it.
2. **How this deployment puts bytes on the wire** is process configuration (CODING_GUIDELINES §12): `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, and optional `SMTP_USER`/`SMTP_PASSWORD`, validated once at boot by the same zod config schema as every other tunable, supplied in production from Secrets Manager. No SMTP credential is ever written to, or read from, a channel table.
3. **Locally and in the demo the transport is Mailpit** (`127.0.0.1:1025` SMTP, `:8025` inbox), declared in this repository's `docker-compose.yml` alongside Redis. Mailpit requires no authentication and accepts every address, so the local path introduces no secret handling whatsoever and `SMTP_USER`/`SMTP_PASSWORD` stay unset.
4. **A send is a send.** Every guardrail that already applies keeps applying — quiet hours, the daily cap, the dedup key, approved-template-only sending — and the `message_log` row carries the transport's real message id in `provider_ref`. The `sandbox-` prefix (ADR-034's companion mechanism, `SANDBOX_PROVIDER`) remains reserved for the simulated path and is never written by this one, so no reader of `message_log` can confuse a delivered message with a simulated one.
5. **SMS and WhatsApp are unchanged.** They still dead-end at "provider not yet connected", because items 4 and 8 are still open. This ADR deliberately unblocks one channel rather than inventing an abstraction over three.

**Reasoning.** The thing ADR-024 refused to do was hold a school's provider password in a table with no encryption behind it. Nothing here does that: the transport is infrastructure the *deployment* owns, the same category as `PLATFORM_DB_PASSWORD` or `REDIS_URL`, and it is configured by the operator who already holds those. That distinction — *state in the database, secrets in config* — is what lets email work today without conceding the point ADR-024 was protecting. Choosing SMTP specifically also keeps docs/11 §2 item 8 genuinely open: SMTP is a protocol every provider speaks, not a vendor, so nothing here pre-empts the eventual SES/SendGrid/existing-ERP-relationship answer.

**Alternatives considered.** (a) **Keep the sandbox path only** — rejected: the sandbox proves the pipeline to a test, never to a recipient, and email carries no regulatory gate that would justify the wait. (b) **Capture per-school SMTP credentials in Settings now** — rejected: precisely what ADR-024 refused, and it needs the key vault ADR-017 built for BYOK extended to a second secret class first. (c) **A hosted email API (SES, SendGrid, Resend)** — rejected for this slice: requires credentials and internet access to demonstrate anything at all, adds an SDK against CODING_GUIDELINES §19, and commits to the vendor answer item 8 is still holding open. (d) **`nodemailer` vs a hand-rolled SMTP client** — nodemailer is added as a dependency under §19 (written need: SMTP with attachments, MIME encoding and connection pooling; no existing project dependency speaks SMTP; MIT licensed; the de-facto Node SMTP client with continuous maintenance).

**Trade-offs.** Until per-org SMTP configuration exists, every school in a deployment sends from one `SMTP_FROM` address. That is a real limitation and belongs on screen rather than in a comment — Settings states which transport an email channel resolved to and which address it sends from. Mailpit accepts everything it is handed, so a green local run proves the pipeline is correct and proves nothing at all about deliverability, SPF/DKIM alignment or a recipient's spam folder; those become real questions the moment a production transport is configured, not before.

**Future impact.** Per-org or per-school SMTP configuration is additive: a vault entry for the credential (extending the ADR-017 vault to a second secret class), a resolution step in front of the transport factory, and no change to anything above it — the action node, the guardrails and `message_log` already address the transport through one narrow interface. The same interface is where an SES/BSP adapter would land if item 8 resolves that way, which is why it takes a message and returns a provider reference rather than exposing SMTP concepts to its callers.

**Status.** Accepted. Extends ADR-024/ADR-034 (neither is amended: state-only channel rows, approved-template-only sending and the resolution order all stand unchanged). Updates docs/07 §4 and docs/11 §2 items 4/8 (email removed from their scope; SMS/WhatsApp unchanged). Implemented in `packages/mailer`, `apps/agent-runtime/src/runner/run-orchestrator.ts` and `apps/orchestrator/src/services/schedules.ts`.

---

## ADR-036 — A message action node carries its own recipient when the record cannot supply one

**Context.** docs/11 §2 item 10, found 2026-09-15: no parent or guardian contact column exists anywhere in the catalogued schema (`apps/mcp-server/src/schema/erp-v1.ts`), so `record['parent_phone']` is `null` for every real record and every non-sandbox send fails with "no recipient contact information available". docs/07 §1's canonical templates assume `{{parent.phone}}` exists. Item 10 is answerable from the extract rather than from a vendor, but it is not answerable *today*, and ADR-035 has just made the send itself work — which turns the missing address from one blocker among several into the only thing standing between a working transport and a delivered message. Separately, docs/07 §2 has always listed agents whose audience is **staff, not parents** ("teacher-absent → substitute", `also_notify_staff`), and for those the record was never going to be the source of the address in the first place.

**Decision.** `messageActionDataSchema` gains one optional field, `recipient` — a literal address the person building the flow types into the node:

1. **Resolution order at send time is: the node's `recipient`, then the record's contact field, then failure.** A node that names an address uses it; a node that does not keeps today's behaviour exactly, including today's structured `message_log` failure row.
2. **It is validated for the node's primary channel.** An email address for `email`; for `sms`/`whatsapp` the field is refused at publish time, because those channels' addressing is inseparable from the DLT/WABA sender registration that items 4/8 still gate, and a phone number typed into a builder would look like it unblocked something it did not.
3. **Flow linting refuses the gap rather than discovering it at 10:31.** A published email message node that has neither a `recipient` nor a record field that can supply one is a Publish-blocking lint error naming item 10, joining the unconnected-node and unapproved-template checks already in `validateGraph`.
4. **It does not widen scope and it is not a contact database.** The address is part of the graph, versioned with it in `agent_versions`, visible in the builder, and written to `message_log.recipient` like any other — it is one more piece of the flow its author can read, not a hidden routing rule.

**Reasoning.** This is the honest shape of what schools actually configure. "Email the principal when attendance drops below 60%" needs one address that belongs to the *flow*, not to the *record*, and no contact column discovered later would ever supply it. That the same field also unblocks parent-addressed flows for demonstration purposes is a consequence, not the motivation — and the resolution order makes the difference visible: the moment a real contact column exists, every node that left `recipient` empty starts using it with no edit and no migration.

**Alternatives considered.** (a) **A deployment-wide catch-all redirect** (every dev email to one inbox) — rejected: it makes `message_log.recipient` a lie in exactly the table docs/08 §7 relies on to prove who was informed and when, and it would have to be torn out rather than grown into the real thing. (b) **Invent a contact column in the extract** — rejected as the same fabrication docs/11 item 6 refuses; a column that is not there is not there. (c) **A separate `notify_address` action kind** — rejected: docs/07 §4 is explicit that one message node presents the school's channels, and a second node kind that also sends a message would be two send paths to keep guardrail-correct instead of one.

**Trade-offs.** An address typed into a flow is a maintenance liability in the ordinary way — a principal leaves, the node still names them — and nothing in this decision detects that. It is also per-flow rather than per-school, so a trust deploying one agent to forty schools with `recipient` set sends forty messages to one address; the builder states this where the field is entered. Both are accepted deliberately: the alternative to a stale address a reader can *see in the flow* is a stale address hidden in a table they cannot.

**Future impact.** When item 10 resolves, nothing built here is thrown away — the record's field simply starts winning for nodes that left `recipient` empty, and staff-addressed flows keep using it forever. A future per-school address book (a `school_contacts` table, or a resolved `{{principal.email}}` variable) becomes a third source slotted into the same ordered resolution, not a replacement for it.

**Status.** Accepted. Changes the agent graph schema, a contract under CODING_GUIDELINES §20 — `packages/agent-graph/src/types.ts` (`messageActionDataSchema`) and `validate.ts` in the same change set. Updates docs/07 §2/§4 and docs/11 §2 item 10 (narrowed, not closed: the schema gap stands; only the "an agent has no address at all" consequence is lifted).

---

## ADR-037 — Scheduled report delivery is server-owned; a schedule is persisted scope, re-validated at send time

**Context.** docs/06 §7 and docs/11 phase 4 both promise scheduled report emails, and the Schedule screen shipped as a browser-local draft: `apps/web/src/schedules.ts` keeps schedules in `localStorage`, states on screen that nothing is being sent, and says in its own module doc that "the moment `/api/schedules` exists, the functions below become its client". With ADR-035 supplying a transport and `services/pdf.ts` already rendering a branded PDF from a persisted spec (ADR-021), the only missing piece is the schedule itself. That piece raises a question the agents work already had to answer and this one inherits: **Invariant 2 says every query is constrained to the `school_ids` in the verified launch token, and a 07:30 delivery has no token.** The Schedule screen's current comment ("the delivery run will resolve scope from the owner's session at send time") describes something that cannot exist — there is no session at 07:30.

**Decision.** Schedules become a platform-owned resource, `report_schedules`, following the shape ADR-022/032 already established for unattended execution:

1. **Scope is captured, never accepted.** At create/edit time the requested `school_ids` are intersected server-side with the creator's verified token scope and persisted on the row, exactly as `agents.school_ids` and `report_definitions.school_scope` are. The client never supplies an authoritative school id (CODING_GUIDELINES §8).
2. **Scope is re-validated at send time, not trusted.** Every delivery re-intersects the persisted set against the org's currently servable schools (docs/02 §6) before reading anything, so a school that left the org, lost its module entitlement or fell out of the registry silently drops out of the next delivery rather than continuing to be reported on. A schedule whose scope re-validates to empty does not send; it records why.
3. **The creator's effective permissions are pinned on the row** — `created_role` and `created_perms`, snapshotted from the token at save time, mirroring `agent_versions.published_role`/`published_perms` and for the identical reason: an unattended run must never read with more authority than the person who asked for it held (docs/04 rail 6 masking, docs/08 §4.5).
4. **Delivery is a repeatable queue job, never a timer** (ADR-022's rule, CODING_GUIDELINES §5): BullMQ repeatable jobs keyed by schedule id on a `schedules` queue, synced on create/edit/pause/delete by the same producer pattern `syncAgentSchedule` already uses. The worker re-runs the report definition through the normal serving path, renders the PDF via `renderReportPdf`, and hands it to the ADR-035 transport.
5. **Every attempt is recorded** in `schedule_deliveries` — schedule, school set, status, provider reference, error — the same audit posture `message_log` has for agents, and for the same docs/08 §7 reason. It is a separate table rather than a reused one because `message_log` foreign-keys to `agent_runs`, and a scheduled report is not an agent run.
6. **"Send now" is a first-class action**, not a debug affordance: the same code path as a scheduled firing, triggered by the owner, so what a reader tests on Monday afternoon is what arrives on Tuesday morning.
7. **Email only, for now.** The screen's WhatsApp option stays visible and refuses per docs/10 §3 ("locked ≠ hidden"), because items 4/8 gate it and ADR-035 does not.

**Reasoning.** Point 2 is the whole decision. The alternative readings — re-deriving scope from the ERP at send time, or trusting the stored list — break Invariant 1 and Invariant 2 respectively. Capturing at save time and re-validating against the registry at send time is the only shape that keeps both, and it is not a new mechanism: it is exactly what ADR-032 does for a report definition's stored scope and what the trigger evaluator does for an agent's deploy scope, applied to a third unattended caller. A schedule is thereby a *request* with a pinned authority, re-checked every time it is honoured.

**Alternatives considered.** (a) **Keep schedules in `localStorage` and add a send-now button** — rejected: a schedule that only fires while the author's browser tab is open is not a schedule, and it would put report data on a delivery path with no persisted authority behind it. (b) **Re-resolve the owner's scope from the ERP at send time** — rejected outright: a runtime ERP call for authorization is the exact thing Invariant 1 and ADR-005 forbid. (c) **Reuse the agents queue and `message_log`** — rejected: it would force a scheduled delivery to fabricate an `agent_runs` row to satisfy a foreign key, corrupting the one table that answers "which agent messaged this parent". (d) **Store a rendered PDF with the schedule** — rejected: a delivery re-runs the definition against fresh data by definition (docs/06 §7), and a stored PDF is school data at rest with no TTL.

**Trade-offs.** A pinned `created_role`/`created_perms` goes stale: a schedule created by a director who later becomes a principal keeps delivering at the authority it was created with until it is edited or deleted. This is the same staleness `agent_versions` accepts, and the same answer applies — it is visible on the row, and re-saving re-pins it. Puppeteer in the delivery worker also means the orchestrator process now renders PDFs on a clock rather than only on a reader's click, so a large scheduled fan-out competes with interactive exports for the one browser instance; the per-schedule school cap and the existing single-browser-many-pages model are what hold that, and it is a scaling question to revisit before fleet scale, not a correctness one.

**Future impact.** A second delivery channel is a branch at the transport call, not a new pipeline. Digest-style delivery (several reports in one email) is a schedule holding several report ids and one render loop. Per-recipient scope narrowing — "send the Noida principal only Noida" — is a change to how the persisted set is split before rendering, with the re-validation step unchanged.

**Status.** Accepted. Depends on ADR-035 for the transport; follows ADR-022 (persisted state, queue jobs not timers), ADR-032 (stored scope intersected at execution) and ADR-021 (PDF from the persisted spec). Updates docs/06 §7 and docs/10 §2 (the Schedule screen is no longer a local draft). New migration `db/platform/migrations/0010_report_schedules.sql`.

---

## Amendment process

1. New decision or change → new ADR entry (next ID), `Status: Proposed`, linking any ADR it supersedes.
2. Review against the six invariants in `CLAUDE.md`; touching an invariant requires explicit sign-off.
3. On acceptance: mark superseded ADRs `Superseded by ADR-0XX` (never delete or rewrite them), update the affected `docs/` files, then implement.