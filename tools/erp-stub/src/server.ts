/**
 * Stub EduNext ERP -- DEVELOPMENT ONLY.
 *
 * Plays the ERP's side of the launch handshake (docs/02 §2) so the rest of the
 * platform can be built and tested before the ERP team ships their endpoints
 * (docs/11 §2 item 3). It implements exactly the three things the real ERP owes:
 *
 *   1. a menu item that starts the handoff
 *   2. a token-signing endpoint (RS256, 60s, one-time nonce -- ADR-003)
 *   3. a published JWKS so the platform can verify without a shared secret
 *
 * Everything downstream is real. Swapping in the real ERP means changing
 * ERP_JWKS_URL and deleting this directory.
 *
 * Deliberately styled to look like a different product, so that in a demo the
 * handoff into Analytics is visually obvious rather than a subtle change of
 * header colour.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { getKeys, jwks } from './keys.js';
import { FAULTS, IDENTITIES, findIdentity, type Fault } from './identities.js';

const PORT = Number(process.env.ERP_STUB_PORT ?? 4000);
const ISSUER = process.env.ERP_ISSUER ?? `http://localhost:${PORT}`;
const LAUNCH_URL = process.env.ANALYTICS_LAUNCH_URL ?? 'http://localhost:3000/launch';

/** Token lifetime: 60 seconds, per ADR-003. */
const TOKEN_TTL_SECONDS = 60;

const keys = await getKeys();

/** Remembered so the replay fault can re-send a previously used token. */
let lastToken: string | null = null;

const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

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

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://localhost:' + String(PORT));

  if (url.pathname === '/.well-known/jwks.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(jwks(keys.publicJwk), null, 2));
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

server.listen(PORT, () => {
  console.log('[erp-stub] listening on http://localhost:' + String(PORT));
  console.log('[erp-stub] JWKS at  http://localhost:' + String(PORT) + '/.well-known/jwks.json');
  console.log('[erp-stub] key id   ' + keys.kid);
});
