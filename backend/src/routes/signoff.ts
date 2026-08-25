import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import db from '../lib/db';
import {
  readKeyLines, totalQty, bcNumberForAssignment, transferSignatureState,
} from '../lib/custody';
import { hashSignature } from '../lib/pdf';
import { generateCustodyReceipt, type CustodyAction } from '../lib/custodyPdf';
import { sendSignedReceipt, caraAddress } from '../lib/custodyMail';

const router = Router();

// ── Public key sign-off portal ───────────────────────────────────────────────
// Reuses the contractor magic-link pattern: a tokenized, login-free URL with a
// 48h TTL, an HTML5 canvas signature, a SHA-256 hash of the signature, and a
// branded PDF receipt attached to the assignment record. Applies to BOTH City
// Wide employees and independent contractors, and to BOTH directions — a
// check-OUT form says "you are receiving these keys", a check-IN form says
// "you are returning these keys".
//
// These routes are mounted WITHOUT requireAuth — the token IS the credential —
// so they expose only what the signer needs to see: their own transaction.

interface Found { row: any; action: CustodyAction }

/** The other party on a transferred record — shown to the signer for context. */
function counterpartyName(linkedId: any): string | null {
  if (!linkedId) return null;
  const raw = db.prepare('SELECT assignee FROM key_assignments WHERE id = ?').get(linkedId) as any;
  const name = raw ? Object.assign({}, raw).assignee : null;
  return name == null ? null : String(name);
}

function loadByToken(token: string): Found | { error: string; status: number } {
  // Two tokens can point at the same record (signed out, then signed back in),
  // so the column that matched is what decides the direction — never the row's
  // status, which has already flipped to 'returned' by the time the check-in
  // form is opened.
  const asCheckout = db.prepare('SELECT * FROM key_assignments WHERE signoff_token = ?').get(token) as any;
  const found: Found | null = asCheckout
    ? { row: Object.assign({}, asCheckout), action: 'checkout' }
    : (() => {
      const asCheckin = db.prepare('SELECT * FROM key_assignments WHERE checkin_signoff_token = ?').get(token) as any;
      return asCheckin ? { row: Object.assign({}, asCheckin), action: 'checkin' as const } : null;
    })();

  if (!found) return { error: 'Invalid or expired link', status: 404 };

  const expiry = found.action === 'checkout'
    ? found.row.signoff_expires_at
    : found.row.checkin_signoff_expires_at;
  if (!expiry || new Date(`${expiry}`.replace(' ', 'T')) < new Date()) {
    return { error: 'This link has expired. Please contact City Wide Boston for a new one.', status: 410 };
  }
  return found;
}

function publicView({ row, action }: Found) {
  const keys = readKeyLines(row);
  const counterparty = counterpartyName(row.linked_assignment_id);

  return {
    id: row.id,
    action,
    holder: row.assignee,
    holder_type: row.holder_type ?? 'employee',
    client: row.account_name,
    bc_number: bcNumberForAssignment(row),
    keys,
    total_keys: totalQty(keys),
    checked_out_at: row.checked_out_at,
    due_at: row.due_at ?? null,
    returned_at: row.returned_at ?? null,
    condition_on_return: row.condition_on_return ?? null,
    recorded_by: (action === 'checkin' ? row.checkin_recorded_by : row.recorded_by) || row.recorded_by || null,
    signed_at: (action === 'checkin' ? row.checkin_signed_at : row.signed_at) ?? null,
    status: row.status,
    // Transfer context — the signer should see who the keys came from / went to.
    is_transfer: !!row.transfer_id,
    transfer_counterparty: counterparty,
  };
}

// ── GET /api/signoff/:token ──────────────────────────────────────────────────
router.get('/:token', (req: Request, res: Response) => {
  const found = loadByToken(req.params.token);
  if ('error' in found) return res.status(found.status).json({ error: found.error });
  res.json(publicView(found));
});

