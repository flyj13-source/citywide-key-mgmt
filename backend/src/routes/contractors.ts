import { Router, Request, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';
import { logAudit } from '../lib/audit';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { sendContractorInvite } from '../lib/mailer';
import { generateSignedPDF, hashSignature } from '../lib/pdf';
import { SIGNATURE_TTL_MS } from '../lib/signatureLink';

const router = Router();

router.get('/', requireAuth, (_req: AuthRequest, res: Response) => {
  const rows = (db.prepare('SELECT * FROM contractors ORDER BY created_at DESC').all() as any[]).map((r) => Object.assign({}, r));
  res.json(rows);
});

router.post('/invite', requireAuth, async (req: AuthRequest, res: Response) => {
  const { name, email, assigned_accounts, bc_vendor_number } = req.body as {
    name: string; email: string; assigned_accounts: string[]; bc_vendor_number?: string;
  };
  // Optional: not every contractor has a vendor number at invite time.
  const vendorNumber = String(bc_vendor_number ?? '').trim() || null;

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SIGNATURE_TTL_MS).toISOString();

  const existing = db.prepare('SELECT id FROM contractors WHERE email = ?').get(email) as any;
  if (existing) {
    // Re-inviting the same address keeps a vendor number already on file when
    // this invite does not carry one — a blank field should not erase it.
    db.prepare(
      'UPDATE contractors SET magic_token=?, token_expires_at=?, assigned_accounts=?, status=?, '
      + 'bc_vendor_number=COALESCE(?, bc_vendor_number) WHERE id=?'
    ).run(token, expires, JSON.stringify(assigned_accounts), 'pending', vendorNumber, Object.assign({}, existing).id);
  } else {
    db.prepare(`
      INSERT INTO contractors (name, email, magic_token, token_expires_at, assigned_accounts, status, bc_vendor_number)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(name, email, token, expires, JSON.stringify(assigned_accounts), vendorNumber);
  }

  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const magicLink = `${baseUrl}/contractor/${token}`;

  // The link exists either way, so a mail problem is reported rather than
  // failing the invitation — the operator can still copy the link from the UI.
  const mail = await sendContractorInvite(email, name, magicLink);

  logAudit(req, 'contractor_invited', null, null, {
    contractor: name, email, accounts: assigned_accounts.length, bc_vendor_number: vendorNumber,
    email_sent: mail.ok, email_skipped: mail.skipped, email_error: mail.error,
  });

  res.json({
    success: true, token, magic_link: magicLink,
    email: { ok: mail.ok, skipped: mail.skipped, error: mail.error },
  });
});

/**
 * IC lookup for the invite modal — BIDIRECTIONAL.
 *
 * `vendor` matches a BC vendor number exactly (one record, or none). `name`
 * searches company name AND primary contact, returning several so the caller
 * can disambiguate rather than guessing for them.
 *
 * MUST stay above `/:token`: that route is a catch-all which would treat
 * "ic-lookup" as a magic token and 404. Behind requireAuth because it exposes
 * vendor contact details, and this router is also mounted publicly at
 * /api/contractor for the magic-link pages.
 */
router.get('/ic-lookup', requireAuth, (req: AuthRequest, res: Response) => {
  const vendor = String(req.query.vendor ?? '').trim();
  const name = String(req.query.name ?? '').trim();
  if (!vendor && !name) return res.json({ matches: [], by: null });

  const shape = (rows: any[]) => rows.map((raw) => {
    const r = Object.assign({}, raw);
    return {
      id: r.id as number,
      // The contact is the person who signs; the company is the vendor. When a
      // named contact exists it is the better default for "Contractor Name".
      name: (r.ic_primary_contact || r.ic_company_name) as string,
      company: r.ic_company_name as string,
      contact: r.ic_primary_contact ?? null,
      email: r.ic_email ?? null,
      bc_vendor_number: r.bc_vendor_number ?? null,
    };
  });

  const IC = "(record_type = 'ic' OR record_type IS NULL) AND COALESCE(archived, 0) = 0";

  if (vendor) {
    const rows = db.prepare(
      `SELECT id, ic_company_name, ic_primary_contact, ic_email, bc_vendor_number
         FROM accounts WHERE ${IC} AND TRIM(bc_vendor_number) = TRIM(?) LIMIT 5`
    ).all(vendor) as any[];
    return res.json({ matches: shape(rows), by: 'vendor' });
  }

  // Name search is capped: this feeds a dropdown, not a report.
  const like = `%${name}%`;
  const rows = db.prepare(
    `SELECT id, ic_company_name, ic_primary_contact, ic_email, bc_vendor_number
       FROM accounts
      WHERE ${IC} AND (ic_company_name LIKE ? OR ic_primary_contact LIKE ?)
      ORDER BY ic_company_name ASC LIMIT 8`
  ).all(like, like) as any[];
  res.json({ matches: shape(rows), by: 'name' });
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
    bc_vendor_number: contractor.bc_vendor_number ?? null,
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
    bcVendorNumber: contractor.bc_vendor_number ?? null,
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
    JSON.stringify({
      email: contractor.email, bc_vendor_number: contractor.bc_vendor_number ?? null,
      hash: hash.slice(0, 16), pdf: path.basename(pdfPath),
    })
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
