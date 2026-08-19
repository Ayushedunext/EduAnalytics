/**
 * Tenant resolution, step 1: the Tenant Registry.
 *
 * Contract source: docs/03 §2 (registry lookup, ~5 min cache) · ADR-005 ("the
 * registry IS the configuration") · ADR-013.
 *
 * The orchestrator also reads this table, for school names and servability. It
 * reads different columns for a different purpose and deliberately cannot see
 * the ones here: `db_name`, `replica_host` and `secret_arn` are how a connection
 * is made, and ADR-006 puts connection-making in exactly one service. The shared
 * part — the row CONTRACT and its validation — comes from `@sap/shared`, so the
 * two readers cannot drift on what a registry row means (CODING_GUIDELINES §1).
 *
 * [MANDATORY] ADR-009: `replica_host` is the only host in this table. There is
 * no primary hostname anywhere in the platform, which is what makes zero ERP
 * load a mechanism rather than a promise.
 */

import {
  ERROR_CODES,
  PlatformError,
  tenantRegistryRowSchema,
  toResolvedTenant,
  type ResolvedTenant,
  type TenantRegistryRow,
} from '@sap/shared';
import { config } from '../config.js';
import { platformDb } from './platform-db.js';

interface CacheEntry {
  rows: Map<string, TenantRegistryRow>;
  loadedAt: number;
}

let cache: CacheEntry | null = null;

const isFresh = (entry: CacheEntry): boolean =>
  (Date.now() - entry.loadedAt) / 1000 < config.REGISTRY_CACHE_TTL_SECONDS;

/**
 * [MANDATORY] CODING_GUIDELINES §3/§9: registry rows are external input (the
 * ERP sync writes them) and stay `unknown` until validated. This matters most
 * for `db_name`, which is interpolated into SQL as an identifier where a bound
 * parameter is not legal syntax — so an unsafe value must not survive as far as
 * a validated object. A malformed row is dropped loudly rather than failing the
 * load: one bad school must not take analytics down for the other 1,499, and its
 * absence surfaces to the user as the documented "dropped from scope" notice
 * (docs/02 §6).
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
        `[mcp:registry] rejecting malformed row for school_id=${id}: ` +
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

/** The raw row, including the secret pointer. Internal to the data plane. */
export async function registryRow(schoolId: string): Promise<TenantRegistryRow | undefined> {
  return (await current()).get(schoolId);
}

export interface ConnectionTarget {
  readonly tenant: ResolvedTenant;
  /**
   * Kept beside the tenant rather than on it: `ResolvedTenant` is the descriptor
   * handed around the data layer, and ADR-013 is explicit that credentials — and
   * therefore the pointer to them — do not travel with it.
   */
  readonly secretArn: string;
}

/**
 * Resolve a school to a connection target.
 *
 * Throws rather than returning undefined: by the time this is called the school
 * has already passed the scope check, so a missing or non-active row is a real
 * failure the caller must surface, not a case to skip past quietly.
 */
export async function resolveConnectionTarget(schoolId: string): Promise<ConnectionTarget> {
  const row = await registryRow(schoolId);
  if (row === undefined) {
    throw new PlatformError({
      code: ERROR_CODES.TENANT_NOT_FOUND,
      message: 'This school is not configured for analytics.',
      diagnostics: { school_id: schoolId },
    });
  }
  if (row.status !== 'active') {
    throw new PlatformError({
      code: ERROR_CODES.TENANT_UNAVAILABLE,
      message: 'This school is temporarily unavailable for analytics.',
      details: { status: row.status },
      diagnostics: { school_id: schoolId },
    });
  }
  return { tenant: toResolvedTenant(row), secretArn: row.secret_arn };
}

/** Dropped by tests and, later, by the ERP sync webhook (ADR-005/029). */
export function invalidateRegistryCache(): void {
  cache = null;
}
