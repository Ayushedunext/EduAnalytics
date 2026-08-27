/**
 * The React rendering surface for chart-spec (ADR-015, CODING_GUIDELINES §18).
 *
 * Exposed on the `./react` subpath so Node services that build specs but never
 * draw them -- the orchestrator, and later the report scheduler -- do not pull
 * React into their dependency graph by importing the contract.
 */

export { ChartSpecView, type ChartSpecViewProps } from './ChartSpecView.js';
export { ChartMotionProvider, useChartMotion, CHART_MOTION_MS } from './ChartMotion.js';
export {
  WidgetView,
  WidgetSpecView,
  KpiTile,
  BarPanel,
  LinePanel,
  DonutPanel,
  TablePanel,
  type ChartAccent,
  type DrillHandler,
  type DrillTarget,
} from './widgets.js';
