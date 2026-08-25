# 08 — Security Model

## 1. One-line summary

**The ERP decides WHO you are and WHICH schools you may see; the platform enforces that twice and logs everything; nothing can write to school data; PII moves as little as possible.**

## 2. Identity & session

- **Launch token:** RS256-signed by the ERP, 60 s expiry, one-time nonce (jti replay cache), verified against the ERP's JWKS with key-rotation support. Carries `role`, `org_id`, `school_ids[]`, `perms[]` (contract in doc 02).
- **Launch transport (ADR-029):** delivered by auto-submitting **POST form**, never a URL query parameter — a token in a URL reaches ERP, proxy and browser logs plus the `Referer` header, none of which this platform can scrub, while CODING_GUIDELINES §13 makes tokens a log-forbidden value. `Referrer-Policy: no-referrer` on the launch route.
- **Platform session:** httpOnly + Secure cookie / 8-hour JWT issued after verification; the ERP is not consulted again during the session. `SameSite=Lax` in new-tab mode, `SameSite=None` in iframe mode.
- **CSRF (ADR-029):** because iframe mode requires `SameSite=None`, cookie policy alone cannot carry the defense. Independently of embedding mode, every state-changing request carries a **double-submit CSRF token** (cookie-readable value echoed in a header, compared server-side); GET/HEAD endpoints are side-effect-free by contract.
- **Webhook authentication (ADR-029):** ERP→platform webhooks carry `X-Signature: HMAC-SHA256(body, secret)` + `X-Timestamp`, constant-time compared, 5-minute window, replay-rejected. The receiver writes to the Tenant Registry, so it is authenticated rather than merely private; webhooks stay advisory (the 15-min sync covers every event), so failures cost freshness, never correctness.
- **Iframe hardening (when embedded):** strict `frame-ancestors` CSP naming the ERP domain; `SameSite=None; Secure` cookies; origin-checked `postMessage`.

## 3. Scope enforcement — the double check

```
request(school_ids requested)
  ① Orchestrator: requested ⊆ token.school_ids  else 403
  ② MCP layer:   every tool call carries the allowed set OUT-OF-BAND;
                  any school_id outside it → hard error, logged
```
*Why twice:* the threat model includes AI-generated SQL under adversarial prompting, UI bugs, and orchestrator logic errors. The AI model never supplies tenant identifiers — tenant identity is not part of model-generated content, so prompt injection cannot address another school. Custom-report scope is likewise **injected**, shown read-only in the logic panel, and not editable even in the advanced SQL tab.

## 4. Data-access controls (layers, all independent)

1. Read-only MySQL users (`analytics_ro`) — SELECT grants only.
2. SQL AST validation — SELECT-only, single-statement; applies equally to AI SQL, hand-edited custom-report SQL, and agent trigger queries.
3. Resource caps — 5,000 rows, 10 s, per-tenant rate limits; circuit breaker per school DB.
4. Column-level PII masking (phone/email) unless the role permits.
5. Role/domain policies from `perms[]`: accountant → fees only; teacher → own classes; drill-down **leaf policies** stop student-level drilling for sessions without student-data rights (top-N caps otherwise).
6. Replicas only; primaries unaddressable from platform code (registry stores replica hosts only).

## 5. Data minimisation

- **Rollup Store holds aggregates only — no student names/PII.** Director-level cross-school views therefore never move row-level personal data out of school DBs. Row-level detail requires an explicit scoped query (fan-out/drill leaf) that is role-checked and audited.
- Agent messaging uses the minimum record fields mapped into approved templates; message_log stores rendered content for compliance under the same access controls.

### 5.1 The Redis result cache — the one store where row-level PII leaves a school DB (ADR-028)

The rollup rule above carries most of the minimisation argument, but it does not cover the result cache. Redis holds **rendered report results** for 5–15 minutes, and those include Fee Defaulters rows, `student(top-N)` drill leaves and fan-out row-level output — names, phone numbers, amounts. It is therefore governed explicitly:

