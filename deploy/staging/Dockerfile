# Staging images for every Node service in this repository.
#
# One file, several stages, because the services are one npm workspace tree and
# splitting them into separate Dockerfiles would mean four copies of the same
# `npm ci` and four chances for them to drift apart.
#
#   deps         -- the workspace's node_modules, cached on the lockfile alone
#   packages     -- @sap/shared and @sap/chart-spec compiled to dist/
#   service      -- orchestrator / mcp-server / erp-stub (no browser)
#   orchestrator -- service + Chromium, for PDF export
#   web-build    -- compiles the SPA bundle
#   web          -- a static file server holding that bundle
#
# THE SERVICES ARE NOT PRE-COMPILED. They run under `tsx`, exactly as they do
# locally (their package.json `start` scripts). That is a deliberate match rather
# than laziness: a staging environment exists to show that the code on this
# branch behaves, and a separate production build step would introduce a second
# way to run the code whose differences would surface here first and be blamed on
# the deployment. When there is a production build target, it belongs in a
# sibling stage and CI should publish it -- not in a hand-edited staging file.
#
# The two SHARED PACKAGES are the exception, and are compiled -- not as a policy
# choice but because they publish themselves that way. Both declare
# `"main": "./dist/index.js"`, so importing them resolves to dist/ regardless of
# what is running the importer. See the `packages` stage.
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not this directory:
#     docker compose -f deploy/staging/docker-compose.yml build

FROM node:20-bookworm-slim AS deps

WORKDIR /app

# Manifests only, so that editing a source file does not invalidate the install
# layer. Every workspace's package.json must be present before `npm ci` -- npm
# resolves the whole tree at once and fails on a workspace it cannot find.
COPY package.json package-lock.json ./
COPY packages/shared/package.json      packages/shared/
COPY packages/chart-spec/package.json  packages/chart-spec/
COPY apps/orchestrator/package.json    apps/orchestrator/
COPY apps/mcp-server/package.json      apps/mcp-server/
COPY apps/web/package.json             apps/web/
COPY tools/erp-stub/package.json       tools/erp-stub/

# Dev dependencies are NOT omitted, and that is required rather than careless:
# `tsx` and `typescript` are root devDependencies and the services are started
# through tsx. `--omit=dev` here produces images that install cleanly and then
# fail at boot with "tsx: not found".
#
# Puppeteer's Chromium download is skipped for every stage. The one stage that
# needs a browser installs the distribution's own, which is patched by apt
# rather than pinned to whatever puppeteer downloaded on build day.
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm ci --no-audit --fund=false


# ── The two shared packages, compiled ────────────────────────────────────────
#
# EVERY other stage needs this, including the ones that only run TypeScript
# through tsx and look like they should not.
#
# @sap/shared and @sap/chart-spec both declare `"main": "./dist/index.js"`, so
# an import of `@sap/shared` resolves to compiled output no matter who is doing
# the importing -- tsx compiles the file it is given, it does not compile the
# workspace dependencies that file imports. Locally the dist directories exist
# because `npm run build` has been run at some point; in a clean build context
# they do not, and .dockerignore excludes them by design (stale local output
# silently shadowing a fresh build is a bad way to deploy).
#
# Skipping this produced two different failures with nothing obviously in
# common: the SPA bundle failed at build time with "Rollup failed to resolve
# @sap/chart-spec/react", and the orchestrator would have started and then died
# on its first import. One missing step, so one stage that both inherit.
FROM deps AS packages

WORKDIR /app
COPY tsconfig.base.json tsconfig.json ./
COPY packages/ ./packages/

RUN npm run build -w @sap/shared -w @sap/chart-spec


# ── The default runtime: every service that does not need a browser ──────────
FROM node:20-bookworm-slim AS service

# `dumb-init` because Node as PID 1 does not reap zombies and does not forward
# SIGTERM to itself in the way compose expects, so `docker compose down` waits
# the full ten seconds and then kills the container. A slow shutdown is a slow
# deploy, every deploy.
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
# From `packages`, not from the build context: this copy carries the compiled
# dist/ directories the services import through, which the context does not have.
COPY --from=packages /app/packages ./packages
COPY apps/     ./apps/
COPY tools/    ./tools/
COPY db/       ./db/

