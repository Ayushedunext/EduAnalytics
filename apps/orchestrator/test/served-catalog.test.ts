/**
 * Tests for what the dashboard catalog SERVES (services/home.ts,
 * `servedDashboards`).
 *
 * docs/10 §3 as amended 2026-09-01: "locked ≠ hidden" is about a signpost — 🔒
 * points at Settings and the feature opens. A card that nobody can open under
 * any role, with any key, points nowhere, so it is withheld from the response
 * rather than rendered inert. That is both unopenable states: `coming` (serving
 * path unbuilt, ADR-010/ADR-022) and `blocked` (the ERP extract has no such
 * data, AUDIT_REPORT C20).
 *
 * Both surfaces that list dashboards read this one response — Sidebar.tsx from
 * `dashboards`, Home.tsx's strip from the same array minus `grid` — so
 * withholding here is what empties both.
 *
 * The regression this guards is a quiet one: nothing throws and nothing fails
 * to typecheck if an unopenable card leaks back into the payload. It just
 * reappears in a deployed menu as a row that goes nowhere.
 */

import './env-defaults.js';
import { describe, expect, it } from 'vitest';
import { DASHBOARDS, otherDashboards, servedDashboards } from '../src/services/home.js';

describe('served dashboard catalog', () => {
  it('serves only dashboards this build can open', () => {
    const served = servedDashboards();
    expect(served.length).toBeGreaterThan(0);
    for (const card of served) expect(card.status).toBe('available');
  });

  it('withholds every unopenable card, by name', () => {
    /**
     * Named rather than counted: the point of this list is that each entry was
     * a decision. If one leaves, it should leave because its status changed —
     * which is a passing assertion to update, not a silent count that drifts.
     */
    const withheld = DASHBOARDS.filter((card) => card.status !== 'available').map((card) => ({
      id: card.id,
      status: card.status,
    }));
    expect(withheld).toEqual([
      { id: 'group-overview', status: 'coming' },
      { id: 'cross-school-attendance', status: 'coming' },
      { id: 'workflow-agents', status: 'coming' },
      { id: 'school-comparison', status: 'coming' },
      { id: 'exam-performance', status: 'blocked' },
    ]);
  });

  it('keeps the withheld cards in the catalog, so they return by flipping status', () => {
    /**
     * Withheld, not deleted. The reasons and ADR references stay in
     * `DASHBOARDS`, which is what makes re-adding one a status change rather
     * than an archaeology exercise — and is where the people who CAN act on
     * them (the rollup-store and extract owners) read them.
     */
    for (const card of DASHBOARDS.filter((c) => c.status !== 'available')) {
      expect(card.reason, `${card.id} must still say why it is withheld`).toBeTruthy();
    }
  });

  it('leaves nothing unopenable in the strip below the grid either', () => {
    for (const card of otherDashboards()) expect(card.status).toBe('available');
  });
});