- **PII is permitted in the cache** (forbidding it would exclude the most-used reports from caching and break the 50–200 ms budget), but the cache is encrypted at rest and in transit, on private subnets, never internet-reachable, and excluded from operational logs.
- **`permission_class` is part of every cache key.** Masking is role-dependent (§4.4, doc 04 rail 6) and drill leaves are rights-gated (§4.5); a key without a permission component would let a privileged user's cache entry be served to a restricted one. A masking rule enforced at query time and discarded at cache time is not enforced.
- **Retention** is TTL-bounded at 5–15 min and is in scope for the compliance review (doc 11 §4.5) alongside audit and message_log retention.

### 5.2 The AI path — no row-level PII to the model provider (ADR-030)

Under BYOK (ADR-017, multi-provider per ADR-031) the model call transits the **customer's own** account with whichever provider they chose — Anthropic or Google Gemini — so what the model receives is a different question from what the platform's own services may hold, regardless of which provider is answering. The model plans queries (`get_dimensions`, then `run_query`/`run_multi`/`run_rollup`) and emits a chart-spec **skeleton** — widget types, encodings, narrative — but never receives result rows in context and never emits `data`/`rows` values itself (docs/05 §1.1). The orchestrator hydrates the skeleton with the actual query result server-side, in the same step that applies masking, so no school's row-level data ever leaves the platform's own infrastructure toward the model provider — matching the no-PII posture already held for the Rollup Store (§5 above) and extending it to the one AI-specific data path this document had not yet stated a rule for.

## 6. BYOK key protection

AES-256 at rest, KMS-held master key; decrypt in memory at call time only; excluded from all logs; masked in UI after save; org-revocable from the org's AI provider console at any time (revocation auto-relocks AI via the `ai_status` error path — doc 05). Platform operators cannot read tenant keys in plaintext. The vault's crypto (`services/key-vault.ts`) is provider-agnostic by construction — it took no changes when Gemini was added (ADR-031); only the key-shape check and the masked-hint format vary per provider, and both live on that provider's own `ProviderMeta`, not in the vault.

## 7. Audit trail (the chokepoints)

| Event | Recorded |
|---|---|
| Report/dashboard view | user, school-set, report id, filters |
| Every executed SQL | statement, school_id, caller, rows returned, duration |
| Drill click | level + drill context (who viewed which slice) |
| PDF export | report, school-set, drill path if any (Export History) |
| AI query | question, tools invoked, per-school token usage |
| Agent run | per-node input/output/status; message_log per recipient |
| Config changes | key save/replace/disable, channel connect/disconnect, agent publish/version |

*Why audit is a design pillar:* schools answer to parents and boards ("prove the parent was informed at 10:31"; "who looked at this student's fee detail"); the platform answers to schools.

## 8. Blast-radius limits (noisy-neighbor & abuse)

Per-tenant rate limits · query timeout/row caps · circuit breaker per school DB · agent guardrails (dedup, quiet hours, daily message caps, auto-pause, kill switch) · AI monthly query caps per org · LRU pool caps per MCP instance. One misbehaving tenant, agent, or prompt cannot degrade the fleet — and can, at worst, slow a replica, never a primary.

## 9. Assumptions

1. TLS everywhere; MCP server and replicas on private subnets; replica security groups admit only the MCP server SG.
2. The ERP protects its signing keys; JWKS rotation is the compromise-recovery path for token forgery.
3. Regulatory posture (Indian school data; DLT/WABA messaging rules) is handled at the product level: approved-template-only messaging, unsubscribe handling, audit retention. Formal compliance review is an open item (doc 11).

## 10. Extensibility

- `perms[]` claim values are the extension point for new domains and finer PII policies.
- A future ERP `user_disabled` webhook enables immediate session revocation (doc 02 §8).
- Per-tenant data-residency classes can ride the registry's `region` column if geo-fencing requirements emerge.
