// ── Key Forms API ────────────────────────────────────────────────────────────
// The auditable artifact: list, generate, send, sign, download.
//
// Sending is idempotent and always logged — every send and resend writes an
// audit entry naming the recipients, the timestamp and who sent it, so an audit
// can reconstruct exactly who was told what and when.

import { Router, Response, Request } from 'express';
import fs from 'fs';
import path from 'path';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';
import { logAudit } from '../lib/audit';
import { hashSignature } from '../lib/pdf';
import {
  createKeyForm, getKeyForm, getKeyFormByToken, listKeyForms, markSent,
  parseScope, serializeForm, snapshotHolder, FORM_EVENT_LABEL,
  type FormEventType,
} from '../lib/keyForm';
import { generateKeyFormPdf } from '../lib/keyFormPdf';
import { sendKeyForm, caraAddress, notifyAddresses } from '../lib/custodyMail';

/** Same base the custody sign-off links use. */
const frontendBase = (): string => process.env.FRONTEND_URL || 'http://localhost:5173';

const router = Router();

const cleanText = (v: any): string => (v == null ? '' : String(v).trim());
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

export const keyFormLinkFor = (token: string): string => `${frontendBase()}/key-form/${token}`;

/** Regenerate the PDF from the row's current state. Never throws upward. */
async function refreshPdf(id: number): Promise<string | null> {
  const row = getKeyForm(id);
  if (!row) return null;
  try {
    const file = await generateKeyFormPdf(row);
    db.prepare('UPDATE key_form_docs SET pdf_path = ? WHERE id = ?').run(file, id);
    return file;
  } catch (e) {
    // A PDF failure must never lose the form itself.
    console.error(`[keyform] PDF generation failed for ${id}:`, (e as Error).message);
    return null;
  }
}

// ── GET /api/key-forms — the Forms tab ───────────────────────────────────────
router.get('/', requireAuth, (req: AuthRequest, res: Response) => {
  const q = req.query as Record<string, string>;
  const page = Math.max(1, parseInt(q.page || '1', 10));
  const limit = Math.min(200, Math.max(1, parseInt(q.limit || '50', 10)));
  const { rows, total } = listKeyForms({
    search: cleanText(q.search) || undefined,
    event_type: cleanText(q.event_type) || undefined,
    status: cleanText(q.status) || undefined,
    from: cleanText(q.from) || undefined,
    to: cleanText(q.to) || undefined,
    holder: cleanText(q.holder) || undefined,
    limit,
    offset: (page - 1) * limit,
  });
  res.json({ forms: rows, total, page, limit });
});

// ── GET /api/key-forms/:id ───────────────────────────────────────────────────
router.get('/:id(\\d+)', requireAuth, (req: AuthRequest, res: Response) => {
  const row = getKeyForm(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Form not found' });
  res.json({ form: serializeForm(row) });
});

// ── GET /api/key-forms/:id/pdf — download ────────────────────────────────────
router.get('/:id(\\d+)/pdf', requireAuth, async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  let row = getKeyForm(id);
  if (!row) return res.status(404).json({ error: 'Form not found' });
  if (!row.pdf_path || !fs.existsSync(row.pdf_path)) {
    await refreshPdf(id);
    row = getKeyForm(id);
  }
  if (!row?.pdf_path || !fs.existsSync(row.pdf_path)) {
    return res.status(500).json({ error: 'The PDF could not be generated' });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(row.pdf_path)}"`);
  res.send(fs.readFileSync(row.pdf_path));
});

// ── POST /api/key-forms/generate — on demand, one OR many holders ────────────
// "Generate Key Form": pick one holder or multi-select several. Each gets their
// own form carrying their CURRENT state.
router.post('/generate', requireAuth, async (req: AuthRequest, res: Response) => {
  const actor = req.manager?.name ?? 'System';
  const body = req.body || {};
  const holders: any[] = Array.isArray(body.holders) && body.holders.length
    ? body.holders
    : [{ name: body.holder, type: body.holder_type, email: body.holder_email }];

  const clean = holders
    .map((h) => ({ name: cleanText(h?.name), type: h?.type === 'ic' ? 'ic' : 'employee', email: cleanText(h?.email) }))
    .filter((h) => h.name);
  if (!clean.length) return res.status(400).json({ error: 'Select at least one holder' });

  const eventType: FormEventType = 'audit';
  const created: any[] = [];
  for (const h of clean) {
    const row = createKeyForm({
      eventType,
      holderName: h.name,
      holderType: h.type as 'employee' | 'ic',
      holderEmail: h.email || null,
      generatedBy: actor,
      sourceKind: 'manual',
    });
    await refreshPdf(row.id);
    const fresh = getKeyForm(row.id);
    created.push(serializeForm(fresh));
    logAudit(req, 'key_form_generated', null, null, {
      form_id: row.id, form_no: row.form_no, holder: h.name,
      event_type: eventType, total_keys: row.total_keys, clients: row.clients_covered,
      no_email: !!row.no_email,
    });
  }
  res.status(201).json({ forms: created, count: created.length });
});

