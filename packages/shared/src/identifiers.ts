/**
 * Safe SQL identifiers.
 *
 * -- Why this module exists -------------------------------------------------
 * CODING_GUIDELINES §9 [MANDATORY] requires all SQL to be parameterized and
 * forbids string-concatenating values into SQL. That rule protects VALUES.
 * It cannot protect IDENTIFIERS: a placeholder is not legal SQL in the
 * position of a database, table or column name, so
 *
 *     USE ?                       -- invalid
 *     SELECT * FROM ?.students    -- invalid
 *
 * Identifiers must therefore be interpolated. The tenant model makes that
 * unavoidable: docs/03 §2 resolves every call to a per-school database, so
 * `db_name` from the Tenant Registry lands directly in a FROM clause or a USE
 * statement. That is the one string-concatenation site the architecture cannot
 * design away.
 *
 * The defence is an allowlist, applied where the identifier ENTERS the system
 * (registry sync, token parsing) rather than where it is used, so an unsafe
 * identifier cannot exist in a validated object in the first place.
 *
 * Threat note: the registry is populated by the ERP sync (ADR-005), so these
 * values are not user input. That is exactly why the check belongs here — a
 * compromised or buggy upstream sync would otherwise have a direct path into
 * SQL, and "it came from a trusted system" is the assumption every supply-chain
 * incident is built on.
 */

import { z } from 'zod';

/**
 * Tenant-facing ids (school_id, org_id). Hyphens permitted because docs/02 §3
 * uses `sunrise-delhi` style ids; the real ERP uses `stmarksmb`.
 * Deliberately excludes: quotes, backticks, semicolons, whitespace, comment
 * markers, and every other character with meaning to a SQL parser.
 */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * MySQL schema/database names. MySQL caps identifiers at 64 characters.
 * Stricter than SAFE_ID: no hyphen, since a hyphenated identifier is only
 * legal when quoted and we do not want correctness depending on the quoting.
 */
export const SAFE_DB_NAME = /^[A-Za-z0-9_$]{1,64}$/;

/** Hostnames. No scheme, no port, no path, no credentials, no whitespace. */
export const SAFE_HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

/** e.g. 'erp-v4.2'. Used as a cache key and never in SQL, but kept tight. */
export const SAFE_SCHEMA_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const safeIdSchema = z
  .string()
  .regex(SAFE_ID, 'must contain only letters, digits, underscore and hyphen');

/**
 * MySQL's own databases. A school tenant must never resolve to one of these:
 * `mysql` holds the credential tables, and `information_schema` would let a
 * scoped query enumerate every database on the instance -- which, given school
 * databases are consolidated many-per-instance (docs/03 §1), is a cross-tenant
 * disclosure path that no amount of scope checking upstream would catch.
 *
 * This is a DENYLIST and deliberately separate from the syntax allowlist above:
 * `information_schema` is a perfectly well-formed identifier. Syntactic safety
 * and authorization are different questions, and conflating them hides both.
 */
export const RESERVED_DB_NAMES = new Set([
  'mysql',
  'information_schema',
  'performance_schema',
  'sys',
]);

export function isReservedDatabase(name: string): boolean {
  return RESERVED_DB_NAMES.has(name.toLowerCase());
}

export const safeDbNameSchema = z
  .string()
  .regex(SAFE_DB_NAME, 'must be a MySQL-safe identifier (letters, digits, _ , $; max 64)')
  .refine((n) => !isReservedDatabase(n), {
    message: 'must not be a MySQL system database',
  });

export const safeHostnameSchema = z.string().regex(SAFE_HOSTNAME, 'must be a bare hostname');

export const safeSchemaVersionSchema = z.string().regex(SAFE_SCHEMA_VERSION, 'invalid schema_version');

/**
 * Quote an identifier for MySQL, validating first.
 *
 * [MANDATORY] This is the ONLY sanctioned way to place an identifier into SQL.
 * Never template a raw `db_name` or column name into a statement. Validation
 * happens here too, not only at the schema boundary, because this function is
 * the last line before the string reaches the driver — belt and braces, the
 * same reasoning ADR-008 gives for pairing read-only grants with AST
 * validation.
 *
 * Throws rather than returning a result: there is no safe way to continue with
 * an unsafe identifier, and a caller that swallowed an error result would
 * produce exactly the silent failure CODING_GUIDELINES §10 calls the worst bug
 * class in this system.
 */
export function quoteMySqlIdentifier(identifier: string): string {
  if (!SAFE_DB_NAME.test(identifier) && !SAFE_ID.test(identifier)) {
    throw new Error(
      `unsafe SQL identifier rejected (length ${identifier.length}); ` +
        `identifiers must match ${SAFE_DB_NAME} or ${SAFE_ID}`,
    );
  }
  if (isReservedDatabase(identifier)) {
    throw new Error('refusing to emit a MySQL system database as an identifier');
  }
  // Backtick-quote and escape any backtick, though the allowlist above already
  // makes one impossible. Cheap, and survives someone loosening the regex.
  return '`' + identifier.replace(/`/g, '``') + '`';
}

/**
 * Keys that must never be accepted as object keys built from external data.
 * Assigning to `__proto__` during a row-shaping loop pollutes Object.prototype
 * process-wide, which in a shared orchestrator is a cross-tenant problem.
 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isDangerousKey(key: string): boolean {
  return DANGEROUS_KEYS.has(key);
}

/** Reject a record whose keys could pollute a prototype chain. */
export function hasDangerousKeys(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).some(isDangerousKey);
}
