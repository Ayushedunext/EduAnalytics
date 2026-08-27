/**
 * Whether a chart may animate its data draw.
 *
 * -- Why this is a context, and why it defaults to OFF -----------------------
 * The same renderer draws the screen and the PDF (ADR-021), and a PDF is a
 * photograph. `services/pdf.ts` signals readiness by waiting for
 * `window.__PRINT_READY__`, which `print.tsx` sets after React commits plus
 * exactly TWO animation frames — so any draw lasting longer than ~32 ms is
 * captured mid-flight. That is not hypothetical: this renderer previously
 * animated, and Puppeteer photographed a donut mid-grow, producing a report
 * with an empty circle and a legend under it — a chart that read as "no data"
 * rather than "not finished drawing".
 *
 * The fix that shipped was a module constant, `ANIMATE = false`, which was
 * correct but total: it also cost the screen its flourish. This context
 * restores the screen's animation without giving the export any way to get it
 * back, and the DEFAULT is the whole mechanism:
 *
 *   - `false` unless something explicitly provides `true`.
 *   - `print.tsx` provides nothing, so the PDF surface cannot animate — not
 *     because it opts out, but because it never opted in.
 *
 * That polarity is deliberate and matches how motion is already gated in
 * `tokens.css` (declared inside `prefers-reduced-motion: no-preference`, never
 * cancelled by a `reduce` rule) and how the entrance fade is already scoped to
 * `#root` so it "simply does not exist on the page ADR-021 photographs". A
 * flag that had to be REMEMBERED on the print path would be one edit away from
 * silently reintroducing the empty-donut bug; forgetting this one only ever
 * costs an animation, which is the harmless direction to fail in.
 *
 * It is also not a timer: nothing here asks the exporter to wait. The export
 * still captures the instant the facts are on the page.
 */

import { createContext, useContext, type ReactElement, type ReactNode } from 'react';

const ChartMotionContext = createContext(false);

/**
 * Turns the data-draw animation on for everything inside it. Mounted by the
 * interactive app only (`apps/web/src/main.tsx`); deliberately absent from
 * `print.tsx`.
 */
export function ChartMotionProvider({
  enabled,
  children,
}: {
  readonly enabled: boolean;
  readonly children: ReactNode;
}): ReactElement {
  return <ChartMotionContext.Provider value={enabled}>{children}</ChartMotionContext.Provider>;
}

export function useChartMotion(): boolean {
  return useContext(ChartMotionContext);
}

/**
 * How long a data draw takes when it is on.
 *
 * Short on purpose. Recharts' own default is 1500 ms, which on a bento grid of
 * six panels reads as the page being slow rather than the page being alive —
 * and every millisecond here is time the numbers are on screen but not yet
 * truthful to their axis. 620 ms is long enough to see a bar rise and short
 * enough that nobody waits for it.
 */
export const CHART_MOTION_MS = 620;
