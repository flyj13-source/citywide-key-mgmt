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
  req<any>(`/accounts/${id}`, { method: 'PUT', body: JSON.stringify(data) });
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

// Staff
export const getStaff = () => req<any[]>('/staff');

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
