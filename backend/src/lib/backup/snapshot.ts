import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';

// The tables whose row counts define "the data survived". accounts is the
// headline number Cara cares about; the rest round out the integrity check.
export const COUNTED_TABLES = ['accounts', 'managers', 'key_assignments', 'staff_key_holders', 'audit_log'];

export interface SnapshotResult {
  path: string;
  sizeBytes: number;
  rowCounts: Record<string, number>;
  accounts: number;
}

/**
 * Create a consistent, defragmented copy of the live DB WITHOUT holding a write
 * lock, using SQLite's `VACUUM INTO`. On a WAL database this reads a consistent
 * snapshot while writers continue against the WAL — so it is safe to run against
 * the live production file with the web service serving traffic.
 *
 * `destPath` must NOT already exist (VACUUM INTO refuses to overwrite).
 */
export function createSnapshot(dbPath: string, destPath: string): SnapshotResult {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Live DB not found at ${dbPath} — nothing to back up.`);
  }
  if (fs.existsSync(destPath)) fs.rmSync(destPath);

  // Dedicated read connection so we never interfere with the app's connection
  // or leave one open.
  const src = new DatabaseSync(dbPath);
  try {
    // VACUUM INTO produces a single, fully consistent file (no -wal/-shm needed).
    src.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }

  return { path: destPath, sizeBytes: fs.statSync(destPath).size, ...countAndVerify(destPath) };
}

/** Open a DB file, run PRAGMA integrity_check, and count the known tables.
 *  Throws on corruption. Used both right after snapshotting and during restore
 *  verification. */
export function countAndVerify(dbFile: string): { rowCounts: Record<string, number>; accounts: number } {
  const db = new DatabaseSync(dbFile);
  try {
    const integrity = Object.assign({}, db.prepare('PRAGMA integrity_check').get()) as any;
    const verdict = integrity.integrity_check ?? Object.values(integrity)[0];
    if (verdict !== 'ok') {
      throw new Error(`integrity_check failed on ${dbFile}: ${verdict}`);
    }
    const present = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(
        (r) => Object.assign({}, r).name as string
      )
    );
    const rowCounts: Record<string, number> = {};
    for (const t of COUNTED_TABLES) {
      if (!present.has(t)) continue;
      const row = Object.assign({}, db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get()) as any;
      rowCounts[t] = row.c as number;
    }
    return { rowCounts, accounts: rowCounts.accounts ?? 0 };
  } finally {
    db.close();
  }
}

/** A stable spot-check fingerprint: the alphabetically-first customer's key
 *  identity + grid column totals. Compared live-vs-restored to prove the
 *  restore is not just row-count-equal but content-equal. */
export function spotCheck(dbFile: string): Record<string, any> | null {
  const db = new DatabaseSync(dbFile);
  try {
    const row = db
      .prepare(
        `SELECT ic_company_name, bc_client_number, am_keys, ccm_keys, contractor_keys, office_keys_held
         FROM accounts
         WHERE record_type = 'customer'
         ORDER BY ic_company_name ASC, id ASC
         LIMIT 1`
      )
      .get();
    return row ? Object.assign({}, row) : null;
  } finally {
    db.close();
  }
}
