/**
 * The widget renderers — one implementation per chart-spec widget type.
 *
 * [MANDATORY] ADR-015 / CODING_GUIDELINES §4: this is the ONLY place a spec
 * becomes pixels. There is no second charting approach for one screen, and
 * nothing here ever renders a string as markup — every value reaches the DOM as
 * a text child, so a spec is data even when it came from a model.
 *
 * -- Why the renderer lives in the contract package --------------------------
 * CODING_GUIDELINES §18 names `/packages/chart-spec` as the seam for ALL
 * rendering, and ADR-021 requires the PDF to be produced from the same spec by
 * the same layer so screen and export cannot disagree. A renderer living in
 * `apps/web` would have to be duplicated by the PDF service, and the first
 * divergence between the two copies would be a report that prints differently
 * from how it was approved on screen.
 *
 * The package exposes it on a `./react` subpath so Node services that only need
 * the TYPES (the orchestrator builds specs; it does not draw them) never pull
 * React into their dependency graph.
 *
 * -- Chart library ------------------------------------------------------------
 * Recharts. PROJECT_CONTEXT §7 already fixes "a Recharts/Chart.js-class chart
 * layer rendering chart-spec", so having one is settled and only the vendor was
 * open; picked 2026-08-19 for declarative React components (no canvas refs or
 * imperative lifecycle to manage) and because it renders to SVG, which the
 * server-side PDF path can produce without a live canvas. A technology choice
 * inside an existing seam, not a contract change — so no ADR, recorded here.
 */

import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { useId, useState } from 'react';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CHART_MOTION_MS, useChartMotion } from './ChartMotion.js';
import { widgetSchema } from '../spec.js';
import type {
  BarSeries,
  BarWidget,
  Tone,
  DonutWidget,
  KpiWidget,
  LineWidget,
  TableWidget,
  Widget,
} from '../spec.js';

/**
 * docs/10 §1: the platform palette — "Meadow", adopted 2026-09-03.
 *
 * -- What changed and why ----------------------------------------------------
 * Softer and lighter than the set it replaces, chosen from four directions put
 * side by side on real figures. The brief was "very soothing colours instead of
 * dark ones", and the useful finding along the way was that a five-slot
 * categorical palette CANNOT simply be washed out to get there: four
 * hand-picked pastel sets were measured and all four failed, dropping below the
 * 0.10 chroma floor at which a colour starts reading grey and collapsing
 * teal↔green to ΔE 10 against a normal-vision floor of 15 — a pair full-colour
 * readers cannot separate.
 *
 * So the softness is bought with LIGHTNESS and with how the mark is drawn, not
 * by draining hue. Every slot here sits higher and lighter than its predecessor
 * while still clearing every check in `scripts/validate_palette.js`: lightness
 * band, chroma floor, adjacent-pair CVD separation and the normal-vision floor.
 * The one accepted deviation is unchanged in kind from before — `#72ba63` sits
 * under 3:1 against the card, and the remedy is the relief this product already
 * ships: a mandatory legend on every multi-series chart, axis values, and a
 * table view. The old palette failed that same check on two slots.
 *
 * -- The order is SEMANTIC and cannot be permuted --------------------------
 * This product means things by colour: slot 0 is demand, 1 is collected, 2 is
 * pending, 3 is defaulters. Reordering the slots would make the separation
 * maths easier — putting ochre between teal and green is worth several ΔE —
 * and would repaint "fee collected" ochre, which is worse than any number. So
 * the hues are pushed apart within their families and LIGHTNESS does the
 * separating that hue cannot: under protanopia and deuteranopia green and ochre
 * collapse to one hue, and only their lightness gap survives. That gap is why
 * slot 2 is the darkest colour in the set rather than a cheerful amber.
 *
 * Beyond five it is still never a generated hue — see `SERIES_OTHER`.
 */
const SERIES: readonly [string, ...string[]] = [
  '#00a5cb', // cyan-teal — demand, headcount, the brand lead
  '#72ba63', // meadow    — collected, present, positive
  '#a17a00', // ochre     — pending, outstanding, warning
  '#cd617e', // rose      — defaulters, absent, negative
  '#a886e5', // violet    — the fifth measure, no fixed meaning
];

/**
 * Each series hue at four steps: shaded foot, base, a half-step above it, lit
 * cap.
 *
 * Derived by moving LIGHTNESS only — hue and chroma are held, so every step of
 * a ramp is unmistakably the same colour as its base. Gamut-clamped on the way
 * out, which is why the lit steps of the greener hues sit slightly lower in
 * chroma than the arithmetic asked for.
 *
 * -- What each step is for ---------------------------------------------------
 * `deep` is pressed and hovered states and the KPI tile's edge gradient.
 * `soft` is the magnitude ramp's pale end on a single-series bar chart.
 * `light` is available for anything that needs a tint darker than the 10% rail.
 *
 * Regenerated 2026-09-03 for the Meadow palette (docs/10 §1).
 */
const RAMP: Record<string, { deep: string; soft: string; light: string }> = {
  '#00a5cb': { deep: '#007da1', soft: '#3cb8dc', light: '#68cdee' },
  '#72ba63': { deep: '#4a913b', soft: '#88cc79', light: '#a3e297' },
  '#a17a00': { deep: '#795400', soft: '#b28d30', light: '#c5a356' },
  '#cd617e': { deep: '#a13959', soft: '#df7691', light: '#f090a7' },
  '#a886e5': { deep: '#815fba', soft: '#ba9af6', light: '#cfb3ff' },
  '#64748b': { deep: '#404f65', soft: '#76869c', light: '#8c9baf' },
  '#cbd5e1': { deep: '#a2acb7', soft: '#dce6f1', light: '#e3ecf7' },
  /* The accent-only hues (`ACCENT_COLOUR`). Same construction as the series
     ramps above -- lightness moved, hue and chroma held -- so a card accent and
     a series mark are painted by identical machinery. */
  '#5f8fe0': { deep: '#3f6ab8', soft: '#84a9ea', light: '#a6c1f2' },
  '#2fb3aa': { deep: '#1b8a83', soft: '#5ac7c0', light: '#85dad4' },
  '#e8896b': { deep: '#bf6349', soft: '#f2a48b', light: '#f8bfae' },
  '#bd77d2': { deep: '#9553ab', soft: '#d095e1', light: '#e0b4ec' },
  /* The deep step is held DELIBERATELY high for this hue. Amber loses chroma
     into brown faster than any other colour here, and the magnitude ramp on a
     single-series chart paints its tallest bar in `deep` -- at `#a3760e` Fee
     Defaulters' ageing chart rendered as four olive bars. `#b8862a` keeps the
     top of the range recognisably gold while still leaving a visible fall to
     `soft` for the smallest bucket. */
  '#d09a2c': { deep: '#b8862a', soft: '#deb057', light: '#eac67f' },
};

/**
 * A hue at partial strength, mixed toward the CARD rather than made translucent.
 *
 * The distinction matters for the rails below: a translucent fill picks up
 * whatever sits behind it, and behind a rail on a stacked or grouped chart is
 * another mark. Mixing toward white gives the same appearance with none of that.
 */
function tintOf(hex: string, strength: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (m === null) return hex;
  const n = Number.parseInt(m[1] as string, 16);
  const mix = (c: number): string =>
    Math.round(c + (255 - c) * (1 - strength))
      .toString(16)
      .padStart(2, '0');
  return `#${mix((n >> 16) & 255)}${mix((n >> 8) & 255)}${mix(n & 255)}`;
}

/**
 * How strong a mark's own rail is. 0.10 — visible as a scale, nowhere near
 * competing with the mark sitting on it (docs/10 §1, "Meadow").
 */
const RAIL_STRENGTH = 0.1;

/**
 * The ramp for a colour: the measured steps where the colour is one of the
 * palette's, and steps derived by moving lightness where it is not.
 *
 * -- Why there is a derivation at all (2026-09-03) ---------------------------
 * `RAMP` is keyed by the five `SERIES` hues plus the two neutrals, and for a
 * long time every caller passed one of those, so falling back to the FLAT
 * colour at every step was a fallback that never fired. It fires now. A
 * single-series bar chart shades each bar along the series ramp by magnitude
 * (`cellColours`), which produces intermediate hexes — `#0f97bd`, not `#00a5cb`
 * — and every one of them missed the table and came back as four copies of
 * itself. The visible result was a chart whose bars were painted with a
 * gradient of one colour, i.e. flat, on exactly the charts this product draws
 * most.
 *
 * The derivation moves toward white and toward the platform ink rather than
 * toward black: a step mixed with black loses chroma fast and turns muddy,
 * where `INK` is the same near-black the rest of the surface is drawn in and
 * keeps the family. The fractions are picked to land the derived steps of a
 * PALETTE colour close to that colour's measured ones, so a magnitude-shaded
 * bar and an unshaded one look like the same treatment.
 *
 * This changes nothing about which colour a mark IS: `base` is returned
 * untouched in both branches, and every stop sits on the lightness axis through
 * it. The audited hues, and the CVD separations measured between them, are the
 * `SERIES` entries — none of which take this branch.
 */
function rampOf(base: string): { deep: string; base: string; soft: string; light: string } {
  const r = RAMP[base];
  if (r !== undefined) return { deep: r.deep, base, soft: r.soft, light: r.light };
  return {
    deep: mixHex(base, INK, 0.3),
    base,
    soft: mixHex(base, '#ffffff', 0.22),
    light: mixHex(base, '#ffffff', 0.42),
  };
}

/**
 * A point between two sRGB hexes. `t` of 0 is `from`, 1 is `to`.
 *
 * Straight-line sRGB rather than an OKLCH interpolation, because both ends are
 * already steps of ONE audited hue (`RAMP`) rather than two arbitrary colours —
 * the path between them is short, stays in the family, and the perceptual
 * bunching that makes naive sRGB blending look muddy needs a long path across
 * hues to show up. A colour-space conversion here would be arithmetic nobody
 * could check against a value in docs/10 §1.
 *
 * A malformed hex yields `from`, which is a palette colour: a mark drawn in the
 * series' own base is wrong about magnitude, where a mark drawn in `NaN` is not
 * drawn at all.
 */
