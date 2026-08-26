/**
 * `report_definitions` / `report_definition_versions` reads and writes.
 *
 * Contract: db/platform/migrations/0007_report_definitions.sql · ADR-018 ·
 * CODING_GUIDELINES §5 ("platform-owned DBs ... are accessed by their owning
 * service only" — that service is services/custom-reports.ts, and this is its
 * ONLY data-access module for these two tables).
 *
 * [MANDATORY] CODING_GUIDELINES §3: rows read back from our own database are
 * still external input at the service boundary — `def_json` is validated by
 * the caller (services/custom-reports.ts's `reportDefSchema`), never trusted
 * here as a domain type. This module's job is the SQL, not the shape.
 */

import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2';
import { platformDb } from './platform-db.js';

export interface ReportDefinitionRow {
  readonly id: string;
  readonly org_id: string;
  readonly owner_sub: string;
  readonly name: string;
  readonly base_report_id: string | null;
  readonly source_kind: 'predefined_clone' | 'ai_saved';
  readonly school_scope: readonly string[];
  readonly shared_flag: 'private' | 'school' | 'trust';
  readonly current_version: number;
  readonly def_json: unknown;
  readonly sql_text: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** JSON columns come back parsed from mysql2 in practice, but never assumed. */
function parseJsonColumn(value: unknown): unknown {
  return typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
}

function toRow(raw: RowDataPacket): ReportDefinitionRow {
  return {
    id: String(raw['id']),
    org_id: String(raw['org_id']),
    owner_sub: String(raw['owner_sub']),
    name: String(raw['name']),
    base_report_id: raw['base_report_id'] === null ? null : String(raw['base_report_id']),
    source_kind: raw['source_kind'] as ReportDefinitionRow['source_kind'],
    school_scope: parseJsonColumn(raw['school_scope']) as readonly string[],
    shared_flag: raw['shared_flag'] as ReportDefinitionRow['shared_flag'],
    current_version: Number(raw['current_version']),
    def_json: parseJsonColumn(raw['def_json']),
    sql_text: String(raw['sql_text']),
    created_at: new Date(raw['created_at'] as string).toISOString(),
    updated_at: new Date(raw['updated_at'] as string).toISOString(),
  };
}

const SELECT_COLUMNS =
  'id, org_id, owner_sub, name, base_report_id, source_kind, school_scope, shared_flag, current_version, def_json, sql_text, created_at, updated_at';

export async function insertReportDefinition(args: {
  orgId: string;
  ownerSub: string;
  name: string;
  baseReportId: string | null;
  sourceKind: 'predefined_clone' | 'ai_saved';
  schoolScope: readonly string[];
  defJson: unknown;
  sqlText: string;
}): Promise<ReportDefinitionRow> {
  const id = randomUUID();
  const conn = await platformDb.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `INSERT INTO report_definitions
         (id, org_id, owner_sub, name, base_report_id, source_kind, school_scope,
          shared_flag, current_version, def_json, sql_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'private', 1, ?, ?)`,
      [
        id,
        args.orgId,
        args.ownerSub,
        args.name,
        args.baseReportId,
        args.sourceKind,
        JSON.stringify(args.schoolScope),
        JSON.stringify(args.defJson),
        args.sqlText,
      ],
    );
    await conn.execute(
      `INSERT INTO report_definition_versions (report_id, version, def_json, sql_text, edited_by)
       VALUES (?, 1, ?, ?, ?)`,
      [id, JSON.stringify(args.defJson), args.sqlText, args.ownerSub],
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  const created = await getReportDefinition(id);
  if (created === undefined) throw new Error('unreachable: just-inserted report definition not found');
  return created;
}

export async function getReportDefinition(id: string): Promise<ReportDefinitionRow | undefined> {
  const [rows] = await platformDb.query<RowDataPacket[]>(
    `SELECT ${SELECT_COLUMNS} FROM report_definitions WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  const row = rows[0];
  return row === undefined ? undefined : toRow(row);
}

/**
 * My Reports: everything this user owns (any visibility) plus anything shared
 * to `school`/`trust` within the org. Scope filtering on the SHARED set
 * happens in the service layer against the viewer's token scope (A8) — this
 * query only decides ownership/visibility, never school membership, because
 * `school_scope` is JSON and is not indexable the way `owner_sub` is.
 */
export async function listReportDefinitions(args: {
  orgId: string;
  ownerSub: string;
}): Promise<ReportDefinitionRow[]> {
  const [rows] = await platformDb.query<RowDataPacket[]>(
    `SELECT ${SELECT_COLUMNS} FROM report_definitions
       WHERE org_id = ? AND deleted_at IS NULL
         AND (owner_sub = ? OR shared_flag <> 'private')
       ORDER BY updated_at DESC`,
    [args.orgId, args.ownerSub],
  );
  return rows.map(toRow);
}

/** Bumps `current_version`, updates the row, and appends the version history entry — one transaction. */
export async function saveNewVersion(args: {
  id: string;
  defJson: unknown;
  sqlText: string;
  editedBy: string;
  /** For rollback: the version being restored, so the version row can record it was a revert. */
  name?: string;
}): Promise<ReportDefinitionRow> {
  const conn = await platformDb.getConnection();
  try {
    await conn.beginTransaction();
    const [current] = await conn.query<RowDataPacket[]>(
      `SELECT current_version FROM report_definitions WHERE id = ? AND deleted_at IS NULL FOR UPDATE`,
      [args.id],
    );
    const row = current[0];
    if (row === undefined) {
      throw new Error(`report definition ${args.id} not found`);
    }
    const nextVersion = Number(row['current_version']) + 1;

    await conn.execute(
      `INSERT INTO report_definition_versions (report_id, version, def_json, sql_text, edited_by)
       VALUES (?, ?, ?, ?, ?)`,
      [args.id, nextVersion, JSON.stringify(args.defJson), args.sqlText, args.editedBy],
    );
    await conn.execute(
      `UPDATE report_definitions
          SET def_json = ?, sql_text = ?, current_version = ?${args.name === undefined ? '' : ', name = ?'}
        WHERE id = ?`,
      args.name === undefined
        ? [JSON.stringify(args.defJson), args.sqlText, nextVersion, args.id]
        : [JSON.stringify(args.defJson), args.sqlText, nextVersion, args.name, args.id],
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  const updated = await getReportDefinition(args.id);
  if (updated === undefined) throw new Error('unreachable: just-updated report definition not found');
  return updated;
}

export interface ReportDefinitionVersionRow {
  readonly version: number;
  readonly def_json: unknown;
  readonly sql_text: string;
  readonly edited_by: string;
  readonly edited_at: string;
}

export async function listVersions(reportId: string): Promise<ReportDefinitionVersionRow[]> {
  const [rows] = await platformDb.query<RowDataPacket[]>(
    `SELECT version, def_json, sql_text, edited_by, edited_at
       FROM report_definition_versions WHERE report_id = ? ORDER BY version DESC`,
    [reportId],
  );
  return rows.map((r) => ({
    version: Number(r['version']),
    def_json: parseJsonColumn(r['def_json']),
    sql_text: String(r['sql_text']),
    edited_by: String(r['edited_by']),
    edited_at: new Date(r['edited_at'] as string).toISOString(),
  }));
}

export async function getVersion(
  reportId: string,
  version: number,
): Promise<ReportDefinitionVersionRow | undefined> {
  const [rows] = await platformDb.query<RowDataPacket[]>(
    `SELECT version, def_json, sql_text, edited_by, edited_at
       FROM report_definition_versions WHERE report_id = ? AND version = ?`,
    [reportId, version],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    version: Number(row['version']),
    def_json: parseJsonColumn(row['def_json']),
    sql_text: String(row['sql_text']),
    edited_by: String(row['edited_by']),
    edited_at: new Date(row['edited_at'] as string).toISOString(),
  };
}

export async function setVisibility(
  id: string,
  sharedFlag: 'private' | 'school' | 'trust',
): Promise<void> {
  await platformDb.execute(
    `UPDATE report_definitions SET shared_flag = ? WHERE id = ? AND deleted_at IS NULL`,
    [sharedFlag, id],
  );
}

/** Soft delete — the version history is kept (§13: audit is not deletable). */
export async function softDeleteReportDefinition(id: string): Promise<void> {
  await platformDb.execute(
    `UPDATE report_definitions SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
}
