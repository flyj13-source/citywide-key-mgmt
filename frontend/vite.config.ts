import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'child_process';

// ── Build marker ─────────────────────────────────────────────────────────────
// The frontend is a SEPARATE Render static service from the backend, so the two
// can drift: a stale bundle renders old UI against a fully migrated API and
// looks like a backend bug. Stamping the commit into the HTML makes staleness
// detectable with one unauthenticated fetch:
//
//   curl -s https://<frontend>/ | grep build-commit
//
// Render injects RENDER_GIT_COMMIT at build time; git is the local fallback.
function buildCommit(): string {
  const env = process.env.RENDER_GIT_COMMIT || process.env.VITE_BUILD_COMMIT || process.env.GIT_COMMIT;
  if (env) return env;
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig(() => {
  const commit = buildCommit();
  const builtAt = new Date().toISOString();

  return {
    plugins: [
      react(),
      {
        name: 'cw-build-marker',
        transformIndexHtml(html: string) {
          return html
            .replace('%BUILD_COMMIT%', commit)
            .replace('%BUILD_AT%', builtAt);
        },
      },
    ],
    define: {
      __BUILD_COMMIT__: JSON.stringify(commit),
      __BUILD_AT__: JSON.stringify(builtAt),
    },
    server: {
      port: 5173,
      // Local dev proxy — forwards /api/* and /uploads/* to the Express backend.
      // In production (Render), VITE_API_URL points directly to the backend
      // service so no proxy is needed.
      proxy: {
        '/api': { target: 'http://localhost:3001', changeOrigin: true },
        '/uploads': { target: 'http://localhost:3001', changeOrigin: true },
      },
    },
  };
});
