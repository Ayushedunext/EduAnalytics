/**
 * Renders a whole chart-spec.
 *
 * Contract source: ADR-015 (spec-driven rendering) · ADR-021 (the PDF renderer
 * reads the identical spec) · docs/10 §3.
 *
 * -- The spec is validated before it is drawn --------------------------------
 * [MANDATORY] CODING_GUIDELINES §10: "a chart-spec from the model is parsed and
 * schema-validated before it touches the renderer or storage; invalid spec →
 * structured error, never partial render."
 *
 * This component validates even when the spec came from the platform's own
 * predefined path, where no model was involved. That is deliberate: the
 * renderer's contract is the SCHEMA, not the good intentions of whoever built
 * the object. Validating only AI-authored specs would mean the safety property
 * depends on knowing the provenance of every spec that ever reaches here — and
 * the day an AI spec arrives through a path someone believed was predefined,
 * the check would not be there.
 *
 * "Never a partial render" is why a bad spec produces a message instead of the
 * widgets that happened to parse: half a dashboard is indistinguishable from a
 * whole one to a reader who does not know what was meant to be there.
 */

import type { ReactElement } from 'react';
import { chartSpecSchema, type ChartSpec } from '../spec.js';
import { WidgetView } from './widgets.js';

export interface ChartSpecViewProps {
  /** Unknown on purpose — see the validation note above. */
  readonly spec: unknown;
  /** Rendered above the widgets; the caller owns page chrome. */
  readonly header?: ReactElement;
}

export function ChartSpecView({ spec, header }: ChartSpecViewProps): ReactElement {
  const parsed = chartSpecSchema.safeParse(spec);

  if (!parsed.success) {
    return (
      <div className="notice">
        This report could not be displayed because its definition is not valid.
      </div>
    );
  }

  const valid: ChartSpec = parsed.data;
  const kpis = valid.widgets.filter((w) => w.type === 'kpi');
  const panels = valid.widgets.filter((w) => w.type !== 'kpi');

  return (
    <div>
      {header}

      {valid.narrative !== undefined && <p className="specNarrative">{valid.narrative}</p>}

      {/* KPI tiles read as a row; everything else is a panel. Keeping the
          distinction here rather than in each dashboard is what makes every
          report in the product lay out the same way (ADR-016). */}
      {kpis.length > 0 && (
        <div className="kpis mb-4">
          {kpis.map((widget) => (
            <WidgetView key={widget.id} widget={widget} />
          ))}
        </div>
      )}

      <div className="specPanels">
        {panels.map((widget) => (
          <WidgetView key={widget.id} widget={widget} />
        ))}
      </div>
    </div>
  );
}
