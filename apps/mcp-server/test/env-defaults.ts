/**
 * Configuration for tests.
 *
 * `src/config.ts` validates the environment at import time and exits the process
 * if it is incomplete — deliberately, so a misconfigured deployment fails at boot
 * rather than on a tenant's first query. That is right for a service and awkward
 * for a test run, so this module supplies whatever the developer's `.env` does
 * not.
 *
 * Import it FIRST in any test that reaches a module importing `config`. ES
 * modules evaluate their dependencies in source order, so a first-position
 * import runs before the rest — which is the whole mechanism here.
 *
 * Precedence is deliberate: the real `.env` is loaded first and wins, so a
 * developer with a local database gets their own credentials and the
 * DB-dependent tests actually run. The placeholders below only fill gaps, so a
 * machine with no `.env` at all can still run every test that does not need a
 * database — which is all of the invariant tests, by design.
 *
 * [MANDATORY] CODING_GUIDELINES §12: no hard-coded secrets, "including tests and
 * scripts". Nothing below is a credential to anything: the context secret is a
 * throwaway signing key for a test-local server, and the database placeholders
 * are values chosen to fail a connection, not to make one.
 */

import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

/** Only ever used to sign contexts for a server this process started itself. */
export const TEST_CONTEXT_SECRET = 'test-only-context-secret-not-a-credential';

process.env['MCP_CONTEXT_SECRET'] ??= TEST_CONTEXT_SECRET;
process.env['PLATFORM_DB_USER'] ??= 'no-such-user';
process.env['PLATFORM_DB_PASSWORD'] ??= '';
process.env['SCHOOL_DB_USER'] ??= 'no-such-user';
process.env['SCHOOL_DB_PASSWORD'] ??= '';
