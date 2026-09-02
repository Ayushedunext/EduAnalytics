/**
 * The staging sign-in page.
 *
 * Read logins.ts first for why a password form exists in this repository at
 * all, and why it is in `tools/` rather than `apps/web`.
 *
 * A NOTE ON THE STYLING
 *
 * The picker page next door is deliberately ugly -- it is styled to look like a
 * different product so that, in a local demo, the handoff into Analytics is
 * visually obvious. This page has the opposite job. It is the first screen a
 * stakeholder sees on the staging URL, and a sign-in that looks like a debug
 * tool makes everything behind it look like one too. So it borrows the
 * product's palette from apps/web/src/tokens.css -- ink, teal, canvas -- while
 * keeping a banner that says plainly what it is.
 *
 * The tokens are COPIED, not imported. This is a standalone Node process with
 * no bundler and no CSS pipeline, and wiring one up to share six colour values
 * would be more machinery than the values are worth. They are stable brand
 * constants, and the banner means nobody will mistake this page for a product
 * screen if they ever drift.
 */

import type { Identity } from './identities.js';

const INK = '#032e36';
const TEAL = '#008a9d';
const TEAL_DARK = '#006472';
const CANVAS = '#f1f5f9';
const SLATE = '#334155';
const MUTED = '#64748b';
const LINE = '#cbd5e1';
const RED = '#c74859';

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLE = [
  '*, *::before, *::after { box-sizing: border-box; }',
  'body {',
  '  margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;',
  `  background: ${CANVAS}; color: ${INK}; padding: 24px;`,
  `  font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;`,
  '}',
  '.shell { width: 100%; max-width: 396px; }',
  '.mark { display: flex; align-items: center; gap: 10px; margin: 0 0 18px 2px; }',
  '.mark .glyph {',
  '  width: 30px; height: 30px; border-radius: 8px; flex: none;',
  `  background: linear-gradient(150deg, ${TEAL} 0%, ${TEAL_DARK} 100%);`,
  '  display: flex; align-items: center; justify-content: center;',
  '}',
  '.mark .glyph svg { display: block; }',
  '.mark b { font-size: 15.5px; font-weight: 600; letter-spacing: -0.01em; }',
  '.card {',
  '  background: #fff; border: 1px solid #e2e8f0; border-radius: 12px;',
  '  box-shadow: 0 1px 2px rgba(3,46,54,.06), 0 8px 24px -12px rgba(3,46,54,.18);',
  '  overflow: hidden;',
  '}',
  '.card .body { padding: 26px 28px 28px; }',
  'h1 { font-size: 17px; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.01em; }',
  `p.sub { font-size: 13px; color: ${MUTED}; margin: 0 0 20px; line-height: 1.5; }`,
  `label { display: block; font-size: 12.5px; font-weight: 500; color: ${SLATE}; margin: 0 0 6px; }`,
  'input {',
  `  width: 100%; font: inherit; font-size: 14px; color: ${INK};`,
  `  padding: 9px 11px; border: 1px solid ${LINE}; border-radius: 7px; background: #fff;`,
  '  margin: 0 0 14px;',
  '}',
  `input:focus { outline: none; border-color: ${TEAL}; box-shadow: 0 0 0 3px rgba(0,138,157,.14); }`,
  'button {',
  '  width: 100%; font: inherit; font-size: 14px; font-weight: 500; color: #fff; cursor: pointer;',
  `  background: ${TEAL}; border: 0; border-radius: 7px; padding: 10px 14px; margin-top: 4px;`,
  '}',
  `button:hover { background: ${TEAL_DARK}; }`,
  '.error {',
  `  display: flex; gap: 8px; font-size: 12.5px; line-height: 1.5; color: ${RED};`,
  '  background: #fdeceb; border: 1px solid #f6d5d3; border-radius: 7px;',
  '  padding: 9px 11px; margin: 0 0 16px;',
  '}',
  '.banner {',
  `  background: #e6f4f1; border-bottom: 1px solid #cde7e2; color: ${TEAL_DARK};`,
  '  font-size: 11.5px; line-height: 1.45; padding: 9px 28px;',
  '}',
  `.accounts { margin: 20px 2px 0; font-size: 11.5px; color: ${MUTED}; line-height: 1.7; }`,
  `.accounts b { display: block; color: ${SLATE}; font-weight: 500; margin-bottom: 3px; }`,
  '.accounts code {',
  `  background: #e8edf2; color: ${SLATE}; padding: 1px 5px; border-radius: 4px;`,
  '  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;',
  '}',
].join('\n');

