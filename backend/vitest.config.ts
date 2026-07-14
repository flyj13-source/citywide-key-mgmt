import { defineConfig } from 'vitest/config';

// node:sqlite is a very new builtin. Vite/vite-node strips the `node:` prefix,
// finds isBuiltin('sqlite') === false, and fails to load it. Redirect the import
// to a virtual module that pulls the real builtin in via a runtime require()
// (which is not subject to Vite's static resolution).
const VIRTUAL = '\0virtual:node-sqlite';
const nodeSqliteShim = {
  name: 'node-sqlite-shim',
  enforce: 'pre' as const,
  resolveId(id: string) {
    if (id === 'node:sqlite' || id === 'sqlite') return VIRTUAL;
    return null;
  },
  load(id: string) {
    if (id === VIRTUAL) {
      return [
        "import { createRequire } from 'node:module';",
        'const require = createRequire(process.cwd() + "/");',
        "const sqlite = require('node:sqlite');",
        'export const DatabaseSync = sqlite.DatabaseSync;',
        'export default sqlite;',
      ].join('\n');
    }
    return null;
  },
};

export default defineConfig({
  plugins: [nodeSqliteShim],
  test: {
    include: ['tests/**/*.test.ts'],
    // Suite shares one temp DB per file — run files sequentially so the
    // synchronous node:sqlite connections don't race.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
