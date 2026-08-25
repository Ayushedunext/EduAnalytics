# 05 — AI Report Engine (Ask AI), Chart-Spec Contract, BYOK & Gating

## 1. The core philosophy: spec-driven rendering

The AI **never produces renderable code**. It produces **chart-spec JSON** — a structured description of widgets — which the frontend renders with the platform's own chart layer, and which the PDF renderer reads identically.

```json
{
  "title": "Fee Defaulters — Class 9 & 10",
  "narrative": "47 defaulters with ₹4.2L pending; 10-A carries the largest dues…",
  "widgets": [
    { "type": "kpi",   "label": "Total pending", "value": "₹4.2L" },
    { "type": "bar",   "x": "section", "y": "pending", "data": [...], "drillable": false },
    { "type": "table", "columns": [...], "rows": [...] }
  ]
}
```

**Why:** safety (no AI-authored code executes in the client), speed (rendering is native, streaming widgets appear progressively), brand consistency (one visual language across predefined, custom and AI reports), reproducibility (a saved spec re-runs with fresh data), and portability (PDF/mobile/email render the same spec). The `drillable` flag is the future hook for AI artifacts to adopt drill-down using the hierarchy catalog — a config change, not a rebuild (doc 06 §7).

### 1.1 Spec hydration — the model never sees or emits a row (ADR-030)

The example above is the fully **hydrated** spec — what the client and the PDF renderer actually draw. What the model itself emits is a **draft**: the same widget vocabulary, but a data-bound widget (`bar`/`line`/`donut`/`table`) names a `query_ref` — the `query_key` of a `run_query`/`run_multi` call already made in this conversation — instead of carrying `data`/`rows`. The one exception is `kpi`, whose `value` the model writes directly, from a single safe aggregate scalar it was shown (never from row-level results — see below). `@sap/chart-spec`'s `ChartSpecDraft`/`widgetDraftSchema` are the enforced shape of this; `assertNoInlineData` rejects a `data`/`rows` key on a draft outright as defence in depth.

The AI Agent Service hydrates each `query_ref` into its real rows in one step, the same step that applies row-level masking (docs/04 §3 rail 6), before anything reaches the client or the PDF renderer. A widget whose `query_ref` does not match a query actually run is `INVALID_CHART_SPEC`, and the model gets one retry with the reason.

**The privacy property does not come from the draft schema alone.** `run_query`/`run_multi` return real rows over MCP, and forwarding those rows into the model's own conversation context would defeat ADR-030 no matter what the model is later asked to emit. So the orchestrator never relays row *contents* back to the model for these two tools — only `{ query_ref, row_count, columns, truncated }`, with the full result cached server-side for hydration. The one exception is a result of exactly one row where no column is tagged `pii` in the schema catalog (the same tagging that already drives masking) — that single safe aggregate's value is included, which is what lets the model write a truthful `kpi` value.

This closes both problems the naive "model emits its own data" design has under BYOK (AUDIT_REPORT C15): student-level PII never transits the provider account under any billing mode, and a widget carries however many rows the query returned regardless of any model-context or token budget, so ADR-008's 5,000-row cap stays meaningful for the AI path exactly as it is for every other path.

One consequence for the narrative text: it is written from aggregates the orchestrator can safely hand back (counts, sums, min/max), not from inspecting individual rows, since the model never has them.

## 2. Query lifecycle

```
user question (POST /api/ai/ask, chunked NDJSON response)
  → AI Agent Service builds context:
      schema doc (per schema_version, prompt-cached) ·
      dimension values (per school) ·
      selected school set + names ·
      output contract (chart-spec draft)
  → Claude plans → MCP tools:
      get_dimensions → generate SQL → run_query / run_multi / run_rollup
  → Claude emits a chart-spec DRAFT (§1.1) — never data
  → orchestrator hydrates it server-side and streams status/result events
    down the same response; widgets render as soon as the hydrated spec lands
  → follow-ups continue the conversation with full context (Refine,
    suggestion chips); "Ask AI about this data" from a dashboard, and
    "Ask AI about this slice" from a drill view, pre-load context.
```

**Transport, corrected 2026-08-25.** This was originally specified as a WebSocket. No WebSocket or SSE infrastructure exists anywhere in this codebase, and `EventSource` cannot carry the POST body a question needs, so the built transport is a plain chunked HTTP response on `POST /api/ai/ask`: the server writes one newline-delimited JSON event per status step and a final `result`/`error`, which avoids a new dependency entirely. This is unrelated to ADR-017's separate mention of pushing `ai_status` changes to every logged-in user over a WebSocket — that cross-user live-status push is still unbuilt and remains a WebSocket question for whenever it is built; it does not touch this chat stream, which is a private response to the one request that opened it.

Tool-choice rule taught in the system prompt: **aggregate metric → `run_rollup` · fresh row-level detail → `run_multi` · single school → `run_query`.** "By school" is just a chart dimension, not a special report type. `run_rollup` needs the Rollup Store (Phase 2, not yet built — CODING_GUIDELINES §23); until then Ask AI's tool set is `get_dimensions`/`run_query`/`run_multi` plus the closing `emit_report` call, which covers exactly the single-school and fan-out cases the rule above already names.

Streaming status steps in the chat ("Confirming scope → Reading schema → Running query → Building chart") are a deliberate trust device: users see the scope confirmation and the data path before results land.

