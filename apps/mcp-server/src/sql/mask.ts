/**
 * PII masking — docs/04 §3 rail 6.
 *
 * Contract source: docs/04 §3 rail 6 ("column-level masking applied unless the
 * session role permits") · docs/08 §4.4/§4.5 · ADR-028 (masking is role
 * dependent, which is why `permission_class` is part of every cache key).
 *
 * -- How a result column is traced back to a policy --------------------------
 * The obvious approach — matching output column names against a list — fails the
 * moment a query says `SELECT studentname AS n`. MySQL's result metadata carries
 * the origin of every column (`orgTable`, `orgName`) alongside its output name,
 * and it survives the derived-table rewrite the SQL guard performs. So the
 * mapping is taken from the server that produced the rows rather than inferred
 * from the text of the query, and an alias cannot be used to slip a masked
 * column past the check.
 *
 * A column MySQL reports no origin for — an expression, a literal, an aggregate
 * — is not a table column and carries no policy. Note the honest limit of that:
 * `SELECT CONCAT(studentname, '') AS n` reports no origin and is not masked.
 * Column-level masking is a control against ordinary reporting, not against a
 * caller deliberately laundering a column; the controls that stop THAT are the
 * domain-permission check in the guard (which refuses the table outright) and
 * the audit trail. Recording the limit here rather than implying completeness.
 *
 * -- Why masked results are still labelled -----------------------------------
 * `masked_columns` travels with the result. A number that quietly differs by who
 * asked is the "success-shaped failure" CODING_GUIDELINES §10 calls the worst bug
 * class in this system; a report that says which columns were masked is honest
 * about what the reader is looking at.
 */

import type { FieldPacket } from 'mysql2';
import { DOMAIN_PERM, findColumn, findTable, type SchemaCatalog } from '../schema/catalog.js';

/** What a masked value becomes. Constant, so it is obvious and unambiguous. */
export const MASKED_VALUE = '[masked]';

export interface MaskResult {
  readonly rows: readonly Record<string, unknown>[];
  /** Output column names that were masked, for display alongside the data. */
  readonly maskedColumns: readonly string[];
}

/**
 * Decide which output columns are masked for this session, then apply it.
 *
 * Returns the input rows untouched when nothing is masked, which is the common
 * case for a Principal or Director and avoids copying large result sets.
 */
export function maskRows(args: {
  readonly rows: readonly Record<string, unknown>[];
  readonly fields: readonly FieldPacket[];
  readonly catalog: SchemaCatalog;
  readonly perms: readonly string[];
}): MaskResult {
  const masked: string[] = [];

  for (const field of args.fields) {
    // `orgTable`/`orgName` are absent on computed columns — nothing to trace.
    const originTable = field.orgTable;
    const originColumn = field.orgName;
    if (
      typeof originTable !== 'string' ||
      originTable === '' ||
      typeof originColumn !== 'string' ||
      originColumn === ''
    ) {
      continue;
    }
    const table = findTable(args.catalog, originTable);
    if (table === undefined) continue;
    const column = findColumn(table, originColumn);
    if (column?.pii === undefined) continue;

    const required = DOMAIN_PERM[column.pii];
    if (required !== null && !args.perms.includes(required)) masked.push(field.name);
  }

  if (masked.length === 0) return { rows: args.rows, maskedColumns: [] };

  const maskedSet = new Set(masked);
  const rows = args.rows.map((row) => {
    const copy: Record<string, unknown> = { ...row };
    for (const name of maskedSet) {
      if (name in copy) copy[name] = MASKED_VALUE;
    }
    return copy;
  });

  return { rows, maskedColumns: [...maskedSet] };
}
