import { getToken } from './auth';

// In local dev, VITE_API_URL is unset so the Vite proxy handles /api/*
// In production (Railway), VITE_API_URL = https://citywide-backend.up.railway.app
const API_ORIGIN = import.meta.env.VITE_API_URL ?? '';
const BASE = `${API_ORIGIN}/api`;

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
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

// Auth
export const login = (email: string, password: string) =>
  req<{ token: string; manager: any }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

// Accounts
export const getAccounts = (params?: Record<string, string>) => {
  const q = params ? '?' + new URLSearchParams(params).toString() : '';
  return req<{ accounts: any[]; total: number }>(`/accounts${q}`);
};
export const getAccount = (id: number) => req<any>(`/accounts/${id}`);
export const getAccountByCustomerId = (customerId: string) =>
  req<any>(`/accounts/by-customer-id/${encodeURIComponent(customerId)}`);
export const createAccount = (data: any) =>
  req<any>('/accounts', { method: 'POST', body: JSON.stringify(data) });
export const updateAccount = (id: number, data: any) =>
  req<any>(`/accounts/${id}`, { method: 'PUT', body: JSON.stringify(data) });

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
  const token = getToken();
  const res = await fetch(`${API_ORIGIN}/api/reports/excel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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

// Online → { response }. Offline (desktop) → { queued, id } (HTTP 202).
export const askClaude = (message: string, history: any[]) =>
  req<AskResult>('/claude', { method: 'POST', body: JSON.stringify({ message, history }) });

// Desktop-only: current AI question queue (used to flip Queued → Answered pills).
export const getAiQueue = () =>
  req<{ queue: AiQueueItem[]; pending: number }>('/claude/queue');

// Import
export const previewImport = (file: File) => {
  const token = getToken();
  const fd = new FormData();
  fd.append('file', file);
  return fetch(`${BASE}/accounts/import`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: fd,
  }).then(async (r) => {
    if (!r.ok) { const e = await r.json().catch(() => ({ error: r.statusText })); throw new Error(e.error); }
    return r.json() as Promise<{ valid: any[]; warnings: any[]; errors: any[]; total: number }>;
  });
};
export const confirmImport = (rows: any[]) =>
  req<{ inserted: number; skipped: number }>('/accounts/import/confirm', {
    method: 'POST', body: JSON.stringify({ rows }),
  });
export const downloadImportTemplate = () => {
  const token = getToken();
  return fetch(`${BASE}/accounts/import/template`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  }).then(async (r) => {
    if (!r.ok) throw new Error('Template download failed');
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'CityWide_IC_Import_Template.xlsx'; a.click();
    URL.revokeObjectURL(url);
  });
};

// Contractors
export const getContractors = () => req<any[]>('/contractors');
export const inviteContractor = (data: any) =>
  req<any>('/contractors/invite', { method: 'POST', body: JSON.stringify(data) });
export const getContractorByToken = (token: string) =>
  fetch(`${API_ORIGIN}/api/contractor/${token}`).then((r) => r.json());
export const signContractor = (token: string, signature_data: string) =>
  fetch(`${API_ORIGIN}/api/contractor/${token}/sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signature_data }),
  }).then((r) => r.json());
