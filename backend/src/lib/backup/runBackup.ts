import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  resolveDbPath,
  readS3Config,
  s3ConfigProblems,
  PREFIX_DAILY,
  PREFIX_MONTHLY,
  utcStamp,
  yearMonth,
  failureRecipient,
} from './config';
import { encryptBuffer, assertBackupKey, hasRealBackupKey, ENCRYPTED_EXT } from './fileCrypto';
import { createSnapshot } from './snapshot';
import { buildRegistryWorkbook } from './registryExport';
import { BackupStore } from './storage';
import { pruneRetention } from './retention';
import { recordBackup, logSystemAudit, ensureBackupTable } from './status';
import { createTransport } from '../mailer';

export interface BackupOutcome {
  status: 'ok' | 'failed';
  rowCount: number | null;
  sizeBytes: number | null;
  destination: string | null;
  filename: string | null;
  durationMs: number;
  message?: string;
  detail: Record<string, any>;
}

export interface RunBackupOptions {
  /** Emit progress lines (default: console.log). Pass a no-op to silence. */
  log?: (msg: string) => void;
  /** Override the "now" used for timestamps/monthly detection (tests). */
  now?: Date;
}

/**
 * The full daily backup: snapshot → encrypt → export (xlsx) → upload both to
 * cloud object storage → promote a monthly copy → prune retention → log +
 * audit + (on failure) email. Self-contained: opens its own DB connections so
 * it can be invoked from the web service (which owns the Render disk) OR the
 * CLI. Never throws — every path resolves to a recorded, reported outcome.
 */
