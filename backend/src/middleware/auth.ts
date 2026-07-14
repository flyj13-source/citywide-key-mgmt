import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthRequest extends Request {
  manager?: { id: number; name: string; email: string; role: string; is_test?: boolean };
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret') as {
      id: number; name: string; email: string; role: string; is_test?: boolean;
    };
    req.manager = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
