import db from './db';

// ── System settings (key/value) ──────────────────────────────────────────────
// Anything an operator must be able to change WITHOUT a redeploy lives here,
// not in an env var and never in a constant. The first case is the custody
// notification recipient: "email Cara on every event" has to survive Cara
// leaving, so the address is a row, editable from Settings.
//
// Env vars remain the BOOTSTRAP default only — on a brand new database the
// stored value is seeded from CARA_EMAIL so behaviour is identical to before
// this table existed, and from then on the stored value wins.

export const CUSTODY_NOTIFY_KEY = 'custody_notification_email';

/** Hard-coded last resort, used only when nothing is stored and no env is set. */
export const CUSTODY_NOTIFY_FALLBACK = 'cara@citywideboston.com';

export function getSetting(key: string): string | null {
  const raw = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any;
  if (!raw) return null;
  const value = Object.assign({}, raw).value;
  const s = value == null ? '' : String(value).trim();
  return s === '' ? null : s;
}

export function setSetting(key: string, value: string | null, updatedBy: string | null): void {
  const clean = value == null ? null : String(value).trim() || null;
  db.prepare(`
    INSERT INTO settings (key, value, updated_at, updated_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                   updated_at = excluded.updated_at,
                                   updated_by = excluded.updated_by
  `).run(key, clean, new Date().toISOString(), updatedBy);
}

export function settingMeta(key: string): { updated_at: string | null; updated_by: string | null } {
  const raw = db.prepare('SELECT updated_at, updated_by FROM settings WHERE key = ?').get(key) as any;
  if (!raw) return { updated_at: null, updated_by: null };
  const row = Object.assign({}, raw);
  return { updated_at: row.updated_at ?? null, updated_by: row.updated_by ?? null };
}

// A basic shape check — enough to stop a typo'd address silently swallowing
// every custody notification, without pretending to validate deliverability.
const ADDRESS = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/**
 * Parse a stored recipient value into addresses. One or more, comma-separated,
 * so a handover period ("Cara AND her replacement") needs no code change.
 * Returns the invalid entries rather than dropping them silently.
 */
export function parseRecipients(value: string | null | undefined): { valid: string[]; invalid: string[] } {
  const parts = String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) (ADDRESS.test(p) ? valid : invalid).push(p);
  return { valid, invalid };
}

/**
 * Who gets the "and Cara" copy of every custody email. Stored value first, then
 * the CARA_EMAIL / SMTP_USER env bootstrap, then the hard-coded fallback.
 */
export function custodyNotifyRecipients(): string[] {
  const stored = getSetting(CUSTODY_NOTIFY_KEY);
  if (stored) {
    const { valid } = parseRecipients(stored);
    if (valid.length) return valid;
  }
  const env = process.env.CARA_EMAIL || process.env.SMTP_USER || CUSTODY_NOTIFY_FALLBACK;
  return parseRecipients(env).valid;
}

/** Single-string form for display and for the legacy `cara` field in responses. */
export function custodyNotifyDisplay(): string {
  return custodyNotifyRecipients().join(', ');
}

/**
 * Seed the stored value once, from the env bootstrap, so a fresh install shows
 * the real recipient in Settings instead of an empty box that reads as "nobody
 * is being notified". Never overwrites an existing row.
 */
export function seedCustodyNotifyDefault(): void {
  if (getSetting(CUSTODY_NOTIFY_KEY)) return;
  const env = process.env.CARA_EMAIL || CUSTODY_NOTIFY_FALLBACK;
  const { valid } = parseRecipients(env);
  if (valid.length) setSetting(CUSTODY_NOTIFY_KEY, valid.join(', '), 'System (default)');
}
