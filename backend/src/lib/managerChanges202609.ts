// ── One-time manager changes, September 2026 ─────────────────────────────────
// Three data changes Cara asked for, applied at boot because the deployed
// database has no shell (same approach, and the same guard, as
// mailboxUpdates.ts):
//
//   1. Jeremiah Williams — crew → can be an Account Manager
//   2. Brooks Pond ×3   — account_manager: Julie Lynch → Jeremiah Williams
//   3. Odvin Rivas      — every ccm_manager: Odvin Rivas → Fallon Medrano
//
// Each part runs ONCE, recorded against its own settings key, so a later
// correction made in the UI is never overwritten on the next deploy. A part
// that cannot run because a person is missing from the roster does NOT set its
// key — it reports why and tries again on the next boot, once the roster is
// fixed. Rows are only changed when they still hold the expected OLD value
// (compared ignoring case and stray spaces); anything else is left alone and
// named in the report.
//
// The full report — before/after, the Odvin list and count, and which of those
// accounts carry CCM keys — is written to the Audit Log
// ('manager_changes_2026_09_applied') and kept in settings for /api/_diag.

import db from './db';
import { getSetting, setSetting } from './settings';

const ACTOR = 'System deploy';
const KEY = {
  jeremiah: 'mgr_change_2026_09_jeremiah_am_v1',
  brooks: 'mgr_change_2026_09_brooks_pond_v1',
  odvin: 'mgr_change_2026_09_odvin_to_fallon_ccm_v1',
  report: 'mgr_change_2026_09_report',
};

export const JEREMIAH = 'Jeremiah Williams';
export const JULIE = 'Julie Lynch';
export const ODVIN = 'Odvin Rivas';
export const FALLON = 'Fallon Medrano';
export const BROOKS_POND: { bc: string; name: string }[] = [
  { bc: '01014100061', name: 'Brooks Pond Apartments' },
  { bc: '01014100050', name: 'Brooks Pond II' },
  { bc: '01014100613', name: 'Brooks Pond Village' },
];

/** Same comparison the registry reader makes: case, surrounding and non-breaking spaces ignored. */
const norm = (v: any) => String(v ?? '').replace(/ /g, ' ').trim().toLowerCase();
const NAME_SQL = (col: string) =>
  `LOWER(TRIM(REPLACE(COALESCE(${col}, ''), char(160), ' '))) = LOWER(TRIM(?))`;
const obj = (r: any) => (r ? Object.assign({}, r) : null);

function audit(action: string, account: { id: number; name: string } | null, metadata: Record<string, any>) {
  db.prepare(
    'INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)'
  ).run(action, account?.name ?? null, account?.id ?? null, ACTOR, JSON.stringify(metadata));
}

const staffRow = (name: string) =>
  obj(db.prepare(`SELECT * FROM staff_managers WHERE ${NAME_SQL('name')} ORDER BY id LIMIT 1`).get(name));

/** Clear a handover flag as part of a deliberate change, audited. */
function autoVerifyHandover(acct: any, reason: string): boolean {
  if (!Number(acct.pending_handover)) return false;
  db.prepare(`
    UPDATE accounts SET pending_handover = 0, pending_handover_from = NULL, pending_handover_to = NULL,
           pending_handover_role = NULL, pending_handover_at = NULL
     WHERE id = ?
  `).run(acct.id);
  audit('handover_auto_verified', { id: acct.id, name: acct.ic_company_name }, {
    from: acct.pending_handover_from, to: acct.pending_handover_to, role: acct.pending_handover_role,
    reason,
  });
  return true;
}

export interface ManagerChangeReport {
  ran_at: string;
  jeremiah: {
    status: 'applied' | 'already_applied' | 'not_found';
    before?: any; after?: any; open_crew_custody?: number;
  };
  brooks_pond: {
    status: 'applied' | 'already_applied' | 'waiting_for_jeremiah';
    accounts: { bc: string; expected: string; found: string | null; id: number | null;
      before: string | null; after: string | null; result: string }[];
  };
  odvin_to_fallon: {
    status: 'applied' | 'already_applied' | 'fallon_not_eligible';
    reason?: string;
    count: number;
    accounts: { id: number; name: string; bc: string | null; before: string | null; after: string }[];
    with_ccm_keys: { id: number; name: string; keys: Record<string, number>; total: number }[];
  };
  handovers_auto_verified: { id: number; name: string }[];
}

