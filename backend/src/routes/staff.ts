import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';
import { logAudit } from '../lib/audit';

const router = Router();

// ── Unified City Wide staff roster ("CW Boston Employees") ───────────────────
// ONE endpoint over the whole staff_managers table — managers AND field crew —
// with per-person key-holding aggregates. Key holdings are resolved by NAME
// against the live source data; no client row or check-out is ever mutated here.
//
//   Managers hold keys via the holder grid on their clients: the am_* columns
//   at clients where they are Account Manager + the ccm_* columns where they are
//   CCM. Crew hold keys via key_assignments currently checked out to them. A
//   'both' person holds via BOTH paths (summed, accounts de-duplicated).

const CLIENT_FILTER = `
  record_type = 'customer'
  AND COALESCE(archived, 0) = 0
  AND (bc_client_number IS NULL OR bc_client_number NOT LIKE '999%')
`;

type KeyBreakdown = { metal: number; card: number; fob: number; dispenser: number; other: number };
const emptyBreakdown = (): KeyBreakdown => ({ metal: 0, card: 0, fob: 0, dispenser: 0, other: 0 });
const breakdownTotal = (b: KeyBreakdown) => b.metal + b.card + b.fob + b.dispenser + b.other;

const isManagerCat = (rc: string | null) => rc === 'manager' || rc === 'both';
const isCrewCat = (rc: string | null) => rc === 'crew' || rc === 'both';

// manager_type is stored as the sentinel 'crew' for pure-crew rows (the column
// is NOT NULL). Surface it as null so the API never leaks the sentinel.
function surfaceManagerType(manager_type: string | null, role_category: string | null): string | null {
  if (role_category === 'crew') return null;
  return manager_type === 'crew' ? null : manager_type;
}

function roleLabel(manager_type: string | null, role_category: string | null): string {
  const mt = surfaceManagerType(manager_type, role_category);
  const mgrLabel = mt === 'both' ? 'AM + CCM' : mt === 'account_manager' ? 'Account Manager (AM)' : mt === 'ccm' ? 'CCM' : null;
  if (role_category === 'both') return `${mgrLabel ?? 'Manager'} + Crew`;
  if (role_category === 'crew') return 'Crew';
  return mgrLabel ?? 'Manager';
}

// Bucket a checked-out assignment into a key type. Assignment data carries only
// a free-text key_type / keys_held, so this is best-effort; anything we can't
// classify lands honestly in "other" rather than being guessed into a type.
function bucketAssignment(key_type: string | null, keys_held: string | null): keyof KeyBreakdown {
  const s = `${key_type ?? ''} ${keys_held ?? ''}`.toLowerCase();
  if (/\bcard\b|keycard|key card/.test(s)) return 'card';
  if (/\bfob\b/.test(s)) return 'fob';
  if (/dispenser/.test(s)) return 'dispenser';
  if (/metal/.test(s)) return 'metal';
  return 'other';
}

interface Gathered {
  keys: KeyBreakdown;
  total_keys_held: number;
  accounts_assigned: number;
  // detail-only
  holdings?: any[];
  accounts?: any[];
}

