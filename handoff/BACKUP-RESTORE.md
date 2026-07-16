# City Wide KMS — Backup & Restore Runbook

Layered, cloud-linked, tested-restorable backups for the Key Management System.

## What runs, when, and where

| Layer | Artifact | Where | Cadence | Retention |
|---|---|---|---|---|
| 1. SQLite snapshot | `citywide-backup-<UTC>.db.enc` (AES-256-GCM) | Cloud bucket `daily/` + `monthly/` | Daily 02:00 ET | 30 daily / 12 monthly |
| 2. Human-readable export | `citywide-registry-<UTC>.xlsx.enc` | Uploaded alongside the snapshot | Daily | Same as snapshot |
| 3. Run log | `backups` table + `audit_log` + Settings screen | The live DB | Every run | — |

- **Consistency:** the snapshot uses SQLite `VACUUM INTO`, which produces a fully consistent copy **without locking** the live DB — safe to run while the app serves traffic.
- **Encryption:** both artifacts are encrypted at rest with `BACKUP_ENCRYPTION_KEY` (separate from the app's vault key) *before* leaving the Render disk.
- **Off-disk:** artifacts go to S3-compatible object storage (Cloudflare R2 by default). A backup that lives only on the Render disk dies with the disk — the whole point is that it leaves.

## Why the cron only *triggers* the backup

A Render **persistent disk attaches to exactly one service.** The DB lives on the disk mounted to the **web service**, so a *separate* cron service cannot read `/data/citywide.db`. Therefore:

```
Render Cron Job  ──POST /api/backups/run (Bearer BACKUP_TRIGGER_TOKEN)──►  Web service (owns disk)
   (holds no disk)                                                          runs runBackup(): snapshot→
                                                                            encrypt→export→upload→prune
```

The identical `runBackup()` library is also callable from the CLI (`npm run backup`) for manual/local runs.

---

## One-time setup

### 1. Create the cloud bucket (Cloudflare R2 — recommended)
1. Cloudflare dashboard → **R2** → **Create bucket** → e.g. `citywide-kms-backups`.
2. **R2 → Manage API Tokens → Create** an **Object Read & Write** token scoped to that bucket. Copy the **Access Key ID**, **Secret**, and the **S3 endpoint** (`https://<accountid>.r2.cloudflarestorage.com`).

> B2 or AWS S3 work identically — only the endpoint/region differ. For AWS also set `BACKUP_S3_REGION`.

### 2. Generate secrets
```bash
openssl rand -hex 32   # → BACKUP_ENCRYPTION_KEY
openssl rand -hex 32   # → BACKUP_TRIGGER_TOKEN
```
> **Store `BACKUP_ENCRYPTION_KEY` somewhere safe and separate (e.g. R2 secret manager / a password vault). If you lose it, the backups are unrecoverable — that is the point of encryption.**

### 3. Set env vars in Render
Render dashboard → **Env Groups → `citywide-backup-secrets`** (created by `render.yaml`), fill in:

| Key | Value |
|---|---|
| `BACKUP_ENCRYPTION_KEY` | the first `openssl` value |
| `BACKUP_TRIGGER_TOKEN` | the second `openssl` value |
| `BACKUP_S3_ENDPOINT` | `https://<accountid>.r2.cloudflarestorage.com` |
| `BACKUP_S3_BUCKET` | `citywide-kms-backups` |
| `BACKUP_S3_KEY` | R2 access key id |
| `BACKUP_S3_SECRET` | R2 secret |
| `BACKUP_ALERT_EMAIL` | `tye@citywideboston.com` (failure alerts) |

Both the web service and the cron job reference this group, so the token matches on both sides automatically. `SMTP_USER`/`SMTP_PASS` must already be set for failure emails.

### 4. Deploy
Push to `main`. Render reads `render.yaml`, provisions the **`citywide-backup-cron`** job, and the daily schedule begins.

---

## Verifying it's alive

- **Settings screen** → **Backups** card: `OK · <rows> rows · <size>` with the last timestamp. Red **FAILED** if the last run failed.
- **Render** → `citywide-backup-cron` → **Logs** show each run's output; a failed run is red.
- **Audit log**: `backup_completed` / `backup_failed` entries (manager = `System (backup)`).

## Test the restore (do this after setup, and periodically)
```bash
cd backend
npm run backup:test
```
Snapshots the live DB, encrypts, decrypts, restores to a temp DB, and asserts the restored **row counts + a spot-checked record** match live. Prints `PASS`/`FAIL` (non-zero exit on FAIL). No cloud creds required.

---

## RESTORE — production recovery runbook

> Goal: bring back `citywide.db` from a cloud backup after data loss/corruption.

### Step 0 — get the tools + creds
On any machine with the repo and Node 20+:
```bash
cd backend
npm ci
# Provide the SAME creds the web service uses (from Render / your vault):
export BACKUP_ENCRYPTION_KEY=...   # REQUIRED — the file can't decrypt without it
export BACKUP_S3_ENDPOINT=...
export BACKUP_S3_BUCKET=...
export BACKUP_S3_KEY=...
export BACKUP_S3_SECRET=...
```

### Step 1 — pick a backup
```bash
npm run backup:restore -- --list
# [daily  ] daily/citywide-backup-2026-07-16T06-00-00-000Z.db.enc   172.3 KB   2026-07-16T06:00:03Z
# [monthly] monthly/citywide-backup-2026-07-01-....db.enc           ...
```

### Step 2 — restore to a local file and inspect
```bash
npm run backup:restore -- \
  --key daily/citywide-backup-2026-07-16T06-00-00-000Z.db.enc \
  --out /tmp/restored.db
```
The tool downloads, decrypts, runs `PRAGMA integrity_check`, counts tables, and only then writes `/tmp/restored.db`. It prints the account count + per-table counts. Open it if you like:
```bash
sqlite3 /tmp/restored.db "SELECT COUNT(*) FROM accounts;"
```

### Step 3 — promote it into production
The live DB is on the Render disk at `/data/citywide.db`. To swap it in:

1. **Render → `citywide-backend` → Settings → Suspend** (or scale to 0) so nothing writes during the swap.
2. Open a **Shell** on the web service (Render dashboard → Shell), or use a one-off job with the disk mounted.
3. Back up the current (bad) file first, then replace:
   ```bash
   cp /data/citywide.db /data/citywide.db.broken-$(date +%s)
   ```
4. Get the restored file onto the disk. Easiest: run the restore **on the service itself** (it already has repo + env):
   ```bash
   cd /opt/render/project/src/backend      # repo root on Render
   npm run backup:restore -- --key <key> --out /data/citywide.db --force
   ```
   `--force` overwrites; the tool still verifies integrity before promoting.
5. **Resume** the service. On boot the self-check logs `customers=<n>` — confirm it matches expectations.
6. Confirm in the app (Dashboard counts, a spot-check account) and via the **Settings → Backups** card.

### If the .db is unusable — rebuild from the Excel (Layer 3)
1. Restore the `...xlsx.enc` instead and decrypt it:
   ```bash
   npm run backup:restore -- --key daily/citywide-registry-<ts>.xlsx.enc --out /tmp/registry.xlsx.enc.dbcheck  # (see note)
   ```
   > The restore tool verifies *DB* files; to just decrypt the xlsx, use the small snippet in **Appendix A** below, then open `registry.xlsx`.
2. In the app: **Key Registry → Import from Excel**, map the columns (they match the export headers), and re-import. Encrypted door/alarm codes are **not** in the Excel by design — they only exist inside the `.db` snapshot.

---

## Appendix A — decrypt an artifact by hand
```bash
cd backend
BACKUP_ENCRYPTION_KEY=... node -e '
  const fs=require("fs");
  const {decryptBuffer}=require("./dist/lib/backup/fileCrypto");   // after: npm run build
  fs.writeFileSync(process.argv[2].replace(/\.enc$/,""), decryptBuffer(fs.readFileSync(process.argv[1])));
  console.log("decrypted →", process.argv[2].replace(/\.enc$/,""));
' /path/to/artifact.xlsx.enc /path/to/artifact.xlsx.enc
```

## Appendix B — env var reference
See `.env.example` (`AUTOMATED BACKUPS` section) for every variable and its purpose.

## Failure modes & alerts
- Any failure writes a `backup_failed` **audit entry**, records a `FAILED` row in the `backups` table (shown red on the Settings card), and — if SMTP is configured — **emails `BACKUP_ALERT_EMAIL`**. A silent failure is worse than none.
- Common causes: bad/rotated S3 creds, missing `BACKUP_ENCRYPTION_KEY` in production (the run refuses rather than ship unencrypted), bucket permissions. Fix, then re-run from the Settings card (**Run backup now**) or `npm run backup`.
