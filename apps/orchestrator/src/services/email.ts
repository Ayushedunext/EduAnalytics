/**
 * This service's handle on the email transport (ADR-035).
 *
 * One mailer per process, created on first use — the same lazy-singleton shape
 * as the Puppeteer browser in pdf.ts, for the same reason: a scheduled fan-out
 * across a trust's schools should cost one connection pool, not one SMTP
 * handshake per delivery.
 *
 * The transport is configuration, never a channel row (ADR-035). Whether a
 * given school may send on email is `services/channels.ts`'s answer, resolved
 * per school; this module only knows how mail leaves the building.
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