export function applyManagerChanges202609(): ManagerChangeReport {
  const report: ManagerChangeReport = {
    ran_at: new Date().toISOString(),
    jeremiah: { status: 'already_applied' },
    brooks_pond: { status: 'already_applied', accounts: [] },
    odvin_to_fallon: { status: 'already_applied', count: 0, accounts: [], with_ccm_keys: [] },
    handovers_auto_verified: [],
  };
  if (getSetting(KEY.jeremiah) && getSetting(KEY.brooks) && getSetting(KEY.odvin)) {
    return managerChanges202609State() ?? report;
  }
  // A part finished on an earlier boot keeps the details it recorded then.
  const prev = managerChanges202609State();
  if (prev) {
    if (getSetting(KEY.jeremiah)) report.jeremiah = prev.jeremiah;
    if (getSetting(KEY.brooks)) report.brooks_pond = prev.brooks_pond;
    if (getSetting(KEY.odvin)) report.odvin_to_fallon = prev.odvin_to_fallon;
    report.handovers_auto_verified = [...(prev.handovers_auto_verified ?? [])];
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    // ── 1. Jeremiah Williams: crew → Account Manager ─────────────────────────
    if (!getSetting(KEY.jeremiah)) {
      const before = staffRow(JEREMIAH);
      if (!before) {
        report.jeremiah = { status: 'not_found' };
      } else {
        // Still holding keys as crew? Then he is both — AM for his clients, and
        // still the holder of those open custody records.
        const openCrew = Number(obj(db.prepare(
          `SELECT COUNT(*) AS c FROM key_assignments WHERE status = 'checked_out' AND ${NAME_SQL('assignee')}`
        ).get(JEREMIAH)).c) || 0;
        const managerType = openCrew > 0 || before.manager_type === 'both' ? 'both' : 'account_manager';
        // Email and every custody record are deliberately untouched.
        db.prepare('UPDATE staff_managers SET manager_type = ?, role_category = ?, active = 1 WHERE id = ?')
          .run(managerType, 'manager', before.id);
        const after = obj(db.prepare('SELECT * FROM staff_managers WHERE id = ?').get(before.id));
        const pick = (r: any) => ({
          id: r.id, name: r.name, email: r.email ?? null, manager_type: r.manager_type,
          role_category: r.role_category, active: r.active,
        });
        report.jeremiah = { status: 'applied', before: pick(before), after: pick(after), open_crew_custody: openCrew };
        audit('staff_manager_updated', null, {
          staff_id: before.id, name: before.name, before: pick(before), after: pick(after),
          reason: 'Prepared to be an Account Manager (Brooks Pond)', open_crew_custody: openCrew,
        });
        setSetting(KEY.jeremiah, report.ran_at, ACTOR);
      }
    }

    // ── 2. Brooks Pond: Julie Lynch → Jeremiah Williams (AM) ─────────────────
    if (!getSetting(KEY.brooks)) {
      const jeremiah = staffRow(JEREMIAH);
      const canAm = jeremiah && ['manager', 'both'].includes(jeremiah.role_category ?? 'manager')
        && ['account_manager', 'both'].includes(jeremiah.manager_type);
      if (!canAm) {
        report.brooks_pond = { status: 'waiting_for_jeremiah', accounts: [] };
      } else {
        const newName = String(jeremiah.name).trim();
        for (const b of BROOKS_POND) {
          const acct = obj(db.prepare('SELECT * FROM accounts WHERE bc_client_number = ?').get(b.bc));
          const line = {
            bc: b.bc, expected: b.name, found: acct?.ic_company_name ?? null, id: acct?.id ?? null,
            before: acct?.account_manager ?? null, after: acct?.account_manager ?? null, result: '',
          };
          if (!acct) line.result = 'not found — no client with this BC Client #';
          else if (norm(acct.account_manager) === norm(newName)) line.result = 'already Jeremiah Williams';
          else if (norm(acct.account_manager) !== norm(JULIE)) {
            line.result = `left alone — AM is "${acct.account_manager ?? ''}", not ${JULIE}`;
          } else {
            db.prepare('UPDATE accounts SET account_manager = ? WHERE id = ?').run(newName, acct.id);
            line.after = newName;
            line.result = 'changed';
            audit('account_manager_changed', { id: acct.id, name: acct.ic_company_name }, {
              field: 'account_manager', old: acct.account_manager, new: newName,
              summary: `Account Manager: ${acct.account_manager} → ${newName}`,
            });
          }
          if (acct && line.after && norm(line.after) === norm(newName) && autoVerifyHandover(acct, 'Account Manager set directly to Jeremiah Williams')) {
            report.handovers_auto_verified.push({ id: acct.id, name: acct.ic_company_name });
          }
          report.brooks_pond.accounts.push(line);
        }
        report.brooks_pond.status = 'applied';
        setSetting(KEY.brooks, report.ran_at, ACTOR);
      }
    }

    // ── 3. Odvin Rivas → Fallon Medrano, every CCM account ───────────────────
    if (!getSetting(KEY.odvin)) {
      const fallon = staffRow(FALLON);
      const canCcm = fallon && ['manager', 'both'].includes(fallon.role_category ?? 'manager')
        && ['ccm', 'both'].includes(fallon.manager_type);
      if (!canCcm) {
        report.odvin_to_fallon = {
          status: 'fallon_not_eligible', count: 0, accounts: [], with_ccm_keys: [],
          reason: fallon
            ? `${fallon.name} is on the roster as ${fallon.manager_type}/${fallon.role_category}, which cannot hold CCM`
            : `${FALLON} is not on the staff roster`,
        };
      } else {
        const newName = String(fallon.name).trim();
        const rows = (db.prepare(
          `SELECT * FROM accounts WHERE ${NAME_SQL('ccm_manager')} ORDER BY ic_company_name`
        ).all(ODVIN) as any[]).map(obj);
        for (const a of rows) {
          db.prepare('UPDATE accounts SET ccm_manager = ? WHERE id = ?').run(newName, a.id);
          audit('ccm_manager_changed', { id: a.id, name: a.ic_company_name }, {
            field: 'ccm_manager', old: a.ccm_manager, new: newName,
            summary: `CCM: ${a.ccm_manager} → ${newName}`,
          });
          report.odvin_to_fallon.accounts.push({
            id: a.id, name: a.ic_company_name, bc: a.bc_client_number ?? null, before: a.ccm_manager, after: newName,
          });
          const keys = {
            metal: Number(a.ccm_metal) || 0, card: Number(a.ccm_card) || 0,
            fob: Number(a.ccm_fob) || 0, dispenser: Number(a.ccm_dispenser) || 0,
          };
          const total = keys.metal + keys.card + keys.fob + keys.dispenser;
          if (total > 0) report.odvin_to_fallon.with_ccm_keys.push({ id: a.id, name: a.ic_company_name, keys, total });
          if (autoVerifyHandover(a, 'CCM set directly to Fallon Medrano')) {
            report.handovers_auto_verified.push({ id: a.id, name: a.ic_company_name });
          }
        }
        report.odvin_to_fallon.status = 'applied';
        report.odvin_to_fallon.count = rows.length;
        setSetting(KEY.odvin, report.ran_at, ACTOR);
      }
    }

    audit('manager_changes_2026_09_applied', null, report as any);
    setSetting(KEY.report, JSON.stringify(report), ACTOR);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    throw e;
  }
  return report;
}

/** The last report, for /api/_diag — so the outcome is readable without a shell. */
export function managerChanges202609State(): ManagerChangeReport | null {
  try { return JSON.parse(getSetting(KEY.report) ?? 'null'); } catch { return null; }
}
