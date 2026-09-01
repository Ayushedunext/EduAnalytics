import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  /**
   * Two entry points, one bundle set. `print.html` is the surface Puppeteer
   * loads (ADR-021) -- it must be BUILT and served like the app, because it
   * imports the same renderer and the same design tokens. A separate build
   * would be a second copy of the visual language and the first place the PDF
   * would drift from the screen.
   */
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        print: fileURLToPath(new URL('print.html', import.meta.url)),
      },
    },
  },
  server: {
    // Must match SPA_ORIGIN in the orchestrator's config: its CORS allowlist
    // names exactly one origin, so a mismatch fails visibly rather than
    // silently opening the API to any site.
    port: 8080,
    strictPort: true,
  },
});
