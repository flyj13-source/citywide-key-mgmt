import { BackupStore } from './storage';
import { PREFIX_DAILY, PREFIX_MONTHLY, RETENTION } from './config';

export interface PruneResult {
  dailyKept: number;
  dailyDeleted: number;
  monthlyKept: number;
  monthlyDeleted: number;
  deletedKeys: string[];
}

// Keep the newest N in each prefix, delete the rest. Daily and monthly live in
// separate prefixes so a monthly keeper is never at risk of being aged out by
// the daily window (30 daily + 12 monthly, independently).
export async function pruneRetention(store: BackupStore): Promise<PruneResult> {
  const result: PruneResult = {
    dailyKept: 0,
    dailyDeleted: 0,
    monthlyKept: 0,
    monthlyDeleted: 0,
    deletedKeys: [],
  };

  for (const [prefix, keep, tag] of [
    [PREFIX_DAILY, RETENTION.daily, 'daily'],
    [PREFIX_MONTHLY, RETENTION.monthly, 'monthly'],
  ] as const) {
    const objects = await store.list(prefix);
    // Group by the artifact stem so a .db.enc and its sibling .xlsx.enc are
    // pruned together and counted as one backup, not two.
    const stems = new Map<string, string[]>(); // stem -> keys
    const order: string[] = []; // stems, newest-first (list() is newest-first)
    for (const o of objects) {
      const stem = stemOf(o.key);
      if (!stems.has(stem)) {
        stems.set(stem, []);
        order.push(stem);
      }
      stems.get(stem)!.push(o.key);
    }
    const keptStems = order.slice(0, keep);
    const doomedStems = order.slice(keep);
    for (const stem of doomedStems) {
      for (const key of stems.get(stem)!) {
        await store.delete(key);
        result.deletedKeys.push(key);
      }
    }
    if (tag === 'daily') {
      result.dailyKept = keptStems.length;
      result.dailyDeleted = doomedStems.length;
    } else {
      result.monthlyKept = keptStems.length;
      result.monthlyDeleted = doomedStems.length;
    }
  }
  return result;
}

// "daily/citywide-backup-<ts>.db.enc" and ".../...-<ts>.xlsx.enc" share the
// stem "daily/citywide-backup-<ts>". Strip the known artifact suffixes.
function stemOf(key: string): string {
  return key.replace(/\.(db|xlsx)\.enc$/, '').replace(/\.(db|xlsx)$/, '');
}
