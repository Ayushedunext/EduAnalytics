/**
 * The transport's configuration shape (ADR-035).
 *
 * -- Why this lives in a package and not in each service's config.ts ----------
 * Two services send mail — apps/orchestrator (scheduled report deliveries) and
 * apps/agent-runtime (message action nodes) — and they must agree on every
 * field, because a deployment sets these variables once. Two hand-written copies
 * of the same zod object is precisely the drift CODING_GUIDELINES §1 forbids for
 * contracts; each service composes THIS schema into its own instead.
 *
 * -- What is deliberately not here -------------------------------------------
 * Any notion of WHICH school may send. That is channel state
 * (`school_channels`/`org_channels`, resolved by @sap/agent-graph's
 * `resolveChannel` per ADR-034) and it never enters this file. The split is the
 * whole of ADR-035: state in the database, secrets in configuration.
 */

import { z } from 'zod';

export const smtpConfigSchema = z.object({
  /**
   * Loopback in development (the Mailpit container in docker-compose.yml), a
   * private address in production. Like every other host in this codebase it is
   * CONFIGURATION and never a request parameter — the same reasoning
   * `PRINT_URL` carries in the orchestrator's config.
   */
  SMTP_HOST: z.string().min(1).default('127.0.0.1'),
  /**
   * 1026, not Mailpit's own 1025, because that is where this repository's
   * `docker-compose.yml` publishes it — and the reason it publishes there is
   * that the default port is taken on at least one developer machine by a
   * neighbouring project's Mailpit. A default that pointed at 1025 would make
   * an unconfigured deployment send school data into whatever else answers
   * there, which is the wrong-but-working failure the compose file exists to
   * prevent.
   */
  SMTP_PORT: z.coerce.number().int().positive().default(1026),

  /**
   * One address for the whole deployment until per-org SMTP configuration
   * exists (ADR-035, trade-offs). Stated on screen in Settings rather than left
   * for an admin to discover from a received header.
   */
  SMTP_FROM: z.string().email('SMTP_FROM must be an email address').default('analytics@school.test'),
  SMTP_FROM_NAME: z.string().default('School Analytics'),

  /**
   * Implicit TLS on connect (port 465). STARTTLS on a plain port is negotiated
   * by the client automatically when the server advertises it, so there is no
   * third mode to configure. False locally: Mailpit speaks plain SMTP on 1025.
   */
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /**
   * Both or neither. Unset against Mailpit, which authenticates nobody; set
   * together from Secrets Manager against a real relay. A half-configured pair
   * is a misconfiguration this schema refuses at boot rather than a connection
   * that fails on the first scheduled delivery at 07:30 (§10, fail loud).
   *
   * [MANDATORY] §12/§13: `SMTP_PASSWORD` is a log-forbidden value. It is read
   * here and handed straight to the transport; nothing in this package ever
   * prints, returns or serialises it.
   */
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),

  /**
   * One send's whole budget — connection, handshake, DATA. Short enough that a
   * dead relay fails a delivery loudly instead of holding a queue worker for
   * minutes, generous enough for a Fee Defaulters PDF of a few hundred KB.
   */
  SMTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
});

export type SmtpConfigInput = z.input<typeof smtpConfigSchema>;
export type SmtpConfig = z.output<typeof smtpConfigSchema>;

/**
 * The both-or-neither rule above, as a check a service runs after parsing.
 *
 * Expressed here rather than as a `.refine()` on the schema so each service can
 * report it in its own boot-failure format (both print a list of issues and
 * exit non-zero), and so a test can assert the rule without building an
 * environment.
 */
export function smtpCredentialIssue(config: SmtpConfig): string | null {
  const hasUser = config.SMTP_USER !== undefined && config.SMTP_USER !== '';
  const hasPassword = config.SMTP_PASSWORD !== undefined && config.SMTP_PASSWORD !== '';
  if (hasUser === hasPassword) return null;
  return hasUser
    ? 'SMTP_USER is set but SMTP_PASSWORD is not — set both, or neither for an unauthenticated relay such as Mailpit.'
    : 'SMTP_PASSWORD is set but SMTP_USER is not — set both, or neither for an unauthenticated relay such as Mailpit.';
}
