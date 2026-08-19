/**
 * Connection pool for the PLATFORM database (registry, audit, nonces).
 *
 * [MANDATORY] CODING_GUIDELINES §5: a mysql2 import outside apps/mcp-server
 * must never point at a SCHOOL database. This pool is bound to the platform
 * database from config and is the only database the orchestrator opens. All
 * school data reaches this service through MCP tools (ADR-006) -- there is no
 * second path, and adding one would collapse the audit chokepoint that makes
 * every school-data read reviewable.
 *
 * Engine is MySQL 8 (PROJECT_CONTEXT.md §7).
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
  // Single statements only. The orchestrator has no legitimate need to send
  // stacked statements, and leaving it off removes a whole injection class from
  // this connection even though every query here is parameterized.
  multipleStatements: false,
  timezone: 'Z',
  dateStrings: false,
});

/** Fail fast at boot if the platform DB is unreachable, rather than per-request. */
export async function assertPlatformDbReachable(): Promise<void> {
  const conn = await platformDb.getConnection();
  try {
    await conn.query('SELECT 1');
  } finally {
    conn.release();
  }
}
