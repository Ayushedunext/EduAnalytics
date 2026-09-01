/**
 * `GET /docs` and `GET /openapi.json` — the API reference.
 *
 * Contract source: src/docs/openapi.ts (the document itself) · ADR-029 clause 3
 * (both are GETs and side-effect-free, so neither needs a CSRF token).
 *
 * -- Mounted before the session and CSRF middleware ---------------------------
 * Deliberately, and for the same reason `/healthz` is: a reference to the API is
 * not school data, and requiring a launch token to read the shape of the launch
 * endpoint is a circle. The document contains no tenant identifiers, no keys and
 * no SQL — every example in it is invented.
 *
 * -- Not served in production -------------------------------------------------
 * `mountDocs` is a no-op when NODE_ENV is production. The document describes the
 * whole attack surface in one place, and an unauthenticated reader of it in
 * front of real school databases gains reconnaissance for nothing the platform
 * needs. Development and staging get it; production deployments that want it can
 * put it behind their own gateway auth, which is a decision for whoever runs the
 * deployment rather than a default this file makes for them.
 *
 * -- Swagger UI comes from a CDN, not node_modules ----------------------------
 * `swagger-ui-dist` is ~15 MB of vendored assets that would ship in every
 * production image to serve a page production does not serve. The two script
 * tags below are pinned to an exact version — a floating `@latest` would make
 * this page's behaviour change under us without a commit. A developer offline
 * still has `/openapi.json`, which is the part machines read.
 */

import { Router, type Request, type Response } from 'express';
import { isProduction } from '../config.js';
import { openApiDocument } from '../docs/openapi.js';

export const docsRouter = Router();

/** Pinned. See the module note. */
const SWAGGER_UI_VERSION = '5.29.0';
const SWAGGER_UI_BASE = `https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_VERSION}`;

docsRouter.get('/openapi.json', (_req: Request, res: Response): void => {
  /** No caching: the document changes with the code, and it is cheap to rebuild. */
  res.setHeader('cache-control', 'no-store');
  res.json(openApiDocument);
});

docsRouter.get('/docs', (_req: Request, res: Response): void => {
  res.setHeader('cache-control', 'no-store');
  res.type('html').send(page());
});

/**
 * The Swagger UI shell.
 *
 * Two settings here are what make "Try it out" work against a real session
 * rather than 401ing on everything:
 *
 *   `withCredentials` — the session is an httpOnly cookie, so it is only sent
 *   when the fetch asks for it. The page is served from the orchestrator's own
 *   origin, so this is a same-origin request and the cookie rides along.
 *
 *   `requestInterceptor` — the double-submit CSRF token (ADR-029 clause 3).
 *   Every non-GET request must echo the `sap_csrf` cookie in a header, exactly
 *   as the SPA's own client does (apps/web/src/api/client.ts). Without it every
 *   POST/PUT/DELETE from this page would fail CSRF_CHECK_FAILED and read as a
 *   broken API rather than a missing header.
 *
 * Launch from the ERP first (`npm run erp:dev`, then open Analytics) — this page
 * has no way to mint a session and should not have one.
 */
function page(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>School Analytics Platform — API</title>
  <link rel="stylesheet" href="${SWAGGER_UI_BASE}/swagger-ui.css">
  <style>
    body { margin: 0; background: #fafafa; }
    .topbar { display: none; }
    .swagger-ui .info { margin: 28px 0; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${SWAGGER_UI_BASE}/swagger-ui-bundle.js" crossorigin></script>
  <script src="${SWAGGER_UI_BASE}/swagger-ui-standalone-preset.js" crossorigin></script>
  <script>
    const CSRF_COOKIE = 'sap_csrf';
    const CSRF_HEADER = 'x-csrf-token';

    function readCookie(name) {
      return document.cookie
        .split('; ')
        .find((c) => c.startsWith(name + '='))
        ?.split('=')[1];
    }

    window.ui = SwaggerUIBundle({
      url: '/openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      // 'list' expands the tag sections and leaves the operations closed: the
      // whole 27-endpoint surface is visible on arrival, and only the one you
      // want opens. 'none' hides every endpoint behind two clicks.
      docExpansion: 'list',
      defaultModelsExpandDepth: 0,
      tryItOutEnabled: true,
      persistAuthorization: true,
      withCredentials: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      layout: 'BaseLayout',
      requestInterceptor: (req) => {
        const method = (req.method || 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
          const token = readCookie(CSRF_COOKIE);
          if (token !== undefined) req.headers[CSRF_HEADER] = token;
        }
        return req;
      },
    });
  </script>
</body>
</html>`;
}

/**
 * Mount the reference, unless this is production.
 *
 * A function rather than a bare router export so the decision is made once, at
 * boot, in one place — a route that exists but 404s would still be a route, and
 * the point is that production serves nothing here at all.
 */
export function mountDocs(app: { use: (router: Router) => unknown }): boolean {
  if (isProduction) return false;
  app.use(docsRouter);
  return true;
}
