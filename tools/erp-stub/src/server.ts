/**
 * Stub EduNext ERP -- NOT PRODUCT CODE.
 *
 * Plays the ERP's side of the launch handshake (docs/02 §2) so the rest of the
 * platform can be built, demonstrated and staged before the ERP team ships
 * their endpoints (docs/11 §2 item 3). It implements exactly the three things
 * the real ERP owes:
 *
 *   1. a menu item that starts the handoff
 *   2. a token-signing endpoint (RS256, 60s, one-time nonce -- ADR-003)
 *   3. a published JWKS so the platform can verify without a shared secret
 *
 * Everything downstream is real. Swapping in the real ERP means changing
 * ERP_JWKS_URL and deleting this directory.
 *
 * TWO FRONT DOORS, ONE HANDSHAKE (`MODE`, below)
 *
 * docs/11 §2 always intended this stub to double as "the staging harness", and
 * staging is the case the original picker cannot serve: there is no ERP to
 * launch from, and a list of personas anyone can click is not a front door.
 * So `ERP_STUB_MODE=login` swaps the picker for a password form (logins.ts,
 * login-page.ts) and switches the picker and its fault injectors off.
 *
 * What does NOT change between the two modes is everything after the password
 * is accepted: the same claims, the same RS256 signature, the same 60-second
 * token, the same auto-POST handoff. Authentication is a gate placed IN FRONT
 * of the handshake, never a variation of it -- which is what keeps the platform
 * unable to tell staging from the real ERP, and keeps CODING_GUIDELINES §11
 * ("never add platform-local login") true of every line in apps/.
 *
 * The picker is deliberately styled to look like a different product, so that
 * in a local demo the handoff into Analytics is visually obvious rather than a
 * subtle change of header colour. The login page is styled the opposite way and
 * says why in its own header.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { getKeys, jwks } from './keys.js';
import { FAULTS, IDENTITIES, findIdentity, type Fault } from './identities.js';
import {
  authenticate,
  enabledLogins,
  passwordVar,
  throttleCheck,
  throttleClear,
  throttleRecordFailure,
} from './logins.js';
import { esc, loginPage } from './login-page.js';

const PORT = Number(process.env.ERP_STUB_PORT ?? 4000);
const ISSUER = process.env.ERP_ISSUER ?? `http://localhost:${PORT}`;
const LAUNCH_URL = process.env.ANALYTICS_LAUNCH_URL ?? 'http://localhost:3000/launch';

/**
 * Which front door this process presents.
 *
 *   picker (default) -- the local development identity list: click a persona,
 *                       inject a fault, no password. Fast, and correct for a
 *                       machine only its owner can reach.
 *   login            -- STAGING: a password form (logins.ts). The picker and
 *                       the fault switches are switched OFF, not merely hidden.
 *
 * Defaulting to `picker` means a developer who pulls this branch sees no
 * change. Staging opts in explicitly, and the mode is printed at boot so a
 * misconfigured deployment is visible in the first ten lines of its log rather
 * than the moment someone notices the front door is open.
 */
const MODE = process.env.ERP_STUB_MODE === 'login' ? 'login' : 'picker';

/** Whether the login page names the configured accounts. See login-page.ts. */
const SHOW_ACCOUNTS = process.env.ERP_STUB_SHOW_ACCOUNTS === 'true';

/**
 * The public path prefix this process is reachable at, if it is not a root.
 *
 * Staging puts the sign-in on the same origin as the SPA, under `/signin`, and
 * the reverse proxy strips the prefix before forwarding -- so the routes below
 * stay `/` and `/login` while the form has to name the un-stripped path. Only
 * the page needs this; the server never sees it. Normalised so that `/signin`,
 * `signin` and `/signin/` all mean the same thing, because a deployment will
 * eventually be configured with each of them.
 */
const BASE_PATH = (() => {
  const raw = (process.env.ERP_STUB_BASE_PATH ?? '').trim().replace(/\/+$/, '');
  if (raw === '') return '';
  return raw.startsWith('/') ? raw : '/' + raw;
})();

/** The three fields every render of the sign-in page needs. */
function loginPageDefaults(): { accounts: ReturnType<typeof enabledLogins>; showHints: boolean; basePath: string } {
  return { accounts: enabledLogins(), showHints: SHOW_ACCOUNTS, basePath: BASE_PATH };
}

/** Token lifetime: 60 seconds, per ADR-003. */
const TOKEN_TTL_SECONDS = 60;

const keys = await getKeys();

/** Remembered so the replay fault can re-send a previously used token. */
let lastToken: string | null = null;

