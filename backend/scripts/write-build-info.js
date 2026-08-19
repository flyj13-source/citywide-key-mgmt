// Writes dist/build-info.json at build time so the running process can always
// report the commit it was built from, even if RENDER_GIT_COMMIT is absent at
// runtime. Never fails the build — a missing commit degrades to null.
const fs = require('fs');
const path = require('path');

const commit =
  process.env.RENDER_GIT_COMMIT ||
  process.env.GIT_COMMIT ||
  (() => {
    try {
      return require('child_process').execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim();
    } catch { return null; }
  })();

const dist = path.join(__dirname, '..', 'dist');
try {
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(
    path.join(dist, 'build-info.json'),
    JSON.stringify({ commit: commit || null, builtAt: new Date().toISOString() }, null, 2),
  );
  console.log(`[build-info] commit=${commit || 'unknown'}`);
} catch (err) {
  console.warn('[build-info] could not write build-info.json:', err.message);
}
