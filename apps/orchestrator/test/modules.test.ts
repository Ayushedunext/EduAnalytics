/**
 * Tests for the Module Wise Analysis catalog (services/modules.ts,
 * services/home.ts `servedModules`).
 *
 * A module is an ARRANGEMENT of the report catalog, so almost everything worth
 * asserting here is about the two halves agreeing — the seven modules that
 * exist, and the report cards that claim membership in them. The failures this
 * guards are all quiet ones: nothing throws and nothing fails to typecheck when
 * a report is filed under a module nobody declared, or when a module tile
 * promises reports that the build does not serve. They surface as a tile whose
 * names disagree with what opens inside it, which is the success-shaped failure
 * CODING_GUIDELINES §10 calls the worst class here.
 */

import './env-defaults.js';
import { describe, expect, it } from 'vitest';
import { MODULES, MODULE_IDS, isModuleId } from '../src/services/modules.js';
import { DASHBOARDS, servedDashboards, servedModules } from '../src/services/home.js';

describe('the module catalog', () => {
  it('declares the seven modules the screen is designed around', () => {
    /**
     * Named rather than counted. The set is a product decision — it is what a
     * school's world is divided into — so adding or removing one should be a
     * deliberate edit to a passing assertion, not a number that drifts.
     */
    expect(MODULES.map((m) => m.id)).toEqual([
      'fees',
      'student',
      'staff',
      'attendance',
      'transport',
      'exam',
      'general',
    ]);
  });

  it('gives every module a title, a blurb and an icon', () => {
    for (const module of MODULES) {
      expect(module.title, `${module.id} has no title`).toBeTruthy();
      expect(module.blurb, `${module.id} has no blurb`).toBeTruthy();
      expect(module.icon, `${module.id} has no icon`).toBeTruthy();
    }
  });

  it('keeps MODULE_IDS and MODULES in step', () => {
    expect(MODULES.map((m) => m.id)).toEqual([...MODULE_IDS]);
    for (const id of MODULE_IDS) expect(isModuleId(id)).toBe(true);
    expect(isModuleId('fees-and-staff')).toBe(false);
  });
});

describe('every report knows which modules it is in', () => {
  /**
   * [MANDATORY] A card filed under a module that does not exist vanishes from
   * the module screen entirely — it is in no tile, and it no longer has a
   * sidebar row of its own either (Sidebar.tsx, amended 2026-09-01). Nothing
   * errors; the report simply becomes unreachable except from Home's strip.
   */
  it('[MANDATORY] files every card under modules that exist', () => {
    for (const card of DASHBOARDS) {
      expect(card.modules.length, `${card.id} is in no module`).toBeGreaterThan(0);
      for (const id of card.modules) {
        expect(isModuleId(id), `${card.id} names an unknown module: ${id}`).toBe(true);
      }
    }
  });

  /**
   * [MANDATORY] The reachability guarantee the sidebar change rests on. The
   * per-report menu rows are gone, so a served report that is in no SERVED
   * module can be opened from Home's grid or strip and nowhere else — which is
   * exactly what "the reports moved into modules" promised would not happen.
   */
  it('[MANDATORY] puts every served report inside a served module', () => {
    const inModules = new Set(servedModules().flatMap((m) => m.report_ids));
    for (const card of servedDashboards()) {
      expect(inModules.has(card.id), `${card.id} is served but is in no module`).toBe(true);
    }
  });

  it('leaves no module declared-but-unclaimed', () => {
    // A module no card claims is served neither as `available` nor as `empty`
    // (it has nothing to show AND nothing to say), so it would silently vanish
    // from a screen that is meant to describe the whole school.
    const claimed = new Set(DASHBOARDS.flatMap((card) => card.modules));
    for (const id of MODULE_IDS) {
      expect(claimed.has(id), `no report is filed under ${id}`).toBe(true);
    }
  });
});

describe('what a module tile says', () => {
  it('serves only openable reports inside an available module', () => {
    const byId = new Map(DASHBOARDS.map((card) => [card.id, card]));
    for (const module of servedModules().filter((m) => m.status === 'available')) {
      expect(module.report_ids.length).toBeGreaterThan(0);
      for (const id of module.report_ids) {
        expect(byId.get(id)?.status, `${id} is offered inside ${module.id}`).toBe('available');
      }
    }
  });

  it('lists a module’s reports in catalog order', () => {
    const order = DASHBOARDS.map((card) => card.id);
    for (const module of servedModules()) {
      const positions = module.report_ids.map((id) => order.indexOf(id));
      expect([...positions].sort((a, b) => a - b), `${module.id} is out of order`).toEqual(positions);
    }
  });

  /**
   * A report in two modules is the same report opened from two doors, and both
   * doors are real. Trend Analysis is the case: six years of fee collection and
   * twelve of enrollment, so Fees and Student both legitimately contain it.
   */
  it('lets one report appear in more than one module', () => {
    const modulesFor = (id: string): string[] =>
      servedModules().filter((m) => m.report_ids.includes(id)).map((m) => m.id);

    expect(modulesFor('trend-analysis')).toEqual(['fees', 'student']);
    expect(modulesFor('staff-attendance')).toEqual(['staff', 'attendance']);
  });

  /**
   * The one place the module screen departs from `servedDashboards`' rule that
   * a menu row must be a place you can go — and the reason it is allowed to.
   *
   * Exam has one report and the ERP extract carries no exam data, so nothing in
   * it opens. Dropping the tile would leave six tiles describing a school that
   * plainly holds exams, which reads as an oversight; the tile states the fact
   * instead, quoting the report card's own reason, and does not click.
   */
  it('serves a module with nothing openable as `empty`, with the reason', () => {
    const exam = servedModules().find((m) => m.id === 'exam');
    expect(exam).toBeDefined();
    expect(exam?.status).toBe('empty');
    expect(exam?.report_ids).toEqual([]);
    expect(exam?.reason).toBe('No exam data exists in the ERP extract');
  });

  it('quotes the cards’ reasons rather than writing its own', () => {
    const reasons = new Set(
      DASHBOARDS.filter((c) => c.reason !== undefined).map((c) => c.reason as string),
    );
    for (const module of servedModules().filter((m) => m.status === 'empty')) {
      // Each clause of an `empty` module's reason came off a card, so the day an
      // extract lands the tile fills in on its own — nothing to reword here.
      for (const clause of (module.reason ?? '').split(' · ')) {
        expect(reasons.has(clause), `${module.id} invented a reason: ${clause}`).toBe(true);
      }
    }
  });

  it('never repeats one reason inside a module', () => {
    for (const module of servedModules().filter((m) => m.status === 'empty')) {
      const clauses = (module.reason ?? '').split(' · ');
      expect(new Set(clauses).size, `${module.id} repeats a reason`).toBe(clauses.length);
    }
  });

  it('draws the tiles in the catalog’s own order', () => {
    const served = servedModules().map((m) => m.id);
    const declared = MODULES.map((m) => m.id).filter((id) => served.includes(id));
    expect(served).toEqual(declared);
  });
});
