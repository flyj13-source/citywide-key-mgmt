import fs from 'fs';
import path from 'path';
import { BackupStore } from './storage';
import { readS3Config, PREFIX_DAILY, PREFIX_MONTHLY } from './config';
import { decryptBuffer } from './fileCrypto';
import { countAndVerify } from './snapshot';

export interface RestoreResult {
  targetPath: string;
  sizeBytes: number;
  rowCounts: Record<string, number>;
  accounts: number;
  source: string;
}

/** List available cloud backups (db artifacts only), newest first. */
export async function listCloudBackups(): Promise<
  Array<{ key: string; size: number; lastModified: Date; tier: 'daily' | 'monthly' }>
> {
  const cfg = readS3Config();
  if (!cfg) throw new Error('No cloud storage configured (BACKUP_S3_* env vars).');
  const store = new BackupStore(cfg);
  const out: Array<{ key: string; size: number; lastModified: Date; tier: 'daily' | 'monthly' }> = [];
  for (const [prefix, tier] of [
    [PREFIX_DAILY, 'daily'],
    [PREFIX_MONTHLY, 'monthly'],
  ] as const) {
    for (const o of await store.list(prefix)) {
      if (/\.db\.enc$/.test(o.key)) out.push({ ...o, tier });
    }
  }
  out.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return out;
}

/** Download an encrypted .db artifact from the cloud, decrypt, verify, and
 *  write it to `targetPath`. Refuses to overwrite unless `force`. */
export async function restoreFromCloud(
  key: string,
  targetPath: string,
  opts: { force?: boolean } = {}
): Promise<RestoreResult> {
  const cfg = readS3Config();
  if (!cfg) throw new Error('No cloud storage configured (BACKUP_S3_* env vars).');
  const store = new BackupStore(cfg);
  const blob = await store.get(key);
  return materialize(decryptBuffer(blob), targetPath, `cloud:${key}`, opts);
}

/** Restore from a local encrypted artifact file (e.g. one already downloaded). */
export async function restoreFromFile(
  encPath: string,
  targetPath: string,
  opts: { force?: boolean } = {}
): Promise<RestoreResult> {
  const blob = fs.readFileSync(encPath);
  return materialize(decryptBuffer(blob), targetPath, `file:${encPath}`, opts);
}

function materialize(
  plainDb: Buffer,
  targetPath: string,
  source: string,
  opts: { force?: boolean }
): RestoreResult {
  if (fs.existsSync(targetPath) && !opts.force) {
    throw new Error(`Target ${targetPath} already exists. Pass force to overwrite.`);
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  // Write to a temp sibling then rename — never leave a half-written DB in place.
  const tmp = `${targetPath}.restore-tmp`;
  fs.writeFileSync(tmp, plainDb);
  // Verify BEFORE promoting it into place.
  const { rowCounts, accounts } = countAndVerify(tmp);
  fs.renameSync(tmp, targetPath);
  return { targetPath, sizeBytes: plainDb.length, rowCounts, accounts, source };
}
