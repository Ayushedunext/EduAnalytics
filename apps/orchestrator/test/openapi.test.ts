/**
 * The API reference cannot fall behind the API (src/docs/openapi.ts).
 *
 * This is the whole reason the document is a TypeScript module rather than a
 * YAML file: the routes it describes can be IMPORTED and walked. A route added
 * in `routes/` and forgotten in the document is not a cosmetic gap — a
 * reference that omits an endpoint reads as "that endpoint does not exist", and
 * one that describes a removed endpoint reads as "call this". Both are confident
 * false statements, which is the success-shaped failure CODING_GUIDELINES §10
 * calls the worst class here. Nothing throws when it happens, so only a test
 * catches it.
 *
 * What is asserted is the SURFACE — path plus method — not the schemas. Response
 * shapes are covered by the tests that build those responses; duplicating them
 * here would be a second description free to disagree with the first.
 */

import './env-defaults.js';
import { describe, expect, it } from 'vitest';
import type { Router } from 'express';
import { openApiDocument } from '../src/docs/openapi.js';
import { launchRouter } from '../src/routes/launch.js';
import { healthRouter } from '../src/routes/health.js';
import { sessionRouter } from '../src/routes/session.js';
import { homeRouter } from '../src/routes/home.js';
import { reportRouter } from '../src/routes/report.js';
import { customReportsRouter } from '../src/routes/custom-reports.js';
import { settingsRouter } from '../src/routes/settings.js';
import { aiRouter } from '../src/routes/ai.js';

/**
 * Every router `server.ts` mounts. Listed rather than discovered: a new router
 * that nobody added here would pass silently, so this line is the one place a
 * reviewer has to look when one appears.
 */
const ROUTERS: readonly Router[] = [
  launchRouter,
  healthRouter,
  sessionRouter,
  homeRouter,
  reportRouter,
  customReportsRouter,
  settingsRouter,
  aiRouter,
];

/**
 * Registered on the app itself rather than in a router, so the walk below cannot
 * see them. Empty since the probe endpoints moved into `healthRouter` — kept as
 * the declared home for the next route that is mounted on `app` directly.
 *
 * `/docs` is deliberately absent: it is an HTML page, not an API endpoint, and
 * describing a documentation viewer inside the document it renders would be
 * noise.
 */
const APP_LEVEL: readonly string[] = [];

/** Express keeps `{path, methods}` on each routed layer; this reads them back. */
function routesOf(router: Router): string[] {
  const found: string[] = [];
  const stack = (router as unknown as { stack: readonly unknown[] }).stack;
  for (const layer of stack) {
    const route = (layer as { route?: { path?: unknown; methods?: Record<string, boolean> } }).route;
    if (route === undefined) continue;
    const path = typeof route.path === 'string' ? route.path : undefined;
    if (path === undefined) continue;
    for (const [method, enabled] of Object.entries(route.methods ?? {})) {
      /** Express adds `_all` for `router.all`; it is not a method anyone calls. */
      if (!enabled || method === '_all') continue;
      found.push(`${method.toUpperCase()} ${openApiPath(path)}`);
    }
  }
  return found;
}

/** `/api/reports/:id` in Express is `/api/reports/{id}` in OpenAPI. */
function openApiPath(expressPath: string): string {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function documented(): string[] {
  const found: string[] = [];
  for (const [path, operations] of Object.entries(openApiDocument.paths)) {
    for (const method of Object.keys(operations)) {
      found.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return found;
}

const served = [...APP_LEVEL, ...ROUTERS.flatMap(routesOf)].sort();
const described = documented().sort();

describe('the OpenAPI document', () => {
  it('describes every route the orchestrator serves', () => {
    const missing = served.filter((route) => !described.includes(route));
    expect(missing, 'served but undocumented — add them to src/docs/openapi.ts').toEqual([]);
  });

  it('describes nothing the orchestrator does not serve', () => {
    const phantom = described.filter((route) => !served.includes(route));
    expect(phantom, 'documented but not served — a reference that invites a 404').toEqual([]);
  });

  it('gives every operation a summary and a tag from the declared list', () => {
    const tags = new Set(openApiDocument.tags.map((t) => t['name']));
    for (const [path, operations] of Object.entries(openApiDocument.paths)) {
      for (const [method, raw] of Object.entries(operations)) {
        const operation = raw as { summary?: unknown; tags?: unknown; responses?: unknown };
        const where = `${method.toUpperCase()} ${path}`;
        expect(operation.summary, `${where} has no summary`).toBeTruthy();
        expect(operation.responses, `${where} documents no responses`).toBeTruthy();
        const operationTags = Array.isArray(operation.tags) ? operation.tags : [];
        expect(operationTags.length, `${where} has no tag`).toBeGreaterThan(0);
        for (const tag of operationTags) {
          expect(tags, `${where} uses undeclared tag ${String(tag)}`).toContain(tag);
        }
      }
    }
  });

  it('resolves every $ref it uses', () => {
    const schemas = openApiDocument.components['schemas'] as Record<string, unknown>;
    const refs = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') refs.add(value);
        else walk(value);
      }
    };
    walk(openApiDocument);

    for (const reference of refs) {
      const name = reference.replace('#/components/schemas/', '');
      expect(schemas, `${reference} points at nothing`).toHaveProperty(name);
    }
  });

  it('exempts only the endpoints that cannot carry a session', () => {
    /**
     * `security: []` means "no authentication required". `/launch` has no
     * session by definition, and the probe paths are called by a kubelet that
     * holds no token and never will; anything else carrying this would be an
     * endpoint claiming to serve school data to an anonymous caller, which is a
     * documentation bug with a real-world reading.
     */
    const exempt: string[] = [];
    for (const [path, operations] of Object.entries(openApiDocument.paths)) {
      for (const [method, raw] of Object.entries(operations)) {
        const security = (raw as { security?: unknown }).security;
        if (Array.isArray(security) && security.length === 0) {
          exempt.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(exempt.sort()).toEqual(['GET /HealthCheckAWS', 'GET /healthz', 'POST /launch']);
  });
});
