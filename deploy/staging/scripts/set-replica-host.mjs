/**
 * Point every registered school at the staging replica host.
 *
 * WHY THIS EXISTS
 *
 * db/platform/seed/*.sql registers the schools with `replica_host` =
 * '127.0.0.1', which is right for a developer whose MySQL is on their own
 * machine and wrong inside a container network, where 127.0.0.1 is the MCP
 * server's own loopback and nothing is listening on it. Left alone, every
 * dashboard fails with a connection error that looks like a database outage.
 *
 * WHY IT IS AN UPDATE RATHER THAN A CODE CHANGE
 *
 * docs/04 §4: "the registry IS the configuration". Where a school's replica
 * lives is a row, not a constant, and the deployment that moves it says so by
 * writing the row. The alternative -- an env var the MCP server consults before
 * trusting the registry -- would put a second source of truth in front of the
 * first, and the day they disagreed the code would win silently. Onboarding a
 * school is an INSERT; re-homing one is an UPDATE.
 *
 * ADR-009 is not weakened by this. The column being written is `replica_host`,
 * the only host column the schema has; there is no primary to point anywhere,
 * by design, and this script cannot introduce one.
 *
 * Idempotent, and safe to run on every deploy: the seed's ON DUPLICATE KEY
 * UPDATE clause deliberately does not list replica_host, so re-seeding never
 * undoes this, and re-running it changes nothing once applied.
 *
 * Usage:  node deploy/staging/scripts/set-replica-host.mjs
 *         (reads SCHOOL_DB_HOST, falling back to the compose service name)
 */
import mysql from 'mysql2/promise';

const host = process.env.SCHOOL_DB_HOST ?? 'mysql';

const conn = await mysql.createConnection({
  host: process.env.PLATFORM_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.PLATFORM_DB_PORT ?? 3306),
  user: process.env.PLATFORM_DB_USER,
  password: process.env.PLATFORM_DB_PASSWORD,
  database: process.env.PLATFORM_DB_NAME ?? 'analytics_platform',
});

const [result] = await conn.execute(
  'UPDATE tenant_registry SET replica_host = ? WHERE replica_host <> ?',
  [host, host],
);

console.log(
  `[staging] replica_host -> ${host} (${result.affectedRows} row(s) changed, ${result.affectedRows === 0 ? 'already correct' : 'updated'})`,
);

const [rows] = await conn.query(
  'SELECT school_id, school_name, replica_host, db_name, status FROM tenant_registry ORDER BY school_id',
);
console.table(rows);

await conn.end();
