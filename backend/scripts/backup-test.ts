/**
 * A backup you've never restored is not a backup.
 *
 *   npm run backup:test
 *
 * Exercises the REAL round-trip end to end, no cloud required:
 *   1. Snapshot the live DB (VACUUM INTO) — same code path as production.
 *   2. Encrypt the snapshot (AES-256-GCM), then decrypt it back.
 *   3. Restore the decrypted bytes to a temp DB, verifying integrity + schema.
 *   4. Assert the restored table row counts EXACTLY match the live DB, and that
 *      a spot-checked record (first customer's identity + key-grid totals) is
 *      byte-identical.
 *   5. Report PASS / FAIL (non-zero exit on FAIL) and clean up temp files.
 *
 * This is the same snapshot/encrypt/decrypt/verify machinery the scheduled
 * backup uses, so a green run proves the production artifact is restorable.
 */
import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveDbPath } from '../src/lib/backup/config';
import { createSnapshot, countAndVerify, spotCheck } from '../src/lib/backup/snapshot';
import { encryptBuffer } from '../src/lib/backup/fileCrypto';
import { restoreFromFile } from '../src/lib/backup/restore';

function pass(msg: string) {
  console.log(`\n\x1b[42m\x1b[30m PASS \x1b[0m ${msg}\n`);
}
function fail(msg: string): never {
  console.error(`\n\x1b[41m\x1b[97m FAIL \x1b[0m ${msg}\n`);
  process.exit(1);
}

(async () => {
  const dbPath = resolveDbPath();
  if (!fs.existsSync(dbPath)) fail(`No live DB at ${dbPath}. Run the app once (seeds a DB) before testing.`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwkm-backuptest-'));
  const snapPath = path.join(tmp, 'snapshot.db');
  const encPath = path.join(tmp, 'snapshot.db.enc');
  const restoredPath = path.join(tmp, 'restored.db');

  try {
    console.log(`Live DB: ${dbPath}`);

    // Live baseline (captured first so we compare against a stable reference).
    const live = countAndVerify(dbPath);
    const liveSpot = spotCheck(dbPath);
    console.log(`Live counts: ${JSON.stringify(live.rowCounts)}`);

    // 1) Snapshot
    const snap = createSnapshot(dbPath, snapPath);
    console.log(`Snapshot:    ${JSON.stringify(snap.rowCounts)}  (${(snap.sizeBytes / 1024).toFixed(1)} KB)`);

    // 2) Encrypt → decrypt happens inside restoreFromFile
    fs.writeFileSync(encPath, encryptBuffer(fs.readFileSync(snapPath)));

    // 3) Restore (decrypt + integrity verify + write)
    const restored = await restoreFromFile(encPath, restoredPath);
    const restoredSpot = spotCheck(restoredPath);
    console.log(`Restored:    ${JSON.stringify(restored.rowCounts)}  (${(restored.sizeBytes / 1024).toFixed(1)} KB)`);

    // 4) Assertions — restored must equal live, table by table.
    const tables = new Set([...Object.keys(live.rowCounts), ...Object.keys(restored.rowCounts)]);
    for (const t of tables) {
      const a = live.rowCounts[t] ?? 0;
      const b = restored.rowCounts[t] ?? 0;
      if (a !== b) fail(`Row-count mismatch on "${t}": live=${a} restored=${b}`);
    }
    if (JSON.stringify(liveSpot) !== JSON.stringify(restoredSpot)) {
      fail(
        `Spot-check record mismatch:\n  live     = ${JSON.stringify(liveSpot)}\n  restored = ${JSON.stringify(
          restoredSpot
        )}`
      );
    }
    if (restored.accounts !== live.accounts) {
      fail(`Accounts mismatch: live=${live.accounts} restored=${restored.accounts}`);
    }

    pass(
      `Restore verified — ${restored.accounts} accounts, ` +
        `${Object.keys(restored.rowCounts).length} tables row-count-equal, spot record identical.`
    );
    console.log(`Spot record: ${JSON.stringify(restoredSpot)}\n`);
  } catch (e: any) {
    fail(e.message);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
