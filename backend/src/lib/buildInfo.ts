import fs from 'fs';
import path from 'path';

// ── Which commit is actually running ─────────────────────────────────────────
// The root cause of every "which commit is live?" argument: nothing in the
// running process reliably knew. Two sources, in order:
//
//   1. process.env.RENDER_GIT_COMMIT — Render injects this automatically into
//      every service at runtime.
//   2. build-info.json — written by the build command from the same variable
//      and shipped inside dist/. This survives even if the runtime environment
//      loses the var (a shell/Docker entrypoint that scrubs env, a service
//      created before the var existed, or a local `node dist/index.js`).
//
// NOTE: RENDER_GIT_COMMIT is deliberately NOT declared in render.yaml. Declaring
// it there as `sync: false` would create an EMPTY dashboard-managed variable
// that SHADOWS the value Render injects automatically — the exact opposite of
// the intent. Baking it at build time is the safe way to pin it.

export interface BuildInfo {
  commit: string | null;
  commitShort: string | null;
  builtAt: string | null;
  source: 'env' | 'build-file' | 'unknown';
}

const CANDIDATES = [
  path.join(__dirname, '../build-info.json'),      // dist/lib → dist/build-info.json
  path.join(__dirname, '../../build-info.json'),   // dist/lib → build-info.json
  path.join(process.cwd(), 'dist/build-info.json'),
  path.join(process.cwd(), 'build-info.json'),
];

let cached: BuildInfo | undefined;

export function buildInfo(): BuildInfo {
  if (cached) return cached;

  const envCommit = process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null;
  if (envCommit) {
    cached = {
      commit: envCommit,
      commitShort: envCommit.slice(0, 7),
      builtAt: readFile()?.builtAt ?? null,
      source: 'env',
    };
    return cached;
  }

  const file = readFile();
  if (file?.commit) {
    cached = {
      commit: file.commit,
      commitShort: String(file.commit).slice(0, 7),
      builtAt: file.builtAt ?? null,
      source: 'build-file',
    };
    return cached;
  }

  cached = { commit: null, commitShort: null, builtAt: null, source: 'unknown' };
  return cached;
}

function readFile(): { commit?: string; builtAt?: string } | null {
  for (const p of CANDIDATES) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { /* try the next candidate */ }
  }
  return null;
}
