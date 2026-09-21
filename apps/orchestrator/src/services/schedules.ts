/**
 * Scheduled report delivery (ADR-037).
 *
 * Contract source: ADR-037 · docs/06 §7 ("scheduled report emails re-run
 * definitions and attach PDFs") · docs/10 §2 ("Schedule") · ADR-035 (the
 * transport) · ADR-021 (the PDF is rendered from the persisted spec) ·
 * docs/08 §7 (every delivery is an audited chokepoint).
 *
 * -- The one hard problem this module solves ----------------------------------
 * Invariant 2 constrains every query to the `school_ids` in a verified launch
 * token, and a 07:30 delivery has no token. There are exactly three places the
 * scope of an unattended read could come from, and two are forbidden: the ERP
 * at send time (Invariant 1, ADR-005) and the client (CODING_GUIDELINES §8).
 * The third is a set CAPTURED from a verified token while a human was present,
 * and RE-VALIDATED against the registry every time it is honoured. That is what
 * `createSchedule` and `deliverSchedule` do between them, and it is the same
 * shape ADR-032 uses for `report_definitions.school_scope` and ADR-022 for an
 * agent's deploy scope — a third unattended caller, not a third mechanism.
 *
 * A schedule is therefore a REQUEST with a pinned authority, never a standing
 * permission: `created_role`/`created_perms` travel with the row so a delivery
 * reads exactly as much as its creator could, and re-saving re-pins them.
 *
 * -- What this module never stores --------------------------------------------
 * A report. No figure, no row and no rendered PDF is kept here; a delivery
 * re-runs the definition against fresh data by definition (docs/06 §7), and a
 * stored PDF would be school data at rest with no TTL.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { ERROR_CODES, PlatformError, effectiveScope, permissionClass, type ErrorDetails } from '@sap/shared';
import { MailerError } from '@sap/mailer';
import { agentsDb } from '../db/agents-db.js';
import { reportSchedules, scheduleDeliveries, type Weekday } from '../db/schedules-schema.js';
import { orgName, schoolNames, servableSchoolIds } from '../db/registry.js';
import { auditSink } from '../db/audit.js';
import { enqueueImmediateDelivery, syncScheduleJob } from '../queue/schedule-queue.js';
import { buildDashboard, isDashboardId, type DashboardResult } from './dashboards.js';
import { resolveAcademicYears } from './home.js';
import { viewReport } from './custom-reports.js';
import { connectedChannelIds } from './channels.js';
import { renderReportPdf } from './pdf.js';
import { emailTransport } from './email.js';
import type { SessionClaims } from '../auth/session.js';

/**
 * The same Drizzle handle every other agent/channel query uses — one connection
 * pool, several query interfaces (db/agents-db.ts). A second pool for two more
 * tables would be two pools against one database.
 */
const db = agentsDb;

export type DeliveryChannel = 'email' | 'whatsapp';
export type ScheduleReportKind = 'predefined' | 'custom';

/** What the Schedule screen renders. Never the stored row verbatim: `created_perms` is not a reader's business. */
export interface ScheduleView {
  readonly id: string;
  readonly report_id: string;
  readonly report_kind: ScheduleReportKind;
  readonly report_title: string;
  readonly days: readonly Weekday[];
  readonly time: string;
  readonly tz: string;
  readonly channel: DeliveryChannel;
  readonly recipient: string;
  /**
   * The scope this schedule was SAVED with, as school names for display.
   * A label and never an authorisation — the delivery re-validates the stored
   * ids against the registry at send time (ADR-037), so this list can be a
   * strict superset of what actually gets reported on.
   */
  readonly school_ids: readonly string[];
  readonly school_names: readonly string[];
  readonly paused: boolean;
  readonly created_at: string;
  /** The last attempt, so a row can say what happened rather than only what is planned. */
  readonly last_delivery: {
    readonly at: string;
    readonly status: string;
    readonly error: string | null;
    readonly trigger: 'schedule' | 'manual';
  } | null;
}

