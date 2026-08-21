/**
 * Server-side PDF rendering.
 *
 * Contract source: ADR-021 ("server-side Puppeteer renders the same React print
 * route from the persisted spec … the PDF renderer reads the same specs") ·
 * docs/06 §5 (branding, school-scope line, generated-on timestamp, page
 * numbers, optional logic appendix, exports are logged).
 *
 * -- Why the server renders, and not the browser -------------------------------
 * docs/06 §5 allows "a lightweight client-side quick-export path … for casual
 * use", but says official documents use the server path. The difference is
 * provenance: a PDF produced here contains numbers this service read from the
 * replica during THIS request. A client-side export — or a server endpoint that
 * accepted a spec in the request body — would let anyone POST arbitrary JSON and
 * receive it back under the school's letterhead, with the platform's branding
 * vouching for it. The spec is therefore always rebuilt from the report id, and
 * the cache (tier ①) makes that re-read cost ~160 ms for anything recently
 * viewed rather than a fresh scan.
 *
 * -- Why Puppeteer and not a PDF library ---------------------------------------
 * ADR-021 requires the export to come from the same chart-spec through the same
 * renderer. A drawing library would be a SECOND renderer, and the first time the
 * two disagreed, a report would print differently from how it was approved on
 * screen. Chromium is a heavy dependency bought for exactly one property: there
 * is one drawing layer in this product.
 *
 * -- One browser, many requests ------------------------------------------------
 * Launching Chromium costs ~300 ms and ~80 MB. The instance is created lazily on
 * the first export and reused; each export gets its own PAGE, which is the unit
 * of isolation — a page carries the payload, is rendered, and is closed.
 */

import puppeteer, { type Browser } from 'puppeteer';
import { ERROR_CODES, PlatformError } from '@sap/shared';
import { config } from '../config.js';
import type { DashboardResult } from './dashboards.js';

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser !== null && browser.connected) return browser;
  /**
   * Two exports arriving together must not launch two Chromiums. The in-flight
   * promise is shared, so the second caller waits for the first launch.
   */
  launching ??= puppeteer
    .launch({
      headless: true,
      /**
       * `--no-sandbox` is required to run Chromium as a non-root user inside a
       * container, which is where this will live. It is acceptable HERE and
       * would not be on a browser that visits the open web: this one loads
       * exactly one origin, our own print route, with no network access to
       * anything else and no user-supplied URL.
       */
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    })
    .then((b) => {
      browser = b;
      launching = null;
      return b;
    })
    .catch((err: unknown) => {
      launching = null;
      throw err;
    });
  return launching;
}

export interface PdfRequest {
  readonly dashboard: DashboardResult;
  readonly title: string;
  readonly orgName: string;
  /** docs/06 §5: which schools this document covers. Always printed. */
  readonly scopeLine: string;
  /** docs/06 §5: "the logic summary can print as an appendix". */
  readonly includeLogic: boolean;
}

/**
 * Everything the print page is given, built from the dashboard the server just
 * produced.
 *
 * Exported and pure so it can be tested without a browser: what reaches the
 * paper is a decision (which filters, whether the SQL appendix prints, what the
 * scope line says), and decisions deserve tests. Whether Chromium can draw is
 * Chromium's problem.
 */
export function buildPrintPayload(req: PdfRequest, generatedAt: string) {
  return {
    spec: req.dashboard.spec,
    title: req.title,
    org_name: req.orgName,
    scope_line: req.scopeLine,
    filters: req.dashboard.logic.filters.map((f) => ({ label: f.label, value: f.value })),
    generated_at: generatedAt,
    ...(req.includeLogic
      ? {
          logic: {
            source: req.dashboard.logic.source,
            group_by: [...req.dashboard.logic.group_by],
            notes: [...req.dashboard.logic.notes],
            queries: req.dashboard.logic.queries.map((q) => ({
              key: q.key,
              description: q.description,
              sql: q.sql,
            })),
          },
        }
      : {}),
  };
}

export async function renderReportPdf(req: PdfRequest): Promise<Uint8Array> {
  const payload = buildPrintPayload(req, new Date().toISOString());
  let page;
  try {
    page = await (await getBrowser()).newPage();
  } catch (err) {
    /**
     * A missing or unlaunchable Chromium is an operational fault, not the
     * user's. It is reported as one rather than as a broken download, because a
     * zero-byte PDF gives an admin nothing to escalate.
     */
    throw new PlatformError({
      code: ERROR_CODES.INTERNAL,
      message: 'The PDF renderer is not available on this server right now.',
      diagnostics: { reason: err instanceof Error ? err.message : 'browser launch failed' },
    });
  }

  try {
    await page.setViewport({ width: 1240, height: 1754, deviceScaleFactor: 2 });

    /**
     * The spec is injected BEFORE any script on the page runs, so the print
     * bundle finds it already there and never fetches. The page holds no
     * session cookie and calls no API — it is a pure function from this payload
     * to pixels.
     */
    /**
     * `globalThis`, not `window`: this arrow function is serialised and run
     * inside Chromium, but it is TYPE-CHECKED here, in a Node project with no
     * DOM lib. `globalThis` is the same object in the browser and satisfies both.
     */
    await page.evaluateOnNewDocument((data: unknown) => {
      (globalThis as unknown as { __CHART_SPEC__: unknown }).__CHART_SPEC__ = data;
    }, payload);

    /**
     * `domcontentloaded`, not `networkidle0`. The print bundle signals its own
     * readiness below, and network idleness is the wrong proxy for it: a Vite
     * dev server holds an HMR WebSocket open forever, so `networkidle0` never
     * fires and every export waits out a timeout it did not need.
     */
    await page.goto(config.PRINT_URL, {
      waitUntil: 'domcontentloaded',
      timeout: config.PDF_TIMEOUT_MS,
    });

    /**
     * Wait for a FACT, not a duration. The print bundle sets `__PRINT_READY__`
     * after React has committed and Recharts has measured and laid out its SVG;
     * a fixed sleep would either waste time on a small report or photograph a
     * half-drawn chart on a large one.
     */
    await page.waitForFunction('window.__PRINT_READY__ === true', {
      timeout: config.PDF_TIMEOUT_MS,
    });

    return await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      /**
       * docs/06 §5 requires page numbers and the generated-on stamp. They live
       * in the footer template because Chromium repeats it on every sheet — a
       * page 4 that does not say it is page 4 of 6 is a loose sheet of paper.
       */
      footerTemplate: `
        <div style="width:100%;font-size:8px;color:#64748b;font-family:Inter,sans-serif;
                    padding:0 12mm;display:flex;justify-content:space-between;">
          <span>${escapeHtml(req.orgName)} · ${escapeHtml(req.title)}</span>
          <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
        </div>`,
      margin: { top: '14mm', bottom: '14mm', left: '10mm', right: '10mm' },
      timeout: config.PDF_TIMEOUT_MS,
    });
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * The org name and report title reach the footer as HTML.
 *
 * Both come from the platform's own registry and catalog rather than from a
 * user, so this is defence in depth — but a footer template is markup, an org
 * name is data, and the day a school is named `Smith & Sons <Trust>` the
 * unescaped version produces a broken document rather than a broken document
 * plus an explanation.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Called on shutdown so a killed process does not leave Chromium behind. */
export async function closePdfRenderer(): Promise<void> {
  const current = browser;
  browser = null;
  await current?.close().catch(() => undefined);
}
