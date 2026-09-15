/**
 * Platform-DB access for agent-runtime, via Drizzle (CODING_GUIDELINES §9,
 * decided 2026-09-15) over the same parameterized mysql2 pool pattern
 * apps/orchestrator/src/db/platform-db.ts uses for every other platform table.
 *
 * [MANDATORY] CODING_GUIDELINES §5: this pool is bound to the PLATFORM
 * database only. Every school-data read this service performs goes through
 * ../mcp/client.ts instead — there is no mysql2 connection to a school
 * database anywhere in this package, by construction.
 */

import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import * as agentDbSchema from '@sap/agent-graph/db-schema';
import { config } from '../config.js';

const pool = mysql.createPool({
  host: config.PLATFORM_DB_HOST,
  port: config.PLATFORM_DB_PORT,
  user: config.PLATFORM_DB_USER,
  password: config.PLATFORM_DB_PASSWORD,
  database: config.PLATFORM_DB_NAME,
  connectionLimit: 10,
  multipleStatements: false,
  timezone: 'Z',
  dateStrings: false,
});

export const db = drizzle(pool, { schema: agentDbSchema, mode: 'default' });

export async function assertPlatformDbReachable(): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.query('SELECT 1');
  } finally {
    conn.release();
  }
}