export interface NewScheduleInput {
  readonly reportId: string;
  readonly reportKind: ScheduleReportKind;
  readonly reportTitle: string;
  readonly days: readonly number[];
  readonly time: string;
  readonly channel: DeliveryChannel;
  readonly recipient: string;
  readonly schoolIds: readonly string[];
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The school's own clock, not the reader's browser's (docs/10 §2).
 *
 * A trust director sitting in another timezone who asks for 07:30 means the
 * school's 07:30, because that is when the school day the report describes
 * actually starts. One value for now — the platform serves Indian schools and
 * the registry carries no per-school timezone — stated here rather than
 * scattered as a literal, so the day the registry gains one there is a single
 * place that has to change.
 */
const SCHOOL_TZ = 'Asia/Kolkata';

// ---------------------------------------------------------------------------
// Validation — at the trust boundary, before anything is stored
// ---------------------------------------------------------------------------

function invalid(message: string, correlationId: string, details?: ErrorDetails): never {
  throw new PlatformError({
    code: ERROR_CODES.VALIDATION_FAILED,
    message,
    ...(details === undefined ? {} : { details }),
    correlationId,
  });
}

function validateInput(input: NewScheduleInput, correlationId: string): {
  days: Weekday[];
  recipient: string;
} {
  const days = [...new Set(input.days)].filter(
    (d): d is Weekday => Number.isInteger(d) && d >= 0 && d <= 6,
  );
  if (days.length === 0) invalid('Choose at least one day to receive this report.', correlationId);
  if (!TIME.test(input.time)) invalid('Choose a time in 24-hour HH:MM form.', correlationId, { expected: 'HH:MM' });

  /**
   * WhatsApp is refused at save, not at send.
   *
   * docs/10 §3's rule is "locked, not hidden": the option is shown, and the
   * reason it cannot be chosen is named where it is chosen. Storing a schedule
   * that could never fire would be the other kind of dishonesty — a row on the
   * list saying "Every Monday · 09:00" beside a next-run time, delivering
   * nothing, forever. The COLUMN accepts 'whatsapp' because the day items 4/8
   * are answered this becomes a one-line change; the API does not, today.
   */
  if (input.channel !== 'email') {
    invalid(
      'Only email delivery is available today. WhatsApp needs a verified Business account and approved templates, which are not set up yet.',
      correlationId,
      { channel: input.channel, blocked_by: 'docs/11 §2 items 4/8' },
    );
  }

  const recipient = input.recipient.trim();
  if (!EMAIL.test(recipient)) invalid('Enter a valid email address to deliver to.', correlationId);

  if (input.reportKind === 'predefined' && !isDashboardId(input.reportId)) {
    invalid('That report does not exist.', correlationId);
  }

  return { days: days.sort((a, b) => a - b), recipient };
}

/**
 * The captured scope (ADR-037 point 1).
 *
 * [MANDATORY] CODING_GUIDELINES §8: the client never supplies an authoritative
 * school id. What arrives is a REQUEST, intersected here with the creator's
 * verified token scope; what is stored is the intersection. An empty request
 * means "everything I can see", which is the selection the screen had when the
 * reader pressed Save and is the one case where defaulting is right — but it
 * defaults to the token's set, never to the org's.
 */
function captureScope(session: SessionClaims, requested: readonly string[], correlationId: string): string[] {
  if (requested.length === 0) return [...session.school_ids];
  const allowed = new Set(session.school_ids);
  const captured = requested.filter((id) => allowed.has(id));
  if (captured.length === 0) {
    throw new PlatformError({
      code: ERROR_CODES.PERMISSION_DENIED,
      message: 'None of those schools are in your access.',
      correlationId,
    });
  }
  return captured;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listSchedules(session: SessionClaims): Promise<ScheduleView[]> {
  const rows = await db
    .select()
    .from(reportSchedules)
    .where(and(eq(reportSchedules.orgId, session.org_id), isNull(reportSchedules.deletedAt)))
    .orderBy(desc(reportSchedules.createdAt));

  /**
   * Own schedules only. A schedule carries its creator's pinned authority and
   * an address they chose; another reader in the same trust has no business
   * seeing either, and could not edit one safely if they did — editing re-pins
   * the authority to whoever saved it.
   */
  const mine = rows.filter((r) => r.createdBy === session.sub);
  if (mine.length === 0) return [];

  const names = new Map(
    (await schoolNames(mine.flatMap((r) => r.schoolIds))).map((s) => [s.school_id, s.school_name]),
  );

  return Promise.all(
    mine.map(async (row) => {
      const [last] = await db
        .select()
        .from(scheduleDeliveries)
        .where(eq(scheduleDeliveries.scheduleId, row.id))
        .orderBy(desc(scheduleDeliveries.sentAt))
        .limit(1);

      return {
        id: row.id,
        report_id: row.reportId,
        report_kind: row.reportKind,
        report_title: row.reportTitle,
        days: row.days,
        time: row.timeOfDay,
        tz: row.tz,
        channel: row.channel,
        recipient: row.recipient,
        school_ids: row.schoolIds,
        school_names: row.schoolIds.map((id) => names.get(id) ?? id),
        paused: row.status === 'paused',
        created_at: row.createdAt.toISOString(),
        last_delivery:
          last === undefined
            ? null
            : {
                at: last.sentAt.toISOString(),
                status: last.status,
                error: last.error,
                trigger: last.triggerKind,
              },
      } satisfies ScheduleView;
    }),
  );
}

async function ownedRow(id: string, session: SessionClaims, correlationId: string) {
  const [row] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, id));
  if (row === undefined || row.orgId !== session.org_id || row.createdBy !== session.sub || row.deletedAt !== null) {
    /**
     * Deliberately the same refusal for "does not exist" and "is not yours" —
     * distinguishing them would let a caller enumerate other readers' schedule
     * ids, and a schedule id is a handle on somebody's email address.
     */
    throw new PlatformError({
      code: ERROR_CODES.REPORT_DEFINITION_NOT_FOUND,
      message: 'That schedule does not exist.',
      correlationId,
    });
  }
  return row;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createSchedule(args: {
  session: SessionClaims;
  correlationId: string;
  input: NewScheduleInput;
}): Promise<ScheduleView> {
  const { days, recipient } = validateInput(args.input, args.correlationId);
  const schoolIds = captureScope(args.session, args.input.schoolIds, args.correlationId);
  const id = randomUUID();

  await db.insert(reportSchedules).values({
    id,
    orgId: args.session.org_id,
    reportId: args.input.reportId,
    reportKind: args.input.reportKind,
    reportTitle: args.input.reportTitle.slice(0, 255),
    schoolIds,
    days,
    timeOfDay: args.input.time,
    tz: SCHOOL_TZ,
    channel: args.input.channel,
    recipient,
    status: 'active',
    /** The pinned authority (ADR-037 point 3) — re-pinned on every edit. */
    createdRole: args.session.role,
    createdPerms: [...args.session.perms],
    createdBy: args.session.sub,
  });

  await syncScheduleJob(id, { days, timeOfDay: args.input.time, tz: SCHOOL_TZ });
  await writeConfigAudit(args.session, args.correlationId, 'created', args.input.reportTitle);

  const [view] = await listSchedulesById(args.session, id);
  if (view === undefined) {
    throw new PlatformError({
      code: ERROR_CODES.INTERNAL,
      message: 'The schedule was saved but could not be read back.',
      correlationId: args.correlationId,
    });
  }
  return view;
}

export async function updateSchedule(args: {
  session: SessionClaims;
  correlationId: string;
  id: string;
  input: NewScheduleInput;
}): Promise<ScheduleView> {
  const existing = await ownedRow(args.id, args.session, args.correlationId);
  const { days, recipient } = validateInput(args.input, args.correlationId);
  const schoolIds = captureScope(args.session, args.input.schoolIds, args.correlationId);

  await db
    .update(reportSchedules)
    .set({
      reportId: args.input.reportId,
      reportKind: args.input.reportKind,
      reportTitle: args.input.reportTitle.slice(0, 255),
      schoolIds,
      days,
      timeOfDay: args.input.time,
      channel: args.input.channel,
      recipient,
      /**
       * Re-pinned, not preserved. An edit is a fresh statement of intent by
       * whoever made it, so the authority the delivery runs at becomes theirs
       * as of now — which is also the only way a schedule whose creator's role
       * changed can be brought back in line (ADR-037, trade-offs).
       */
      createdRole: args.session.role,
      createdPerms: [...args.session.perms],
    })
    .where(eq(reportSchedules.id, args.id));

  await syncScheduleJob(
    args.id,
    existing.status === 'paused' ? null : { days, timeOfDay: args.input.time, tz: existing.tz },
  );
  await writeConfigAudit(args.session, args.correlationId, 'updated', args.input.reportTitle);

  const [view] = await listSchedulesById(args.session, args.id);
  if (view === undefined) {
    throw new PlatformError({
      code: ERROR_CODES.INTERNAL,
      message: 'The schedule was saved but could not be read back.',
      correlationId: args.correlationId,
    });
  }
  return view;
}

export async function setSchedulePaused(args: {
  session: SessionClaims;
  correlationId: string;
  id: string;
  paused: boolean;
}): Promise<void> {
  const row = await ownedRow(args.id, args.session, args.correlationId);

  await db
    .update(reportSchedules)
    .set({ status: args.paused ? 'paused' : 'active' })
    .where(eq(reportSchedules.id, args.id));

  /**
   * The queue is the source of truth for whether anything fires, so pausing
   * REMOVES the repeatable job rather than relying on the worker to check a
   * column. A paused schedule whose job still ran would be a delivery that
   * depends on a guard nobody can see from the queue.
   */
  await syncScheduleJob(args.id, args.paused ? null : { days: row.days, timeOfDay: row.timeOfDay, tz: row.tz });
  await writeConfigAudit(args.session, args.correlationId, args.paused ? 'paused' : 'resumed', row.reportTitle);
}

export async function deleteSchedule(args: {
  session: SessionClaims;
  correlationId: string;
  id: string;
}): Promise<void> {
  const row = await ownedRow(args.id, args.session, args.correlationId);

  /**
   * Soft-deleted, because `schedule_deliveries` foreign-keys to this row and
   * those rows are the audit trail for messages that really went out (docs/08
   * §7). A hard delete would cascade away the evidence that a school was sent
   * a report — the one thing the table exists to be able to prove.
   */
  await db.update(reportSchedules).set({ deletedAt: new Date() }).where(eq(reportSchedules.id, args.id));
  await syncScheduleJob(args.id, null);
  await writeConfigAudit(args.session, args.correlationId, 'deleted', row.reportTitle);
}

/** "Send now" — the same delivery path, off the clock (ADR-037 point 6). */
export async function sendScheduleNow(args: {
  session: SessionClaims;
  correlationId: string;
  id: string;
}): Promise<void> {
  await ownedRow(args.id, args.session, args.correlationId);
  await enqueueImmediateDelivery(args.id);
}

async function listSchedulesById(session: SessionClaims, id: string): Promise<ScheduleView[]> {
  return (await listSchedules(session)).filter((s) => s.id === id);
}

/** docs/08 §7: "Config changes … " — a schedule is one, same as a channel connect. */
async function writeConfigAudit(
  session: SessionClaims,
  correlationId: string,
  action: string,
  reportTitle: string,
): Promise<void> {
  await auditSink.write({
    kind: 'config.changed',
    at: new Date().toISOString(),
    actor_sub: session.sub,
    org_id: session.org_id,
    correlation_id: correlationId,
    subject: 'schedule',
    action,
    /** Never the recipient address: this is the operational-ish config trail,
     * and the address lives in `report_schedules`/`schedule_deliveries`, which
     * carry the PII exemption (0010's header note). */
    summary: `${action} schedule for "${reportTitle}"`,
  });
}

// ---------------------------------------------------------------------------
// Delivery — what the queue worker runs
// ---------------------------------------------------------------------------

/**
 * One delivery, from a schedule id.
 *
 * [MANDATORY] CODING_GUIDELINES §11, applied the same way apps/agent-runtime
 * applies it to an agent run: a failure here is a recorded outcome, never an
 * exception that kills the worker. Every exit from this function writes a
 * `schedule_deliveries` row saying what happened and why — including the skips,
 * because "not sent" with no reason is the state a school admin cannot act on.
 */
export async function deliverSchedule(scheduleId: string, trigger: 'schedule' | 'manual'): Promise<void> {
  const startedAt = Date.now();
  const [row] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, scheduleId));

  /**
   * A job with no row behind it is not an error to record — there is nothing to
   * record it against. It happens when a schedule is deleted between a firing
   * being enqueued and being picked up; the repeatable job is already gone, so
   * this is the last echo of it.
   */
  if (row === undefined || row.deletedAt !== null) return;

  /**
   * Bound once, so the closure below reads a value TypeScript already knows is
   * present rather than re-asserting it on every field.
   */
  const schedule = row;
  const correlationId = `sched-${randomUUID()}`;

  async function record(
    status: 'sent' | 'failed' | 'skipped_scope_empty' | 'skipped_channel_not_connected' | 'skipped_paused',
    extra: { schoolIds: string[]; providerRef?: string; error?: string },
  ): Promise<void> {
    await db.insert(scheduleDeliveries).values({
      scheduleId,
      orgId: schedule.orgId,
      schoolIds: extra.schoolIds,
      channel: schedule.channel,
      recipient: schedule.recipient,
      triggerKind: trigger,
      status,
      ...(extra.providerRef === undefined ? {} : { providerRef: extra.providerRef }),
      ...(extra.error === undefined ? {} : { error: extra.error.slice(0, 255) }),
      durationMs: Date.now() - startedAt,
    });
  }

  if (row.status === 'paused') {
    await record('skipped_paused', { schoolIds: [] });
    return;
  }

  /**
   * -- Re-validation (ADR-037 point 2) --------------------------------------
   *
   * The stored set is intersected with the schools the registry can currently
   * serve, EVERY time. A school that left the org, was suspended or lost its
   * entitlement between saving and sending drops out here rather than
   * continuing to be reported on — which is the entire reason a schedule is
   * allowed to carry a scope at all.
   */
  const { effective } = effectiveScope(row.schoolIds, await servableSchoolIds());
  const schoolIds = [...effective];
  if (schoolIds.length === 0) {
    await record('skipped_scope_empty', {
      schoolIds: [],
      error: 'No school on this schedule is available to report on any more.',
    });
    return;
  }

  /**
   * The channel must be connected for the schools being reported on (ADR-034's
   * resolution, ADR-024's connection-gated sending). Checked against the FIRST
   * school of the re-validated set: a delivery is one document covering the
   * whole selection, sent once, so there is one channel decision to make and
   * the school whose data leads the report is the one that makes it.
   */
  const firstSchool = schoolIds[0];
  if (firstSchool !== undefined) {
    const connected = await connectedChannelIds(row.orgId, firstSchool);
    if (!connected.has('email')) {
      await record('skipped_channel_not_connected', {
        schoolIds,
        error: 'Email is not connected for this school — connect it in Settings.',
      });
      return;
    }
  }

  /**
   * The pinned authority, reconstituted as a session (ADR-037 point 3).
   *
   * Everything downstream — `buildDashboard`, `viewReport`, the MCP call
   * context, the result-cache key — takes a `SessionClaims`, and this is one:
   * the creator's role and perms as they stood when they saved, over the scope
   * that just re-validated. `permission_class` is recomputed from them rather
   * than stored, so a delivery's cache entries land in exactly the same
   * partition an interactive read by that person would (ADR-028).
   */
  const session: SessionClaims = {
    sub: row.createdBy,
    name: 'Scheduled delivery',
    role: row.createdRole,
    org_id: row.orgId,
    school_ids: schoolIds,
    default_school: firstSchool ?? schoolIds[0] ?? '',
    perms: row.createdPerms,
    permission_class: permissionClass({ role: row.createdRole, perms: row.createdPerms }),
  };

  try {
    const { dashboard, title } = await runReport(row, session, schoolIds, correlationId);
    const scope = await schoolNames(schoolIds);
    const scopeLine = scope.map((s) => s.school_name).join(' · ');

    const pdf = await renderReportPdf({
      dashboard,
      title,
      orgName: await orgName(row.orgId),
      scopeLine,
      /**
       * The appendix is off. Invariant 6 keeps report logic available on every
       * surface, and it is — one click away in the app — but an emailed PDF is
       * the one copy that gets forwarded outside the school, and a SQL appendix
       * on a document sent to a parent-facing address is schema detail with no
       * reader. The reader who wants it exports with `?logic=1`.
       */
      includeLogic: false,
    });

    const result = await emailTransport().send({
      to: row.recipient,
      subject: `${title} · ${scopeLine}`,
      text: bodyFor(title, scopeLine, trigger),
      attachments: [
        { filename: pdfFilename(title), content: pdf, contentType: 'application/pdf' },
      ],
      correlationId,
    });

    await record('sent', { schoolIds, providerRef: result.providerRef });

    /**
     * [MANDATORY] docs/08 §7: "PDF export — report, school-set". A delivery
     * really did render and send a branded document, so it belongs in Export
     * History beside the ones a reader clicked — attributed to the schedule's
     * owner, because it went out on their instruction. Written only after a
     * successful send, the same rule routes/report.ts follows: a failed
     * delivery produced no document anyone received.
     */
    await auditSink.write({
      kind: 'report.exported',
      at: new Date().toISOString(),
      actor_sub: row.createdBy,
      org_id: row.orgId,
      correlation_id: correlationId,
      report_id: row.reportId,
      school_ids: schoolIds,
      format: 'pdf',
    });
  } catch (error) {
    /**
     * Two failure classes, one row. A `MailerError` already carries plain
     * language safe to show (@sap/mailer translates provider errors for exactly
     * this); a `PlatformError` from the report path carries a message written
     * for a reader. Anything else is reported as a generic failure rather than
     * having its text passed through, because an unclassified error can carry a
     * hostname or a SQL fragment and CODING_GUIDELINES §6 forbids either
     * reaching a caller.
     */
    const reason =
      error instanceof MailerError || error instanceof PlatformError
        ? error.message
        : 'The report could not be produced for delivery.';
    await record('failed', { schoolIds, error: reason });
    console.error(`[orchestrator] schedule ${scheduleId} delivery failed: ${reason}`);
  }
}

