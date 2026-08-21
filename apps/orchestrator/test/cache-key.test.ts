/**
 * Invariant tests for the result-cache key.
 *
 * [MANDATORY] docs/08 §5: "`permission_class` is part of every cache key.
 * Masking is role-dependent (§4.4, doc 04 rail 6) and drill leaves are
 * rights-gated; a key without a permission component would let a privileged
 * user's cache entry be served to a restricted one. A masking rule enforced at
 * query time and discarded at cache time is not enforced."
 *
 * That is the whole reason this file exists. The MCP server masks an
 * accountant's view of a defaulter list correctly today; a cache that ignored
 * the permission class would hand that same accountant the Principal's unmasked
 * rows on the next request, and every rail upstream would have done its job.
 *
 * The tests are on the KEY rather than on Redis: the key is where the property
 * lives, and asserting it needs no server.
 */

import { describe, expect, it } from 'vitest';
import './env-defaults.js';

const { cacheKey } = await import('../src/cache/result-cache.js');

const BASE = {
  kind: 'report:fee-defaulters',
  schoolIds: ['stmarksmb', 'stmarksj'],
  permissionClass: 'principal:fees.read+students.read+staff.read',
  filters: { academic_year: '2026-27', as_of_date: '2026-08-20' },
};

describe('a cache entry can only be reached by an identical request', () => {
  it('is stable for the same request', () => {
    expect(cacheKey(BASE)).toBe(cacheKey({ ...BASE }));
  });

  it('ignores the ORDER of the school set, which is a selection and not a sequence', () => {
    expect(cacheKey(BASE)).toBe(cacheKey({ ...BASE, schoolIds: ['stmarksj', 'stmarksmb'] }));
  });

  it('ignores the order filters happen to be built in', () => {
    expect(cacheKey(BASE)).toBe(
      cacheKey({
        ...BASE,
        filters: { as_of_date: '2026-08-20', academic_year: '2026-27' },
      }),
    );
  });

  it('[MANDATORY] separates sessions with different permission classes', () => {
    const accountant = cacheKey({ ...BASE, permissionClass: 'accountant:fees.read' });
    expect(accountant).not.toBe(cacheKey(BASE));
  });

  it.each([
    ['a different report', { kind: 'report:fee-collection' }],
    ['a narrower school set', { schoolIds: ['stmarksmb'] }],
    ['an extra school', { schoolIds: ['stmarksmb', 'stmarksj', 'stmarksg'] }],
    ['a different academic year', { filters: { ...BASE.filters, academic_year: '2025-26' } }],
    ['a different as-of date', { filters: { ...BASE.filters, as_of_date: '2026-06-30' } }],
    ['a dropped filter', { filters: { academic_year: '2026-27' } }],
  ])('separates %s', (_label, patch) => {
    expect(cacheKey({ ...BASE, ...patch })).not.toBe(cacheKey(BASE));
  });

  /**
   * A key built by concatenation would collide here: one school called "a:b"
   * and two schools called "a" and "b" flatten to the same string. Hashing a
   * canonical JSON document instead means the structure survives into the key.
   */
  it('does not collide when a separator appears inside an id', () => {
    const one = cacheKey({ ...BASE, schoolIds: ['a:b'] });
    const two = cacheKey({ ...BASE, schoolIds: ['a', 'b'] });
    expect(one).not.toBe(two);
  });

  it('is namespaced and versioned, so a value-shape change cannot be misread', () => {
    // The prefix carries the version: bump it and every old entry becomes
    // unreachable rather than being deserialised by code that expects more.
    expect(cacheKey(BASE)).toMatch(/^sap:v1:report:fee-defaulters:[0-9a-f]{32}$/);
  });
});
