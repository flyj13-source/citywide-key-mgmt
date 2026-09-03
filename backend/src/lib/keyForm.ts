// ── Key Forms ────────────────────────────────────────────────────────────────
// A Key Form is the auditable artifact: every key one person holds, by client
// and key type, at a moment in time. One is generated on every custody event
// and on demand for an audit.
//
// SECURITY: a Key Form never carries a door or alarm code. The snapshot holds
// client names, BC numbers, key types and counts — nothing else.

import crypto from 'crypto';
import db from './db';
import { KEY_TYPES, readKeyLines, type KeyLine } from './custody';

export type FormEventType = 'checkin' | 'checkout' | 'transfer' | 'reassignment' | 'audit';
export type FormStatus = 'draft' | 'sent' | 'signed' | 'unsigned';

export const FORM_EVENT_LABEL: Record<FormEventType, string> = {
  checkin: 'Check-in',
  checkout: 'Check-out',
  transfer: 'Transfer',
  reassignment: 'Reassignment',
  audit: 'Audit',
};

/** One client row on a form: the keys this person holds THERE. */
export interface FormLine {
  account_id: number | null;
  client: string;
  bc_client_number: string | null;
  metal: number;
  card: number;
  fob: number;
  dispenser: number;
  office: number;
  subtotal: number;
}

export interface FormScope {
  lines: FormLine[];
  /** Free text describing what the triggering event moved, if anything. */
  event_note?: string | null;
}

const TTL_MS = 48 * 60 * 60 * 1000;
const cleanText = (v: any): string | null => {
  const s = v == null ? '' : String(v).trim();
  return s || null;
};

/** Turn key lines into the five per-type columns a form row carries. */
function tally(lines: KeyLine[]): Pick<FormLine, 'metal' | 'card' | 'fob' | 'dispenser' | 'office' | 'subtotal'> {
  const out = { metal: 0, card: 0, fob: 0, dispenser: 0, office: 0, subtotal: 0 };
  for (const l of lines) {
    const key = l.type as keyof typeof out;
    if (key in out && key !== 'subtotal') out[key] += l.qty;
    out.subtotal += l.qty;
  }
  return out;
}

/**
 * CURRENT STATE: every client where this person holds keys right now, read
 * from open custody records. This is what makes a Key Form an audit document
 * rather than a receipt — it answers "what do they have?", not "what moved?".
 */
export function snapshotHolder(holderName: string): FormLine[] {
  const rows = (db.prepare(`
    SELECT a.id AS assignment_id, a.account_id, a.account_name, a.keys_json, a.keys_held, a.key_type,
           acc.bc_client_number
      FROM key_assignments a
      LEFT JOIN accounts acc ON acc.id = a.account_id
     WHERE a.status = 'checked_out'
       AND LOWER(TRIM(a.assignee)) = LOWER(TRIM(?))
     ORDER BY a.account_name ASC
  `).all(holderName) as any[]).map((r) => Object.assign({}, r));

  // One line per CLIENT, merging multiple open records at the same site.
  const byClient = new Map<string, FormLine>();
  for (const r of rows) {
    const key = String(r.account_id ?? r.account_name);
    const lines = readKeyLines(r);
    const t = tally(lines);
    const existing = byClient.get(key);
    if (existing) {
      existing.metal += t.metal; existing.card += t.card; existing.fob += t.fob;
      existing.dispenser += t.dispenser; existing.office += t.office;
      existing.subtotal += t.subtotal;
    } else {
      byClient.set(key, {
        account_id: r.account_id ?? null,
        client: r.account_name,
        bc_client_number: r.bc_client_number ?? null,
        ...t,
      });
    }
  }
  return [...byClient.values()];
}

/** The keys a single event moved, as form lines. Used for transfer forms. */
export function linesFromEvent(
  entries: { account_id: number | null; client: string; bc_client_number?: string | null; keys: KeyLine[] }[]
): FormLine[] {
  return entries.map((e) => ({
    account_id: e.account_id ?? null,
    client: e.client,
    bc_client_number: e.bc_client_number ?? null,
    ...tally(e.keys),
  }));
}

