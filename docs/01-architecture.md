# 01 — System Architecture

## 1. Layered view

```
┌───────────────────────────── EXISTING ERP ──────────────────────────────┐
│ School login → session → menu item "📊 Analytics"                       │
│ ① Signs launch token (user, role, org_id, school_ids[], perms, nonce)  │
│ ② Master config (school ↔ DB mapping, org hierarchy) ──background sync──┼──┐
└──────────────────────────────────┬──────────────────────────────────────┘  │
                                   ▼ redirect / iframe                       │
┌────────────────────────── ANALYTICS PLATFORM ───────────────────────────┐  │
│  REACT SPA                                                              │  │
│   school picker (multi-select) · dashboard gallery · Ask-AI chat +      │  │
│   artifact canvas · report editor · agent builder · PDF/My Reports      │  │
│        │ REST + WebSocket (streaming)                                   │  │
│  ORCHESTRATOR (Node.js) — token verify · scope enforcement              │  │
│   ┌──────────────┬───────────────┬──────────────┬───────────┬────────┐  │  │
│   │ Dashboard    │ AI Agent      │ Fan-out      │ Key Vault │ PDF    │  │  │
│   │ Service      │ Service       │ Engine       │ (BYOK)    │ Render │  │  │
│   │ (Redis-      │ (Claude API,  │ (run_multi   │ AES-256 + │ (Puppe-│  │  │
│   │  cached)     │  chart-spec)  │  parallel)   │ KMS       │  teer) │  │  │
│   └──────────────┴───────┬───────┴──────────────┴───────────┴────────┘  │  │
│                          │ MCP client (private network)                 │  │
│  MCP SERVER (stateless · read-only)                                     │  │
│   get_schema · get_dimensions · run_query · run_multi · run_rollup ·    │  │
│   run_predefined                                                        │  │
│        │                                                                │  │
│  DATA PLANE — ERP primaries are NEVER touched                           │  │
│   ① Redis result cache   ② READ REPLICAS of school RDS instances        │  │
│   ③ Rollup Store (pre-aggregated per-school metrics, no PII)            │  │
│                                                                         │  │
│  WORKFLOW AGENT RUNTIME (shares the data plane; see doc 07)             │  │
│   Scheduler → Trigger Evaluator → Run Orchestrator (queue) → Action     │  │
│   Workers (WhatsApp/SMS/Email/ERP-notify/AI-compose)                    │  │
│                                                                         │  │
│  TENANT REGISTRY  ◄──────────────── 15-min sync + create/update webhook ┘  │
│   school_id → org_id, replica host, db, secret ARN, schema_version         │
└─────────────────────────────────────────────────────────────────────────┘
```

## 2. The two golden rules (and why)

**Rule 1 — Zero ERP load.** The platform never queries an ERP primary and never calls ERP services at query time.
*Why:* 1,500 schools' daily operations run on those primaries; any coupling means an analytics bug or a heavy AI-generated query could take fee counters offline. Read replicas isolate load at the storage/binlog level; the config sync removes the runtime API dependency (an ERP outage does not take analytics down, and an analytics surge cannot slow the ERP). The ERP's total runtime cost is signing one JWT (~1 ms) per session.

**Rule 2 — Scope is law.** Every data access is constrained to the `school_ids` inside the verified launch token, enforced twice: at the orchestrator (business logic) and again inside the MCP layer (defense in depth).
*Why:* the AI generates SQL; prompts can be adversarial; UI code can have bugs. Double enforcement means no single compromised layer can cross tenant boundaries. The model is structurally unable to pick tenants because tenant identity travels out-of-band with the tool call, never inside model-generated content.

## 3. Component responsibilities (one-line contracts)

| Component | Owns | Must never |
|---|---|---|
| React SPA | Rendering chart-specs, picker state, builder/editor UX | Hold DB credentials, API keys, or widen scope |
| Orchestrator | Session issuance, scope checks, service routing, caching, BYOK key resolution, PDF | Reach a school DB directly (always via MCP) |
| MCP server | The only path to school data; SELECT-only validation; per-tenant connections; second scope check | Accept a school_id not present in the out-of-band allowed set |
| Tenant Registry | Topology (school → replica/db/secret/schema_version/org) | Store credentials (Secrets Manager only) |
| Rollup Store | Pre-aggregated metrics for cross-school + drill L1/L2 | Contain row-level student PII |
| Key Vault | Org BYOK keys, encrypted at rest, decrypted in memory at call time | Log keys or return them to any client |
| Agent Runtime | Scheduling, trigger evaluation, run state machines, message dispatch | Write to school DBs; message outside guardrails |
| PDF Renderer | Print-route rendering of the same chart-specs, logic appendix | Re-query data differently from the on-screen view |

## 4. Why an orchestrator between SPA and MCP

The browser must never hold DB credentials or Anthropic keys. Centralizing tenant resolution, key resolution, caching, and scope checks in one service also gives a single audit chokepoint: every data access and every AI call passes through code we control and log. The MCP server stays stateless and dumb-but-strict, which is what makes it safely horizontal.

## 5. Statelessness & horizontal scale

- MCP server: fully stateless per request (tenant resolved per call from registry + secrets caches) → 2–4 instances behind an internal ALB in the same VPC as the replicas; optional consistent-hash routing by tenant for pool/cache reuse.
- Orchestrator: session in signed cookie/JWT; result caching in Redis → horizontally scalable.
- Agent runtime: runs are persisted state machines; waits are delayed queue jobs → engine restarts lose nothing.

## 6. Assumptions

1. School DBs are consolidated many-per-RDS-instance (working estimate ~30 instances for 1,500 DBs). Replica economics in doc 09 depend on this; the ERP team owes confirmation (doc 11).
2. The ERP can emit create/update webhooks for schools (or accept a small patch to do so); the 15-min sync alone is an acceptable fallback.
3. All schools run the platform vendor's ERP schema, in 3–5 concurrently-live schema versions (drives schema caching and prompt caching, docs 03/05).

## 7. Extensibility notes

- The chart-spec contract is the seam for future surfaces (mobile app, scheduled email digests) — anything that can render the spec gets every report type for free, including drill-down (`drillable` flag).
- The registry's `schema_version` field is the hook for gradual ERP schema migrations: a school flips versions in one row; schema/prompt caches key on it.
- The agent runtime's action-worker interface is the hook for new channels (e.g., voice calls, parent-app push) without touching flow semantics.