// Compute a person's key holdings + assigned accounts. `detail` adds the
// per-account holdings list and the merged account list for the detail page.
function gatherStaff(row: any, detail = false): Gathered {
  const name = row.name as string;
  const rc = (row.role_category ?? 'manager') as string;
  const mt = surfaceManagerType(row.manager_type, rc);
  const includeAm = isManagerCat(rc) && (mt === 'account_manager' || mt === 'both');
  const includeCcm = isManagerCat(rc) && (mt === 'ccm' || mt === 'both');

  const keys = emptyBreakdown();
  const holdings: any[] = [];
  // Union of assigned accounts, keyed by a stable id (prefer account_id).
  const acctKeys = new Set<string>();
  const acctList: any[] = [];
  const addAccount = (idKey: string, obj: any) => {
    if (acctKeys.has(idKey)) return;
    acctKeys.add(idKey);
    if (detail) acctList.push(obj);
  };

  if ((includeAm || includeCcm) && name && name.trim()) {
    // One pass over the person's managed clients; attribute the grid columns for
    // whichever role(s) they hold at each client.
    const clauses: string[] = [];
    const params: any[] = [];
    if (includeAm) { clauses.push('account_manager = ?'); params.push(name); }
    if (includeCcm) { clauses.push('ccm_manager = ?'); params.push(name); }
    const rows = db.prepare(`
      SELECT id, ic_company_name, bc_client_number, ic_name, account_manager, ccm_manager,
             COALESCE(am_metal,0) am_metal, COALESCE(am_card,0) am_card, COALESCE(am_fob,0) am_fob, COALESCE(am_dispenser,0) am_dispenser,
             COALESCE(ccm_metal,0) ccm_metal, COALESCE(ccm_card,0) ccm_card, COALESCE(ccm_fob,0) ccm_fob, COALESCE(ccm_dispenser,0) ccm_dispenser,
             COALESCE(am_keys,0) am_keys, COALESCE(ccm_keys,0) ccm_keys
      FROM accounts
      WHERE ${CLIENT_FILTER} AND (${clauses.join(' OR ')})
      ORDER BY ic_company_name ASC
    `).all(...params) as any[];

    for (const raw of rows) {
      const c = Object.assign({}, raw);
      const asAm = includeAm && c.account_manager === name;
      const asCcm = includeCcm && c.ccm_manager === name;
      let hereTotal = 0;
      const here = emptyBreakdown();
      if (asAm) { here.metal += c.am_metal; here.card += c.am_card; here.fob += c.am_fob; here.dispenser += c.am_dispenser; }
      if (asCcm) { here.metal += c.ccm_metal; here.card += c.ccm_card; here.fob += c.ccm_fob; here.dispenser += c.ccm_dispenser; }
      hereTotal = breakdownTotal(here);
      keys.metal += here.metal; keys.card += here.card; keys.fob += here.fob; keys.dispenser += here.dispenser;

      const roleParts: string[] = [];
      if (asAm) roleParts.push('AM');
      if (asCcm) roleParts.push('CCM');
      addAccount(`acct:${c.id}`, {
        id: c.id,
        name: c.ic_company_name,
        bc_client_number: c.bc_client_number,
        ic_name: c.ic_name,
        role: roleParts.join(' + ') || '—',
        source: 'manager',
        keys_here: hereTotal,
      });
      if (detail && hereTotal > 0) {
        holdings.push({
          source: 'manager', account_id: c.id, account_name: c.ic_company_name,
          role: roleParts.join(' + '), ...here, total: hereTotal,
        });
      }
    }
  }

  if (isCrewCat(rc) && name && name.trim()) {
    const rows = db.prepare(`
      SELECT id, account_id, account_name, key_type, keys_held, checked_out_at, due_at
      FROM key_assignments
      WHERE assignee = ? AND status = 'checked_out'
      ORDER BY checked_out_at DESC
    `).all(name) as any[];

    for (const raw of rows) {
      const a = Object.assign({}, raw);
      const bucket = bucketAssignment(a.key_type, a.keys_held);
      keys[bucket] += 1; // one currently-held key per open assignment
      const acctKey = a.account_id != null ? `acct:${a.account_id}` : `name:${String(a.account_name || '').toLowerCase()}`;
      addAccount(acctKey, {
        id: a.account_id ?? null,
        name: a.account_name,
        bc_client_number: null,
        ic_name: null,
        role: 'Crew',
        source: 'crew',
        keys_here: 1,
      });
      if (detail) {
        holdings.push({
          source: 'crew', assignment_id: a.id, account_id: a.account_id ?? null,
          account_name: a.account_name, key_type: a.key_type, keys_held: a.keys_held,
          bucket, checked_out_at: a.checked_out_at, due_at: a.due_at,
        });
      }
    }
  }

  const result: Gathered = {
    keys,
    total_keys_held: breakdownTotal(keys),
    accounts_assigned: acctKeys.size,
  };
  if (detail) { result.holdings = holdings; result.accounts = acctList; }
  return result;
}

function serialize(row: any, detail = false) {
  const r = Object.assign({}, row);
  const g = gatherStaff(r, detail);
  const base = {
    id: r.id,
    name: r.name,
    role_category: r.role_category ?? 'manager',
    manager_type: surfaceManagerType(r.manager_type, r.role_category ?? 'manager'),
    role_label: roleLabel(r.manager_type, r.role_category ?? 'manager'),
    shift: r.shift ?? null,
    day_night: r.day_night ?? null,
    email: r.email ?? null,
    phone: r.phone ?? null,
    active: r.active === null || r.active === undefined ? 1 : Number(r.active),
    login_manager_id: r.login_manager_id ?? null,
    created_at: r.created_at,
    keys_metal: g.keys.metal,
    keys_card: g.keys.card,
    keys_fob: g.keys.fob,
    keys_dispenser: g.keys.dispenser,
    keys_other: g.keys.other,
    total_keys_held: g.total_keys_held,
    accounts_assigned: g.accounts_assigned,
  };
  if (detail) return { ...base, holdings: g.holdings, accounts: g.accounts };
  return base;
}

