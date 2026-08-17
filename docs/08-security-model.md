# 08 — Security Model

## 1. One-line summary

**The ERP decides WHO you are and WHICH schools you may see; the platform enforces that twice and logs everything; nothing can write to school data; PII moves as little as possible.**

## 2. Identity & session

- **Launch token:** RS256-signed by the ERP, 60 s expiry, one-time nonce (jti replay cache), verified against the ERP's JWKS with key-rotation support. Carries `role`, `org_id`, `school_ids[]`, `perms[]` (contract in doc 02).
- **Platform session:** httpOnly + Secure cookie / 8-hour JWT issued after verification; the ERP is not consulted again during the session.
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

## 6. BYOK key protection

AES-256 at rest, KMS-held master key; decrypt in memory at call time only; excluded from all logs; masked in UI after save; org-revocable from the Anthropic Console at any time (revocation auto-relocks AI via the `ai_status` error path — doc 05). Platform operators cannot read tenant keys in plaintext.

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
