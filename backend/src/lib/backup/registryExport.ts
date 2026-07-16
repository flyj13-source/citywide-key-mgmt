import { DatabaseSync } from 'node:sqlite';
import ExcelJS from 'exceljs';

// Human-readable secondary backup: the full registry as an .xlsx a person could
// re-key or re-import from if the .db artifact were ever unusable. Deliberately
// EXCLUDES every secret: no *_encrypted / *_iv columns, no manager password
// hashes. The encrypted access codes can't be represented in plaintext here
// (and we never decrypt them for a backup), so they simply aren't included —
// they live only inside the .db snapshot.

const HEADER_FILL = 'FF1A1A1A';

function styleHeader(ws: ExcelJS.Worksheet) {
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

/** Build the registry workbook from a DB file and return it as an xlsx buffer. */
export async function buildRegistryWorkbook(dbFile: string): Promise<{ buffer: Buffer; accountRows: number }> {
  const db = new DatabaseSync(dbFile);
  try {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'City Wide Boston Key Management — Automated Backup';
    wb.created = new Date();

    // ── Accounts + the full holder×type key grid ─────────────────────────────
    const accounts = (db.prepare('SELECT * FROM accounts ORDER BY ic_company_name ASC, id ASC').all() as any[]).map(
      (a) => Object.assign({}, a)
    );
    const ws = wb.addWorksheet('Accounts');
    ws.columns = [
      { header: 'Record Type', key: 'record_type', width: 12 },
      { header: 'Client / Company', key: 'ic_company_name', width: 34 },
      { header: 'BC Client #', key: 'bc_client_number', width: 15 },
      { header: 'IC Name', key: 'ic_name', width: 28 },
      { header: 'BC Vendor #', key: 'bc_vendor_number', width: 15 },
      { header: 'Account Manager', key: 'account_manager', width: 20 },
      { header: 'Contract Compliance Mgr', key: 'ccm_manager', width: 22 },
      { header: 'Keys Y/N', key: 'keys_yn', width: 9 },
      { header: 'Security App', key: 'security_app_yn', width: 12 },
      // Client-site inventory (row totals)
      { header: 'Metal', key: 'metal_keys', width: 8 },
      { header: 'Cards', key: 'key_cards', width: 8 },
      { header: 'Fobs', key: 'has_fob', width: 8 },
      { header: 'Dispenser', key: 'dispenser_keys', width: 10 },
      // Holder × type grid — 16 cells
      { header: 'AM Metal', key: 'am_metal', width: 9 },
      { header: 'AM Card', key: 'am_card', width: 9 },
      { header: 'AM Fob', key: 'am_fob', width: 9 },
      { header: 'AM Disp', key: 'am_dispenser', width: 9 },
      { header: 'CCM Metal', key: 'ccm_metal', width: 9 },
      { header: 'CCM Card', key: 'ccm_card', width: 9 },
      { header: 'CCM Fob', key: 'ccm_fob', width: 9 },
      { header: 'CCM Disp', key: 'ccm_dispenser', width: 9 },
      { header: 'IC Metal', key: 'contractor_metal', width: 9 },
      { header: 'IC Card', key: 'contractor_card', width: 9 },
      { header: 'IC Fob', key: 'contractor_fob', width: 9 },
      { header: 'IC Disp', key: 'contractor_dispenser', width: 9 },
      { header: 'Office Metal', key: 'office_metal', width: 10 },
      { header: 'Office Card', key: 'office_card', width: 10 },
      { header: 'Office Fob', key: 'office_fob', width: 10 },
      { header: 'Office Disp', key: 'office_dispenser', width: 10 },
      // Column totals
      { header: 'AM Keys', key: 'am_keys', width: 9 },
      { header: 'CCM Keys', key: 'ccm_keys', width: 9 },
      { header: 'IC Keys', key: 'contractor_keys', width: 9 },
      { header: 'Office Keys', key: 'office_keys_held', width: 11 },
      // Non-secret extras
      { header: 'Lockbox Code', key: 'lockbox_code', width: 14 },
      { header: 'Notes', key: 'notes', width: 40 },
      { header: 'Status', key: 'status', width: 10 },
      { header: 'Archived', key: 'archived', width: 9 },
    ];
    styleHeader(ws);
    for (const a of accounts) {
      ws.addRow({
        ...a,
        keys_yn: a.keys_yn ? 'Y' : 'N',
        security_app_yn: a.security_app_yn ? 'Y' : 'N',
        archived: a.archived ? 'Y' : '',
      });
    }

    // ── Managers (identity only — NEVER password_hash) ───────────────────────
    const wsM = wb.addWorksheet('Managers');
    wsM.columns = [
      { header: 'Name', key: 'name', width: 24 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Role', key: 'role', width: 12 },
      { header: 'Can Delete', key: 'can_delete', width: 11 },
      { header: 'Test Account', key: 'is_test', width: 12 },
    ];
    styleHeader(wsM);
    const mgrCols = new Set(
      (db.prepare('PRAGMA table_info(managers)').all() as any[]).map((c) => Object.assign({}, c).name)
    );
    const managers = (db.prepare('SELECT * FROM managers ORDER BY name ASC').all() as any[]).map((m) =>
      Object.assign({}, m)
    );
    for (const m of managers) {
      wsM.addRow({
        name: m.name,
        email: m.email,
        role: m.role,
        can_delete: mgrCols.has('can_delete') ? (m.can_delete ? 'Y' : 'N') : '',
        is_test: mgrCols.has('is_test') ? (m.is_test ? 'Y' : 'N') : '',
      });
    }

    // ── Cover sheet: what this file is + timestamp ───────────────────────────
    const cover = wb.addWorksheet('README');
    cover.columns = [{ width: 24 }, { width: 80 }];
    cover.addRow(['City Wide Boston', 'Key Management — human-readable registry export']);
    cover.addRow(['Generated (UTC)', new Date().toISOString()]);
    cover.addRow(['Accounts', String(accounts.length)]);
    cover.addRow(['Managers', String(managers.length)]);
    cover.addRow(['', '']);
    cover.addRow(['Note', 'Encrypted access codes (door/alarm) are NOT in this file by design.']);
    cover.addRow(['', 'They exist only inside the encrypted .db snapshot. Restore that to recover codes.']);
    cover.getColumn(1).font = { bold: true };

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return { buffer, accountRows: accounts.length };
  } finally {
    db.close();
  }
}
