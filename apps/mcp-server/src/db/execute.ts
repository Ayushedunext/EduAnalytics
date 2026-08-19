/**
 * The execution path.
 *
 * [MANDATORY] CODING_GUIDELINES §7 fixes this sequence and forbids any code path
 * that skips a step, "including 'trusted' predefined SQL — the rails apply
 * uniformly (ADR-008)":
 *
 *     scope check (scope.ts, before this module is reached)
 *       -> AST validation + parameter binding + row cap   (sql/guard.ts)
 *       -> rate limit + circuit breaker                   (here)
 *       -> tenant resolution: registry -> secret -> pool  (here)
 *       -> replica, with a time cap at two layers         (here)
 *       -> PII masking                                    (sql/mask.ts)
 *       -> audit                                          (audit.ts)
 *
 * Uniformity is the whole point, so this module takes a `PreparedSelect` and
 * nothing else. There is no overload that accepts a string: predefined SQL, AI
 * SQL and hand-edited SQL become executable the same way or not at all.
 *
 * -- Why the time cap is applied twice ----------------------------------------
 * docs/04 §3 rail 4 says "10 s timeout (`max_execution_time` hint + driver
 * timeout)", and both halves are load bearing. `max_execution_time` stops the
 * SERVER, which is what protects the replica other schools share; it does not
 * cover a connection that stops answering, and a request waiting forever on a
 * silent socket still holds one of the three connections this school gets. The
 * client-side deadline covers that case, and destroys the connection rather than
 * returning it to the pool, because a connection whose result set was abandoned
 * mid-flight cannot safely serve the next query.
 */

import type { FieldPacket, Pool, PoolConnection } from 'mysql2/promise';
import { ERROR_CODES, PlatformError, type AuditSink } from '@sap/shared';
import { config } from '../config.js';
import { maskRows } from '../sql/mask.js';
import type { PreparedSelect } from '../sql/guard.js';
import type { SchemaCatalog } from '../schema/catalog.js';
import { consumeQueryBudget } from '../rate-limit.js';
import { assertClosed, recordFailure, recordSuccess } from './breaker.js';
import { getPool } from './pools.js';
import { resolveConnectionTarget } from './registry.js';

export interface QueryOutcome {
  readonly school_id: string;
  readonly rows: readonly Record<string, unknown>[];
  readonly columns: readonly string[];
  /** True when the row cap stopped the result short of the full answer. */
  readonly truncated: boolean;
  readonly masked_columns: readonly string[];
  readonly duration_ms: number;
  /** docs/09: replicas lag by seconds, so every result says when it is from. */
  readonly as_of: string;
}

export async function executePrepared(args: {
  readonly schoolId: string;
  readonly prepared: PreparedSelect;
  readonly catalog: SchemaCatalog;
  readonly tool: string;
  readonly perms: readonly string[];
  readonly audit: AuditSink;
  readonly actorSub: string;
  readonly orgId: string;
  readonly correlationId: string;
}): Promise<QueryOutcome> {
  // Fairness and blast radius first: a school that is over budget or already
  // failing should not reach a connection at all.
  assertClosed(args.schoolId);
  consumeQueryBudget(args.schoolId);

  const target = await resolveConnectionTarget(args.schoolId);
  const pool = await getPool(target.tenant, target.secretArn);

  const startedAt = Date.now();
  let rows: Record<string, unknown>[];
  let fields: FieldPacket[];
  try {
    ({ rows, fields } = await runWithDeadline(pool, args.prepared));
    recordSuccess(args.schoolId);
  } catch (err) {
    /**
     * Only infrastructure failures move the breaker. A statement the database
     * refuses is a caller problem, and counting it would let one bad report take
     * a healthy school offline (see db/breaker.ts).
     */
    if (isInfrastructureFailure(err)) recordFailure(args.schoolId);
    throw err;
  }
  const durationMs = Date.now() - startedAt;

  // One row beyond the cap was requested, so truncation is observed, not guessed.
  const truncated = rows.length > args.prepared.rowCap;
  const capped = truncated ? rows.slice(0, args.prepared.rowCap) : rows;

  const masked = maskRows({
    rows: capped,
    fields,
    catalog: args.catalog,
    perms: args.perms,
  });

  /**
   * [MANDATORY] docs/08 §7: "Every executed SQL — statement, school_id, caller,
   * rows returned, duration". Awaited, not fired and forgotten: an audit write
   * racing the response is an audit write that goes missing under load, and
   * §13 makes this part of the feature rather than an accompaniment to it.
   */
  await args.audit.write({
    kind: 'sql.executed',
    at: new Date().toISOString(),
    actor_sub: args.actorSub,
    org_id: args.orgId,
    correlation_id: args.correlationId,
    school_id: args.schoolId,
    // The rewritten statement — what the database was actually asked to do.
    statement: args.prepared.sql,
    rows_returned: masked.rows.length,
    duration_ms: durationMs,
    tool: args.tool,
    truncated,
  });

  return {
    school_id: args.schoolId,
    rows: masked.rows,
    columns: fields.map((field) => field.name),
    truncated,
    masked_columns: masked.maskedColumns,
    duration_ms: durationMs,
    as_of: new Date().toISOString(),
  };
}

