import { useEffect, useMemo, useRef, useState } from 'react';
import Modal from './Modal';
import SignaturePad, { type SignaturePadHandle } from './SignaturePad';
import { getManager } from '../lib/auth';
import {
  getAccounts, getKeyAvailability, getHolders, getRecentHolders, checkout, checkin, getAssignments, saveHolderEmail,
  getCheckoutContext, getCheckinContext, signInPerson, resendSignoff,
  type Assignment, type HolderOption, type KeyAvailability, type KeyTypeKey, type MailOutcome,
  type SignatureStatus,
} from '../lib/api';

// ── Shared pieces ────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-bold uppercase tracking-widest text-[#1a1a1a] border-b border-gray-200 pb-1 mb-3">
      {children}
    </div>
  );
}

// Timestamps arrive as ISO strings from new rows and as SQLite 'YYYY-MM-DD
// HH:MM:SS' (UTC, no zone) from older ones — parse both without inventing a
// zone on a string that already has one.
function parseStamp(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(/[TZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function ErrorBanner({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-[#C0272D] bg-[#fbeaea] border border-[#f0c9cb] rounded px-3 py-2">{children}</p>;
}

/**
 * Email outcome banner. SMTP failures are surfaced here rather than swallowed —
 * a custody record whose notification never landed must be visible.
 */
export function MailBanner({ mail, kind }: { mail: MailOutcome; kind: 'checkout' | 'checkin' }) {
  if (mail.ok) {
    return (
      <div className="text-sm bg-green-50 border border-green-200 text-green-800 rounded px-3 py-2">
        ✓ {kind === 'checkout' ? 'Check-out' : 'Return'} email sent to {mail.recipients.join(', ')}
      </div>
    );
  }
  return (
    <div className="text-sm bg-[#fff8e6] border border-[#e8cf8a] text-[#7a5a00] rounded px-3 py-2">
      ⚠ The record was saved, but the email did not send{mail.error ? `: ${mail.error}` : '.'}
      {mail.recipients.length > 0 && <> Intended recipients: {mail.recipients.join(', ')}.</>}
      {' '}It is logged in the Audit Log as <span className="font-mono">custody_email_failed</span>.
    </div>
  );
}

/**
 * The missing-email gate. Shown the moment a holder with no address on file is
 * selected — before anything is saved — offering the two ways forward the spec
 * requires. Nothing here is a dead end: either the gap gets closed permanently,
 * or the release is recorded with a written reason and flagged in red.
 */
export function MissingEmailWarning({
  holder, holderType, holderId, onEmailSaved,
  proceeding, setProceeding, reason, setReason,
  context = 'signature',
}: {
  holder: string;
  holderType: 'employee' | 'ic';
  holderId: number | null;
  onEmailSaved: (email: string) => void;
  proceeding: boolean;
  setProceeding: (v: boolean) => void;
  reason: string;
  setReason: (v: string) => void;
  /** 'signature' blocks a sign-off; 'notification' only loses a confirmation. */
  context?: 'signature' | 'notification';
}) {
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (holderId == null) {
      // A free-typed name has no record to attach an address to.
      onEmailSaved(email.trim());
      setAdding(false);
      return;
    }
    setSaving(true); setError('');
    try {
      const r = await saveHolderEmail({ holder_type: holderType, holder_id: holderId, email: email.trim() });
      onEmailSaved(r.email);
      setAdding(false);
    } catch (e: any) {
      setError(e?.message || 'Could not save the email');
    } finally { setSaving(false); }
  };

  return (
    <div className="rounded border-2 border-[#C0272D] bg-[#fbeaea] px-4 py-3 space-y-3">
      <div className="text-sm font-semibold text-[#C0272D]">
        {holder} has no email on file — {context === 'signature'
          ? 'signature cannot be sent.'
          : 'they will not receive the confirmation.'}
      </div>

      {!adding && !proceeding && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="px-3 py-1.5 bg-[#C0272D] text-white text-xs font-medium rounded hover:bg-[#a82227] transition-colors"
          >
            Add email
          </button>
          <button
            type="button"
            onClick={() => setProceeding(true)}
            className="px-3 py-1.5 border border-[#1a1a1a] text-[#1a1a1a] text-xs font-medium rounded hover:bg-white transition-colors"
          >
            {context === 'signature' ? 'Continue without signature' : 'Continue without notifying them'}
          </button>
        </div>
      )}

      {adding && (
        <div className="space-y-2">
          <label className="block text-xs font-medium text-[#1a1a1a]">
            Email for {holder}
            <span className="font-normal text-gray-500">
              {holderId != null ? ' — saved to their record permanently' : ' — used for this record only'}
            </span>
          </label>
          <div className="flex gap-2">
            <input
              type="email"
              autoFocus
              className="input flex-1 focus:ring-[#C0272D] focus:border-[#C0272D]"
              placeholder="name@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button
              type="button"
              onClick={save}
              disabled={saving || !email.trim()}
              className="px-3 py-1.5 bg-[#C0272D] text-white text-xs font-medium rounded hover:bg-[#a82227] disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => { setAdding(false); setError(''); }}
              className="px-3 py-1.5 border border-[#1a1a1a] text-[#1a1a1a] text-xs font-medium rounded hover:bg-white transition-colors"
            >
              Cancel
            </button>
          </div>
          {error && <p className="text-xs text-[#C0272D]">{error}</p>}
        </div>
      )}

      {proceeding && (
        <div className="space-y-2">
          <label className="block text-xs font-medium text-[#1a1a1a]">
            Why are the keys being released without a signature? <span className="text-[#C0272D]">*</span>
          </label>
          <input
            autoFocus
            className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
            placeholder="e.g. Subcontractor on site, address to follow"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="text-[11px] text-[#1a1a1a]">
            This record will be flagged <strong>No signature — no email on file</strong> in red until an email is
            added or someone signs it in person. Cara is notified either way.
          </p>
          <button
            type="button"
            onClick={() => { setProceeding(false); setReason(''); }}
            className="text-xs text-[#C0272D] hover:underline"
          >
            ← Back
          </button>
        </div>
      )}
    </div>
  );
}

// A client picker that pre-fills from the selected registry row and otherwise
// searches the whole registry server-side (the list is 578+ rows).
export function ClientPicker({
  value, onSelect,
}: {
  value: { id: number; name: string } | null;
  onSelect: (v: { id: number; name: string } | null) => void;
}) {
  const [search, setSearch] = useState(value?.name ?? '');
  const [results, setResults] = useState<any[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (value || !search.trim()) { setResults([]); return; }
    const id = setTimeout(() => {
      getAccounts({ search, type: 'all', limit: '20' })
        .then((d) => { setResults(d.accounts); setOpen(true); })
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(id);
  }, [search, value]);

  return (
    <div className="relative">
      <input
        className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
        placeholder="Search clients and IC vendors…"
        value={search}
        onChange={(e) => { setSearch(e.target.value); onSelect(null); }}
      />
      {open && !value && results.length > 0 && (
        <div className="absolute z-30 w-full bg-white border border-cw-border rounded shadow-lg max-h-52 overflow-y-auto mt-1">
          {results.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => { onSelect({ id: a.id, name: a.ic_company_name }); setSearch(a.ic_company_name); setOpen(false); }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center justify-between gap-2"
            >
              <span className="truncate">{a.ic_company_name}</span>
              <span className="text-[10px] uppercase tracking-wide text-cw-muted shrink-0">
                {a.record_type === 'customer' ? 'Customer' : 'IC'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Multi-key checkbox list ──────────────────────────────────────────────────
// Every key type available AT the client, each with a checkbox and a quantity.
// Quantity is clamped to what is actually left, and a type with nothing left is
// disabled rather than silently accepting an impossible number.
export interface Pick { checked: boolean; qty: number }

export function KeyPickerList({
  rows, picks, setPicks, availableLabel = 'available', emptyNote,
}: {
  rows: { type: KeyTypeKey; label: string; available: number; hint?: string }[];
  picks: Record<string, Pick>;
  setPicks: (p: Record<string, Pick>) => void;
  availableLabel?: string;
  emptyNote: string;
}) {
  const set = (type: string, patch: Partial<Pick>) =>
    setPicks({ ...picks, [type]: { ...(picks[type] ?? { checked: false, qty: 1 }), ...patch } });

  if (!rows.length) return <p className="text-sm text-cw-muted">{emptyNote}</p>;

  return (
    <div className="border border-cw-border rounded divide-y divide-gray-100">
      {rows.map((r) => {
        const pick = picks[r.type] ?? { checked: false, qty: 1 };
        const none = r.available <= 0;
        const boxId = `keypick-${r.type}`;
        return (
          <div
            key={r.type}
            className={`flex items-center gap-3 px-3 py-2.5 text-sm ${none ? 'opacity-45' : 'hover:bg-[#faf9f8]'}`}
          >
            <input
              id={boxId}
              type="checkbox"
              className="h-4 w-4 accent-[#C0272D] cursor-pointer disabled:cursor-not-allowed"
              disabled={none}
              checked={!!pick.checked && !none}
              onChange={(e) => set(r.type, { checked: e.target.checked, qty: Math.min(pick.qty || 1, r.available) || 1 })}
            />
            <label htmlFor={boxId} className={`font-medium text-[#1a1a1a] whitespace-nowrap min-w-[7.5rem] ${none ? '' : 'cursor-pointer'}`}>
              {r.label}
            </label>
            <span className="flex-1 text-xs text-cw-muted whitespace-nowrap">
              ({availableLabel}: <span className={none ? 'text-[#C0272D] font-semibold' : 'font-semibold text-[#1a1a1a]'}>{r.available}</span>)
              {r.hint && <span className="ml-1 text-gray-400">{r.hint}</span>}
            </span>
            <input
              type="number"
              min={1}
              max={Math.max(1, r.available)}
              disabled={none || !pick.checked}
              value={pick.qty}
              onChange={(e) => {
                const n = Math.max(1, Math.min(Number(e.target.value) || 1, r.available));
                set(r.type, { qty: n });
              }}
              className="input w-16 text-center px-1 py-1 disabled:bg-gray-100 disabled:text-gray-400 focus:ring-[#C0272D] focus:border-[#C0272D]"
              aria-label={`${r.label} quantity`}
            />
          </div>
        );
      })}
    </div>
  );
}

export function selectedLines(picks: Record<string, Pick>): { type: KeyTypeKey; qty: number }[] {
  return Object.entries(picks)
    .filter(([, p]) => p.checked && p.qty > 0)
    .map(([type, p]) => ({ type: type as KeyTypeKey, qty: p.qty }));
}

// ── "Recording for" picker (self-service vs on-behalf) ───────────────────────
// Two things sit above the full roster: whoever the client already assigns
// (passed in as `suggested`, and normally already selected), and the people
// who have actually held keys lately. An alphabetical list of 260+ records put
// the person standing in front of you somewhere in the middle of a scroll.
export function HolderPicker({
  mode, setMode, holder, setHolder, placeholder = '— Select the person receiving the keys —',
  suggested = null,
}: {
  mode: 'self' | 'other';
  setMode: (m: 'self' | 'other') => void;
  holder: HolderOption | null;
  setHolder: (h: HolderOption | null) => void;
  /** Overridden for opening balances, where nobody is RECEIVING anything. */
  placeholder?: string;
  /** The client's assigned IC or AM, pinned to the top with its reason. */
  suggested?: (HolderOption & { reason?: string }) | null;
}) {
  const me = getManager();
  const [options, setOptions] = useState<{ employees: HolderOption[]; ics: HolderOption[] }>({ employees: [], ics: [] });
  const [recent, setRecent] = useState<HolderOption[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const loaded = useRef(false);

  useEffect(() => {
    if (mode !== 'other' || loaded.current) return;
    loaded.current = true;
    setLoading(true);
    getHolders().then(setOptions).catch(() => setOptions({ employees: [], ics: [] })).finally(() => setLoading(false));
    getRecentHolders(6)
      .then((d) => setRecent(d.holders.map((h) => ({
        id: h.id, name: h.name, email: h.email, type: h.type,
        detail: h.type === 'ic' ? 'IC' : 'Employee', has_email: !!h.email,
      }))))
      .catch(() => setRecent([]));
  }, [mode]);

  const sameHolder = (a: HolderOption | null, b: HolderOption | null) =>
    !!a && !!b && a.type === b.type && a.name === b.name;

  // The suggestion is not repeated in the recent strip — one row, one person.
  const recentShown = recent.filter((r) => !sameHolder(r, suggested ?? null)).slice(0, 5);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (o: HolderOption) => !q || o.name.toLowerCase().includes(q) || (o.email || '').toLowerCase().includes(q);
    return { employees: options.employees.filter(match), ics: options.ics.filter(match) };
  }, [options, query]);

  return (
    <div className="space-y-3">
      <div className="flex gap-4">
        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
          <input type="radio" className="accent-[#C0272D]" checked={mode === 'self'} onChange={() => { setMode('self'); setHolder(null); }} />
          Myself <span className="text-gray-400">— {me?.name}</span>
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
          <input type="radio" className="accent-[#C0272D]" checked={mode === 'other'} onChange={() => setMode('other')} />
          Recording for someone else
        </label>
      </div>

      {mode === 'other' && (
        <div className="space-y-2">
          {(suggested || recentShown.length > 0) && (
            <div className="flex flex-wrap gap-1.5">
              {suggested && (
                <button
                  type="button"
                  onClick={() => setHolder(suggested)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs transition-colors ${
                    sameHolder(holder, suggested)
                      ? 'bg-[#C0272D] border-[#C0272D] text-white'
                      : 'bg-white border-cw-border text-[#1a1a1a] hover:border-[#C0272D]'
                  }`}
                  title={`Assigned to this client${suggested.email ? ` · ${suggested.email}` : ''}`}
                >
                  <span className="font-medium truncate max-w-[15rem]">{suggested.name}</span>
                  <span className={sameHolder(holder, suggested) ? 'text-white/75' : 'text-cw-muted'}>
                    {suggested.reason ?? 'assigned'}
                  </span>
                </button>
              )}
              {recentShown.map((r) => (
                <button
                  key={`${r.type}:${r.id ?? r.name}`}
                  type="button"
                  onClick={() => setHolder(r)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs transition-colors ${
                    sameHolder(holder, r)
                      ? 'bg-[#1a1a1a] border-[#1a1a1a] text-white'
                      : 'bg-white border-cw-border text-[#1a1a1a] hover:border-[#1a1a1a]'
                  }`}
                  title={r.email ?? 'No email on file'}
                >
                  <span className="truncate max-w-[13rem]">{r.name}</span>
                  <span className={sameHolder(holder, r) ? 'text-white/60' : 'text-gray-400'}>recent</span>
                </button>
              ))}
            </div>
          )}
          <input
            className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
            placeholder="Filter staff and IC vendors…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
            value={holder ? `${holder.type}:${holder.id ?? 'unlinked'}` : ''}
            onChange={(e) => {
              const [type, id] = e.target.value.split(':');
              // Re-picking the unlinked entry keeps the holder it stands for;
              // looking it up by id would find nothing and silently clear it.
              if (id === 'unlinked') return;
              const list = type === 'ic' ? options.ics : options.employees;
              setHolder(list.find((o) => String(o.id) === id) ?? null);
            }}
            size={1}
          >
            <option value="">{loading ? 'Loading roster…' : placeholder}</option>
            {/* A holder named on a client row can have no vendor or roster
                record behind them. Still selectable — just not linkable. */}
            {holder && holder.id == null && (
              <option value={`${holder.type}:unlinked`}>{holder.name}</option>
            )}
            {filtered.employees.length > 0 && (
              <optgroup label="City Wide Employees">
                {filtered.employees.map((o) => (
                  <option key={`employee:${o.id}`} value={`employee:${o.id}`}>
                    {o.name}{o.detail ? ` — ${o.detail}` : ''}
                  </option>
                ))}
              </optgroup>
            )}
            {filtered.ics.length > 0 && (
              <optgroup label="Independent Contractors">
                {filtered.ics.map((o) => (
                  <option key={`ic:${o.id}`} value={`ic:${o.id}`}>{o.name}</option>
                ))}
              </optgroup>
            )}
          </select>
          {holder && !holder.email && (
            <p className="text-[11px] text-[#7a5a00] bg-[#fff8e6] border border-[#e8cf8a] rounded px-2 py-1.5">
              No email on file for {holder.name} — enter one below so they receive the notification and sign-off link.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Sign-now step ────────────────────────────────────────────────────────────
// The default ending for a custody event: the person is standing there, so the
// pad opens the moment the record is written rather than an email going out
// asking them to do later what they could do now. Everything it posts goes
// through the same sign-in-person route the recovery flow uses — same PDF,
// same audit, same recorded witness.
export function SignNowStep({
  assignment, kind, onSigned, onSkip, intro,
}: {
  assignment: Assignment;
  kind: 'checkout' | 'checkin';
  onSigned: (r: { mail: MailOutcome; pdfError: string | null }) => void;
  /** Leaves the record awaiting a signature — never a dead end, because the
   *  48h link is already minted and the registry flags it. */
  onSkip: () => void;
  intro?: React.ReactNode;
}) {
  const me = getManager();
  const padRef = useRef<SignaturePadHandle>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    const signature = padRef.current?.toDataURL();
    if (!signature) { setError(`Ask ${assignment.holder} to sign in the box before confirming.`); return; }
    setSaving(true); setError('');
    try {
      const r = await signInPerson(assignment.id, signature, kind);
      onSigned({ mail: r.email, pdfError: r.pdf_error });
    } catch (e: any) {
      setError(e?.message || 'Could not save the signature');
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-4">
      {intro}
      <div className="rounded border border-cw-border bg-[#f4f4f2] px-4 py-3 text-sm">
        <div className="font-semibold text-[#1a1a1a]">{assignment.holder}</div>
        <div className="text-cw-muted text-xs mt-0.5">{assignment.account_name}</div>
        <div className="mt-2 flex flex-wrap gap-1">
          {assignment.keys.map((k) => (
            <span key={k.type} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white border border-cw-border text-[11px]">
              {k.label}<span className="font-bold text-[#C0272D]">×{k.qty}</span>
            </span>
          ))}
        </div>
      </div>

      <label className="flex items-start gap-3 text-sm cursor-pointer">
        <input
          type="checkbox"
          className="h-4 w-4 mt-0.5 accent-[#C0272D]"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
        />
        <span className="text-cw-text">
          {kind === 'checkin'
            ? `${assignment.holder} confirms they are returning these keys to City Wide Boston.`
            : `${assignment.holder} acknowledges receipt of these keys, and agrees to safeguard them, not duplicate or share them, return them on request, and report any loss within 24 hours.`}
        </span>
      </label>

      <div>
        <div className="text-xs font-medium text-gray-600 mb-2">
          Signature — hand the device to {assignment.holder}
        </div>
        <SignaturePad ref={padRef} />
      </div>

      <p className="text-[11px] text-gray-400">
        Recorded as witnessed by <span className="font-semibold text-[#1a1a1a]">{me?.name}</span>.
        The signed PDF goes to {assignment.holder_email ? `${assignment.holder_email}, ` : ''}Cara.
      </p>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <div className="flex flex-wrap items-center gap-2 pt-4 border-t border-gray-200">
        <button
          onClick={submit}
          disabled={saving || !acknowledged}
          className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? 'Saving signature…' : 'Confirm signature'}
        </button>
        <button
          onClick={onSkip}
          disabled={saving}
          className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:bg-gray-50 transition-colors"
        >
          Email the link instead
        </button>
        <span className="text-[11px] text-gray-400 ml-auto">
          The keys are already recorded — this adds the signature.
        </span>
      </div>
    </div>
  );
}

// ── Check Out modal ──────────────────────────────────────────────────────────

export function CheckOutModal({
  presetAccount, onClose, onDone,
}: {
  presetAccount: { id: number; name: string } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const me = getManager();
  const [account, setAccount] = useState<{ id: number; name: string } | null>(presetAccount);
  const [avail, setAvail] = useState<KeyAvailability[]>([]);
  const [availLoading, setAvailLoading] = useState(false);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [mode, setMode] = useState<'self' | 'other'>('self');
  const [holder, setHolder] = useState<HolderOption | null>(null);
  const [suggested, setSuggested] = useState<(HolderOption & { reason?: string }) | null>(null);
  const [email, setEmail] = useState(me?.email ?? '');
  const [dueAt, setDueAt] = useState('');
  const [notes, setNotes] = useState('');
  // Due date and notes are collapsed: most handovers need neither, and an
  // always-visible empty field reads as something still to fill in.
  const [showMore, setShowMore] = useState(false);
  // Sign-now is the default. The person is standing at the handover; emailing
  // a link asks them to come back to it later from somewhere else.
  const [signMode, setSignMode] = useState<'in_person' | 'email'>('in_person');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [proceedUnsigned, setProceedUnsigned] = useState(false);
  const [noEmailReason, setNoEmailReason] = useState('');
  // Set the moment the record is written, so the pad can open on top of it.
  const [signing, setSigning] = useState<Assignment | null>(null);
  const [done, setDone] = useState<{
    mail: MailOutcome; link: string | null; holder: string; status: SignatureStatus;
    signed?: boolean; pdfError?: string | null;
  } | null>(null);

  // ── The form opens already answered ───────────────────────────────────────
  // One call brings back the client's key types with a suggested quantity, the
  // person normally holding them, and a due date. Everything remains editable;
  // none of it starts blank.
  useEffect(() => {
    if (!account) { setAvail([]); setPicks({}); setSuggested(null); return; }
    setAvailLoading(true);
    let cancelled = false;
    getCheckoutContext(account.id)
      .then((ctx) => {
        if (cancelled) return;
        setAvail(ctx.keys);
        setPicks(Object.fromEntries(
          ctx.keys
            .filter((k) => k.suggested > 0)
            .map((k) => [k.type, { checked: true, qty: k.suggested }])
        ));
        setDueAt(ctx.due_at);
        if (ctx.suggested_holder) {
          const h: HolderOption & { reason?: string } = {
            id: ctx.suggested_holder.id,
            name: ctx.suggested_holder.name,
            email: ctx.suggested_holder.email,
            type: ctx.suggested_holder.type,
            detail: ctx.suggested_holder.reason,
            has_email: ctx.suggested_holder.has_email,
            reason: ctx.suggested_holder.reason,
          };
          setSuggested(h);
          setMode('other');
          setHolder(h);
        } else {
          setSuggested(null);
        }
      })
      .catch(() => { if (!cancelled) { setAvail([]); setPicks({}); setSuggested(null); } })
      .finally(() => { if (!cancelled) setAvailLoading(false); });
    return () => { cancelled = true; };
  }, [account]);

  useEffect(() => {
    if (mode === 'self') setEmail(me?.email ?? '');
    else setEmail(holder?.email ?? '');
    // A new holder is a new decision — never carry a previous "proceed unsigned"
    // choice onto a different person.
    setProceedUnsigned(false);
    setNoEmailReason('');
  }, [mode, holder, me?.email]);

  const holderName = mode === 'self' ? (me?.name ?? '') : (holder?.name ?? '');
  const holderType: 'employee' | 'ic' = mode === 'self' ? 'employee' : (holder?.type ?? 'employee');
  const lines = selectedLines(picks);
  const totalKeys = lines.reduce((n, l) => n + l.qty, 0);
  const holderChosen = mode === 'self' || !!holder;
  const missingEmail = holderChosen && !email.trim();
  // With no address, the only way forward is an explicit, written reason.
  const emailResolved = !missingEmail || (proceedUnsigned && noEmailReason.trim().length > 0);
  const canSubmit = !!account && !!holderName && lines.length > 0 && emailResolved && !saving;

  const submit = async () => {
    if (!canSubmit || !account) return;
    setSaving(true); setError('');
    // No address means no link to email, so there is nothing to sign remotely
    // — the on-device pad is the only way this record gets a signature at all.
    const effectiveSignMode = missingEmail ? 'in_person' : signMode;
    try {
      const r = await checkout({
        account_id: account.id,
        account_name: account.name,
        holder: holderName,
        holder_email: email.trim() || null,
        holder_type: holderType,
        holder_id: mode === 'other' ? holder?.id ?? null : null,
        keys: lines,
        due_at: dueAt || null,
        notes: notes.trim() || null,
        on_behalf: mode === 'other',
        no_email_reason: missingEmail ? noEmailReason.trim() : null,
        sign_mode: effectiveSignMode,
      });
      onDone();
      if (effectiveSignMode === 'in_person') {
        // The keys are recorded; the pad opens on top of that record.
        setSigning(r.assignment);
      } else {
        setDone({ mail: r.email, link: r.signoff_link, holder: holderName, status: r.signature_status });
      }
    } catch (e: any) {
      setError(e?.message || 'Check-out failed');
    } finally {
      setSaving(false);
    }
  };

  // Closing the pad without signing must not lose the link: send it, so the
  // record leaves this modal either signed or actively chasing a signature.
  const emailInstead = async () => {
    if (!signing) return;
    let mail: MailOutcome = { ok: false, recipients: [], skipped: true };
    let link: string | null = null;
    try {
      const r = await resendSignoff(signing.id, 'checkout');
      mail = r.email; link = r.signoff_link;
    } catch (e: any) {
      mail = { ok: false, recipients: [], error: e?.message || 'Could not send the sign-off link' };
    }
    setDone({ mail, link, holder: signing.holder, status: 'awaiting_signature' });
    setSigning(null);
  };

  if (signing) {
    return (
      <Modal title="Sign for the keys" onClose={onClose} width="max-w-lg">
        <SignNowStep
          assignment={signing}
          kind="checkout"
          intro={
            <div className="text-sm bg-green-50 border border-green-200 text-green-800 rounded px-3 py-2">
              ✓ {signing.total_keys} key{signing.total_keys === 1 ? '' : 's'} recorded to {signing.holder}. One
              signature and this is complete.
            </div>
          }
          onSigned={({ mail, pdfError }) => {
            setSigning(null);
            setDone({
              mail, link: null, holder: signing.holder, status: 'signed',
              signed: true, pdfError,
            });
          }}
          onSkip={emailInstead}
        />
      </Modal>
    );
  }

  if (done) {
    return (
      <Modal title={done.signed ? 'Signed and checked out' : 'Keys checked out'} onClose={onClose} width="max-w-lg">
        <div className="space-y-4">
          <div className="text-sm text-cw-text">
            <span className="font-semibold">{totalKeys}</span> key{totalKeys === 1 ? '' : 's'} checked out to{' '}
            <span className="font-semibold">{done.holder}</span> for <span className="font-semibold">{account?.name}</span>
            {done.signed ? ', signed on this device.' : '.'}
          </div>
          {done.pdfError && (
            <div className="text-sm bg-[#fff8e6] border border-[#e8cf8a] text-[#7a5a00] rounded px-3 py-2">
              ⚠ The signature is saved, but the PDF receipt failed to generate ({done.pdfError}).
            </div>
          )}
          {done.status === 'signature_unavailable' ? (
            <div className="text-sm bg-[#fbeaea] border-2 border-[#C0272D] text-[#C0272D] rounded px-3 py-2">
              <strong>No signature was sent.</strong> {done.holder} has no email on file, so this record is
              flagged <em>No signature — no email on file</em> in the registry. Cara was notified, and it will
              stay flagged until someone adds an email or signs it in person.
            </div>
          ) : (
            <MailBanner mail={done.mail} kind="checkout" />
          )}
          {done.link && (
            <div className="text-xs text-cw-muted">
              Sign-off link (48-hour expiry) — also included in the email:
              <div className="mt-1 font-mono break-all bg-gray-50 border border-cw-border rounded px-2 py-1.5">{done.link}</div>
            </div>
          )}
        </div>
        <div className="flex gap-2 pt-4 border-t border-gray-200 mt-4">
          <button onClick={onClose} className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] transition-colors">Done</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Check Out Keys" onClose={onClose} width="max-w-lg">
      <div className="space-y-5 max-h-[70vh] overflow-y-auto pr-1">
        <div>
          <SectionLabel>Client</SectionLabel>
          <ClientPicker value={account} onSelect={setAccount} />
          {presetAccount && account?.id === presetAccount.id && (
            <p className="text-[11px] text-gray-400 mt-1">Pre-filled from the row selected in the registry.</p>
          )}
        </div>

        <div>
          <SectionLabel>Keys</SectionLabel>
          {!account ? (
            <p className="text-sm text-cw-muted">Select a client to see which keys are available.</p>
          ) : availLoading ? (
            <p className="text-sm text-cw-muted">Loading availability…</p>
          ) : (
            <>
              <KeyPickerList
                rows={avail.map((a) => ({
                  type: a.type,
                  label: a.label,
                  available: a.available,
                  hint: a.checked_out ? `· ${a.checked_out} out of ${a.site_total}` : undefined,
                }))}
                picks={picks}
                setPicks={setPicks}
                emptyNote="No key inventory recorded for this client."
              />
              <p className="text-[11px] text-gray-400 mt-2">
                Available = the client-site total minus what is already checked out. A type with 0 left cannot be taken.
              </p>
            </>
          )}
        </div>

        <div>
          <SectionLabel>Who is taking the keys</SectionLabel>
          <HolderPicker mode={mode} setMode={setMode} holder={holder} setHolder={setHolder} suggested={suggested} />
          <div className="mt-3">
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Holder email <span className="text-gray-400 font-normal">— receives the notification + sign-off link</span>
            </label>
            <input
              type="email"
              className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
            />
          </div>

          {/* Blocked at entry — surfaced the moment the holder is chosen, not
              after the record has already been written. */}
          {missingEmail && (
            <div className="mt-3">
              <MissingEmailWarning
                holder={holderName}
                holderType={holderType}
                holderId={mode === 'other' ? holder?.id ?? null : null}
                onEmailSaved={(saved) => { setEmail(saved); setProceedUnsigned(false); setNoEmailReason(''); }}
                proceeding={proceedUnsigned}
                setProceeding={setProceedUnsigned}
                reason={noEmailReason}
                setReason={setNoEmailReason}
              />
            </div>
          )}
        </div>

        {/* Everything most handovers never touch, folded away. The due date is
            already set, so the summary line says what it is rather than
            leaving a field that looks unfinished. */}
        <div>
          <button
            type="button"
            onClick={() => setShowMore((v) => !v)}
            className="flex items-center gap-2 text-xs font-medium text-[#1a1a1a] hover:text-[#C0272D] transition-colors"
          >
            <span className={`inline-block transition-transform ${showMore ? 'rotate-90' : ''}`}>›</span>
            More options
            {!showMore && (
              <span className="font-normal text-gray-400">
                due {dueAt || 'not set'}{notes.trim() ? ' · notes added' : ''}
              </span>
            )}
          </button>
          {showMore && (
            <div className="space-y-3 mt-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Due back</label>
                <input type="date" className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
                <textarea className="input h-16 resize-none focus:ring-[#C0272D] focus:border-[#C0272D]" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>
            </div>
          )}
        </div>

        {error && <ErrorBanner>{error}</ErrorBanner>}
      </div>

      <div className="pt-4 border-t border-gray-200 mt-4 space-y-3">
        {/* Outside the scroll area on purpose: this decides what the primary
            button does, so it must never be a scroll away from it. */}
        {!missingEmail && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-xs font-medium text-[#1a1a1a]">Signature</span>
            {([
              ['in_person', 'Sign here now', 'they are at the handover'],
              ['email', 'Email the link', 'they are not here'],
            ] as const).map(([value, label, hint]) => (
              <label key={value} className="flex items-center gap-1.5 text-sm cursor-pointer">
                <input
                  type="radio"
                  className="accent-[#C0272D]"
                  checked={signMode === value}
                  onChange={() => setSignMode(value)}
                />
                <span className={signMode === value ? 'font-medium text-[#1a1a1a]' : 'text-gray-600'}>{label}</span>
                <span className="text-[11px] text-gray-400">— {hint}</span>
              </label>
            ))}
          </div>
        )}
      <div className="flex items-center gap-2">
        <button onClick={submit} disabled={!canSubmit} className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
          {saving ? 'Checking out…' : `Check Out${totalKeys ? ` ${totalKeys} Key${totalKeys === 1 ? '' : 's'}` : ''}`}
        </button>
        <button onClick={onClose} className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:bg-gray-50 transition-colors">Cancel</button>
        <span className="text-[11px] text-gray-400 ml-auto">
          {missingEmail
            ? 'No email on file — sign here to capture a signature anyway.'
            : signMode === 'in_person'
              ? 'Opens the signature pad next.'
              : 'Emails the holder a sign-off link and copies Cara.'}
        </span>
      </div>
      </div>
    </Modal>
  );
}

// ── Check In modal ───────────────────────────────────────────────────────────

export function CheckInModal({
  presetAccount, presetAssignmentId, onClose, onDone,
}: {
  presetAccount: { id: number; name: string } | null;
  presetAssignmentId?: number | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const me = getManager();
  const [account, setAccount] = useState<{ id: number; name: string } | null>(presetAccount);
  const [open, setOpen] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string>(presetAssignmentId ? String(presetAssignmentId) : '');
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [condition, setCondition] = useState('good');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Check-in now collects its own signature (upstream), so a missing address
  // costs the holder both their confirmation AND their return sign-off. The
  // notification recipient is told either way.
  const [notifyAnyway, setNotifyAnyway] = useState(false);
  // Same default as a check-out: the person handing the keys back is here.
  const [signMode, setSignMode] = useState<'in_person' | 'email'>('in_person');
  const [showMore, setShowMore] = useState(false);
  const [signing, setSigning] = useState<Assignment | null>(null);
  const [done, setDone] = useState<{
    mail: MailOutcome; partial: boolean; holder: string; link: string | null;
    reconciled?: boolean; form?: { form_no: string; total_keys: number } | null;
    signed?: boolean; pdfError?: string | null;
  } | null>(null);

  // ── Manual entry ──────────────────────────────────────────────────────────
  // Used when nothing is on record for this client. Same field set as a
  // check-out, so the return is captured in full rather than refused.
  const [manualMode, setManualMode] = useState<'self' | 'other'>('other');
  const [manualHolder, setManualHolder] = useState<HolderOption | null>(null);
  const [manualEmail, setManualEmail] = useState('');
  const [manualPicks, setManualPicks] = useState<Record<string, Pick>>({});
  const [manualAvail, setManualAvail] = useState<KeyAvailability[]>([]);
  const [returnedAt, setReturnedAt] = useState(new Date().toISOString().slice(0, 10));

  // All open custody records; filtered to the chosen client below so a preset
  // row narrows the list without hiding the rest of the registry.
  useEffect(() => {
    setLoading(true);
    getAssignments({ status: 'checked_out', limit: '500' })
      .then((d) => {
        setOpen(d.assignments);
        // Re-apply the preselection once the options exist — a controlled
        // <select> pointed at an id that has not loaded yet renders as blank.
        if (presetAssignmentId && d.assignments.some((a) => a.id === presetAssignmentId)) {
          setSelectedId(String(presetAssignmentId));
        }
      })
      .catch(() => setOpen([]))
      .finally(() => setLoading(false));
  }, [presetAssignmentId]);

  const candidates = useMemo(
    () => (account ? open.filter((a) => a.account_id === account.id) : open),
    [open, account],
  );
  const selected = open.find((a) => String(a.id) === selectedId) ?? null;

  // One open check-out at this client is not a choice — pick it. Two or more
  // is a real decision, so leave it to the user rather than guessing.
  useEffect(() => {
    if (selectedId || candidates.length !== 1) return;
    setSelectedId(String(candidates[0].id));
  }, [candidates, selectedId]);

  // Default to returning everything on the selected transaction — the common
  // case is a full return; unchecking a line makes it partial. Depends on
  // `open` as well as the id: with a row-preselected id the transaction is not
  // in hand until the list finishes loading.
  useEffect(() => { setNotifyAnyway(false); }, [selectedId]);

  useEffect(() => {
    if (!selected) { setPicks({}); return; }
    const next: Record<string, Pick> = {};
    for (const k of selected.keys) next[k.type] = { checked: true, qty: k.qty };
    setPicks(next);
  }, [selectedId, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const lines = selectedLines(picks);

  // ── Manual entry derivations ──────────────────────────────────────────────
  const manualHolderName = manualMode === 'self' ? (me?.name ?? '') : (manualHolder?.name ?? '');
  const manualHolderType: 'employee' | 'ic' = manualMode === 'self' ? 'employee' : (manualHolder?.type ?? 'employee');
  const manualLines = selectedLines(manualPicks);
  // Manual entry only appears once the list has loaded and come back empty —
  // otherwise it would flash on screen while the candidates are still arriving.
  const manualEntry = !loading && candidates.length === 0;

  useEffect(() => {
    if (!manualEntry || !account) { setManualAvail([]); return; }
    getKeyAvailability(account.id)
      .then((d) => setManualAvail(d.types))
      .catch(() => setManualAvail([]));
    setManualPicks({});
  }, [manualEntry, account]);

  useEffect(() => {
    setManualEmail(manualMode === 'self' ? (me?.email ?? '') : (manualHolder?.email ?? ''));
  }, [manualMode, manualHolder, me?.email]);
  const totalReturning = lines.reduce((n, l) => n + l.qty, 0);
  const totalOut = selected?.keys.reduce((n, k) => n + k.qty, 0) ?? 0;
  const isPartial = !!selected && selected.keys.length > 0 && totalReturning < totalOut;
  const canSubmit = saving ? false : (
    selected
      ? (selected.keys.length === 0 || lines.length > 0)
        && (!!selected.holder_email || notifyAnyway)
      // Manual entry needs a holder, a client and at least one key. No email
      // gate: a return is a fact worth recording even if nobody can be told.
      : manualEntry && !!manualHolderName && !!account && manualLines.length > 0
  );
  const submitCount = selected ? totalReturning : manualLines.reduce((n, l) => n + l.qty, 0);

  const submit = async () => {
    setSaving(true); setError('');
    try {
      // Two shapes, one endpoint. Against an open record we name it; with
      // nothing on file we send the whole entry and the server reconciles it,
      // creating and closing the record in one step. A check-in must never be
      // a dead end just because the check-OUT was never captured.
      // With no address there is no link to send, so the on-device pad is the
      // only route to a signature on this return.
      const returningEmail = selected ? selected.holder_email : manualEmail.trim();
      const effectiveSignMode = returningEmail ? signMode : 'in_person';
      const r = selected
        ? await checkin({
          id: selected.id,
          keys: selected.keys.length ? lines : undefined,
          condition_on_return: condition,
          notes: notes.trim() || null,
          on_behalf: (me?.name ?? '').trim().toLowerCase() !== selected.holder.trim().toLowerCase(),
          sign_mode: effectiveSignMode,
        })
        : await checkin({
          holder: manualHolderName,
          holder_email: manualEmail.trim() || null,
          holder_type: manualHolderType,
          holder_id: manualHolder?.id ?? null,
          account_id: account?.id,
          keys: manualLines,
          condition_on_return: condition,
          returned_at: returnedAt || null,
          notes: notes.trim() || null,
          sign_mode: effectiveSignMode,
        });
      onDone();
      if (effectiveSignMode === 'in_person' && r.assignment) {
        setSigning(r.assignment);
        return;
      }
      setDone({
        mail: r.email, partial: r.partial,
        holder: selected ? selected.holder : manualHolderName,
        link: r.signoff_link,
        reconciled: !!(r as any).reconciled,
        form: (r as any).key_form ?? null,
      });
    } catch (e: any) {
      setError(e?.message || 'Check-in failed');
    } finally {
      setSaving(false);
    }
  };

  if (signing) {
    return (
      <Modal title="Sign for the return" onClose={onClose} width="max-w-lg">
        <SignNowStep
          assignment={signing}
          kind="checkin"
          intro={
            <div className="text-sm bg-green-50 border border-green-200 text-green-800 rounded px-3 py-2">
              ✓ Return recorded for {signing.holder}. One signature and this is complete.
            </div>
          }
          onSigned={({ mail, pdfError }) => {
            setSigning(null);
            setDone({
              mail, partial: false, holder: signing.holder, link: null,
              signed: true, pdfError,
            });
          }}
          onSkip={async () => {
            let mail: MailOutcome = { ok: false, recipients: [], skipped: true };
            let link: string | null = null;
            try {
              const r = await resendSignoff(signing.id, 'checkin');
              mail = r.email; link = r.signoff_link;
            } catch (e: any) {
              mail = { ok: false, recipients: [], error: e?.message || 'Could not send the sign-off link' };
            }
            setDone({ mail, partial: false, holder: signing.holder, link });
            setSigning(null);
          }}
        />
      </Modal>
    );
  }

  if (done) {
    return (
      <Modal title={done.signed ? 'Signed and returned' : 'Keys returned'} onClose={onClose} width="max-w-lg">
        <div className="space-y-4">
          <div className="text-sm text-cw-text">
            {done.partial
              ? <>Partial return recorded for <span className="font-semibold">{done.holder}</span>. The remaining keys stay checked out.</>
              : <>All keys returned by <span className="font-semibold">{done.holder}</span>. The record moved to Checked In.</>}
          </div>
          {done.reconciled && (
            <div className="rounded border border-cw-border bg-[#f4f4f2] px-3 py-2 text-sm text-cw-text">
              No check-out existed for these keys, so the record was created and closed together.
              It is marked as a reconciling entry in the audit trail.
            </div>
          )}
          {done.form && (
            <div className="rounded border border-cw-border bg-white px-3 py-2 text-sm text-cw-text">
              Key Form <span className="font-mono font-semibold">{done.form.form_no}</span> generated —{' '}
              {done.form.total_keys} key{done.form.total_keys === 1 ? '' : 's'} now on record for {done.holder}.
              It is listed under the <strong>Key Forms</strong> tab.
            </div>
          )}
          <MailBanner mail={done.mail} kind="checkin" />
          {done.link ? (
            <>
              <div className="text-xs text-cw-muted">
                Return signature link (48-hour expiry) — also included in the email:
                <div className="mt-1 font-mono break-all bg-gray-50 border border-cw-border rounded px-2 py-1.5">{done.link}</div>
              </div>
              <p className="text-xs text-cw-muted">
                The record shows <span className="font-semibold text-[#7a5a00]">Awaiting signature</span> until {done.holder} signs.
              </p>
            </>
          ) : null}
        </div>
        <div className="flex gap-2 pt-4 border-t border-gray-200 mt-4">
          <button onClick={onClose} className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] transition-colors">Done</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Check In Keys" onClose={onClose} width="max-w-lg">
      <div className="space-y-5 max-h-[70vh] overflow-y-auto pr-1">
        <div>
          <SectionLabel>Client</SectionLabel>
          <ClientPicker value={account} onSelect={(v) => { setAccount(v); setSelectedId(''); }} />
        </div>

        <div>
          <SectionLabel>Open check-out</SectionLabel>
          <select
            className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            <option value="">{loading ? 'Loading…' : `— Select a check-out (${candidates.length}) —`}</option>
            {candidates.map((a) => (
              <option key={a.id} value={a.id}>
                {a.holder} — {a.account_name} — {a.keys_summary || 'keys'}{a.overdue ? '  ⚠ OVERDUE' : ''}
              </option>
            ))}
          </select>
          {/* Nothing on record is not an error — it is the common case for keys
              that predate the system. Say so, and open the full entry form
              below rather than refusing the return. */}
          {manualEntry && (
            <div className="mt-2 rounded border border-[#e8cf8a] bg-[#fff8e6] px-3 py-2.5 text-sm text-[#7a5a00]">
              {account
                ? <>No keys are on record at <strong>{account.name}</strong>.</>
                : <>No keys are on record as checked out.</>}
              {' '}Enter the return below — it will be recorded even though no check-out exists.
            </div>
          )}
        </div>

        {/* ── Manual entry: the same field set as a check-out ───────────────
            Holder, client, keys, condition, date, notes. This is what makes a
            check-in work with or without a prior record. */}
        {manualEntry && (
          <>
            <div>
              <SectionLabel>Who is returning the keys</SectionLabel>
              <HolderPicker
                mode={manualMode} setMode={setManualMode}
                holder={manualHolder} setHolder={setManualHolder}
                placeholder="— Select the person returning the keys —"
              />
              <div className="mt-3">
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Holder email <span className="text-gray-400 font-normal">— receives the confirmation</span>
                </label>
                <input
                  type="email"
                  className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
                  value={manualEmail}
                  onChange={(e) => setManualEmail(e.target.value)}
                  placeholder="name@example.com"
                />
              </div>
            </div>

            <div>
              <SectionLabel>Keys being returned</SectionLabel>
              {!account ? (
                <p className="text-sm text-cw-muted">Choose a client above to list its key types.</p>
              ) : (
                <KeyPickerList
                  rows={manualAvail.map((k) => ({ type: k.type, label: k.label, available: k.site_total }))}
                  picks={manualPicks}
                  setPicks={setManualPicks}
                  availableLabel="on record at this client"
                  emptyNote="No key inventory recorded for this client."
                />
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Date returned</label>
              <input
                type="date"
                className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
                value={returnedAt}
                onChange={(e) => setReturnedAt(e.target.value)}
              />
            </div>
          </>
        )}

        {selected && (
          <>
            <div>
              <SectionLabel>Keys being returned</SectionLabel>
              <KeyPickerList
                rows={selected.keys.map((k) => ({ type: k.type, label: k.label, available: k.qty }))}
                picks={picks}
                setPicks={setPicks}
                availableLabel="checked out"
                emptyNote="This is a legacy record with no key breakdown — checking it in returns the whole record."
              />
              {isPartial && (
                <p className="text-[11px] text-[#7a5a00] bg-[#fff8e6] border border-[#e8cf8a] rounded px-2 py-1.5 mt-2">
                  Partial return — {totalOut - totalReturning} key{totalOut - totalReturning === 1 ? '' : 's'} will stay checked out to {selected.holder}.
                </p>
              )}
            </div>

            {!selected.holder_email && (
              <MissingEmailWarning
                holder={selected.holder}
                holderType={selected.holder_type ?? 'employee'}
                holderId={selected.holder_id}
                context="notification"
                onEmailSaved={() => setNotifyAnyway(true)}
                proceeding={notifyAnyway}
                setProceeding={setNotifyAnyway}
                reason={''}
                setReason={() => {}}
              />
            )}

            <div className="text-xs text-cw-muted">
              Holder: <span className="font-semibold text-[#1a1a1a]">{selected.holder}</span>
              {' · '}Out since {parseStamp(selected.checked_out_at)?.toLocaleDateString() ?? '—'}
              {(me?.name ?? '').trim().toLowerCase() !== selected.holder.trim().toLowerCase() && (
                <> · recorded by <span className="font-semibold text-[#1a1a1a]">{me?.name}</span> on their behalf</>
              )}
            </div>

            {/* Condition already reads "Good" and notes are usually empty, so
                both sit behind the fold with the current answer on the label. */}
            <div>
              <button
                type="button"
                onClick={() => setShowMore((v) => !v)}
                className="flex items-center gap-2 text-xs font-medium text-[#1a1a1a] hover:text-[#C0272D] transition-colors"
              >
                <span className={`inline-block transition-transform ${showMore ? 'rotate-90' : ''}`}>›</span>
                More options
                {!showMore && (
                  <span className="font-normal text-gray-400">
                    condition {condition === 'missing_copy' ? 'missing copy' : condition}
                    {notes.trim() ? ' · notes added' : ''}
                  </span>
                )}
              </button>
              {showMore && (
                <div className="space-y-3 mt-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Condition on return</label>
                    <select className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={condition} onChange={(e) => setCondition(e.target.value)}>
                      <option value="good">Good</option>
                      <option value="damaged">Damaged</option>
                      <option value="missing_copy">Missing Copy</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
                    <textarea className="input h-16 resize-none focus:ring-[#C0272D] focus:border-[#C0272D]" value={notes} onChange={(e) => setNotes(e.target.value)} />
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {error && <ErrorBanner>{error}</ErrorBanner>}
      </div>

      <div className="pt-4 border-t border-gray-200 mt-4 space-y-3">
        {/* Same choice as a check-out, on the same footing and in the same
            place: beside the button whose behaviour it changes. */}
        {(selected?.holder_email || (!selected && manualEmail.trim())) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-xs font-medium text-[#1a1a1a]">Signature</span>
            {([
              ['in_person', 'Sign here now', 'they are handing them back'],
              ['email', 'Email the link', 'they are not here'],
            ] as const).map(([value, label, hint]) => (
              <label key={value} className="flex items-center gap-1.5 text-sm cursor-pointer">
                <input
                  type="radio"
                  className="accent-[#C0272D]"
                  checked={signMode === value}
                  onChange={() => setSignMode(value)}
                />
                <span className={signMode === value ? 'font-medium text-[#1a1a1a]' : 'text-gray-600'}>{label}</span>
                <span className="text-[11px] text-gray-400">— {hint}</span>
              </label>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <button onClick={submit} disabled={!canSubmit} className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
            {saving ? 'Checking in…' : `Check In${submitCount ? ` ${submitCount} Key${submitCount === 1 ? '' : 's'}` : ''}`}
          </button>
          <button onClick={onClose} className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:bg-gray-50 transition-colors">Cancel</button>
          <span className="text-[11px] text-gray-400 ml-auto">
            {signMode === 'in_person' ? 'Opens the signature pad next.' : 'Emails the holder and Cara · sends a signature form.'}
          </span>
        </div>
      </div>
    </Modal>
  );
}
