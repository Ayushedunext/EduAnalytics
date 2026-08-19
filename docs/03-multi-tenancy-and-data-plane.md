# 03 — Multi-Tenancy & the Data Plane

## 1. The problem shape

1,500+ schools, each with its **own MySQL database** on AWS, consolidated many-databases-per-RDS-instance (working estimate ~30 instances). One platform must serve all of them, per-request, with strict isolation, without holding 1,500 open connection pools, and without ever touching an ERP primary.

## 2. Tenant resolution — the registry is the configuration

The MCP server (and the agent runtime) is **stateless about tenants**. Every data operation carries a `tenant_id` (school_id) injected by the orchestrator from the session — never by the AI model. Resolution per call:

```
tool call (school_id, …)
  → Tenant Registry lookup            (in-memory cache, TTL ~5 min)
  → AWS Secrets Manager fetch by ARN  (cache, TTL ~10 min)
  → getPool(school_id)                (lazy LRU pool, below)
  → execute on the school's REPLICA
```

**Why credentials live in Secrets Manager, not the registry:** the registry is a frequently-read topology table; secrets belong in a purpose-built store with IAM-scoped access, rotation, and audit. The registry stores only the ARN pointer.

**Why per-school read-only users (`analytics_ro`):** blast-radius. Even a validation bypass cannot write, and grants can be revoked per school instantly. SELECT-only is additionally enforced by SQL AST validation in the MCP layer (doc 04) — two independent layers.

## 3. Connection pooling at 1,500-school scale

Holding a pool per school is the trap (memory + connection exhaustion). Most schools are idle at any instant, so:

- **Lazy creation:** a pool exists only after a school's first query.
- **Small pools:** `connectionLimit: 3` per school suffices (queries are short, capped, and cached upstream).
- **LRU eviction:** cap ~200 live pools per MCP instance; least-recently-used pools are closed on pressure; a background sweep closes pools idle > 10 min.
- **Cost of a cold pool:** ~100–300 ms once per idle-period per school — invisible against cache-miss latencies.

Capacity math: 200 pools × 3 connections = 600 max connections per instance; real usage far lower. **RDS Proxy** (or Aurora's connection management) in front of dense instances is the recommended hardening: multiplexing, failover survival, and optionally IAM auth tokens that eliminate stored passwords entirely.

## 4. The data plane (three stores, strict order)

```
Query path (predefined/custom reports) — exactly three result-serving tiers:
  ① Redis result cache      key = report + level + drill-context + filters
                                  + school-set + permission_class
  ② Rollup Store            cross-school aggregates, drill L1/L2
  ③ Read replica            raw SELECT (single school) or fan-out (multi)
Never: ERP primary.
```

The schema and dimension caches (§5) are **not** tiers in this order — they serve schema metadata for AI SQL generation and never answer a report query (ADR-028).

**Why `permission_class` is in the key (ADR-028):** PII masking is applied per session role (doc 04 §3 rail 6) and drill leaves are gated on student-data rights (doc 08 §4.5). A key without a permission component lets two users of the same school with different `perms[]` collide — a Principal warming the cache would serve unmasked rows to a class teacher on an identical key. `permission_class` is a deterministic digest of the caller's effective data visibility, so callers who may see different data can never share an entry. It must be derived deterministically or entries fragment silently.

### 4.1 Read replicas — the zero-load mechanism

Replicas are **per RDS instance, not per database**: ~30 replicas cover all 1,500 school DBs. Replica queries consume no primary CPU/IO beyond replication itself (storage/binlog level; on Aurora, existing readers make this near-free). All raw SQL — human, AI-generated, agent triggers, drill leaves — lands here.

*Why this is the guarantee, not a convention:* the registry's `replica_host` is the only host the platform knows for a school; primaries are simply not addressable from platform code.

### 4.2 Rollup Store — cross-school speed

A small platform DB (Aurora MySQL or ClickHouse) of **pre-aggregated per-school daily metrics**:

```
rollup_daily(school_id, date, metric, dims_json, value)
  e.g. ('sunrise-delhi','2026-08-11','student_strength','{"gender":"F"}',612)
       ('sunrise-noida','2026-08-11','attendance_pct','{"who":"teacher"}',96.2)
```

- Filled by **incremental ETL** reading replicas in small batches (15–30 min for attendance/fees; nightly for slow metrics).
- Serves Director dashboards and ~90% of cross-school AI questions with one indexed query — **100–500 ms whether 3 schools or 300**.
- Extended dims for drill-down: class and fee_type aggregates, so drill L1/L2 answer from rollups (doc 06).
- **Aggregates only, no student PII** — this is a privacy decision as much as a performance one: Director-level cross-school views never move row-level personal data out of school DBs.

### 4.3 Fan-out — fresh row-level detail across schools

`run_multi(school_ids[], sql)` executes the same SELECT on each school's replica **in parallel** (concurrency-capped ~10), tags rows with `school_id`, merges. Latency ≈ slowest single school (~1–2 s). Caps: ≤25 schools per fan-out (beyond, the agent answers from rollups or asks to narrow). Partial failures degrade gracefully: results return annotated ("Noida temporarily unreachable") instead of failing the whole report.

## 5. Schema versioning — the 1,500-DB shortcut

All schools run the vendor's ERP schema in **3–5 live versions**, so schema metadata is cached **per `schema_version`, not per school**: `get_schema` returns one of ~5 cached documents instead of introspecting 1,500 DBs. This also makes Anthropic **prompt caching** highly effective (thousands of schools share an identical schema prompt — doc 05). Only `get_dimensions` (class names, fee heads, academic years) is per-school, cached daily.

## 6. Isolation & fairness

- Per-tenant guardrails: 10 s query timeout, 5,000-row cap, per-tenant rate limits.
- **Circuit breaker per school DB:** a down/slow school fails fast for 60 s instead of letting stuck connections drain shared instances.
- Optional consistent-hash routing (tenant → MCP instance) improves pool and cache locality.
- Multi-region: one platform deployment per region, routed by the registry's `region` column (cross-region DB queries are avoided for latency and cost).

## 7. Assumptions

1. ~30 RDS instances host the 1,500 DBs (confirmation owed — doc 11). If schools are more fragmented, replica consolidation precedes GA.
2. Replication lag on the replicas is seconds-level; dashboards labeled "as of" tolerate it. Nothing in the product promises transactional freshness.
3. The rollup ETL's 15–30 min window is acceptable staleness for cross-school aggregates (live row-level questions use fan-out instead).

## 8. Extensibility

- New metric in rollups = new ETL mapping + a row `metric` value; no schema change (`dims_json` is generic).
- The registry can carry additional per-tenant capabilities (feature flags, data-residency class) without touching services.
- IAM-token DB auth (via RDS Proxy) can replace stored passwords school-by-school; the resolution path already isolates credential acquisition in one function.
