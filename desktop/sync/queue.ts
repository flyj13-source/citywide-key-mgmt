import path from 'path';

// The embedded backend is already loaded in this process; requiring its compiled
// modules reuses the same SQLite singleton (no second DB handle).
function backend(dir: string, mod: string): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(path.join(dir, mod));
}

export interface SyncHelpers {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  pendingCount(): number;
  pendingWrites(): Array<{ id: number; method: string; endpoint: string; payload: string | null }>;
  markSynced(id: number): void;
  upsertRows(table: string, rows: any[]): void;
  auditConflict(endpoint: string, detail: string): void;
  auditSyncError(detail: string): void;
}

export function loadSyncHelpers(backendDir: string): SyncHelpers {
  const sq = backend(backendDir, 'lib/syncQueue.js');
  const db = backend(backendDir, 'lib/db.js').default;

  const columnCache = new Map<string, string[]>();
  function columnsOf(table: string): string[] {
    if (!columnCache.has(table)) {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c: any) => c.name);
      columnCache.set(table, cols);
    }
    return columnCache.get(table)!;
  }

  function upsertRows(table: string, rows: any[]) {
    const cols = columnsOf(table);
    db.exec('BEGIN');
    try {
      for (const row of rows) {
        const keys = Object.keys(row).filter((k) => cols.includes(k));
        if (!keys.includes('id')) continue; // upsert by id only
        const placeholders = keys.map(() => '?').join(', ');
        const stmt = db.prepare(
          `INSERT OR REPLACE INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`
        );
        stmt.run(...keys.map((k) => normalize(row[k])));
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  function auditConflict(endpoint: string, detail: string) {
    db.prepare(
      'INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)'
    ).run('sync_conflict', null, null, 'Sync', JSON.stringify({ endpoint, detail: detail.slice(0, 300) }));
  }

  function auditSyncError(detail: string) {
    db.prepare(
      'INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)'
    ).run('sync_failed', null, null, 'Sync', JSON.stringify({ detail: detail.slice(0, 300) }));
  }

  return {
    getMeta: sq.getMeta,
    setMeta: sq.setMeta,
    pendingCount: sq.pendingCount,
    pendingWrites: sq.pendingWrites,
    markSynced: sq.markSynced,
    upsertRows,
    auditConflict,
    auditSyncError,
  };
}

// SQLite (node:sqlite) accepts only null/number/bigint/string/Buffer — coerce
// booleans and nested objects that may arrive from the JSON API.
function normalize(v: any): any {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

export interface PushOptions {
  remote: string;
  token: string;
  backendDir: string;
}

/**
 * Replay queued local mutations against Render in order.
 *  - 2xx           → mark synced.
 *  - 4xx (conflict)→ audit 'sync_conflict', mark synced (last-write-wins; can't
 *                    succeed on retry).
 *  - 5xx / network → audit 'sync_conflict', stop the pass, leave queued to retry.
 */
export async function pushQueue({ remote, token, backendDir }: PushOptions): Promise<number> {
  const helpers = loadSyncHelpers(backendDir);
  const pending = helpers.pendingWrites();
  let pushed = 0;

  for (const row of pending) {
    let res: Response;
    try {
      res = await fetch(`${remote}${row.endpoint}`, {
        method: row.method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: row.method === 'GET' ? undefined : row.payload ?? '{}',
      });
    } catch (err: any) {
      helpers.auditConflict(row.endpoint, `network: ${err?.message ?? err}`);
      break; // transient — retry the rest next cycle
    }

    if (res.ok) {
      helpers.markSynced(row.id);
      pushed++;
      continue;
    }

    const detail = await res.text().catch(() => res.statusText);
    helpers.auditConflict(row.endpoint, `${res.status}: ${detail}`);
    if (res.status >= 400 && res.status < 500) {
      helpers.markSynced(row.id); // conflict resolved (server rejected) — don't loop
      continue;
    }
    break; // 5xx — stop, keep queued
  }

  return pushed;
}
