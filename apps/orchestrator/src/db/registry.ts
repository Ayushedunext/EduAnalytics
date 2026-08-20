/**
 * Tenant registry reads.
 *
 * Contract: docs/02 §5 (columns) · docs/03 §2 (resolution path, ~5 min cache) ·
 * ADR-005 ("the registry IS the configuration") · ADR-013.
 *
 * The orchestrator reads the registry for two things only:
 *   1. school NAMES, so scope can be shown on screen (docs/10 §3) and printed
 *      on PDFs -- the SPA is never trusted to supply them
 *   2. which schools are currently SERVABLE, so a suspended or missing school is
 *      dropped from scope with a visible notice (docs/02 §6)
 *
 * It does NOT resolve credentials or open school connections. That belongs to
 * the MCP server (ADR-006/013), which performs its own resolution.
 */

import type { RowDataPacket } from 'mysql2';
import { tenantRegistryRowSchema, type TenantRegistryRow } from '@sap/shared';
import { config } from '../config.js';
import { platformDb } from './platform-db.js';

interface CacheEntry {
  rows: Map<string, TenantRegistryRow>;
  loadedAt: number;
}

let cache: CacheEntry | null = null;

function isFresh(entry: CacheEntry): boolean {
  return (Date.now() - entry.loadedAt) / 1000 < config.REGISTRY_CACHE_TTL_SECONDS;
}

/**
 * Load and validate every registry row.
 *
 * [MANDATORY] CODING_GUIDELINES §3: ERP sync rows are external input and are
 * `unknown` until validated. Validating on read matters specifically because
 * db_name is interpolated into SQL as an identifier downstream, where a bound
 * parameter is not legal syntax -- so an unsafe value must never survive as far
 * as a validated object (@sap/shared identifiers.ts, §9).
 *
 * A row that fails validation is dropped with a loud operational log rather than
 * failing the whole load: one malformed school must not take the platform down
 * for every other tenant, and its absence surfaces to users as the documented
 * "dropped from scope with a notice" path (docs/02 §6).
 */
async function loadAll(): Promise<Map<string, TenantRegistryRow>> {
  const [raw] = await platformDb.query(
    `SELECT school_id, org_id, school_name, region, status,
            replica_host, db_name, secret_arn, schema_version, tenant_key
       FROM tenant_registry`,
  );

  const rows = new Map<string, TenantRegistryRow>();
  for (const candidate of raw as unknown[]) {
    const parsed = tenantRegistryRowSchema.safeParse(candidate);
    if (!parsed.success) {
      const id =
        typeof candidate === 'object' && candidate !== null && 'school_id' in candidate
          ? String((candidate as { school_id: unknown }).school_id)
          : '<unknown>';
      console.error(
        `[registry] rejecting malformed row for school_id=${id}: ` +
          parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '),
      );
      continue;
    }
    rows.set(parsed.data.school_id, parsed.data);
  }
  return rows;
}

async function current(): Promise<Map<string, TenantRegistryRow>> {
  if (cache !== null && isFresh(cache)) return cache.rows;
  const rows = await loadAll();
  cache = { rows, loadedAt: Date.now() };
  return rows;
}

export async function getSchool(schoolId: string): Promise<TenantRegistryRow | undefined> {
  return (await current()).get(schoolId);
}

/** School ids that exist and are active -- see docs/02 §6. */
export async function servableSchoolIds(): Promise<string[]> {
  const rows = await current();
  return [...rows.values()].filter((r) => r.status === 'active').map((r) => r.school_id);
}

/** Display names for a scope, in the order given. Unknown ids are omitted. */
export async function schoolNames(
  schoolIds: readonly string[],
): Promise<{ school_id: string; school_name: string }[]> {
  const rows = await current();
  return schoolIds
    .map((id) => rows.get(id))
    .filter((r): r is TenantRegistryRow => r !== undefined)
    .map((r) => ({ school_id: r.school_id, school_name: r.school_name }));
}

/** Drop the cache. Used by tests and, later, by the ERP sync webhook. */
export function invalidateRegistryCache(): void {
  cache = null;
}

/**
 * The org's display name.
 *
 * Read here rather than carried in the launch token: docs/02's token contract
 * has no org-name claim, and inventing one in the SPA would be the client
 * asserting an identity the server never gave it (CODING_GUIDELINES §8). Falls
 * back to the id, which is always true even when it is not pretty — a screen
 * saying "stmarks" is a worse label and a correct one.
 */
export async function orgName(orgId: string): Promise<string> {
  const [rows] = await platformDb.query<RowDataPacket[]>(
    'SELECT org_name FROM org_registry WHERE org_id = ?',
    [orgId],
  );
  const name = rows[0]?.['org_name'];
  return typeof name === 'string' && name !== '' ? name : orgId;
}
