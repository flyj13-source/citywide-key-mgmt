import ExcelJS from 'exceljs';
import db from './db';
import { accountManagerRoster, ccmRoster } from '../routes/managers';
import { staffRoster } from '../routes/staff';

// ── On-demand registry export ────────────────────────────────────────────────
// Builds the Key Registry as xlsx (primary) or csv from the SAME queries the
// on-screen tabs use, so "what I see is what I get". Column order mirrors each
// tab exactly.
//
// SECURITY: decrypted door/alarm codes are NEVER emitted. Where the screen
// shows a reveal button, the export shows a non-secret "Has Door Code" /
// "Has Alarm Code" Yes/No derived from whether the ciphertext exists. The audit
// log records every export (caller does the logging with the row count we
// return here).

export type ExportTab = 'customer' | 'ic' | 'am' | 'ccm' | 'office' | 'cwemployees' | 'all' | 'archived';

export interface ExportOpts {
  scope: 'current' | 'all';
  tab: ExportTab;
  search?: string;
  includeArchived?: boolean;
}

interface Column { header: string; key: string; width: number }
export interface SheetSpec { name: string; columns: Column[]; rows: Record<string, any>[] }

// null → '' (unset stays distinct from an explicit No), 1 → 'Yes', 0 → 'No'.
const yn = (v: any): string => (v === null || v === undefined ? '' : v ? 'Yes' : 'No');
const has = (v: any): string => (v ? 'Yes' : 'No');

// Build the accounts WHERE clause + params for an account-based tab, honoring
// search + archived exactly like GET /api/accounts.
function accountWhere(
  kind: 'customer' | 'ic' | 'office' | 'all' | 'archived',
  opts: { search?: string; includeArchived?: boolean },
): { sql: string; params: any[] } {
  let sql = '1=1';
  const params: any[] = [];

  if (kind === 'archived') {
    sql += ' AND archived = 1';
  } else if (opts.includeArchived) {
    // no archived filter → include both
  } else {
    sql += ' AND COALESCE(archived, 0) = 0';
  }

  if (kind === 'customer' || kind === 'office') sql += " AND record_type = 'customer'";
  else if (kind === 'ic') sql += " AND (record_type = 'ic' OR record_type IS NULL)";
  if (kind === 'office') sql += ' AND COALESCE(office_keys_held, 0) > 0';

  if (opts.search) {
    sql += ' AND (ic_company_name LIKE ? OR notes LIKE ? OR bc_vendor_number LIKE ? OR bc_client_number LIKE ? OR ic_name LIKE ? OR account_manager LIKE ?)';
    const s = `%${opts.search}%`;
    params.push(s, s, s, s, s, s);
  }
  return { sql, params };
}

function fetchAccounts(kind: 'customer' | 'ic' | 'office' | 'all' | 'archived', opts: ExportOpts): any[] {
  const { sql, params } = accountWhere(kind, opts);
  return (db.prepare(`SELECT * FROM accounts WHERE ${sql} ORDER BY ic_company_name ASC`).all(...params) as any[])
    .map((a) => Object.assign({}, a));
}

// ── Per-tab sheet builders (columns mirror the on-screen order) ──────────────

function customerSheet(name: string, kind: 'customer' | 'office', opts: ExportOpts): SheetSpec {
  const columns: Column[] = [
    { header: 'Client Name', key: 'ic_company_name', width: 34 },
    { header: 'BC Client #', key: 'bc_client_number', width: 15 },
    { header: 'Independent Contractor', key: 'ic_name', width: 28 },
    { header: 'BC Vendor #', key: 'bc_vendor_number', width: 15 },
    { header: 'Account Manager', key: 'account_manager', width: 20 },
    { header: 'Contract Compliance Manager', key: 'ccm_manager', width: 24 },
    { header: 'Keys Y/N', key: 'keys_yn', width: 9 },
    { header: 'Security App Y/N', key: 'security_app_yn', width: 15 },
    { header: 'Metal Keys', key: 'metal_keys', width: 10 },
    { header: 'Key Cards', key: 'key_cards', width: 10 },
    { header: 'Key Fobs', key: 'has_fob', width: 9 },
    { header: 'Dispenser Key', key: 'dispenser_keys', width: 12 },
    { header: 'IC Keys', key: 'contractor_keys', width: 9 },
    { header: 'AM Keys', key: 'am_keys', width: 9 },
    { header: 'CCM Keys', key: 'ccm_keys', width: 9 },
    { header: 'Office Keys', key: 'office_keys_held', width: 11 },
    { header: 'Lockbox Code', key: 'lockbox_code', width: 14 },
    { header: 'Has Door Code', key: 'has_door', width: 13 },
    { header: 'Has Alarm Code', key: 'has_alarm', width: 14 },
    { header: 'Notes', key: 'notes', width: 40 },
    ...(opts.includeArchived ? [{ header: 'Archived', key: 'archived', width: 9 } as Column] : []),
  ];
  const rows = fetchAccounts(kind, opts).map((a) => ({
    ...a,
    keys_yn: yn(a.keys_yn),
    security_app_yn: yn(a.security_app_yn),
    has_door: has(a.door_code_encrypted),
    has_alarm: has(a.alarm_code_encrypted),
    archived: a.archived ? 'Yes' : 'No',
  }));
  return { name, columns, rows };
}