/**
 * Re-runs the report behind a schedule — both catalogs, one return shape.
 *
 * The title comes from the CATALOG, not from `report_schedules.report_title`:
 * that column is a label kept so a broken schedule can still say what it was
 * for, and a report renamed since would otherwise be delivered under its old
 * name with its new contents.
 */
async function runReport(
  row: typeof reportSchedules.$inferSelect,
  session: SessionClaims,
  schoolIds: readonly string[],
  correlationId: string,
): Promise<{ dashboard: DashboardResult; title: string }> {
  if (row.reportKind === 'custom') {
    const view = await viewReport({ session, correlationId, id: row.reportId, requestedSchoolIds: schoolIds });
    return {
      dashboard: {
        spec: view.spec,
        logic: view.logic,
        degraded: view.degraded,
        degraded_schools: view.degraded_schools,
      },
      title: view.spec.title,
    };
  }

  if (!isDashboardId(row.reportId)) {
    throw new PlatformError({
      code: ERROR_CODES.REPORT_NOT_FOUND,
      message: 'The report this schedule points at no longer exists.',
      correlationId,
    });
  }

  /**
   * The academic year is DERIVED, not stored on the schedule.
   *
   * A year saved in August 2026 would still be requested in August 2027, and
   * the report would quietly keep describing a finished year — the failure
   * being that nothing looks wrong: real numbers, correct arithmetic, the wrong
   * twelve months. `resolveAcademicYears` is the same resolution the Dashboard
   * does for a reader opening the page, over the same scope, so a delivered
   * report covers the year the school is actually in.
   */
  const { academic_year: academicYear } = await resolveAcademicYears({ session, schoolIds, correlationId });
  if (academicYear === null) {
    /**
     * No `NO_DATA` code exists and none is added here: this never reaches a
     * client. `deliverSchedule` catches it and writes the message into
     * `schedule_deliveries.error`, which is where a reader of the Schedule
     * screen actually sees why nothing arrived.
     */
    throw new PlatformError({
      code: ERROR_CODES.INTERNAL,
      message: 'No academic year has data for these schools yet, so there is nothing to send.',
      correlationId,
    });
  }

  const dashboard = await buildDashboard({
    session,
    schoolIds,
    reportId: row.reportId,
    academicYear,
    asOfDate: todayIso(),
    correlationId,
  });
  return { dashboard, title: dashboard.spec.title };
}

