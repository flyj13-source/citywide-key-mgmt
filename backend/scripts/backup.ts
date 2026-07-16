/**
 * MANUAL / LOCAL backup runner.
 *
 *   npm run backup            → run a full backup right now (snapshot → encrypt
 *                               → export → upload → prune), using the same
 *                               runBackup() the production HTTP trigger uses.
 *
 * In PRODUCTION the scheduled backup is driven by a Render Cron Job that hits an
 * authenticated endpoint on the WEB SERVICE (see scripts/trigger-backup.ts and
 * handoff/BACKUP-RESTORE.md) — because a Render persistent disk attaches to only
 * one service, so only the web service can read /data/citywide.db. This script
 * is for local runs and manual/ad-hoc admin backups.
 *
 * Config via env (see .env.example): DB_PATH, BACKUP_ENCRYPTION_KEY,
 * BACKUP_S3_ENDPOINT / _BUCKET / _KEY / _SECRET.
 */
import 'dotenv/config';
import { runBackup } from '../src/lib/backup/runBackup';

(async () => {
  const outcome = await runBackup();
  console.log('\nResult:', JSON.stringify({ ...outcome, detail: undefined }, null, 2));
  process.exit(outcome.status === 'ok' ? 0 : 1);
})();
