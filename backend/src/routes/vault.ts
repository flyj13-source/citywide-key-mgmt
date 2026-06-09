import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';
import { encrypt, decrypt } from '../lib/crypto';

const router = Router();

router.get('/', requireAuth, (_req: AuthRequest, res: Response) => {
  const rows = db.prepare(`
    SELECT a.id, a.name,
      CASE WHEN a.door_code_encrypted IS NOT NULL THEN 1 ELSE 0 END as has_door_code,
      CASE WHEN a.alarm_code_encrypted IS NOT NULL THEN 1 ELSE 0 END as has_alarm_code,
      a.lockbox, a.has_fob, a.notes
    FROM accounts a
    WHERE a.door_code_encrypted IS NOT NULL OR a.alarm_code_encrypted IS NOT NULL OR a.lockbox IS NOT NULL
    ORDER BY a.name ASC
  `).all();
  res.json(rows.map((r) => Object.assign({}, r)));
});

router.post('/reveal/:id', requireAuth, (req: AuthRequest, res: Response) => {
  const { type } = req.body as { type: 'door' | 'alarm' };
  const raw = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id) as any;
  if (!raw) return res.status(404).json({ error: 'Not found' });
  const account = Object.assign({}, raw);

  let code: string | null = null;
  if (type === 'door' && account.door_code_encrypted) {
    code = decrypt(account.door_code_encrypted, account.door_code_iv);
  } else if (type === 'alarm' && account.alarm_code_encrypted) {
    code = decrypt(account.alarm_code_encrypted, account.alarm_code_iv);
  }

  if (!code) return res.status(404).json({ error: 'No code stored' });

  db.prepare('INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)').run(
    'vault_revealed', account.name, account.id, req.manager!.name,
    JSON.stringify({ type, ip: req.ip })
  );

  res.json({ code });
});

router.post('/', requireAuth, (req: AuthRequest, res: Response) => {
  const { account_id, door_code, alarm_code } = req.body;
  const raw = db.prepare('SELECT * FROM accounts WHERE id = ?').get(account_id) as any;
  if (!raw) return res.status(404).json({ error: 'Account not found' });
  const account = Object.assign({}, raw);

  if (door_code) {
    const { encrypted, iv } = encrypt(door_code);
    db.prepare('UPDATE accounts SET door_code_encrypted=?, door_code_iv=? WHERE id=?').run(encrypted, iv, account_id);
  }
  if (alarm_code) {
    const { encrypted, iv } = encrypt(alarm_code);
    db.prepare('UPDATE accounts SET alarm_code_encrypted=?, alarm_code_iv=? WHERE id=?').run(encrypted, iv, account_id);
  }

  db.prepare('INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)').run(
    'vault_updated', account.name, account_id, req.manager!.name,
    JSON.stringify({ has_door: !!door_code, has_alarm: !!alarm_code })
  );

  res.json({ success: true });
});

export default router;
