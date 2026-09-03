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

// Roster-driven manager tabs: staff_managers records WITH their aggregates.
// `unmatched` carries names found on client rows that have no roster record —
// surfaced rather than dropped, since they hold real keys.
export interface ManagerRosterRow {
  id: number;
  name: string;
  manager_type: 'account_manager' | 'ccm' | 'both';
  role_category: string;
  shift: '1st' | '2nd' | '3rd' | null;
  day_night: 'day' | 'night' | null;
  email: string | null;
  phone: string | null;
  active: number;
  clients_managed: number;
  personal_metal: number;
  personal_cards: number;
  personal_fobs: number;
  personal_dispenser: number;
  total_held: number;
  total_client_keys: number;
  on_roster: true;
}
export interface UnmatchedManager {
  person: string;
  clients_managed: number;
  total_held: number;
}
export const getManagerRoster = (role: 'am' | 'ccm') =>
  req<{ role: 'am' | 'ccm'; managers: ManagerRosterRow[]; unmatched: UnmatchedManager[] }>(
    `/staff-managers/roster?role=${role}`
  );

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

// ── Key custody (Check Out / Check In, inside the Key Registry) ─────────────
export type KeyTypeKey = 'metal' | 'card' | 'fob' | 'dispenser';
export interface KeyLine { type: KeyTypeKey; label: string; qty: number }
export interface KeyAvailability {
  type: KeyTypeKey;
  label: string;
  site_total: number;
  checked_out: number;
  available: number;
}
export interface Assignment {
  id: number;
  account_id: number | null;
  account_name: string;
  holder: string;
  holder_email: string | null;
  holder_type: 'employee' | 'ic' | null;
  holder_id: number | null;
  keys: KeyLine[];
  keys_summary: string;
  total_keys: number;
  checked_out_at: string;
  due_at: string | null;
  returned_at: string | null;
  condition_on_return: string | null;
  notes: string | null;
  status: 'checked_out' | 'returned';
  overdue: boolean;
  recorded_by: string | null;
  checkin_recorded_by: string | null;
  signed_at: string | null;
  signature_hash: string | null;
  signature_typed_name: string | null;
  has_pdf: boolean;
  signoff_pending: boolean;
  signoff_expires_at: string | null;
  // Check-IN signature — tracked independently of the check-out one, so a
  // record can be signed out and still awaiting its return signature.
  checkin_signed_at: string | null;
  checkin_signature_hash: string | null;
  checkin_signature_typed_name: string | null;
  has_checkin_pdf: boolean;
  checkin_signoff_pending: boolean;
  checkin_signoff_expires_at: string | null;
  // Person-to-person transfer linkage.
  transfer_id: string | null;
  transfer_role: 'from' | 'to' | null;
  linked_assignment_id: number | null;
  return_reason: string | null;
  transfer_signatures: TransferSignatures | null;
  // Signature DELIVERABILITY — whether one could ever be collected, which is a
  // different question from whether one exists.
  signature_status: SignatureStatus;
  no_email_reason: string | null;
  signed_in_person_by: string | null;
  signature_send_error: string | null;
  signature_send_attempts: number;
  counterparty_name: string | null;
  counterparty_email: string | null;
}
export interface TransferSignatures {
  signed: number;
  total: 2;
  complete: boolean;
  from_signed: boolean;
  to_signed: boolean;
}
export interface MailOutcome {
  ok: boolean;
  recipients: string[];
  error?: string;
  cara?: string;
  /** How many send attempts were made (0 when skipped before trying). */
  attempts?: number;
}

export interface HolderOption {
  id: number;
  name: string;
  email: string | null;
  type: 'employee' | 'ic';
  detail: string;
  has_email: boolean;
}

// Explicit lifecycle so "a signature is coming" and "no signature will ever
// arrive" are never rendered the same way.
export type SignatureStatus =
  | 'signed' | 'awaiting_signature' | 'signature_unavailable'
  | 'signature_send_failed' | 'not_required';

/** The two states that will NOT resolve on their own — always red. */
export const SIGNATURE_NEEDS_ATTENTION: SignatureStatus[] =
  ['signature_unavailable', 'signature_send_failed'];