function mixHex(from: string, to: string, t: number): string {
  const parse = (hex: string): [number, number, number] | null => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (m === null) return null;
    const n = Number.parseInt(m[1] as string, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const a = parse(from);
  const b = parse(to);
  if (a === null || b === null) return from;
  const k = Math.min(1, Math.max(0, t));
  const channel = (i: 0 | 1 | 2): string =>
    Math.round(a[i] + (b[i] - a[i]) * k)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

const SERIES_NEUTRALS: readonly [string, string] = ['#64748b', '#cbd5e1'];
/** The single fold-in neutral, where only one is needed (donut legend, etc.). */
const SERIES_OTHER = SERIES_NEUTRALS[0];

/** The colour of the nth series: the fixed palette, then the neutrals. */
function seriesColourAt(index: number): string {
  return (
    SERIES[index] ??
    SERIES_NEUTRALS[(index - SERIES.length) % SERIES_NEUTRALS.length] ??
    SERIES_OTHER
  );
}

/**
 * A single-series bar/line's colour, for callers that want visual variety
 * across SEVERAL single-series charts shown together (Home's preview grid)
 * without inventing a hue outside the CVD-audited four above. Deliberately
 * NOT part of the chart-spec contract (spec.ts) -- it is how a caller
 * presents a widget, not a fact the widget's data carries, so a caller that
 * passes nothing (every full dashboard and the PDF path) gets exactly
 * `SERIES[0]`, pixel-identical to before this existed.
 *
 * Named `primary`/`secondary` rather than reusing `KpiWidget['tone']`
 * (`neutral`/`positive`/`warning`/`negative`) on purpose: tone claims the
 * NUMBER is good or bad news, which is true for a KPI's delta and not true
 * for, say, which teal step a headcount-by-department bar happens to be
 * drawn in. `warning`/`negative` are kept because those two really do carry
 * meaning here too (docs/10 §1 token table: amber = warnings, red =
 * defaulter counts) -- callers only reach for them when that meaning
 * actually applies.
 */
export type ChartAccent =
  /* The four that carry MEANING. Reach for these only when the meaning applies. */
  | 'primary'
  | 'secondary'
  | 'warning'
  | 'negative'
  /* The five that carry only IDENTITY -- "this card is not that card". */
  | 'violet'
  | 'indigo'
  | 'aqua'
  | 'coral'
  | 'plum';

/**
 * The accent hues, widened from four to nine (2026-09-03).
 *
 * -- Why widen, and why it is safe -------------------------------------------
 * Four accents over eight preview cards meant most of them fell back to
 * `primary`, and the Dashboard read as one blue page: a grid whose whole job is
 * to hold eight DIFFERENT subjects side by side was painting six of them the
 * same colour, which is the one thing that makes a set of cards hard to tell
 * apart at a glance.
 *
 * This does NOT touch `SERIES`. That palette orders five hues semantically and
 * is audited for the separation between ADJACENT MARKS INSIDE ONE CHART, which
 * is the hard constraint (deuteranopia collapses green and ochre to one hue, and
 * only their lightness gap survives). An accent is a different job: it colours a
 * chart that has ONE series, so there is nothing inside the chart for it to be
 * confused with, and the only separation that matters is between one card and
 * the card beside it -- a much weaker requirement, met here by simply spreading
 * the hues around the wheel. `measureColour` still lets `tone` outrank `accent`,
 * so a caller cycling colours across a grid can never repaint overdue money in
 * the teal it uses for headcounts.
 *
 * -- The blue-led family ------------------------------------------------------
 * The product's lead is teal and stays the lead. `indigo` and `aqua` sit either
 * side of it so the page still reads as blue overall; `coral` and `plum` are the
 * warm and purple counterweights that stop eight cards blurring together. Every
 * one is a lighter, lower-chroma choice than the equivalent hue in `SERIES`,
 * because an accent fills a whole chart rather than competing with four
 * neighbours inside one.
 *
 * -- `warning` is the one accent that differs from its series slot ------------
 * `SERIES[2]` is `#a17a00`, and it is that dark on purpose: it is the only thing
 * separating "pending" from "collected" for a red-green colour-blind reader
 * looking at a grouped bar. A SINGLE-series chart has no green beside it, so the
 * lightness gap is buying nothing there and the cost is real -- Fee Defaulters'
 * ageing chart rendered as four brown bars. The accent is therefore the lighter
 * `#d09a2c`, and it applies only where the constraint does not: `SERIES[2]`
 * itself is untouched, so every grouped bar in the product is exactly as it was.
 * At 2.4:1 against the card it sits under the 3:1 line, the same accepted
 * deviation `#72ba63` already carries, with the same relief -- axis values, a
 * title, and a wash that deepens toward the axis.
 */
const ACCENT_COLOUR: Record<ChartAccent, string> = {
  primary: SERIES[0],
  secondary: SERIES[1] ?? SERIES[0],
  warning: '#d09a2c',
  negative: SERIES[3] ?? SERIES[0],
  violet: SERIES[4] ?? SERIES[0],
  indigo: '#5f8fe0',
  aqua: '#2fb3aa',
  coral: '#e8896b',
  plum: '#bd77d2',
};
const AXIS: CSSProperties = { fontSize: 11 };
/**
 * The scale rule behind the marks.
 *
 * A grid is a RULER, not part of the picture: it exists so a reader can put a
 * number on a mark, and every pixel of it that is darker than that job requires
 * is ink competing with the data. Lightened from `#eef2f6` and drawn dashed on
 * 2026-09-03, which together are most of the difference between a chart that
 * looks boxed and one that looks drawn on the card.
 */
const GRID = '#e3e8ef';
/**
 * A dashed rule reads as a reference line; a solid one reads as a border. The
 * distinction matters here because these grids run edge to edge across a card
 * that already has a border of its own, and two solid lines at right angles to
 * each other is a table, not a chart.
 */
const GRID_DASH = '3 4';
/** The card behind a chart — what a surface gap is painted in. */
const SURFACE = '#ffffff';
const MUTED = '#64748b';
const INK = '#032e36';

const tick = { fill: MUTED, fontSize: 11 };

/**
 * Axis chrome, off. The tick VALUES stay; the line they hang from and the little
 * stub beside each one go.
 *
 * Recharts draws both by default because a standalone chart has nothing else to
 * bound it. A panel here does: the card's own border is the frame, the grid is
 * the scale, and an axis line drawn on top of both is a third boundary saying
 * what the first two already said. Applied to every axis in this file so no
 * chart carries chrome another one has dropped.
 */
const AXIS_BARE = { axisLine: false, tickLine: false } as const;

/** Numbers are read as quantities, so they are grouped Indian-style. */
const compactNum = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat('en-IN');

function axisNumber(value: number): string {
  return compactNum.format(value);
}

/**
 * Entry animation is OFF unless something explicitly turns it on.
 *
 * It used to be off unconditionally (`const ANIMATE = false`), for a reason
 * that has not changed: the same renderer draws the screen and the PDF
 * (ADR-021), and a PDF is a PHOTOGRAPH. Puppeteer once captured a donut
 * mid-grow and produced a report with an empty circle and a legend under it —
 * a chart that looked like a panel with no data rather than one that had not
 * finished drawing. Waiting out an animation would be a timer, and this
 * codebase waits for facts.
 *
 * What changed is only WHERE that decision is made. `useChartMotion()` reads a
 * context that defaults to `false`, and `print.tsx` provides no value — so the
 * export still cannot animate, and cannot be made to by editing this file.
 * See ChartMotion.tsx for why the default carries the safety property.
 */
function useAnimation(): { readonly isAnimationActive: boolean; readonly animationDuration: number } {
  return { isAnimationActive: useChartMotion(), animationDuration: CHART_MOTION_MS };
}

/**
 * A stable id for an `<svg><defs>` gradient, scoped to one chart instance.
 *
 * `useId()` returns colons (":r0:"), which are legal in an SVG id but break
 * the `url(#id)` paint reference in some renderers unless the fragment is
 * quoted — stripped here so the id is plain alphanumerics and every caller
 * can reference it the same, simpler way.
 */
function useGradientId(prefix: string): string {
  return `${prefix}-${useId().replace(/:/g, '')}`;
}

/**
 * A mark's wash: one hue lit at the far end, deepened at the foot.
 *
 * -- Why gradients are back on the marks (2026-09-03, "Meadow Lit") ----------
 * Meadow took every gradient off the bars and the wedges and put the tonal
 * interest in the rail behind them, on the argument that a reader matching a
 * bar to its legend dot should be matching a colour to itself rather than to
 * the midpoint of a wash. The argument was right about the failure mode and
 * wrong about the fix: what it produced was a page of flat blocks on flat
 * rails, and "the charts look bland" is the complaint it came back as.
 *
 * The wash is reinstated with the matching problem answered rather than
 * ignored. Three things make it safe where the old five-stop cylinder was not:
 *
 *  1. Every stop is a LIGHTNESS step of the same audited hue (`RAMP`) — hue and
 *     chroma are held, so the whole mark is unmistakably one palette colour and
 *     the CVD separations `scripts/validate_palette.js` checks are untouched.
 *  2. The BASE sits at the 50% stop, so the mark's midpoint — the part of a bar
 *     the eye actually samples — is exactly the colour in `SERIES`.
 *  3. The legend dot is painted with the SAME ramp (`legendDotStyle`), so a
 *     reader matches a wash to a wash. That is the piece the earlier attempts
 *     never had, and it is why this one does not reintroduce their defect.
 *
 * The direction is always axis → tip: a bar is deepest where it is measured
 * from and lightest where it ends, so the wash reinforces the direction the
 * length is read in instead of running across it.
 */
/**
 * The three stops every washed mark is painted from, in one place.
 *
 * The lit end stops SHORT of the ramp's `light` step, at about six tenths of
 * the way to it. `light` is a cap sized for a donut wedge, which has area and a
 * card-coloured hairline around it; the top of a 38px column has neither, and
 * painted in the full lit step it dissolves into the white behind it — a reader
 * looking for where the bar ends ends up reading the axis instead of the mark.
 * Six tenths keeps the mark unmistakably its own hue for its whole length while
 * still leaving a visible fall from foot to tip.
 *
 * Shared by the SVG gradient and the CSS legend swatch so the two cannot drift:
 * the swatch matching the mark is the entire argument for washing marks at all
 * (see `MarkGradient`), and it would stop being true the first time one of them
 * was tuned alone.
 */
function markStops(colour: string): { deep: string; base: string; lit: string } {
  const ramp = rampOf(colour);
  return { deep: ramp.deep, base: ramp.base, lit: mixHex(ramp.base, ramp.light, 0.6) };
}

function MarkGradient({
  id,
  colour,
  horizontal,
}: {
  id: string;
  colour: string;
  /** Bars running left-to-right wash along x; columns and wedges wash down y. */
  horizontal: boolean;
}): ReactElement {
  const ramp = markStops(colour);
  return (
    <linearGradient
      id={id}
      x1="0"
      y1={horizontal ? '0' : '1'}
      x2={horizontal ? '1' : '0'}
      y2="0"
    >
      <stop offset="0%" stopColor={ramp.deep} />
      <stop offset="52%" stopColor={ramp.base} />
      <stop offset="100%" stopColor={ramp.lit} />
    </linearGradient>
  );
}

/**
 * The legend swatch for a series, washed exactly as its mark is.
 *
 * A flat dot beside a gradient bar is the mismatch that got gradients removed
 * the last two times; drawn from the same three ramp steps in the same order,
 * the swatch is a miniature of the mark and the match is direct again. CSS
 * rather than SVG because these legends are plain HTML (see the `content`
 * renderer below), and Chromium paints a CSS gradient into the PDF as
 * faithfully as an SVG one.
 */
function legendDotStyle(colour: string): CSSProperties {
  const ramp = markStops(colour);
  return { background: `linear-gradient(135deg, ${ramp.lit}, ${ramp.base} 55%, ${ramp.deep})` };
}

/**
 * The soft coloured shadow under a trend line.
 *
 * A line is one 2–3px stroke on a white card, which is why a chart made only of
 * lines reads as thin however saturated the stroke is. A drop shadow in the
 * line's OWN hue gives it depth without adding a second mark or a second
 * colour — the reference surfaces this product is measured against all do it,
 * and it is the cheapest possible way to stop a curve looking like a hairline.
 *
 * `feDropShadow` is a static filter, not a timed effect, so ADR-021 holds: the
 * PDF capture renders it identically at whatever instant Puppeteer shoots.
 * Deliberately weak (0.28) — past about a third it stops being depth and starts
 * being a second, blurred copy of the trend sitting under the real one.
 */
function LineGlow({ id, colour }: { id: string; colour: string }): ReactElement {
  return (
    <filter id={id} x="-25%" y="-25%" width="150%" height="150%">
      <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor={colour} floodOpacity={0.28} />
    </filter>
  );
}

interface TooltipPayloadEntry {
  readonly name?: string | number;
  readonly value?: number | string;
  readonly color?: string;
  readonly dataKey?: string | number;
  readonly payload?: { readonly fill?: string };
}

/**
 * Replaces Recharts' default tooltip box, which doesn't share the product's
 * card styling (docs/10 §1) — border, radius and shadow all drift from the
 * `.card` the panel itself sits in. Pointer-driven only, so a headless PDF
 * capture (which never moves a mouse) never renders it — it needs no equivalent
 * of `useChartMotion()`'s default-off guard, because there is no pointer on the
 * print surface to trigger it in the first place.
 */
function ChartTooltip({
  active,
  label,
  payload,
}: {
  readonly active?: boolean;
  readonly label?: string | number;
  readonly payload?: readonly TooltipPayloadEntry[];
}): ReactElement | null {
  if (active !== true || payload === undefined || payload.length === 0) return null;
  return (
    <div className="specTooltip">
      {label !== undefined && <div className="specTooltipLabel">{String(label)}</div>}
      {payload.map((entry, index) => (
        <div className="specTooltipRow" key={String(entry.dataKey ?? entry.name ?? index)}>
          <span
            className="specTooltipDot"
            style={{ background: entry.color ?? entry.payload?.fill ?? MUTED }}
          />
          {entry.name !== undefined && <span className="specTooltipName">{entry.name}</span>}
          <span>{full.format(Number(entry.value))}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Reads the SIGN already present in a server-formatted delta string ("+12.4%",
 * "-3.1 pts") to decide the pill's colour and arrow. This is presentation of a
 * fact the server already computed, not a client-side trend calculation — a
 * widget with no `delta` renders no pill at all rather than a fabricated one
 * (§4 "do not add fake trends").
 */
function deltaDirection(delta: string): 'up' | 'down' | 'flat' {
  const trimmed = delta.trim();
  if (trimmed.startsWith('+')) return 'up';
  if (trimmed.startsWith('-') || trimmed.startsWith('−')) return 'down';
  return 'flat';
}

const DELTA_ARROW: Record<'up' | 'down' | 'flat', string> = { up: '▲', down: '▼', flat: '•' };

/**
 * A KPI's value as a 0–1 share, when — and only when — the value IS a share.
 *
 * The pattern is deliberately strict: a bare number with a trailing percent
 * sign and nothing else. "86.1%" is a rate and has a dial; "₹92.0Cr", "9,628"
 * and "53% of 41 schools" are not, and each returns null rather than a share
 * guessed out of a string that happens to contain a digit and a sign.
 *
 * Reading the formatted string is the point rather than a shortcut. Values reach
 * this renderer pre-formatted precisely so the screen and the PDF cannot format
 * the same number differently (ADR-015), and there is no parallel numeric field
 * on the widget to read instead — so the choice is between deriving the dial
 * from the printed figure or asking the server for a second representation of a
 * number it already sent. Derived here, the dial and the digits cannot disagree:
 * they are the same value drawn twice.
 *
 * Clamped, because a percentage over 100 is a real thing this product can print
 * (a collection rate against a revised demand) and a dial that wrapped past its
 * own start would read as a small number rather than a large one.
 */
function rateShare(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*%$/.exec(value.trim());
  if (match === null) return null;
  const percent = Number(match[1]);
  return Number.isFinite(percent) ? Math.min(1, Math.max(0, percent / 100)) : null;
}

/**
 * A rate drawn as a dial: an arc of the metric's own hue on a rail of the same
 * hue at rail strength, the same pairing every bar on the platform uses.
 *
 * Rounded cap and a gradient sweep, so it belongs to the same family as the
 * marks in the charts below it rather than looking like a borrowed component.
 * `aria-hidden` throughout: the figure beside it is the accessible reading, and
 * a screen reader announcing "86.1%" twice is worse than one that says it once.
 */
function MeterRing({
  id,
  share,
  colour,
}: {
  id: string;
  share: number;
  colour: string;
}): ReactElement {
  const ramp = rampOf(colour);
  const radius = 16.5;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg className="kpiRing" viewBox="0 0 42 42" width={42} height={42} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor={ramp.deep} />
          <stop offset="100%" stopColor={ramp.light} />
        </linearGradient>
      </defs>
      <circle
        cx="21"
        cy="21"
        r={radius}
        fill="none"
        stroke={tintOf(colour, RAIL_STRENGTH * 1.8)}
        strokeWidth="5"
      />
      {/* From twelve o'clock, clockwise — the direction a dial is read. */}
      <circle
        cx="21"
        cy="21"
        r={radius}
        fill="none"
        stroke={`url(#${id})`}
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray={`${String(circumference * share)} ${String(circumference)}`}
        transform="rotate(-90 21 21)"
      />
    </svg>
  );
}

/**
 * One metric, one tile — the same tile everywhere, at the same size (§22).
 *
 * -- Why there is no headline tile any more (2026-09-01) ---------------------
 * The first tile in a strip used to render double-width at a 36px figure. The
 * intent was a reading order, but a strip is already read left to right, and
 * what the width actually produced was a row that looked broken: on Dashboard's
 * four cards, one 2× tile beside three 1× tiles reads as a layout accident
 * before it reads as emphasis, and the eye goes to the odd shape rather than to
 * the number in it.
 *
 * Emphasis a strip can carry without breaking its own grid: ORDER, which is
 * still the server's (`spec.widgets`, held as contract in
 * test/home-summary.test.ts), and `tone`, which colours the left edge from
 * meaning the server assigned. Both survive a tile changing size; a hard-coded
 * 2× span does not survive the strip growing by one card, which is what the old
 * "hero up to five tiles, none at six" rule was already conceding.
 */
export function KpiTile({
  widget,
  accent,
}: {
  widget: KpiWidget;
  /**
   * A hue for a tile whose `tone` is neutral -- see `kpiColour`.
   *
   * Presentation chosen by the strip showing the tile, exactly as `accent` is on
   * a chart, and honoured under exactly the same precedence: meaning first,
   * arrangement second. A caller passing one can never repaint a warning tile.
   */
  accent?: ChartAccent | undefined;
}): ReactElement {
  const tone = widget.tone ?? 'neutral';
  const hue = kpiColour(widget.tone, accent);
  const direction = widget.delta !== undefined ? deltaDirection(widget.delta) : null;
  const ringId = useGradientId('ring');
  /**
   * A rate metric gets its own dial; a count does not.
   *
   * `rateShare` reads the share back out of the SERVER'S OWN formatted value
   * rather than taking a second number from anywhere — the tile draws exactly
   * the figure it prints, in a second channel. Attendance at 86% and fee
   * realisation at 53% are the two the strip carries today, and the difference
   * between them is visible before either number is read, which is the whole
   * argument for the dial. Anything that is not a bare percentage returns null
   * and the tile is laid out exactly as it was.
   */
  const share = rateShare(widget.value);
  return (
    /**
     * The tone still names the CLASS -- the tile's rail and corner pool are
     * keyed off it in CSS (tokens.css `.kpi--*`) and must keep saying what the
     * server said. `--kpi-grad` is overridden inline only for a NEUTRAL tile
     * carrying an accent, so a warning tile's amber edge cannot be repainted by
     * a caller cycling colours.
     */
    <div
      className={`card kpi kpi--${tone}`}
      style={
        tone === 'neutral' && accent !== undefined
          ? ({
              '--kpi-grad': gradientCss(hue),
              '--kpi-tint': tintOf(hue, 0.09),
            } as CSSProperties)
          : undefined
      }
    >
      <span className="kpiLabel">{widget.label}</span>
      <div className="kpiFigure">
        {share !== null && <MeterRing id={ringId} share={share} colour={hue} />}
        <b className="kpiValue" style={{ color: hue }}>
          {widget.value}
        </b>
        {widget.delta !== undefined && direction !== null && (
          <span className={`kpiDelta ${direction}`}>
            <span aria-hidden="true">{DELTA_ARROW[direction]}</span>
            {widget.delta}
          </span>
        )}
      </div>
      {/**
        * The parts of the figure above, on one row beneath it.
        *
        * Rendered as a definition list because that is what it is — a set of
        * label/value pairs qualifying one headline number — and a screen reader
        * then announces "Girls, 4,812" as a pair instead of reading a wall of
        * loose text. `.kpiPartValue` carries `tabular-nums` for the same reason
        * `.kpiValue` does: these sit in a row and digits that do not line up
        * read as sloppy at a glance.
        *
        * No tone is applied unless the server sent one. A breakdown is mostly
        * neutral description — "Boys" and "Girls" are not good and bad news —
        * and colouring parts by default would invent a judgement the data does
        * not carry. Fees pending is the case that DOES want it, and it says so
        * in its own spec.
        */}
      {widget.breakdown !== undefined && (
        <dl className="kpiBreakdown">
          {widget.breakdown.map((part) => (
            <div key={part.label} className="kpiPart">
              <dt className="kpiPartLabel">{part.label}</dt>
              <dd className="kpiPartValue" style={{ color: toneColour(part.tone) }}>
                {part.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/**
 * Category labels decide which way the bars run.
 *
 * A panel here is ~340–450px wide (`.specPanels` is a `minmax(340px, 1fr)`
 * grid), so twenty department names — "ADHOC OFFICE STAFF(A.O.S)" is 25
 * characters — get about 20px of axis each. No rotation angle rescues that;
 * rotated long labels overlap, then get clipped by the axis band, and the chart
 * stops being readable at all.
 *
 * Turning the bars horizontal gives every label its own line at 0°, which is
 * the standard answer for categorical comparison with long or numerous names.
 * Short ordinal axes — class I…XII, months — stay vertical, because their shape
 * across the sequence is the thing being read and rotating six-character labels
 * costs nothing.
 *
 * The thresholds are about LABEL WIDTH, not category count: five bands read
 * horizontally too when one of them is "No due date recorded".
 *
 * The same budget now also sizes Home's compact preview cards (2-up,
 * tokens.css `.pgallery`, ~900px each) — wider than a full dashboard panel,
 * never narrower, so nothing here needed a compact-specific number.
 */
/**
 * How thick a bar is drawn, in pixels. A CAP, not a width: Recharts sizes a bar
 * from its category band and this only stops it growing past here, so a chart
 * with many categories still thins out on its own.
 *
 * -- Why these numbers went up (2026-09-01) ----------------------------------
 * Horizontal bars were 14px single / 11px grouped. In a Home preview card that
 * drew three schools as three hairlines with far more air than ink, and a
 * preview that does not read as a chart is a card that does not earn its click.
 * The complaint the change came from was that the bars looked flat and cheap
 * next to the prototype's; the prototype's bars are not shaded or bevelled, they
 * are simply THICK, solid and rounded at the tip, and thickness is nearly all of
 * that impression.
 *
 * 22px is the ceiling on purpose. A mark much past ~24px stops being a bar and
 * becomes a block: it fills its band, the air between categories disappears, and
 * a row of blocks reads louder than the numbers it carries. The band's leftover
 * is meant to be air — so these grew to the top of that range and stopped there,
 * and `perRow` below grew with them so the air came back rather than being eaten.
 *
 * A grouped bar is thinner than a single one because three of them share one
 * band; `barGap={2}` keeps the 2px surface gap between them, which is what makes
 * three fills read as three marks without a stroke drawn around each.
 *
 * Vertical columns were already in this range (38/26) and are unchanged — the
 * complaint was never about them, and they have a whole column's height to give
 * the mark presence that a horizontal bar has to get from thickness.
 */
const BAR_PX = {
  /** One measure, bars running horizontally. */
  single: 22,
  /** One measure per band, columns running vertically. */
  singleV: 38,
  /** One of several measures sharing a horizontal band. */
  grouped: 16,
  /** One of several measures sharing a vertical band. */
  groupedV: 26,
} as const;

function categoryAxis(rows: readonly Record<string, unknown>[], field: string) {
  let longest = 0;
  for (const row of rows) longest = Math.max(longest, String(row[field] ?? '').length);
  return { count: rows.length, longest, horizontal: longest > 8 || (longest > 5 && rows.length > 14) };
}

/**
 * Whether a panel has to take the whole row, or can sit in a half.
 *
 * -- Two-up is the default and full width is EARNED (2026-09-03) -------------
 * Every widget used to declare a footprint by kind: a horizontal bar and a
 * table were always 12, a vertical bar 6, a line 7 and a donut 5. Kind is the
 * wrong thing to key on, because it does not vary with the one thing that
 * actually decides whether a chart is legible at half width -- what is IN it.
 * Fee Collection's "by school" chart is three bars labelled "World School" and
 * was taking a full row; Staff Overview's is twenty departments labelled
 * "ADHOC OFFICE STAFF(A.O.S)" and genuinely needs one.
 *
 * So the test is the data -- and WHICH part of the data depends on which way the
 * categories run, which is the distinction this function exists to make.
 *
 * On a HORIZONTAL bar chart the categories run down the panel: their number sets
 * the chart's HEIGHT (`perRow` below) and costs no width at all. The only thing
 * competing for width is the label text, so that is the only thing tested.
 * Fifteen classes labelled "NURSERY" are perfectly legible in half a page; five
 * departments labelled "ADHOC OFFICE STAFF(A.O.S)" are not.
 *
 * On a VERTICAL axis -- columns, or a line's periods -- every category needs its
 * own slice of width, so the count matters as much as the label. 78 months in
 * half a page is a smear whatever the labels say.
 *
 * `longest > 16` is roughly where the axis starts ellipsing at the label width a
 * half-width panel allows; `count > 14` is about where a vertical axis stops
 * having room for a legible tick per category.
 *
 * The point of the change is screen space. On a 1900px page a full-width panel
 * holding three bars spends about a thousand horizontal pixels on nothing, and
 * a reader comparing two panels has to scroll between them instead of putting
 * them side by side -- which is most of what a reporting surface is for.
 */
function needsFullWidth(
  orientation: 'horizontal' | 'vertical',
  count: number,
  longest: number,
): boolean {
  return orientation === 'horizontal' ? longest > 16 : longest > 16 || count > 14;
}

/**
 * How a VERTICAL chart's category labels are set: flat where they fit, tilted
 * where they do not.
 *
 * Every such axis in this file used to pass `angle={-35}` unconditionally, and
 * on the axes that needed it — twelve month names across a half-width panel —
 * it is the right answer. On the ones that did not it is pure chrome: four
 * quarters, six academic years and twelve roman-numeral classes were all being
 * drawn on the diagonal, which makes a reader tilt their head to read "Q1" and
 * gives the bottom of the panel a ragged edge that a flat axis does not have.
 * Nothing about the reference dashboards this was measured against tilts a short
 * label, and neither does anything else in the product.
 *
 * The threshold is about the label's WIDTH, and the arithmetic is the same
 * budget `CHAR_PX` states: a category gets roughly `panel / count` pixels, and
 * `longest * CHAR_PX` has to fit inside that. This module does not know the
 * panel width (see `rotatedTicks`), so the test is deliberately conservative —
 * six characters is about 44px, which fits at every count and every panel width
 * the grid produces, including a `medium` panel with a dozen categories in it.
 * Anything longer keeps the tilt, so no axis that currently reads gets worse.
 *
 * `height` follows the same branch, because a flat row of labels needs one line
 * of type plus its margin and a tilted one needs room for the diagonal.
 */
function categoryTicks(longest: number): {
  angle?: number;
  textAnchor: 'end' | 'middle';
  tickMargin: number;
  height: number;
} {
  if (longest <= 6) return { textAnchor: 'middle', tickMargin: 8, height: 34 };
  return {
    angle: -35,
    textAnchor: 'end',
    tickMargin: 6,
    height: clamp(longest * 4.8 + 26, 40, 76),
  };
}

/**
 * Width budget per character at 11px Inter, rounded UP for capitals.
 *
 * The ERP's dimension values arrive shouting — TEACHING, ADHOC OFFICE
 * STAFF(A.O.S), CONFIRMATION — and uppercase runs ~7.2px a glyph where mixed
 * case runs ~6.2px. Budgeting at the lowercase rate is what makes a label
 * "fit" by arithmetic and wrap in the browser.
 */
const CHAR_PX = 7.4;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Air between two rotated labels, on top of the room the labels themselves take.
 *
 * 8px rather than Recharts' default 5, because these axes are read at a glance
 * across a wide panel and touching labels read as one string. It is a gap, not a
 * slot: the width of the label is measured and added by Recharts (see below).
 */
const TICK_GAP_PX = 8;

/**
 * How a rotated category axis thins its labels when they will not all fit.
 *
 * -- What went wrong without this ---------------------------------------------
 * Every rotated axis here passed `interval={0}`, which is an instruction to draw
 * EVERY label whatever the width — not a default, a demand. That was invisible
 * while the longest axis on the platform was twelve classes or four quarters,
 * and became unreadable the moment Trend Analysis drew 78 months across one
 * panel: at ~16px of axis each, the dates overprint into a grey smear and a
 * reader cannot recover a single one of them. Recharts had no licence to
 * intervene; it was told to draw them all, and it did.
 *
 * -- Why the thinning is Recharts' job and not arithmetic here ----------------
 * This module does not know how wide the panel is. A grid panel is ~340-450px, a
 * `wide` line spans two thirds of the page and a `hero` the whole of it, and all
 * three are `width="100%"` inside a `ResponsiveContainer` — so any constant
 * chosen here would be right for one variant and wrong for the other two.
 * Recharts knows the width at layout time, and `preserveStartEnd` is its own API
 * for exactly this: keep the first and last, drop what will not fit between.
 *
 * -- The correction this deliberately does NOT make ---------------------------
 * An earlier attempt subtracted the label's width from `minTickGap`, on the
 * assumption that Recharts measures ticks unrotated and would therefore reserve
 * far too much room for a −35° label. It does not: `getTicks` calls
 * `getAngledTickWidth(size, unitSize, angle)` and already reserves the label's
 * true horizontal extent (recharts/lib/cartesian/getTicks.js). The subtraction
 * cancelled the thinning almost exactly — required gap fell to ~10px against
 * ~16px available, so nothing was dropped and the axis stayed a smear. The
 * geometry is already handled; what is left to say is only how much air to leave.
 *
 * Preserving the START and END is the half that matters for a time series: an
 * axis that dropped "Apr 2020" and "Aug 2026" would lose the two labels a reader
 * looks for first — where the history begins and where it stops.
 *
 * An axis whose labels already fit is untouched. Nothing is dropped when there is
 * room, so twelve classes and four quarters render exactly as they did.
 */
const rotatedTicks = {
  interval: 'preserveStartEnd',
  minTickGap: TICK_GAP_PX,
} as const;

/**
 * A category tick that cannot wrap.
 *
 * Recharts' default tick is its `<Text>` component, which WRAPS to a second
 * line when the string exceeds the axis width — and a wrapped label overlaps
 * the rows above and below it, which is worse than the ellipsis it was trying
 * to avoid. No arithmetic fixes that reliably: the wrap point depends on the
 * browser's own text metrics, so a per-character estimate is always one long
 * department name away from being wrong.
 *
 * A plain `<text>` never wraps, so truncation here is the only behaviour there
 * is. The `<title>` child gives the untruncated name on hover — the axis
 * abbreviates, the name is never lost.
 */
interface TickProps {
  readonly x?: number;
  readonly y?: number;
  readonly payload?: { value?: unknown };
  readonly maxChars?: number;
}

function CategoryTick({ x = 0, y = 0, payload, maxChars = 24 }: TickProps): ReactElement {
  const text = String(payload?.value ?? '');
  const shown = text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
  return (
    <text x={x} y={y} dy={4} textAnchor="end" fill={MUTED} fontSize={11}>
      <title>{text}</title>
      {shown}
    </text>
  );
}

/**
 * Wraps a chart's `ResponsiveContainer` so a COMPACT card's chart can grow to
 * fill whatever height the CSS grid row stretches its card to (`.pgallery`
 * stretches every card in a row to match the tallest one, e.g. a
 * many-department bar chart) instead of sitting at a fixed pixel height with
 * dead space below it. `naturalHeight` is what the chart would be standing
 * alone — still applied as a CSS `min-height` (tokens.css `.specChartFill`),
 * so nothing changes for a card with no taller neighbour. The full dashboard
 * and the PDF (`compact` unset) are untouched: a plain `ResponsiveContainer`
 * at its original fixed height, exactly as before this existed.
 *
 * -- Why the stretch is now BOUNDED (2026-09-01) -----------------------------
 * It was unbounded, and the 2-up grid made that visible: a 3-school Enrollment
 * card sharing a row with an 8-department Staff Overview was stretched to the
 * taller card's height, so three 22px bars sat in 390px with ~110px of blank
 * band between them. That is not a chart breathing, it is a chart coming apart
 * — the bars stop reading as one series because nothing visually groups them.
 *
 * 1.3× is the ceiling: enough that a card an inch taller than its neighbour
 * still fills, which is the case this wrapper was written for, and not so much
 * that a 3-row chart can be stretched to an 8-row one's height. Past the
 * ceiling the leftover goes back to being space under the chart. Dead space at
 * the bottom of a card is a smaller problem than a chart whose own rows have
 * drifted apart, and it is the one the reader does not notice.
 */
function ChartFrame({
  compact,
  naturalHeight,
  children,
}: {
  compact: boolean | undefined;
  naturalHeight: number;
  children: ReactElement;
}): ReactElement {
  if (compact === true) {
    return (
      <div
        className="specChartFill"
        style={{ minHeight: naturalHeight, maxHeight: Math.round(naturalHeight * 1.3) }}
      >
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={naturalHeight}>
      {children}
    </ResponsiveContainer>
  );
}

/**
 * One drill click, as ADR-020 defines it: a `{dim, value}` pair pushed onto the
 * drill stack, plus the text the breadcrumb should show for it.
 *
 * `label` is separate from `value` because they are not always the same string
 * — a school drills on its id and reads as its name — and a breadcrumb built
 * from the id would name a slice nobody recognises. The renderer reports the
 * click; deciding what to fetch next belongs to the caller, which owns the
 * drill path (services/dashboards.ts `DRILL_PATHS`).
 */
export interface DrillTarget {
  readonly dim: string;
  readonly value: string;
  readonly label: string;
}

export type DrillHandler = (target: DrillTarget) => void;

/**
 * The Recharts click state, narrowed to the one field this file reads.
 * Recharts' own `CategoricalChartState` is not exported from its public types,
 * and the alternative — `any` on a click handler — is exactly the shape §3
 * refuses.
 */
interface ChartClickState {
  /**
   * Recharts types this as `number | TooltipIndex | undefined`, where
   * `TooltipIndex` widens to a string or null. Accepted as it really is and
   * narrowed in `drillTargetAt`, rather than declared as a number here and
   * cast — a cast would move the same uncertainty somewhere it cannot be
   * checked.
   */
  readonly activeTooltipIndex?: number | string | null | undefined;
}

/**
 * Turn a click on category N into the pair the caller pushes.
 *
 * Reads the ROW, not the label Recharts hands back: `drill_value_field` lets a
 * chart display one string and narrow on another (a school's name versus its
 * id), and a drill built from the visible label would silently depend on those
 * being the same. Returns null when the widget is not drillable, when the index
 * is out of range, or when the row has no usable value — a click that cannot be
 * turned into a bound parameter must do nothing rather than something
 * approximate.
 */
function drillTargetAt(
  widget: {
    data: readonly Record<string, unknown>[];
    x: string;
    drillable?: boolean | undefined;
    drill_dim?: string | undefined;
    drill_value_field?: string | undefined;
  },
  index: number | string | null | undefined,
): DrillTarget | null {
  if (widget.drillable !== true || widget.drill_dim === undefined) return null;
  const at = typeof index === 'string' ? Number(index) : index;
  if (at === null || at === undefined || !Number.isInteger(at)) return null;
  if (at < 0 || at >= widget.data.length) return null;
  const row = widget.data[at];
  if (row === undefined) return null;
  const label = String(row[widget.x] ?? '');
  const raw = row[widget.drill_value_field ?? widget.x];
  if (raw === null || raw === undefined) return null;
  const value = String(raw);
  if (value === '') return null;
  return { dim: widget.drill_dim, value, label: label === '' ? value : label };
}

/**
 * The measures a bar chart draws, as a list, whether or not it is grouped.
 *
 * A single-series bar is the one-element case rather than a separate concept,
 * so the axis-sizing arithmetic and the click handling below have ONE shape to
 * reason about. What stays separate is the PAINT: a lone series keeps its
 * gradient and tallest-bar highlight (devices that mean "compare within this
 * chart"), which would read as noise once three colours are already carrying
 * identity.
 */
function seriesOf(widget: BarWidget): readonly BarSeries[] {
  return widget.series ?? [{ field: widget.y, label: widget.title ?? widget.y }];
}

/**
 * The colour a data-bound chart draws in.
 *
 * `tone` wins over `accent` when both are present, and the precedence is the
 * point: `accent` is variety chosen by the page showing the chart, `tone` is
 * what the measure IS (spec.ts). A caller cycling colours across a preview grid
 * must not be able to paint overdue money in the teal it uses for headcounts —
 * meaning outranks arrangement. Neither present is the platform teal every
 * chart has always been.
 */
function measureColour(tone: Tone | undefined, accent: ChartAccent | undefined): string {
  if (tone !== undefined && tone !== 'neutral') return toneColour(tone);
  return ACCENT_COLOUR[accent ?? 'primary'];
}

export function BarPanel({
  widget,
  compact,
  accent,
  actions,
  onDrill,
}: {
  widget: BarWidget;
  /** Card-sized: shorter than the full dashboard panel, real axes (Home preview cards). */
  compact?: boolean | undefined;
  /** Single-series colour, Home preview cards only -- see `ChartAccent`. Ignored by a grouped bar, whose colours carry series identity rather than variety. */
  accent?: ChartAccent | undefined;
  actions?: ReactNode | undefined;
  /**
   * Called when a reader clicks a category, for a `drillable` widget (ADR-020).
   * Absent means the chart is inert -- which is how the PDF route renders it
   * (print.tsx passes nothing), so an export can never carry a dead affordance.
   */
  onDrill?: DrillHandler | undefined;
}): ReactElement {
  const series = seriesOf(widget);
  const grouped = widget.series !== undefined;
  /**
   * The measures are PARTS of one bar rather than bars beside each other
   * (spec.ts, `bar.stacked`). The schema already guarantees `series` is present
   * whenever this is true, so everything below can treat it as a variation of
   * the grouped case rather than a third kind of chart.
   */
  const stacked = grouped && widget.stacked === true;
  const seriesColour = measureColour(widget.tone, accent);
  const animation = useAnimation();
  /** One `<defs>` namespace per chart instance — see `MarkGradient`. */
  const gradId = useGradientId('bar');

  /**
   * The hook runs before the empty check, unconditionally. React requires the
   * same hooks in the same order on every render, and an early `return` above
   * it would break that the first time a widget went from having rows to having
   * none -- a filter change, or a drill into an empty slice, which is exactly
   * when this chart is most likely to be re-rendered.
   */
  if (widget.data.length === 0) {
    return (
      <Panel
        title={widget.title}
        variant="medium"
        compact={compact}
        actions={actions}
      >
        <div className="specEmpty">
          <span className="icon" aria-hidden="true">▤</span>
          <span className="msg">No records available.</span>
        </div>
      </Panel>
    );
  }

  const axis = categoryAxis(widget.data, widget.x);

  /** Live only when the spec says drillable AND the caller wants the clicks. */
  const drillable =
    widget.drillable === true && widget.drill_dim !== undefined && onDrill !== undefined;
  /**
   * Cursor and click sit on the CHART, not on the panel: the title and the
   * "Clone" button beside it are not drill targets, and a pointer cursor over
   * the whole card would promise a click that does nothing there.
   */
  const chartProps = drillable
    ? {
        onClick: (state: ChartClickState): void => {
          const target = drillTargetAt(widget, state.activeTooltipIndex);
          if (target !== null) onDrill?.(target);
        },
        style: { cursor: 'pointer' } as CSSProperties,
      }
    : {};

  /**
   * The bars themselves. Grouped bars are flat fills in the fixed docs/10
   * section 1 order (`SERIES`) -- colour carries series identity, so it must
   * not also depend on which series happens to be tallest, and removing one
   * series must never repaint the survivors.
   *
   * `barGap` is the 2px surface gap that keeps adjacent fills readable as two
   * marks rather than one wide one; the category gap Recharts defaults to is
   * already wider, which is what makes the grouping legible without a box
   * around it.
   */
  /**
   * The range a SINGLE series' magnitude shading is measured against, and the
   * ramp it is drawn from. Both are computed once here rather than per bar: the
   * scale of a chart is a property of the chart, and recomputing the maximum
   * inside the map would be the same scan fourteen times over.
   *
   * The largest value, not the largest MINUS the smallest. A bar chart's value
   * axis starts at zero — that is what makes bar length comparable at all — so
   * the shading is measured from the same origin the marks are, and a set of
   * nearly-equal values is nearly-equally shaded rather than being stretched
   * across the whole ramp to manufacture a difference that is not there.
   *
   * Negative values are floored at zero where the share is taken (below), not
   * here: a negative measure has no position on a zero-based ramp, and clamping
   * it to the palest step is the same thing the axis does to its bar.
   */
  const barMax = grouped
    ? 0
    : widget.data.reduce((most, row) => {
        const value = row[widget.y];
        return typeof value === 'number' && Number.isFinite(value) ? Math.max(most, value) : most;
      }, 0);
  const singleRamp = rampOf(seriesColour);

  /**
   * Each single-series bar's own base colour, shaded by magnitude — computed
   * ONCE here because two things now consume it: the `<Cell>` that paints the
   * bar, and the `<linearGradient>` in `<defs>` that the cell points at. Derived
   * twice they could disagree, and a bar whose wash was built from a different
   * step than its own would be a shading scale that lies about magnitude.
   *
   * Empty for a grouped chart, where colour carries series identity instead and
   * magnitude shading would fight it (see `barMax`).
   */
  const cellColours = grouped
    ? []
    : widget.data.map((row) => {
        const value = row[widget.y];
        const share =
          typeof value === 'number' && Number.isFinite(value) && barMax > 0
            ? Math.max(0, value) / barMax
            : null;
        return share === null ? singleRamp.base : mixHex(singleRamp.soft, singleRamp.deep, share);
      });

  /**
   * Whether the marks are thick enough for a rail to read as a CONTAINER rather
   * than as background texture.
   *
   * The rail is the whole of the Meadow treatment (docs/10 §1) and it earns its
   * place on the charts this product draws most: three schools, one to three
   * measures each. It stops earning it as the marks multiply. Comparative
   * Analysis draws twelve fee periods against three measures — thirty-six bars
   * in one panel — and thirty-six full-height rails behind them is not a set of
   * containers, it is a picket fence with the data threaded through it. Recharts
   * thins a bar as its band shrinks, so past roughly sixteen marks the rail's
   * own edges carry more ink than the mark inside them.
   *
   * Sixteen rather than a rounder number because it is the first count at which
   * this product's real charts split cleanly: Fee Collection's fourteen classes
   * keep their rails, Comparative Analysis' thirty-six lose them.
   */
  const rails = axis.count * series.length <= 16;

  const bars = grouped
    ? series.map((entry, index) => {
        /**
         * Only the segment at the VALUE end of a stack is rounded; rounding
         * every segment would draw four capsules with gaps of background
         * between them, which reads as four bars — the exact misreading
         * stacking exists to prevent. An unstacked group rounds each bar,
         * because each one really is its own mark.
         */
        const last = index === series.length - 1;
        const square: [number, number, number, number] = [0, 0, 0, 0];
        /**
         * 4px at the DATA end, square at the baseline. Both halves of that
         * matter: the rounded cap is what stops a bar reading as a bare rule,
         * and the square foot is what keeps every bar starting from one shared
         * line — a capsule rounded at both ends floats off its own axis and the
         * eye has to guess where the measurement begins.
         */
        const rounded: [number, number, number, number] = axis.horizontal
          ? [0, 6, 6, 0]
          : [6, 6, 0, 0];
        return (
          <Bar
            key={entry.field}
            dataKey={entry.field}
            name={entry.label}
            /**
             * Washed along the bar in the series' own hue (`MarkGradient`). The
             * legend swatch beside it is painted from the same three stops, so
             * identity still matches colour-for-colour — which is the condition
             * the two earlier gradient attempts failed and this one meets.
             */
            fill={`url(#${gradId}-s${String(index)})`}
            /**
             * A rail per bar, in that bar's hue — the same device the
             * single-series chart uses, applied to each member of the group.
             *
             * Never on a STACK: a stack's segments are parts of one bar, so a
             * full-scale rail behind each of them would draw four scales for one
             * measurement and the bar would sit inside its own ghost.
             */
            {...(stacked || !rails
              ? {}
              : { background: { fill: tintOf(seriesColourAt(index), RAIL_STRENGTH), radius: 6 } })}
            {...(stacked ? { stackId: 'a' } : {})}
            radius={stacked ? (last ? rounded : square) : rounded}
            /**
             * Each series enters after the one before it. The eye follows a
             * group being built rather than three bars appearing at once, and
             * on a stacked bar it is the reading order of the stack itself.
             * `useAnimation` already returns `isAnimationActive: false` under
             * prefers-reduced-motion, so this offset simply never applies then.
             */
            animationBegin={index * 90}
            animationEasing="ease-out"
            /**
             * A stacked bar's segments touch, and two adjacent fills with no
             * space between them read as one wider band. The separator is drawn
             * in the CARD's own colour so it reads as a gap rather than as an
             * outline around each segment — the mark is still only its fill.
             * Grouped bars have `barGap` doing this already, so they take none.
             */
            {...(stacked ? { stroke: SURFACE, strokeWidth: 1.5 } : {})}
            /**
             * A stack is ONE bar per category however many measures it holds,
             * so it gets the width a single-series bar would have rather than
             * the narrow band a member of a group gets.
             */
            maxBarSize={
              stacked
                ? axis.horizontal
                  ? BAR_PX.single
                  : BAR_PX.singleV
                : axis.horizontal
                  ? BAR_PX.grouped
                  : BAR_PX.groupedV
            }
            {...animation}
            activeBar={{ stroke: INK, strokeWidth: 1 }}
          />
        );
      })
    : [
        <Bar
          key={widget.y}
          dataKey={widget.y}
          radius={axis.horizontal ? [0, 6, 6, 0] : [6, 6, 0, 0]}
          maxBarSize={axis.horizontal ? BAR_PX.single : BAR_PX.singleV}
          /**
           * The rail is back, and this time it is the mark's OWN hue at 10%
           * rather than grey (Meadow, docs/10 §1).
           *
           * The grey version was removed because fourteen full-width grey rails
           * behind fourteen teal bars read as a striped table with the data
           * faint inside it — the scale louder than the measurement. A rail in
           * the hue is a different object: it reads as the unfilled part of the
           * same measure, so a short bar reads as a small share of something
           * rather than a stub floating in space, and nothing on the card is
           * competing with the mark for attention.
           *
           * It also replaces the grid on these charts rather than joining it
           * (see `CartesianGrid` below): a rail per row and a rule per tick are
           * two scales drawn over each other.
           */
          {...(rails
            ? { background: { fill: tintOf(seriesColour, RAIL_STRENGTH), radius: 6 } }
            : {})}
          animationEasing="ease-out"
          {...animation}
          activeBar={{ stroke: INK, strokeWidth: 1, strokeOpacity: 0.35 }}
        >
          {/**
            * Each bar shaded along the series' OWN ramp by how big it is —
            * palest at the bottom of the range, deepest at the top (2026-09-03).
            *
            * -- Why this is not the thing that was removed --------------------
            * What used to be here painted THE TALLEST bar a deeper step, and it
            * was taken out because singling out one mark on a single-measure
            * chart reads as a second series: two colours where the data has one
            * category. A continuous ramp says the opposite. No bar is picked
            * out, nothing is grouped, and the shade is a function of the same
            * number the length already draws — so a reader cannot infer a
            * category from it, because there is none to infer. Length remains
            * the encoding; the shade is redundant with it, which is exactly what
            * makes it safe.
            *
            * -- What it buys ---------------------------------------------------
            * Fourteen classes in one flat teal is a picket fence: the panel has
            * no focus, and the eye has to walk the axis to find the ends of the
            * range. Shaded, the biggest and smallest classes are visible before
            * anything is read. The complaint this comes from was that the charts
            * looked monotonous, and a single-series bar chart is where the
            * product has the most of them.
            *
            * -- The floor is deliberate -----------------------------------------
            * The scale runs `soft` → `deep`, not `light` → `deep`: `light` is a
            * cap for shading a donut wedge that has real area, and a 22px bar
            * painted in it reads as disabled. Starting at `soft` keeps the
            * smallest bar unmistakably the series' hue while still leaving a
            * visible distance to the largest.
            *
            * A non-numeric or missing value takes the base colour rather than a
            * position it has not earned. `max <= 0` (every value zero or absent)
            * takes it too, and the chart is then one flat hue — which is honest:
            * there is no magnitude to shade by.
            */}
          {widget.data.map((row, index) => (
            <Cell key={String(row[widget.x] ?? index)} fill={`url(#${gradId}-c${String(index)})`} />
          ))}
        </Bar>,
      ];

  /**
   * One `<linearGradient>` per paintable mark — per SERIES when colour carries
   * identity, per BAR when it carries magnitude.
   *
   * Both branches wash along the same axis the bars run on, so a horizontal
   * chart's marks all deepen toward the value axis on the left and a column
   * chart's all deepen toward the baseline. See `MarkGradient` for why the wash
   * came back and what keeps it honest against the legend.
   */
  const gradientDefs = (
    <defs>
      {grouped
        ? series.map((entry, index) => (
            <MarkGradient
              key={entry.field}
              id={`${gradId}-s${String(index)}`}
              colour={seriesColourAt(index)}
              horizontal={axis.horizontal}
            />
          ))
        : cellColours.map((colour, index) => (
            <MarkGradient
              key={`${gradId}-c${String(index)}`}
              id={`${gradId}-c${String(index)}`}
              colour={colour}
              horizontal={axis.horizontal}
            />
          ))}
    </defs>
  );

  /**
   * [MANDATORY for two or more series] identity is never colour alone, so a
   * grouped bar always carries a legend. A single-series bar never does: its
   * title already names the one thing it draws, and a legend box repeating it
   * would be chrome standing in for information.
   */
  /**
   * The legend's entries are passed EXPLICITLY, in the spec's series order.
   *
   * Recharts derives its own payload otherwise, and the order it derives is not
   * the order the chart draws — the Fee Collection group renders
   * payable/collected/pending and legends them "Collected, Demand raised,
   * Outstanding". On a grouped bar that is a nuisance; on a STACKED one it is a
   * defect, because the legend is the only key to which band of one bar is
   * which, and a reader matching top-to-bottom gets the wrong answer.
   */
  /**
   * No `height` on the Legend, deliberately.
   *
   * Recharts reserves plot space for a legend by MEASURING its wrapper div and
   * offsetting the plot area by that box (`appendOffsetOfLegend`). A `height`
   * prop is written straight onto the wrapper's style, which pins the measured
   * box no matter what is inside it -- and the row below wraps. Four exit
   * reasons plus "Other reasons" do not fit one line of a 6-column panel, so
   * the second row rendered OUTSIDE the 26px the plot had been shifted by, and
   * printed over the value axis and the tops of the bars ("Why students left").
   *
   * Left to size itself the wrapper is `height: auto`, the ResizeObserver
   * behind that measurement reports the real two- or three-row height, and the
   * plot starts below the last row -- at any panel width, for any number of
   * series, and in the PDF, which renders these same specs through Chromium.
   */
  const legend = grouped ? (
    <Legend
      verticalAlign="top"
      align="center"
      iconType="circle"
      iconSize={8}
      wrapperStyle={{ fontSize: 11, color: MUTED, paddingBottom: 10 }}
      /**
       * `content` rather than `payload`: this Recharts version derives the
       * payload itself and does not accept one, so the only way to fix the
       * ORDER is to draw the row. It is six spans and a dot each — chrome, not
       * a chart — and it renders identically on paper, which a legend the PDF
       * had to re-derive would not be guaranteed to do.
       */
      content={() => (
        <ul
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            /**
             * Centred over the plot since 2026-09-03, where it used to sit hard
             * left under the title.
             *
             * Left-aligned, a legend is a second heading: it starts on the same
             * x as the panel title one line above it and reads as a subtitle
             * that happens to have dots in it. Centred over the plot it reads as
             * a key TO the plot, which is what it is — and the gap it leaves
             * under the title is what makes the title look like a title.
             */
            justifyContent: 'center',
            gap: '4px 16px',
            listStyle: 'none',
            margin: 0,
            padding: 0,
            fontSize: 11,
            lineHeight: 1.35,
            color: MUTED,
          }}
        >
          {series.map((entry, index) => (
            <li key={entry.field} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {/* Washed like the bars it keys — see `legendDotStyle`. */}
              <span
                aria-hidden="true"
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: '50%',
                  display: 'inline-block',
                  ...legendDotStyle(seriesColourAt(index)),
                }}
              />
              {entry.label}
            </li>
          ))}
        </ul>
      )}
    />
  ) : null;

  /**
   * docs/06 section 4.4 asks for a hover hint naming what a click does. Dropped
   * at card size, where there is no room for a line of prose under the chart,
   * and absent from the PDF for free -- the export passes no `onDrill`.
   */
  const hint =
    drillable && compact !== true ? (
      <p className="specDrillHint">Click a bar to see this {widget.drill_dim} broken down.</p>
    ) : null;

  if (axis.horizontal) {
    /**
     * The panel grows with the data instead of squeezing rows to a fixed 260px:
     * 26px a row keeps a 12px bar plus air, and the ceiling stops a
     * pathological category list from producing a page-long chart. Compact
     * uses the same idea at a tighter budget -- Home's preview cards are wide
     * (2-up, tokens.css `.pgallery`) but still a preview, not a full report.
     */
    /**
     * A band's height, per category. Raised with `BAR_PX` on 2026-09-01 and for
     * the same reason: thickness alone would have made a thicker bar eat the gap
     * between categories, trading one kind of ugly for another. The rule of
     * thumb here is bar + roughly half a bar of air — 22px marks in a ~34px
     * band, 3×16px grouped marks in a ~62px band — which keeps each category
     * legible as its own row while the marks stay solid.
     *
     * A grouped band holds one bar PER SERIES, so its budget is per-bar rather
     * than per-category: three measures across nine classes is 27 bars, and a
     * band sized for one would draw them on top of each other.
     */
    const perRow = grouped && !stacked ? 17 * series.length + 10 : 28;
    const compactPerRow = grouped && !stacked ? 16 * series.length + 9 : 26;
    /**
     * The ceiling came down from 680 to 520 (2026-09-03) along with the per-row
     * budget. A panel is half the page wide now rather than all of it, so a
     * chart that runs 680px tall beside a 330px neighbour leaves the row looking
     * broken -- and 680px of one chart is more than a screen of a reporting page
     * can spend on a single reading anyway. Past the ceiling the bands thin on
     * their own, which is the behaviour a long category list should have.
     */
    const height =
      compact === true
        ? clamp(50 + axis.count * compactPerRow, 150, 330)
        : clamp(40 + axis.count * perRow + (grouped ? 22 : 0), 180, 520);
    /**
     * The axis takes the width its labels need, up to a ceiling that leaves the
     * bars the larger half of the panel. `- 14` is the tick line and its gap.
     *
     * Both numbers come from the same budget on purpose: Recharts WRAPS a
     * category tick that does not fit its band, and a wrapped label collides
     * with the rows either side of it -- worse than the ellipsis it was avoiding.
     * So the ellipsis is applied at exactly the width the axis was given.
     */
    const labelWidth = clamp(axis.longest * CHAR_PX + 14, 104, 168);
    const labelChars = Math.floor((labelWidth - 14) / CHAR_PX);

    return (
      <Panel
        title={widget.title}
        variant={needsFullWidth('horizontal', axis.count, axis.longest) ? 'wide' : 'medium'}
        compact={compact}
        actions={actions}
      >
        <ChartFrame compact={compact} naturalHeight={height}>
          <BarChart
            data={[...widget.data]}
            layout="vertical"
            margin={{ top: 4, right: 16, bottom: 4, left: 0 }}
            barGap={2}
            {...chartProps}
          >
            {gradientDefs}
            {/* Grid lines run along the value axis only -- the category axis has
                no scale to read against. */}
            {/* Exactly ONE scale device, always. Where each bar has a rail, the
                rail already shows the full scale it is measured against, once per
                mark, and a rule per tick on top of that is a second scale drawn
                over the first. Where the rails were suppressed for density
                (`rails`, above), the grid comes back — otherwise a chart of
                thirty-six bars would have no scale at all behind its axis
                labels (docs/10 §1, Meadow). */}
            {!rails && (
              <CartesianGrid stroke={GRID} strokeDasharray={GRID_DASH} horizontal={false} />
            )}
            {/* Both axes render at every size now -- Home's preview cards are wide
                enough (2-up, tokens.css `.pgallery`) for the same truncate-with-
                tooltip treatment the full dashboard uses (`CategoryTick`,
                `axisNumber` below) to stay legible; a glance no longer has to
                guess what a bar's category or scale is. */}
            <XAxis type="number" tick={tick} tickFormatter={axisNumber} height={28} {...AXIS_BARE} />
            <YAxis
              type="category"
              dataKey={widget.x}
              tick={<CategoryTick maxChars={labelChars} />}
              interval={0}
              width={labelWidth}
              {...AXIS_BARE}
            />
            {/* The tooltip carries the untruncated name: the axis may abbreviate,
                the reader can still find out what a bar is. */}
            <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(3,46,54,0.04)' }} />
            {legend}
            {bars}
          </BarChart>
        </ChartFrame>
        {hint}
      </Panel>
    );
  }

  return (
    /**
     * A drill panel is `wide` even when its bars run vertically.
     *
     * Orientation is derived from the CATEGORY LABELS (`categoryAxis`), and a
     * drill path changes its categories at every level — so Comparative
     * Analysis' panel is horizontal at school level ("World School"), still
     * horizontal at instalment level ("April 2026-27"), and turns vertical at
     * class level, where the longest label is "NURSERY". Sized by orientation
     * alone that panel is 12 columns, then 12, then 6: it HALVES under the
     * reader on the last click, and the six columns it frees cannot be filled,
     * because every panel below it on these reports is already 12.
     *
     * Which is the wrong thing to optimise anyway. docs/06 §4.4 has a drill
     * "swap the chart in place", and a panel that resizes as you descend is not
     * in place — the page reflows under the cursor that just clicked, and
     * clicking ← Back reflows it again. A stable frame is what makes three
     * levels read as one chart being narrowed rather than three charts.
     *
     * `medium` for the pair of them since 2026-09-03, where it was `wide`.
     *
     * The stability requirement is unchanged and is still the whole point; what
     * changed is the span that satisfies it. `wide` was chosen when a horizontal
     * bar was always 12 and a vertical one always 6, so 12 was the only value
     * both orientations could share. Now that the default rhythm is two-up and
     * BOTH orientations are 6 unless their data earns a full row
     * (`needsFullWidth`), 6 is equally stable and costs half the screen.
     *
     * Note this is deliberately not `needsFullWidth` per level: that would
     * reintroduce exactly the resizing this comment argues against, since a path
     * changes its categories as it descends. A drill panel picks one span and
     * keeps it for the whole descent.
     */
    <Panel
      title={widget.title}
      variant="medium"
      compact={compact}
      actions={actions}
    >
      <ChartFrame
        compact={compact}
        naturalHeight={compact === true ? 240 : grouped ? 300 : 260}
      >
        <BarChart
          data={[...widget.data]}
          margin={{ top: 8, right: 8, bottom: 4, left: 0 }}
          barGap={2}
          {...chartProps}
        >
          {gradientDefs}
          {/* One scale device, always — the rails, or the grid when they were
              suppressed for density. See the horizontal branch. */}
          {!rails && <CartesianGrid stroke={GRID} strokeDasharray={GRID_DASH} vertical={false} />}
          <XAxis
            dataKey={widget.x}
            tick={tick}
            {...rotatedTicks}
            {...AXIS_BARE}
            {...categoryTicks(axis.longest)}
          />
          <YAxis tick={tick} tickFormatter={axisNumber} width={54} {...AXIS_BARE} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(3,46,54,0.04)' }} />
          {legend}
          {bars}
        </BarChart>
      </ChartFrame>
      {hint}
    </Panel>
  );
}

/** A custom dot renderer's props, per Recharts' convention (mirrors `TickProps` above). */
interface LineDotProps {
  readonly cx?: number;
  readonly cy?: number;
  readonly index?: number;
}

/**
 * The latest point drawn larger and outlined, permanently — not only on
 * hover. A trend line's most recent value is usually the one a reader came
 * to check, so it stays visually singled out (§7 "highlight the latest data
 * point"). `lastIndex` is closed over rather than read from props because
 * Recharts does not otherwise tell a dot renderer how many points there are.
 */
function makeLineDot(lastIndex: number, color: string): (props: LineDotProps) => ReactElement {
  return function LineDot({ cx = 0, cy = 0, index = -1 }: LineDotProps): ReactElement {
    const isLatest = index === lastIndex;
    /**
     * Every reading is a RING — card-coloured inside the series stroke — and the
     * latest one is the single filled disc on the chart (2026-09-03).
     *
     * Filled dots everywhere made the emphasis a size difference of 1.5px, which
     * nobody can see, and thickened the line into a beaded rule. Inverting it
     * gives the distinction a channel of its own: the reader is not comparing two
     * radii, they are finding the one solid mark among the hollow ones.
     */
    return isLatest ? (
      <circle cx={cx} cy={cy} r={4} fill={color} stroke={SURFACE} strokeWidth={2} />
    ) : (
      <circle cx={cx} cy={cy} r={3} fill={SURFACE} stroke={color} strokeWidth={1.6} />
    );
  };
}

/**
 * Long-format rows pivoted into the wide shape Recharts draws from.
 *
 * The spec's `line.series` names a FIELD whose value splits the rows into
 * several lines -- one row per (period, year) for a two-year recovery trend --
 * because that is the shape SQL returns and the shape a spec can describe
 * without inventing a column name per series. Recharts wants the opposite: one
 * row per period carrying a key per line. Pivoting here, in the renderer, keeps
 * the contract describing the DATA rather than the drawing library.
 *
 * Category order is the order the rows arrive in, never sorted: the emitter
 * ordered the periods (`seq` in the SQL) and re-sorting them as text would put
 * Q10 before Q2. Series order is first-appearance for the same reason -- the
 * emitter puts the current year first, and colour identity follows it.
 *
 * A missing (period, series) pair is left ABSENT rather than filled with zero:
 * a year with no instalment 5 has no point there, and a zero would draw a line
 * diving to the floor, which is a measurement nobody took.
 */
function pivotSeries(
  rows: readonly Record<string, unknown>[],
  x: string,
  y: string,
  seriesField: string,
): { rows: Record<string, unknown>[]; names: string[] } {
  const byCategory = new Map<string, Record<string, unknown>>();
  const names: string[] = [];
  for (const row of rows) {
    const category = String(row[x] ?? '');
    const name = String(row[seriesField] ?? '');
    if (name !== '' && !names.includes(name)) names.push(name);
    let entry = byCategory.get(category);
    if (entry === undefined) {
      entry = { [x]: category };
      byCategory.set(category, entry);
    }
    const value = row[y];
    if (name !== '' && value !== null && value !== undefined) entry[name] = value;
  }
  return { rows: [...byCategory.values()], names };
}

export function LinePanel({
  widget,
  compact,
  accent,
  actions,
  onDrill,
}: {
  widget: LineWidget;
  /** Card-sized: shorter than the full dashboard panel, real axes (Home preview cards). */
  compact?: boolean | undefined;
  /** Single-series colour, Home preview cards only -- see `ChartAccent`. */
  accent?: ChartAccent | undefined;
  actions?: ReactNode | undefined;
  /**
   * Drill clicks (ADR-020), for a level a report chose to draw as a line rather
   * than a bar (docs/06 §4.1's per-level `chart`).
   *
   * A line takes these because it is the same Recharts cartesian chart a bar
   * is: `activeTooltipIndex` names the same category, and `drillTargetAt` reads
   * the same row of `widget.data`. Without this a reader who set level 1 to a
   * line would get a chart that looks drillable, says it drills, and does
   * nothing on click -- exactly the success-shaped failure §10 names.
   *
   * Honoured only on the SINGLE-series branch below. A multi-series line is
   * drawn from `pivotSeries`' rows, which are not `widget.data` and do not
   * share its indices, so a click there cannot be turned into a bound value
   * without inventing a mapping -- and a drill that guesses which slice was
   * clicked is worse than one that does not offer itself.
   */
  onDrill?: DrillHandler | undefined;
}): ReactElement {
  const gradId = useGradientId('area');
  const animation = useAnimation();
  const seriesColor = measureColour(widget.tone, accent);
  const seriesRamp = rampOf(seriesColor);

  // Empty and single-point series read as a broken chart if forced through
  // the same axes a real trend uses — an honest small state instead (§18/19).
  if (widget.data.length === 0) {
    return (
      <Panel title={widget.title} variant="hero" compact={compact} actions={actions}>
        <div className="specEmpty">
          <span className="icon" aria-hidden="true">📈</span>
          <span className="msg">No records available for this period.</span>
        </div>
      </Panel>
    );
  }

  /**
   * Several lines on one pair of axes (`line.series`) -- the year-on-year
   * comparison Comparative Analysis' recovery trend is. Kept as its own branch
   * rather than folded into the single-series path below because the two differ
   * in more than a loop: a gradient fill under two overlapping lines is mud, and
   * the "latest point" emphasis that makes sense for one trend would mark two
   * different points on two different lines.
   *
   * `series` has been in the contract since it was written and had no renderer
   * until now, which is why this is an implementation rather than a contract
   * change: a spec setting it drew a single line and silently lost the split.
   */
  if (widget.series !== undefined) {
    const pivoted = pivotSeries(widget.data, widget.x, widget.y, widget.series);
    if (pivoted.names.length > 0) {
      return (
        /**
         * `wide`, where a single-series line is `hero`.
         *
         * Not a preference — it is the same kind of rule as `categoryAxis`
         * deciding a bar's orientation from its label lengths: the widget's own
         * shape decides its footprint. A one-series line is a trend, and `hero`
         * (span 7) leaves exactly the 5 columns a donut's `side` fills, which is
         * the pairing Fee Collection's "Receipts by month" and "Payment modes"
         * are built on. A MULTI-series line is a comparison: it carries a legend,
         * twice the marks, and the reader is matching two shapes against each
         * other point by point, which is the one thing horizontal room actually
         * buys. It also has no donut to pair with — a report that compares two
         * years has no reason to also carry a five-slice breakdown — so at span 7
         * those 5 columns strand, and the page grows a hole no later panel can
         * fill because every remaining panel is span 12.
         *
         * Single-series lines are untouched: Fee Collection's row still pairs.
         */
        <Panel
          title={widget.title}
          variant={
            needsFullWidth(
              'vertical',
              pivoted.rows.length,
              categoryAxis(pivoted.rows, widget.x).longest,
            )
              ? 'wide'
              : 'medium'
          }
          compact={compact}
          actions={actions}
        >
          <ChartFrame compact={compact} naturalHeight={compact === true ? 200 : 280}>
            <ComposedChart data={pivoted.rows} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
              {/**
                * A glow per line, in that line's own hue.
                *
                * The shadow is the one depth device a comparison chart can take:
                * the AREA fill is still refused here (two washes under two
                * crossing lines is mud, which is why this branch exists), but a
                * blurred copy of a stroke sits under the stroke rather than
                * across the plot, so two of them never pool into a third shape.
                */}
              <defs>
                {pivoted.names.map((name, index) => (
                  <LineGlow
                    key={name}
                    id={`${gradId}-glow${String(index)}`}
                    colour={SERIES[index] ?? SERIES_OTHER}
                  />
                ))}
              </defs>
              <CartesianGrid stroke={GRID} strokeDasharray={GRID_DASH} vertical={false} />
              <XAxis
                dataKey={widget.x}
                tick={tick}
                {...rotatedTicks}
                {...AXIS_BARE}
                {...categoryTicks(categoryAxis(pivoted.rows, widget.x).longest)}
              />
              <YAxis tick={tick} tickFormatter={axisNumber} width={54} {...AXIS_BARE} />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: MUTED, strokeWidth: 1, strokeDasharray: '3 3' }} />
              {/* [MANDATORY for two or more series] identity is never colour
                  alone -- the same rule the grouped bar follows, including its
                  reason for carrying no `height`: this legend names SCHOOLS, a
                  list neither this file nor the catalog bounds, so it wraps
                  sooner than any of them. Sized by measurement it pushes the
                  plot down instead of printing on it. */}
              <Legend
                verticalAlign="top"
                align="center"
                iconType="plainline"
                iconSize={14}
                wrapperStyle={{ fontSize: 11, color: MUTED, paddingBottom: 10 }}
              />
              {pivoted.names.map((name, index) => (
                <Line
                  key={name}
                  type="monotone"
                  dataKey={name}
                  name={name}
                  stroke={SERIES[index] ?? SERIES_OTHER}
                  strokeWidth={2.75}
                  strokeLinecap="round"
                  filter={`url(#${gradId}-glow${String(index)})`}
                  /**
                   * Dotted from the second line on. A comparison line is a
                   * REFERENCE, and dash pattern separates it from this year's
                   * line without a fifth hue -- and it survives a greyscale
                   * print, which colour alone does not (docs/10 §1).
                   */
                  {...(index === 0 ? {} : { strokeDasharray: '5 4' })}
                  /**
                   * A ring, not a disc: card-coloured fill inside the series'
                   * own stroke.
                   *
                   * A filled dot is a blob of the same ink the line is drawn in,
                   * so on a two-series chart the points stop reading as readings
                   * and start reading as a thicker line — and where two lines
                   * cross, four solid dots in two hues become one smudge. A ring
                   * keeps the point locatable because the card shows THROUGH it,
                   * which is also what stops the crossing from filling in.
                   */
                  dot={{ r: 3, fill: SURFACE, stroke: SERIES[index] ?? SERIES_OTHER, strokeWidth: 1.6 }}
                  activeDot={{ r: 5, fill: SERIES[index] ?? SERIES_OTHER, stroke: '#fff', strokeWidth: 2 }}
                  connectNulls={false}
                  {...animation}
                />
              ))}
            </ComposedChart>
          </ChartFrame>
        </Panel>
      );
    }
  }

  /**
   * Live only when the spec says drillable AND the caller wants the clicks --
   * the same pair `BarPanel` requires, so a line drills on exactly the
   * conditions a bar does and the PDF (which passes no handler) stays inert.
   *
   * Below the single-point branch on purpose: one point is drawn as a figure
   * rather than a chart, and there is no category there to click.
   */
  const drillable =
    widget.drillable === true && widget.drill_dim !== undefined && onDrill !== undefined;
  const chartProps = drillable
    ? {
        onClick: (state: ChartClickState): void => {
          const target = drillTargetAt(widget, state.activeTooltipIndex);
          if (target !== null) onDrill?.(target);
        },
        style: { cursor: 'pointer' } as CSSProperties,
      }
    : {};
  /** docs/06 §4.4's hover hint, at the size that has room for it (see BarPanel). */
  const hint =
    drillable && compact !== true ? (
      <p className="specDrillHint">Click a point to see this {widget.drill_dim} broken down.</p>
    ) : null;

  if (widget.data.length === 1) {
    const row = widget.data[0] as Record<string, unknown>;
    const value = row[widget.y];
    const label = row[widget.x];
    return (
      <Panel title={widget.title} variant="hero" compact={compact} actions={actions}>
        <div className="specSingle">
          <span className="value">
            {typeof value === 'number' ? full.format(value) : String(value ?? '—')}
          </span>
          {label !== undefined && label !== null && <span className="label">{String(label)}</span>}
          <span className="note">Only one period is currently available.</span>
        </div>
      </Panel>
    );
  }

  return (
    /**
     * A trend takes half the row unless its periods will not fit in one. Twelve
     * months pair happily beside a donut; Trend Analysis' 78 months are a smear
     * at that width, and `preserveStartEnd` would answer by dropping most of the
     * axis rather than by making the chart readable.
     */
    <Panel
      title={widget.title}
      variant={
        needsFullWidth('vertical', widget.data.length, categoryAxis(widget.data, widget.x).longest)
          ? 'wide'
          : 'medium'
      }
      compact={compact}
      actions={actions}
    >
      <ChartFrame compact={compact} naturalHeight={compact === true ? 200 : 260}>
        <ComposedChart data={[...widget.data]} margin={{ top: 8, right: 8, bottom: 4, left: 0 }} {...chartProps}>
          <defs>
            {/* A static fade to transparent — fixed SVG stops, not a timed
                effect, so the PDF capture (ADR-021) still matches the screen
                exactly at whatever instant Puppeteer takes the shot. */}
            {/* 0.26 at the top, three stops rather than two (2026-09-03).
                The ceiling argument still holds — past about a third the wash
                stops being a shadow of the trend and becomes a filled REGION
                whose AREA the eye starts reading, which on a monthly receipts
                chart is a quantity nobody measured. What changed is the floor:
                at 0.18 fading linearly to nothing, the wash was gone by the
                middle of the plot and the chart was a hairline over white for
                its bottom half. The middle stop holds a trace of colour to the
                foot of the plot, so the line reads as sitting ON something.
                The line is still the finding; the wash is still punctuation. */}
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={seriesRamp.base} stopOpacity={0.26} />
              <stop offset="55%" stopColor={seriesRamp.base} stopOpacity={0.09} />
              <stop offset="100%" stopColor={seriesRamp.base} stopOpacity={0} />
            </linearGradient>
            {/**
              * The stroke is washed along the trend, deep at the start and lit
              * at the latest reading.
              *
              * Same rule as a bar's (`MarkGradient`): lightness steps of one
              * audited hue, so the line is unmistakably one colour, and the wash
              * runs in the direction the chart is READ — left to right, arriving
              * lightest at the most recent point, which is the one the filled
              * dot already singles out. A single-series line carries no legend
              * to match against, so there is nothing here for the wash to
              * mismatch.
              */}
            <linearGradient id={`${gradId}-stroke`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={seriesRamp.deep} />
              <stop offset="60%" stopColor={seriesRamp.base} />
              <stop offset="100%" stopColor={seriesRamp.soft} />
            </linearGradient>
            <LineGlow id={`${gradId}-glow`} colour={seriesColor} />
          </defs>
          <CartesianGrid stroke={GRID} strokeDasharray={GRID_DASH} vertical={false} />
          {/* A line's x is a sequence — months, terms — so it stays horizontal
              and only sizes its band to the labels it actually has. Rendered
              at every size now (see BarPanel's axes above for why compact no
              longer drops them). */}
          <XAxis
            dataKey={widget.x}
            tick={tick}
            {...rotatedTicks}
            {...AXIS_BARE}
            {...categoryTicks(categoryAxis(widget.data, widget.x).longest)}
          />
          <YAxis tick={tick} tickFormatter={axisNumber} width={54} {...AXIS_BARE} />
          <Tooltip
            content={<ChartTooltip />}
            cursor={{ stroke: seriesColor, strokeWidth: 1, strokeDasharray: '3 3' }}
          />
          <Area
            type="monotone"
            dataKey={widget.y}
            stroke="none"
            fill={`url(#${gradId})`}
            {...animation}
            legendType="none"
          />
          <Line
            type="monotone"
            dataKey={widget.y}
            stroke={`url(#${gradId}-stroke)`}
            strokeWidth={3}
            strokeLinecap="round"
            filter={`url(#${gradId}-glow)`}
            dot={makeLineDot(widget.data.length - 1, seriesColor)}
            activeDot={{ r: 5.5, fill: seriesColor, stroke: '#fff', strokeWidth: 2 }}
            {...animation}
          />
        </ComposedChart>
      </ChartFrame>
      {hint}
    </Panel>
  );
}

/** A centre label longer than this collides with the ring at this radius. */
function centerLabel(text: string, max = 15): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function DonutPanel({
  widget,
  compact,
  actions,
}: {
  widget: DonutWidget;
  /** Card-sized: smaller ring, no legend list (Home preview cards). */
  compact?: boolean | undefined;
  actions?: ReactNode | undefined;
}): ReactElement {
  /**
   * The hook runs before the empty check, unconditionally — the same rule
   * BarPanel states at its own empty check, and this branch was on the wrong
   * side of it. React requires the same hooks in the same order on every
   * render, so a donut that went from having rows to having none (a filter
   * change, a drill into an empty slice) rendered fewer hooks than the render
   * before it and threw.
   */
  const animation = useAnimation();
  /** One `<defs>` namespace per ring — see `MarkGradient`. */
  const gradId = useGradientId('slice');

  if (widget.data.length === 0) {
    return (
      <Panel title={widget.title} variant="side" compact={compact} actions={actions}>
        <div className="specEmpty">
          <span className="icon" aria-hidden="true">◔</span>
          <span className="msg">No records available.</span>
        </div>
      </Panel>
    );
  }

  /** Restated at the centre of the ring — see `specDonutCenter` below. */
  const total = widget.data.reduce((sum, row) => {
    const value = row[widget.value_field];
    return sum + (typeof value === 'number' ? value : 0);
  }, 0);

  /**
   * When one slice genuinely dominates, naming it beats restating the total —
   * "68% Online" is the observation a reader would otherwise have to compute
   * from the legend by hand (§9). Derived purely from this widget's own data;
   * below a clear majority the total is the more honest summary.
   */
  let dominant: { label: string; value: number } | null = null;
  for (const row of widget.data) {
    const value = row[widget.value_field];
    if (typeof value === 'number' && (dominant === null || value > dominant.value)) {
      dominant = { label: String(row[widget.label_field] ?? ''), value };
    }
  }
  const dominantShare = dominant !== null && total > 0 ? dominant.value / total : 0;
  const showDominant = widget.data.length > 1 && dominant !== null && dominantShare >= 0.5;

  /**
   * Whether any slice is too thin to survive a rounded cap and a padding gap.
   *
   * 1.5% of the circle is 5.4 degrees, comfortably wider than the ~3 degrees the
   * padding takes and than the arc a 6px corner needs at this radius. Below it
   * the wedge is drawn as a spike (see the `cornerRadius` note on the Pie).
   * A zero-value slice counts: it is exactly the case that degenerates, and it
   * is one this product shows rather than hides.
   */
  const hasSliver =
    total > 0 &&
    widget.data.some((row) => {
      const value = row[widget.value_field];
      return typeof value !== 'number' || value / total < 0.015;
    });

  return (
    <Panel title={widget.title} variant="side" compact={compact} actions={actions}>
      {/**
       * The centre readout is a plain HTML overlay, not an SVG `<Label>` child
       * of `<Pie>`. Recharts 3's Pie no longer mounts a child `Label` at all
       * (confirmed against the rendered DOM — zero `<text>` nodes, silently) —
       * an internal-architecture break from the v2 pattern this used to be,
       * not a chart-spec contract change. `pointer-events: none` keeps the
       * overlay from stealing hover off the ring underneath it.
       */}
      <div className="specDonutWrap">
        <ResponsiveContainer width="100%" height={compact === true ? 210 : 220}>
          <PieChart>
            {/* A wash per wedge, in that wedge's own hue (`MarkGradient`), all
                running the same way down the ring — so the donut reads as one
                lit object rather than as five flat cut-outs, and no wedge picks
                up a hue that is not its own. The legend below keys it with the
                same three stops (`legendDotStyle`), which is the condition that
                makes a washed mark safe here as on the bars. */}
            <defs>
              {widget.data.map((row, index) => (
                <MarkGradient
                  key={String(row[widget.label_field] ?? index)}
                  id={`${gradId}-${String(index)}`}
                  colour={index < SERIES.length ? (SERIES[index] ?? SERIES_OTHER) : SERIES_OTHER}
                  horizontal={false}
                />
              ))}
            </defs>
            <Pie
              data={[...widget.data]}
              dataKey={widget.value_field}
              nameKey={widget.label_field}
              /**
               * A thicker band than the ring carried before (34px → 40px), and
               * rounded at both ends of every wedge.
               *
               * The band is where the colour lives, and at 30-odd pixels inside
               * a 220px plot the ring was a hoop with a lot of card showing
               * through the middle of a panel that had nothing else in it. The
               * `cornerRadius` is the other half: a wedge squared off against
               * its neighbours reads as a slice cut out of a disc, where a
               * rounded one reads as a segment of a track — which is the shape
               * a proportion should have when the centre is a readout rather
               * than part of the chart.
               */
              innerRadius={compact === true ? 54 : 52}
              outerRadius={92}
              /**
               * Rounded ends and the gap between wedges are both DROPPED once
               * the ring carries a sliver.
               *
               * Neither is defined for a wedge narrower than it is: a 3 degree
               * padding taken out of a 0.4 degree slice leaves a negative arc,
               * and a 6px corner radius on a wedge 2px across is a corner with
               * no straight edge to sit on. Recharts draws the degenerate path
               * rather than refusing it, and what appears is a thin spike
               * shooting out of the ring — which a reader reads as a data point,
               * because on every other chart in this product a mark that size
               * means a value that size.
               *
               * `hasSliver` is measured off the real shares rather than the
               * category count: a six-slice ring whose smallest slice is 8% is
               * perfectly safe and keeps the treatment. Attendance is the case
               * that forced this — Present, Absent, Leave, NIWD, NA, Half Day,
               * where the last three round to 0% and are still, correctly, shown.
               *
               * Dropping both for the WHOLE ring rather than per wedge is
               * deliberate: `cornerRadius` and `paddingAngle` are Pie-level
               * props, and a ring with some wedges rounded and others not would
               * read as two kinds of thing in one chart. The card-coloured
               * hairline still separates neighbours, which is what was doing the
               * real work anyway.
               */
              cornerRadius={hasSliver ? 0 : 6}
              paddingAngle={hasSliver ? 0 : 3}
              {...animation}
            >
              {widget.data.map((row, index) => {
                /* dataviz non-negotiable: a category past the validated,
                   four-step palette is never a fifth generated hue — it folds
                   into a single recessive "Other" fill instead. */
                const inPalette = index < SERIES.length;
                return (
                  <Cell
                    key={String(row[widget.label_field] ?? index)}
                    fill={`url(#${gradId}-${String(index)})`}
                    fillOpacity={inPalette ? 1 : 0.55}
                    /* The surface ring the dataviz spec asks for: slices touch
                       around the circle, and a hairline of card colour is what
                       keeps two neighbours from fusing into one wedge. */
                    stroke={SURFACE}
                    strokeWidth={2}
                  />
                );
              })}
            </Pie>
            <Tooltip content={<ChartTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        {/* The KPI strip above already states the total; restating it (or,
            when one slice dominates, naming that slice) where the eye
            actually lands saves the reader from adding the legend by hand. */}
        <div className={compact === true ? 'specDonutCenter specDonutCenter--compact' : 'specDonutCenter'}>
          {showDominant && dominant !== null ? (
            <>
              <span className="value">{Math.round(dominantShare * 100)}%</span>
              <span className="label">{centerLabel(dominant.label)}</span>
            </>
          ) : (
            <>
              <span className="value">{compactNum.format(total)}</span>
              <span className="label">TOTAL</span>
            </>
          )}
        </div>
      </div>
      {/* A plain HTML legend, not Recharts' — sharing the Pie's own drawing
          area with a legend row pushed the ring's true centre away from the
          container's geometric centre, which is what the HTML overlay above
          centres against. Keeping the legend outside that area keeps both
          simple.

          -- It renders at card size too now (2026-09-03) ---------------------
          It used to be dropped in `compact`, on the argument that the ring's
          colour split is the glance and the full key is a click away on the real
          dashboard. That held while a donut appeared on a preview card only by
          accident. It is now a chart the Dashboard grid CHOOSES — the gender mix
          of the roll, what attendance actually recorded (`DASHBOARD_PREVIEW`) —
          and a ring with no key is four coloured arcs a reader cannot name. The
          shares are the whole finding, so a card that omits them shows a
          decoration where a chart was meant to be. It is set tighter at card
          size rather than dropped (tokens.css `.specPanelCompact`).

          The centre readout follows for the same reason: `label` used to be
          `compact`-only-hidden, which left a bare number floating in a ring with
          nothing saying what it counted. */}
      <ul className="specDonutLegend">
          {widget.data.map((row, index) => {
            const inPalette = index < SERIES.length;
            /**
             * Each slice's SHARE, beside its name (2026-09-03).
             *
             * A donut's whole subject is proportion, and a legend that gives
             * only names hands the reader a colour key and asks them to
             * eyeball the angles — which is the one thing people are measurably
             * bad at. The number turns the legend into the readout and leaves
             * the ring to do what it is good at, which is showing the shape of
             * the split at a glance.
             *
             * A percentage, never the raw value: the underlying figures reach
             * this renderer as numbers rather than the server-formatted strings
             * a KPI carries, so printing them would mean this file inventing a
             * currency format the rest of the product decided once, elsewhere.
             * A share has no such problem — it is a ratio of two numbers in the
             * same unit, and the unit cancels. Rounded to whole percent, so the
             * column stays a column; the exact figure is a hover away on the
             * ring, which is where an exact figure belongs.
             */
            const value = row[widget.value_field];
            const share = typeof value === 'number' && total > 0 ? value / total : null;
            return (
              <li key={String(row[widget.label_field] ?? index)}>
                {/* Washed like the wedge it keys — see `legendDotStyle`. */}
                <span
                  className="dot"
                  style={legendDotStyle(
                    inPalette ? (SERIES[index] ?? SERIES_OTHER) : SERIES_OTHER,
                  )}
                />
                <span className="name">{String(row[widget.label_field] ?? '')}</span>
                {share !== null && <span className="share">{Math.round(share * 100)}%</span>}
              </li>
            );
        })}
      </ul>
    </Panel>
  );
}

/**
 * Compare two cells of the same column.
 *
 * Numbers numerically, everything else as text under the reader's own locale —
 * `localeCompare` rather than `<`, so "Ácharya" files beside "Acharya" instead
 * of after "Zoya". Nulls sort last in both directions: a missing value is not
 * the smallest value, and letting it lead an ascending sort would put every
 * blank row at the top of a table someone sorted to find their worst school.
 */
function compareCells(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

export function TablePanel({
  widget,
  actions,
}: {
  widget: TableWidget;
  actions?: ReactNode | undefined;
}): ReactElement {
  /**
   * Which column the reader sorted by, if any. `null` means the EMITTED order,
   * which is not "unsorted": the server ranked these rows for a reason (worst
   * arrears first, largest class first), so the initial view is the report's own
   * answer and re-sorting is the reader overriding it. Reset is therefore a real
   * third state of the header, not a no-op.
   *
   * Held here rather than lifted to the page because it is a property of looking
   * at this table, not of the report — a sorted column is never persisted, never
   * cloned into a saved report, and never printed: the PDF renders the spec's own
   * order (ADR-021), which is what keeps an export matching what was approved.
   */
  const [sort, setSort] = useState<{ field: string; descending: boolean } | null>(null);

  const sorted = (() => {
    if (sort === null) return widget.rows;
    const column = widget.columns.find((entry) => entry.field === sort.field);
    if (column === undefined) return widget.rows;
    const key = column.sort_field ?? column.field;
    /**
     * A copy. `widget.rows` belongs to the spec, and sorting in place would
     * mutate the object the PDF route and the clone button read from.
     */
    return [...widget.rows].sort((a, b) => {
      const order = compareCells(a[key], b[key]);
      return sort.descending ? -order : order;
    });
  })();

  return (
    /**
     * A table earns a full row by its COLUMN COUNT, not by being a table.
     *
     * Comparative Analysis' "School by school" carries eleven columns of
     * figures and cannot be read in half a page; its "Where to look first" is
     * three columns of short strings and was taking the same full row for no
     * reason.
     *
     * FOUR is the threshold, not five (corrected 2026-09-03 against the real
     * Fee Collection table). A label column plus three columns of Indian-format
     * rupee figures — "68,02,67,540" is twelve characters — already overflows a
     * half-width panel, and `.specTableWrap` answered by scrolling the last
     * column half out of view. A table the reader has to scroll sideways is
     * worse than one that took the width it needed.
     */
    <Panel
      title={widget.title}
      variant={widget.columns.length > 3 ? 'wide' : 'medium'}
      actions={actions}
    >
      {widget.rows.length === 0 ? (
        <div className="specEmpty">
          <span className="icon" aria-hidden="true">▤</span>
          <span className="msg">No rows to show.</span>
        </div>
      ) : (
        <>
          <div className="specTableWrap">
            <table className="specTable">
              <thead>
                <tr>
                  {widget.columns.map((column) => {
                    const active = sort !== null && sort.field === column.field;
                    return (
                      <th
                        key={column.field}
                        style={{ textAlign: column.align ?? 'left' }}
                        aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : 'none'}
                      >
                        {/* A real button, so the header is reachable by keyboard
                            and announced as the control it is. Three states in
                            order: ascending, descending, back to the order the
                            server sent. */}
                        <button
                          type="button"
                          className={`specSort${active ? ' active' : ''}`}
                          onClick={() => {
                            setSort((current) =>
                              current === null || current.field !== column.field
                                ? { field: column.field, descending: false }
                                : current.descending
                                  ? null
                                  : { field: column.field, descending: true },
                            );
                          }}
                        >
                          {column.label}
                          <span className="specSortMark" aria-hidden="true">
                            {active ? (sort.descending ? '▾' : '▴') : '⇅'}
                          </span>
                        </button>
                        {/* docs/04 rail 6: a masked column says so. Hiding it would be
                            a silently different table for a different reader. */}
                        {column.masked === true && <span className="pill nodata ml-2">masked</span>}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sorted.map((row, index) => (
                  <tr key={index}>
                    {widget.columns.map((column) => (
                      <td key={column.field} style={{ textAlign: column.align ?? 'left' }}>
                        {formatCell(row[column.field])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* ADR-008: truncation is never silent. */}
          {widget.truncated === true && (
            <p className="specNote">
              Showing the first rows only — this result hit the 5,000-row cap.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

/** Bento sizing (§5) — a widget kind's normal visual weight on the grid. */
type PanelVariant = 'hero' | 'side' | 'medium' | 'wide';

function Panel({
  title,
  variant,
  compact,
  actions,
  children,
}: {
  title?: string | undefined;
  variant?: PanelVariant | undefined;
  /**
   * A caller that already owns the card chrome and the title -- Home's preview
   * cards (services/home.ts `buildHomePreview`) -- gets the chart with neither
   * repeated. Never used by the dashboard screen or the PDF: both still get the
   * full `.card specPanel` exactly as before, which is what keeps ADR-021 true
   * (same renderer produces what prints).
   */
  compact?: boolean | undefined;
  /**
   * Platform chrome the caller renders beside the title — e.g. a per-chart
   * "⧉ Clone" button (docs/06 §3, per-widget customization). This is NOT
   * part of the chart-spec contract (ADR-015 still governs the widget's
   * DATA): the caller decides whether and what to render here from its own
   * page state, never from anything inside `spec`. Dropped in `compact` and
   * PDF rendering — neither owns page chrome (PDF renders no interactive
   * controls at all).
   */
  actions?: ReactNode | undefined;
  children: ReactNode;
}): ReactElement {
  if (compact === true) {
    return (
      <div className="specPanelCompact">
        {/* Axis chrome is dropped at card size (see the callers above), but the
            title is the one piece of context a shape cannot carry on its own --
            without it a preview card's chart is a squiggle or a stack of bars
            with no way to tell what it counts. The card's own header (Home's
            `pcardHead`) names the DASHBOARD; this names the specific metric the
            lead chart draws, which is not always the same string. */}
        {title !== undefined && <div className="specPanelCompactTitle">{title}</div>}
        {children}
      </div>
    );
  }
  return (
    <section className={`card specPanel${variant !== undefined ? ` specPanel--${variant}` : ''}`}>
      {(title !== undefined || actions !== undefined) && (
        <div className="specPanelHead">
          {title !== undefined && <h3 className="specPanelTitle">{title}</h3>}
          {actions !== undefined && <div className="specPanelActions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return full.format(value);
  return String(value);
}

/**
 * The colour a KPI figure is drawn in, from the meaning the server assigned it.
 *
 * These are the PALETTE's own hues, not a parallel set. They had drifted into
 * one — the four values here were still the pre-2026-09-01 palette, two
 * generations behind `SERIES`, so a tile and the chart summarising the same
 * measure were painted in visibly different colours. Read from `SERIES` by slot
 * so the next palette change cannot leave them behind again.
 */
/**
 * A KPI figure's colour: what the measure MEANS, or -- only where it means
 * nothing in particular -- what the strip chose.
 *
 * The precedence is `measureColour`'s, applied to a tile instead of a mark, and
 * for the same reason: `tone` is a claim the server made about the number
 * ("this is a warning"), `accent` is how the page arranged its cards. A strip
 * cycling hues so that five tiles read as five subjects must never be able to
 * paint fees-outstanding in the teal it used for headcount.
 *
 * `neutral` is the one tone with nothing to lose. It is not a judgement the
 * server made; it is the absence of one -- services/home.ts sets it on every
 * tile in the Dashboard strip precisely because there is no threshold at which
 * a student count is good or bad news. Colouring those by subject adds a
 * distinction where there was none, and removes none.
 */
function kpiColour(tone: KpiWidget['tone'], accent: ChartAccent | undefined): string {
  if (tone !== undefined && tone !== 'neutral') return toneColour(tone);
  return accent === undefined ? toneColour(tone) : ACCENT_COLOUR[accent];
}

/** A hue's three mark stops as a CSS gradient — the SVG wash, for a DOM element. */
function gradientCss(colour: string): string {
  const ramp = markStops(colour);
  return `linear-gradient(180deg, ${ramp.lit}, ${ramp.base} 55%, ${ramp.deep})`;
}

function toneColour(tone: KpiWidget['tone']): string {
  switch (tone) {
    case 'warning':
      return SERIES[2] ?? SERIES[0];
    case 'negative':
      return SERIES[3] ?? SERIES[0];
    case 'positive':
      return SERIES[1] ?? SERIES[0];
    default:
      return SERIES[0];
  }
}

/**
 * Dispatch on the discriminant. The union is closed, so this is exhaustive.
 * `compact` only ever reaches a chart branch (bar/line/donut) — it means
 * "card-sized, chrome dropped" (Home preview cards), which a KPI tile or a
 * table does not have a smaller form of. (A `hero` flag sat beside it until
 * 2026-09-01, naming the headline tile in a KPI row; every tile is one size
 * now, so the strip needs no per-tile prop at all — see `KpiTile`.)
 */
export function WidgetView({
  widget,
  compact,
  accent,
  actions,
  onDrill,
}: {
  widget: Widget;
  compact?: boolean | undefined;
  /**
   * Single-series colour for a bar/line widget, and a NEUTRAL KPI tile's hue —
   * see `ChartAccent` and `kpiColour`. Still ignored by donut and table: a donut
   * is already multi-colour by category, and a table has no mark to paint.
   *
   * A KPI honours it only where `tone` is neutral, i.e. where the server made no
   * claim about the number; a warning or negative tile keeps the colour its
   * meaning earned. That is the same precedence `measureColour` applies to a
   * chart, and it is what lets a strip read as five subjects without any tile
   * being able to lie about whether its figure is good news.
   */
  accent?: ChartAccent | undefined;
  /** Platform chrome beside the panel title — see `Panel`'s doc comment. Never offered to a KPI tile, which has no panel head to hold it. */
  actions?: ReactNode | undefined;
  /**
   * Drill clicks (ADR-020). Taken by the `bar` and `line` branches, which are
   * the two cartesian charts a drill LEVEL may be drawn as (docs/06 §4.1's
   * per-level `chart`, and the orchestrator's `DrillChart`).
   *
   * `donut` deliberately does not take it: a pie has no category axis to click,
   * which is exactly why a donut is only ever offered for a LEAF level, where
   * there is nothing below to drill into. `table` and `kpi` are not levels.
   */
  onDrill?: DrillHandler | undefined;
}): ReactElement {
  switch (widget.type) {
    case 'kpi':
      return <KpiTile widget={widget} accent={accent} />;
    case 'bar':
      return (
        <BarPanel
          widget={widget}
          compact={compact}
          accent={accent}
          actions={actions}
          onDrill={onDrill}
        />
      );
    case 'line':
      return (
        <LinePanel
          widget={widget}
          compact={compact}
          accent={accent}
          actions={actions}
          onDrill={onDrill}
        />
      );
    case 'donut':
      return <DonutPanel widget={widget} compact={compact} actions={actions} />;
    case 'table':
      return <TablePanel widget={widget} actions={actions} />;
  }
}

/**
 * Validate-then-render for exactly ONE untrusted widget, the same contract
 * `ChartSpecView` applies to a whole spec (CODING_GUIDELINES §10) — for a
 * caller that has a single widget rather than a full report, e.g. Home's
 * per-dashboard preview cards. Never skip straight to `WidgetView` with an
 * unvalidated widget; that would make this the one rendering path in the
 * product whose safety depends on the honesty of whoever built the object.
 */
export function WidgetSpecView({
  widget,
  compact,
  accent,
  onDrill,
}: {
  widget: unknown;
  compact?: boolean | undefined;
  accent?: ChartAccent | undefined;
  /**
   * Drill clicks (ADR-020), forwarded to `WidgetView` exactly as `ChartSpecView`
   * forwards them for a whole spec. Added for the Dashboard grid, whose cards
   * each hold ONE widget and are drilled in place — before this, a single-widget
   * caller could render a chart the spec marked `drillable` and then silently
   * drop every click on it, which is the affordance lying about itself.
   *
   * Still nothing prints: a drilled level is reached by clicking, and the PDF
   * path passes no handler, so the hint and the pointer cursor stay off paper
   * for free.
   */
  onDrill?: DrillHandler | undefined;
}): ReactElement {
  const parsed = widgetSchema.safeParse(widget);
  if (!parsed.success) {
    return <div className="notice">This could not be displayed because its definition is not valid.</div>;
  }
  return (
    <WidgetView
      widget={parsed.data}
      compact={compact}
      accent={accent}
      onDrill={onDrill}
    />
  );
}
