// ── Migrating the single door/alarm pair into access_codes ───────────────────
// Each account row could hold one door code and one alarm code. A client really
// has many labeled codes, so those two move into access_codes as the first two
// rows for that client.
//
// THE CIPHERTEXT IS COPIED VERBATIM. It is not decrypted and re-encrypted: a
// migration that round-trips every secret in the database would put all of them
// in process memory at once, and would silently destroy any row whose key no
// longer matches instead of leaving it alone to be investigated. Copying the
// (ciphertext, iv) pair preserves both the value and the failure mode.
//
// The old accounts columns are deliberately LEFT IN PLACE. Reads go to
// access_codes from here on, but dropping the source of a migration in the same
// change that introduces it leaves nothing to compare against if it went wrong.
//
// Guarded by a settings key so it runs exactly once: after it, a migrated code
// can be edited or archived, and a second pass would resurrect the original.

import db from './db';
import { getSetting, setSetting } from './settings';

const APPLIED_KEY = 'access_codes.migrated_from_accounts_at';

export interface AccessCodeMigrationResult {
  applied: boolean;
  reason?: string;
  door: number;
  alarm: number;
  total: number;
  /** Rows whose ciphertext was present but whose iv was not, so were skipped. */
  incomplete: number;
}

export function migrateAccountCodesToAccessCodes(actor = 'System'): AccessCodeMigrationResult {
  const empty = { door: 0, alarm: 0, total: 0, incomplete: 0 };
  if (getSetting(APPLIED_KEY)) {
    return { applied: false, reason: 'already applied', ...empty };
  }

  const insert = db.prepare(`
    INSERT INTO access_codes
      (account_id, code_type, custom_label, code_encrypted, code_iv, notes,
       created_by, created_at, is_test, archived)
    VALUES (?, ?, NULL, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, 0)
  `);

  // One pass per source column: a client can legitimately have both, and each
  // becomes its own labeled row.
  const sources: { column: string; ivColumn: string; type: string; label: string }[] = [
    { column: 'door_code_encrypted', ivColumn: 'door_code_iv', type: 'front_door', label: 'door code' },
    { column: 'alarm_code_encrypted', ivColumn: 'alarm_code_iv', type: 'alarm', label: 'alarm code' },
  ];

  const counts: Record<string, number> = { front_door: 0, alarm: 0 };
  let incomplete = 0;

  db.exec('BEGIN');
  try {
    for (const s of sources) {
      const rows = (db.prepare(`
        SELECT id, ic_company_name, ${s.column} AS enc, ${s.ivColumn} AS iv, COALESCE(is_test, 0) AS is_test
          FROM accounts
         WHERE ${s.column} IS NOT NULL AND TRIM(${s.column}) <> ''
      `).all() as any[]).map((r) => Object.assign({}, r));

      for (const r of rows) {
        // An iv-less ciphertext cannot be decrypted by anyone, so carrying it
        // forward would create a row that looks like a code and is not one.
        if (!r.iv || String(r.iv).trim() === '') { incomplete++; continue; }
        insert.run(
          r.id, s.type, r.enc, r.iv,
          `Migrated from the client's ${s.label} on ${new Date().toISOString().slice(0, 10)}`,
          actor, Number(r.is_test) === 1 ? 1 : 0,
        );
        counts[s.type]++;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  setSetting(APPLIED_KEY, new Date().toISOString(), actor);

  return {
    applied: true,
    door: counts.front_door,
    alarm: counts.alarm,
    total: counts.front_door + counts.alarm,
    incomplete,
  };
}

/** For the diagnostics endpoint: when the migration ran, if it has. */
export function accessCodeMigrationAppliedAt(): string | null {
  return getSetting(APPLIED_KEY);
}