export const getAssignments = (params?: Record<string, string>) => {
  const q = params ? '?' + new URLSearchParams(params).toString() : '';
  return req<{ assignments: Assignment[]; total: number }>(`/assignments${q}`);
};
export const getKeyAvailability = (accountId: number) =>
  req<{ account: { id: number; name: string; record_type: string }; types: KeyAvailability[] }>(
    `/assignments/availability?account_id=${accountId}`
  );
export const getHolders = () =>
  req<{ employees: HolderOption[]; ics: HolderOption[] }>('/assignments/holders');
export const checkout = (data: {
  account_id: number;
  account_name?: string;
  holder: string;
  holder_email?: string | null;
  holder_type: 'employee' | 'ic';
  holder_id?: number | null;
  keys: { type: KeyTypeKey; qty: number }[];
  due_at?: string | null;
  notes?: string | null;
  on_behalf: boolean;
  /** Required when the holder has no email — states why keys go out unsigned. */
  no_email_reason?: string | null;
  counterparty_name?: string | null;
  counterparty_email?: string | null;
}) =>
  req<{
    id: number; assignment: Assignment; signoff_link: string | null;
    signature_status: SignatureStatus; email: MailOutcome;
  }>('/assignments/checkout', { method: 'POST', body: JSON.stringify(data) });

// ── Key Forms ────────────────────────────────────────────────────────────────
export type FormEventType = 'checkin' | 'checkout' | 'transfer' | 'reassignment' | 'audit';
export type FormStatus = 'draft' | 'sent' | 'signed' | 'unsigned';

export interface KeyFormLine {
  account_id: number | null;
  client: string;
  bc_client_number: string | null;
  metal: number; card: number; fob: number; dispenser: number; office: number;
  subtotal: number;
}

export interface KeyFormDoc {
  id: number;
  form_no: string;
  event_type: FormEventType;
  event_label: string;
  holder_name: string;
  holder_type: 'employee' | 'ic';
  holder_role: string | null;
  holder_shift: string | null;
  holder_email: string | null;
  clients_covered: number;
  total_keys: number;
  status: FormStatus;
  generated_at: string;
  generated_by: string | null;
  sent_to: string[];
  last_sent_at: string | null;
  send_count: number;
  send_error: string | null;
  signed_at: string | null;
  signature_typed_name: string | null;
  has_pdf: boolean;
  no_email: boolean;
  counterparty_name: string | null;
  clients: KeyFormLine[];
  event_note: string | null;
}

export const getKeyFormDocs = (params: Record<string, string>) =>
  req<{ forms: KeyFormDoc[]; total: number; page: number; limit: number }>(
    `/key-forms?${new URLSearchParams(params)}`
  );

/** One form per holder, each carrying that person's CURRENT state. */
export const generateKeyFormDocs = (holders: { name: string; type: 'employee' | 'ic'; email?: string | null }[]) =>
  req<{ forms: KeyFormDoc[]; count: number }>('/key-forms/generate', {
    method: 'POST', body: JSON.stringify({ holders }),
  });

/** Send or resend. `to` routes a copy anywhere during an audit. */
export const sendKeyFormDoc = (id: number, to?: string | null) =>
  req<{ ok: boolean; recipients: string[]; error: string | null; form: KeyFormDoc }>(
    `/key-forms/${id}/send`, { method: 'POST', body: JSON.stringify({ to: to || null }) },
  );

export const bulkSendKeyFormDocs = (ids: number[], to?: string | null) =>
  req<{ sent: number; failed: number; results: { id: number; ok: boolean; error?: string | null }[] }>(
    '/key-forms/bulk-send', { method: 'POST', body: JSON.stringify({ ids, to: to || null }) },
  );

export const downloadKeyFormDocPdf = async (id: number, formNo: string) => {
  const res = await reqRaw(`/key-forms/${id}/pdf`);
  if (!res.ok) throw new Error('Could not download the PDF');
  await saveResponseAsFile(res, `${formNo}.pdf`);
};

/** Public — the tokenized signature page. */
export const getKeyFormDocByToken = (token: string) =>
  fetch(`${API_ORIGIN}/api/key-forms/token/${token}`).then((r) => r.json());

