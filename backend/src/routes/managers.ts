import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';
import { logAudit } from '../lib/audit';
import {
  Role, ROLE_LABEL, clientsFor, staffById, canHoldRole,
  performTransfer, performUndo, confirmHandover, staffEmail,
} from '../lib/reassign';
import { sendHandoverNotice } from '../lib/handoverMail';

const router = Router();

// People-roster aggregates for the Account Manager / CCM tabs, in TWO groups:
//
//   PERSONALLY HOLDS — what's in that person's pocket, by type (Metal/Card/
//     Fob/Dispenser — the holder-grid columns for this role) + Total (the
//     computed column total, am_keys/ccm_keys). Office is its own holder now,
//     not a per-role bolt-on, so it no longer appears here.
//
//   ACROSS THEIR CLIENTS — the client-site Key Inventory (Metal/Card/Fob/
//     Dispenser row totals) at every client this person manages.
//
// All aggregation is done in SQL (GROUP BY + SUMs) — never client-side over
// hundreds of rows. Sentinel/test records (bc_client_number starting "999") are
// excluded so the rosters stay truthful, matching the dashboard hygiene rule.
function roster(groupCol: 'account_manager' | 'ccm_manager', role: 'am' | 'ccm') {
  const personalKeysCol = `${role}_keys`; // computed column total (metal+card+fob+dispenser)
  const rows = db.prepare(`
    SELECT
      ${groupCol}                          AS person,
      COUNT(*)                             AS clients_managed,
      COALESCE(SUM(${personalKeysCol}), 0) AS keys_held,
      -- PERSONALLY HOLDS, per type (this role's holder-grid columns)
      COALESCE(SUM(${role}_metal), 0)      AS personal_metal,
      COALESCE(SUM(${role}_card), 0)       AS personal_cards,
      COALESCE(SUM(${role}_fob), 0)        AS personal_fobs,
      COALESCE(SUM(${role}_dispenser), 0)  AS personal_dispenser,
      -- ACROSS THEIR CLIENTS (client-site Key Inventory row totals)
      COALESCE(SUM(metal_keys), 0)         AS metal_keys,
      COALESCE(SUM(key_cards), 0)          AS key_cards,
      COALESCE(SUM(has_fob), 0)            AS key_fobs,
      COALESCE(SUM(dispenser_keys), 0)     AS dispenser_keys
    FROM accounts
    WHERE record_type = 'customer'
      AND COALESCE(archived, 0) = 0
      AND ${groupCol} IS NOT NULL AND TRIM(${groupCol}) <> ''
      AND (bc_client_number IS NULL OR bc_client_number NOT LIKE '999%')
    GROUP BY ${groupCol}
    ORDER BY COALESCE(SUM(${personalKeysCol}), 0) DESC, person ASC
  `).all() as any[];

  return rows.map((raw) => {
    const r = Object.assign({}, raw);
    const total_held = r.keys_held; // column total IS the personal total now
    const total_client_keys = r.metal_keys + r.key_cards + r.key_fobs + r.dispenser_keys;
    return { ...r, total_held, total_client_keys };
  });
}

// Reusable roster builders (also consumed by the registry export) so the
// exported AM/CCM sheets are byte-for-byte the same aggregate as the tabs.
export const accountManagerRoster = () => roster('account_manager', 'am');
export const ccmRoster = () => roster('ccm_manager', 'ccm');

router.get('/account-managers', requireAuth, (_req: AuthRequest, res: Response) => {
  res.json({ managers: accountManagerRoster() });
});

router.get('/ccms', requireAuth, (_req: AuthRequest, res: Response) => {
  res.json({ managers: ccmRoster() });
});

