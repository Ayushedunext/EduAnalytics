/**
 * `GET /HealthCheckAWS` — the container probe endpoint.
 *
 * One path answers all three Kubernetes probes (startup, liveness, readiness),
 * because that is what the deployment's Helm values ask for:
 *
 *     startupProbe:   path /HealthCheckAWS  failureThreshold 30  period 10s
 *     livenessProbe:  path /HealthCheckAWS  period 10s  timeout 10s  threshold 5
 *     readinessProbe: path /HealthCheckAWS  period 10s  timeout 3s   threshold 3
 *
 * -- [MANDATORY] this handler touches NOTHING ---------------------------------
 * No platform DB query, no Redis PING, no MCP call. That is the single design
 * decision in this file and it follows from the probe config above rather than
 * from laziness.
 *
 * A liveness probe's only remedy is `kill -9` and a restart. So a liveness check
 * that queried MySQL would convert a database blip into a cluster-wide restart
 * loop: every pod fails five checks in ~50 s, every pod dies, none of them can
 * fix the database, and the restarts throw away the warm connection pools and
 * caches that would have absorbed the blip. The failure the check "detected" is
 * one it would then be causing. Since one path serves all three probes here, the
 * strictest consumer (liveness) sets the rule for the endpoint, and dependency
 * state has to be an alarm on metrics rather than a probe that reboots things.
 *
 * The 3-second readiness timeout says the same thing from the other side: an
 * endpoint that opens a connection has no business promising an answer inside a
 * budget the connection alone can exceed.
 *
 * -- Then what does a 200 here actually assert? -------------------------------
 * That this process is up, its event loop is turning, and it is accepting on its
 * port. That is more than it sounds, because server.ts awaits
 * `assertPlatformDbReachable()` BEFORE `app.listen()` — a process that answers
 * at all is one that reached the platform database at boot. That is precisely
 * what the startupProbe needs to gate on (30 × 10 s = up to 5 minutes of boot),
 * and it is why the startup gate needs no check of its own.
 *
 * The payload names the limit rather than leaving a reader to assume a green
 * response is a green system.
 *
 * -- Unauthenticated, and above the session gate ------------------------------
 * Mounted before `requireSession`/`requireCsrfToken` for the same reason
 * `/docs` is: the kubelet holds no launch token and never will, and this
 * response contains no school data, no tenant identifier and no configuration —
 * a service name and an uptime. Invariant 1 (zero ERP load) is untouched
 * because nothing here reads anything.
 */

import { Router, type Request, type Response } from 'express';

export const healthRouter = Router();

/** The path the deployment's probes are configured to call. Exported for tests. */
export const HEALTH_CHECK_PATH = '/HealthCheckAWS';

/**
 * The pre-existing alias, kept.
 *
 * Nothing is gained by breaking whatever already calls it — local scripts, the
 * compose stack, and the MCP server's own equivalent all speak `/healthz`, and
 * both names are the same zero-cost answer.
 */
export const HEALTH_ALIAS_PATH = '/healthz';

/**
 * ISO-8601, stamped once at module load rather than computed per request, so
 * every probe reports the same boot instant instead of one that drifts.
 */
const startedAt = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();

export interface HealthReport {
  readonly status: 'ok';
  readonly service: 'orchestrator';
  /** Whole seconds since this process started. */
  readonly uptime_seconds: number;
  readonly started_at: string;
  /**
   * Stated in the payload because a probe response that says only `ok` invites
   * the reading that a green check means a green system. It does not: see the
   * module note.
   */
  readonly checks: 'process-only';
}

export function healthReport(): HealthReport {
  return {
    status: 'ok',
    service: 'orchestrator',
    uptime_seconds: Math.floor(process.uptime()),
    started_at: startedAt,
    checks: 'process-only',
  };
}

function respond(_req: Request, res: Response): void {
  /**
   * `no-store`, not merely `no-cache`. A probe answered from any cache — a
   * sidecar, a mesh proxy, an ALB — reports the health of a stored response
   * rather than of this process, which is the one thing it exists to measure.
   */
  res.setHeader('cache-control', 'no-store');
  res.status(200).json(healthReport());
}

/** Express answers HEAD from a GET handler, which is what a probe may send. */
healthRouter.get(HEALTH_CHECK_PATH, respond);
healthRouter.get(HEALTH_ALIAS_PATH, respond);