/** Shared send path — used by the single, bulk and auto-send callers. */
export async function deliverKeyForm(
  req: AuthRequest, id: number, customTo?: string | null,
): Promise<{ ok: boolean; recipients: string[]; error?: string | null; form: any }> {
  let row = getKeyForm(id);
  if (!row) return { ok: false, recipients: [], error: 'Form not found', form: null };

  if (!row.pdf_path || !fs.existsSync(row.pdf_path)) {
    await refreshPdf(id);
    row = getKeyForm(id);
  }
  const scope = parseScope(row);

  // Holder + Cara + any custom audit address. A form with no holder email can
  // still be routed somewhere by naming an address explicitly.
  const custom = cleanText(customTo);
  const recipients = [
    cleanText(row.holder_email),
    ...notifyAddresses(),
    ...(custom && isEmail(custom) ? [custom] : []),
  ].filter(Boolean);

  const mail = await sendKeyForm({
    formNo: row.form_no ?? `KF-${row.id}`,
    eventLabel: FORM_EVENT_LABEL[row.event_type as FormEventType] ?? row.event_type,
    holder: row.holder_name,
    holderRole: row.holder_role,
    clients: row.clients_covered,
    totalKeys: row.total_keys,
    lines: scope.lines,
    signLink: row.token ? keyFormLinkFor(row.token) : null,
    signed: !!row.signed_at,
    pdf: row.pdf_path && fs.existsSync(row.pdf_path)
      ? { filename: path.basename(row.pdf_path), content: fs.readFileSync(row.pdf_path) }
      : null,
    recipients,
  });

  markSent(id, mail.recipients, mail.ok, mail.error);

  logAudit(req, mail.ok ? 'key_form_sent' : 'key_form_send_failed', null, null, {
    form_id: id, form_no: row.form_no, holder: row.holder_name,
    recipients: mail.recipients, custom_recipient: custom || undefined,
    sent_by: req.manager?.name ?? 'System', at: new Date().toISOString(),
    error: mail.error, attempts: mail.attempts,
  });

  return { ok: mail.ok, recipients: mail.recipients, error: mail.error, form: serializeForm(getKeyForm(id)) };
}

// ── POST /api/key-forms/:id/send — send or resend ────────────────────────────
router.post('/:id(\\d+)/send', requireAuth, async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!getKeyForm(id)) return res.status(404).json({ error: 'Form not found' });
  const to = cleanText(req.body?.to);
  if (to && !isEmail(to)) return res.status(400).json({ error: `"${to}" is not a valid email address` });
  const r = await deliverKeyForm(req, id, to || null);
  res.json({ ok: r.ok, recipients: r.recipients, error: r.error, form: r.form });
});

// ── POST /api/key-forms/bulk-send ────────────────────────────────────────────
router.post('/bulk-send', requireAuth, async (req: AuthRequest, res: Response) => {
  const ids: number[] = Array.isArray(req.body?.ids)
    ? (req.body.ids as any[]).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)
    : [];
  if (!ids.length) return res.status(400).json({ error: 'No forms selected' });
  if (ids.length > 200) return res.status(400).json({ error: 'Too many forms at once (max 200)' });
  const to = cleanText(req.body?.to);
  if (to && !isEmail(to)) return res.status(400).json({ error: `"${to}" is not a valid email address` });

  const results: { id: number; ok: boolean; recipients: string[]; error?: string | null }[] = [];
  for (const id of [...new Set(ids)]) {
    if (!getKeyForm(id)) { results.push({ id, ok: false, recipients: [], error: 'Not found' }); continue; }
    const r = await deliverKeyForm(req, id, to || null);
    results.push({ id, ok: r.ok, recipients: r.recipients, error: r.error });
  }
  const sent = results.filter((r) => r.ok).length;
  logAudit(req, 'key_forms_bulk_sent', null, null, {
    requested: ids.length, sent, failed: results.length - sent,
    custom_recipient: to || undefined, sent_by: req.manager?.name ?? 'System',
  });
  res.json({ sent, failed: results.length - sent, results });
});

