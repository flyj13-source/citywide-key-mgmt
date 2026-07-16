import { Router, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';
import { getLatestBackup, ensureBackupTable } from '../lib/backup/status';
import { runBackup } from '../lib/backup/runBackup';

const router = Router();

// ── GET /api/backups/status — latest run + recent history (for Settings) ──────
router.get('/status', requireAuth, (_req: AuthRequest, res: Response) => {
  const latest = getLatestBackup(db);
  const recent = (
    db
      .prepare(
        `SELECT created_at, status, row_count, size_bytes, destination, duration_ms, message
         FROM backups ORDER BY id DESC LIMIT 10`
      )
      .all() as any[]
  ).map((r) => Object.assign({}, r));
  res.json({ latest, recent });
});

// ── POST /api/backups/run — trigger a backup on THIS (disk-owning) service ────
// Auth: either the shared cron secret (BACKUP_TRIGGER_TOKEN) OR an admin JWT.
// This is the endpoint the Render Cron Job calls (see scripts/trigger-backup.ts).
function authorizeRun(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = process.env.BACKUP_TRIGGER_TOKEN || '';
  if (expected && token && timingSafeEq(token, expected)) return next();
  // Fall back to admin JWT so Cara can also trigger a manual backup from the UI.
  return requireAuth(req, res, () => {
    if (req.manager?.role !== 'admin') return res.status(403).json({ error: 'Admin or trigger token required' });
    next();
  });
}

router.post('/run', authorizeRun, async (_req: AuthRequest, res: Response) => {
  ensureBackupTable(db);
  const outcome = await runBackup();
  res.status(outcome.status === 'ok' ? 200 : 500).json({
    status: outcome.status,
    rowCount: outcome.rowCount,
    sizeBytes: outcome.sizeBytes,
    destination: outcome.destination,
    durationMs: outcome.durationMs,
    message: outcome.message,
  });
});

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export default router;