# The migration one-shot in docker-compose.yml runs set-replica-host.mjs from
# here after `db:migrate --seed`.
COPY deploy/staging/scripts/ ./deploy/staging/scripts/

# The identity provider's signing-key directory, created here and owned by the
# user that has to write to it.
#
# docker-compose.yml mounts a named volume over this path so the RS256 keypair
# survives restarts. When Docker initialises an empty named volume it copies the
# image's directory AT THAT PATH, ownership included -- and if the path does not
# exist in the image, it creates one owned by root. The container runs as `node`,
# so keys.ts would then fail its first `writeFileSync` with EACCES and the whole
# environment would have no way to sign a launch token. Creating the directory
# with the right owner here is what makes the volume land with the right owner.
RUN mkdir -p /app/tools/erp-stub/.keys && chown -R node:node /app/tools/erp-stub

# Drop to the unprivileged user the base image already provides. Root inside a
# container is not root on the host, but it is one fewer boundary between a
# remote code execution and the mounted volumes.
USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "run", "start", "-w", "@sap/orchestrator"]


# ── The orchestrator: the same thing, plus a browser ─────────────────────────
FROM service AS orchestrator

USER root

# Chromium from Debian, not puppeteer's bundled download. The bundled one needs
# a long list of shared libraries installed anyway, so this trades no work for a
# browser that receives distribution security updates.
#
# The font packages are not optional decoration. Without them Chromium renders
# every glyph as a box, and the failure appears only in the PDF -- the screen,
# drawn by the user's own browser, looks perfect.
#
# `fonts-noto-core` is the one that matters, and it is here for a specific
# reason: school and student names in this data are not all Latin, and it is
# what ships NotoSansDevanagari. A PDF that renders a parent's name as boxes is
# worse than one that fails outright, because it will be sent.
#
# (There is no `fonts-noto-devanagari` package in bookworm -- the script fonts
# live inside fonts-noto-core. Asking for it by name fails the build with
# "Unable to locate package".)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      fonts-dejavu-core \
      fonts-noto-core \
 && rm -rf /var/lib/apt/lists/*

# puppeteer reads this and skips looking for its own download.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

USER node

CMD ["npm", "run", "start", "-w", "@sap/orchestrator"]


# ── The SPA build. Compiles the bundle; never run as a container. ────────────
FROM packages AS web-build

WORKDIR /app
COPY apps/web/ ./apps/web/

# Same-origin API calls.
#
# apps/web/src/api/client.ts defaults API_BASE to http://localhost:3000, which
# is correct for `npm run web:dev` (Vite on 8080, orchestrator on 3000) and
# wrong for every deployment. An EMPTY string makes every request a relative
# path -- `/api/session` -- served by the reverse proxy from the one origin the
# browser is already on.
#
# That is not only tidier than naming the staging hostname here: the session and
# CSRF cookies are SameSite=Lax (auth/session.ts), and Lax cookies are not sent
# on cross-SITE fetches. A second origin would mean every API call arriving
# unauthenticated. One origin is a correctness requirement, not a preference.
#
# `?? 'http://localhost:3000'` is nullish-coalescing, so an empty string is kept
# rather than replaced by the default. That is what makes this work without a
# change to client.ts.
ENV VITE_API_BASE=""

RUN npm run build -w @sap/web


# ── The static file server that holds the built SPA ──────────────────────────
#
# Internal only: the public reverse proxy is the `proxy` service, and this one
# is never published to the host. Two Caddies rather than one because they have
# genuinely different jobs -- this serves files over plain HTTP on the compose
# network, and is the origin Puppeteer loads print.html from (PRINT_URL). If the
# print page were fetched through the public proxy instead, PDF export would
# depend on DNS, TLS and the proxy's own access control, and would break the
# first time someone put the box behind an IP allowlist.
FROM caddy:2-alpine AS web

COPY --from=web-build /app/apps/web/dist /srv
COPY deploy/staging/Caddyfile.web /etc/caddy/Caddyfile
