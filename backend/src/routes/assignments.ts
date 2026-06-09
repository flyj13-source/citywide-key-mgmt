import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';

const router = Router();

router.get('/', requireAuth, (req: AuthRequest, res: Response) => {
  const { status = '', search = '', page = '1', limit = '50' } = req.query as Record<string, string>;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  let where = '1=1';
  const params: any[] = [];
  if (status) { where += ' AND status = ?'; params.push(status); }
  if (search) { where += ' AND (assignee LIKE ? OR account_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

  const countRow = db.prepare(`SELECT COUNT(*) as c FROM key_assignments WHERE ${where}`).get(...params) as any;
  const total = Object.assign({}, countRow).c as number;

  const assignments = db.prepare(
    `SELECT * FROM key_assignments WHERE ${where} ORDER BY checked_out_at DESC LIMIT ? OFFSET ?`
  ).all(...params, parseInt(limit), offset);

  res.json({ assignments: assignments.map((a) => Object.assign({}, a)), total });
});

router.post('/checkout', requireAuth, (req: AuthRequest, res: Response) => {
  const { account_id, account_name, assignee, assignee_email, key_type, keys_held, due_at, notes } = req.body;
  const result = db.prepare(`
    INSERT INTO key_assignments (account_id, account_name, assignee, assignee_email, key_type, keys_held, due_at, notes, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'checked_out')
  `).run(account_id, account_name, assignee, assignee_email || null, key_type || 'physical', keys_held || null, due_at || null, notes || null);

  db.prepare('INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)').run(
    'key_checked_out', account_name, account_id, req.manager!.name,
    JSON.stringify({ assignee, key_type, keys_held, due_at })
  );

  res.status(201).json({ id: result.lastInsertRowid });
});

router.post('/checkin', requireAuth, (req: AuthRequest, res: Response) => {
  const { id, condition_on_return, notes } = req.body;
  const raw = db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(id) as any;
  if (!raw) return res.status(404).json({ error: 'Assignment not found' });
  const assignment = Object.assign({}, raw);

  db.prepare(`
    UPDATE key_assignments SET status='returned', returned_at=CURRENT_TIMESTAMP, condition_on_return=?, notes=COALESCE(notes||' | '||?, ?)
    WHERE id=?
  `).run(condition_on_return || 'good', notes || '', notes || '', id);

  db.prepare('INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)').run(
    'key_checked_in', assignment.account_name, assignment.account_id, req.manager!.name,
    JSON.stringify({ assignee: assignment.assignee, condition: condition_on_return })
  );

  res.json({ success: true });
});

export default router;
