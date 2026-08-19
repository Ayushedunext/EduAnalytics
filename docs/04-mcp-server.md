# 04 — MCP Server

## 1. Role

The MCP server is the **only path to school data** in the entire platform. Everything that reads a school database — predefined dashboards, AI-generated SQL, custom reports, drill levels, agent trigger evaluation — goes through its tools. It is stateless, read-only, deployed on the private network only (never internet-exposed), and enforces tenant scope **independently** of the orchestrator.

*Why a dedicated MCP layer instead of a DB library in the orchestrator:* (a) it is the model-facing tool surface — Claude plans against these tools, so their contracts are the AI's entire world; (b) a separate process with its own hard rules means orchestrator bugs cannot become data leaks; (c) the same server can serve other MCP clients (e.g., Claude Desktop for internal analysts) without new data-access code.

## 2. Tool surface (v2, final)

| Tool | Contract | Serving layer |
|---|---|---|
| `get_schema(schema_version)` | Returns tables/columns/relationships for a schema version. Cached per version (3–5 docs total), refreshed daily. | cache |
| `get_dimensions(school_id)` | Valid classes, sections, academic years, fee heads, exam terms for one school — so the AI never guesses filter values. Cached per school, daily TTL. | cache → replica |
| `run_query(school_id, sql)` | Single-school SELECT. AST-validated, row-capped (5,000), time-capped (10 s). | replica |
| `run_multi(school_ids[], sql, merge)` | Parallel fan-out of one SELECT across replicas; rows tagged with school_id; merged/aggregated. ≤25 schools; partial-failure annotated. | replicas |
| `run_rollup(metric, school_ids[], dims, range)` | Cross-school aggregates from the Rollup Store; ms-fast. | rollup store |
| `run_predefined(report_id, school_ids[], params)` | Vetted parameterized SQL for the predefined catalog. | rollup/replica per report def |

## 3. Safety rails (each independent; all always on)

1. **Read-only DB users** (`analytics_ro`, SELECT grants only) — enforced by MySQL itself.
2. **SQL AST validation** — anything non-SELECT is rejected before execution (second layer over #1). Multi-statement payloads rejected.
3. **Scope double-check** — the orchestrator passes the session's allowed school set **out-of-band** with every call; any `school_id` argument outside it is a hard error, logged. The AI model never supplies tenant identifiers; they are not part of model-generated content.
4. **Resource caps** — 5,000-row limit, 10 s timeout (`max_execution_time` hint + driver timeout), per-tenant rate limit.
5. **Circuit breaker per school DB** — fail fast for 60 s on a down/slow school.
6. **PII masking rules** — column-level masking (phone/email) applied unless the session role permits; drill leaf policies (doc 06) build on this.
7. **Query logging per tenant** — every executed statement recorded with school_id, caller, rows returned (audit chain — doc 08).

*Why belt-and-braces (1+2, orchestrator+MCP scope):* the threat model includes AI-generated SQL under adversarial prompting and ordinary engineering mistakes. No single check is trusted alone.

## 4. Connection & tenancy model

Per-call resolution: registry (cached) → Secrets Manager (cached) → lazy LRU pool → replica. Full mechanics in doc 03 §2–3. The MCP server holds no per-tenant configuration of its own; **the registry is the configuration**, which is what makes onboarding a school a data change, not a deployment.

## 5. Drill-down endpoint relationship

Drill levels are ordinary parameterized queries: the orchestrator's `POST /api/report/{id}/drill {level, context[]}` resolves to `run_rollup` (L1/L2) or `run_query`/`run_multi` (L3 leaves), with drill-context values **bound as parameters** — a click can only narrow a query (doc 06 §4).

## 6. Deployment

- 2–4 stateless instances behind an internal ALB, same VPC as replicas; replica security groups admit only the MCP server's SG.
- Optional consistent-hash routing by tenant for pool/cache locality.
- One deployment per AWS region where school DBs exist (registry `region` column routes).

## 7. Assumptions

1. Streamable HTTP transport between orchestrator and MCP server on the private network.
2. The AST validator covers the MySQL dialect in use across all supported `schema_version`s.

**No longer an assumption — a rule.** Agent trigger evaluation (doc 07) reads school data through **this tool surface only**; there is no second data path and no "MCP-style" parallel layer (ADR-006, confirmed as a decision). Note the scope of the rule: it governs *school-data reads*. An agent's IMAP polling and its ERP-webhook receiver are ingestion, not school-data reads, and correctly sit outside the MCP surface.

## 8. Extensibility

- New tool additions must preserve invariants: scope out-of-band, SELECT-only, capped. A future `run_export(report_id)` for bulk CSV would follow the same contract with a streaming row cap.
- If a non-vendor schema ever onboards, `get_schema` gains a new `schema_version` — no tool-shape change.
