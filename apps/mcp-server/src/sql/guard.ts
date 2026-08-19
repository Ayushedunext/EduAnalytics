/**
 * The SQL guard: the only way a statement becomes executable.
 *
 * Contract source: ADR-008 (read-only data plane) · docs/04 §3 rails 2 and 4 ·
 * CODING_GUIDELINES §7 [MANDATORY]: "SQL execution path: AST validation (single
 * statement, SELECT-only) -> parameter binding -> row cap 5,000 -> timeout 10 s
 * -> replica pool. No code path may skip a step, including 'trusted' predefined
 * SQL."
 *
 * That last clause is why validation, tenant filtering and capping live in ONE
 * function returning ONE opaque result rather than three helpers a caller
 * composes. A caller cannot skip a step it was never offered, and `prepareSelect`
 * is the only producer of the shape the executor accepts. Guardrails as
 * mechanism, not as discipline (PROJECT_CONTEXT §9.3).
 *
 * -- What this guard does ----------------------------------------------------
 *   1. parses one statement (multi-statement payloads are rejected outright)
 *   2. proves it is a SELECT, with no CTE, no locking read, no SELECT ... INTO,
 *      no placeholders and no denylisted function
 *   3. proves every table it names exists in the schema catalog, and that the
 *      session holds the domain permission that table requires
 *   4. rewrites every base-table reference into a tenant-filtered derived table
 *      with the school BOUND as a parameter
 *   5. clamps the row cap into the statement itself, so MySQL stops producing
 *      rows rather than the server discarding them after transport
 *   6. re-parses its own output and proves postconditions 3 and 4 hold there
 *
 * Step 6 exists because steps 3 and 4 walk an AST whose shape belongs to a third
 * party. If a construct this walk does not recognise ever carried a table
 * reference past it, the failure would be silent and it would be a cross-tenant
 * read — the worst outcome this system has. So the output is checked as data
 * rather than trusted as a consequence of the code being correct.
 *
 * -- Why the tenant filter is a rewrite --------------------------------------
 * Only under `tenant_isolation.mode === 'shared_database'` (option (a); see
 * schema/erp-v1.ts). There the database gives no isolation at all, so the MCP
 * server must, and appending `AND school_db = ?` to a WHERE clause would miss
 * joins, subqueries and derived tables. Wrapping each table reference means the
 * filter cannot be escaped by the shape of the query around it.
 *
 * -- Why no caller parameters ------------------------------------------------
 * docs/04 §2 gives `run_query(school_id, sql)` and `run_multi(school_ids[], sql,
 * merge)` — neither takes parameters; only `run_predefined` does. That is load
 * bearing here, not incidental: because every placeholder in the final statement
 * is one this guard injected, and all of them bind the same value, the parameter
 * array cannot be mis-ordered. A caller-supplied placeholder would make ordering
 * depend on where the driver renders each clause, so caller placeholders are
 * rejected (rule stated in the catalog, enforced here).
 */

/**
 * node-sql-parser ships a webpack-bundled CommonJS entry point with no export
 * map, so Node's ESM named-export detection cannot see `Parser` and only the
 * synthetic default import works. Destructured here once rather than at each
 * use so the interop quirk stays in one place.
 */
import sqlParser from 'node-sql-parser';

const { Parser } = sqlParser;
import { ERROR_CODES, PlatformError, quoteMySqlIdentifier } from '@sap/shared';
import { DOMAIN_PERM, findTable, type SchemaCatalog } from '../schema/catalog.js';

const PARSER_OPTIONS = { database: 'MySQL' } as const;
const parser = new Parser();

/**
 * The AST is treated as opaque, structurally-typed data (`Node` below) rather
 * than through the parser's published `AST` union. The union describes the
 * shapes the library documents; this module walks shapes it does not, including
 * the parser-internal bookkeeping a derived table carries. Adapting at these two
 * boundaries keeps every cast in one place instead of scattering them through
 * the walk.
 */
const astify = (sql: string): unknown => parser.astify(sql, PARSER_OPTIONS) as unknown;
const sqlify = (ast: Node): string =>
  parser.sqlify(ast as unknown as Parameters<typeof parser.sqlify>[0], PARSER_OPTIONS);

/**
 * Functions that are valid SELECT syntax and are not analytics.
 *
 * SLEEP and BENCHMARK are how a capped query becomes a denial of service inside
 * its own time budget; LOAD_FILE and the lock functions reach outside the result
 * set entirely. `analytics_ro` should hold no FILE privilege (ADR-008), so this
 * is a second layer over a grant — the same belt-and-braces reasoning that pairs
 * SELECT-only validation with a read-only user.
 */
