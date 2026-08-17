# 09 — Performance & Scale

## 1. The two promises

1. **Zero load on the ERP** — analytics and agents are provably incapable of consuming ERP-primary resources.
2. **Every answer in ms to 10 s** — hard latency budget below; the LLM is the only component allowed to cost seconds.

## 2. Why the ERP feels nothing (mechanics, not policy)

| Concern | Mechanism |
|---|---|
| Query load on ERP DBs | All SQL runs on **read replicas**; replication is storage/binlog-level, so replica load never becomes primary CPU. The registry stores replica hosts only — primaries are unaddressable from platform code. |
| Replica cost at 1,500 DBs | Replicas are per **RDS instance**, not per database: ~1,500 schools consolidated on ~30 instances ≈ 30 replicas. On Aurora, existing readers ≈ near-zero marginal cost. |
| ERP app-server load | The platform runs on its own EC2/ECS; the ERP's per-session work is signing one JWT (~1 ms). |
| ERP API/network load | No runtime calls; config arrives via the 15-min background sync + webhooks (the sync itself reads an ERP replica). |
| A "bad" AI or hand-written query | Contained to a replica by 10 s timeout, 5,000-row cap, per-tenant rate limit, circuit breaker. |
| Agent trigger load | Trigger evaluation queries the replicas on ticks with the same caps; action work happens in the platform's own queue/workers. |

## 3. Latency budget (user-experienced targets)

| Path | Serving layer | Target |
|---|---|---|
| Predefined dashboard · cache hit | Redis | **50–200 ms** |
| Predefined dashboard · cache miss | Replica → cache fill | 0.5–2 s |
| Director cross-school view | Rollup Store (+cache) | **100–500 ms** |
| Drill L1/L2 | Rollup Store | 100–400 ms |
| Drill L3 leaf | Rollup or capped replica | 300 ms–1.5 s |
| AI query · single school | Claude + replica | **3–8 s** |
| AI query · cross-school (rollup-answered) | Claude + rollups | 3–8 s |
| AI query · fan-out ≤10 schools (row-level) | Claude + parallel replicas | 5–10 s |
| PDF export | Puppeteer on persisted spec | 2–4 s |

## 4. Caching tiers (strict order)

```
① Redis result cache   key = report + level + drill-context + filters + school-set
                        TTL 5–15 min · serves repeats in ms
② Rollup Store          pre-computed answers for ~90% of Director questions
                        and drill L1/L2 (ETL every 15–30 min from replicas)
③ Schema/dimension cache  per schema_version (3–5 docs total) / per school daily
④ Replica               the only place raw SQL ever runs
```

## 5. Keeping the AI at the low end of 3–10 s

- **Anthropic prompt caching** on the schema block — 1,500 schools share 3–5 schema versions, so hit rates are structurally very high (the single biggest cost/latency lever).
- **Haiku-first, Sonnet escalation.**
- **Streaming:** first widgets visible ~2 s; perceived latency ≪ end-to-end.
- Pre-warmed replica connections (LRU pools, doc 03) remove cold-connect from the hot path.

## 6. Drill-specific polish

Cache keys include level + drill context; optional **idle prefetch of Level 2 for the top-3 bars** after Level 1 renders — most first clicks then feel instant. Fan-out at drill leaves obeys the same ≤25-school cap and partial-failure annotation.

## 7. Scale ceilings & horizontal knobs

- MCP: stateless; add instances behind the internal ALB; consistent-hash by tenant improves pool/cache locality; ~200 LRU pools × 3 connections per instance is the per-instance envelope.
- Orchestrator: stateless with Redis; scale on CPU.
- Rollup Store: single Aurora/ClickHouse comfortably serves aggregate queries at this cardinality (1,500 schools × daily metrics is small data).
- Agent runtime: queue-backed; workers scale on queue depth; runs are persisted state machines so scaling events lose nothing.
- Regions: one platform deployment per AWS region of school DBs; registry routes.

## 8. Load-test gate before GA (acceptance criteria)

- 200 concurrent schools active;
- p95 dashboard < 2 s (cold), cache-hit p95 < 300 ms;
- p95 AI < 10 s;
- **measured ERP primary CPU delta = 0** during the test;
- agent tick storm (all agents on the same minute) drains within the tick interval with zero duplicate messages (dedup verified).

## 9. Assumptions

1. ~30-instance consolidation (owed confirmation — doc 11); more fragmentation means a replica-consolidation workstream before GA.
2. Seconds-level replica lag and 15–30 min rollup staleness are acceptable per product framing ("as of" labels).
3. Cost figures for AI usage are estimates at design time; the usage meter is the source of truth in production.
