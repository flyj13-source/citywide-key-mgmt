import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';

const router = Router();

router.get('/', requireAuth, (_req: AuthRequest, res: Response) => {
  const staff = db.prepare('SELECT * FROM staff_key_holders ORDER BY staff_name ASC').all();
  const grouped: Record<string, { accounts: string[] }> = {};
  for (const row of staff as any[]) {
    const r = Object.assign({}, row);
    if (!grouped[r.staff_name]) grouped[r.staff_name] = { accounts: [] };
    grouped[r.staff_name].accounts.push(r.account);
  }
  const result = Object.entries(grouped).map(([name, data]) => ({
    name,
    account_count: data.accounts.length,
    accounts: data.accounts,
  }));
  res.json(result);
});

export default router;
