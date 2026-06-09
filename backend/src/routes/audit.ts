import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';

const router = Router();

router.get('/', requireAuth, (req: AuthRequest, res: Response) => {
  const { page = '1', limit = '100', action = '', manager = '' } = req.query as Record<string, string>;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  let where = '1=1';
  const params: any[] = [];
  if (action) { where += ' AND action = ?'; params.push(action); }
  if (manager) { where += ' AND manager LIKE ?'; params.push(`%${manager}%`); }

  const countRow = db.prepare(`SELECT COUNT(*) as c FROM audit_log WHERE ${where}`).get(...params) as any;
  const total = Object.assign({}, countRow).c as number;

  const logs = db.prepare(
    `SELECT * FROM audit_log WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, parseInt(limit), offset);

  res.json({ logs: logs.map((l) => Object.assign({}, l)), total });
});

export default router;
