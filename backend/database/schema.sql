CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ic_company_name TEXT NOT NULL,
  bc_vendor_number TEXT,
  keys_yn INTEGER DEFAULT 0,
  security_app_yn INTEGER DEFAULT 0,
  metal_keys INTEGER DEFAULT 0,
  key_cards INTEGER DEFAULT 0,
  has_fob INTEGER DEFAULT 0,
  dispenser_keys INTEGER DEFAULT 0,
  office_keys INTEGER DEFAULT 0,
  ic_office_keys INTEGER DEFAULT 0,
  am_office_keys INTEGER DEFAULT 0,
  ccm_office_keys INTEGER DEFAULT 0,
  lockbox_code TEXT,
  door_code_encrypted TEXT,
  door_code_iv TEXT,
  alarm_code_encrypted TEXT,
  alarm_code_iv TEXT,
  door_access_code_encrypted TEXT,
  door_access_code_iv TEXT,
  notes TEXT,
  status TEXT DEFAULT 'active',
  archived INTEGER DEFAULT 0,
  archived_at DATETIME,
  archived_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- legacy columns kept for reference / migration compat
  name TEXT,
  total_keys INTEGER DEFAULT 0,
  am_keys INTEGER DEFAULT 0,
  ccm_keys INTEGER DEFAULT 0,
  contractor_keys INTEGER DEFAULT 0,
  -- Per-role per-type breakdown. The role totals above are COMPUTED as the sum
  -- of these three (plus the office split, tracked separately).
  am_metal_keys INTEGER DEFAULT 0,
  am_key_cards INTEGER DEFAULT 0,
  am_key_fobs INTEGER DEFAULT 0,
  ccm_metal_keys INTEGER DEFAULT 0,
  ccm_key_cards INTEGER DEFAULT 0,
  ccm_key_fobs INTEGER DEFAULT 0,
  contractor_metal_keys INTEGER DEFAULT 0,
  contractor_key_cards INTEGER DEFAULT 0,
  contractor_key_fobs INTEGER DEFAULT 0,
  -- Holder × type grid (TRANSPOSED model — Office is now a HOLDER, like AM/
  -- CCM/Contractor, not a key TYPE). Rows are types (Metal/Card/Fob/Dispenser);
  -- these 16 cells are the columns (AM/CCM/Contractor/Office). Column totals
  -- (am_keys/ccm_keys/contractor_keys/office_keys_held) are COMPUTED from these.
  am_metal INTEGER DEFAULT 0,
  am_card INTEGER DEFAULT 0,
  am_fob INTEGER DEFAULT 0,
  am_dispenser INTEGER DEFAULT 0,
  ccm_metal INTEGER DEFAULT 0,
  ccm_card INTEGER DEFAULT 0,
  ccm_fob INTEGER DEFAULT 0,
  ccm_dispenser INTEGER DEFAULT 0,
  contractor_metal INTEGER DEFAULT 0,
  contractor_card INTEGER DEFAULT 0,
  contractor_fob INTEGER DEFAULT 0,
  contractor_dispenser INTEGER DEFAULT 0,
  office_metal INTEGER DEFAULT 0,
  office_card INTEGER DEFAULT 0,
  office_fob INTEGER DEFAULT 0,
  office_dispenser INTEGER DEFAULT 0,
  office_keys_held INTEGER DEFAULT 0,
  key_code TEXT,
  lockbox TEXT,
  ic_name TEXT,
  ic_id_number TEXT,
  customer_id TEXT,
  -- Physical-handover tracking after a bulk manager reassignment. Registry
  -- responsibility moves immediately; these flag that the metal has not.
  pending_handover INTEGER DEFAULT 0,
  pending_handover_from TEXT,
  pending_handover_to TEXT,
  pending_handover_role TEXT,
  pending_handover_at DATETIME
);

