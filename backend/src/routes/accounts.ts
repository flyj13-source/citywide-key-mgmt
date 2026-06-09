import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';

const router = Router();

router.get('/', requireAuth, (req: AuthRequest, res: Response) => {
  const { search = '', status = '', page = '1', limit = '50' } = req.query as Record<string, string>;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let whereClauses = '1=1';
  const params: any[] = [];

  if (search) {
    whereClauses += ' AND (name LIKE ? OR notes LIKE ? OR key_code LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (status) {
    whereClauses += ' AND status = ?';
    params.push(status);
  }

  const countRow = db.prepare(`SELECT COUNT(*) as c FROM accounts WHERE ${whereClauses}`).get(...params) as any;
  const total = Object.assign({}, countRow).c as number;

  const accounts = db.prepare(
    `SELECT * FROM accounts WHERE ${whereClauses} ORDER BY name ASC LIMIT ? OFFSET ?`
  ).all(...params, parseInt(limit), offset);

  res.json({ accounts: accounts.map((a) => Object.assign({}, a)), total, page: parseInt(page), limit: parseInt(limit) });
});

router.post('/', requireAuth, (req: AuthRequest, res: Response) => {
  const { name, total_keys, am_keys, ccm_keys, contractor_keys, key_code, lockbox, has_fob, notes, status } = req.body;
  const result = db.prepare(`
    INSERT INTO accounts (name, total_keys, am_keys, ccm_keys, contractor_keys, key_code, lockbox, has_fob, notes, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, total_keys || 0, am_keys || 0, ccm_keys || 0, contractor_keys || 0, key_code || null, lockbox || null, has_fob ? 1 : 0, notes || null, status || 'active');

  db.prepare('INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)').run(
    'account_created', name, result.lastInsertRowid, req.manager!.name, JSON.stringify({ total_keys })
  );

  res.status(201).json({ id: result.lastInsertRowid });
});

router.get('/:id', requireAuth, (req: AuthRequest, res: Response) => {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id) as any;
  if (!account) return res.status(404).json({ error: 'Not found' });

  const assignments = db.prepare('SELECT * FROM key_assignments WHERE account_id = ? ORDER BY checked_out_at DESC LIMIT 20').all(req.params.id);
  res.json({ ...Object.assign({}, account), assignments: assignments.map((a) => Object.assign({}, a)) });
});

router.put('/:id', requireAuth, (req: AuthRequest, res: Response) => {
  const { name, total_keys, am_keys, ccm_keys, contractor_keys, key_code, lockbox, has_fob, notes, status } = req.body;
  db.prepare(`
    UPDATE accounts SET name=?, total_keys=?, am_keys=?, ccm_keys=?, contractor_keys=?, key_code=?, lockbox=?, has_fob=?, notes=?, status=?
    WHERE id=?
  `).run(name, total_keys, am_keys, ccm_keys, contractor_keys, key_code, lockbox, has_fob ? 1 : 0, notes, status, req.params.id);

  db.prepare('INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)').run(
    'account_updated', name, req.params.id, req.manager!.name, JSON.stringify(req.body)
  );

  res.json({ success: true });
});

export default router;