/** Who is this person on the roster? Drives the role/shift on the header. */
export function holderProfile(holderName: string, holderType?: string | null): {
  role: string; shift: string | null; email: string | null; phone: string | null; id: number | null;
} {
  if (holderType === 'ic') {
    const raw = db.prepare(
      "SELECT id, ic_primary_contact, ic_email FROM accounts WHERE (record_type='ic' OR record_type IS NULL) AND LOWER(TRIM(ic_company_name)) = LOWER(TRIM(?)) LIMIT 1"
    ).get(holderName) as any;
    const r = raw ? Object.assign({}, raw) : null;
    return { role: 'Independent Contractor', shift: null, email: r?.ic_email ?? null, phone: null, id: r?.id ?? null };
  }
  const raw = db.prepare(
    'SELECT id, manager_type, role_category, shift, day_night, email, phone FROM staff_managers WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1'
  ).get(holderName) as any;
  if (!raw) return { role: 'City Wide Staff', shift: null, email: null, phone: null, id: null };
  const r = Object.assign({}, raw);
  const role = r.role_category === 'crew' ? 'Crew'
    : r.manager_type === 'both' ? 'AM + CCM'
    : r.manager_type === 'ccm' ? 'CCM'
    : r.manager_type === 'account_manager' ? 'AM'
    : 'City Wide Staff';
  const shift = [r.shift ? `${r.shift} shift` : null, r.day_night ? r.day_night : null]
    .filter(Boolean).join(' · ') || null;
  return { role, shift, email: r.email ?? null, phone: r.phone ?? null, id: r.id ?? null };
}

export interface CreateFormInput {
  eventType: FormEventType;
  holderName: string;
  holderType?: 'employee' | 'ic' | null;
  holderEmail?: string | null;
  /** Omit to snapshot the holder's CURRENT state. */
  lines?: FormLine[];
  eventNote?: string | null;
  holderId?: number | null;
  generatedBy: string;
  sourceKind?: string | null;
  sourceRef?: string | null;
  counterpartyName?: string | null;
}

/**
 * Create a Key Form row. It starts as a draft; a token is minted only when
 * there is somewhere to send it, because an unusable link makes a form look
 * like it is waiting for something it is not.
 */