-- Key custody. ONE row per check-out transaction, which may carry SEVERAL key
-- types at once (2 metal + 1 fob): the full set lives in keys_json as
-- [{ type, label, qty }]. key_type/keys_held are kept as a human summary for
-- legacy consumers and for rows that predate the multi-key model.
--
-- `assignee` is the HOLDER (the person who has the keys); `recorded_by` /
-- `checkin_recorded_by` are the ACTOR who entered the transaction — the two
-- differ whenever Cara or a manager records a check-out on someone's behalf.
CREATE TABLE IF NOT EXISTS key_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER REFERENCES accounts(id),
  account_name TEXT NOT NULL,
  assignee TEXT NOT NULL,
  assignee_email TEXT,
  key_type TEXT DEFAULT 'physical',
  keys_held TEXT,
  keys_json TEXT,                 -- JSON [{type,label,qty}] — the full key set
  holder_type TEXT,               -- 'employee' | 'ic'
  holder_id INTEGER,              -- staff_managers.id (employee) / accounts.id (IC)
  recorded_by TEXT,               -- actor who recorded the CHECK-OUT
  checkin_recorded_by TEXT,       -- actor who recorded the CHECK-IN
  checked_out_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  due_at DATETIME,
  returned_at DATETIME,
  condition_on_return TEXT,
  notes TEXT,
  status TEXT DEFAULT 'checked_out',
  -- Check-OUT sign-off ("You are receiving these keys")
  signoff_token TEXT,
  signoff_expires_at DATETIME,
  signed_at DATETIME,
  signature_data TEXT,            -- base64 PNG data URL
  signature_hash TEXT,            -- sha256 of signature_data
  signature_typed_name TEXT,      -- the signer's typed name confirmation
  pdf_path TEXT,
  -- Check-IN sign-off ("You are returning these keys") — the mirror set, so a
  -- record that was signed for on the way out AND on the way back carries both
  -- signatures independently instead of one overwriting the other.
  checkin_signoff_token TEXT,
  checkin_signoff_expires_at DATETIME,
  checkin_signed_at DATETIME,
  checkin_signature_data TEXT,
  checkin_signature_hash TEXT,
  checkin_signature_typed_name TEXT,
  checkin_pdf_path TEXT,
  -- Person-to-person transfer linkage. Both sides of a transfer share a
  -- transfer_id; transfer_role says which end this row is, and
  -- linked_assignment_id cross-references the other end.
  transfer_id TEXT,
  transfer_role TEXT,             -- 'from' | 'to'
  linked_assignment_id INTEGER,
  return_reason TEXT              -- 'returned' | 'transferred'
);

CREATE TABLE IF NOT EXISTS staff_key_holders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_name TEXT NOT NULL,
  account TEXT NOT NULL,
  keys_held TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- System settings — operator-editable key/value configuration that must survive
-- staff changes without a redeploy (e.g. who receives every key custody email).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  account_name TEXT,
  account_id INTEGER,
  manager TEXT NOT NULL,
  metadata TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Signed key sign-off forms — an append-only log of e-signatures collected in
-- person (kiosk-style) when an EMPLOYEE or CONTRACTOR receives or returns keys.
-- The signature image is stored in the DB (base64 PNG) so it persists on the
-- Render disk; PDF/JPEG/PNG downloads are rendered on demand from this record.
CREATE TABLE IF NOT EXISTS key_forms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  party_type TEXT NOT NULL,       -- 'employee' | 'contractor'
  action TEXT NOT NULL,           -- 'receive' | 'return'
  person_name TEXT NOT NULL,
  person_id INTEGER,              -- optional link to staff_managers.id / contractors.id
  person_email TEXT,
  account_names TEXT,             -- JSON array of account/site strings
  key_details TEXT,               -- free text (counts / types / tags)
  notes TEXT,
  signature_data TEXT NOT NULL,   -- base64 PNG data URL
  signature_hash TEXT NOT NULL,   -- sha256 of the signature data
  signed_at DATETIME NOT NULL,
  collected_by TEXT,              -- the manager (JWT) who collected the signature
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contractors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  magic_token TEXT,
  token_expires_at DATETIME,
  assigned_accounts TEXT,
  signed_at DATETIME,
  signature_data TEXT,
  signature_hash TEXT,
  pdf_path TEXT,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS managers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'manager',
  is_test INTEGER DEFAULT 0,
  can_delete INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Staff manager roster — the PEOPLE who manage client accounts (Account
-- Managers / Contract Compliance Managers), as first-class records with a
-- type, shift, and contact info. This is DISTINCT from the `managers` table
-- above, which holds LOGIN accounts. A staff member who also has a login is
-- linked optionally via login_manager_id. Client linkage stays on the account
-- rows themselves (accounts.account_manager / accounts.ccm_manager TEXT),
-- matched by name — this table never touches those 577 rows.
-- Unified City Wide staff roster — ALL staff, not just managers. role_category
-- widens it to field crew too (see db.ts migration for the full contract).
CREATE TABLE IF NOT EXISTS staff_managers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  manager_type TEXT NOT NULL,   -- 'account_manager' | 'ccm' | 'both' | 'crew' (crew = sentinel)
  role_category TEXT,           -- 'manager' | 'crew' | 'both'
  shift TEXT,                   -- '1st' | '2nd' | '3rd'
  day_night TEXT,               -- 'day' | 'night'
  email TEXT,
  phone TEXT,
  active INTEGER DEFAULT 1,
  login_manager_id INTEGER,     -- optional FK to managers(id) if this person
                                -- also has a login account
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
