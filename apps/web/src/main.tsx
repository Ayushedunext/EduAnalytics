import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChartMotionProvider } from '@sap/chart-spec/react';
import { App } from './App';
import './tokens.css';

const root = document.getElementById('root');
if (root === null) throw new Error('#root not found');

/**
 * The one place chart animation is turned on.
 *
 * `print.tsx` deliberately does NOT do this, which is what keeps the PDF
 * surface still (ADR-021 — see ChartMotion.tsx). Respecting
 * `prefers-reduced-motion` here rather than inside the renderer keeps the
 * accessibility decision next to the other one about this document, and
 * matches how `tokens.css` already gates its entrance fade: motion is
 * declared for `no-preference`, never cancelled afterwards for `reduce`.
 *
 * Read once at startup, not subscribed to: a viewer who changes the OS setting
 * mid-session gets it on the next load, and the alternative — charts silently
 * re-mounting under them to drop an animation — would be the more startling of
 * the two.
 */
const prefersMotion = window.matchMedia('(prefers-reduced-motion: no-preference)').matches;

createRoot(root).render(
  <StrictMode>
    <ChartMotionProvider enabled={prefersMotion}>
      <App />
    </ChartMotionProvider>
  </StrictMode>,
);
