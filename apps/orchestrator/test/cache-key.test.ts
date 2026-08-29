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
    //
    // v2 since entries began carrying their write time alongside the value, so
    // staleness is answerable on read (cache/result-cache.ts). A v1 entry is a
    // bare value and would deserialise as an envelope with no `t` at all.
    //
    // v3 since Fee Collection gained a widget: the key was unchanged, so a warm
    // cache went on serving the pre-change dashboard for the whole TTL. Found
    // by running it, not by reasoning about it — which is why the assertion is
    // written against a LITERAL prefix. A regex that accepted any version would
    // pass whether or not anyone remembered to bump it, and this is precisely
    // the rule nobody remembers.
    //
    // v4 since Fee Defaulters gained its own drill entry point, two days later.
    // Any change to what a builder EMITS needs the bump, not only a change to a
    // type — if a reader would see something different, the digit moves.
    //
    // v5 since the aging chart went amber (`tone: 'warning'`). No widget added,
    // no number changed — a colour alone is enough, because the test of this
    // rule is what a reader sees and not what a deserialiser would notice.
    expect(cacheKey(BASE)).toMatch(/^sap:v5:report:fee-defaulters:[0-9a-f]{32}$/);
  });

  /**
   * [MANDATORY] A partial fetch must not share a key with the full report.
   *
   * Home's preview cards ask for one of a report's queries rather than all of
   * them (services/dashboards.ts, `queryKeys`). If that answer landed on the
   * full dashboard's key, opening the dashboard would serve a report with one
   * panel and the rest silently missing -- a page that looks finished and is
   * not, which is the failure mode §10 singles out as the worst here. The
   * separation is structural: they cannot name the same key.
   */
  it('[MANDATORY] separates a one-query preview from the full report', () => {
    const full = cacheKey(BASE);
    const preview = cacheKey({ ...BASE, kind: 'report:fee-defaulters:q=aging' });
    expect(preview).not.toBe(full);
  });

  it('separates previews of different queries from the same report', () => {
    const aging = cacheKey({ ...BASE, kind: 'report:fee-defaulters:q=aging' });
    const byClass = cacheKey({ ...BASE, kind: 'report:fee-defaulters:q=by_class' });
    expect(aging).not.toBe(byClass);
  });
});
