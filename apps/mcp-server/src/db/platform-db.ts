/**
 * Connection pool for the PLATFORM database.
 *
 * The MCP server touches the platform database for exactly two things: reading
 * the Tenant Registry (docs/03 §2) and writing the audit trail (docs/08 §7).
 * Both are platform-owned data. School data never arrives through this pool —
 * it arrives through db/pools.ts, on a read-only user, against a replica.
 *
 * Keeping the two pools in separate modules is not tidiness. They differ in
 * every property that matters: this one writes, is trusted, and points at one
 * fixed database; the other is read-only, per-tenant, lazily created and capped.
 * A single "the database" module would make it easy to reach for the wrong one.
 */

import mysql from 'mysql2/promise';
import { config } from '../config.js';

export const platformDb = mysql.createPool({
  host: config.PLATFORM_DB_HOST,
  port: config.PLATFORM_DB_PORT,
  user: config.PLATFORM_DB_USER,
  password: config.PLATFORM_DB_PASSWORD,
  database: config.PLATFORM_DB_NAME,
  connectionLimit: 10,
  multipleStatements: false,
  timezone: 'Z',
});

/** Fail at boot rather than on a tenant's first query. */
export async function assertPlatformDbReachable(): Promise<void> {
  const conn = await platformDb.getConnection();
  try {
    await conn.query('SELECT 1');
  } finally {
    conn.release();
  }
}