export async function runBackup(opts: RunBackupOptions = {}): Promise<BackupOutcome> {
  const log = opts.log || ((m: string) => console.log(m));
  const now = opts.now || new Date();
  const started = Date.now();
  const dbPath = resolveDbPath();
  const detail: Record<string, any> = {};

  // Scratch dir on the same volume for atomic-ish temp writes.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwkm-backup-'));
  const statusDb = new DatabaseSync(dbPath);

  try {
    ensureBackupTable(statusDb);
    assertBackupKey(); // refuse to write a real prod backup with no key
    if (!hasRealBackupKey()) {
      log('⚠️  BACKUP_ENCRYPTION_KEY not set — using the insecure default key (dev/test only).');
    }

    const stamp = utcStamp(now);
    const dbName = `citywide-backup-${stamp}.db`;
    const xlsxName = `citywide-registry-${stamp}.xlsx`;

    // 1) Consistent snapshot (no lock) + integrity + row counts
    log('• Snapshotting live DB (VACUUM INTO)…');
    const snap = createSnapshot(dbPath, path.join(tmp, dbName));
    detail.rowCounts = snap.rowCounts;
    log(`  snapshot ok — accounts=${snap.accounts}, size=${fmtBytes(snap.sizeBytes)}`);

    // 2) Human-readable secondary export
    log('• Building human-readable registry export (.xlsx)…');
    const xlsx = await buildRegistryWorkbook(snap.path);
    detail.exportAccountRows = xlsx.accountRows;

    // 3) Encrypt both artifacts at rest
    log('• Encrypting artifacts (AES-256-GCM)…');
    const dbEnc = encryptBuffer(fs.readFileSync(snap.path));
    const xlsxEnc = encryptBuffer(xlsx.buffer);
    detail.encryptedDbBytes = dbEnc.length;

    // 4) Upload off-disk (skipped when no cloud configured → local-only run)
    const s3cfg = readS3Config();
    let destination = 'local-only';
    let promotedMonthly = false;

    if (s3cfg) {
      const store = new BackupStore(s3cfg);
      const dbKey = `${PREFIX_DAILY}${dbName}${ENCRYPTED_EXT}`;
      const xlsxKey = `${PREFIX_DAILY}${xlsxName}${ENCRYPTED_EXT}`;
      log(`• Uploading to ${s3cfg.bucket} (${s3cfg.endpoint})…`);
      await store.put(dbKey, dbEnc, 'application/octet-stream');
      await store.put(xlsxKey, xlsxEnc, 'application/octet-stream');
      destination = dbKey;
      log(`  uploaded ${dbKey} + ${xlsxKey}`);

      // Monthly promotion: first successful run of a calendar month is copied
      // to monthly/ (robust to a missed 1st-of-month cron run).
      const ym = yearMonth(now);
      const existingMonthly = await store.list(PREFIX_MONTHLY);
      const haveThisMonth = existingMonthly.some((o) => o.key.includes(`-${ym}`));
      if (!haveThisMonth) {
        const mDbKey = `${PREFIX_MONTHLY}citywide-backup-${ym}-${stamp}.db${ENCRYPTED_EXT}`;
        const mXlsxKey = `${PREFIX_MONTHLY}citywide-registry-${ym}-${stamp}.xlsx${ENCRYPTED_EXT}`;
        await store.put(mDbKey, dbEnc, 'application/octet-stream');
        await store.put(mXlsxKey, xlsxEnc, 'application/octet-stream');
        promotedMonthly = true;
        log(`  promoted monthly copy → ${mDbKey}`);
      }

      // 5) Retention prune
      log('• Pruning retention (keep 30 daily / 12 monthly)…');
      const prune = await pruneRetention(store);
      detail.retention = prune;
      log(
        `  kept ${prune.dailyKept} daily / ${prune.monthlyKept} monthly; ` +
          `deleted ${prune.deletedKeys.length} object(s)`
      );
    } else {
      const missing = s3ConfigProblems();
      log(`• Cloud upload skipped — off-disk destination not configured (missing: ${missing.join(', ')}).`);
      detail.cloudSkipped = missing;
    }

    detail.promotedMonthly = promotedMonthly;

    // 6) Success bookkeeping
    const outcome: BackupOutcome = {
      status: 'ok',
      rowCount: snap.accounts,
      sizeBytes: dbEnc.length,
      destination,
      filename: `${dbName}${ENCRYPTED_EXT}`,
      durationMs: Date.now() - started,
      detail,
    };
    recordBackup(statusDb, {
      status: 'ok',
      rowCount: outcome.rowCount,
      sizeBytes: outcome.sizeBytes,
      destination: outcome.destination,
      filename: outcome.filename,
      durationMs: outcome.durationMs,
      detail,
    });
    logSystemAudit(statusDb, 'backup_completed', {
      row_count: outcome.rowCount,
      size_bytes: outcome.sizeBytes,
      destination: outcome.destination,
      duration_ms: outcome.durationMs,
      monthly: promotedMonthly,
    });
    log(`✅ Backup OK in ${outcome.durationMs}ms → ${destination}`);
    return outcome;
  } catch (err: any) {
    const message = err?.message || String(err);
    const outcome: BackupOutcome = {
      status: 'failed',
      rowCount: null,
      sizeBytes: null,
      destination: null,
      filename: null,
      durationMs: Date.now() - started,
      message,
      detail,
    };
    // A silent failure is worse than none: record + audit + email.
    try {
      recordBackup(statusDb, { ...outcome, detail });
      logSystemAudit(statusDb, 'backup_failed', { message, detail });
    } catch (e) {
      log(`⚠️  Could not record failure to DB: ${(e as Error).message}`);
    }
    await notifyFailure(message).catch((e) =>
      log(`⚠️  Failure email could not be sent: ${(e as Error).message}`)
    );
    log(`❌ Backup FAILED: ${message}`);
    return outcome;
  } finally {
    statusDb.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function notifyFailure(message: string): Promise<void> {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return; // SMTP not configured
  const to = failureRecipient();
  const transport = createTransport();
  await transport.sendMail({
    from: `City Wide Key Management <${process.env.SMTP_USER}>`,
    to,
    subject: '[Key Mgmt] ⚠️ Automated backup FAILED',
    html: `
      <h2 style="color:#C0272D">City Wide Boston — Backup Failure</h2>
      <p>The scheduled Key Management database backup did <b>not</b> complete.</p>
      <p><b>Time (UTC):</b> ${new Date().toISOString()}</p>
      <pre style="background:#f4f4f2;padding:12px;border-radius:4px;white-space:pre-wrap">${escapeHtml(
        message
      )}</pre>
      <p style="color:#6b6b68;font-size:12px">Check the Render cron logs and the Settings → Backups panel. Fix and re-run <code>npm run backup:test</code>.</p>
    `,
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
