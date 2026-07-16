import { DatabaseSync } from 'node:sqlite';

// One row per backup run — the source of truth for the Settings-screen
// "Last backup" line and the audit trail. Created idempotently so the cron path
// (which opens its own connection) never depends on the web service having
// booted first.
export function ensureBackupTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL,            -- 'ok' | 'failed'
      row_count INTEGER,               -- accounts count (headline number)
      size_bytes INTEGER,              -- encrypted .db artifact size
      destination TEXT,                -- s3 key, or 'local-only'
      filename TEXT,
      duration_ms INTEGER,
      message TEXT,                    -- error text on failure, else NULL
      detail TEXT                      -- JSON: per-table counts, excel key, etc.
    )
  `);
}

export interface BackupRecord {
  status: 'ok' | 'failed';
  rowCount: number | null;
  sizeBytes: number | null;
  destination: string | null;
  filename: string | null;
  durationMs: number;
  message?: string | null;
  detail?: Record<string, any>;
}

export function recordBackup(db: DatabaseSync, rec: BackupRecord): void {
  ensureBackupTable(db);
  db.prepare(
    `INSERT INTO backups (status, row_count, size_bytes, destination, filename, duration_ms, message, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    rec.status,
    rec.rowCount,
    rec.sizeBytes,
    rec.destination,
    rec.filename,
    rec.durationMs,
    rec.message ?? null,
    rec.detail ? JSON.stringify(rec.detail) : null
  );
}

/** Write a System audit_log entry (no request context). Guarded so a missing
 *  audit_log table can never crash a backup. */
export function logSystemAudit(
  db: DatabaseSync,
  action: string,
  metadata: Record<string, any> = {}
): void {
  try {
    db.prepare(
      'INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)'
    ).run(action, null, null, 'System (backup)', JSON.stringify(metadata));
  } catch {
    /* audit_log absent (e.g. isolated test DB) — non-fatal */
  }
}

export interface LatestBackup {
  created_at: string;
  status: string;
  row_count: number | null;
  size_bytes: number | null;
  destination: string | null;
  message: string | null;
}

export function getLatestBackup(db: DatabaseSync): LatestBackup | null {
  ensureBackupTable(db);
  const row = db
    .prepare(
      `SELECT created_at, status, row_count, size_bytes, destination, message
       FROM backups ORDER BY id DESC LIMIT 1`
    )
    .get();
  return row ? (Object.assign({}, row) as unknown as LatestBackup) : null;
}
