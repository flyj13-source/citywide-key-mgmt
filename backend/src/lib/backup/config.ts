import path from 'path';

// ── Where the live DB lives ──────────────────────────────────────────────────
// Mirrors the resolution in src/lib/db.ts EXACTLY so the backup tooling always
// targets the same file the web service is serving (Render disk → /data, local
// dev → ./database).
export function resolveDbPath(): string {
  return (
    process.env.DB_PATH ||
    path.join(process.env.CITYWIDE_DB_DIR || path.join(process.cwd(), 'database'), 'citywide.db')
  );
}

// ── Cloud object storage (S3-compatible: Cloudflare R2 / Backblaze B2 / AWS) ──
export interface S3Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  prefix: string;
}

export function readS3Config(): S3Config | null {
  const endpoint = process.env.BACKUP_S3_ENDPOINT;
  const bucket = process.env.BACKUP_S3_BUCKET;
  const accessKeyId = process.env.BACKUP_S3_KEY;
  const secretAccessKey = process.env.BACKUP_S3_SECRET;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    // R2 ignores region ("auto"); AWS/B2 honor it. Overridable for AWS S3.
    region: process.env.BACKUP_S3_REGION || 'auto',
    // Optional key prefix inside the bucket, e.g. "citywide/". No leading slash.
    prefix: (process.env.BACKUP_S3_PREFIX || '').replace(/^\/+/, ''),
  };
}

export function s3ConfigProblems(): string[] {
  const missing: string[] = [];
  for (const [k, v] of [
    ['BACKUP_S3_ENDPOINT', process.env.BACKUP_S3_ENDPOINT],
    ['BACKUP_S3_BUCKET', process.env.BACKUP_S3_BUCKET],
    ['BACKUP_S3_KEY', process.env.BACKUP_S3_KEY],
    ['BACKUP_S3_SECRET', process.env.BACKUP_S3_SECRET],
  ] as const) {
    if (!v) missing.push(k);
  }
  return missing;
}

// ── Retention ────────────────────────────────────────────────────────────────
export const RETENTION = {
  daily: Number(process.env.BACKUP_RETAIN_DAILY || 30),
  monthly: Number(process.env.BACKUP_RETAIN_MONTHLY || 12),
};

// ── Object-key layout in the bucket ──────────────────────────────────────────
export const PREFIX_DAILY = 'daily/';
export const PREFIX_MONTHLY = 'monthly/';

// A filename-safe UTC timestamp: 2026-07-16T06-00-00-000Z
export function utcStamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

// YYYY-MM in UTC, used to detect "already have a monthly for this month".
export function yearMonth(d: Date): string {
  return d.toISOString().slice(0, 7);
}

// Who to email on failure (falls back to the SMTP user, then Cara).
export function failureRecipient(): string {
  return (
    process.env.BACKUP_ALERT_EMAIL ||
    process.env.SMTP_USER ||
    'tye@citywideboston.com'
  );
}
