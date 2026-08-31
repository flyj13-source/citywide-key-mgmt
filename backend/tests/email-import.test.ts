import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-email-'));
process.env.CITYWIDE_DB_DIR = TEST_DIR;
delete process.env.DB_PATH;
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SEED_PASSWORD = 'demo1234';

const DB_FILE = path.join(TEST_DIR, 'citywide.db');

let db: DatabaseSync;
let lib: typeof import('../src/lib/emailImport');

beforeAll(async () => {
  // Importing db.ts runs the migrations, including ic_primary_contact.
  await import('../src/lib/db');
  lib = await import('../src/lib/emailImport');
  db = new DatabaseSync(DB_FILE);
});

beforeEach(() => {
  db.exec('DELETE FROM staff_managers');
  db.exec('DELETE FROM accounts');
});

const staffRows = (rows: [string, string, string][]) =>
  lib.parseStaffRows([['First Name', 'Last Name', 'Email Address'], ...rows]);

const icRows = (rows: any[][]) =>
  lib.parseIcRows([
    ['(Do Not Modify) Account', 'DBA Name', 'BC Vendor No', 'Primary Contact', 'Email (Primary Contact) (Contact)'],
    ...rows,
  ]);

const addStaff = (name: string, email: string | null, type = 'account_manager', role = 'manager') =>
  db.prepare(
    'INSERT INTO staff_managers (name, manager_type, role_category, email, active) VALUES (?,?,?,?,1)'
  ).run(name, type, role, email);

