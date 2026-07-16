/**
 * PRODUCTION cron entrypoint.
 *
 * A Render persistent disk attaches to exactly ONE service, so a separate cron
 * *service* cannot read /data/citywide.db. Instead this tiny script (run by the
 * Render Cron Job) POSTs to an authenticated endpoint on the WEB SERVICE, which
 * owns the disk and runs the actual backup via the shared runBackup() lib.
 *
 * Env:
 *   BACKUP_TRIGGER_URL     e.g. https://citywide-backend-0xuj.onrender.com/api/backups/run
 *   BACKUP_TRIGGER_TOKEN   shared secret, also set on the web service
 *
 * Exits non-zero if the trigger fails or the backup reports failure, so the run
 * shows red in the Render cron dashboard.
 */
import 'dotenv/config';

(async () => {
  const url = process.env.BACKUP_TRIGGER_URL;
  const token = process.env.BACKUP_TRIGGER_TOKEN;
  if (!url) {
    console.error('BACKUP_TRIGGER_URL is not set.');
    process.exit(1);
  }
  if (!token) {
    console.error('BACKUP_TRIGGER_TOKEN is not set.');
    process.exit(1);
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const text = await res.text();
    console.log(`HTTP ${res.status}: ${text}`);
    let ok = res.ok;
    try {
      ok = ok && JSON.parse(text).status === 'ok';
    } catch {
      /* non-JSON body → rely on HTTP status */
    }
    process.exit(ok ? 0 : 1);
  } catch (e: any) {
    console.error(`Backup trigger failed: ${e.message}`);
    process.exit(1);
  }
})();