const DENIED_FUNCTIONS = new Set([
  'sleep',
  'benchmark',
  'load_file',
  'get_lock',
  'release_lock',
  'is_free_lock',
  'is_used_lock',
  'master_pos_wait',
  'source_pos_wait',
  'sys_exec',
]);

/** A statement longer than this is not a report query; it is an attack surface. */
const MAX_SQL_LENGTH = 20_000;

/**
 * The name the tenant filter binds under.
 *
 * NAMED rather than positional, and that is the whole reason predefined reports
 * can carry their own parameters at all. With positional `?`, the order of the
 * final statement's placeholders would depend on where the renderer emits each
 * clause relative to the derived tables this guard injects — knowable, but a
 * silent corruption if ever wrong, and "the wrong school's rows under the right
 * heading" is the worst shape that bug could take. Binding by name makes the
 * question disappear: mysql2 maps names to positions itself, so a report author
 * cannot mis-order what they never ordered.
 *
 * Reserved: a report declaring a parameter of this name is rejected, so caller
 * input can never occupy the slot the tenant filter binds.
 */
export const TENANT_PARAM = 'sap_tenant_key';

export interface PreparedSelect {
  /** Rewritten, capped, ready for the driver. Never the caller's original text. */
  readonly sql: string;
  /**
   * Bound values by name: the tenant key the server injected, plus whatever the
   * predefined report declared. Executed with mysql2's named placeholders, so
   * nothing here depends on the order clauses happen to render in.
   */
  readonly params: Readonly<Record<string, unknown>>;
  /** Catalog table names the statement reads — for the audit record. */
  readonly tables: readonly string[];
  /** Rows beyond this are never fetched; `rowCap + 1` is requested to detect it. */
  readonly rowCap: number;
}

function reject(message: string, diagnostics?: Record<string, unknown>): never {
  throw new PlatformError({
    code: ERROR_CODES.SQL_REJECTED,
    /**
     * Client-visible, and deliberately says WHAT was refused without echoing the
     * statement: CODING_GUIDELINES §6 forbids leaking SQL in error payloads, and
     * the AI needs the reason in order to re-plan (docs/05).
     */
    message: `Query rejected: ${message}`,
    ...(diagnostics === undefined ? {} : { diagnostics }),
  });
}

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A `from` entry that names a base table, as opposed to a derived table. */
function isBaseTableEntry(entry: unknown): entry is Node & { table: string } {
  return isNode(entry) && typeof entry['table'] === 'string' && entry['expr'] === undefined;
}

