/**
 * The print surface — what Puppeteer photographs.
 *
 * Contract source: ADR-021 ("server-side Puppeteer renders the same React print
 * route from the persisted spec") · docs/06 §5 (branding, school-scope line,
 * generated-on timestamp, page numbers, optional logic appendix).
 *
 * -- Why this is an entry point and not a component -----------------------------
 * It draws with the SAME `@sap/chart-spec/react` components as the screen, so
 * there is still exactly one rendering layer in the product (CODING_GUIDELINES
 * §4/§18). What differs is everything AROUND the widgets: a paper page has no
 * sidebar, no topbar, no hover, no scroll — and it needs a header, a footer and
 * page breaks that a screen does not. Those belong here rather than as print
 * media queries bolted onto the app shell, where they would be invisible to
 * anyone maintaining the screen.
 *
 * -- Where the data comes from --------------------------------------------------
 * `window.__CHART_SPEC__`, injected by the orchestrator before any script runs.
 * The browser never fetches: this page has no session, sends no credentials and
 * cannot reach the API. It is a pure function from a spec to pixels, which is
 * also what makes it safe for Puppeteer to run with JavaScript enabled.
 */

import { createRoot } from 'react-dom/client';
import { ChartSpecView } from '@sap/chart-spec/react';
import './tokens.css';
import './print.css';

/** Everything the orchestrator hands the page. Mirrors services/pdf.ts. */
interface PrintPayload {
  spec: unknown;
  title: string;
  org_name: string;
  scope_line: string;
  filters: { label: string; value: string }[];
  generated_at: string;
  /** docs/06 §5: "the logic summary can print as an appendix". Opt-in. */
  logic?: {
    source: string;
    group_by: string[];
    notes: string[];
    queries: { key: string; description: string; sql: string }[];
  };
}

declare global {
  interface Window {
    __CHART_SPEC__?: PrintPayload;
    /** Set once the page has drawn, so Puppeteer waits for a fact, not a timer. */
    __PRINT_READY__?: boolean;
  }
}

function Print({ payload }: { payload: PrintPayload }): JSX.Element {
  return (
    <div className="printPage">
      <header className="printHead">
        <div>
          <div className="printOrg">{payload.org_name}</div>
          <h1 className="printTitle">{payload.title}</h1>
        </div>
        <div className="printMark">📊 Analytics</div>
      </header>

      {/**
       * docs/10 §3 and docs/06 §5: the scope is on the page, always. A printed
       * report that does not say which schools it covers is a number without a
       * subject, and it will outlive the session that produced it.
       */}
      <div className="printMeta">
        <span>
          <b>Schools:</b> {payload.scope_line}
        </span>
        {payload.filters.map((f) => (
          <span key={f.label}>
            <b>{f.label}:</b> {f.value}
          </span>
        ))}
        <span>
          <b>Generated:</b> {new Date(payload.generated_at).toLocaleString()}
        </span>
      </div>

      <ChartSpecView spec={payload.spec} />

      {payload.logic !== undefined && (
        <section className="printAppendix">
          <h2>Appendix — how this report was produced</h2>
          <p className="printAppendixLine">
            <b>Source:</b> {payload.logic.source}
          </p>
          <p className="printAppendixLine">
            <b>Grouped by:</b> {payload.logic.group_by.join(' · ')}
          </p>
          {payload.logic.notes.map((note) => (
            <p key={note} className="printNote">
              {note}
            </p>
          ))}
          <h3>Generated SQL</h3>
          {payload.logic.queries.map((query) => (
            <div key={query.key} className="printQuery">
              <div className="printQueryTitle">
                {query.key} — {query.description}
              </div>
              {/* Text, never markup — the same rule as on screen (§4). */}
              <pre className="printSql">{query.sql}</pre>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

const payload = window.__CHART_SPEC__;
const mount = document.getElementById('print-root');

if (mount !== null) {
  if (payload === undefined) {
    /**
     * Fail visibly. A blank PDF is the worst possible output here: it looks
     * like a report about a school with nothing in it, which is the
     * success-shaped failure this codebase treats as its worst bug class (§10).
     */
    mount.textContent = 'No report data was supplied to the print renderer.';
    window.__PRINT_READY__ = true;
  } else {
    createRoot(mount).render(<Print payload={payload} />);
    /**
     * Ready means three things have happened, in order: React has committed,
     * Recharts has measured its container and laid out the SVG (two animation
     * frames), and the webfont has actually loaded.
     *
     * `document.fonts.ready` is what lets the renderer stop waiting on the
     * NETWORK. Puppeteer was using `networkidle0`, which on a Vite dev server
     * never settles — the HMR WebSocket stays open — so every export paid a
     * timeout it did not need. Waiting for the specific fact that matters is
     * both faster and more correct: fonts change text metrics, and a PDF
     * captured before they load has different line breaks from the same report
     * captured after.
     */
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        void document.fonts.ready.then(() => {
          window.__PRINT_READY__ = true;
        });
      });
    });
  }
}
