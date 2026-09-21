/**
 * Filling a message's `{{variable}}` slots from the record a run is FOR.
 *
 * Contract source: docs/07 §2 ("every node exposes downstream variables
 * … picked from a dropdown, never typed blind") · ADR-024 (approved-template-
 * only sending) · ADR-035 (a real send now consumes the result of this).
 *
 * -- Why this is one shared function ------------------------------------------
 * Three surfaces render the same message and must never disagree: the builder's
 * live preview, the dry-run test panel's "exact rendered message previews per
 * branch" (docs/10 §2), and the send itself. Two of the three claim to show
 * what the third will do, so a second implementation anywhere would be a
 * preview that lies — the same "one function, unit-tested" discipline ADR-034
 * required of channel resolution and ADR-028 of `permission_class`.
 *
 * -- What it deliberately does NOT do -----------------------------------------
 * It does not invent values. An unresolved slot is left standing as
 * `{{student.name}}`, visibly, rather than blanked or replaced with a guess:
 * blanking produces "Dear parent,  has been absent", which reads as a bug in
 * the school's message rather than as missing data, and CODING_GUIDELINES §10
 * names silent success-shaped failure as the worst bug class here. A caller
 * that must not send a half-filled message asks `unresolvedSlots` first.
 *
 * It also renders TEXT, never markup. The record comes from a school database
 * and the body may be sent as HTML by a transport; escaping is the sender's
 * job, at the point it knows the format (see `escapeHtml` in the orchestrator's
 * pdf.ts for the same rule applied to the print payload).
 */

const SLOT = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/**
 * Two vocabularies, one record.
 *
 * docs/07 §1/§2 write template variables in a PRESENTATION vocabulary that
 * groups by subject — `{{student.name}}`, `{{fee.balance_amount}}`,
 * `{{parent.phone}}` — and every template in the gallery is written that way.
 * The records a run carries are flat, because a fetch source declares flat
 * `fields` (`FETCH_SOURCES` in types.ts) and the evaluator spreads the query
 * row as-is: `student_name`, `balance_amount`, `days_overdue`.
 *
 * Neither side is wrong and neither should be rewritten to match the other: the
 * dotted names are what a school reads in the builder, and the flat names are
 * the columns a vetted SELECT actually returns. So resolution tries four
 * things, in a fixed order, and stops at the first that yields a value:
 *
 *   1. the whole path as a literal key   — `{{days_overdue}}` → `days_overdue`
 *   2. a nested path                     — if a caller ever does build objects
 *   3. the path with `_` for `.`         — `{{student.name}}` → `student_name`
 *   4. the LAST segment alone            — `{{fee.balance_amount}}` → `balance_amount`
 *
 * Rule 4 is the one that carries the group prefixes the flat schema does not
 * have (`fee.`, `student.class`), and it is last precisely because it is the
 * broadest: anything a more literal rule can answer is answered before it. The
 * order is fixed and total — there is no scoring and no nearest-match — so the
 * same template and the same record always render the same way, which is what
 * lets the builder preview, the dry-run panel and the send agree.
 */
function lookup(record: Readonly<Record<string, unknown>>, path: string): unknown {
  if (path in record) return record[path];

  let current: unknown = record;
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null) {
      current = undefined;
      break;
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (current !== undefined && current !== null) return current;

  const underscored = path.replace(/\./g, '_');
  if (underscored in record) return record[underscored];

  const segments = path.split('.');
  const last = segments[segments.length - 1];
  if (segments.length > 1 && last !== undefined && last in record) return record[last];

  return undefined;
}

function stringify(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return null;
}

/** Fills every slot it can; leaves the rest standing. */
export function renderMessageBody(template: string, record: Readonly<Record<string, unknown>>): string {
  return template.replace(SLOT, (whole, path: string) => stringify(lookup(record, path)) ?? whole);
}

/** The slots `renderMessageBody` could not fill — what a caller checks before sending. */
export function unresolvedSlots(template: string, record: Readonly<Record<string, unknown>>): readonly string[] {
  const out: string[] = [];
  for (const match of template.matchAll(SLOT)) {
    const path = match[1];
    if (path !== undefined && stringify(lookup(record, path)) === null) out.push(path);
  }
  return [...new Set(out)];
}

/**
 * A subject line for an email carrying this message.
 *
 * Email is the one channel with a subject, and no template in the gallery has
 * one — docs/07 §6's templates are bodies, written when WhatsApp and SMS were
 * the assumed channels. Rather than invent a subject field on a contract the
 * Template Manager will own (ADR-024), the subject is DERIVED: the agent's own
 * name, which is the one string the school itself wrote to describe what this
 * message is for ("Absence alert — Class 9"). A subject taken from the body's
 * first line would be the message repeated in the preview pane, and a fixed
 * "Notification from your school" tells a reader nothing at the moment they
 * decide whether to open it.
 */
export function messageSubject(agentName: string): string {
  return agentName.trim() === '' ? 'A message from your school' : agentName.trim();
}

/**
 * Which of a template's slots no record from this source could ever fill.
 *
 * The builder's version of `unresolvedSlots`: it has a template and a list of
 * field NAMES, not a record. Implemented by standing up a record with those
 * names and asking the real function, so the four resolution rules are applied
 * by the code that owns them — a second, "close enough" implementation here is
 * how a builder starts promising something the runtime will refuse.
 *
 * `fields` should exclude anything the source declares but cannot populate
 * (`UNPOPULATED_FIELDS`), because a slot that resolves to null at send time is
 * not a slot that works.
 */
export function slotsNotCoveredBy(template: string, fields: readonly string[]): readonly string[] {
  const stand_in: Record<string, unknown> = {};
  for (const field of fields) stand_in[field] = '·';
  return unresolvedSlots(template, stand_in);
}
