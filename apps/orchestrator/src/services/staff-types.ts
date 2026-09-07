/**
 * What `employees_data_set.stafftype` means, in the one place that decides it.
 *
 * -- Why this is not a two-way split -----------------------------------------
 * The column holds CONFIRMATION / CONTRACTUAL / PROBATION alongside opaque
 * codes — S0011, S004AD — 19 distinct values across three schools
 * (mcp-server/src/reports/catalog.ts, `by_stafftype`). The words classify
 * themselves. The codes do not, and no mapping for them has been confirmed by
 * anyone.
 *
 * Forcing the codes into one bucket or the other would produce two numbers that
 * look authoritative and are guesses — a wrong answer wearing the shape of a
 * right one. Dropping them is no better: the parts would then quietly fail to
 * account for the headcount printed directly above them. So they get named, and
 * a school whose codes dominate can SEE that its employment split is unknown
 * rather than being told a confident fiction.
 *
 * -- Why it lives in its own module ------------------------------------------
 * Two screens print this split now — the Dashboard's KPI strip (`home.ts`) and
 * the "At a glance" tiles card (`overview.ts`) — over the same schools, under
 * the same labels. Two copies of these regexes would be two definitions of
 * "permanent", and the day one of them learns what S0011 means is the day the
 * two screens start disagreeing in front of the same reader. If a mapping is
 * ever confirmed, this file is the one place that changes and the Unclassified
 * part disappears from both screens on its own.
 *
 * Matched as substrings of the upper-cased value because the extract is not
 * consistent about form — "CONFIRMATION", "CONTRACTUAL", "PROBATION" and
 * "PART TIME" all appear, and a school is free to add another tomorrow.
 */
export const PERMANENT_TYPE = /CONFIRM|PERMANENT|REGULAR/;
export const IMPERMANENT_TYPE = /CONTRACT|PROBATION|TEMPORARY|TEMP\b|ADHOC|AD[ -]HOC|GUEST|PART[ -]?TIME|TRAINEE|INTERN|PROVISION/;

export interface StaffSplit {
  readonly permanent: number;
  readonly impermanent: number;
  readonly unclassified: number;
  /**
   * Did ANY row name its employment type in words?
   *
   * False means the column is entirely codes for these schools, so there is no
   * split to report and the caller should print the headcount alone. Three parts
   * reading 0 / 0 / everything is not information.
   */
  readonly classified: boolean;
}

/**
 * Split rows of `{ stafftype, <countField> }` three ways.
 *
 * The count column is named by the caller because the two statements that feed
 * this differ in what they measure and say so in their own names: `home.ts`
 * counts active employees (`n`), while the Dashboard's tiles count the ones on
 * roll on the as-of date (`on_roll`). Same classification, different measure.
 */
export function splitStaffTypes(
  rows: readonly Record<string, unknown>[],
  countField: string,
): StaffSplit {
  let permanent = 0;
  let impermanent = 0;
  let unclassified = 0;

  for (const row of rows) {
    const type = String(row['stafftype'] ?? '').trim().toUpperCase();
    const value = Number(row[countField]);
    const count = Number.isFinite(value) ? value : 0;
    if (PERMANENT_TYPE.test(type)) permanent += count;
    else if (IMPERMANENT_TYPE.test(type)) impermanent += count;
    else unclassified += count;
  }

  return { permanent, impermanent, unclassified, classified: permanent > 0 || impermanent > 0 };
}
