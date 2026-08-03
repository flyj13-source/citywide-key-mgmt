import { getToken, clearAuth } from './auth';

// In local dev, VITE_API_URL is unset so the Vite proxy handles /api/*
// In production (Render), VITE_API_URL = https://citywide-backend-0xuj.onrender.com
const API_ORIGIN = import.meta.env.VITE_API_URL ?? '';
const BASE = `${API_ORIGIN}/api`;

// ── Global 401/403 handler ────────────────────────────────────────────────────
// Clears stored credentials and hard-redirects to /login so a stale token
// never silently renders "0 records" or a dead modal.
function handleUnauth(): never {
  clearAuth();
  const loginUrl = `${window.location.origin}/login`;
  // Use replace so Back doesn't loop back to the expired session page
  window.location.replace(loginUrl);
  throw new Error('Session expired');
}

async function req<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (res.status === 401 || res.status === 403) handleUnauth();
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

// Raw fetch helper for blob/multipart responses — same auth + 401 guard
async function reqRaw(path: string, options: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (res.status === 401 || res.status === 403) handleUnauth();
  return res;
}

// Auth
export const login = (email: string, password: string) =>
  req<{ token: string; manager: any }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

export const changePassword = (currentPassword: string, newPassword: string) =>
  req<{ success: true }>('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });

// Accounts
export const getAccounts = (params?: Record<string, string>) => {
  const q = params ? '?' + new URLSearchParams(params).toString() : '';
  return req<{ accounts: any[]; total: number }>(`/accounts${q}`);
};
export const getAccount = (id: number) => req<any>(`/accounts/${id}`);
export const getKeyHolderStats = () =>
  req<{
    am_total: number; ccm_total: number; contractor_total: number; office_total: number;
    ic_personal: number; am_personal: number; ccm_personal: number; office_personal: number;
  }>('/accounts/key-holder-stats');
export interface BackupStatus {
  latest: {
    created_at: string;
    status: string;
    row_count: number | null;
    size_bytes: number | null;
    destination: string | null;
    message: string | null;
  } | null;
  recent: Array<{
    created_at: string;
    status: string;
    row_count: number | null;
    size_bytes: number | null;
    destination: string | null;
    duration_ms: number | null;
    message: string | null;
  }>;
}
export const getBackupStatus = () => req<BackupStatus>('/backups/status');
export const runBackupNow = () =>
  req<{ status: string; rowCount: number | null; destination: string | null; durationMs: number; message?: string }>(
    '/backups/run',
    { method: 'POST' }
  );

// Staff manager roster (the PEOPLE who manage clients — distinct from login
// accounts). Metrics (clients_managed / keys_personally_held /
// total_managed_inventory) are computed server-side.
export interface StaffManager {
  id: number;
  name: string;
  manager_type: 'account_manager' | 'ccm' | 'both';
  shift: '1st' | '2nd' | '3rd' | null;
  day_night: 'day' | 'night' | null;
  email: string | null;
  phone: string | null;
  active: number;
  login_manager_id: number | null;
  created_at: string;
  clients_managed: number;
  keys_personally_held: number;
  total_managed_inventory: number;
}
export const getStaffManagers = (includeInactive = false) =>
  req<{ managers: StaffManager[] }>(`/staff-managers${includeInactive ? '?include_inactive=1' : ''}`);
export const getStaffManager = (id: number) =>
  req<{ manager: StaffManager; clients: any[] }>(`/staff-managers/${id}`);
export const createStaffManager = (data: Partial<StaffManager>) =>
  req<{ manager: StaffManager }>('/staff-managers', { method: 'POST', body: JSON.stringify(data) });
export const updateStaffManager = (id: number, data: Partial<StaffManager>) =>
  req<{ manager: StaffManager }>(`/staff-managers/${id}`, { method: 'PATCH', body: JSON.stringify(data) });

export const getAccountManagers = () =>
  req<{ managers: any[] }>('/managers/account-managers');
export const getCcms = () =>
  req<{ managers: any[] }>('/managers/ccms');
export const getAccountByCustomerId = (customerId: string) =>
  req<any>(`/accounts/by-customer-id/${encodeURIComponent(customerId)}`);
export const getCustomerByBcNumber = (bcNumber: string) =>
  req<any>(`/accounts/customer-lookup/${encodeURIComponent(bcNumber)}`);
export const createAccount = (data: any) =>
  req<any>('/accounts', { method: 'POST', body: JSON.stringify(data) });
export const updateAccount = (id: number, data: any) =>
  req<{ success: true; changed: string[] }>(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const archiveAccount = (id: number) =>
  req<any>(`/accounts/${id}/archive`, { method: 'POST' });
export const restoreAccount = (id: number) =>
  req<any>(`/accounts/${id}/restore`, { method: 'POST' });
export const purgeAccount = (id: number, confirm: string) =>
  req<any>(`/accounts/${id}`, { method: 'DELETE', body: JSON.stringify({ confirm }) });

// Assignments
export const getAssignments = (params?: Record<string, string>) => {
  const q = params ? '?' + new URLSearchParams(params).toString() : '';
  return req<{ assignments: any[]; total: number }>(`/assignments${q}`);
};
export const checkout = (data: any) =>
  req<any>('/assignments/checkout', { method: 'POST', body: JSON.stringify(data) });
export const checkin = (data: any) =>
  req<any>('/assignments/checkin', { method: 'POST', body: JSON.stringify(data) });

// Vault
export const getVault = () => req<any[]>('/vault');
export const revealCode = (id: number, type: 'door' | 'alarm' | 'door_access') =>
  req<{ code: string }>(`/vault/reveal/${id}`, { method: 'POST', body: JSON.stringify({ type }) });
export const addVaultCode = (data: any) =>
  req<any>('/vault', { method: 'POST', body: JSON.stringify(data) });

// Audit
export const getAudit = (params?: Record<string, string>) => {
  const q = params ? '?' + new URLSearchParams(params).toString() : '';
  return req<{ logs: any[]; total: number }>(`/audit${q}`);
};

// Unified CW staff roster (managers + field crew). Key aggregates are computed
// server-side by resolving each person's holdings against the live source data.
export interface StaffMember {
  id: number;
  name: string;
  role_category: 'manager' | 'crew' | 'both';
  manager_type: 'account_manager' | 'ccm' | 'both' | null;
  role_label: string;
  shift: '1st' | '2nd' | '3rd' | null;
  day_night: 'day' | 'night' | null;
  email: string | null;
  phone: string | null;
  active: number;
  login_manager_id: number | null;
  created_at: string;
  keys_metal: number;
  keys_card: number;
  keys_fob: number;
  keys_dispenser: number;
  keys_other: number;
  total_keys_held: number;
  accounts_assigned: number;
}
export interface StaffDetail extends StaffMember {
  holdings: any[];
  accounts: any[];
}
export const getStaff = (opts?: { category?: 'all' | 'managers' | 'crew'; includeInactive?: boolean }) => {
  const p = new URLSearchParams();
  if (opts?.category && opts.category !== 'all') p.set('category', opts.category);
  if (opts?.includeInactive) p.set('include_inactive', '1');
  const q = p.toString();
  return req<StaffMember[]>(`/staff${q ? `?${q}` : ''}`);
};
export const getStaffMember = (id: number) =>
  req<{ staff: StaffDetail }>(`/staff/${id}`);
export const updateStaffMember = (id: number, data: Partial<StaffMember>) =>
  req<{ staff: StaffDetail }>(`/staff/${id}`, { method: 'PATCH', body: JSON.stringify(data) });

// ── Downloads ────────────────────────────────────────────────────────────────
// Save a fetch Response body as a file, preferring the server-provided
// Content-Disposition filename (so the CityWide-… naming is authoritative).
async function saveResponseAsFile(res: Response, fallback: string): Promise<void> {
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(e.error || 'Export failed');
  }
  const cd = res.headers.get('Content-Disposition') || '';
  const match = /filename="?([^"]+)"?/.exec(cd);
  const name = match?.[1] || fallback;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// Per-employee export (Excel or one-page branded PDF).