export const signKeyFormDoc = (token: string, signature_data: string, typed_name: string) =>
  fetch(`${API_ORIGIN}/api/key-forms/token/${token}/sign`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signature_data, typed_name }),
  }).then((r) => r.json());

/** Save an address onto the person's staff/IC record so the gap closes for good. */
export const saveHolderEmail = (data: {
  holder_type: 'employee' | 'ic'; holder_id: number; email: string;
}) =>
  req<{ success: true; name: string; email: string }>('/assignments/holder-email', {
    method: 'POST', body: JSON.stringify(data),
  });

/** In-person (wet) signature captured on a device at handover. */
export const signInPerson = (id: number, signature_data: string, kind: 'checkout' | 'checkin' = 'checkout') =>
  req<{
    success: true; signed_at: string; witnessed_by: string;
    pdf: string | null; pdf_error: string | null;
    assignment: Assignment; email: MailOutcome;
  }>(`/assignments/${id}/sign-in-person`, {
    method: 'POST', body: JSON.stringify({ signature_data, kind }),
  });

export interface SignatureGaps {
  no_email: number;
  send_failed: number;
  awaiting: number;
  needs_attention: number;
  total_missing: number;
  staff_without_email: number;
}
export const getSignatureGaps = () => req<SignatureGaps>('/assignments/signature-gaps');
/**
 * Check-in takes two shapes against one endpoint:
 *  • `id` names an OPEN record — the normal return.
 *  • no `id` sends the whole entry, and the server reconciles it: with nothing
 *    on file it creates and closes the record in one step, so a return is never
 *    refused just because the check-OUT was never captured.
 */
export const checkin = (data: {
  id?: number;
  keys?: { type: KeyTypeKey; qty: number }[];
  condition_on_return?: string;
  notes?: string | null;
  on_behalf?: boolean;
  /** Manual-entry fields — required when `id` is absent. */
  holder?: string;
  holder_email?: string | null;
  holder_type?: 'employee' | 'ic';
  holder_id?: number | null;
  account_id?: number;
  returned_at?: string | null;
}) =>
  req<{
    success: true; partial: boolean; still_out: KeyLine[]; assignment: Assignment;
    signoff_link: string | null; email: MailOutcome;
    reconciled?: boolean; key_form?: KeyFormDoc | null;
  }>('/assignments/checkin', { method: 'POST', body: JSON.stringify(data) });

export type SignoffKind = 'checkout' | 'checkin';

export const resendSignoff = (id: number, kind?: SignoffKind) =>
  req<{ success: true; kind: SignoffKind; signoff_link: string; email: MailOutcome }>(
    `/assignments/${id}/resend-signoff`, { method: 'POST', body: JSON.stringify({ kind }) }
  );
export const downloadReceipt = async (id: number, kind: SignoffKind = 'checkout') => {
  const res = await reqRaw(`/assignments/${id}/receipt?kind=${kind}`);
  await saveResponseAsFile(res, `CityWide-KeyReceipt-${kind}-${id}.pdf`);
};

// ── Person-to-person transfer ───────────────────────────────────────────────
export interface CurrentHolder {
  holder: string;
  holder_type: 'employee' | 'ic' | null;
  holder_email: string | null;
  holder_id: number | null;
  assignments: number;
  keys: KeyLine[];
  total_keys: number;
}
export const getCurrentHolders = (accountId: number) =>
  req<{ holders: CurrentHolder[] }>(`/assignments/current-holders?account_id=${accountId}`);

export const getTransferable = (accountId: number, holder: string) =>
  req<{
    account: { id: number; name: string; bc_number: string | null };
    holder: string;
    holder_type: 'employee' | 'ic' | null;
    holder_email: string | null;
    keys: KeyLine[];
    total_keys: number;
    assignments: Assignment[];
  }>(`/assignments/transferable?account_id=${accountId}&holder=${encodeURIComponent(holder)}`);