## 3. Model strategy & latency

- **Haiku-first with Sonnet escalation** (org-selectable default) — most school questions are simple SQL planning; escalate for complex multi-step analysis.
- **Prompt caching** on the schema block: 1,500 schools share 3–5 schema versions, so cache hit rates are very high; this is the single biggest AI cost/latency lever.
- Streaming keeps perceived latency at ~2 s to first widget; end-to-end AI budget 3–10 s (doc 09 table).
- Guardrails in-conversation: ambiguous question → one clarifying chip-question; role-restricted data → polite policy message; oversized result → auto-aggregate and retry once.

## 4. BYOK — the billing and trust model

**Decision:** AI usage bills to the **organization's own Anthropic account** (org creates a Console account, adds billing, generates an API key). One org key covers all its schools. The platform carries zero AI cost. A **hybrid mode** exists: `billing_mode = 'platform' | 'byok'` — small schools may run on the platform key bundled into ERP pricing; the gating logic is identical, only the vault entry differs.

*Why org-level, not school-level:* trusts administer centrally; one key, one billing relationship, per-school usage metering on top (below).

### 4.1 Key Vault

```
tenant_ai_config(org_id, encrypted_api_key, model, billing_mode,
                 monthly_query_cap, ai_status, last_validated_at)
```
- AES-256 at rest; master key in KMS/Vault; decrypted only in memory at call time; never logged; UI shows only a masked form (`sk-ant-…****1G4a`).
- Validation on save: a 1-token live test call to the Messages API; only success activates.

### 4.2 Gating state machine (`ai_status`)

```
not_configured ──save key──► pending_validation ──test ok──► active
      ▲                                             │
      └────────────── admin disables ◄──────────────┤
                                                    ▼ 401 invalid key /
                        error  ◄───── credit exhausted / revoked
                        (chat auto-relocks; dashboards unaffected)
```

**Enforcement is server-side:** every `/api/ai/*` request re-checks `ai_status == active` (and the monthly query cap). UI locks — the 🔒 badge on Ask AI, the disabled home ask-bar, the locked-state card — are cosmetic on top of a real 403. Status changes broadcast over WebSocket so locks appear/vanish for all logged-in users of the org without re-login.

*Why visible-but-locked instead of hidden:* admins discover what they're missing; the locked card carries the setup CTA. Predefined dashboards work from day one regardless — the product is never bricked by AI setup.

### 4.3 Usage transparency & cost posture

Every API response's `usage` object is logged per school; Settings shows queries/tokens/estimated cost per school per month, plus an org-set monthly query cap. Cost order of magnitude at design time: a typical question ≈ single-digit rupees on Sonnet, far less on Haiku with prompt caching; treat all absolute prices as estimates to re-verify at implementation.

### 4.4 AI features gated by the same key

Ask-AI chat and artifact canvas; "Modify with AI" in the report editor; "Describe your workflow" flow-drafting and the AI-compose node in workflow agents. All check the same `ai_status`; everything else in the product functions fully without a key.

## 5. Setup UX (admin-only, org-level)

*"Admin" means the `ADMIN` role, decided 2026-08-20.* The launch token carries one of DIRECTOR · PRINCIPAL · TEACHER · ACCOUNTANT · ADMIN, and only `ADMIN` may save, replace or disable the key. The narrower reading is deliberate: the key is a **billable credential for the whole org**, so "who may spend the trust's money with a provider" is a smaller question than "who may read the trust's numbers" — a Director sees every school's data and still cannot connect a key. Everyone else is shown *"Contact your admin for key configuration."* and receives the same sentence as a 403 if they call the endpoint directly; the screen is the polite half of a rule enforced in the service layer (`services/ai-config.ts`), never a client-side role check.

*Key handling on the screen (2026-08-20).* The key field is a password input, so the value is never legible even to the person pasting it; it is held in component state for one submit and cleared on every outcome. After save the API returns `key_hint` (`sk-ant-…1G4a`) and **no endpoint returns the key to any caller at any role** — which is what makes docs/08 §6's "platform operators cannot read tenant keys in plaintext" true of the API surface and not only of the database. "Open Anthropic Console" opens in a new tab with `rel="noopener"`.

A 3-step wizard: ① create the Anthropic Console account (guided, with an illustrated PDF guide; billing added by the org) → ② paste key, choose model (Economical–Haiku / Best–Sonnet), optional monthly cap → **Test & Save** → ③ verification result; on success "AI Reports UNLOCKED for all schools & users". After activation the page becomes a status panel: usage meter, Replace Key, Disable AI; on later key failure, an explanatory banner with a fix-it path (never a silent failure).

## 6. Assumptions

1. Orgs are willing and able to hold their own Anthropic Console account (the wizard and PDF guide exist because this is a 10-minute admin task, not a developer task).
2. Anthropic API pricing/model names drift; the model selector and cost meter are data-driven, not hard-coded.

## 7. Extensibility

- Provider adapters: institutions on AWS/GCP procurement can supply **Bedrock or Vertex** credentials instead; the agent service isolates the provider call behind one interface.
- The chart-spec contract may gain widget types (heatmap, funnel) — additive, renderer-gated; old specs stay valid.
- Saved AI reports already persist their spec + SQL; scheduled re-runs (email digests) are an orchestration feature, not an AI change.