// ── Grant / revoke a manager's delete permission (admin only) ────────────────
// The Manage Users UI arrives later; the endpoint exists now so Cara can grant
// can_delete=1 to a teammate. Audit-logged.
router.patch('/:id/permissions', requireAuth, (req: AuthRequest, res: Response) => {
  if (req.manager?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  const target = db.prepare('SELECT id, name, email FROM managers WHERE id = ?').get(req.params.id) as any;
  if (!target) return res.status(404).json({ error: 'Manager not found' });

  const { can_delete } = req.body as { can_delete?: boolean | number };
  const value = can_delete ? 1 : 0;
  db.prepare('UPDATE managers SET can_delete = ? WHERE id = ?').run(value, req.params.id);

  logAudit(req, 'permissions_changed', null, null, {
    target_manager: target.email, can_delete: value === 1,
  });

  res.json({ id: target.id, email: target.email, can_delete: value === 1 });
});


// ═══════════════════════════════════════════════════════════════════════════
// BULK MANAGER REASSIGNMENT
// ═══════════════════════════════════════════════════════════════════════════
// Moves a manager's clients — and the key responsibility that rides on them —
// to another manager in one atomic action. Gated on can_delete: this is the
// same class of high-impact bulk mutation as a delete.

function requireBulkPermission(req: AuthRequest, res: Response): boolean {
  if (!req.manager?.can_delete && req.manager?.role !== 'admin') {
    res.status(403).json({ error: 'Reassignment requires delete permission' });
    return false;
  }
  return true;
}

const asRole = (v: any): Role | null => (v === 'am' || v === 'ccm' ? v : null);

// ── GET /api/managers/:id/reassignable?role=am|ccm ──────────────────────────
// The modal's payload: the source manager, every client they hold in that role
// with the keys they hold there, and the list of valid targets.
router.get('/:id/reassignable', requireAuth, (req: AuthRequest, res: Response) => {
  const source = staffById(Number(req.params.id));
  if (!source) return res.status(404).json({ error: 'Manager not found' });

  // Default to whichever role this person actually holds.
  const requested = asRole(req.query.role);
  const role: Role = requested
    ?? (source.manager_type === 'ccm' ? 'ccm' : 'am');
  if (!canHoldRole(source, role)) {
    return res.status(400).json({ error: `${source.name} is not a ${ROLE_LABEL[role]}` });
  }

  const clients = clientsFor(source.name, role);
  const targets = (db.prepare(
    'SELECT * FROM staff_managers WHERE COALESCE(active, 1) = 1 AND id <> ? ORDER BY name ASC'
  ).all(source.id) as any[])
    .map((r) => Object.assign({}, r))
    .filter((r) => canHoldRole(r, role))
    .map((r) => ({
      id: r.id, name: r.name, manager_type: r.manager_type,
      email: r.email ?? null,
      clients_managed: clientsFor(r.name, role).length,
    }));

  res.json({
    source: { id: source.id, name: source.name, manager_type: source.manager_type },
    role,
    role_label: ROLE_LABEL[role],
    clients,
    targets,
    summary: {
      clients: clients.length,
      keys: clients.reduce((n, c) => n + c.total_keys, 0),
      key_types: [...new Set(clients.flatMap((c) => c.keys.map((k) => k.label)))].length,
    },
  });
});

// ── POST /api/managers/reassign ─────────────────────────────────────────────
// { fromId, toId, clientIds[], role, sendHandover? }
router.post('/reassign', requireAuth, async (req: AuthRequest, res: Response) => {
  if (!requireBulkPermission(req, res)) return;

  const { fromId, toId, clientIds, role: roleRaw, sendHandover } = (req.body || {}) as {
    fromId?: number; toId?: number; clientIds?: number[]; role?: string; sendHandover?: boolean;
  };
  const role = asRole(roleRaw);
  if (!role) return res.status(400).json({ error: "role must be 'am' or 'ccm'" });
  if (!Array.isArray(clientIds) || clientIds.length === 0) {
    return res.status(400).json({ error: 'Select at least one client to transfer' });
  }

  const source = fromId != null ? staffById(Number(fromId)) : null;
  const target = toId != null ? staffById(Number(toId)) : null;
  if (!source) return res.status(404).json({ error: 'Source manager not found' });
  if (!target) return res.status(404).json({ error: 'Target manager not found' });
  if (source.id === target.id) return res.status(400).json({ error: 'Source and target are the same person' });
  if (!canHoldRole(source, role)) {
    return res.status(400).json({ error: `${source.name} is not a ${ROLE_LABEL[role]}` });
  }
  if (!canHoldRole(target, role)) {
    return res.status(400).json({
      error: `${target.name} cannot take ${ROLE_LABEL[role]} clients — their type is "${target.manager_type}". Cross-type transfers are only allowed for staff typed "both".`,
    });
  }

  // Only clients the source actually holds in this role are eligible; anything
  // else in the request is rejected rather than silently dropped.
  const eligible = clientsFor(source.name, role);
  const eligibleIds = new Set(eligible.map((c) => c.id));
  const unknown = clientIds.filter((id) => !eligibleIds.has(Number(id)));
  if (unknown.length) {
    return res.status(400).json({
      error: `${unknown.length} selected client(s) are not currently assigned to ${source.name} as ${ROLE_LABEL[role]}`,
      client_ids: unknown,
    });
  }

  const markHandover = sendHandover !== false;
  let result;
  try {
    result = performTransfer({
      fromName: source.name, toName: target.name, role,
      clientIds: clientIds.map(Number), markHandover,
    });
  } catch (err: any) {
    return res.status(409).json({ error: err?.message || 'Transfer failed — nothing was changed' });
  }

  // (c) one audit entry PER CLIENT …
  for (const c of result.moved) {
    logAudit(req, 'manager_reassigned', c.name, c.id, {
      from: source.name, to: target.name, role, role_label: ROLE_LABEL[role],
      keys_transferred: c.keys_transferred, keys: c.keys, client: c.name,
      bc_client_number: c.bc_client_number,
    });
  }

  // … (d) plus ONE summary entry carrying full before/after for undo.
  logAudit(req, 'bulk_manager_reassignment', null, null, {
    from: source.name, from_id: source.id,
    to: target.name, to_id: target.id,
    role, role_label: ROLE_LABEL[role],
    total_clients: result.totalClients,
    total_keys: result.totalKeys,
    key_types_affected: result.keyTypesAffected,
    client_ids: result.moved.map((c) => c.id),
    clients: result.moved.map((c) => ({ id: c.id, name: c.name, keys_transferred: c.keys_transferred })),
    pending_handover: markHandover,
    actor: req.manager?.name ?? 'System',
  });
  const summaryId = Number(
    Object.assign({}, db.prepare('SELECT MAX(id) AS c FROM audit_log').get() as any).c
  );

  // (4) optional physical-handover notice — never blocks the transfer.
  let email: any = null;
  if (sendHandover) {
    const mail = await sendHandoverNotice({
      fromName: source.name, fromEmail: source.email ?? staffEmail(source.name),
      toName: target.name, toEmail: target.email ?? staffEmail(target.name),
      roleLabel: ROLE_LABEL[role],
      actor: req.manager?.name ?? 'System',
      clients: result.moved.map((c) => ({ name: c.name, bc_client_number: c.bc_client_number, keys: c.keys })),
    });
    logAudit(req, mail.ok ? 'handover_notice_sent' : 'handover_notice_failed', null, null, {
      from: source.name, to: target.name, recipients: mail.recipients, error: mail.error,
      clients: result.totalClients,
    });
    email = { ok: mail.ok, recipients: mail.recipients, error: mail.error };
  }

  res.json({
    success: true,
    audit_id: summaryId,
    from: source.name,
    to: target.name,
    role,
    ...result,
    pending_handover: markHandover,
    email,
  });
});

// ── POST /api/managers/reassign/:auditId/undo ───────────────────────────────
// Reverses a bulk reassignment from its own audit record. can_delete + 30 days.
router.post('/reassign/:auditId/undo', requireAuth, (req: AuthRequest, res: Response) => {
  if (!requireBulkPermission(req, res)) return;

  const raw = db.prepare("SELECT * FROM audit_log WHERE id = ? AND action = 'bulk_manager_reassignment'")
    .get(req.params.auditId) as any;
  if (!raw) return res.status(404).json({ error: 'Reassignment not found' });
  const entry = Object.assign({}, raw);

  let meta: any;
  try { meta = JSON.parse(entry.metadata || '{}'); } catch { meta = {}; }
  if (meta.undone_by) {
    return res.status(409).json({ error: 'This reassignment has already been undone' });
  }

  const created = new Date(String(entry.created_at).replace(' ', 'T') + 'Z');
  const ageDays = (Date.now() - created.getTime()) / 86_400_000;
  if (Number.isFinite(ageDays) && ageDays > 30) {
    return res.status(410).json({
      error: `This reassignment is ${Math.floor(ageDays)} days old — undo is only available within 30 days.`,
    });
  }

  const role = asRole(meta.role);
  if (!role || !meta.from || !meta.to || !Array.isArray(meta.client_ids)) {
    return res.status(422).json({ error: 'This audit entry does not carry enough detail to undo' });
  }

  let outcome;
  try {
    outcome = performUndo({
      fromName: meta.from, toName: meta.to, role, clientIds: meta.client_ids.map(Number),
    });
  } catch (err: any) {
    return res.status(409).json({ error: err?.message || 'Undo failed — nothing was changed' });
  }

  logAudit(req, 'reassignment_undone', null, null, {
    reversed_audit_id: Number(req.params.auditId),
    from: meta.to, to: meta.from, role, role_label: ROLE_LABEL[role],
    restored: outcome.restored.length,
    skipped: outcome.skipped.length,
    skipped_detail: outcome.skipped.length ? outcome.skipped : undefined,
    actor: req.manager?.name ?? 'System',
  });

  // Stamp the original so the UI stops offering Undo and the trail is closed.
  db.prepare('UPDATE audit_log SET metadata = ? WHERE id = ?').run(
    JSON.stringify({ ...meta, undone_by: req.manager?.name ?? 'System', undone_at: new Date().toISOString() }),
    req.params.auditId,
  );

  res.json({
    success: true,
    restored: outcome.restored.length,
    skipped: outcome.skipped.length,
    skipped_detail: outcome.skipped,
    message: outcome.skipped.length
      ? `${outcome.restored.length} client(s) restored. ${outcome.skipped.length} were skipped because they have since been reassigned again.`
      : `${outcome.restored.length} client(s) restored to ${meta.from}.`,
  });
});

// ── POST /api/managers/handover/confirm ─────────────────────────────────────
// Cara marks the physical exchange complete; clears the amber registry pill.
router.post('/handover/confirm', requireAuth, (req: AuthRequest, res: Response) => {
  if (!requireBulkPermission(req, res)) return;
  const ids = Array.isArray(req.body?.clientIds) ? req.body.clientIds.map(Number) : [];
  if (!ids.length) return res.status(400).json({ error: 'No clients specified' });

  const before = (db.prepare(
    `SELECT id, ic_company_name, pending_handover_from, pending_handover_to
       FROM accounts WHERE id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids) as any[]).map((r) => Object.assign({}, r));

  const changed = confirmHandover(ids);
  for (const c of before) {
    if (!c.pending_handover_to) continue;
    logAudit(req, 'handover_confirmed', c.ic_company_name, c.id, {
      from: c.pending_handover_from, to: c.pending_handover_to,
    });
  }
  res.json({ success: true, confirmed: changed });
});

// ── GET /api/managers/handover/pending ──────────────────────────────────────
router.get('/handover/pending', requireAuth, (_req: AuthRequest, res: Response) => {
  const rows = (db.prepare(
    `SELECT id, ic_company_name, bc_client_number, pending_handover_from,
            pending_handover_to, pending_handover_role, pending_handover_at
       FROM accounts WHERE COALESCE(pending_handover, 0) = 1
      ORDER BY pending_handover_at DESC`
  ).all() as any[]).map((r) => Object.assign({}, r));
  res.json({ pending: rows, count: rows.length });
});

export default router;
