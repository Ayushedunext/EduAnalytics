/**
 * Injection-surface tests.
 *
 * These target the one place the architecture cannot use bound parameters:
 * SQL identifiers (see identifiers.ts). CODING_GUIDELINES §14 asks for
 * invariant tests over the security rails; this is the identifier half of
 * "all SQL is parameterized" (§9).
 */

import { describe, expect, it } from 'vitest';
import {
  isReservedDatabase,
  quoteMySqlIdentifier,
  safeDbNameSchema,
  safeHostnameSchema,
  safeIdSchema,
  hasDangerousKeys,
} from '../src/identifiers.js';
import { tenantRegistryRowSchema } from '../src/tenant.js';
import { parseLaunchTokenClaims } from '../src/launch-token.js';

/** Payloads that would be catastrophic if interpolated into SQL. */
const INJECTION_PAYLOADS = [
  'stmarks`; DROP TABLE students; --',
  "stmarks'; DELETE FROM fee_collection_data_set; --",
  'stmarks` UNION SELECT * FROM mysql.user -- ',
  'stmarks/*comment*/',
  'stmarks stmarksj',
  'stmarks\nDROP DATABASE ai_analysis',
  'stmarks;',
  '../../etc/passwd',
  '`backtick`',
  '',
];

describe('identifier allowlist', () => {
  it.each(INJECTION_PAYLOADS)('rejects %j as a db_name', (payload) => {
    expect(safeDbNameSchema.safeParse(payload).success).toBe(false);
  });

  it.each(INJECTION_PAYLOADS)('rejects %j as a school id', (payload) => {
    expect(safeIdSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects MySQL system databases -- valid syntax, forbidden target', () => {
    for (const name of ['mysql', 'information_schema', 'performance_schema', 'sys', 'MySQL']) {
      expect(safeDbNameSchema.safeParse(name).success).toBe(false);
      expect(isReservedDatabase(name)).toBe(true);
      expect(() => quoteMySqlIdentifier(name)).toThrow();
    }
  });

  it('accepts the real ERP database names', () => {
    for (const name of ['stmarksg', 'stmarksj', 'stmarksmb', 'ai_analysis', 'sacskb']) {
      expect(safeDbNameSchema.safeParse(name).success).toBe(true);
    }
  });

  it('accepts hyphenated school ids used in docs/02 §3', () => {
    expect(safeIdSchema.safeParse('sunrise-delhi').success).toBe(true);
  });

  it('rejects a hyphen in a db_name -- legal only when quoted', () => {
    expect(safeDbNameSchema.safeParse('st-marks').success).toBe(false);
  });

  it('enforces the MySQL 64-character identifier limit', () => {
    expect(safeDbNameSchema.safeParse('a'.repeat(64)).success).toBe(true);
    expect(safeDbNameSchema.safeParse('a'.repeat(65)).success).toBe(false);
  });

  it('rejects a host carrying a scheme, port, path or credentials', () => {
    for (const host of [
      'http://db.internal',
      'db.internal:3306',
      'db.internal/path',
      'user:pass@db.internal',
      'db internal',
    ]) {
      expect(safeHostnameSchema.safeParse(host).success).toBe(false);
    }
    expect(safeHostnameSchema.safeParse('replica-1.abc.ap-south-1.rds.amazonaws.com').success).toBe(
      true,
    );
  });
});

describe('quoteMySqlIdentifier', () => {
  it('backtick-quotes a valid identifier', () => {
    expect(quoteMySqlIdentifier('stmarksmb')).toBe('`stmarksmb`');
  });

  it('throws on every injection payload rather than emitting SQL', () => {
    for (const payload of INJECTION_PAYLOADS) {
      expect(() => quoteMySqlIdentifier(payload)).toThrow();
    }
  });

  it('does not echo the rejected value in the error -- it may be hostile', () => {
    try {
      quoteMySqlIdentifier('evil`; DROP TABLE students; --');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain('DROP TABLE');
    }
  });
});

describe('registry rows reject unsafe topology', () => {
  const row = {
    school_id: 'stmarksmb',
    org_id: 'stmarks',
    school_name: 'Meera Bagh',
    region: 'ap-south-1',
    status: 'active' as const,
    replica_host: 'replica-1.ap-south-1.rds.amazonaws.com',
    db_name: 'stmarksmb',
    secret_arn: 'arn:aws:secretsmanager:ap-south-1:1:secret:x',
    schema_version: 'erp-v4.2',
    // NULL is the expected production value: one database per school means
    // db_name is the tenant boundary and no row-level filter exists (docs/02 §5).
    tenant_key: null,
  };

  it('accepts a well-formed row', () => {
    expect(tenantRegistryRowSchema.safeParse(row).success).toBe(true);
  });

  it('accepts a row-level tenant key for a consolidated schema version', () => {
    expect(tenantRegistryRowSchema.safeParse({ ...row, tenant_key: 'stmarksmb' }).success).toBe(
      true,
    );
  });

  it('requires tenant_key to be stated, not merely omitted', () => {
    // Strict about presence because "absent" and "no row-level filter needed"
    // must not be the same thing: a sync that forgot the column would otherwise
    // look identical to a school that legitimately has no filter (docs/02 §5).
    const { tenant_key: _omitted, ...withoutKey } = row;
    expect(tenantRegistryRowSchema.safeParse(withoutKey).success).toBe(false);
  });

  it('rejects an injected db_name even though the sync is "trusted"', () => {
    const bad = { ...row, db_name: 'stmarksmb`; DROP DATABASE ai_analysis; --' };
    expect(tenantRegistryRowSchema.safeParse(bad).success).toBe(false);
  });

  it('has no primary_host field, and rejects one (ADR-009)', () => {
    const bad = { ...row, primary_host: 'primary.rds.amazonaws.com' };
    expect(tenantRegistryRowSchema.safeParse(bad).success).toBe(false);
  });
});

describe('launch token ids are allowlisted, not merely signed', () => {
  const base = {
    sub: 'user_1',
    name: 'R. Mehta',
    role: 'DIRECTOR',
    org_id: 'stmarks',
    school_ids: ['stmarksg'],
    default_school: 'stmarksg',
    perms: ['fees.read'],
    iat: 0,
    exp: 60,
    jti: 'n1',
  };

  it('rejects an injected school_id from an otherwise valid token', () => {
    // A signed token is trusted for authenticity, never for content.
    const r = parseLaunchTokenClaims({
      ...base,
      school_ids: ['stmarksg`; DROP TABLE students; --'],
      default_school: 'stmarksg`; DROP TABLE students; --',
    });
    expect(r.ok).toBe(false);
  });
});

describe('prototype pollution guard', () => {
  it('flags dangerous keys', () => {
    expect(hasDangerousKeys(JSON.parse('{"__proto__":{"admin":true}}'))).toBe(true);
    expect(hasDangerousKeys({ classname: 'IX' })).toBe(false);
  });
});
