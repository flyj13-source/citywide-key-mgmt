import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import db from '../lib/db';

const router = Router();

router.post('/login', (req: Request, res: Response) => {
  const { email, password } = req.body as { email: string; password: string };
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const manager = db.prepare('SELECT * FROM managers WHERE email = ?').get(email) as any;
  if (!manager) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = bcrypt.compareSync(password, manager.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const isTest = !!manager.is_test;
  const canDelete = !!manager.can_delete;
  const token = jwt.sign(
    { id: manager.id, name: manager.name, email: manager.email, role: manager.role, is_test: isTest, can_delete: canDelete },
    process.env.JWT_SECRET || 'dev-secret',
    { expiresIn: '8h' }
  );

  return res.json({
    token,
    manager: { id: manager.id, name: manager.name, email: manager.email, role: manager.role, is_test: isTest, can_delete: canDelete },
  });
});

// JWT-protected password change
router.post('/change-password', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });

  let payload: any;
  try {
    payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET || 'dev-secret');
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  const manager = db.prepare('SELECT * FROM managers WHERE id = ?').get(payload.id) as any;
  if (!manager) return res.status(401).json({ error: 'Unauthorized' });

  const match = await bcrypt.compare(currentPassword, manager.password_hash);
  if (!match) return res.status(401).json({ error: 'Current password incorrect' });

  const hash = await bcrypt.hash(newPassword, 12);
  db.prepare('UPDATE managers SET password_hash = ? WHERE id = ?').run(hash, manager.id);

  return res.json({ success: true });
});

// ONE-TIME emergency reset — inert unless RESET_SECRET env var is set
router.post('/admin-reset', async (req: Request, res: Response) => {
  const secret = process.env.RESET_SECRET;
  if (!secret) return res.status(404).json({ error: 'Not found' });

  if (req.headers['x-reset-secret'] !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { email, newPassword } = req.body as { email: string; newPassword: string };
  if (!email || !newPassword) {
    return res.status(400).json({ error: 'email and newPassword required' });
  }

  const hash = await bcrypt.hash(newPassword, 12);
  const result = db.prepare('UPDATE managers SET password_hash = ? WHERE email = ?')
    .run(hash, email) as { changes: number };

  return res.json({ updated: result.changes });
});

export default router;
