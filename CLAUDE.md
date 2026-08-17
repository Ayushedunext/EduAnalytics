# CLAUDE.md — Project Orientation

## What this project is

**School Analytics Platform** — an AI-powered analytics and automation module embedded inside an existing school ERP (hereafter *the ERP*), serving **1,500+ schools**, each with its own MySQL database on AWS. It provides:

1. **~15 predefined dashboards** served from cached, vetted SQL (zero AI cost).
2. **Ask AI** — natural-language questions answered as live report *artifacts* (chart + table + narrative) via Claude + an MCP server.
3. **Multi-school analytics** for trusts/directors (combined views across any subset of their schools).
4. **Custom reports** — any report can be cloned, renamed, edited; report logic (definition + SQL) is always visible.
5. **Drill-down reports** — up to 3 clickable levels (High → Mid → Low).
6. **Workflow Agents** — school-built no-code automations (triggers → if/else flows → WhatsApp/SMS/Email actions).
7. **Branded PDF export** for every report.

## Non-negotiable invariants (violating any of these is a design regression)

1. **Zero ERP load.** Analytics/agents NEVER query an ERP primary database and NEVER call ERP services at query time. All reads go to read replicas, the rollup store, or cache. The ERP's only runtime involvement is signing one launch JWT per session.
2. **Scope is law.** Every query is constrained to the `school_ids` in the verified launch token. Enforced at the orchestrator AND independently at the MCP layer. The AI model never supplies tenant/school identifiers.
3. **Read-only data plane.** All school-data access is SELECT-only (AST-validated), through read-only DB users, with row/time caps. Agents and reports write nothing to school databases.
4. **Spec-driven rendering.** The AI outputs structured **chart-spec JSON**, never renderable code. The frontend renders specs; the PDF renderer reads the same specs.
5. **BYOK gating.** AI features run on the organization's own Anthropic API key. `ai_status != active` → all `/api/ai/*` endpoints return 403; UI locks are cosmetic on top of that server-side check.
6. **Logic transparency.** Every report exposes its definition and generated SQL (view mode, edit mode, PDF appendix). No black boxes.

## Document map (read in this order for full context)

| Doc | Covers |
|---|---|
| `docs/00-overview.md` | Product summary, actors, glossary — **terminology source of truth** |
| `docs/01-architecture.md` | Layered system architecture, golden rules, component responsibilities |
| `docs/02-erp-integration-auth.md` | SSO launch flow, launch token, registry sync, embedding modes |
| `docs/03-multi-tenancy-and-data-plane.md` | Tenant registry, secrets, connection pooling, replicas, rollup store, schema versioning |
| `docs/04-mcp-server.md` | MCP tool surface, safety rails, scope double-enforcement |
| `docs/05-ai-report-engine.md` | Agent service, chart-spec contract, model strategy, BYOK key vault & gating state machine |
| `docs/06-reporting-system.md` | Predefined catalog, clone-to-edit model, logic panel, drill-down (3 levels), PDF |
| `docs/07-workflow-agents.md` | Agent = Trigger + Flow + Schedule; execution engine; channels & Template Manager; guardrails |
| `docs/08-security-model.md` | Token, double scope check, PII policy, key vault, audit, blast-radius limits |
| `docs/09-performance-and-scale.md` | Zero-ERP-load mechanics, latency budgets, caching tiers, load-test gates |
| `docs/10-ui-ux-design-system.md` | Screen inventory, design tokens, UX conventions, locked/empty states |
| `docs/11-roadmap-and-open-items.md` | Phased delivery, assumptions register, inputs owed by the ERP team |

## Ground rules for engineers (and Claude Code) working in this repo

- These docs are the **single source of truth**; they document decisions already made. Do not invent alternative architectures in code. If a doc and code disagree, the doc wins until the doc is amended.
- Keep terminology consistent with the glossary in `docs/00-overview.md` (e.g., *org* vs *school* vs *tenant* have precise meanings).
- Any change touching the six invariants above requires an explicit doc amendment first.
- Reference implementations of the UX exist as a clickable HTML prototype and a 19-slide architecture deck (see `docs/11`, Artifacts section); they are design references, not production code.
