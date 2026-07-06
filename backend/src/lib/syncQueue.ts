import { Request, Response, NextFunction } from 'express';
import db from './db';

/**
 * Desktop write-path interceptor.
 *
 * All local mutations (check-out/in, add account, vault add, contractor invite,
 * …) hit the embedded backend and are written to the local SQLite immediately —
 * the UI never blocks on the network. This middleware additionally records each
 * *successful* mutation into `sync_queue` so the sync engine can replay it
 * against the Render backend when connectivity returns.
 *
 * Reads (GET) and endpoints that are meaningless to replay (auth, claude,
 * reports/exports, contractor PDF) are skipped.
 */

const REPLAYABLE = /^\/(accounts|assignments|vault|contractors|staff)/;
const SKIP = /^\/(auth|claude|health|reports)/;

export function enqueueMiddleware(req: Request, res: Response, next: NextFunction) {
  const method = req.method.toUpperCase();
  const isMutation = method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';

  if (!isMutation || SKIP.test(req.path) || !REPLAYABLE.test(req.path)) {
    return next();
  }

  res.on('finish', () => {
    // Only queue writes that the local DB actually accepted.
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    try {
      db.prepare(
        'INSERT INTO sync_queue (method, endpoint, payload) VALUES (?, ?, ?)'
      ).run(method, req.originalUrl, JSON.stringify(req.body ?? {}));
    } catch (err) {
      console.error('[syncQueue] failed to enqueue mutation', err);
    }
  });

  next();
}

export interface SyncRow {
  id: number;
  method: string;
  endpoint: string;
  payload: string | null;
  created_at: string;
  synced_at: string | null;
}

/** Pending (not-yet-pushed) mutations, oldest first. */
export function pendingWrites(): SyncRow[] {
  return (db
    .prepare('SELECT * FROM sync_queue WHERE synced_at IS NULL ORDER BY id ASC')
    .all() as any[]).map((r) => Object.assign({}, r) as SyncRow);
}

export function markSynced(id: number) {
  db.prepare('UPDATE sync_queue SET synced_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
}

export function pendingCount(): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM sync_queue WHERE synced_at IS NULL').get() as any;
  return Object.assign({}, row).c as number;
}

export function getMeta(key: string): string | null {
  const row = db.prepare('SELECT value FROM sync_meta WHERE key = ?').get(key) as any;
  return row ? (Object.assign({}, row).value as string) : null;
}

export function setMeta(key: string, value: string) {
  db.prepare(
    'INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}
