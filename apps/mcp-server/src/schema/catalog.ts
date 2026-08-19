/**
 * The schema catalog — what `get_schema` serves, and what the SQL guard checks
 * against.
 *
 * Contract source: docs/04 §2 (`get_schema(schema_version)` returns
 * tables/columns/relationships, cached per version) · ADR-014 (cache per
 * `schema_version`, not per school — 3–5 live versions across 1,500 databases) ·
 * ADR-026 (the schema block is the prompt-cache payload, the single biggest AI
 * cost lever).
 *
 * -- Why the catalog is also the allowlist ------------------------------------
 * The obvious reading of ADR-014 is that this document exists for the AI's
 * benefit. It has a second job. docs/04 §3 rail 2 requires SELECT-only AST
 * validation, and a validator needs to know which tables a query may name — a
 * statement reaching `mysql.user` or `information_schema` is syntactically a
 * perfect SELECT (@sap/shared identifiers.ts makes exactly this point about
 * syntax versus authorization).
 *
 * Deriving the allowlist from the same document the AI is shown means the model
 * cannot be told about a table it is not permitted to read, and cannot read a
 * table it was not told about. One source, so the two cannot drift.
 *
 * -- Tenant isolation is a property of the schema version ---------------------
 * ADR-009/docs/03 §1 assume one database per school. The first real ERP dataset
 * (`ai_analysis`) is a consolidated extract where all three St Marks schools
 * share one database, distinguished by a `school_db` column — option (a),
 * recorded in db/platform/seed/stmarks.sql. That is a materially weaker
 * isolation model, so it is named here as data rather than hidden in query code:
 * `tenant_isolation` says how a school is separated from its neighbours, the SQL
 * guard reads it, and nothing above the MCP layer is aware of the difference.
 * When production turns out to use per-school databases, this becomes
 * `database_per_school` and the injected predicate disappears — no other code
 * changes.
 */

import type { KnownPerm } from '@sap/shared';

/** Which domain permission (docs/02 §3 `perms[]`) governs a table or column. */
export type DataDomain = 'students' | 'fees' | 'staff' | 'reference';

/**
 * docs/08 §4.5: "Role/domain policies from `perms[]`: accountant → fees only".
 * `reference` data (the school's own name and code) is governed by scope alone.
 */
export const DOMAIN_PERM: Readonly<Record<DataDomain, KnownPerm | null>> = Object.freeze({
  students: 'students.read',
  fees: 'fees.read',
  staff: 'staff.read',
  reference: null,
});

export interface CatalogColumn {
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  /**
   * Set when the column identifies a person (docs/04 §3 rail 6, docs/08 §4.4).
   * The value is the domain whose read permission unmasks it — a student's name
   * appearing in a fee table is still student PII, which is precisely the case
   * an accountant-only session must not see in the clear.
   */
  readonly pii?: 'students' | 'staff';
}

export interface CatalogTable {
  readonly name: string;
  readonly description: string;
  readonly domain: DataDomain;
  readonly columns: readonly CatalogColumn[];
}

/** How rows of one school are separated from another's, for this version. */
export type TenantIsolation =
  | {
      readonly mode: 'shared_database';
      /**
       * The discriminator column. Every catalog table must carry it; the SQL
       * guard injects `WHERE <column> = ?` as a BOUND parameter around every
       * table reference in the statement.
       */
      readonly column: string;
    }
  | { readonly mode: 'database_per_school' };

export interface JoinHint {
  readonly from: string;
  readonly to: string;
  readonly on: readonly string[];
  readonly note?: string;
}

export interface SchemaCatalog {
  readonly schema_version: string;
  readonly description: string;
  readonly tenant_isolation: TenantIsolation;
  readonly tables: readonly CatalogTable[];
  readonly joins: readonly JoinHint[];
  /** Stated to the model so it does not plan queries the guard will reject. */
  readonly rules: readonly string[];
}

/** Case-insensitive table lookup — MySQL identifiers are not case-sensitive here. */
export function findTable(catalog: SchemaCatalog, table: string): CatalogTable | undefined {
  const wanted = table.toLowerCase();
  return catalog.tables.find((t) => t.name.toLowerCase() === wanted);
}

/** Column lookup within a table, for mapping result fields back to PII rules. */
export function findColumn(
  table: CatalogTable,
  column: string,
): CatalogColumn | undefined {
  const wanted = column.toLowerCase();
  return table.columns.find((c) => c.name.toLowerCase() === wanted);
}