const addAccount = (o: Record<string, any>) => {
  const cols = Object.keys(o);
  db.prepare(
    `INSERT INTO accounts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
  ).run(...cols.map((c) => o[c]));
};

// ─────────────────────────────────────────────────────────────────────────────

describe('CELL HYGIENE — the source files carry trailing spaces everywhere', () => {
  it('trims every value, including the email', () => {
    const rows = staffRows([['Daniel ', 'Bordenave ', 'daniel.bordenave@gocitywide.com ']]);
    expect(rows[0]).toMatchObject({
      first: 'Daniel', last: 'Bordenave',
      name: 'Daniel Bordenave', email: 'daniel.bordenave@gocitywide.com',
    });
  });

  it('a trailing-space name still matches an untrimmed roster row', () => {
    addStaff('daniel bordenave', null);
    const r = lib.importStaffEmails(db, staffRows([['Daniel ', 'Bordenave ', ' dan@cw.test ']]));
    expect(r.matchedUpdated).toEqual([{ name: 'Daniel Bordenave', email: 'dan@cw.test' }]);
    expect(db.prepare('SELECT email FROM staff_managers').get()).toMatchObject({ email: 'dan@cw.test' });
  });
});

describe('VENDOR NUMBERS ARE TEXT — leading zeros must survive', () => {
  it('re-pads a number Excel stripped the leading zero from', () => {
    expect(lib.vendorNo(2014100437)).toBe('02014100437');
    expect(lib.vendorNo('02014100437')).toBe('02014100437');
    expect(lib.vendorNo(' 02014100437 ')).toBe('02014100437');
  });

  it('never truncates or reformats a full-length string', () => {
    expect(lib.vendorNo('02014100437')).toHaveLength(11);
    expect(lib.vendorNo('123456789012')).toBe('123456789012');
  });

  it('matches an IC whose stored vendor number kept its leading zero', () => {
    addAccount({ ic_company_name: 'ACME CLEAN', bc_vendor_number: '02014100437', record_type: 'ic' });
    // Excel handed us the number, not the string.
    const r = lib.importIcEmails(db, icRows([['x', 'ACME CLEAN', 2014100437, 'Pat Lee', 'pat@acme.test']]));
    expect(r.created).toHaveLength(0);
    expect(r.matchedUpdated).toHaveLength(1);
    expect(db.prepare('SELECT ic_email, ic_primary_contact FROM accounts').get())
      .toMatchObject({ ic_email: 'pat@acme.test', ic_primary_contact: 'Pat Lee' });
  });
});

describe('STAFF IMPORT — match on full name, never overwrite', () => {
  it('fills a NULL email but leaves a populated one alone', () => {
    addStaff('Empty Ellen', null);
    addStaff('Taken Tom', 'tom.existing@cw.test');
    const r = lib.importStaffEmails(db, staffRows([
      ['Empty', 'Ellen', 'ellen@cw.test'],
      ['Taken', 'Tom', 'tom.new@cw.test'],
    ]));
    expect(r.matchedUpdated).toEqual([{ name: 'Empty Ellen', email: 'ellen@cw.test' }]);
    expect(r.matchedAlreadyHadEmail).toEqual([
      { name: 'Taken Tom', existing: 'tom.existing@cw.test', incoming: 'tom.new@cw.test' },
    ]);
    expect(db.prepare("SELECT email FROM staff_managers WHERE name = 'Taken Tom'").get())
      .toMatchObject({ email: 'tom.existing@cw.test' });
  });

  it('treats an empty-string email as unset and fills it', () => {
    addStaff('Blank Bob', '');
    lib.importStaffEmails(db, staffRows([['Blank', 'Bob', 'bob@cw.test']]));
    expect(db.prepare('SELECT email FROM staff_managers').get()).toMatchObject({ email: 'bob@cw.test' });
  });

  it('matches case-insensitively', () => {
    addStaff('MARIA GONZALEZ', null);
    const r = lib.importStaffEmails(db, staffRows([['maria', 'gonzalez', 'maria@cw.test']]));
    expect(r.matchedUpdated).toHaveLength(1);
    expect(r.created).toHaveLength(0);
  });

  it('reports an ambiguous name and applies NOTHING to either row', () => {
    addStaff('Same Name', null);
    addStaff('Same Name', null);
    const r = lib.importStaffEmails(db, staffRows([['Same', 'Name', 'who@cw.test']]));
    expect(r.ambiguous).toHaveLength(1);
    expect(r.ambiguous[0].name).toBe('Same Name');
    expect(r.ambiguous[0].ids).toHaveLength(2);
    expect(r.matchedUpdated).toHaveLength(0);
    const emails = (db.prepare('SELECT email FROM staff_managers').all() as any[])
      .map((x) => Object.assign({}, x).email);
    expect(emails).toEqual([null, null]);
  });
});

describe('STAFF IMPORT — unmatched names become new roster rows', () => {
  it("creates as 'crew' when the name is on no client row", () => {
    const r = lib.importStaffEmails(db, staffRows([['New', 'Hire', 'new@cw.test']]));
    expect(r.created).toEqual([
      { name: 'New Hire', email: 'new@cw.test', role_category: 'crew', manager_type: 'crew' },
    ]);
    expect(db.prepare('SELECT * FROM staff_managers').get()).toMatchObject({
      name: 'New Hire', role_category: 'crew', shift: null, day_night: null, active: 1,
    });
  });

  it("creates as 'manager' when the name appears in account_manager", () => {
    addAccount({ ic_company_name: 'SITE A', account_manager: 'Field Fiona', record_type: 'customer' });
    const r = lib.importStaffEmails(db, staffRows([['Field', 'Fiona', 'fiona@cw.test']]));
    expect(r.created[0]).toMatchObject({ role_category: 'manager', manager_type: 'account_manager' });
  });

  it("creates as 'manager' when the name appears in ccm_manager", () => {
    addAccount({ ic_company_name: 'SITE B', ccm_manager: 'Comply Carl', record_type: 'customer' });
    const r = lib.importStaffEmails(db, staffRows([['Comply', 'Carl', 'carl@cw.test']]));
    expect(r.created[0]).toMatchObject({ role_category: 'manager', manager_type: 'ccm' });
  });

  it("creates as manager_type 'both' when the name appears in BOTH columns", () => {
    addAccount({ ic_company_name: 'SITE C', account_manager: 'Dual Dana', record_type: 'customer' });
    addAccount({ ic_company_name: 'SITE D', ccm_manager: 'Dual Dana', record_type: 'customer' });
    const r = lib.importStaffEmails(db, staffRows([['Dual', 'Dana', 'dana@cw.test']]));
    expect(r.created[0]).toMatchObject({ role_category: 'manager', manager_type: 'both' });
  });
});

describe('STAFF IMPORT — the residual gap is reported, never an error', () => {
  it('leaves absent employees NULL and lists them', () => {
    addStaff('Listed Larry', null);
    addStaff('Absent Alice', null);   // not in the file at all
    addStaff('Inactive Ivan', null, 'account_manager', 'manager');
    db.prepare("UPDATE staff_managers SET active = 0 WHERE name = 'Inactive Ivan'").run();

    const r = lib.importStaffEmails(db, staffRows([['Listed', 'Larry', 'larry@cw.test']]));
    const names = r.remainingWithoutEmail.map((x) => x.name);
    expect(names).toContain('Absent Alice');
    expect(names).not.toContain('Listed Larry');
    // Inactive rows are not part of the actionable gap.
    expect(names).not.toContain('Inactive Ivan');
    expect(db.prepare("SELECT email FROM staff_managers WHERE name = 'Absent Alice'").get())
      .toMatchObject({ email: null });
  });

  it('skips an unparseable address rather than storing junk', () => {
    addStaff('Bad Email Bill', null);
    const r = lib.importStaffEmails(db, staffRows([['Bad Email', 'Bill', 'not-an-email']]));
    expect(r.invalidEmail).toHaveLength(1);
    expect(db.prepare('SELECT email FROM staff_managers').get()).toMatchObject({ email: null });
  });
});

describe('IC IMPORT — match on bc_vendor_number', () => {
  it('fills contact + email where empty, and creates what does not exist', () => {
    addAccount({ ic_company_name: 'KNOWN IC', bc_vendor_number: '02014100437', record_type: 'ic' });
    const r = lib.importIcEmails(db, icRows([
      ['x', 'KNOWN IC', '02014100437', 'Pat Lee', 'pat@known.test'],
      ['x', 'BRAND NEW IC', '02014100999', 'Sam Ray', 'sam@new.test'],
    ]));
    expect(r.matchedUpdated).toHaveLength(1);
    expect(r.created).toHaveLength(1);
    const made = db.prepare("SELECT * FROM accounts WHERE bc_vendor_number = '02014100999'").get() as any;
    expect(Object.assign({}, made)).toMatchObject({
      ic_company_name: 'BRAND NEW IC', ic_primary_contact: 'Sam Ray',
      ic_email: 'sam@new.test', record_type: 'ic', status: 'active', archived: 0,
    });
  });

  it('never overwrites a populated contact or email', () => {
    addAccount({
      ic_company_name: 'SET IC', bc_vendor_number: '02014100437', record_type: 'ic',
      ic_primary_contact: 'Original Person', ic_email: 'original@ic.test',
    });
    lib.importIcEmails(db, icRows([['x', 'SET IC', '02014100437', 'New Person', 'new@ic.test']]));
    expect(Object.assign({}, db.prepare('SELECT * FROM accounts').get() as any)).toMatchObject({
      ic_primary_contact: 'Original Person', ic_email: 'original@ic.test',
    });
  });

  it('fills only the empty half when one of the two is already set', () => {
    addAccount({
      ic_company_name: 'HALF IC', bc_vendor_number: '02014100437', record_type: 'ic',
      ic_primary_contact: 'Existing Contact', ic_email: null,
    });
    lib.importIcEmails(db, icRows([['x', 'HALF IC', '02014100437', 'Ignored', 'fills@ic.test']]));
    expect(Object.assign({}, db.prepare('SELECT * FROM accounts').get() as any)).toMatchObject({
      ic_primary_contact: 'Existing Contact', ic_email: 'fills@ic.test',
    });
  });

  it('flags a row with no email and a row with no vendor number, importing both', () => {
    const r = lib.importIcEmails(db, icRows([
      ['x', 'NO EMAIL IC', '02014100111', 'Contact One', ''],
      ['x', 'NO VENDOR IC', '', 'Contact Two', 'two@ic.test'],
    ]));
    expect(r.missingEmail.map((m) => m.dba)).toEqual(['NO EMAIL IC']);
    expect(r.missingVendorNo.map((m) => m.dba)).toEqual(['NO VENDOR IC']);
    // Flagged, but still imported.
    expect(db.prepare('SELECT COUNT(*) AS n FROM accounts').get()).toMatchObject({ n: 2 });
  });
});

describe('IDEMPOTENCE — running either import twice changes nothing', () => {
  it('staff: a second run creates no duplicates and updates nothing', () => {
    addStaff('Existing Ed', null);
    const rows = staffRows([['Existing', 'Ed', 'ed@cw.test'], ['Fresh', 'Face', 'fresh@cw.test']]);

    const first = lib.importStaffEmails(db, rows);
    expect(first.matchedUpdated).toHaveLength(1);
    expect(first.created).toHaveLength(1);

    const second = lib.importStaffEmails(db, rows);
    expect(second.matchedUpdated).toHaveLength(0);
    expect(second.created).toHaveLength(0);
    expect(second.matchedAlreadyHadEmail).toHaveLength(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM staff_managers').get()).toMatchObject({ n: 2 });
  });

  it('ic: a second run creates no duplicates and updates nothing', () => {
    const rows = icRows([
      ['x', 'ONE IC', '02014100437', 'Pat', 'pat@ic.test'],
      ['x', 'TWO IC', '02014100438', 'Sam', 'sam@ic.test'],
    ]);
    const first = lib.importIcEmails(db, rows);
    expect(first.created).toHaveLength(2);

    const second = lib.importIcEmails(db, rows);
    expect(second.created).toHaveLength(0);
    expect(second.matchedUpdated).toHaveLength(0);
    expect(second.matchedAlreadyPopulated).toHaveLength(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM accounts').get()).toMatchObject({ n: 2 });
  });

  it('ic: a no-vendor-number row re-matches by company name instead of duplicating', () => {
    const rows = icRows([['x', 'NAMELESS VENDOR', '', 'Pat', 'pat@ic.test']]);
    lib.importIcEmails(db, rows);
    lib.importIcEmails(db, rows);
    expect(db.prepare('SELECT COUNT(*) AS n FROM accounts').get()).toMatchObject({ n: 1 });
  });
});

describe('CUSTOMER → SERVING IC RESOLUTION', () => {
  it('counts which customers can reach a human, and why the rest cannot', () => {
    // Two ICs: one reachable, one with no email.
    addAccount({ ic_company_name: 'GOOD IC', bc_vendor_number: '02014100001', record_type: 'ic', ic_email: 'good@ic.test' });
    addAccount({ ic_company_name: 'MUTE IC', bc_vendor_number: '02014100002', record_type: 'ic', ic_email: null });
    // Four customers, one per outcome.
    addAccount({ ic_company_name: 'RESOLVES', bc_vendor_number: '02014100001', record_type: 'customer' });
    addAccount({ ic_company_name: 'IC HAS NO EMAIL', bc_vendor_number: '02014100002', record_type: 'customer' });
    addAccount({ ic_company_name: 'NO SUCH IC', bc_vendor_number: '02014109999', record_type: 'customer' });
    addAccount({ ic_company_name: 'NO VENDOR NO', bc_vendor_number: null, record_type: 'customer' });

    const r = lib.resolveCustomerIcEmails(db);
    expect(r).toMatchObject({
      totalCustomers: 4, resolved: 1,
      unresolvedIcHasNoEmail: 1, unresolvedNoMatchingIc: 1, unresolvedNoVendorNo: 1,
    });
    expect(r.samples.map((s) => s.customer).sort())
      .toEqual(['IC HAS NO EMAIL', 'NO SUCH IC', 'NO VENDOR NO']);
  });

  it('an archived customer is not counted in the gap', () => {
    addAccount({ ic_company_name: 'GONE', bc_vendor_number: null, record_type: 'customer', archived: 1 });
    expect(lib.resolveCustomerIcEmails(db).totalCustomers).toBe(0);
  });

  it('importing the IC file closes the gap it was blocking', () => {
    addAccount({ ic_company_name: 'SITE', bc_vendor_number: '02014100437', record_type: 'customer' });
    addAccount({ ic_company_name: 'SERVING IC', bc_vendor_number: '02014100437', record_type: 'ic' });
    expect(lib.resolveCustomerIcEmails(db).resolved).toBe(0);

    lib.importIcEmails(db, icRows([['x', 'SERVING IC', '02014100437', 'Pat Lee', 'pat@ic.test']]));
    expect(lib.resolveCustomerIcEmails(db).resolved).toBe(1);
  });
});

describe('HEADER SHAPE DETECTION — one uploader, three sheets', () => {
  it('recognises the employee sheet', () => {
    expect(lib.detectShape(['First Name', 'Last Name', 'Email Address'])).toBe('staff-emails');
  });

  it('recognises the IC sheet, ignoring the (Do Not Modify) columns', () => {
    expect(lib.detectShape([
      '(Do Not Modify) Account', '(Do Not Modify) Row Checksum', '(Do Not Modify) Modified On',
      'DBA Name', 'BC Vendor No', 'Primary Contact', 'Email (Primary Contact) (Contact)',
    ])).toBe('ic-emails');
  });

  it('does NOT claim the customer registry sheet, which also has a vendor number', () => {
    expect(lib.detectShape([
      'Client Name', 'BC Client Number', 'Independent Contractor', 'BC Vendor Number',
      'Account Manager', 'Contract Compliance Manager', 'Metal Keys',
    ])).toBeNull();
  });

  it('tolerates trailing spaces and case in the header row itself', () => {
    expect(lib.detectShape(['First Name ', ' LAST NAME', 'Email Address '])).toBe('staff-emails');
  });
});

describe('DRY RUN — previewing writes nothing', () => {
  it('reports what would happen without touching the database', () => {
    addStaff('Preview Pat', null);
    const r = lib.importStaffEmails(db, staffRows([
      ['Preview', 'Pat', 'pat@cw.test'],
      ['Would', 'Create', 'wc@cw.test'],
    ]), { dryRun: true });
    expect(r.matchedUpdated).toHaveLength(1);
    expect(r.created).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM staff_managers').get()).toMatchObject({ n: 1 });
    expect(db.prepare('SELECT email FROM staff_managers').get()).toMatchObject({ email: null });
  });
});

describe('PREVIEW TRANSPARENCY — no silent failures', () => {
  it('names every recognised column and the field it feeds', () => {
    const h = lib.describeHeaders(
      ['First Name', 'Last Name', 'Email Address'], 'staff-emails');
    expect(h.recognized).toEqual([
      { header: 'First Name', field: 'first' },
      { header: 'Last Name', field: 'last' },
      { header: 'Email Address', field: 'email' },
    ]);
    expect(h.unrecognized).toEqual([]);
  });

  it('reports a column it did NOT understand rather than ignoring it', () => {
    const h = lib.describeHeaders(
      ['First Name', 'Last Name', 'Email Address', 'Badge Number', 'Hire Date'], 'staff-emails');
    expect(h.unrecognized).toEqual(['Badge Number', 'Hire Date']);
  });

  it('lists the (Do Not Modify) columns as skipped BY DESIGN, not as a problem', () => {
    const h = lib.describeHeaders([
      '(Do Not Modify) Account', '(Do Not Modify) Row Checksum', '(Do Not Modify) Modified On',
      'DBA Name', 'BC Vendor No', 'Primary Contact', 'Email (Primary Contact) (Contact)',
    ], 'ic-emails');
    expect(h.ignoredByDesign).toHaveLength(3);
    expect(h.unrecognized).toEqual([]);
    expect(h.recognized.map((r) => r.field).sort())
      .toEqual(['bc_vendor_number', 'dba', 'ic_email', 'ic_primary_contact']);
  });

  it('a RENAMED email column shows up as unrecognized instead of a silent blank import', () => {
    // This is the failure mode the header report exists to catch: a refreshed
    // export renames a column, every row imports blank, and nobody notices.
    const rows = lib.parseIcRows([
      ['DBA Name', 'BC Vendor No', 'Primary Contact', 'Contact Email Address'],
      ['ACME', '02014100437', 'Pat Lee', 'pat@acme.test'],
    ]);
    const h = lib.describeHeaders(
      ['DBA Name', 'BC Vendor No', 'Primary Contact', 'Contact Email Address'], 'ic-emails');
    expect(h.unrecognized).toEqual(['Contact Email Address']);
    // …and the fill counts say plainly that no email would land.
    const r = lib.importIcEmails(db, rows, { dryRun: true });
    expect(r.fieldFills['accounts.ic_email']).toBe(0);
    expect(r.fieldFills['accounts.ic_primary_contact']).toBe(1);
  });

  it('reports per-field fill counts for the staff sheet', () => {
    addStaff('Empty Ellen', null);
    const r = lib.importStaffEmails(db, staffRows([
      ['Empty', 'Ellen', 'ellen@cw.test'],
      ['Brand', 'New', 'new@cw.test'],
    ]), { dryRun: true });
    expect(r.fieldFills).toEqual({
      'staff_managers.email': 2,      // 1 filled + 1 created carrying an address
      'staff_managers (new rows)': 1,
    });
  });

  it('reports per-field fill counts for the IC sheet', () => {
    addAccount({ ic_company_name: 'KNOWN', bc_vendor_number: '02014100437', record_type: 'ic' });
    const r = lib.importIcEmails(db, icRows([
      ['x', 'KNOWN', '02014100437', 'Pat', 'pat@ic.test'],
      ['x', 'FRESH', '02014100999', 'Sam', 'sam@ic.test'],
      ['x', 'NO MAIL', '02014100888', 'Kim', ''],
    ]), { dryRun: true });
    expect(r.fieldFills).toEqual({
      'accounts.ic_email': 2,
      'accounts.ic_primary_contact': 3,
      'accounts (new IC rows)': 2,
    });
  });

  it('a re-run reports ZERO fills — the signal that nothing was left to do', () => {
    addStaff('Done Dana', 'dana@cw.test');
    const r = lib.importStaffEmails(db, staffRows([['Done', 'Dana', 'dana@cw.test']]), { dryRun: true });
    expect(r.fieldFills['staff_managers.email']).toBe(0);
    expect(r.totalRows).toBe(1);
  });
});