export function prepareSelect(args: {
  readonly sql: string;
  readonly catalog: SchemaCatalog;
  /**
   * The registry-resolved row-level discriminator (`tenant_key`, docs/02 §5).
   * Never caller-supplied, and deliberately not derived from `school_id`. Null
   * only when the schema version isolates tenants by database, in which case
   * nothing is injected.
   */
  readonly tenantKey: string | null;
  readonly perms: readonly string[];
  readonly rowCap: number;
  /**
   * Values for a PREDEFINED report's declared parameters (docs/04 §2:
   * `run_predefined(report_id, school_ids[], params)`). Absent for
   * `run_query`/`run_multi`, whose contracts take no parameters — and when
   * absent, any parameter in the statement is rejected outright rather than
   * left unbound.
   */
  readonly declaredParams?: Readonly<Record<string, string | number | null>>;
}): PreparedSelect {
  const raw = args.sql.trim();
  if (raw === '') reject('the statement is empty');
  if (raw.length > MAX_SQL_LENGTH) {
    reject(`the statement exceeds ${String(MAX_SQL_LENGTH)} characters`);
  }

  // ── 1. Parse. One statement only. ────────────────────────────────────────
  let parsed: { ast: unknown; tableList: string[] };
  try {
    parsed = parser.parse(raw, PARSER_OPTIONS) as unknown as { ast: unknown; tableList: string[] };
  } catch (err) {
    reject('it is not valid MySQL, or it is not a single SELECT statement', {
      parser_error: err instanceof Error ? err.message : String(err),
    });
  }
  if (Array.isArray(parsed.ast)) {
    reject('multi-statement payloads are not accepted; send one SELECT');
  }
  const ast = parsed.ast;
  if (!isNode(ast) || ast['type'] !== 'select') {
    reject('only SELECT statements are accepted');
  }

  /**
   * The parser's own inventory, in `operation::db::table` form. Checked as well
   * as the walk because it sees the whole statement at once: an operation other
   * than `select` here means a write hid somewhere the top-level type check
   * would not reach.
   */
  for (const entry of parsed.tableList) {
    const [operation] = entry.split('::');
    if (operation !== 'select') {
      reject('the statement performs a write; the data plane is read-only');
    }
  }

  // ── 2/3/4. Walk: validate, then rewrite from the inside out. ─────────────
  const isolation = args.catalog.tenant_isolation;
  const scopeColumn = isolation.mode === 'shared_database' ? isolation.column : null;

  /**
   * Fail loud rather than fall back. A schema version that isolates tenants by
   * column, on a school whose registry row has no `tenant_key`, is a
   * misconfiguration; guessing a value (`school_id` is the tempting one) would
   * answer plausibly about the wrong school — or, if the guess matched nothing,
   * about no school while looking like a real empty result.
   */
  if (scopeColumn !== null && args.tenantKey === null) {
    throw new PlatformError({
      code: ERROR_CODES.TENANT_UNAVAILABLE,
      message: 'This school is not correctly configured for analytics and cannot be queried.',
      diagnostics: {
        reason: 'schema version isolates tenants by column but the registry row has no tenant_key',
        schema_version: args.catalog.schema_version,
      },
    });
  }

  const tablesUsed = new Set<string>();
  const usedParams = new Set<string>();
  let wrapCount = 0;

  /**
   * The wrapper is lifted whole from a parsed template rather than assembled by
   * hand. A derived table carries parser-internal bookkeeping (`parentheses`,
   * among others) that the renderer needs and that is not part of any published
   * AST contract — an object built to look right renders as
   * `FROM SELECT * FROM t ...`, which is not valid SQL. Parsing the exact shape
   * we want and cloning it keeps this correct across parser versions.
   */
  const scopeTemplate =
    scopeColumn === null
      ? null
      : ((
          astify(
            `SELECT * FROM (SELECT * FROM placeholder_table WHERE ${quoteMySqlIdentifier(
              scopeColumn,
            )} = :${TENANT_PARAM}) AS placeholder_alias`,
          ) as Node
        )['from'] as Node[])[0]!;

  function wrapBaseTable(entry: Node & { table: string }, canonicalTable: string): Node {
    if (scopeTemplate === null) return entry;
    const wrapper = structuredClone(scopeTemplate);
    const expr = wrapper['expr'] as Node;
    // Stale inventories describing the template's placeholder table; the real
    // inventory is `tablesUsed`, and leaving a wrong one behind invites a future
    // reader to trust it.
    delete expr['tableList'];
    delete expr['columnList'];
    ((expr['ast'] as Node)['from'] as Node[])[0]!['table'] = canonicalTable;
    /**
     * Keep the caller's alias if it had one, otherwise alias with the table's
     * own name — without that, `students_data_set.classname` elsewhere in the
     * statement would stop resolving.
     */
    wrapper['as'] = (entry['as'] as string | null | undefined) ?? entry['table'];
    for (const key of ['join', 'on', 'using'] as const) {
      if (entry[key] !== undefined && entry[key] !== null) wrapper[key] = entry[key];
    }
    wrapCount += 1;
    return wrapper;
  }

  function checkTable(entry: Node & { table: string }): string {
    if (entry['db'] !== null && entry['db'] !== undefined) {
      reject(
        'tables must not be qualified with a database name; the tenant database is chosen by the server',
      );
    }
    const table = findTable(args.catalog, entry['table']);
    if (table === undefined) {
      reject(`table "${entry['table']}" is not in the schema catalog for this schema version`);
    }
    const required = DOMAIN_PERM[table.domain];
    if (required !== null && !args.perms.includes(required)) {
      /**
       * docs/08 §4.5: "accountant -> fees only". A domain the session does not
       * hold is refused here rather than masked: masking a table you may not
       * read at all would still disclose how many rows it has.
       */
      throw new PlatformError({
        code: ERROR_CODES.PERMISSION_DENIED,
        message: `This session does not have access to ${table.domain} data.`,
        details: { domain: table.domain, required_permission: required },
        diagnostics: { table: table.name },
      });
    }
    tablesUsed.add(table.name);
    return table.name;
  }

  function visit(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isNode(node)) return;

    const type = node['type'];
    if (type === 'origin' && node['value'] === '?') {
      /**
       * Positional placeholders are never accepted, from anyone. Predefined
       * reports bind by NAME (see TENANT_PARAM); a stray `?` would take a slot
       * whose position nothing in this file controls.
       */
      reject('positional placeholders (?) are not accepted; bind parameters by name');
    }
    if (type === 'param') {
      const name = node['value'];
      if (args.declaredParams === undefined) {
        reject('parameters are not accepted here; this statement carries its own values');
      }
      if (typeof name !== 'string' || name === '') {
        reject('a parameter must be named');
      }
      if (name === TENANT_PARAM) {
        // The slot the tenant filter binds. A report that could write into it
        // could choose its own tenant.
        reject(`the parameter name "${name}" is reserved`);
      }
      if (!Object.prototype.hasOwnProperty.call(args.declaredParams ?? {}, name)) {
        reject(`the statement uses an undeclared parameter ":${name}"`);
      }
      usedParams.add(name);
    }
    if (type === 'function' || type === 'aggr_func') checkFunctionName(node['name']);

    // Children first, so the wrappers created below are never revisited.
    for (const key of Object.keys(node)) visit(node[key]);

    if (type !== 'select') return;

    if (node['with'] !== null && node['with'] !== undefined) {
      reject('common table expressions (WITH ...) are not supported; use a subquery');
    }
    if (node['locking_read'] !== null && node['locking_read'] !== undefined) {
      reject('locking reads (FOR UPDATE / LOCK IN SHARE MODE) are not permitted on a replica');
    }
    const into = node['into'];
    if (isNode(into) && into['position'] !== null && into['position'] !== undefined) {
      reject('SELECT ... INTO is not permitted');
    }

    const from = node['from'];
    if (from === null || from === undefined) return; // e.g. SELECT 1
    if (!Array.isArray(from)) reject('unsupported FROM clause');

    node['from'] = from.map((entry: unknown) => {
      if (isBaseTableEntry(entry)) return wrapBaseTable(entry, checkTable(entry));
      if (isNode(entry) && entry['expr'] !== undefined) return entry; // already visited
      reject('unsupported FROM element');
    });
  }

  visit(ast);

  if (tablesUsed.size === 0) {
    reject('the statement reads no table from the schema catalog');
  }

  // ── 5. Row cap, pushed into the statement. ───────────────────────────────
  // One row beyond the cap is requested so truncation is a fact observed rather
  // than a coincidence assumed (docs/04 §3 rail 4).
  clampLimit(tailOfUnionChain(ast), args.rowCap + 1);

  const sql = sqlify(ast);

  const boundParams: Record<string, unknown> = {};
  if (scopeColumn !== null) boundParams[TENANT_PARAM] = args.tenantKey;
  for (const name of usedParams) boundParams[name] = args.declaredParams?.[name] ?? null;

  // ── 6. Postconditions, checked against the output. ───────────────────────
  verifyOutput({
    sql,
    catalog: args.catalog,
    scopeColumn,
    expectedWraps: wrapCount,
    allowedParams: usedParams,
  });

  return {
    sql,
    /**
     * Only the parameters the statement actually uses are bound. mysql2 errors
     * on a missing name but ignores extra ones, so filtering here turns a
     * report that declares a filter it forgot to apply into a visible mistake
     * rather than a silently ignored one.
     */
    params: Object.freeze(boundParams),
    tables: Object.freeze([...tablesUsed]),
    rowCap: args.rowCap,
  };
}