// ── GET /api/staff — unified roster with key aggregates ──────────────────────
// Returns a JSON array (so existing count consumers keep working). Query:
//   ?category=all|managers|crew  (default all)
//   ?include_inactive=1          (default: active only)
router.get('/', requireAuth, (req: AuthRequest, res: Response) => {
  const includeInactive = req.query.include_inactive === '1' || req.query.include_inactive === 'true';
  const category = String(req.query.category || 'all');

  const where: string[] = [];
  if (!includeInactive) where.push('COALESCE(active, 1) = 1');
  if (category === 'managers') where.push("(role_category IN ('manager', 'both') OR role_category IS NULL)");
  else if (category === 'crew') where.push("role_category IN ('crew', 'both')");
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db.prepare(`SELECT * FROM staff_managers ${whereSql} ORDER BY name ASC`).all();
  res.json(rows.map((r) => serialize(r)));
});

// ── GET /api/staff/:id — one staff member + holdings + accounts ──────────────
router.get('/:id', requireAuth, (req: AuthRequest, res: Response) => {
  const row = db.prepare('SELECT * FROM staff_managers WHERE id = ?').get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: 'Staff member not found' });
  res.json({ staff: serialize(row, true) });
});

// ── PATCH /api/staff/:id — edit (incl. soft-deactivate) ──────────────────────
// Reuses the roster-edit contract. Never hard-deletes. Audited.
const VALID_TYPES = ['account_manager', 'ccm', 'both'];
const VALID_SHIFTS = ['1st', '2nd', '3rd'];
const VALID_DAY_NIGHT = ['day', 'night'];
const cleanText = (v: any): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};
const cleanEnum = (v: any, allowed: string[]): string | null => {
  if (v === undefined || v === null || v === '') return null;
  return allowed.includes(v) ? v : null;
};

router.patch('/:id', requireAuth, (req: AuthRequest, res: Response) => {
  const existing = db.prepare('SELECT * FROM staff_managers WHERE id = ?').get(req.params.id) as any;
  if (!existing) return res.status(404).json({ error: 'Staff member not found' });
  const rc = (existing.role_category ?? 'manager') as string;

  const updates: string[] = [];
  const params: any[] = [];
  const changed: Record<string, any> = {};

  if ('name' in req.body) {
    const name = cleanText(req.body.name);
    if (!name) return res.status(400).json({ error: 'Name cannot be empty' });
    updates.push('name = ?'); params.push(name); changed.name = name;
  }
  if ('manager_type' in req.body) {
    if (!isManagerCat(rc)) return res.status(400).json({ error: 'Crew members have no manager type' });
    if (!VALID_TYPES.includes(req.body.manager_type)) {
      return res.status(400).json({ error: "manager_type must be one of 'account_manager', 'ccm', 'both'" });
    }
    updates.push('manager_type = ?'); params.push(req.body.manager_type); changed.manager_type = req.body.manager_type;
  }
  if ('shift' in req.body) {
    const shift = cleanEnum(req.body.shift, VALID_SHIFTS);
    updates.push('shift = ?'); params.push(shift); changed.shift = shift;
  }
  if ('day_night' in req.body) {
    const dn = cleanEnum(req.body.day_night, VALID_DAY_NIGHT);
    updates.push('day_night = ?'); params.push(dn); changed.day_night = dn;
  }
  if ('email' in req.body) {
    const email = cleanText(req.body.email);
    updates.push('email = ?'); params.push(email); changed.email = email;
  }
  if ('phone' in req.body) {
    const phone = cleanText(req.body.phone);
    updates.push('phone = ?'); params.push(phone); changed.phone = phone;
  }
  if ('active' in req.body) {
    const active = req.body.active === 0 || req.body.active === false || req.body.active === '0' ? 0 : 1;
    updates.push('active = ?'); params.push(active); changed.active = active;
  }

  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

  params.push(req.params.id);
  db.prepare(`UPDATE staff_managers SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const action = 'active' in changed && changed.active === 0
    ? 'staff_deactivated'
    : ('active' in changed && changed.active === 1 && existing.active === 0 ? 'staff_reactivated' : 'staff_edited');
  logAudit(req, action, changed.name ?? existing.name, null, { id: Number(req.params.id), changes: changed });

  const updated = db.prepare('SELECT * FROM staff_managers WHERE id = ?').get(req.params.id);
  res.json({ staff: serialize(updated, true) });
});

export default router;
