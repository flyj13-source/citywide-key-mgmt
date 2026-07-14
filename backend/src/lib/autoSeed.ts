import bcrypt from 'bcryptjs';
import db from './db';
import { encrypt } from './crypto';

// Runs at every server startup. Idempotent — only writes when rows are missing.
// This is the ONLY place seeding happens in production; seed.ts is local-dev-only.
export function autoSeedIfEmpty(): void {
  const seedPassword = process.env.SEED_PASSWORD || 'demo1234';

  // ── Manager ───────────────────────────────────────────────────────────────
  const existingManager = db.prepare('SELECT id FROM managers WHERE email = ?').get('cara@citywideboston.com');
  if (!existingManager) {
    const hash = bcrypt.hashSync(seedPassword, 10);
    db.prepare('INSERT INTO managers (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(
      'Cara Angeloni', 'cara@citywideboston.com', hash, 'admin'
    );
    console.log(`✓ [seed] Manager created: cara@citywideboston.com`);
  } else {
    console.log('✓ [seed] Manager cara@citywideboston.com already exists');
  }

  // ── Dedicated test/troubleshooting account (Cinch IT) ───────────────────────
  // Created ONLY when TEST_USER_PASSWORD is set. Password never hardcoded.
  // Same insert-if-absent guard as Cara's row → never resets an existing hash.
  const testPassword = process.env.TEST_USER_PASSWORD;
  const testEmail = process.env.TEST_USER_EMAIL || 'test@citywideboston.com';
  if (!testPassword) {
    console.log('• [seed] test user skipped, no password set (TEST_USER_PASSWORD unset)');
  } else {
    const existingTest = db.prepare('SELECT id FROM managers WHERE email = ?').get(testEmail);
    if (!existingTest) {
      const hash = bcrypt.hashSync(testPassword, 10);
      db.prepare(
        'INSERT INTO managers (name, email, password_hash, role, is_test) VALUES (?, ?, ?, ?, 1)'
      ).run('Test Account (Cinch IT)', testEmail, hash, 'admin');
      console.log(`✓ [seed] Test user created: ${testEmail} (is_test=1)`);
    } else {
      // Ensure the flag is set even if the row predates this column.
      db.prepare('UPDATE managers SET is_test = 1 WHERE email = ? AND is_test IS NOT 1').run(testEmail);
      console.log(`✓ [seed] Test user ${testEmail} already exists — password unchanged`);
    }
  }

  // ── Demo accounts — only if the accounts table is completely empty ─────────
  // Skips on any real deployment that already has imported data.
  const count = (db.prepare('SELECT COUNT(*) as c FROM accounts').get() as any).c as number;
  if (count > 0) {
    console.log(`✓ [seed] Accounts table has ${count} rows — skipping demo data`);
    return;
  }

  const insertIC = db.prepare(`
    INSERT OR IGNORE INTO accounts (
      ic_company_name, bc_vendor_number,
      keys_yn, security_app_yn,
      metal_keys, key_cards, has_fob, dispenser_keys, lockbox_code,
      door_code_encrypted, door_code_iv,
      alarm_code_encrypted, alarm_code_iv,
      notes, status, record_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'ic')
  `);

  const ics = [
    { ic_company_name: 'ALVES CLEANING SERVICES INC', bc_vendor_number: '02014100020', keys_yn: 1, security_app_yn: 0, metal_keys: 2, key_cards: 0, has_fob: 0, dispenser_keys: 0, lockbox_code: null, door_code: null, alarm_code: null, notes: 'Demo record' },
    { ic_company_name: 'ICLEAN FACILITIES SERVICES INC', bc_vendor_number: '02014100203', keys_yn: 1, security_app_yn: 1, metal_keys: 3, key_cards: 1, has_fob: 1, dispenser_keys: 1, lockbox_code: '42', door_code: '1234', alarm_code: '0000', notes: 'Demo record with all key types' },
    { ic_company_name: 'SHARP CLEANING CORPORATION', bc_vendor_number: '02014100044', keys_yn: 0, security_app_yn: 0, metal_keys: 0, key_cards: 0, has_fob: 0, dispenser_keys: 0, lockbox_code: null, door_code: null, alarm_code: null, notes: 'Demo record — no keys' },
    { ic_company_name: 'AINE CONTRACTORS CORP', bc_vendor_number: '02014100181', keys_yn: 1, security_app_yn: 1, metal_keys: 1, key_cards: 2, has_fob: 1, dispenser_keys: 0, lockbox_code: '28', door_code: '5678', alarm_code: null, notes: 'Demo record' },
    { ic_company_name: 'HOWARD CLEANING SERVICES', bc_vendor_number: '02014100209', keys_yn: 1, security_app_yn: 0, metal_keys: 4, key_cards: 0, has_fob: 0, dispenser_keys: 2, lockbox_code: null, door_code: null, alarm_code: '9999', notes: 'Demo record with dispenser keys' },
  ];

  for (const a of ics) {
    let door_enc: string | null = null, door_iv: string | null = null;
    let alarm_enc: string | null = null, alarm_iv: string | null = null;
    if (a.door_code) { const r = encrypt(a.door_code); door_enc = r.encrypted; door_iv = r.iv; }
    if (a.alarm_code) { const r = encrypt(a.alarm_code); alarm_enc = r.encrypted; alarm_iv = r.iv; }
    insertIC.run(a.ic_company_name, a.bc_vendor_number, a.keys_yn, a.security_app_yn, a.metal_keys, a.key_cards, a.has_fob, a.dispenser_keys, a.lockbox_code ?? null, door_enc, door_iv, alarm_enc, alarm_iv, a.notes);
  }

  const insertCustomer = db.prepare(`
    INSERT OR IGNORE INTO accounts (
      ic_company_name, bc_client_number, bc_vendor_number,
      ic_name, account_manager, ccm_manager,
      keys_yn, security_app_yn,
      metal_keys, key_cards, has_fob, dispenser_keys,
      am_keys, ccm_keys, contractor_keys,
      lockbox_code,
      door_code_encrypted, door_code_iv,
      alarm_code_encrypted, alarm_code_iv,
      notes, status, record_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'customer')
  `);

  const customers = [
    { ic_company_name: 'DEMO MEDICAL CENTER', bc_client_number: '01014200001', bc_vendor_number: '02014200001', ic_name: 'ALVES CLEANING SERVICES INC', account_manager: 'Demo Manager A', ccm_manager: 'Demo Manager B', keys_yn: 1, security_app_yn: 1, metal_keys: 3, key_cards: 2, has_fob: 1, dispenser_keys: 1, am_keys: 1, ccm_keys: 2, contractor_keys: 3, lockbox_code: '55', door_code: '7890', alarm_code: null, notes: 'Demo customer record — medical facility' },
    { ic_company_name: 'DEMO BANK BRANCH', bc_client_number: '01014200002', bc_vendor_number: '02014200002', ic_name: 'HOWARD CLEANING SERVICES', account_manager: 'Demo Manager A', ccm_manager: 'Demo Manager B', keys_yn: 1, security_app_yn: 0, metal_keys: 1, key_cards: 0, has_fob: 0, dispenser_keys: 0, am_keys: 1, ccm_keys: 1, contractor_keys: 2, lockbox_code: null, door_code: null, alarm_code: '3456', notes: 'Demo customer record — bank branch' },
  ];

  for (const c of customers) {
    let door_enc: string | null = null, door_iv: string | null = null;
    let alarm_enc: string | null = null, alarm_iv: string | null = null;
    if (c.door_code) { const r = encrypt(c.door_code); door_enc = r.encrypted; door_iv = r.iv; }
    if (c.alarm_code) { const r = encrypt(c.alarm_code); alarm_enc = r.encrypted; alarm_iv = r.iv; }
    insertCustomer.run(c.ic_company_name, c.bc_client_number, c.bc_vendor_number, c.ic_name, c.account_manager, c.ccm_manager, c.keys_yn, c.security_app_yn, c.metal_keys, c.key_cards, c.has_fob, c.dispenser_keys, c.am_keys, c.ccm_keys, c.contractor_keys, c.lockbox_code ?? null, door_enc, door_iv, alarm_enc, alarm_iv, c.notes);
  }

  db.prepare('INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)').run(
    'system_seed', null, null, 'System', JSON.stringify({ ics: ics.length, customers: customers.length, version: '2.1' })
  );

  console.log(`✓ [seed] Inserted ${ics.length} IC vendors + ${customers.length} demo customers`);
}
