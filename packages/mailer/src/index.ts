/**
 * @sap/mailer — the email transport (ADR-035).
 *
 * Server-only. `apps/web` must have no dependency path to this package: it
 * pulls in an SMTP client and reads credentials from configuration, and
 * CODING_GUIDELINES §1 is [MANDATORY] that the browser bundle can never contain
 * either.
 */

export { smtpConfigSchema, smtpCredentialIssue, type SmtpConfig, type SmtpConfigInput } from './config.js';
export {
  createMailer,
  MailerError,
  type Mailer,
  type MailAttachment,
  type MailMessage,
  type MailResult,
} from './mailer.js';
