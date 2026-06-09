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

  const token = jwt.sign(
    { id: manager.id, name: manager.name, email: manager.email, role: manager.role },
    process.env.JWT_SECRET || 'dev-secret',
    { expiresIn: '8h' }
  );

  return res.json({ token, manager: { id: manager.id, name: manager.name, email: manager.email, role: manager.role } });
});

export default router;
