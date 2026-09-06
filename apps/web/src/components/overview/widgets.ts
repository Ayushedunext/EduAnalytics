/**
 * Reading a slot's widgets on the client.
 *
 * [MANDATORY] CODING_GUIDELINES §10: a widget is `unknown` until it has been
 * validated against the chart-spec schema. Every helper here parses first and
 * hands back a typed widget or nothing — a card never reads a field off an
 * object that has not passed the contract, however trusted the path.
 */

import {
  widgetSchema,
  type DonutWidget,
  type KpiWidget,
  type LineWidget,
  type BarWidget,
  type TableWidget,
  type Widget,
} from '@sap/chart-spec';

export function validWidgets(widgets: readonly unknown[]): Widget[] {
  const out: Widget[] = [];
  for (const raw of widgets) {
    const parsed = widgetSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export function kpiOf(widgets: readonly Widget[], id: string): KpiWidget | undefined {
  return widgets.find((w): w is KpiWidget => w.type === 'kpi' && w.id === id);
}

export function lineOf(widgets: readonly Widget[], id: string): LineWidget | undefined {
  return widgets.find((w): w is LineWidget => w.type === 'line' && w.id === id);
}

export function barOf(widgets: readonly Widget[], id: string): BarWidget | undefined {
  return widgets.find((w): w is BarWidget => w.type === 'bar' && w.id === id);
}

export function donutOf(widgets: readonly Widget[], id: string): DonutWidget | undefined {
  return widgets.find((w): w is DonutWidget => w.type === 'donut' && w.id === id);
}

export function tableOf(widgets: readonly Widget[], id: string): TableWidget | undefined {
  return widgets.find((w): w is TableWidget => w.type === 'table' && w.id === id);
}

/**
 * A KPI's share, read back out of the SERVER'S OWN formatted value — a bare
 * percentage and nothing else. The dial and the digits are then the same
 * number drawn twice; anything that is not a rate has no dial.
 */
export function rateOf(kpi: KpiWidget | undefined): number | null {
  if (kpi === undefined) return null;
  const match = /^(\d+(?:\.\d+)?)\s*%$/.exec(kpi.value.trim());
  if (match === null) return null;
  const percent = Number(match[1]);
  return Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : null;
}

/** A breakdown part's value, by label. */
export function partOf(kpi: KpiWidget | undefined, labelText: string): string | undefined {
  return kpi?.breakdown?.find((p) => p.label === labelText)?.value;
}

/** Initials for an avatar. A masked name yields a lock glyph rather than "[M". */
export function initialsOf(name: string): string {
  if (name === '[masked]') return '🔒';
  const parts = name.trim().split(/\s+/).filter((p) => p !== '');
  return parts.slice(0, 2).map((p) => p.charAt(0)).join('').toUpperCase() || '—';
}
