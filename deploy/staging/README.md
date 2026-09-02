# Staging deployment

The whole platform on one Linux host, with a password sign-in instead of the
ERP. Everything behind that sign-in is the real product: the real orchestrator,
the real MCP server, the real vetted SQL, against a real restored ERP extract.

---

## What replaces the ERP, and what does not

The platform has exactly one runtime dependency on the ERP: **the ERP signs one
launch JWT per session** (Invariant 1 — on the read path, that is its entire
runtime involvement). Everything else already comes from the platform's own
registry, replicas and cache.

So staging replaces exactly that one thing. `tools/erp-stub` — which
`docs/11 §2` always described as doubling as "the staging harness" — is started
with `ERP_STUB_MODE=login`, which swaps its click-a-persona picker for a
password form and switches the unauthenticated `/launch-analytics` route off.
After the password is accepted it performs the **ordinary, unmodified** launch
handshake of `docs/02 §2`: same claims, same RS256 signature, same 60-second
token, same one-time `jti`, same auto-POST handoff.

**No code in `apps/` changed for any of this**, and that is the point.
`CODING_GUIDELINES §11` is `[MANDATORY]` — *"Never add platform-local login,
password storage, or user tables mirroring the ERP"* — and `docs/10 §2` says
there is no login screen in this product. Both stay true. The login lives where
the ERP's login lives: in the thing standing in for the ERP. When the real ERP
ships, `ERP_JWKS_URL` changes, `tools/erp-stub` is deleted, and nothing else
moves.

---

## The stack

Only `proxy` publishes a port. MySQL, Redis, the MCP server, the orchestrator
and the identity provider are reachable on the compose network and nowhere else
— which is what `docs/04 §6` ("MCP server: private network only") and
`docs/09 §4` (cached rows are school data) require.

```
                    :80 :443
                       │
                  ┌────▼─────┐
                  │  proxy   │  Caddy · TLS · one public origin
                  └────┬─────┘
        ┌──────────────┼──────────────┬────────────────┐
        │              │              │                │
   /signin*         /launch        /api/*        everything else
        │           /HealthCheck…     │                │
   ┌────▼────┐      ┌────▼────────────▼──┐        ┌────▼────┐
   │   idp   │      │    orchestrator    │        │   web   │
   │erp-stub │      │  + Chromium (PDF)  │        │  static │
   └─────────┘      └────┬──────────┬────┘        └────▲────┘
                         │          │                  │
                    ┌────▼────┐  ┌──▼────┐             │ PRINT_URL
                    │  redis  │  │  mcp  │             │ (internal)
                    └─────────┘  └───┬───┘─────────────┘
                                     │
                                ┌────▼────┐
                                │  mysql  │  analytics_platform (rw)
                                └─────────┘  ai_analysis        (SELECT only)
```

**One origin is a correctness requirement, not a preference.** The session and
CSRF cookies are `SameSite=Lax`, and browsers do not attach Lax cookies to
cross-*site* fetches. Split the SPA and the API onto two registrable domains and
every `/api/*` call arrives unauthenticated, with perfectly good cookies sitting
unused in the jar. Hence: one hostname, paths routed behind it, and the SPA
built with `VITE_API_BASE=""` so every request is relative.

---

## Deploy

### 0. Host

A Linux box with Docker, ~4 GB RAM and ~15 GB free disk. A DNS A record
pointing at it **before** the first `up` — Caddy requests a Let's Encrypt
certificate on boot, the challenge fails if the name does not resolve yet, and
failed challenges count against a rate limit of 5 per name per week.

Ports 80 and 443 must be reachable from the internet for the same reason.

### 1. Configure

```bash
git clone <this repo> && cd EduAnalytics
cp deploy/staging/.env.staging.example deploy/staging/.env
bash deploy/staging/scripts/make-secrets.sh      # generates every secret
$EDITOR deploy/staging/.env                      # set STAGING_HOSTNAME, ACME_EMAIL
```

`make-secrets.sh` generates six independent secrets and six account passwords,
then `chmod 600`s the file. It only fills values that are empty or still
`CHANGE_ME`, so re-running it will not rotate a working environment out from
under itself.

### 2. Bring up the database and load the data

```bash
docker compose -f deploy/staging/docker-compose.yml up -d mysql
```

The first boot of an empty volume runs `mysql-init/`, which creates both
databases and both users — `analytics_app` with full rights over
`analytics_platform`, and `analytics_ro` with **`SELECT` and nothing else** over
`ai_analysis`. That second grant is Invariant 3 enforced by the database itself,
independently of the AST validator in the MCP server.

Then, **on the machine that currently holds the extract** (the development box
whose MySQL has the restored ERP dumps):

```bash
bash deploy/staging/scripts/export-data.sh          # ~1 GB -> dumps/*.sql.gz
scp dumps/ai_analysis-staging.sql.gz  HOST:~/
```

and on the staging host:

```bash
bash deploy/staging/scripts/load-data.sh ~/ai_analysis-staging.sql.gz
shred -u ~/ai_analysis-staging.sql.gz
```

### 3. Bring up everything else

```bash
docker compose -f deploy/staging/docker-compose.yml up -d --build
```

The `migrate` service runs first, applies `db/platform/migrations/`, seeds the
registry, and repoints `tenant_registry.replica_host` at the `mysql` service. It
exits; the others wait for it to have completed successfully.

