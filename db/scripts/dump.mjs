/**
 * Platform-DB dump tool.
 *
 * Writes a self-contained mysqldump of the PLATFORM database (the control
 * plane: tenant registry, report definitions, audit trail, BYOK vault) to
 * dumps/. Restore with:
 *
 *   mysql -u root -p < dumps/analytics_platform_<timestamp>.sql
 *
 * Note on CODING_GUIDELINES §5, same as migrate.mjs: that rule forbids opening
 * a SCHOOL database outside apps/mcp-server. This tool only ever names
 * PLATFORM_DB_NAME, which the rule explicitly allows ("platform-owned DBs are
 * accessed by their owning service"). There is no code path here that can
 * reach a school database or an ERP primary.
 *
 * -- Where the output goes, and why it is not committed -----------------------
 * dumps/ is git-ignored (.gitignore §"School data -- real PII"), and this dump
 * belongs there rather than beside the migrations. The migrations are SOURCE:
 * schema and configuration a fresh clone needs. This is DATA: 20k+ audit rows
 * carrying actor ids and question payloads, plus whatever ciphertext the BYOK
 * vault holds. The blanket *.sql ignore exists precisely so a dump cannot be
 * added to a commit by reflex, and nothing here should defeat it.
 *
 * Usage:  node db/scripts/dump.mjs [--schema-only] [--out <path>]
 */
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const cfg = {
  host: process.env.PLATFORM_DB_HOST ?? '127.0.0.1',
  port: String(process.env.PLATFORM_DB_PORT ?? 3306),
  user: process.env.PLATFORM_DB_USER,
  password: process.env.PLATFORM_DB_PASSWORD ?? '',
  database: process.env.PLATFORM_DB_NAME ?? 'analytics_platform',
};

if (!cfg.user) {
  console.error('PLATFORM_DB_USER is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const argv = process.argv.slice(2);
const schemaOnly = argv.includes('--schema-only');

/**
 * Locating mysqldump.
 *
 * The MySQL Windows installer does not put its bin/ on PATH, so "not on PATH"
 * is the normal case on a dev machine rather than an error worth failing on.
 * MYSQLDUMP overrides everything for anyone with a non-standard install.
 */
function findMysqldump() {
  if (process.env.MYSQLDUMP) return process.env.MYSQLDUMP;

  const candidates =
    process.platform === 'win32'
      ? [
          // Forward slashes on purpose: Node accepts them on Windows for both
          // existsSync and spawn, and they keep this list free of the escaping
          // a backslash path needs inside a JS string literal.
          'C:/Program Files/MySQL/MySQL Server 8.4/bin/mysqldump.exe',
          'C:/Program Files/MySQL/MySQL Server 8.0/bin/mysqldump.exe',
          'C:/xampp/mysql/bin/mysqldump.exe',
        ]
      : ['/usr/bin/mysqldump', '/usr/local/bin/mysqldump', '/opt/homebrew/bin/mysqldump'];

  return candidates.find((p) => existsSync(p)) ?? 'mysqldump';
}

// Sortable, filename-safe, local time: 20260901-143000.
const stamp = new Date()
  .toLocaleString('sv-SE')       // 'YYYY-MM-DD HH:MM:SS' in local time
  .replace(/[-:]/g, '')
  .replace(' ', '-');

const outIdx = argv.indexOf('--out');
const defaultName = `${cfg.database}${schemaOnly ? '_schema' : ''}_${stamp}.sql`;
const outPath =
  outIdx !== -1 && argv[outIdx + 1]
    ? resolve(argv[outIdx + 1])
    : join(repoRoot, 'dumps', defaultName);

mkdirSync(dirname(outPath), { recursive: true });

const args = [
  `--host=${cfg.host}`,
  `--port=${cfg.port}`,
  `--user=${cfg.user}`,

  // --databases (not a bare name) so the dump carries its own CREATE DATABASE
  // and USE. A restore then reproduces the schema by name instead of landing in
  // whatever database the operator's client happened to have selected.
  '--databases',
  cfg.database,

  // Consistent snapshot across every table without taking a global read lock,
  // which matters because the orchestrator may be writing audit rows while this
  // runs. InnoDB-only schema, so there is nothing this misses.
  '--single-transaction',

  // [MANDATORY] analytics_app holds ALL PRIVILEGES on analytics_platform and
  // only USAGE on *.*. mysqldump 8.0 probes INFORMATION_SCHEMA.FILES for
  // tablespace clauses unless told not to, and that probe needs the GLOBAL
  // PROCESS privilege -- so without this flag the dump dies on "Access denied;
  // you need (at least one of) the PROCESS privilege(s)". The right fix is this
  // flag, not granting the dump user rights over the whole server.
  '--no-tablespaces',

  // encrypted_api_key is VARBINARY (AES-256-GCM ciphertext, migration 0005).
  // Written as a plain quoted string it would round-trip through the file's
  // character set and come back corrupt -- a key that restores but cannot
  // decrypt. --hex-blob writes 0x... literals, which survive byte for byte.
  '--hex-blob',

  '--default-character-set=utf8mb4',

  // gtid_mode is OFF on this server; saying so explicitly keeps mysqldump from
  // deciding for itself and keeps the output identical across servers.
  '--set-gtid-purged=OFF',

  '--routines',
  '--triggers',
  '--events',
];

if (schemaOnly) args.push('--no-data');

const bin = findMysqldump();
const out = createWriteStream(outPath);

console.log(`dumping ${cfg.database} from ${cfg.host}:${cfg.port} as ${cfg.user}`);
console.log(`  -> ${outPath}${schemaOnly ? '  (schema only)' : ''}`);

// The password goes through MYSQL_PWD, never argv: an argument is visible to
// every other process on the machine via the process list, and mysqldump warns
// about exactly this when handed --password.
const child = spawn(bin, args, {
  env: { ...process.env, MYSQL_PWD: cfg.password },
  stdio: ['ignore', 'pipe', 'inherit'],
});

child.stdout.pipe(out);

child.on('error', (err) => {
  rmSync(outPath, { force: true });
  if (err.code === 'ENOENT') {
    console.error(
      `\nmysqldump not found (tried "${bin}").\n` +
        'Set MYSQLDUMP to its full path, or add the MySQL bin/ directory to PATH.',
    );
  } else {
    console.error(`\nfailed to run mysqldump: ${err.message}`);
  }
  process.exit(1);
});

child.on('close', (code) => {
  out.end(() => {
    if (code !== 0) {
      // A partial dump is worse than none: it restores without complaint and
      // silently drops whatever came after the failure.
      rmSync(outPath, { force: true });
      console.error(`\nmysqldump exited ${code}; removed the incomplete file.`);
      process.exit(1);
    }
    const mb = (statSync(outPath).size / 1024 / 1024).toFixed(1);
    console.log(`done: ${mb} MB`);
  });
});
