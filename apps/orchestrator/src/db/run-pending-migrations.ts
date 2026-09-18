/**
 * Runtime migration runner.
 *
 * At boot, applies whatever db/platform/migrations/*.sql the platform DB is
 * still missing -- tracked in the same schema_migrations table (filename
 * primary key) that db/scripts/migrate.mjs already uses, so the two are
 * interchangeable: either can run first, and both see the same "already
 * applied" state.
 *
 * Why this exists: a platform DB that falls behind the app by even one
 * migration fails whatever feature that migration backs with a raw, generic
 * "An internal error occurred." (agents-schema-bootstrap.ts's narrower,
 * agents-only version of this first caught 0009_agents.sql missing on
 * staging; readAiConfig's `provider` column -- 0006_tenant_ai_config_provider.sql
 * -- surfaced the same way right after, proving the drift wasn't limited to
 * one migration). Applying everything pending, generically, means the next
 * missing migration self-heals on deploy instead of failing one screen at a
 * time until someone notices and hand-patches that one table.
 *
 * -- Why a dedicated connection, not the shared platformDb pool ---------------
 * platformDb (./platform-db.ts) deliberately runs with multipleStatements:
 * false, removing a whole class of injection risk from every ordinary query
 * the app makes. A migration file legitimately contains several statements,
 * so this opens its own short-lived connection with multipleStatements: true
 * -- exactly db/scripts/migrate.mjs's own posture -- and closes it once done.
 * The app's regular connections never gain that capability.
 *
 * -- Why a MySQL named lock -----------------------------------------------
 * deploy/staging/docker-compose.yml's `migrate` service carries a warning:
 * running migrations from the orchestrator's own boot is unsafe once it runs
 * more than one replica, because concurrent CREATE/ALTER statements are how a
 * schema gets corrupted. GET_LOCK/RELEASE_LOCK is MySQL's own mutual-exclusion
 * primitive for exactly this: held only while migrations are being applied, so
 * a second replica booting at the same moment waits its turn (or -- if the
 * lock is still held past the timeout below -- skips migrating this boot
 * rather than racing) instead of running the same ALTER twice.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';
import { config } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));
// apps/orchestrator/src/db -> repo root -> db/platform/migrations
const migrationsDir = join(here, '..', '..', '..', '..', 'db', 'platform', 'migrations');

const LOCK_NAME = 'sap_platform_migrations';
const LOCK_TIMEOUT_SECONDS = 30;

export async function runPendingMigrations(): Promise<void> {
  const conn = await mysql.createConnection({
    host: config.PLATFORM_DB_HOST,
    port: config.PLATFORM_DB_PORT,
    user: config.PLATFORM_DB_USER,
    password: config.PLATFORM_DB_PASSWORD,
    database: config.PLATFORM_DB_NAME,
    multipleStatements: true,
  });

  try {
    const [lockRows] = await conn.query<RowDataPacket[]>('SELECT GET_LOCK(?, ?) AS acquired', [
      LOCK_NAME,
      LOCK_TIMEOUT_SECONDS,
    ]);
    if (Number(lockRows[0]?.['acquired']) !== 1) {
      console.warn(
        '[orchestrator] could not acquire the platform-migration lock in time -- ' +
          'another replica is likely applying migrations right now. Continuing boot without migrating this time.',
      );
      return;
    }

    try {
      await conn.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          filename   VARCHAR(255) NOT NULL,
          applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (filename)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);

      const [appliedRows] = await conn.query<RowDataPacket[]>('SELECT filename FROM schema_migrations');
      const done = new Set(appliedRows.map((r) => String(r['filename'])));

      const pending = readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .filter((f) => !done.has(f));

      if (pending.length === 0) {
        console.log('[orchestrator] platform DB migrations: up to date');
        return;
      }

      for (const file of pending) {
        console.log(`[orchestrator] applying platform DB migration ${file} ...`);
        await conn.query(readFileSync(join(migrationsDir, file), 'utf8'));
        await conn.query('INSERT INTO schema_migrations (filename) VALUES (?)', [file]);
      }
      console.log(`[orchestrator] platform DB migrations: applied ${String(pending.length)} pending file(s)`);
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
    }
  } finally {
    await conn.end();
  }
}