// ── POST /api/signoff/:token/sign ────────────────────────────────────────────
router.post('/:token/sign', async (req: Request, res: Response) => {
  const found = loadByToken(req.params.token);
  if ('error' in found) return res.status(found.status).json({ error: found.error });
  const { row, action } = found;

  const alreadySigned = action === 'checkin' ? row.checkin_signed_at : row.signed_at;
  if (alreadySigned) {
    return res.status(409).json({
      error: action === 'checkin'
        ? 'This return has already been signed for'
        : 'These keys have already been signed for',
    });
  }

  const signature_data = typeof req.body?.signature_data === 'string' ? req.body.signature_data : '';
  if (!signature_data.startsWith('data:image/png;base64,')) {
    return res.status(400).json({ error: 'A signature is required' });
  }

  const hash = hashSignature(signature_data);
  const signedAt = new Date().toISOString();
  const keys = readKeyLines(row);
  const bcNumber = bcNumberForAssignment(row);
  const holderType: 'employee' | 'ic' = row.holder_type === 'ic' ? 'ic' : 'employee';
  const counterparty = counterpartyName(row.linked_assignment_id);

  let pdfPath: string | null = null;
  let pdfError: string | null = null;
  try {
    pdfPath = await generateCustodyReceipt({
      assignmentId: row.id,
      action,
      holder: row.assignee,
      holderType,
      holderEmail: row.assignee_email ?? null,
      client: row.account_name,
      bcNumber,
      keys,
      checkedOutAt: row.checked_out_at,
      dueAt: row.due_at ?? null,
      returnedAt: row.returned_at ?? null,
      condition: row.condition_on_return ?? null,
      recordedBy: (action === 'checkin' ? row.checkin_recorded_by : row.recorded_by) || row.recorded_by || 'City Wide Boston',
      signatureData: signature_data,
      signedAt,
      transferCounterparty: counterparty,
    });
  } catch (err: any) {
    // The signature itself is the legal record — never lose it because the PDF
    // renderer failed. Store the signature, report the PDF failure loudly.
    pdfError = err?.message || 'PDF generation failed';
  }

  db.prepare(
    action === 'checkin'
      ? `UPDATE key_assignments
            SET checkin_signed_at=?, checkin_signature_data=?, checkin_signature_hash=?,
                checkin_pdf_path=?, checkin_signoff_token=NULL
          WHERE id=?`
      : `UPDATE key_assignments
            SET signed_at=?, signature_data=?, signature_hash=?, pdf_path=?, signoff_token=NULL
          WHERE id=?`
  ).run(signedAt, signature_data, hash, pdfPath, row.id);

  // Email the signed PDF to the notification recipient AND back to the signer.
  // A failed send is logged and reported — never swallowed.
  const mail = await sendSignedReceipt({
    action,
    holder: row.assignee,
    holderEmail: row.assignee_email ?? null,
    holderType,
    client: row.account_name,
    bcNumber,
    keys,
    signedAt,
    pdf: pdfPath && fs.existsSync(pdfPath)
      ? { filename: path.basename(pdfPath), content: fs.readFileSync(pdfPath) }
      : null,
    pdfError,
  });

  const transfer = row.transfer_id ? transferSignatureState(row.transfer_id) : null;

  db.prepare('INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)').run(
    action === 'checkin' ? 'checkin_signed' : 'checkout_signed',
    row.account_name, row.account_id ?? null, row.assignee,
    JSON.stringify({
      assignment_id: row.id,
      kind: action,
      holder: row.assignee,
      holder_type: row.holder_type ?? 'employee',
      keys, total_keys: totalQty(keys),
      hash: hash.slice(0, 16),
      pdf: pdfPath ? path.basename(pdfPath) : null,
      pdf_error: pdfError || undefined,
      transfer_id: row.transfer_id ?? undefined,
      transfer_signatures: transfer ? `${transfer.signed} of ${transfer.total}` : undefined,
    }),
  );

  db.prepare('INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)').run(
    mail.ok ? 'custody_email_sent' : 'custody_email_failed',
    row.account_name, row.account_id ?? null, row.assignee,
    JSON.stringify({
      kind: 'signed_receipt', signed_kind: action, holder: row.assignee,
      recipients: mail.recipients, error: mail.error, skipped: mail.skipped || undefined,
    }),
  );

  res.json({
    success: true,
    action,
    signed_at: signedAt,
    pdf: pdfPath ? path.basename(pdfPath) : null,
    pdf_error: pdfError,
    receipt_email: { ok: mail.ok, recipients: mail.recipients, error: mail.error, cara: caraAddress() },
    transfer_signatures: transfer,
  });
});

export default router;
