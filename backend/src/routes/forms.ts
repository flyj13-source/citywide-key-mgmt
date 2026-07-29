import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';
import { logAudit } from '../lib/audit';
import { hashSignature } from '../lib/pdf';

const router = Router();

// ── Key sign-off forms ───────────────────────────────────────────────────────
// In-person e-signature capture for EMPLOYEES and CONTRACTORS receiving or
// returning keys. Each submission is an append-only record; the signature image
// is stored in the DB (base64 PNG) so PDF/JPEG/PNG downloads can be re-rendered
// on demand client-side. This never mutates key inventory — it is a signed
// acknowledgement log, distinct from Check Out / In custody.

type PartyType = 'employee' | 'contractor';
type Action = 'receive' | 'return';
const VALID_PARTY: PartyType[] = ['employee', 'contractor'];
const VALID_ACTION: Action[] = ['receive', 'return'];

const cleanText = (v: any): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

// Normalize account_names into a JSON array string (accepts array or newline/
// comma-separated text). Returns null when empty.
function normalizeAccounts(v: any): string | null {
  let list: string[] = [];
  if (Array.isArray(v)) list = v.map((x) => String(x));
  else if (typeof v === 'string') list = v.split(/[\n,]/);
  list = list.map((s) => s.trim()).filter(Boolean);
  return list.length ? JSON.stringify(list) : null;
}

// List row — the signature-log view. Excludes the heavy signature_data blob;
// clients fetch it via GET /:id only when a download is requested.
function serializeRow(row: any) {
  const r = Object.assign({}, row);
  let accounts: string[] = [];
  try { accounts = r.account_names ? JSON.parse(r.account_names) : []; } catch { accounts = []; }
  return {
    id: r.id,
    party_type: r.party_type,
    action: r.action,
    person_name: r.person_name,
    person_id: r.person_id ?? null,
    person_email: r.person_email ?? null,
    account_names: accounts,
    key_details: r.key_details ?? null,
    notes: r.notes ?? null,
    signature_hash: r.signature_hash,
    signed_at: r.signed_at,
    collected_by: r.collected_by ?? null,
    created_at: r.created_at,
  };
}

// ── POST /api/forms — capture a signed form ──────────────────────────────────
router.post('/', requireAuth, (req: AuthRequest, res: Response) => {
  const party_type = req.body.party_type as PartyType;
  const action = req.body.action as Action;
  const person_name = cleanText(req.body.person_name);
  const signature_data = typeof req.body.signature_data === 'string' ? req.body.signature_data : '';

  if (!VALID_PARTY.includes(party_type)) return res.status(400).json({ error: "party_type must be 'employee' or 'contractor'" });
  if (!VALID_ACTION.includes(action)) return res.status(400).json({ error: "action must be 'receive' or 'return'" });
  if (!person_name) return res.status(400).json({ error: 'Person name is required' });
  if (!signature_data.startsWith('data:image/png;base64,')) {
    return res.status(400).json({ error: 'A signature is required' });
  }

  const person_id = req.body.person_id != null && req.body.person_id !== '' ? Number(req.body.person_id) : null;
  const person_email = cleanText(req.body.person_email);
  const account_names = normalizeAccounts(req.body.account_names);
  const key_details = cleanText(req.body.key_details);
  const notes = cleanText(req.body.notes);
  const signature_hash = hashSignature(signature_data);
  const signed_at = new Date().toISOString();
  const collected_by = req.manager?.name ?? 'System';

  const result = db.prepare(`
    INSERT INTO key_forms
      (party_type, action, person_name, person_id, person_email, account_names,
       key_details, notes, signature_data, signature_hash, signed_at, collected_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    party_type, action, person_name, person_id, person_email, account_names,
    key_details, notes, signature_data, signature_hash, signed_at, collected_by,
  );

  const id = Number(result.lastInsertRowid);
  logAudit(req, 'key_form_signed', person_name, null, {
    id, party_type, action, hash: signature_hash.slice(0, 16),
    accounts: account_names ? JSON.parse(account_names).length : 0,
  });

  const row = db.prepare('SELECT * FROM key_forms WHERE id = ?').get(id);
  res.status(201).json({ form: serializeRow(row) });
});

// ── GET /api/forms — the signature log (list) ────────────────────────────────
router.get('/', requireAuth, (req: AuthRequest, res: Response) => {
  const { party_type = '', action = '', search = '' } = req.query as Record<string, string>;
  let where = '1=1';
  const params: any[] = [];
  if (VALID_PARTY.includes(party_type as PartyType)) { where += ' AND party_type = ?'; params.push(party_type); }
  if (VALID_ACTION.includes(action as Action)) { where += ' AND action = ?'; params.push(action); }
  if (search) {
    where += ' AND (person_name LIKE ? OR person_email LIKE ? OR account_names LIKE ? OR key_details LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }
  const rows = db.prepare(`SELECT * FROM key_forms WHERE ${where} ORDER BY datetime(signed_at) DESC, id DESC`).all(...params);
  res.json({ forms: rows.map(serializeRow) });
});

// ── GET /api/forms/:id — one record WITH the signature (for downloads) ───────
router.get('/:id', requireAuth, (req: AuthRequest, res: Response) => {
  const row = db.prepare('SELECT * FROM key_forms WHERE id = ?').get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: 'Form not found' });
  res.json({ form: { ...serializeRow(row), signature_data: Object.assign({}, row).signature_data } });
});

export default router;