const STYLE = [
  ':root { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }',
  'body { margin:0; background:#eef1f5; color:#1f2937; }',
  'header { background:#1e3a5f; color:#fff; padding:14px 24px; display:flex; align-items:baseline; gap:12px; }',
  'header b { font-size:17px; letter-spacing:.2px; }',
  'header span { font-size:12px; opacity:.75; }',
  '.warn { background:#fff4d6; border-bottom:1px solid #e6d3a3; color:#6b5417; padding:8px 24px; font-size:12.5px; }',
  'main { max-width:760px; margin:28px auto; padding:0 20px; }',
  'h1 { font-size:19px; margin:0 0 4px; font-weight:600; }',
  'p.sub { margin:0 0 22px; color:#6b7280; font-size:13.5px; }',
  '.row { background:#fff; border:1px solid #d7dde5; border-radius:6px; padding:14px 16px; margin-bottom:10px; display:flex; align-items:center; gap:16px; }',
  '.who { flex:1; }',
  '.who b { display:block; font-size:14px; font-weight:600; }',
  '.who small { color:#6b7280; font-size:12px; }',
  'a.launch { background:#1e3a5f; color:#fff; text-decoration:none; padding:8px 14px; border-radius:4px; font-size:13px; white-space:nowrap; }',
  'fieldset { background:#fff; border:1px solid #d7dde5; border-radius:6px; margin:22px 0 0; }',
  'legend { font-size:12px; color:#6b7280; padding:0 6px; }',
  'label { display:block; font-size:13px; padding:3px 0; }',
  'footer { max-width:760px; margin:20px auto 40px; padding:0 20px; color:#6b7280; font-size:12px; }',
  'code { background:#e5e9ef; padding:1px 5px; border-radius:3px; font-size:12px; }',
].join('\n');

function page(body: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<title>EduNext ERP - dev stub</title>',
    '<style>' + STYLE + '</style></head><body>',
    '<header><b>EduNext ERP</b><span>development stub - not the real ERP</span></header>',
    '<div class="warn">This page exists only to sign launch tokens. The real ERP',
    ' will own this step; everything after the handoff is production code.</div>',
    body,
    '</body></html>',
  ].join('\n');
}

function pickerPage(fault: Fault): string {
  const rows = IDENTITIES.map((i) =>
    [
      '<div class="row"><div class="who">',
      '<b>' + esc(i.label) + '</b>',
      '<small>' + esc(i.note) + '</small>',
      '</div><a class="launch" href="/launch-analytics?who=' + i.key + '&amp;fault=' + fault + '">',
      'Analytics &rarr;</a></div>',
    ].join(''),
  ).join('\n');

  const faultKeys = Object.keys(FAULTS) as Fault[];
  const faults = faultKeys
    .map((f) =>
      [
        '<label><input type="radio" name="fault" value="' + f + '"',
        f === fault ? ' checked' : '',
        ' onchange="location.search=\'?fault=\'+this.value"> ',
        esc(FAULTS[f]),
        '</label>',
      ].join(''),
    )
    .join('\n');

  return page(
    [
      '<main><h1>Sign in as&hellip;</h1>',
      '<p class="sub">Pick a user, then click Analytics. The ERP signs a token and hands off.</p>',
      rows,
      '<fieldset><legend>Failure modes (docs/02 &sect;6)</legend>' + faults + '</fieldset>',
      '</main><footer>JWKS <code>' + esc(ISSUER) + '/.well-known/jwks.json</code> &middot; ',
      'key id <code>' + esc(keys.kid) + '</code> &middot; ',
      'launch target <code>' + esc(LAUNCH_URL) + '</code></footer>',
    ].join('\n'),
  );
}

/**
 * The handoff page.
 *
 * ADR-029: the token is delivered by an auto-submitting POST form, never a URL
 * query parameter. A token in a URL lands in ERP access logs, proxy logs,
 * browser history and the Referer header, none of which the platform can scrub,
 * while CODING_GUIDELINES §13 declares launch tokens a log-forbidden value. The
 * 60-second window narrows that exposure; POST removes it.
 */
function handoffPage(token: string): string {
  return page(
    [
      '<main><h1>Opening Analytics&hellip;</h1>',
      '<p class="sub">Handing off to the analytics platform.</p>',
      '<form id="f" method="POST" action="' + esc(LAUNCH_URL) + '">',
      '<input type="hidden" name="token" value="' + esc(token) + '">',
      '<noscript><button type="submit">Continue &rarr;</button></noscript>',
      '</form></main>',
      '<script>document.getElementById("f").submit();</script>',
    ].join('\n'),
  );
}

