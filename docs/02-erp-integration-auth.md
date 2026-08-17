# 02 — ERP Integration & Authentication

## 1. Design goal

One click from the ERP menu into Analytics with **no second login**, and **no runtime coupling**: after launch, the analytics session lives entirely on the platform. The ERP contributes exactly two things — *identity* (a signed launch token per session) and *configuration* (a background sync of its master school↔DB mapping).

## 2. Launch flow (SSO)

```
 User (already logged into ERP)
   │ clicks menu "📊 Analytics"
   ▼
 ERP backend ── signs LAUNCH TOKEN (RS256, 60 s expiry, one-time nonce)
   │  { sub, name, role, org_id, school_ids[], default_school,
   │    perms[], iat, exp, jti }
   ▼ redirect (new tab) or iframe →  https://analytics.<domain>/launch?token=…
 Analytics orchestrator
   ① verify signature against ERP JWKS endpoint (key rotation supported)
   ② check exp + jti nonce (replay protection; jti cached until expiry)
   ③ issue OWN session (httpOnly Secure cookie / 8-hour JWT)
   ▼
 SPA loads — school picker pre-filled from token; ERP never called again
 this session.
```

**Why a 60-second single-use token instead of shared sessions:** the two systems keep independent lifecycles (the ERP can rotate keys, the platform can scale sessions) and the attack surface is one short-lived, replay-proof artifact. The analytics session deliberately outlives the token (8 h) so ERP hiccups never log analytics users out mid-analysis.

**Why role and scope live in the token:** the ERP is the system of record for who may see which schools. Encoding `role`, `org_id`, `school_ids[]`, `perms[]` at launch means the platform never needs a runtime "what can this user see?" API call — which would violate the no-runtime-coupling rule and add the ERP to the latency path.

## 3. Token contract (reference)

```json
{
  "sub": "user_88231",
  "name": "R. Mehta",
  "role": "DIRECTOR",            // DIRECTOR | PRINCIPAL | TEACHER | ACCOUNTANT | ADMIN
  "org_id": "sunrise-trust",
  "school_ids": ["sunrise-delhi", "sunrise-noida", "sunrise-gurgaon"],
  "default_school": "sunrise-delhi",
  "perms": ["fees.read", "attendance.read", "exams.read", "staff.read"],
  "iat": 1723350000, "exp": 1723350060, "jti": "one-time-nonce"
}
```

Rules: `school_ids` is exhaustive for the session — a Principal's token carries one id, a Director's carries all schools of the org. `perms` gate domains (an accountant-only token lacks `exams.read`; the reporting layer and drill leaf policies honor it — docs 06/08). IDs are the **same IDs the ERP uses** so no mapping layer exists to drift.

## 4. Embedding modes

- **New tab (default, recommended):** simplest; the analytics origin is its own first-party context.
- **Iframe inside the ERP shell:** supported for seamless UX. Requirements: CSP `frame-ancestors` allowing exactly the ERP domain; cookies `SameSite=None; Secure`; any ERP↔SPA `postMessage` traffic origin-checked.

Both use the identical launch flow; the choice is per-deployment cosmetic.

## 5. Configuration inheritance — registry sync, not runtime calls

The ERP already knows every school's DB (host, database, credentials) and the org hierarchy (a school-info table the ERP team will identify — see doc 11). The platform copies, it does not call:

```
ERP master config + school-info table
        │  every 15 min (pull)  +  create/update webhook (push)
        ▼
TENANT REGISTRY (platform-owned)
  school_id PK · org_id · school_name · region · status
  replica_host · db_name              ← points at the READ REPLICA
  secret_arn                          ← credentials live in AWS Secrets Manager
  schema_version                      ← e.g. 'erp-v4.2'
ORG REGISTRY
  org_id PK · org_name · school_count
```

Sync-time onboarding steps for a new school: ensure a read-only `analytics_ro` MySQL user exists on its DB; create/refresh the Secrets Manager entry; insert/update the registry row; health-check (connect → `SELECT 1` → verify grants are SELECT-only) → `status = active`. **A new school in the ERP is analytics-ready within one sync cycle with zero deployments** — the registry *is* the configuration.

**Why sync over runtime API:** availability isolation (ERP down ≠ analytics down), latency isolation (no ERP hop per query), and load isolation (the sync reads an ERP replica in the background). The 15-min staleness window is acceptable because school topology changes rarely; the webhook closes the gap for onboarding demos.

## 6. Failure & edge handling

| Case | Behavior |
|---|---|
| Token expired / bad signature / replayed jti | Launch rejected with a "return to ERP and reopen" page; nothing issued |
| ERP JWKS unreachable at launch | Retry against cached JWKS (keys cached with rotation grace); if cold-cache fails, launch fails loudly — never "verify later" |
| Registry row missing for a token's school_id | That school is dropped from scope with a visible notice; session proceeds for remaining schools |
| School `status = suspended/migrating` | Excluded from scope; picker shows it disabled with the status |
| Mid-session role change in ERP | Takes effect at next launch (sessions are 8 h max); acceptable by design — see Assumptions |

## 7. Assumptions

1. The ERP can add one menu item and one token-signing endpoint (JWKS published). This is the entire ERP-side build for launch.
2. The school-info table provides a stable org↔school mapping; `org_id`/`school_id` values are stable identifiers (not display names).
3. 8-hour session with launch-time role snapshot is acceptable; immediate revocation (fire an employee, kill their analytics session now) is out of scope v1 — extensibility below.

## 8. Extensibility

- **Session revocation feed:** a future ERP webhook (`user_disabled`) can blacklist `sub` values against active sessions if immediate revocation becomes a requirement.
- **Per-domain scopes:** `perms[]` is already granular; new domains (e.g., `transport.read`) require only new claim values honored by the reporting layer.
- **Multiple ERP versions/brands:** the launch contract is ERP-agnostic; a second ERP product only needs to sign the same token shape and feed the same registry sync.