/** A small bar-chart glyph, so the page has a mark without shipping an asset. */
const GLYPH =
  '<svg width="15" height="15" viewBox="0 0 16 16" fill="none">' +
  '<rect x="1" y="9" width="3.2" height="6" rx="1" fill="#fff" fill-opacity=".65"/>' +
  '<rect x="6.4" y="5" width="3.2" height="10" rx="1" fill="#fff" fill-opacity=".85"/>' +
  '<rect x="11.8" y="1.5" width="3.2" height="13.5" rx="1" fill="#fff"/>' +
  '</svg>';

/**
 * @param error      message to show above the form, if the last attempt failed
 * @param username   what they typed, so a wrong password does not clear it
 * @param accounts   identities with a password configured, listed as a hint
 * @param showHints  whether to name those accounts on the page at all
 * @param basePath   public path prefix this process is mounted under, '' at root
 */
export function loginPage(opts: {
  error?: string | undefined;
  username?: string | undefined;
  accounts: Identity[];
  showHints: boolean;
  basePath: string;
}): string {
  const errorBlock =
    opts.error === undefined
      ? ''
      : '<div class="error"><span>&#9888;</span><span>' + esc(opts.error) + '</span></div>';

  /**
   * The account hint is OPT-IN (ERP_STUB_SHOW_ACCOUNTS), and defaults off.
   *
   * On a shared demo link it saves a round of "what do I type?". On a box
   * reachable from the internet it is a published list of valid usernames,
   * which halves the work of guessing at one. Whoever deploys knows which of
   * those two situations they are in; this file does not.
   */
  const hints =
    opts.showHints && opts.accounts.length > 0
      ? [
          '<div class="accounts"><b>Sign in as</b>',
          opts.accounts
            .map((a) => '<code>' + esc(a.key) + '</code> &mdash; ' + esc(a.label))
            .join('<br>'),
          '</div>',
        ].join('')
      : '';

  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // A staging box holding real school data must never appear in a search
    // index. Cheap, and the alternative is discovering it in Google.
    '<meta name="robots" content="noindex, nofollow">',
    '<title>Sign in &middot; School Analytics</title>',
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">',
    '<style>' + STYLE + '</style></head><body>',
    '<div class="shell">',
    '<div class="mark"><span class="glyph">' + GLYPH + '</span><b>School Analytics</b></div>',
    '<div class="card">',
    '<div class="banner">Staging environment. This sign-in stands in for the ERP',
    ' menu &mdash; the platform itself has no login screen.</div>',
    '<div class="body">',
    '<h1>Sign in</h1>',
    '<p class="sub">Analytics opens with the schools your role can see.</p>',
    errorBlock,
    /**
     * The form posts to the PUBLIC path, which is not the path this process
     * receives.
     *
     * Staging mounts the sign-in under a prefix on the one origin the SPA also
     * lives on (`/signin`), and the proxy strips that prefix before the request
     * arrives here -- so this server's own routes are `/` and `/login`, while
     * the browser must be told `/signin/login`. Hard-coding `/login` made the
     * form post to the SPA's origin root, which answered with the app's own
     * index.html and a sign-in that appeared to do nothing at all.
     *
     * Empty when mounted at a root, which is the local-development case.
     */
    '<form method="POST" action="' + esc(opts.basePath) + '/login">',
    '<label for="u">Username</label>',
    '<input id="u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false"',
    ' autofocus value="' + esc(opts.username ?? '') + '" required>',
    '<label for="p">Password</label>',
    '<input id="p" name="password" type="password" autocomplete="current-password" required>',
    '<button type="submit">Sign in</button>',
    '</form></div></div>',
    hints,
    '</div></body></html>',
  ].join('\n');
}