/**
 * The covering note.
 *
 * Plain text, deliberately short, and it does not summarise the report. A
 * sentence in an email claiming a finding ("collections are up 4%") is a second
 * renderer of the same data — ADR-021's whole point is that there is one — and
 * it would be the copy nobody checks. The document is the answer; this says
 * where it came from and how to stop it.
 */
function bodyFor(title: string, scopeLine: string, trigger: 'schedule' | 'manual'): string {
  const opening =
    trigger === 'manual'
      ? 'You asked for this report to be sent now.'
      : 'This is your scheduled report.';
  return [
    opening,
    '',
    `Report: ${title}`,
    `Schools: ${scopeLine}`,
    '',
    'The report is attached as a PDF. Open Analytics from your ERP menu to change or stop this schedule.',
  ].join('\n');
}

function pdfFilename(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug === '' ? 'report' : slug}-${todayIso()}.pdf`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Re-arm every active schedule's repeatable job at boot.
 *
 * BullMQ keeps repeatable definitions in Redis, and this project's Redis runs
 * with persistence deliberately off (docker-compose.yml: "a cache that survives
 * a restart is a cache nobody can clear by restarting it"). That is the right
 * call for the result cache and it means the schedule definitions do NOT
 * survive a Redis restart — so the platform DB is the source of truth and this
 * replays it. `syncScheduleJob` removes any existing definition first, so
 * running this on every boot is idempotent.
 */
export async function rearmSchedules(): Promise<number> {
  const rows = await db
    .select()
    .from(reportSchedules)
    .where(and(eq(reportSchedules.status, 'active'), isNull(reportSchedules.deletedAt)));

  for (const row of rows) {
    await syncScheduleJob(row.id, { days: row.days, timeOfDay: row.timeOfDay, tz: row.tz });
  }
  return rows.length;
}
