import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Must match SPA_ORIGIN in the orchestrator's config: its CORS allowlist
    // names exactly one origin, so a mismatch fails visibly rather than
    // silently opening the API to any site.
    port: 5174,
    strictPort: true,
  },
});
