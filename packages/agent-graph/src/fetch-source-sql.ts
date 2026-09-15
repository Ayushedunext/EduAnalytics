/**
 * The vetted, literal SELECT behind each runnable `FETCH_SOURCES` entry
 * (types.ts) — shared so apps/agent-runtime's trigger evaluator (the
 * schedule-driven read) and apps/orchestrator's `testRunAgent` (the
 * builder's "Test run" button, run under the live admin's own session) can
 * never quietly drift onto two different queries for the same declared
 * source. Both go through `run_query`/`run_multi` (ADR-006) — this module
 * only supplies the statement text, never touches a connection.
 *
 * `parent_phone` never appears in any statement here — see FETCH_SOURCES'
 * own comment and docs/11 §2 item 10 (no contact column exists in the
 * catalogued schema yet). Every caller adds `parent_phone: null` itself
 * rather than this module inventing a value.
 *
 * -- `students_absent_today` --------------------------------------------------
 * Against the real, catalogued schema (`apps/mcp-server/src/schema/erp-v1.ts`):
 * `student_attendance_data_set` is not unique on (student, date) and its
 * `academicyearname` cannot be trusted, so this statement filters on
 * `attendancedate` (text, `YYYY-MM-DD`) and `statusname = 'Absent'` only, per
 * that schema's own column notes. `consecutive_days` is a TRAILING-WINDOW
 * approximation (count of distinct absent dates in the last 7 calendar days),
 * not a true unbroken-run calculation — the same kind of stated simplification
 * docs/06's drill per-level notes make for other counts that read like one
 * thing and are actually another.
 *
 * -- `fee_defaulters_30_60_90` -------------------------------------------------
 * Reads `fee_compile_data_set`, the same table the Fee Defaulters dashboard
 * reads (mcp-server/src/reports/catalog.ts's `FEE_DEFAULTERS`), aggregated
 * per student instead of per aging band. "Current academic year" is read
 * from that table's own `acfromdate`/`actodate` window rather than a literal
 * year string — the dashboard's queries take `academic_year` as a bound
 * parameter through `run_predefined`, which an agent's literal `run_query`
 * SQL cannot do (ADR-006 §2: "no placeholders"), so the date-window
 * reformulation is this evaluator's, not a copy of the dashboard's SQL. The
 * `HAVING days_overdue >= 30` floor is what "30/60/90" means for this
 * source: every matched row already cleared 30 days, and the if/else
 * condition in `feeReminderGraph` (>=60) only decides how loudly to say so.
 */

import type { FetchSourceId } from './types.js';

export const FETCH_SOURCE_SQL: Partial<Record<FetchSourceId, string>> = {
  students_absent_today: `
    SELECT s.studentid AS student_id, s.studentname AS student_name,
           s.classname AS class, s.sectionname AS section,
           (SELECT COUNT(DISTINCT a2.attendancedate)
              FROM student_attendance_data_set a2
             WHERE a2.studentid = s.studentid
               AND a2.statusname = 'Absent'
               AND a2.attendancedate BETWEEN DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 6 DAY), '%Y-%m-%d')
                                          AND DATE_FORMAT(CURDATE(), '%Y-%m-%d')
           ) AS consecutive_days
      FROM (
        SELECT DISTINCT studentid, studentname, classname, sectionname
          FROM student_attendance_data_set
         WHERE attendancedate = DATE_FORMAT(CURDATE(), '%Y-%m-%d')
           AND statusname = 'Absent'
      ) s
  `.trim(),
  fee_defaulters_30_60_90: `
    SELECT enrollmentno AS student_id, studentname AS student_name,
           classname AS class, sectionname AS section,
           ROUND(SUM(balance_amount)) AS balance_amount,
           DATEDIFF(CURDATE(), MIN(periodtodate)) AS days_overdue
      FROM fee_compile_data_set
     WHERE acfromdate <= CURDATE() AND actodate >= CURDATE()
       AND balance_amount > 0
       AND periodtodate < CURDATE()
     GROUP BY enrollmentno, studentname, classname, sectionname
    HAVING DATEDIFF(CURDATE(), MIN(periodtodate)) >= 30
  `.trim(),
};