function icSheet(opts: ExportOpts): SheetSpec {
  const columns: Column[] = [
    { header: 'Independent Contractor', key: 'ic_company_name', width: 34 },
    { header: 'BC Vendor Number', key: 'bc_vendor_number', width: 18 },
    { header: 'Keys Y/N', key: 'keys_yn', width: 9 },
    { header: 'Security App Y/N', key: 'security_app_yn', width: 15 },
    { header: 'Metal Keys', key: 'metal_keys', width: 10 },
    { header: 'Key Cards', key: 'key_cards', width: 10 },
    { header: 'Key Fobs', key: 'has_fob', width: 9 },
    { header: 'Dispenser Key', key: 'dispenser_keys', width: 12 },
    { header: 'Lockbox Code', key: 'lockbox_code', width: 14 },
    { header: 'Has Door Code', key: 'has_door', width: 13 },
    { header: 'Has Alarm Code', key: 'has_alarm', width: 14 },
    { header: 'Notes', key: 'notes', width: 40 },
    ...(opts.includeArchived ? [{ header: 'Archived', key: 'archived', width: 9 } as Column] : []),
  ];
  const rows = fetchAccounts('ic', opts).map((a) => ({
    ...a,
    keys_yn: yn(a.keys_yn),
    security_app_yn: yn(a.security_app_yn),
    has_door: has(a.door_code_encrypted),
    has_alarm: has(a.alarm_code_encrypted),
    archived: a.archived ? 'Yes' : 'No',
  }));
  return { name: 'IC Vendors', columns, rows };
}

function allSheet(opts: ExportOpts): SheetSpec {
  const columns: Column[] = [
    { header: 'Name', key: 'ic_company_name', width: 34 },
    { header: 'BC Vendor Number', key: 'bc_vendor_number', width: 18 },
    { header: 'Keys Y/N', key: 'keys_yn', width: 9 },
    { header: 'Security App Y/N', key: 'security_app_yn', width: 15 },
    { header: 'Metal Keys', key: 'metal_keys', width: 10 },
    { header: 'Key Cards', key: 'key_cards', width: 10 },
    { header: 'Key Fobs', key: 'has_fob', width: 9 },
    { header: 'Dispenser Key', key: 'dispenser_keys', width: 12 },
    { header: 'Lockbox Code', key: 'lockbox_code', width: 14 },
    { header: 'Has Door Code', key: 'has_door', width: 13 },
    { header: 'Has Alarm Code', key: 'has_alarm', width: 14 },
    { header: 'Notes', key: 'notes', width: 40 },
    { header: 'Type', key: 'type', width: 10 },
    ...(opts.includeArchived ? [{ header: 'Archived', key: 'archived', width: 9 } as Column] : []),
  ];
  const rows = fetchAccounts('all', opts).map((a) => ({
    ...a,
    keys_yn: yn(a.keys_yn),
    security_app_yn: yn(a.security_app_yn),
    has_door: has(a.door_code_encrypted),
    has_alarm: has(a.alarm_code_encrypted),
    type: a.record_type === 'customer' ? 'Customer' : 'IC',
    archived: a.archived ? 'Yes' : 'No',
  }));
  return { name: 'All Records', columns, rows };
}

function archivedSheet(opts: ExportOpts): SheetSpec {
  const columns: Column[] = [
    { header: 'Name', key: 'ic_company_name', width: 34 },
    { header: 'BC #', key: 'bc', width: 16 },
    { header: 'Type', key: 'type', width: 10 },
    { header: 'Archived by', key: 'archived_by', width: 20 },
    { header: 'Archived on', key: 'archived_at', width: 22 },
  ];
  const rows = fetchAccounts('archived', opts).map((a) => ({
    ic_company_name: a.ic_company_name,
    bc: a.record_type === 'customer' ? a.bc_client_number : a.bc_vendor_number,
    type: a.record_type === 'customer' ? 'Customer' : 'IC',
    archived_by: a.archived_by,
    archived_at: a.archived_at,
  }));
  return { name: 'Archived', columns, rows };
}

