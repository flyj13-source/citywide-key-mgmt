import { Router, Request, Response } from 'express';
import path from 'path';
import db from '../lib/db';
import { readKeyLines, totalQty } from '../lib/custody';
import { hashSignature } from '../lib/pdf';
import { generateCustodyReceipt } from '../lib/custodyPdf';

const router = Router();

// ── Public key check-out sign-off portal ─────────────────────────────────────
// Reuses the contractor magic-link pattern: a tokenized, login-free URL with a
// 48h TTL, an HTML5 canvas signature, a SHA-256 hash of the signature, and a
// branded PDF receipt attached to the assignment record. Applies to BOTH City
// Wide employees and independent contractors.
//
// These routes are mounted WITHOUT requireAuth — the token IS the credential —
// so they expose only what the signer needs to see: their own transaction.

function loadByToken(token: string): { row: any } | { error: string; status: number } {
  const raw = db.prepare('SELECT * FROM key_assignments WHERE signoff_token = ?').get(token) as any;
  if (!raw) return { error: 'Invalid or expired link', status: 404 };
  const row = Object.assign({}, raw);
  if (!row.signoff_expires_at || new Date(`${row.signoff_expires_at}`.replace(' ', 'T')) < new Date()) {
    return { error: 'This link has expired. Please contact City Wide Boston for a new one.', status: 410 };
  }
  return { row };
}

function publicView(row: any) {
  const keys = readKeyLines(row);
  return {
    id: row.id,
    holder: row.assignee,
    holder_type: row.holder_type ?? 'employee',
    client: row.account_name,
    keys,
    total_keys: totalQty(keys),
    checked_out_at: row.checked_out_at,
    due_at: row.due_at ?? null,
    recorded_by: row.recorded_by ?? null,
    signed_at: row.signed_at ?? null,
    status: row.status,
  };
}

// ── GET /api/signoff/:token ──────────────────────────────────────────────────
router.get('/:token', (req: Request, res: Response) => {
  const found = loadByToken(req.params.token);
  if ('error' in found) return res.status(found.status).json({ error: found.error });
  res.json(publicView(found.row));
});

// ── POST /api/signoff/:token/sign ────────────────────────────────────────────
router.post('/:token/sign', async (req: Request, res: Response) => {
  const found = loadByToken(req.params.token);
  if ('error' in found) return res.status(found.status).json({ error: found.error });
  const row = found.row;
  if (row.signed_at) return res.status(409).json({ error: 'These keys have already been signed for' });

  const signature_data = typeof req.body?.signature_data === 'string' ? req.body.signature_data : '';
  if (!signature_data.startsWith('data:image/png;base64,')) {
    return res.status(400).json({ error: 'A signature is required' });
  }

  const hash = hashSignature(signature_data);
  const signedAt = new Date().toISOString();
  const keys = readKeyLines(row);

  let pdfPath: string | null = null;
  let pdfError: string | null = null;
  try {
    pdfPath = await generateCustodyReceipt({
      assignmentId: row.id,
      holder: row.assignee,
      holderType: row.holder_type === 'ic' ? 'ic' : 'employee',
      holderEmail: row.assignee_email ?? null,
      client: row.account_name,
      keys,
      checkedOutAt: row.checked_out_at,
      dueAt: row.due_at ?? null,
      recordedBy: row.recorded_by || 'City Wide Boston',
      signatureData: signature_data,
      signedAt,
    });
  } catch (err: any) {
    // The signature itself is the legal record — never lose it because the PDF
    // renderer failed. Store the signature, report the PDF failure loudly.
    pdfError = err?.message || 'PDF generation failed';
  }

  db.prepare(`
    UPDATE key_assignments
       SET signed_at=?, signature_data=?, signature_hash=?, pdf_path=?, signoff_token=NULL
     WHERE id=?
  `).run(signedAt, signature_data, hash, pdfPath, row.id);

  db.prepare('INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)').run(
    'checkout_signed', row.account_name, row.account_id ?? null, row.assignee,
    JSON.stringify({
      assignment_id: row.id,
      holder: row.assignee,
      holder_type: row.holder_type ?? 'employee',
      keys, total_keys: totalQty(keys),
      hash: hash.slice(0, 16),
      pdf: pdfPath ? path.basename(pdfPath) : null,
      pdf_error: pdfError || undefined,
    }),
  );

  res.json({
    success: true,
    signed_at: signedAt,
    pdf: pdfPath ? path.basename(pdfPath) : null,
    pdf_error: pdfError,
  });
});

export default router;