export interface TransferResult {
  success: true;
  transfer_id: string;
  from: { record_id: number; all_record_ids: number[]; holder: string; signoff_link: string; assignment: Assignment };
  to: { record_id: number; holder: string; signoff_link: string; assignment: Assignment };
  keys: KeyLine[];
  total_keys: number;
  signatures: TransferSignatures;
  email: { from: MailOutcome; to: MailOutcome; cara?: string };
}
/** A transfer moves the physical keys, the account assignment, or both. */
export type TransferMode = 'keys' | 'accounts' | 'both';

export const transferKeys = (data: {
  account_id: number;
  mode?: TransferMode;
  /** Which manager column moves, for the account half. */
  account_role?: 'am' | 'ccm';
  from_holder: string;
  to_holder: string;
  to_holder_type: 'employee' | 'ic';
  to_holder_id?: number | null;
  to_holder_email?: string | null;
  keys: { type: KeyTypeKey; qty: number }[];
  due_at?: string | null;
  notes?: string | null;
}) => req<TransferResult & {
  mode: TransferMode;
  account_moved: { role: 'am' | 'ccm'; from: string | null; to: string } | null;
  key_forms: { from: KeyFormDoc | null; to: KeyFormDoc | null };
}>('/assignments/transfer', { method: 'POST', body: JSON.stringify(data) });

// ── Custody Report ──────────────────────────────────────────────────────────
export interface CustodyReportFilters {
  date_from?: string;
  date_to?: string;
  holder?: string;
  client?: string;
  holder_type?: 'all' | 'employee' | 'ic';
  status?: 'all' | 'active' | 'returned' | 'overdue';
  signature?: 'all' | 'signed' | 'awaiting' | 'missing' | 'unresolvable';
}
export interface CustodyReportRow {
  id: number;
  holder: string;
  holder_type: 'employee' | 'ic' | null;
  holder_type_label: string;
  client: string;
  bc_number: string | null;
  keys: KeyLine[];
  keys_summary: string;
  total_keys: number;
  checked_out_at: string | null;
  due_at: string | null;
  returned_at: string | null;
  status: 'checked_out' | 'returned';
  overdue: boolean;
  status_label: string;
  signed_out_at: string | null;
  signed_in_at: string | null;
  signature_status: 'signed' | 'partial' | 'awaiting';
  signature_label: string;
  recorded_by: string | null;
  transfer_id: string | null;
  transfer_role: 'from' | 'to' | null;
  linked_assignment_id: number | null;
  return_reason: string | null;
}
export interface CustodyReportSummary {
  total: number;
  currently_out: number;
  overdue: number;
  awaiting_signature: number;
  no_email: number;
  send_failed: number;
  needs_follow_up: number;
  total_keys_out: number;
}

const custodyQuery = (f: CustodyReportFilters): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v !== undefined && v !== null && v !== '' && v !== 'all') p.set(k, String(v));
  }
  const q = p.toString();
  return q ? `?${q}` : '';
};

export const getCustodyReport = (f: CustodyReportFilters) =>
  req<{ rows: CustodyReportRow[]; summary: CustodyReportSummary; description: string }>(
    `/exports/custody-report${custodyQuery(f)}`
  );

export const exportCustodyReport = async (f: CustodyReportFilters, format: 'xlsx' | 'pdf') => {
  const q = custodyQuery({ ...f });
  const res = await reqRaw(`/exports/custody-report/download${q ? `${q}&` : '?'}format=${format}`);
  await saveResponseAsFile(res, `CityWide-CustodyReport.${format}`);
};

// ── Custody notification recipient (Settings) ───────────────────────────────
export interface CustodyNotificationSetting {
  value: string;
  effective: string[];
  source: 'settings' | 'environment' | 'default';
  updated_at: string | null;
  updated_by: string | null;
}
export const getCustodyNotification = () =>
  req<CustodyNotificationSetting>('/settings/custody-notification');
export const setCustodyNotification = (value: string) =>
  req<CustodyNotificationSetting & { success: true }>('/settings/custody-notification', {
    method: 'PUT', body: JSON.stringify({ value }),
  });

