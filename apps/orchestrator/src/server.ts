/**
 * Orchestrator entry point.
 *
 * Contract: docs/01 §3 (component responsibilities) · docs/04 §4 (why an
 * orchestrator sits between the SPA and MCP).
 *
 * This service owns session issuance, scope checks, service routing, caching,
 * BYOK key resolution and PDF. What it must NEVER do (docs/01 §3): reach a school
 * database directly. School data arrives only through MCP tools, which is what
 * keeps a single audit chokepoint over every school-data read.
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import { config, isProduction } from './config.js';
import { assertPlatformDbReachable } from './db/platform-db.js';
import { pruneExpiredNonces } from './auth/nonce.js';
import { withCorrelationId, requireSession } from './middleware/context.js';
import { requireCsrfToken } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { launchRouter } from './routes/launch.js';
import { sessionRouter } from './routes/session.js';
import { homeRouter } from './routes/home.js';
import { reportRouter } from './routes/report.js';
import { settingsRouter } from './routes/settings.js';
import { aiRouter } from './routes/ai.js';
import { closePdfRenderer } from './services/pdf.js';
import { closeCache } from './cache/result-cache.js';

const app = express();

app.disable('x-powered-by');

/**
 * CORS for the SPA only, with credentials.
 *
 * A strict allowlist of one origin. `credentials: true` plus a wildcard origin is
 * forbidden by browsers anyway, but naming the origin explicitly means a
 * misconfigured deployment fails visibly rather than opening the API to any site.
 */
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin === config.SPA_ORIGIN) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-allow-headers', 'content-type, x-csrf-token');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('vary', 'origin');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.use(withCorrelationId);
app.use(cookieParser());

/** The launch handoff is a form POST (ADR-029 clause 1). */
app.use(express.urlencoded({ extended: false, limit: '16kb' }));
app.use(express.json({ limit: '256kb' }));

/**
 * Route order is deliberate. /launch is mounted BEFORE the CSRF middleware
 * because it is a cross-site form POST from the ERP by design and no CSRF token
 * can exist yet -- there is no session. Its protection is the single-use,
 * 60-second, ERP-signed token itself (see middleware/csrf.ts).
 */
app.use(launchRouter);

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

/** Everything past here requires a session and a CSRF token on writes. */
app.use(requireCsrfToken);
app.use('/api', requireSession);
app.use(sessionRouter);
app.use(homeRouter);
app.use(reportRouter);
app.use(settingsRouter);
app.use(aiRouter);

app.use(notFoundHandler);
app.use(errorHandler);

await assertPlatformDbReachable();
console.log('[orchestrator] platform DB reachable');

const pruned = await pruneExpiredNonces();
if (pruned > 0) console.log(`[orchestrator] pruned ${pruned} expired launch nonces`);
/** Housekeeping, not a security control -- expiry is enforced on the token itself. */
setInterval(() => {
  void pruneExpiredNonces().catch((err: unknown) => {
    console.error('[orchestrator] nonce prune failed:', err);
  });
}, 60_000).unref();

app.listen(config.ORCHESTRATOR_PORT, () => {
  console.log(`[orchestrator] listening on http://localhost:${config.ORCHESTRATOR_PORT}`);
  console.log(`[orchestrator] SPA origin  ${config.SPA_ORIGIN}`);
  console.log(`[orchestrator] ERP JWKS    ${config.ERP_JWKS_URL}`);
  console.log(`[orchestrator] secure cookies: ${String(isProduction)}`);
});

/**
 * Shut the long-lived clients down on the way out.
 *
 * Chromium is a CHILD PROCESS, not a socket: a killed orchestrator that never
 * closes it leaves a headless browser running with no parent, and a
 * dev-server restart loop leaves one per restart until the machine notices.
 * Redis is closed for tidiness rather than necessity — the socket would drop
 * anyway, but a clean QUIT keeps the server's log free of resets it did not
 * cause.
 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void Promise.allSettled([closePdfRenderer(), closeCache()]).then(() => {
      process.exit(0);
    });
  });
}
