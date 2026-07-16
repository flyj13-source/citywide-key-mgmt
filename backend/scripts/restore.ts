/**
 * Restore a chosen backup — downloads, decrypts, verifies integrity + row
 * counts + schema, and writes it to a target DB path.
 *
 *   npm run backup:restore -- --list
 *       List available cloud backups (newest first).
 *
 *   npm run backup:restore -- --key daily/citywide-backup-<ts>.db.enc --out /tmp/restored.db
 *       Restore a specific cloud object to a target file.
 *
 *   npm run backup:restore -- --file ./local-artifact.db.enc --out /tmp/restored.db
 *       Restore from a local encrypted artifact.
 *
 * Add --force to overwrite an existing target. The restore ALWAYS verifies the
 * file (PRAGMA integrity_check + table row counts) before promoting it into
 * place, so a corrupt download can never clobber a good target.
 *
 * See handoff/BACKUP-RESTORE.md for the full production restore runbook.
 */
import 'dotenv/config';
import { listCloudBackups, restoreFromCloud, restoreFromFile } from '../src/lib/backup/restore';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

(async () => {
  try {
    if (flag('list')) {
      const rows = await listCloudBackups();
      if (rows.length === 0) {
        console.log('No cloud backups found.');
        return;
      }
      console.log(`\n${rows.length} backup(s), newest first:\n`);
      for (const r of rows) {
        console.log(
          `  [${r.tier.padEnd(7)}] ${r.key}   ${(r.size / 1024).toFixed(1)} KB   ${r.lastModified.toISOString()}`
        );
      }
      console.log('\nRestore with:  npm run backup:restore -- --key <key> --out <path>\n');
      return;
    }

    const out = arg('out');
    if (!out) throw new Error('Missing --out <target-db-path>. (Use --list to see available backups.)');
    const force = flag('force');

    let result;
    const key = arg('key');
    const file = arg('file');
    if (key) result = await restoreFromCloud(key, out, { force });
    else if (file) result = await restoreFromFile(file, out, { force });
    else throw new Error('Provide --key <cloud-key> or --file <local-artifact>. (Use --list first.)');

    console.log('\n\x1b[42m\x1b[30m RESTORED \x1b[0m');
    console.log(`  source:   ${result.source}`);
    console.log(`  target:   ${result.targetPath}`);
    console.log(`  size:     ${(result.sizeBytes / 1024).toFixed(1)} KB`);
    console.log(`  accounts: ${result.accounts}`);
    console.log(`  tables:   ${JSON.stringify(result.rowCounts)}\n`);
  } catch (e: any) {
    console.error(`\n\x1b[41m\x1b[97m RESTORE FAILED \x1b[0m ${e.message}\n`);
    process.exit(1);
  }
})();