// Public sign-off portal (no JWT — the 48h token is the credential)
export interface SignoffView {
  id: number;
  action: 'checkout' | 'checkin' | 'established';
  holder: string;
  holder_type: 'employee' | 'ic';
  client: string;
  bc_number: string | null;
  keys: KeyLine[];
  total_keys: number;
  checked_out_at: string;
  due_at: string | null;
  returned_at: string | null;
  condition_on_return: string | null;
  recorded_by: string | null;
  signed_at: string | null;
  status: string;
  is_transfer: boolean;
  transfer_counterparty: string | null;
  /** Opening balances: the approximate date the holder has had the keys. */
  held_since: string | null;
  /** Set when ONE acknowledgement covers several clients (bulk rollout). */
  sites: { assignment_id: number; client: string; bc_number: string | null; keys: KeyLine[] }[] | null;
}
export const getSignoffByToken = (token: string) =>
  fetch(`${API_ORIGIN}/api/signoff/${token}`).then((r) => r.json());
// Both factors travel together: the drawn mark and the typed name that ties it
// to the person the keys are recorded against.
export const submitSignoff = (token: string, signature_data: string, typed_name: string) =>
  fetch(`${API_ORIGIN}/api/signoff/${token}/sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signature_data, typed_name }),
  }).then((r) => r.json());

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
export const getStaff = (opts?: { category?: 'all' | 'managers' | 'crew'; includeInactive?: boolean; includeTest?: boolean }) => {
  const p = new URLSearchParams();
  if (opts?.category && opts.category !== 'all') p.set('category', opts.category);
  if (opts?.includeInactive) p.set('include_inactive', '1');
  if (opts?.includeTest) p.set('include_test', '1');
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
  /** "Export selected" — exactly these account ids. */
  ids?: number[];
  /** Test fixtures are left out unless this is ticked. */
  includeTest?: boolean;
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
// ── Bulk selection ───────────────────────────────────────────────────────────
/** The minimal shape the selection toolbar needs to decide which bulk actions
 *  are legal. Never the full row — and never a code of any kind. */
export interface AccountIdItem {
  id: number;
  ic_company_name: string;
  record_type: string | null;
  account_manager: string | null;
  ccm_manager: string | null;
  archived: number;
  pending_handover: number;
}

/** Every id matching the CURRENT filter — powers "Select all N matching". */
export const getAccountIds = (params: Record<string, string>) =>
  req<{ ids: number[]; items: AccountIdItem[]; total: number }>(
    `/accounts/ids?${new URLSearchParams(params)}`
  );

/** Archive N records in one transaction. Rows holding checked-out keys are
 *  refused individually and named back. Requires the can_delete gate. */
export const bulkArchiveAccounts = (ids: number[]) =>
  req<{
    archived: number; archivedNames: string[];
    blocked: { id: number; name: string; reason?: 'checked_out' | 'test_fixture' }[];
    alreadyArchived: number; notFound: number;
  }>('/accounts/bulk-archive', { method: 'POST', body: JSON.stringify({ ids }) });

export const previewImport = async (file: File) => {
  const fd = new FormData();
  fd.append('file', file);
  const res = await reqRaw('/accounts/import', { method: 'POST', body: fd });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(e.error || 'Import failed');
  }
  // The uploader handles three sheet shapes. The two email backfills come back
  // tagged with `kind` and a DRY-RUN preview instead of the valid/warnings/
  // errors triple the customer registry sheet returns.
  return res.json() as Promise<ImportPreview>;
};

export type EmailImportKind = 'staff-emails' | 'ic-emails';

export interface HeaderReport {
  recognized: { header: string; field: string }[];
  unrecognized: string[];
  ignoredByDesign: string[];
}

export interface StaffEmailPreview {
  totalRows: number;
  matchedUpdated: { name: string; email: string }[];
  matchedAlreadyHadEmail: { name: string; existing: string; incoming: string }[];
  created: { name: string; email: string; role_category: string; manager_type: string }[];
  ambiguous: { name: string; ids: number[] }[];
  invalidEmail: { row: number; name: string; value: string }[];
  remainingWithoutEmail: { id: number; name: string; role_category: string }[];
  fieldFills: Record<string, number>;
}

export interface IcEmailPreview {
  totalRows: number;
  matchedUpdated: { vendor: string; dba: string; contact: string; email: string }[];
  matchedAlreadyPopulated: { vendor: string; dba: string }[];
  created: { vendor: string; dba: string; contact: string; email: string }[];
  missingEmail: { row: number; dba: string; vendor: string }[];
  missingVendorNo: { row: number; dba: string; email: string }[];
  invalidEmail: { row: number; dba: string; value: string }[];
  duplicateVendorNos: { vendor: string; count: number }[];
  vendorPadded: { row: number; dba: string; vendor: string }[];
  fieldFills: Record<string, number>;
}

export interface IcResolution {
  totalCustomers: number;
  resolved: number;
  unresolvedNoVendorNo: number;
  unresolvedNoMatchingIc: number;
  unresolvedIcHasNoEmail: number;
  samples: { customer: string; bc_vendor_number: string; reason: string }[];
}

export type ImportPreview =
  | { kind?: undefined; valid: any[]; warnings: any[]; errors: any[]; total: number;
      unmappedHeaders?: string[]; fieldCollisions?: { field: string; headers: string[] }[] }
  | { kind: 'staff-emails'; sheet: string; rows: any[]; headers: HeaderReport; preview: StaffEmailPreview }
  | { kind: 'ic-emails'; sheet: string; rows: any[]; headers: HeaderReport; preview: IcEmailPreview; resolutionBefore: IcResolution };

export const confirmImport = (rows: any[], mode?: 'insert' | 'upsert') =>
  req<{ inserted: number; updated?: number; skipped: number; errors?: any[] }>('/accounts/import/confirm', {
    method: 'POST', body: JSON.stringify({ rows, mode }),
  });

/** Apply an email backfill. Idempotent — only ever fills blanks. */
export const confirmEmailImport = (kind: EmailImportKind, rows: any[]) =>
  req<{ kind: EmailImportKind; report: any; resolution?: IcResolution }>(
    '/accounts/import/emails/confirm',
    { method: 'POST', body: JSON.stringify({ kind, rows }) },
  );

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

// ── Bulk manager reassignment ───────────────────────────────────────────────
export interface ReassignClient {
  id: number;
  name: string;
  bc_client_number: string | null;
  keys: { type: string; label: string; qty: number }[];
  total_keys: number;
  pending_handover: boolean;
}
export interface ReassignTarget {
  id: number;
  name: string;
  manager_type: string;
  email: string | null;
  clients_managed: number;
}
export interface ReassignablePayload {
  source: { id: number; name: string; manager_type: string; email: string | null };
  role: 'am' | 'ccm';
  role_label: string;
  clients: ReassignClient[];
  targets: ReassignTarget[];
  summary: { clients: number; keys: number; key_types: number };
}
export const getReassignable = (staffId: number, role: 'am' | 'ccm') =>
  req<ReassignablePayload>(`/managers/${staffId}/reassignable?role=${role}`);

export const reassignManager = (data: {
  fromId: number;
  toId: number;
  clientIds: number[];
  role: 'am' | 'ccm';
  sendHandover: boolean;
}) =>
  req<{
    success: true; audit_id: number; from: string; to: string; role: 'am' | 'ccm';
    totalClients: number; totalKeys: number; keyTypesAffected: string[];
    pending_handover: boolean; email: MailOutcome | null;
  }>('/managers/reassign', { method: 'POST', body: JSON.stringify(data) });

export const undoReassignment = (auditId: number) =>
  req<{ success: true; restored: number; skipped: number; message: string }>(
    `/managers/reassign/${auditId}/undo`, { method: 'POST' }
  );

export interface PendingHandover {
  id: number;
  ic_company_name: string;
  bc_client_number: string | null;
  pending_handover_from: string | null;
  pending_handover_to: string | null;
  pending_handover_role: string | null;
  pending_handover_at: string | null;
}
export const getPendingHandovers = () =>
  req<{ pending: PendingHandover[]; count: number }>('/managers/handover/pending');

export const confirmHandover = (clientIds: number[]) =>
  req<{ success: true; confirmed: number }>('/managers/handover/confirm', {
    method: 'POST', body: JSON.stringify({ clientIds }),
  });
