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
| ADR-012 | Redis result caching as tier 1 of a strict cache order | Accepted |
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
**Status.** Accepted.

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
**Status.** Accepted.

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
**Status.** Accepted.

## ADR-021 — PDF rendering server-side from the persisted spec

**Context.** Every report must export as a branded, print-perfect PDF that matches the screen — including drilled views.
**Decision.** Puppeteer renders a print-optimized route fed by the same persisted chart-spec/report definition (never a re-query through a different path): school/trust branding, scope line, timestamps, page numbers; optional logic appendix; drill exports as current-view (breadcrumb in header) or full pack of visited levels. Exports logged in Export History. A client-side quick-export may exist for casual use; official documents use the server path.
**Reasoning.** Same-spec rendering guarantees screen/PDF parity; server-side gives pixel-perfect, brandable output and an auditable export event.
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
**Status.** Accepted.

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

---

## Amendment process

1. New decision or change → new ADR entry (next ID), `Status: Proposed`, linking any ADR it supersedes.
2. Review against the six invariants in `CLAUDE.md`; touching an invariant requires explicit sign-off.
3. On acceptance: mark superseded ADRs `Superseded by ADR-0XX` (never delete or rewrite them), update the affected `docs/` files, then implement.