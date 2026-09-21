/**
 * The email transport (ADR-035).
 *
 * Contract source: ADR-035 ("the same interface is where an SES/BSP adapter
 * would land if item 8 resolves that way, which is why it takes a message and
 * returns a provider reference rather than exposing SMTP concepts to its
 * callers") · docs/07 §4 · CODING_GUIDELINES §12 (secrets in config) and §13
 * (what may never be logged).
 *
 * -- Why the interface is this narrow -----------------------------------------
 * Two callers send mail and neither should know what SMTP is. A message action
 * node (apps/agent-runtime) knows a recipient, an approved template and a
 * rendered body; a scheduled delivery (apps/orchestrator) knows a recipient, a
 * report title and a PDF. Both want the same thing back — a provider reference
 * to write into their audit row (`message_log.provider_ref`,
 * `schedule_deliveries.provider_ref`) — and nothing else. Everything SMTP-shaped
 * stops at this file, which is what makes docs/11 §2 item 8 resolvable later by
 * writing a sibling of this module rather than by touching either caller.
 *
 * -- What this module must never do -------------------------------------------
 * Log a body, a subject, a recipient or a credential. Message content is school
 * data and recipients are contact PII; the audit trail for a send is the
 * caller's own table (the exemption `message_log` carries, per db/platform/
 * migrations/0009_agents.sql's PII note), never this process's stdout
 * (CODING_GUIDELINES §13). The only things this module prints are a host, a port
 * and a failure class.
 *
 * -- One transporter, many sends ----------------------------------------------
 * Same reasoning as services/pdf.ts's single browser: a connection pool is
 * created lazily on first use and reused, because opening an SMTP connection per
 * message would make a fan-out of forty scheduled deliveries forty handshakes.
 */

import nodemailer, { type Transporter } from 'nodemailer';
import type { SmtpConfig } from './config.js';

/** An attachment, already rendered by the caller — a branded report PDF today. */
export interface MailAttachment {
  readonly filename: string;
  readonly content: Uint8Array;
  readonly contentType: string;
}

export interface MailMessage {
  /** One address. Fan-out is the caller's loop, so one failure is one recorded failure. */
  readonly to: string;
  readonly subject: string;
  /** Always present: a mail with no text part is a mail some clients render blank. */
  readonly text: string;
  readonly html?: string;
  readonly attachments?: readonly MailAttachment[];
  /**
   * Correlation id (CODING_GUIDELINES §5: every request/run carries one through
   * MCP calls, queue messages and logs). Travels as a header so a message found
   * in an inbox — or in Mailpit — can be traced back to the run or delivery that
   * sent it without opening the database.
   */
  readonly correlationId?: string;
}

export interface MailResult {
  /**
   * The transport's own message id, written to the caller's audit row. Never
   * prefixed `sandbox-`: that prefix is reserved by @sap/agent-graph's
   * `SANDBOX_PROVIDER` for the simulated path, and ADR-035 turns on a reader of
   * `message_log` being able to tell a delivered message from a simulated one.
   */
  readonly providerRef: string;
  /** What the server said it did with the envelope. Recorded, not interpreted. */
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
}

/**
 * A send that did not happen, as a value the caller turns into a structured
 * audit row rather than an exception that kills a queue worker
 * (CODING_GUIDELINES §11 — the rule the run orchestrator's module doc states
 * for provider failures).
 *
 * `message` is written to `message_log.error`/`schedule_deliveries.error`, so it
 * must be plain language and must never carry a credential or a recipient.
 */
export class MailerError extends Error {
  readonly kind: 'connection' | 'auth' | 'rejected' | 'timeout' | 'unknown';

  constructor(kind: MailerError['kind'], message: string) {
    super(message);
    this.name = 'MailerError';
    this.kind = kind;
  }
}

export interface Mailer {
  send(message: MailMessage): Promise<MailResult>;
  /** Proves the transport answers, for a health check or a boot-time smoke test. */
  verify(): Promise<void>;
  close(): Promise<void>;
  /** For display only — Settings states which address a deployment sends from. */
  readonly from: string;
}

export function createMailer(config: SmtpConfig): Mailer {
  let transporter: Transporter | null = null;

  function get(): Transporter {
    transporter ??= nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      /**
       * Only when both halves are present. The both-or-neither rule is checked
       * at boot (`smtpCredentialIssue`); this is the consequence of it —
       * nodemailer treats a half-filled `auth` object as a request to
       * authenticate, which against Mailpit would fail a send for a reason the
       * developer never configured.
       */
      ...(config.SMTP_USER !== undefined && config.SMTP_USER !== '' && config.SMTP_PASSWORD !== undefined
        ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } }
        : {}),
      connectionTimeout: config.SMTP_TIMEOUT_MS,
      greetingTimeout: config.SMTP_TIMEOUT_MS,
      socketTimeout: config.SMTP_TIMEOUT_MS,
      pool: true,
      maxConnections: 3,
    });
    return transporter;
  }

  return {
    from: config.SMTP_FROM,

    async send(message: MailMessage): Promise<MailResult> {
      try {
        const info = await get().sendMail({
          from: { name: config.SMTP_FROM_NAME, address: config.SMTP_FROM },
          to: message.to,
          subject: message.subject,
          text: message.text,
          ...(message.html === undefined ? {} : { html: message.html }),
          ...(message.correlationId === undefined
            ? {}
            : { headers: { 'X-Correlation-Id': message.correlationId } }),
          ...(message.attachments === undefined || message.attachments.length === 0
            ? {}
            : {
                attachments: message.attachments.map((a) => ({
                  filename: a.filename,
                  content: Buffer.from(a.content),
                  contentType: a.contentType,
                })),
              }),
        });

        /**
         * A 2xx from the server with the address in `rejected` is the
         * success-shaped failure CODING_GUIDELINES §10 calls the worst bug class
         * in this system: the send "worked" and nobody was mailed. Treated as a
         * failure here so the caller records one.
         */
        if (info.rejected.length > 0) {
          throw new MailerError('rejected', 'The mail server refused the recipient address.');
        }

        return {
          providerRef: info.messageId,
          accepted: info.accepted.map(String),
          rejected: info.rejected.map(String),
        };
      } catch (error) {
        throw toMailerError(error);
      }
    },

    async verify(): Promise<void> {
      try {
        await get().verify();
      } catch (error) {
        throw toMailerError(error);
      }
    },

    async close(): Promise<void> {
      transporter?.close();
      transporter = null;
    },
  };
}

/**
 * Provider errors, translated to plain language — the same rule
 * `message_log.error` documents ("provider error, translated to plain language,
 * mirrors ADR-017's billing-error rule").
 *
 * Deliberately lossy: the caller writes this string into an audit row a school
 * admin reads, and an SMTP response line quoted verbatim tells them nothing they
 * can act on. The original is re-thrown nowhere and logged nowhere, because it
 * can contain the envelope — recipient included.
 */
function toMailerError(error: unknown): MailerError {
  if (error instanceof MailerError) return error;

  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';

  switch (code) {
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'EHOSTUNREACH':
    case 'ECONNECTION':
      return new MailerError('connection', 'Could not reach the mail server.');
    case 'ETIMEDOUT':
    case 'ESOCKET':
      return new MailerError('timeout', 'The mail server did not respond in time.');
    case 'EAUTH':
      return new MailerError('auth', 'The mail server rejected the configured credentials.');
    case 'EENVELOPE':
      return new MailerError('rejected', 'The mail server refused the recipient address.');
    default:
      return new MailerError('unknown', 'The mail server refused the message.');
  }
}