async function signFor(who: string, fault: Fault): Promise<string> {
  const identity = findIdentity(who);
  if (identity === undefined) throw new Error('unknown identity');

  if (fault === 'replay' && lastToken !== null) return lastToken;

  const now = Math.floor(Date.now() / 1000);
  // The expired fault backdates iat and exp so the token is already stale on
  // arrival. The orchestrator must reject it outright rather than "verify
  // later" (docs/02 §6).
  const iat = fault === 'expired' ? now - 600 : now;
  const exp = fault === 'expired' ? now - 540 : now + TOKEN_TTL_SECONDS;

  const token = await new SignJWT({ ...identity.claims, jti: randomUUID() })
    .setProtectedHeader({ alg: 'RS256', kid: keys.kid, typ: 'JWT' })
    .setIssuer(ISSUER)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(keys.privateKey);

  lastToken = token;

  if (fault === 'badSignature') {
    const parts = token.split('.');
    const sig = parts[2] ?? '';
    const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    return parts[0] + '.' + parts[1] + '.' + flipped;
  }
  return token;
}

/**
 * Send an HTML page that a browser must never reuse.
 *
 * Both pages this stub serves are snapshots of server state that changes under
 * them, and both broke because of it:
 *
 *   * The PICKER lists IDENTITIES. Adding one and restarting left browsers
 *     showing the old list -- a role that exists, is signable, and works, but
 *     cannot be clicked because the page offering it is stale. That is a
 *     confusing failure precisely because nothing is actually broken.
 *   * The HANDOFF page carries a signed launch token in a form field. A cached
 *     copy is a cached CREDENTIAL, and re-submitting it is the replay the
 *     orchestrator rejects by jti (docs/02 §6) -- so the user sees an
 *     authentication failure produced by their own back button.
 *
 * Neither page carried any cache directive at all, which does not mean "do not
 * cache": with no directive a browser applies heuristic caching and is entitled
 * to reuse the response. `no-store` is the only one of these that says what is
 * actually true of both pages.
 */
function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store, must-revalidate',
  });
  res.end(body);
}

/**
 * Read a form POST body, with a hard cap.
 *
 * 8 KB is orders of magnitude more than a username and a password, and the cap
 * exists so an unauthenticated caller cannot make this process buffer an
 * unbounded request -- the one denial-of-service a login endpoint hands out for
 * free. `node:http` gives no body parsing, and adding a framework to this
 * process to read two fields would be the wrong trade (CODING_GUIDELINES §19).
 */
const MAX_BODY_BYTES = 8 * 1024;

function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

/**
 * Who is asking, for the login throttle.
 *
 * Behind the staging reverse proxy every request arrives from the proxy's own
 * address, so `socket.remoteAddress` alone would throttle the entire internet
 * as one client -- the first person to fumble their password would lock out
 * everybody. `x-forwarded-for`'s leftmost entry is the original client.
 *
 * That header is trivially forged by a direct caller, which would let someone
 * hand themselves a fresh attempt budget per request. Accepted, deliberately:
 * this process is only reachable through the proxy in staging, the throttle is
 * a brake on opportunistic guessing rather than an access control, and the
 * failure it prevents (one address locking out all others) is the one that
 * actually happens.
 */
