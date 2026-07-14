import { Router, Request, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';
import { logAudit } from '../lib/audit';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { sendContractorInvite } from '../lib/mailer';
import { generateSignedPDF, hashSignature } from '../lib/pdf';

const router = Router();

router.get('/', requireAuth, (_req: AuthRequest, res: Response) => {
  const rows = (db.prepare('SELECT * FROM contractors ORDER BY created_at DESC').all() as any[]).map((r) => Object.assign({}, r));
  res.json(rows);
});

router.post('/invite', requireAuth, async (req: AuthRequest, res: Response) => {
  const { name, email, assigned_accounts } = req.body as {
    name: string; email: string; assigned_accounts: string[];
  };

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  const existing = db.prepare('SELECT id FROM contractors WHERE email = ?').get(email) as any;
  if (existing) {
    db.prepare('UPDATE contractors SET magic_token=?, token_expires_at=?, assigned_accounts=?, status=? WHERE id=?')
      .run(token, expires, JSON.stringify(assigned_accounts), 'pending', Object.assign({}, existing).id);
  } else {
    db.prepare(`
      INSERT INTO contractors (name, email, magic_token, token_expires_at, assigned_accounts, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(name, email, token, expires, JSON.stringify(assigned_accounts));
  }

  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const magicLink = `${baseUrl}/contractor/${token}`;

  try {
    await sendContractorInvite(email, name, magicLink);
  } catch {
    // email failure is non-blocking in demo mode
  }

  logAudit(req, 'contractor_invited', null, null, { contractor: name, email, accounts: assigned_accounts.length });

  res.json({ success: true, token, magic_link: magicLink });
});

router.get('/:token', (req: Request, res: Response) => {
  // Support both /api/contractors/:id/pdf (numeric) and /api/contractor/:token (hex)
  const param = req.params.token;

  // PDF download by numeric id
  if (/^\d+$/.test(param)) {
    const contractor = db.prepare('SELECT * FROM contractors WHERE id = ?').get(param) as any;
    if (!contractor?.pdf_path) return res.status(404).json({ error: 'No PDF' });
    const c = Object.assign({}, contractor);
    if (!fs.existsSync(c.pdf_path)) return res.status(404).json({ error: 'PDF file not found' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(c.pdf_path)}"`);
    return fs.createReadStream(c.pdf_path).pipe(res);
  }

  // Magic token lookup
  const raw = db.prepare('SELECT * FROM contractors WHERE magic_token = ?').get(param) as any;
  if (!raw) return res.status(404).json({ error: 'Invalid or expired link' });
  const contractor = Object.assign({}, raw);
  if (new Date(contractor.token_expires_at) < new Date()) {
    return res.status(410).json({ error: 'This link has expired. Please contact City Wide Boston.' });
  }
  const accounts = JSON.parse(contractor.assigned_accounts || '[]');
  res.json({
    id: contractor.id,
    name: contractor.name,
    email: contractor.email,
    assigned_accounts: accounts,
    status: contractor.status,
    signed_at: contractor.signed_at,
  });
});

router.post('/:token/sign', async (req: Request, res: Response) => {
  const raw = db.prepare('SELECT * FROM contractors WHERE magic_token = ?').get(req.params.token) as any;
  if (!raw) return res.status(404).json({ error: 'Invalid link' });
  const contractor = Object.assign({}, raw);
  if (new Date(contractor.token_expires_at) < new Date()) {
    return res.status(410).json({ error: 'Link expired' });
  }

  const { signature_data } = req.body as { signature_data: string };
  if (!signature_data) return res.status(400).json({ error: 'Signature required' });

  const hash = hashSignature(signature_data);
  const signedAt = new Date().toISOString();
  const accounts = JSON.parse(contractor.assigned_accounts || '[]');

  const pdfPath = await generateSignedPDF({
    contractorName: contractor.name,
    contractorEmail: contractor.email,
    accounts,
    signatureData: signature_data,
    signedAt,
  });

  db.prepare(`
    UPDATE contractors SET status='signed', signed_at=?, signature_data=?, signature_hash=?, pdf_path=?
    WHERE id=?
  `).run(signedAt, signature_data, hash, pdfPath, contractor.id);

  db.prepare('INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)').run(
    'contractor_signed', null, null, contractor.name,
    JSON.stringify({ email: contractor.email, hash: hash.slice(0, 16), pdf: path.basename(pdfPath) })
  );

  res.json({ success: true, pdf_path: path.basename(pdfPath), signed_at: signedAt });
});

router.get('/:id/pdf', requireAuth, (req: AuthRequest, res: Response) => {
  const raw = db.prepare('SELECT * FROM contractors WHERE id = ?').get(req.params.id) as any;
  if (!raw?.pdf_path) return res.status(404).json({ error: 'No PDF' });
  const contractor = Object.assign({}, raw);
  if (!fs.existsSync(contractor.pdf_path)) return res.status(404).json({ error: 'PDF file not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(contractor.pdf_path)}"`);
  fs.createReadStream(contractor.pdf_path).pipe(res);
});

export default router;
