/**
 * Configuration for the orchestrator's tests.
 *
 * `src/config.ts` validates the environment at import time and exits the process
 * if it is incomplete — deliberately, so a misconfigured deployment fails at
 * boot rather than on a user's first request. That is right for a service and
 * awkward for a test run, so this module supplies whatever the developer's
 * `.env` does not.
 *
 * Import it FIRST in any test that reaches a module importing `config`. ES
 * modules evaluate dependencies in source order, so a first-position import runs
 * before the rest — which is the whole mechanism here.
 *
 * Precedence is deliberate: the real `.env` loads first and wins, so a developer
 * with a local database gets their own credentials.
 *
 * [MANDATORY] CODING_GUIDELINES §12: no hard-coded secrets, "including tests and
 * scripts". Nothing below is a credential to anything — the vault key is 32
 * fixed bytes used to encrypt a fake key inside one test process, and the
 * database placeholders are values chosen to FAIL a connection, not to make one.
 */

import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-a-credential';
process.env['MCP_CONTEXT_SECRET'] ??= 'test-only-context-secret-not-a-credential';
process.env['ERP_JWKS_URL'] ??= 'http://localhost:4000/.well-known/jwks.json';
process.env['ERP_ISSUER'] ??= 'http://localhost:4000';
process.env['PLATFORM_DB_USER'] ??= 'no-such-user';
process.env['PLATFORM_DB_PASSWORD'] ??= '';
/** 32 bytes, so the vault's length check passes. Encrypts nothing real. */
process.env['AI_KEY_ENCRYPTION_KEY'] ??= Buffer.alloc(32, 3).toString('base64');

/**
 * The result cache is OFF in tests, and this one is forced rather than
 * defaulted — a developer's `.env` must not be able to switch it back on.
 *
 * Two reasons, and the first one is not hypothetical: with a Redis running
 * locally, `buildDashboard` cached one test's canned response and served it to
 * the next, so a test asserting 35 defaulters read 12 from the test above it.
 * Tests that share state through a server outside the process are not tests.
 *
 * The second is portability: a suite that needs a Redis to pass cannot run on a
 * machine that has none, and every test in this repo is meant to run anywhere.
 * The cache's own logic is covered by cache-key.test.ts, which needs no server
 * because the property that matters lives in the key.
 */
process.env['CACHE_ENABLED'] = 'false';
