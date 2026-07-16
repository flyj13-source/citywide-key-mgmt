import crypto from 'crypto';

// Whole-file encryption at rest for backup artifacts (the .db snapshot and the
// registry .xlsx) before they leave the Render disk. AES-256-GCM, independent
// of the app's ENCRYPTION_KEY so the backup key can be rotated / stored
// separately (e.g. in the cloud provider's secret manager).
//
// On-disk layout of an encrypted artifact:
//   MAGIC(8) | version(1) | iv(12) | authTag(16) | ciphertext(...)
//
// GCM authenticates the whole payload, so any bit-flip in transit or at rest is
// caught at decrypt time (the restore path treats a bad tag as a hard failure).

const MAGIC = Buffer.from('CWKMBK1\0', 'latin1'); // 8 bytes
const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const ALGO = 'aes-256-gcm';

export const ENCRYPTED_EXT = '.enc';

function getKey(): Buffer {
  const hex = process.env.BACKUP_ENCRYPTION_KEY || '';
  const key = Buffer.from(hex, 'hex');
  if (key.length === 32) return key;
  // Deterministic fallback so `backup:test` and local runs work without a
  // configured key. Production refuses to run without a real key (see
  // assertBackupKey), so this fallback is never used to protect real data.
  return crypto.scryptSync('citywide-backup-default', 'citywide-backup-salt', 32);
}

/** True when a real 32-byte BACKUP_ENCRYPTION_KEY is configured. */
export function hasRealBackupKey(): boolean {
  return Buffer.from(process.env.BACKUP_ENCRYPTION_KEY || '', 'hex').length === 32;
}

/** Throw in production if no real key is set — never ship real data under the
 *  weak deterministic fallback. */
export function assertBackupKey(): void {
  if (!hasRealBackupKey() && process.env.NODE_ENV === 'production') {
    throw new Error(
      'BACKUP_ENCRYPTION_KEY is not set (need 64 hex chars = 32 bytes). ' +
        'Refusing to write a production backup under the insecure default key. ' +
        'Generate one with:  openssl rand -hex 32'
    );
  }
}

export function encryptBuffer(plain: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), iv, tag, body]);
}

export function decryptBuffer(blob: Buffer): Buffer {
  const magic = blob.subarray(0, MAGIC.length);
  if (!magic.equals(MAGIC)) {
    throw new Error('Not a City Wide backup artifact (bad magic header) — refusing to decrypt.');
  }
  const version = blob[MAGIC.length];
  if (version !== VERSION) {
    throw new Error(`Unsupported backup format version ${version} (expected ${VERSION}).`);
  }
  let off = MAGIC.length + 1;
  const iv = blob.subarray(off, off + IV_LEN);
  off += IV_LEN;
  const tag = blob.subarray(off, off + TAG_LEN);
  off += TAG_LEN;
  const body = blob.subarray(off);
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