/** Function names appear as a string in some node shapes and a list in others. */
function checkFunctionName(name: unknown): void {
  const deny = (value: string): void => {
    if (DENIED_FUNCTIONS.has(value.toLowerCase())) {
      reject(`the function ${value} is not permitted`);
    }
  };
  if (typeof name === 'string') {
    deny(name);
    return;
  }
  if (!isNode(name)) return;
  const parts = name['name'];
  if (!Array.isArray(parts)) return;
  for (const part of parts) {
    const value = isNode(part) ? part['value'] : undefined;
    if (typeof value === 'string') deny(value);
  }
}

/** In a UNION chain MySQL attaches the trailing LIMIT to the last SELECT. */
function tailOfUnionChain(ast: Node): Node {
  let node = ast;
  while (isNode(node['_next'])) node = node['_next'] as Node;
  return node;
}

/**
 * Clamp, never widen. A caller asking for 10 rows gets 10; a caller asking for a
 * million, or asking for nothing at all, gets the cap.
 */
function clampLimit(node: Node, cap: number): void {
  const limit = node['limit'];
  if (limit === null || limit === undefined) {
    node['limit'] = { seperator: '', value: [{ type: 'number', value: cap }] };
    return;
  }
  if (!isNode(limit) || !Array.isArray(limit['value'])) reject('unsupported LIMIT clause');
  const values = limit['value'] as unknown[];
  if (values.length === 0 || values.length > 2) reject('unsupported LIMIT clause');
  // `LIMIT a, b` puts the row count second; `LIMIT b OFFSET a` puts it first.
  const index = values.length === 1 ? 0 : limit['seperator'] === ',' ? 1 : 0;
  const target = values[index];
  if (!isNode(target) || target['type'] !== 'number' || typeof target['value'] !== 'number') {
    reject('LIMIT must be a literal number');
  }
  if ((target['value'] as number) > cap) target['value'] = cap;
}