export function createKeyForm(input: CreateFormInput): any {
  const profile = holderProfile(input.holderName, input.holderType);
  const email = cleanText(input.holderEmail) ?? profile.email;
  const lines = input.lines ?? snapshotHolder(input.holderName);
  const scope: FormScope = { lines, event_note: input.eventNote ?? null };
  const totalKeys = lines.reduce((n, l) => n + l.subtotal, 0);

  const hasEmail = !!email;
  const token = hasEmail ? crypto.randomBytes(32).toString('hex') : null;
  const expires = hasEmail ? new Date(Date.now() + TTL_MS).toISOString() : null;

  const r = db.prepare(`
    INSERT INTO key_form_docs
      (event_type, holder_name, holder_type, holder_role, holder_shift, holder_id,
       holder_email, holder_phone, scope_json, clients_covered, total_keys,
       status, token, token_expires_at, generated_by, source_kind, source_ref,
       counterparty_name, no_email)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.eventType, input.holderName, input.holderType ?? 'employee',
    profile.role, profile.shift, input.holderId ?? profile.id,
    email, profile.phone, JSON.stringify(scope), lines.length, totalKeys,
    token, expires, input.generatedBy,
    input.sourceKind ?? null, input.sourceRef ?? null,
    input.counterpartyName ?? null, hasEmail ? 0 : 1,
  );
  const id = Number(r.lastInsertRowid);
  // Human-readable identifier, assigned after insert so it matches the row id.
  db.prepare('UPDATE key_form_docs SET form_no = ? WHERE id = ?').run(`KF-${String(id).padStart(5, '0')}`, id);
  return getKeyForm(id);
}

export function getKeyForm(id: number): any | null {
  const raw = db.prepare('SELECT * FROM key_form_docs WHERE id = ?').get(id) as any;
  return raw ? Object.assign({}, raw) : null;
}

export function getKeyFormByToken(token: string): any | null {
  const raw = db.prepare('SELECT * FROM key_form_docs WHERE token = ?').get(token) as any;
  return raw ? Object.assign({}, raw) : null;
}

export function parseScope(row: any): FormScope {
  try {
    const s = JSON.parse(row.scope_json || '{}');
    return { lines: Array.isArray(s.lines) ? s.lines : [], event_note: s.event_note ?? null };
  } catch {
    return { lines: [], event_note: null };
  }
}

/** The list view's shape — never the raw scope blob. */
export function serializeForm(row: any): any {
  const scope = parseScope(row);
  let sentTo: string[] = [];
  try { sentTo = JSON.parse(row.sent_to || '[]'); } catch { sentTo = []; }
  return {
    id: row.id,
    form_no: row.form_no,
    event_type: row.event_type,
    event_label: FORM_EVENT_LABEL[row.event_type as FormEventType] ?? row.event_type,
    holder_name: row.holder_name,
    holder_type: row.holder_type,
    holder_role: row.holder_role,
    holder_shift: row.holder_shift,
    holder_email: row.holder_email,
    clients_covered: row.clients_covered,
    total_keys: row.total_keys,
    status: row.status,
    generated_at: row.created_at,
    generated_by: row.generated_by,
    sent_to: sentTo,
    last_sent_at: row.last_sent_at,
    send_count: row.send_count ?? 0,
    send_error: row.send_error ?? null,
    signed_at: row.signed_at,
    signature_typed_name: row.signature_typed_name,
    has_pdf: !!row.pdf_path,
    no_email: !!row.no_email,
    counterparty_name: row.counterparty_name,
    clients: scope.lines,
    event_note: scope.event_note,
  };
}

export interface FormFilters {
  search?: string;
  event_type?: string;
  status?: string;
  from?: string;
  to?: string;
  holder?: string;
  limit?: number;
  offset?: number;
}

export function listKeyForms(f: FormFilters): { rows: any[]; total: number } {
  let where = '1=1';
  const params: any[] = [];

  if (f.search) {
    // Holder OR any client named in the snapshot — the scope blob is searched
    // as text so "Ridgeway" finds every form covering that site.
    where += ' AND (holder_name LIKE ? OR scope_json LIKE ? OR form_no LIKE ?)';
    const s = `%${f.search}%`;
    params.push(s, s, s);
  }
  if (f.holder) { where += ' AND LOWER(TRIM(holder_name)) = LOWER(TRIM(?))'; params.push(f.holder); }
  if (f.event_type && f.event_type !== 'all') { where += ' AND event_type = ?'; params.push(f.event_type); }
  if (f.status && f.status !== 'all') { where += ' AND status = ?'; params.push(f.status); }
  if (f.from) { where += ' AND created_at >= ?'; params.push(f.from); }
  if (f.to) { where += ' AND created_at <= ?'; params.push(`${f.to} 23:59:59`); }

  const countRow = db.prepare(`SELECT COUNT(*) AS c FROM key_form_docs WHERE ${where}`).get(...params) as any;
  const rows = db.prepare(
    `SELECT * FROM key_form_docs WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...params, f.limit ?? 50, f.offset ?? 0) as any[];

  return {
    rows: rows.map((r) => serializeForm(Object.assign({}, r))),
    total: Object.assign({}, countRow).c as number,
  };
}

/** Record a send. Idempotent by design: re-sending is allowed and counted. */
export function markSent(id: number, recipients: string[], ok: boolean, error?: string | null): void {
  const row = getKeyForm(id);
  if (!row) return;
  let prior: string[] = [];
  try { prior = JSON.parse(row.sent_to || '[]'); } catch { prior = []; }
  const merged = [...new Set([...prior, ...recipients.filter(Boolean)])];
  db.prepare(`
    UPDATE key_form_docs
       SET sent_to = ?, last_sent_at = ?, send_count = COALESCE(send_count, 0) + 1,
           send_error = ?,
           status = CASE WHEN status = 'signed' THEN 'signed'
                         WHEN ? = 1 THEN 'sent' ELSE 'unsigned' END
     WHERE id = ?
  `).run(JSON.stringify(merged), new Date().toISOString(), ok ? null : (error ?? 'send failed'), ok ? 1 : 0, id);
}

/**
 * The five columns a Key Form body carries. NOTE: 'office' is a HOLDER in this
 * system (office_keys_held), not a key type a person can be handed — the
 * picker offers metal/card/fob/dispenser. The column is kept because the form
 * layout calls for it, and it fills whenever a line of that type exists.
 */
export const FORM_COLUMNS = [
  { key: 'metal', label: 'Metal' },
  { key: 'card', label: 'Key Card' },
  { key: 'fob', label: 'Key Fob' },
  { key: 'dispenser', label: 'Dispenser' },
  { key: 'office', label: 'Office' },
] as const;
