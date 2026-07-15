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
  customer_id TEXT
);

CREATE TABLE IF NOT EXISTS key_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER REFERENCES accounts(id),
  account_name TEXT NOT NULL,
  assignee TEXT NOT NULL,
  assignee_email TEXT,
  key_type TEXT DEFAULT 'physical',
  keys_held TEXT,
  checked_out_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  due_at DATETIME,
  returned_at DATETIME,
  condition_on_return TEXT,
  notes TEXT,
  status TEXT DEFAULT 'checked_out'
);

CREATE TABLE IF NOT EXISTS staff_key_holders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_name TEXT NOT NULL,
  account TEXT NOT NULL,
  keys_held TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
