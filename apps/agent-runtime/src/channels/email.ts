/**
 * This service's handle on the email transport (ADR-035).
 *
 * One mailer per process, created on first use — the same lazy-singleton shape
 * `resolveEffectiveChannel` neighbours and the orchestrator's Puppeteer browser
 * use, and for the same reason: a connection pool built per message would turn
 * a morning's absence alerts into one SMTP handshake per parent.
 *
 * The transport is configuration, never a channel row (ADR-035). Which school
 * may send on email is answered next door by `resolveEffectiveChannel`; this
 * module only knows how mail leaves the building.
 */

import { createMailer, type Mailer } from '@sap/mailer';
import { config } from '../config.js';

let mailer: Mailer | null = null;

export function emailTransport(): Mailer {
  mailer ??= createMailer(config);
  return mailer;
}

export async function closeEmailTransport(): Promise<void> {
  await mailer?.close();
  mailer = null;
}
