/**
 * Platform-DB migration runner.
 *
 * Applies db/platform/migrations/*.sql in filename order, tracking what has run
 * in a schema_migrations table so it is safe to re-run.
 *
 * Note on CODING_GUIDELINES §5: that rule forbids a mysql2 import outside
 * apps/mcp-server from pointing at a SCHOOL database. This points at the
 * PLATFORM database, which the rule explicitly allows ("platform-owned DBs are
 * accessed by their owning service"). It never opens a school connection.
 *
 * Usage:  node db/scripts/migrate.mjs [--seed]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import 'dotenv/config';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'platform', 'migrations');
const seedDir = join(here, '..', 'platform', 'seed');

const cfg = {
  host: process.env.PLATFORM_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.PLATFORM_DB_PORT ?? 3306),
  user: process.env.PLATFORM_DB_USER,
  password: process.env.PLATFORM_DB_PASSWORD,
  database: process.env.PLATFORM_DB_NAME ?? 'analytics_platform',
  multipleStatements: true,
};

if (!cfg.user) {
  console.error('PLATFORM_DB_USER is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const conn = await mysql.createConnection(cfg);

await conn.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   VARCHAR(255) NOT NULL,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (filename)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`);

const [applied] = await conn.query('SELECT filename FROM schema_migrations');
const done = new Set(applied.map((r) => r.filename));

const pending = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .filter((f) => !done.has(f));

if (pending.length === 0) {
  console.log('migrations: up to date');
} else {
  for (const file of pending) {
    process.stdout.write(`applying ${file} ... `);
    await conn.query(readFileSync(join(migrationsDir, file), 'utf8'));
    await conn.query('INSERT INTO schema_migrations (filename) VALUES (?)', [file]);
    console.log('ok');
  }
}

if (process.argv.includes('--seed')) {
  for (const file of readdirSync(seedDir).filter((f) => f.endsWith('.sql')).sort()) {
    process.stdout.write(`seeding ${file} ... `);
    await conn.query(readFileSync(join(seedDir, file), 'utf8'));
    console.log('ok');
  }
  const [rows] = await conn.query(
    'SELECT school_id, school_name, db_name, status FROM tenant_registry ORDER BY school_id',
  );
  console.table(rows);
}

await conn.end();