// ── PUBLIC: GET /api/key-forms/token/:token — the signature page ─────────────
router.get('/token/:token', (req: Request, res: Response) => {
  const row = getKeyFormByToken(req.params.token);
  if (!row) return res.status(404).json({ error: 'Invalid or expired link' });
  if (!row.token_expires_at || new Date(String(row.token_expires_at).replace(' ', 'T')) < new Date()) {
    return res.status(410).json({ error: 'This link has expired. Please contact City Wide Boston for a new one.' });
  }
  const scope = parseScope(row);
  res.json({
    form_no: row.form_no,
    event_type: row.event_type,
    event_label: FORM_EVENT_LABEL[row.event_type as FormEventType] ?? row.event_type,
    holder: row.holder_name,
    holder_role: row.holder_role,
    holder_shift: row.holder_shift,
    holder_email: row.holder_email,
    clients: scope.lines,
    event_note: scope.event_note,
    total_keys: row.total_keys,
    clients_covered: row.clients_covered,
    generated_at: row.created_at,
    generated_by: row.generated_by,
    signed_at: row.signed_at,
  });
});

// ── PUBLIC: POST /api/key-forms/token/:token/sign ────────────────────────────
router.post('/token/:token/sign', async (req: Request, res: Response) => {
  const row = getKeyFormByToken(req.params.token);
  if (!row) return res.status(404).json({ error: 'Invalid or expired link' });
  if (!row.token_expires_at || new Date(String(row.token_expires_at).replace(' ', 'T')) < new Date()) {
    return res.status(410).json({ error: 'This link has expired. Please contact City Wide Boston for a new one.' });
  }
  if (row.signed_at) return res.status(409).json({ error: 'This form has already been signed' });

  const signature_data = typeof req.body?.signature_data === 'string' ? req.body.signature_data : '';
  if (!signature_data.startsWith('data:image/png;base64,')) {
    return res.status(400).json({ error: 'A signature is required' });
  }
  const typed_name = typeof req.body?.typed_name === 'string' ? req.body.typed_name.trim() : '';
  if (!typed_name) return res.status(400).json({ error: 'Please type your full name to confirm' });
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  if (norm(typed_name) !== norm(row.holder_name)) {
    return res.status(400).json({ error: `Please type the name this form is recorded against: ${row.holder_name}` });
  }

  const signedAt = new Date().toISOString();
  const hash = hashSignature(signature_data);
  db.prepare(`
    UPDATE key_form_docs
       SET signed_at = ?, signature_data = ?, signature_hash = ?, signature_typed_name = ?,
           status = 'signed', token = NULL
     WHERE id = ?
  `).run(signedAt, signature_data, hash, typed_name, row.id);

  // Regenerate so the stored PDF carries the signature.
  await refreshPdf(row.id);
  const signed = getKeyForm(row.id);
  const scope = parseScope(signed);

  // Back to the signer, Cara, and anywhere this form was routed during an audit.
  let priorSends: string[] = [];
  try { priorSends = JSON.parse(signed.sent_to || '[]'); } catch { priorSends = []; }
  const recipients = [
    cleanText(signed.holder_email), ...notifyAddresses(), ...priorSends,
  ].filter(Boolean);

  const mail = await sendKeyForm({
    formNo: signed.form_no, eventLabel: FORM_EVENT_LABEL[signed.event_type as FormEventType] ?? signed.event_type,
    holder: signed.holder_name, holderRole: signed.holder_role,
    clients: signed.clients_covered, totalKeys: signed.total_keys,
    lines: scope.lines, signLink: null, signed: true,
    pdf: signed.pdf_path && fs.existsSync(signed.pdf_path)
      ? { filename: path.basename(signed.pdf_path), content: fs.readFileSync(signed.pdf_path) }
      : null,
    recipients,
  });

  db.prepare('INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)').run(
    'key_form_signed', null, null, signed.holder_name,
    JSON.stringify({
      form_id: signed.id, form_no: signed.form_no, holder: signed.holder_name,
      total_keys: signed.total_keys, clients: signed.clients_covered,
      hash: hash.slice(0, 16), typed_name,
      receipt_recipients: mail.recipients, receipt_error: mail.error,
    }),
  );

  res.json({
    success: true, form_no: signed.form_no, signed_at: signedAt,
    receipt_email: { ok: mail.ok, recipients: mail.recipients, error: mail.error, cara: caraAddress() },
  });
});

export default router;