First build takes several minutes (npm install, the SPA bundle, and Chromium for
the orchestrator's PDF rendering).

### 4. Check

```bash
docker compose -f deploy/staging/docker-compose.yml ps          # all healthy
curl -fsS https://YOUR-HOST/HealthCheckAWS
grep ERP_STUB_PASSWORD deploy/staging/.env                       # the passwords
```

Open `https://YOUR-HOST/` — with no session you are redirected to `/signin`.

---

## The accounts

Username is the identity key; passwords are in `deploy/staging/.env`. What each
one can see is defined in `tools/erp-stub/src/identities.ts`, and the differences
are worth demonstrating rather than picking one at random:

| Username | Role | Shows |
|---|---|---|
| `director` | Director, St Marks | All 3 schools; combine and compare |
| `principal-mb` | Principal, Meera Bagh | One school — scope isolation, against… |
| `principal-j` | Principal, Janakpuri | …a different single school |
| `principal-training` | Principal, Edubac Training | The **only** account with attendance data |
| `accountant-mb` | Accountant | Fees only, no `students.read`; a different cache class |
| `admin` | IT Admin | The only role that can configure the org's AI key |

An account whose `ERP_STUB_PASSWORD_*` is empty **does not exist** — it cannot be
signed in as and is not listed. Deleting a line disables a role; it never
quietly opens one.

`ERP_STUB_SHOW_ACCOUNTS=true` prints the username list on the sign-in page.
Convenient when sharing a link; also a published list of valid usernames to
guess passwords against. Turn it on only behind `STAGING_ALLOW_CIDRS`.

---

## Ask AI is off until someone turns it on

Deliberately, and there is no environment variable that changes this. Ask AI runs
on the **organisation's own** Anthropic key (BYOK, ADR-017, Invariant 5), entered
through the UI and stored encrypted in the platform database. Every `/api/ai/*`
endpoint re-checks the org's gating state server-side on every request.

To enable it: sign in as `admin` → Settings → paste the key. Until then the AI
screens render their locked state, which is itself worth showing.

---

## This box holds real school data

Roughly 242,000 students with names and guardian contact details, 1.7 million
fee rows, and staff records — the real extract, not a fixture. That was a
deliberate choice for this environment, made with an anonymised copy on the
table. It has consequences worth being explicit about:

- **The host's disk is as sensitive as the source database.** Encrypt the
  volume; restrict who can SSH in.
- **`STAGING_ALLOW_CIDRS` is the highest-value setting in the file.** The
  application's password gate (with a per-address attempt throttle) is the front
  door, and it is a front door on the open internet. Narrowing to office and VPN
  ranges takes one variable and `docker compose up -d proxy`. It defaults open
  only so the person deploying is not locked out before they first reach the
  sign-in page.
- **Delete the dump from both machines once loaded.** Both scripts end by saying
  so.
- **`deploy/staging/.env` is a production-grade credential file** — every
  database password plus the key that decrypts the org's Anthropic key. It is
  git-ignored and `chmod 600`. Do not paste it into a ticket or a chat.

Should this stop being acceptable, the change is to anonymise names, phone
numbers, emails and addresses between the dump and the copy. Leave amounts,
dates and counts exactly as they are, or the dashboards stop demonstrating
anything real.

---

## Operating it

```bash
# All commands from the repo root.
C="docker compose -f deploy/staging/docker-compose.yml"

$C ps                                  # health of every service
$C logs -f orchestrator                # structured JSON, one line per request
$C logs -f idp                         # sign-in attempts (never passwords)
$C up -d --build                       # deploy a new commit
$C up -d proxy                         # after changing STAGING_ALLOW_CIDRS
$C exec redis redis-cli FLUSHDB        # drop the report cache
$C down                                # stop; volumes survive
$C down -v                             # stop AND DESTROY the loaded data
```

**Deploying a new commit** is `git pull && $C up -d --build`. `migrate` re-runs
and applies anything new; it tracks applied files in `schema_migrations` and the
seeds are `ON DUPLICATE KEY UPDATE`, so it is safe every time.

### When something is wrong

| Symptom | Cause |
|---|---|
| Sign-in succeeds, lands back on sign-in | Cookie not stored. `NODE_ENV=production` sets `Secure`, so the origin must be HTTPS. Check `proxy` logs for a certificate failure. |
| "This launch link is not valid." | `ERP_ISSUER` differs between `idp` and `orchestrator`. Compose passes one value to both — check `.env`. |
| "This launch link has already been used." | The one-time `jti` was consumed (ADR-003). A refresh or back-button on the handoff page. Sign in again. |
| Dashboards error, everything else fine | `tenant_registry.replica_host` is not `mysql`. Re-run: `$C run --rm migrate`. |
| PDF export times out | Chromium missing from the image, or `PRINT_URL` not reachable. It must be `http://web:8080/print.html` — internal, never the public hostname. |
| Blank page after a deploy | A cached `index.html` pointing at asset names that no longer exist. `Caddyfile.web` sets `no-cache` on the entry points to prevent this; check it was not edited. |
| MySQL restart-loops on first boot | A `mysql-init` script failed. `$C logs mysql`. That script runs **only** on an empty volume — fixing it needs `down -v`. |

---

## Files

| Path | What |
|---|---|
| `docker-compose.yml` | The stack. Every service, and why each setting is what it is. |
| `Dockerfile` | Four build stages: deps, service, orchestrator (+Chromium), web. |
| `Caddyfile` | Public edge: TLS, routing, allowlist, the signed-out redirect. |
| `Caddyfile.web` | Internal static server for the SPA bundle and `print.html`. |
| `.env.staging.example` | Template. Copy to `.env`; never commit the copy. |
| `mysql-init/` | First-boot database and user creation, with the SELECT-only grant. |
| `scripts/make-secrets.sh` | Generates the six secrets and six account passwords. |
| `scripts/export-data.sh` | Dumps the extract, on the machine that has it. |
| `scripts/load-data.sh` | Restores it into the staging container. |
| `scripts/set-replica-host.mjs` | Repoints the registry at the container's MySQL. |