function clientAddress(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = header?.split(',')[0]?.trim();
  if (first !== undefined && first !== '') return first;
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * POST /login -- the staging front door.
 *
 * On success this does exactly what clicking a persona does in picker mode:
 * sign a normal token and hand off. There is deliberately NO session here. The
 * platform issues the only session that matters (ADR-004, 8 hours), and a
 * second one in front of it would be a second thing to expire, a second cookie
 * to get wrong, and a login that could appear to succeed while Analytics
 * insisted the user was a stranger.
 */
async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const address = clientAddress(req);
  const now = Date.now();

  const gate = throttleCheck(address, now);
  if (!gate.allowed) {
    console.warn('[erp-stub] login throttled for ' + address);
    sendHtml(
      res,
      429,
      loginPage({
        error: 'Too many sign-in attempts. Try again in ' + String(gate.retryInSeconds) + ' seconds.',
        ...loginPageDefaults(),
      }),
    );
    return;
  }

  const form = await readFormBody(req);
  const username = form.get('username') ?? '';
  const password = form.get('password') ?? '';

  const identity = authenticate(username, password);
  if (identity === undefined) {
    throttleRecordFailure(address, now);
    // One message for both a wrong name and a wrong password. Two would tell an
    // unauthenticated caller which usernames exist, and enumeration is most of
    // the work of guessing at a password.
    console.warn('[erp-stub] login failed for ' + JSON.stringify(username) + ' from ' + address);
    sendHtml(
      res,
      401,
      loginPage({
        error: 'That username and password did not match.',
        username,
        ...loginPageDefaults(),
      }),
    );
    return;
  }

  throttleClear(address);
  // The password itself is never logged, at any level -- CODING_GUIDELINES §13
  // treats credentials as a log-forbidden value and a staging log is still a log.
  console.log('[erp-stub] login ok: ' + identity.key + ' (' + identity.claims.role + ')');
  sendHtml(res, 200, handoffPage(await signFor(identity.key, 'none')));
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://localhost:' + String(PORT));

  if (url.pathname === '/.well-known/jwks.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(jwks(keys.publicJwk), null, 2));
    return;
  }

  if (MODE === 'login') {
    if (url.pathname === '/login' && req.method === 'POST') {
      handleLogin(req, res).catch((err: unknown) => {
        console.error('[erp-stub] login error: ' + (err instanceof Error ? err.message : String(err)));
        sendHtml(
          res,
          400,
          loginPage({
            error: 'Something went wrong. Please try again.',
            ...loginPageDefaults(),
          }),
        );
      });
      return;
    }

    if (url.pathname === '/' || url.pathname === '/login') {
      sendHtml(res, 200, loginPage(loginPageDefaults()));
      return;
    }

    // Everything else -- crucially /launch-analytics -- does not exist in this
    // mode. Leaving that route reachable would have made the password form
    // decorative: `?who=director` signs a Director token with no credential at
    // all. A front door with an unlocked side entrance is not a front door.
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }

  if (url.pathname === '/launch-analytics') {
    const who = url.searchParams.get('who') ?? '';
    const raw = url.searchParams.get('fault') ?? 'none';
    const fault = (raw in FAULTS ? raw : 'none') as Fault;
    signFor(who, fault)
      .then((token) => {
        console.log('[erp-stub] signed for ' + who + ' (fault=' + fault + ')');
        sendHtml(res, 200, handoffPage(token));
      })
      .catch((err: unknown) => {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end(err instanceof Error ? err.message : 'bad request');
      });
    return;
  }

  if (url.pathname === '/') {
    const raw = url.searchParams.get('fault') ?? 'none';
    sendHtml(res, 200, pickerPage((raw in FAULTS ? raw : 'none') as Fault));
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

/**
 * Refuse to start a login-mode process that nobody can log in to.
 *
 * The passwords come from the environment (logins.ts), so the way this is
 * misconfigured is a forgotten variable — and the symptom would be a sign-in
 * page that rejects every correct password with no clue why. Failing at boot
 * turns a puzzling staging outage into a deployment that never went out, which
 * is PROJECT_CONTEXT §9.7's "fail loud" applied to configuration.
 */
if (MODE === 'login' && enabledLogins().length === 0) {
  console.error('[erp-stub] ERP_STUB_MODE=login but no account has a password set.');
  console.error('[erp-stub] Set at least one ERP_STUB_PASSWORD_<IDENTITY> variable:');
  for (const identity of IDENTITIES) {
    console.error('[erp-stub]   ' + passwordVar(identity.key) + '  (signs in as ' + identity.key + ')');
  }
  process.exit(1);
}

/**
 * The bind address.
 *
 * 127.0.0.1 by default, which is what a developer wants and what a container
 * cannot use: inside Docker, loopback means the container's own loopback and
 * the reverse proxy on the other side of the bridge network gets connection
 * refused. So the staging compose file sets 0.0.0.0 — safe there precisely
 * because the port is never published to the host, only to the proxy.
 */
const BIND_HOST = process.env.ERP_STUB_BIND_HOST ?? '127.0.0.1';

server.listen(PORT, BIND_HOST, () => {
  console.log('[erp-stub] listening on http://' + BIND_HOST + ':' + String(PORT));
  console.log('[erp-stub] mode     ' + MODE + (MODE === 'login' ? ' (password required)' : ' (no password — local dev)'));
  if (MODE === 'login') {
    console.log('[erp-stub] accounts ' + enabledLogins().map((i) => i.key).join(', '));
  }
  console.log('[erp-stub] JWKS at  http://' + BIND_HOST + ':' + String(PORT) + '/.well-known/jwks.json');
  console.log('[erp-stub] key id   ' + keys.kid);
  console.log('[erp-stub] launch   ' + LAUNCH_URL);
});
