/**
 * Tests for the container probe endpoint (routes/health.ts).
 *
 * Two properties are worth a test here, and neither is "does it return 200".
 *
 * ① The PATH is a contract with the deployment, not with any caller in this
 *   repo. `/HealthCheckAWS` is spelled that way, capitals and all, in the Helm
 *   values for all three probes. A rename or a lower-cased path typechecks,
 *   passes every other test, and then fails 30 startup probes in production
 *   before the pod is killed — a failure nothing in the code can hint at, so it
 *   is asserted literally.
 *
 * ② The handler does NO I/O. That is the design decision the module exists to
 *   hold: one path serves liveness, so a dependency check here converts a
 *   database blip into a restart loop. The test below is run with a platform DB
 *   pointed at `no-such-user` (test/env-defaults.ts) and no Redis anywhere, so a
 *   handler that grew a dependency check would hang or throw here rather than
 *   answer — which is exactly the regression to catch.
 *
 * The server is a real one on an ephemeral port rather than a stubbed
 * `Response`: status code, headers and JSON body are the whole surface a kubelet
 * sees, and a stub would let a mistake in any of the three pass.
 */

import './env-defaults.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { HEALTH_ALIAS_PATH, HEALTH_CHECK_PATH, healthRouter } from '../src/routes/health.js';

let server: Server;
let origin: string;

beforeAll(async () => {
  const app = express();
  app.use(healthRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no ephemeral port');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => { resolve(); }));
});

describe('the container probe endpoint', () => {
  /** The literal from the deployment's probe config. Do not compute it. */
  it('is served at exactly /HealthCheckAWS', () => {
    expect(HEALTH_CHECK_PATH).toBe('/HealthCheckAWS');
  });

  it('answers 200 with the process report', async () => {
    const res = await fetch(`${origin}${HEALTH_CHECK_PATH}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body['status']).toBe('ok');
    expect(body['service']).toBe('orchestrator');
    expect(typeof body['uptime_seconds']).toBe('number');
    expect(Number.isInteger(body['uptime_seconds'])).toBe(true);
    expect(Number.isNaN(Date.parse(String(body['started_at'])))).toBe(false);
    /**
     * The payload says what it did not check. A probe body reading only `ok`
     * invites "the system is healthy", which this response cannot support.
     */
    expect(body['checks']).toBe('process-only');
  });

  it('keeps answering the /healthz alias', async () => {
    const res = await fetch(`${origin}${HEALTH_ALIAS_PATH}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>)['status']).toBe('ok');
  });

  it('is never cached, so a probe measures this process', async () => {
    const res = await fetch(`${origin}${HEALTH_CHECK_PATH}`);
    /**
     * `no-store`, not `no-cache`: a sidecar or ALB answering a probe from a
     * stored response reports the health of that response.
     */
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers well inside the 3-second readiness timeout, because it does no I/O', async () => {
    /**
     * The margin is enormous on purpose — this asserts a category (memory, not
     * network), not a benchmark, and must not go red on a loaded CI box. The
     * platform DB in this suite points at a user that cannot connect and there
     * is no Redis, so any dependency check added to the handler blows past this
     * or fails outright.
     */
    const started = process.hrtime.bigint();
    const res = await fetch(`${origin}${HEALTH_CHECK_PATH}`);
    await res.arrayBuffer();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(res.status).toBe(200);
    expect(elapsedMs).toBeLessThan(500);
  });

  it('reports the same boot instant on every call', async () => {
    /**
     * `started_at` is stamped once at module load. Recomputing it per request
     * would make each probe report a slightly different boot time, so an
     * operator correlating a restart against a log window would be reading a
     * moving number.
     */
    const first = (await (await fetch(`${origin}${HEALTH_CHECK_PATH}`)).json()) as Record<string, unknown>;
    const second = (await (await fetch(`${origin}${HEALTH_CHECK_PATH}`)).json()) as Record<string, unknown>;
    expect(second['started_at']).toBe(first['started_at']);
  });
});
