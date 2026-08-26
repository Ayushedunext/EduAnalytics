/**
 * Per-widget "⧉ Clone" — docs/06 §3's clone-to-edit model, scoped to ONE
 * chart on a predefined dashboard instead of the whole page.
 *
 * Rendered via `ChartSpecView`'s `renderWidgetActions` (packages/chart-spec),
 * which is platform chrome, not part of the chart-spec contract (ADR-015) —
 * this component decides what to show from the DASHBOARD's own knowledge of
 * which widgets are cloneable (`DashboardPage.tsx`'s `WIDGET_CLONE_CONFIG`),
 * never from anything inside the spec itself.
 *
 * A small inline popover, not a modal: consistent with this screen's existing
 * "prompt for a name, then call the API" clone flow (DashboardPage.tsx's
 * page-level ⧉ Clone button), just with the extra field a bucket-aware chart
 * needs. `window.prompt` is fine for one text field; a bucket choice needs a
 * real control, which is the whole reason this exists instead of reusing that
 * flow.
 */

import { useState } from 'react';
import { ApiFailure, cloneReport } from '../api/client';

const BUCKET_LABELS: Record<'week' | 'month' | 'quarter' | 'year', string> = {
  week: 'Week',
  month: 'Month',
  quarter: 'Quarter',
  year: 'Year',
};

interface Props {
  readonly baseReportId: string;
  readonly widgetId: string;
  readonly widgetTitle: string;
  readonly academicYear: string;
  readonly schoolIds: readonly string[];
  /** Present only for a widget `WIDGET_CLONE_CONFIG` marks bucketable. */
  readonly bucketOptions?: readonly ('week' | 'month' | 'quarter' | 'year')[] | undefined;
  readonly onCloned: (id: string) => void;
}

export function WidgetCloneButton({
  baseReportId,
  widgetId,
  widgetTitle,
  academicYear,
  schoolIds,
  bucketOptions,
  onCloned,
}: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(`${widgetTitle} (copy)`);
  const [year, setYear] = useState(academicYear);
  const [bucket, setBucket] = useState<'week' | 'month' | 'quarter' | 'year'>('month');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="widgetCloneWrap">
      <button
        type="button"
        className="widgetCloneBtn"
        title={`Clone "${widgetTitle}" on its own into My Reports`}
        aria-expanded={open}
        onClick={() => {
          setError(null);
          setOpen((v) => !v);
        }}
      >
        ⧉
      </button>

      {open && (
        <div className="widgetClonePopover" role="dialog" aria-label={`Clone ${widgetTitle}`}>
          <div className="widgetClonePopoverTitle">Clone this chart</div>
          <p className="widgetClonePopoverHint">
            Saves just &ldquo;{widgetTitle}&rdquo; to My Reports, editable on its own.
          </p>

          {error !== null && <div className="widgetClonePopoverError">{error}</div>}

          <label className="widgetCloneField">
            Name
            <input value={name} onChange={(e) => { setName(e.target.value); }} />
          </label>

          <label className="widgetCloneField">
            Academic year
            <input value={year} onChange={(e) => { setYear(e.target.value); }} placeholder="2026-27" />
          </label>

          {bucketOptions !== undefined && bucketOptions.length > 0 && (
            <label className="widgetCloneField">
              Group by
              <select value={bucket} onChange={(e) => { setBucket(e.target.value as typeof bucket); }}>
                {bucketOptions.map((b) => (
                  <option key={b} value={b}>
                    {BUCKET_LABELS[b]}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="widgetClonePopoverActions">
            <button type="button" className="chipbtn" onClick={() => { setOpen(false); }} disabled={saving}>
              Cancel
            </button>
            <button
              type="button"
              className="chipbtn chipbtn--ai"
              disabled={saving || name.trim() === '' || year.trim() === ''}
              onClick={() => {
                setSaving(true);
                setError(null);
                cloneReport({
                  base_report_id: baseReportId,
                  name: name.trim(),
                  academic_year: year.trim(),
                  school_ids: schoolIds,
                  widget_id: widgetId,
                  ...(bucketOptions !== undefined && bucketOptions.length > 0 && bucket !== 'month'
                    ? { bucket }
                    : {}),
                })
                  .then((cloned) => {
                    setOpen(false);
                    onCloned(cloned.id);
                  })
                  .catch((err: unknown) => {
                    setError(err instanceof ApiFailure ? err.message : 'Could not clone this chart.');
                  })
                  .finally(() => { setSaving(false); });
              }}
            >
              {saving ? 'Cloning…' : 'Clone'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