export const exportEmployee = async (id: number, format: 'xlsx' | 'pdf') => {
  const res = await reqRaw(`/staff/${id}/export?format=${format}`);
  await saveResponseAsFile(res, `CityWide-Employee-${id}.${format}`);
};

// Full or current-tab registry export (xlsx primary, or csv).
export interface RegistryExportOpts {
  scope: 'current' | 'all';
  tab: string;
  format: 'xlsx' | 'csv';
  search?: string;
  includeArchived?: boolean;
}
export const exportRegistry = async (opts: RegistryExportOpts) => {
  const res = await reqRaw('/exports/registry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  await saveResponseAsFile(res, `CityWide-KeyRegistry-${opts.scope}.${opts.format}`);
};

// Key sign-off forms (in-person e-signatures — employees + contractors).
export interface KeyForm {
  id: number;
  party_type: 'employee' | 'contractor';
  action: 'receive' | 'return';
  person_name: string;
  person_id: number | null;
  person_email: string | null;
  account_names: string[];
  key_details: string | null;
  notes: string | null;
  signature_hash: string;
  signed_at: string;
  collected_by: string | null;
  created_at: string;
}
export interface KeyFormFull extends KeyForm {
  signature_data: string;
}
export const getKeyForms = (params?: Record<string, string>) => {
  const q = params ? '?' + new URLSearchParams(params).toString() : '';
  return req<{ forms: KeyForm[] }>(`/forms${q}`);
};
export const getKeyForm = (id: number) => req<{ form: KeyFormFull }>(`/forms/${id}`);
export const createKeyForm = (data: {
  party_type: 'employee' | 'contractor';
  action: 'receive' | 'return';
  person_name: string;
  person_id?: number | null;
  person_email?: string | null;
  account_names?: string[];
  key_details?: string | null;
  notes?: string | null;
  signature_data: string;
}) => req<{ form: KeyForm }>('/forms', { method: 'POST', body: JSON.stringify(data) });

// Reports
export const getOverdue = () => req<any[]>('/reports/overdue');
export const sendOutlookAlert = (to?: string) =>
  req<any>('/reports/outlook', { method: 'POST', body: JSON.stringify({ to }) });
export const sendTeamsAlert = () =>
  req<any>('/reports/teams', { method: 'POST', body: JSON.stringify({}) });

export const downloadExcel = async () => {
  const res = await reqRaw('/reports/excel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error('Export failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `CityWide_KeyReport_${new Date().toISOString().slice(0, 10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
};

// Claude
export interface AiQueueItem {
  id: number;
  question: string;
  status: 'pending' | 'answered' | 'failed';
  answer: string | null;
  created_at: string;
  answered_at: string | null;
}
export type AskResult =
  | { response: string }
  | { queued: true; id: number; question: string; status: 'pending' };

export const askClaude = (message: string, history: any[]) =>
  req<AskResult>('/claude', { method: 'POST', body: JSON.stringify({ message, history }) });

export const getAiQueue = () =>
  req<{ queue: AiQueueItem[]; pending: number }>('/claude/queue');

// Import — routed through reqRaw so the 401 guard applies identically
export const previewImport = async (file: File) => {
  const fd = new FormData();
  fd.append('file', file);
  const res = await reqRaw('/accounts/import', { method: 'POST', body: fd });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(e.error || 'Import failed');
  }
  return res.json() as Promise<{ valid: any[]; warnings: any[]; errors: any[]; total: number }>;
};

export const confirmImport = (rows: any[], mode?: 'insert' | 'upsert') =>
  req<{ inserted: number; updated?: number; skipped: number; errors?: any[] }>('/accounts/import/confirm', {
    method: 'POST', body: JSON.stringify({ rows, mode }),
  });

export const downloadImportTemplate = async () => {
  const res = await reqRaw('/accounts/import/template');
  if (!res.ok) throw new Error('Template download failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'CityWide_IC_Import_Template.xlsx';
  a.click();
  URL.revokeObjectURL(url);
};

// Contractors
export const getContractors = () => req<any[]>('/contractors');
export const inviteContractor = (data: any) =>
  req<any>('/contractors/invite', { method: 'POST', body: JSON.stringify(data) });
// These two are public (no JWT) — contractor portal routes
export const getContractorByToken = (token: string) =>
  fetch(`${API_ORIGIN}/api/contractor/${token}`).then((r) => r.json());
export const signContractor = (token: string, signature_data: string) =>
  fetch(`${API_ORIGIN}/api/contractor/${token}/sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signature_data }),
  }).then((r) => r.json());
