CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  total_keys INTEGER DEFAULT 0,
  am_keys INTEGER DEFAULT 0,
  ccm_keys INTEGER DEFAULT 0,
  contractor_keys INTEGER DEFAULT 0,
  key_code TEXT,
  lockbox TEXT,
  door_code_encrypted TEXT,
  door_code_iv TEXT,
  alarm_code_encrypted TEXT,
  alarm_code_iv TEXT,
  has_fob INTEGER DEFAULT 0,
  notes TEXT,
  status TEXT DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  ic_name TEXT,
  ic_id_number TEXT,
  dispenser_keys INTEGER DEFAULT 0,
  customer_id TEXT UNIQUE,
  door_access_code_encrypted TEXT,
  door_access_code_iv TEXT
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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
