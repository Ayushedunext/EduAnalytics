/**
 * The bar above the Dashboard: which layout, which theme colour.
 *
 * Both controls change PRESENTATION only (theme/dashboardTheme.ts). Nothing here
 * touches scope, the year, or a single figure — a reader picking amber is
 * choosing paint, and the numbers under it are the numbers the server sent.
 */

import type { ReactElement } from 'react';
import { LAYOUTS, THEME_SWATCHES, type DashboardTheme } from '../theme/dashboardTheme';

export function ThemeControls({ theme }: { theme: DashboardTheme }): ReactElement {
  return (
    <div className="thControls">
      <div>
        <span className="thLbl">Layout</span>
        <span className="thSeg" role="group" aria-label="Dashboard layout">
          {LAYOUTS.map((layout) => (
            <button
              key={layout.id}
              type="button"
              className={theme.layout === layout.id ? 'on' : ''}
              aria-pressed={theme.layout === layout.id}
              onClick={() => { theme.setLayout(layout.id); }}
            >
              <span className="sw" style={{ background: layout.swatch }} />
              {layout.label}
            </button>
          ))}
        </span>
      </div>
      <div className="thColour">
        <span className="thLbl">Theme colour</span>
        <span className="thSwatches" role="group" aria-label="Theme colour">
          {THEME_SWATCHES.map((hex) => (
            <button
              key={hex}
              type="button"
              style={{ background: hex }}
              title={hex}
              aria-label={`Theme ${hex}`}
              aria-pressed={theme.custom === hex}
              className={theme.custom === hex ? 'on' : ''}
              onClick={() => { theme.setCustom(hex); }}
            />
          ))}
        </span>
        <span className="thPicker" title="Pick any colour">
          <input
            type="color"
            value={theme.custom ?? theme.palette.colours[0] ?? '#1fa0e8'}
            aria-label="Pick theme colour"
            onChange={(event) => { theme.setCustom(event.target.value); }}
          />
        </span>
        <button type="button" className="thReset" onClick={() => { theme.setCustom(null); }}>
          Reset to original
        </button>
      </div>
      <span className="thHint">
        Each chart has its own type menu (bar · line · area · donut · pie · spiral · radar).
      </span>
    </div>
  );
}