function amSheet(role: 'am' | 'ccm'): SheetSpec {
  const columns: Column[] = [
    { header: role === 'am' ? 'Account Manager' : 'Contract Compliance Manager', key: 'person', width: 26 },
    { header: 'Clients Managed', key: 'clients_managed', width: 15 },
    { header: 'Personal Metal', key: 'personal_metal', width: 13 },
    { header: 'Personal Cards', key: 'personal_cards', width: 13 },
    { header: 'Personal Fobs', key: 'personal_fobs', width: 13 },
    { header: 'Personal Dispenser', key: 'personal_dispenser', width: 17 },
    { header: 'Total Held', key: 'total_held', width: 11 },
    { header: 'Client Metal', key: 'metal_keys', width: 12 },
    { header: 'Client Cards', key: 'key_cards', width: 12 },
    { header: 'Client Fobs', key: 'key_fobs', width: 11 },
    { header: 'Client Dispenser', key: 'dispenser_keys', width: 15 },
    { header: 'Total Client Keys', key: 'total_client_keys', width: 16 },
  ];
  const rows = role === 'am' ? accountManagerRoster() : ccmRoster();
  return { name: role === 'am' ? 'Account Managers' : 'CCM', columns, rows };
}

function cwEmployeesSheet(): SheetSpec {
  const columns: Column[] = [
    { header: 'Name', key: 'name', width: 24 },
    { header: 'Role', key: 'role_label', width: 24 },
    { header: 'Shift', key: 'shift_text', width: 14 },
    { header: 'Day/Night', key: 'day_night', width: 11 },
    { header: 'Keys Held', key: 'keys_text', width: 32 },
    { header: 'Total Keys Held', key: 'total_keys_held', width: 15 },
    { header: 'Accounts Assigned', key: 'accounts_assigned', width: 17 },
    { header: 'Active', key: 'active', width: 8 },
  ];
  const rows = staffRoster({ includeInactive: true }).map((s: any) => {
    const shift_text = [s.shift ? `${s.shift} shift` : null, s.day_night ? s.day_night[0].toUpperCase() + s.day_night.slice(1) : null]
      .filter(Boolean).join(' · ');
    const keys_text = [
      s.keys_metal ? `${s.keys_metal} metal` : null,
      s.keys_card ? `${s.keys_card} card` : null,
      s.keys_fob ? `${s.keys_fob} fob` : null,
      s.keys_dispenser ? `${s.keys_dispenser} dispenser` : null,
      s.keys_other ? `${s.keys_other} other` : null,
    ].filter(Boolean).join(' · ');
    return {
      name: s.name,
      role_label: s.role_label,
      shift_text,
      day_night: s.day_night ? s.day_night[0].toUpperCase() + s.day_night.slice(1) : '',
      keys_text,
      total_keys_held: s.total_keys_held,
      accounts_assigned: s.accounts_assigned,
      active: s.active === 1 ? 'Yes' : 'No',
    };
  });
  return { name: 'CW Employees', columns, rows };
}

// Build the sheet(s) for a request. `current` → just the active tab; `all` →
// the six registry tabs, one sheet each.
export function buildSheets(opts: ExportOpts): SheetSpec[] {
  if (opts.scope === 'all') {
    return [
      customerSheet('Customers', 'customer', opts),
      icSheet(opts),
      amSheet('am'),
      amSheet('ccm'),
      customerSheet('Office', 'office', opts),
      cwEmployeesSheet(),
    ];
  }
  switch (opts.tab) {
    case 'customer': return [customerSheet('Customers', 'customer', opts)];
    case 'office': return [customerSheet('Office', 'office', opts)];
    case 'ic': return [icSheet(opts)];
    case 'am': return [amSheet('am')];
    case 'ccm': return [amSheet('ccm')];
    case 'cwemployees': return [cwEmployeesSheet()];
    case 'archived': return [archivedSheet(opts)];
    case 'all':
    default: return [allSheet(opts)];
  }
}

export function countRows(sheets: SheetSpec[]): number {
  return sheets.reduce((n, s) => n + s.rows.length, 0);
}

// ── Renderers ────────────────────────────────────────────────────────────────
export async function sheetsToXlsx(sheets: SheetSpec[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'City Wide Boston Key Management';
  wb.created = new Date();
  for (const spec of sheets) {
    const ws = wb.addWorksheet(spec.name.slice(0, 31));
    ws.columns = spec.columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A1A' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const row of spec.rows) ws.addRow(row);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const csvCell = (v: any): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function sheetsToCsv(sheets: SheetSpec[]): Buffer {
  const blocks: string[] = [];
  for (const spec of sheets) {
    const lines: string[] = [];
    if (sheets.length > 1) lines.push(`# ${spec.name}`);
    lines.push(spec.columns.map((c) => csvCell(c.header)).join(','));
    for (const row of spec.rows) {
      lines.push(spec.columns.map((c) => csvCell(row[c.key])).join(','));
    }
    blocks.push(lines.join('\r\n'));
  }
  return Buffer.from(blocks.join('\r\n\r\n'), 'utf8');
}
