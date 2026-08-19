/**
 * One SELECT, against one school, all rails applied.
 *
 * [MANDATORY] CODING_GUIDELINES §7 fixes the execution path and forbids any code
 * path that skips a step. This function is that path, and it is the only one:
 * `run_query`, `run_multi` and `get_dimensions` all come through here, so there
 * is no per-tool variation in how a statement is validated, scoped, capped,
 * limited or audited. A future `run_predefined` and the drill endpoint (ADR-020)
 * join the same funnel — "the rails apply uniformly, including 'trusted'
 * predefined SQL".
 *
 * Scope is deliberately NOT checked here. It is checked by the tool handler,
 * before this is reached, so that a scope violation costs no registry lookup and
 * no connection — and so that the check is visibly the first thing a tool does
 * rather than a side effect buried in an execution helper.
 */

import { ERROR_CODES, PlatformError } from '@sap/shared';
import { config } from './config.js';
import { getCatalog } from './schema/index.js';
import { executePrepared, type QueryOutcome } from './db/execute.js';
import { resolveConnectionTarget } from './db/registry.js';
import { prepareSelect } from './sql/guard.js';
import type { ToolContext } from './scope.js';

export async function runScopedSelect(args: {
  readonly context: ToolContext;
  /** Already proven ⊆ the session's allowed set by the calling tool. */
  readonly schoolId: string;
  readonly sql: string;
  readonly tool: string;
}): Promise<QueryOutcome> {
  const target = await resolveConnectionTarget(args.schoolId);
  const catalog = getCatalog(target.tenant.schema_version);
  if (catalog === undefined) {
    /**
     * ADR-014's stated trade-off, surfaced rather than absorbed: "a school on a
     * hotfixed schema must be assigned a version honestly". Falling back to
     * another version's catalog would validate the query against a schema this
     * school does not have.
     */
    throw new PlatformError({
      code: ERROR_CODES.TENANT_UNAVAILABLE,
      message: 'Analytics has no schema document for this school yet.',
      diagnostics: {
        school_id: args.schoolId,
        schema_version: target.tenant.schema_version,
      },
    });
  }

  const prepared = prepareSelect({
    sql: args.sql,
    catalog,
    /** From the registry. Never from the caller, never from the model. */
    tenantKey: target.tenant.tenant_key,
    perms: args.context.call.perms,
    rowCap: config.ROW_CAP,
  });

  return executePrepared({
    schoolId: args.schoolId,
    prepared,
    catalog,
    tool: args.tool,
    perms: args.context.call.perms,
    audit: args.context.audit,
    actorSub: args.context.call.sub,
    orgId: args.context.call.org_id,
    correlationId: args.context.call.correlation_id,
  });
}
