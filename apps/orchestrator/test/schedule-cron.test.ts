/**
 * Weekdays + a time → the cron pattern BullMQ repeats on (ADR-037).
 *
 * [MANDATORY] CODING_GUIDELINES §14. This is four lines of code and it is
 * tested because of how it fails: an off-by-one in the day numbering sends a
 * weekly report on the wrong day, every week, with no error anywhere — and the
 * only person who could notice is the reader who was expecting it on Monday and
 * has learned to check their inbox on Tuesday.
 *
 * `Date#getDay` numbers Sunday as 0, and so does cron. That agreement is the
 * reason the SPA, `report_schedules.days` and this expression can all count
 * days the same way without a translation table; these cases are what hold it.
 */

import { describe, expect, it } from 'vitest';
import { cronFor } from '../src/queue/schedule-queue.js';

describe('cronFor', () => {
  it('puts minutes and hours in cron order, not clock order', () => {
    expect(cronFor([1], '07:30')).toBe('30 7 * * 1');
  });

  it('strips the leading zero cron would read as octal-looking noise', () => {
    expect(cronFor([1], '09:05')).toBe('5 9 * * 1');
  });

  it('keeps midnight as 0 0 rather than an empty field', () => {
    expect(cronFor([0], '00:00')).toBe('0 0 * * 0');
  });

  it('lists a school week in ascending order', () => {
    expect(cronFor([5, 1, 3, 2, 4], '10:30')).toBe('30 10 * * 1,2,3,4,5');
  });

  it('numbers Sunday 0, agreeing with Date#getDay', () => {
    const sunday = new Date('2026-09-20T00:00:00Z').getUTCDay();
    expect(sunday).toBe(0);
    expect(cronFor([sunday], '08:00')).toBe('0 8 * * 0');
  });

  it('numbers Saturday 6, agreeing with Date#getDay', () => {
    const saturday = new Date('2026-09-19T00:00:00Z').getUTCDay();
    expect(saturday).toBe(6);
    expect(cronFor([saturday], '08:00')).toBe('0 8 * * 6');
  });

  it('collapses a duplicated day rather than firing twice', () => {
    expect(cronFor([1, 1, 2], '06:00')).toBe('0 6 * * 1,2');
  });
});