/**
 * Prove, from the rendered statement alone, that the guard did its job.
 *
 * Every base-table reference in the output must sit inside a wrapper this guard
 * built — `SELECT * FROM <catalog table> WHERE <scope column> = ?` and nothing
 * else. Anything else means a construct carried a table past the walk, and the
 * only safe answer to "I cannot account for my own output" is to refuse.
 */
function verifyOutput(args: {
  sql: string;
  catalog: SchemaCatalog;
  scopeColumn: string | null;
  expectedWraps: number;
  /** Parameter names the walk approved; anything else in the output is a bug. */
  allowedParams: ReadonlySet<string>;
}): void {
  let ast: unknown;
  try {
    ast = astify(args.sql);
  } catch (err) {
    reject('the server could not re-verify the rewritten statement', {
      parser_error: err instanceof Error ? err.message : String(err),
    });
  }

  let baseTableRefs = 0;
  let scopedWrappers = 0;
  let placeholders = 0;

  const isScopeWrapper = (node: Node): boolean => {
    if (args.scopeColumn === null) return false;
    const columns = node['columns'];
    const first = Array.isArray(columns) && columns.length === 1 ? columns[0] : undefined;
    const firstExpr = isNode(first) ? first['expr'] : undefined;
    const selectsStar = isNode(firstExpr) && firstExpr['column'] === '*';

    const where = node['where'];
    if (!isNode(where)) return false;
    const left = where['left'];
    const right = where['right'];
    const scoped =
      where['type'] === 'binary_expr' &&
      where['operator'] === '=' &&
      isNode(left) &&
      left['column'] === args.scopeColumn &&
      isNode(right) &&
      right['type'] === 'param' &&
      right['value'] === TENANT_PARAM;

    return selectsStar && scoped;
  };

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!isNode(node)) return;

    if (node['type'] === 'origin' && node['value'] === '?') {
      // Nothing in this pipeline emits a positional placeholder. One in the
      // output means the rewrite produced something the walk never saw.
      reject('the rewritten statement carries an unexpected positional placeholder');
    }
    if (node['type'] === 'param') {
      const name = node['value'];
      if (name === TENANT_PARAM) placeholders += 1;
      else if (typeof name !== 'string' || !args.allowedParams.has(name)) {
        reject('the rewritten statement carries an unexpected parameter');
      }
    }

    if (node['type'] === 'select' && Array.isArray(node['from'])) {
      const bases = (node['from'] as unknown[]).filter(isBaseTableEntry);
      baseTableRefs += bases.length;
      if (bases.length > 0) {
        for (const entry of bases) {
          if (findTable(args.catalog, entry.table) === undefined) {
            reject('the rewritten statement names a table outside the catalog');
          }
        }
        if (args.scopeColumn !== null) {
          if (bases.length === 1 && isScopeWrapper(node)) {
            scopedWrappers += 1;
          } else {
            reject('the server could not confirm the tenant filter on every table');
          }
        }
      }
    }

    for (const key of Object.keys(node)) walk(node[key]);
  };

  walk(ast);

  if (args.scopeColumn === null) return;
  if (scopedWrappers !== args.expectedWraps || baseTableRefs !== args.expectedWraps) {
    reject('the server could not confirm the tenant filter on every table', {
      expected_wraps: args.expectedWraps,
      scoped_wrappers: scopedWrappers,
      base_table_refs: baseTableRefs,
    });
  }
  if (placeholders !== args.expectedWraps) {
    reject('the tenant filter is not bound on every table', {
      expected: args.expectedWraps,
      found: placeholders,
    });
  }
}