async function runWithDeadline(
  pool: Pool,
  prepared: PreparedSelect,
): Promise<{ rows: Record<string, unknown>[]; fields: FieldPacket[] }> {
  const connection: PoolConnection = await pool.getConnection();
  let settled = false;

  try {
    /**
     * Server-side cap. MySQL 8 applies `max_execution_time` to read-only
     * SELECTs, which is exactly the statement class this server sends. Set per
     * connection because pooled connections outlive a request and must not
     * inherit a previous caller's session state.
     */
    await connection.query('SET SESSION max_execution_time = ?', [config.QUERY_TIMEOUT_MS]);

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new PlatformError({
            code: ERROR_CODES.QUERY_TIMEOUT,
            message: `The query took longer than ${String(
              config.QUERY_TIMEOUT_MS / 1000,
            )} seconds and was stopped.`,
            details: { timeout_ms: config.QUERY_TIMEOUT_MS },
          }),
        );
      }, config.QUERY_TIMEOUT_MS + 500);
    });

    try {
      /**
       * Named placeholders: the guard binds the tenant key and any predefined
       * report's filters BY NAME, so nothing here depends on the order clauses
       * render in (sql/guard.ts, TENANT_PARAM).
       *
       * The cast is a typings gap, not a behaviour change: mysql2 supports an
       * object of values when `namedPlaceholders` is set, but its `execute`
       * overloads only model the positional array form.
       */
      const executeNamed = connection.execute.bind(connection) as unknown as (
        options: { sql: string; namedPlaceholders: true },
        values: Record<string, unknown>,
      ) => Promise<[Record<string, unknown>[], FieldPacket[]]>;

      const query = executeNamed(
        { sql: prepared.sql, namedPlaceholders: true },
        { ...prepared.params },
      );
      const [rows, fields] = (await Promise.race([query, deadline])) as [
        Record<string, unknown>[],
        FieldPacket[],
      ];
      settled = true;
      return { rows, fields };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch (err) {
    throw translateDriverError(err);
  } finally {
    /**
     * A connection whose query is still in flight cannot be reused — the next
     * caller would read this one's rows. Destroy it and let the pool open a
     * fresh one; that cost is paid only on the timeout path.
     */
    if (settled) connection.release();
    else connection.destroy();
  }
}

/** MySQL's own timeout, surfaced as the platform's timeout error. */
const MYSQL_EXEC_TIMEOUT_ERRNOS = new Set([3024]);

function translateDriverError(err: unknown): unknown {
  if (err instanceof PlatformError) return err;
  const errno = (err as { errno?: unknown }).errno;
  if (typeof errno === 'number' && MYSQL_EXEC_TIMEOUT_ERRNOS.has(errno)) {
    return new PlatformError({
      code: ERROR_CODES.QUERY_TIMEOUT,
      message: `The query took longer than ${String(
        config.QUERY_TIMEOUT_MS / 1000,
      )} seconds and was stopped.`,
      details: { timeout_ms: config.QUERY_TIMEOUT_MS },
      cause: err,
    });
  }
  /**
   * Everything else becomes a generic data-plane failure. CODING_GUIDELINES §6
   * forbids leaking SQL, hostnames or driver text to a caller; the driver's
   * message goes to `diagnostics`, which `toWireError()` drops.
   */
  return new PlatformError({
    code: ERROR_CODES.TENANT_UNAVAILABLE,
    message: 'The query could not be completed against this school right now.',
    diagnostics: { driver_error: err instanceof Error ? err.message : String(err) },
    cause: err,
  });
}

/**
 * Which failures indicate the SCHOOL is unhealthy, as opposed to the request
 * being wrong. Only the former should open a circuit breaker.
 */
function isInfrastructureFailure(err: unknown): boolean {
  if (!(err instanceof PlatformError)) return true;
  return (
    err.code === ERROR_CODES.TENANT_UNAVAILABLE || err.code === ERROR_CODES.QUERY_TIMEOUT
  );
}
