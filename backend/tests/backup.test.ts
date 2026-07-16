import { describe, it, expect } from 'vitest';
import { encryptBuffer, decryptBuffer } from '../src/lib/backup/fileCrypto';
import { pruneRetention } from '../src/lib/backup/retention';
import { PREFIX_DAILY, PREFIX_MONTHLY } from '../src/lib/backup/config';

// ── Encryption round-trip + tamper detection ─────────────────────────────────
describe('backup fileCrypto', () => {
  it('round-trips arbitrary bytes', () => {
    const plain = Buffer.from('the quick brown fox '.repeat(1000));
    expect(decryptBuffer(encryptBuffer(plain)).equals(plain)).toBe(true);
  });

  it('rejects a tampered artifact (GCM tag mismatch)', () => {
    const blob = encryptBuffer(Buffer.from('sensitive backup bytes'));
    blob[blob.length - 1] ^= 0xff; // flip a ciphertext bit
    expect(() => decryptBuffer(blob)).toThrow();
  });

  it('rejects a non-backup blob (bad magic)', () => {
    expect(() => decryptBuffer(Buffer.from('not a backup at all'))).toThrow(/magic/i);
  });
});

// ── Retention: keep newest 30 daily / 12 monthly, prune the rest, siblings
//    (.db + .xlsx) counted as ONE backup ──────────────────────────────────────
class FakeStore {
  objects: Array<{ key: string; size: number; lastModified: Date }> = [];
  seed(prefix: string, n: number, startMs: number) {
    for (let i = 0; i < n; i++) {
      const ts = new Date(startMs + i * 86_400_000).toISOString().replace(/[:.]/g, '-');
      const stem = `${prefix}citywide-backup-${ts}`;
      this.objects.push({ key: `${stem}.db.enc`, size: 100, lastModified: new Date(startMs + i * 86_400_000) });
      this.objects.push({ key: `${stem}.xlsx.enc`, size: 20, lastModified: new Date(startMs + i * 86_400_000) });
    }
  }
  async list(subPrefix: string) {
    return this.objects
      .filter((o) => o.key.startsWith(subPrefix))
      .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  }
  async delete(key: string) {
    this.objects = this.objects.filter((o) => o.key !== key);
  }
}

describe('backup retention', () => {
  it('keeps the newest 30 daily + 12 monthly backups, pruning older siblings together', async () => {
    const store = new FakeStore();
    const base = Date.UTC(2026, 0, 1);
    store.seed(PREFIX_DAILY, 40, base); // 40 daily backups (× 2 files each)
    store.seed(PREFIX_MONTHLY, 15, base); // 15 monthly backups

    const result = await pruneRetention(store as any);

    expect(result.dailyKept).toBe(30);
    expect(result.dailyDeleted).toBe(10);
    expect(result.monthlyKept).toBe(12);
    expect(result.monthlyDeleted).toBe(3);
    // 10 daily + 3 monthly stems × 2 sibling files = 26 objects deleted.
    expect(result.deletedKeys.length).toBe(26);

    // Survivors: exactly 30 daily + 12 monthly db artifacts remain.
    const remainingDailyDb = (await store.list(PREFIX_DAILY)).filter((o) => o.key.endsWith('.db.enc'));
    const remainingMonthlyDb = (await store.list(PREFIX_MONTHLY)).filter((o) => o.key.endsWith('.db.enc'));
    expect(remainingDailyDb.length).toBe(30);
    expect(remainingMonthlyDb.length).toBe(12);
    // Every surviving db artifact still has its .xlsx sibling (pruned together).
    for (const db of remainingDailyDb) {
      const sib = db.key.replace('.db.enc', '.xlsx.enc');
      expect((await store.list(PREFIX_DAILY)).some((o) => o.key === sib)).toBe(true);
    }
  });

  it('is a no-op when under the retention limits', async () => {
    const store = new FakeStore();
    store.seed(PREFIX_DAILY, 5, Date.UTC(2026, 0, 1));
    const result = await pruneRetention(store as any);
    expect(result.dailyKept).toBe(5);
    expect(result.dailyDeleted).toBe(0);
    expect(result.deletedKeys.length).toBe(0);
  });
});
