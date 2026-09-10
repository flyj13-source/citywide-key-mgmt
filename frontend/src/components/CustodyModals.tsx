import { useEffect, useMemo, useRef, useState } from 'react';
import Modal from './Modal';
import AccountPicker from './AccountPicker';
import HolderList, { sameHolder } from './HolderList';
import SignaturePad, { type SignaturePadHandle } from './SignaturePad';
import { getManager } from '../lib/auth';
import {
  getKeyAvailability, getHolders, getRecentHolders, checkout, checkin, getAssignments, saveHolderEmail,
  getCheckoutContext, getCheckinContext, getReturnContext, signInPerson, resendSignoff,
  type ReturnContext,
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

// The account picker lives in AccountPicker.tsx so Check Out, Check In and
// Transfer are literally the same control rather than three that drift apart.
// The one that used to live here searched only after you typed and never
// listed IC vendors as a group, so half the registry was unreachable from the
// three screens where it matters most.

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

  // Is the chosen person actually on the roster we loaded? Name-matched,
  // because that is the only field the two sources reliably share.
  const onRoster = !!holder && [...options.employees, ...options.ics]
    .some((o) => o.name.trim().toLowerCase() === holder.name.trim().toLowerCase());

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

  // The suggestion is not repeated in the recent strip — one row, one person.
  const recentShown = recent.filter((r) => !sameHolder(r, suggested ?? null)).slice(0, 5);


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
          <HolderList
            options={options}
            query={query}
            value={holder}
            onSelect={setHolder}
            loading={loading}
            emptyNote={placeholder}
          />
          {/* A holder named on a client row with no roster or vendor record
              behind them is still a valid holder — just not one on this list.
              Judged by whether the ROSTER actually has them, not by whether the
              option carries an id: a person picked from the recent strip has a
              null id whenever the assignment that put them there was recorded
              without one, and they are on the roster all the same. */}
          {holder && !onRoster && (
            <p className="text-[11px] text-cw-muted">
              Selected: <span className="font-medium text-[#1a1a1a]">{holder.name}</span> — named on a client
              row, with no roster record behind them.
            </p>
          )}
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
          <AccountPicker value={account} onSelect={setAccount} autoFocus />
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
// Four decisions, in the order a return actually happens: which client, who is
// handing the keys back, which keys, and how it gets signed.
//
// There is deliberately NO "open check-out" selector. Which transaction the
// keys came out on is bookkeeping the person at the counter never saw, and on
// the common path — keys that predate this system — the dropdown was empty and
// had to be ignored. The server works it out from the client and the holder:
// one open record closes, several are consumed oldest-first, none means the
// return is recorded and closed together. All three are normal, so none of
// them gets a warning.

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

  // Who is returning — the same control as a check-out, always present.
  const [mode, setMode] = useState<'self' | 'other'>('other');
  const [holder, setHolder] = useState<HolderOption | null>(null);
  const [email, setEmail] = useState('');

  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [condition, setCondition] = useState('good');
  const [notes, setNotes] = useState('');
  const [returnedAt, setReturnedAt] = useState(new Date().toISOString().slice(0, 10));
  const [signMode, setSignMode] = useState<'in_person' | 'email'>('in_person');
  const [showMore, setShowMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [signing, setSigning] = useState<Assignment | null>(null);
  const [done, setDone] = useState<{
    mail: MailOutcome; partial: boolean; holder: string; link: string | null;
    reconciled?: boolean; form?: { form_no: string; total_keys: number } | null;
    signed?: boolean; pdfError?: string | null;
  } | null>(null);

  // What is on file for this client + person. Resolved silently; the only
  // thing it ever puts on screen is one quiet line.
  const [ctx, setCtx] = useState<ReturnContext | null>(null);
  const [ctxLoading, setCtxLoading] = useState(false);
  // Key types at the client, for a return with nothing on file.
  const [siteKeys, setSiteKeys] = useState<KeyAvailability[]>([]);

  const holderName = mode === 'self' ? (me?.name ?? '') : (holder?.name ?? '');
  const holderType: 'employee' | 'ic' = mode === 'self' ? 'employee' : (holder?.type ?? 'employee');

  // A row-launched check-in already knows both answers — seed them rather than
  // making someone re-enter what they just clicked on.
  useEffect(() => {
    if (!presetAssignmentId) return;
    let cancelled = false;
    getAssignments({ status: 'checked_out', limit: '500' })
      .then((d) => {
        if (cancelled) return;
        const a = d.assignments.find((x) => x.id === presetAssignmentId);
        if (!a) return;
        if (!presetAccount && a.account_id) setAccount({ id: a.account_id, name: a.account_name });
        setMode('other');
        setHolder({
          id: a.holder_id ?? null, name: a.holder, email: a.holder_email ?? null,
          type: (a.holder_type as 'employee' | 'ic') ?? 'employee',
          detail: '', has_email: !!a.holder_email,
        });
      })
      .catch(() => { /* the modal still works from an empty start */ });
    return () => { cancelled = true; };
  }, [presetAssignmentId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mode === 'self') setEmail(me?.email ?? '');
    else setEmail(holder?.email ?? '');
  }, [mode, holder, me?.email]);

  // ── The inference (§2) ────────────────────────────────────────────────────
  // Both facts in hand → ask the server what is open and pre-fill from it.
  // One record, several, or none all take the same path here; the difference
  // shows up only in how many keys come back pre-checked.
  useEffect(() => {
    if (!account || !holderName) { setCtx(null); setPicks({}); return; }
    let cancelled = false;
    setCtxLoading(true);
    getReturnContext(account.id, holderName)
      .then((c) => {
        if (cancelled) return;
        setCtx(c);
        setPicks(Object.fromEntries(c.keys.map((k) => [k.type, { checked: true, qty: k.qty }])));
      })
      .catch(() => { if (!cancelled) { setCtx(null); setPicks({}); } })
      .finally(() => { if (!cancelled) setCtxLoading(false); });
    return () => { cancelled = true; };
  }, [account, holderName]);

  // With nothing on file the key list falls back to what the client holds, so
  // the return can still be captured in full.
  useEffect(() => {
    if (!account) { setSiteKeys([]); return; }
    getKeyAvailability(account.id)
      .then((d) => setSiteKeys(d.types))
      .catch(() => setSiteKeys([]));
  }, [account]);

  const hasPrior = !!ctx && ctx.open_count > 0;
  const keyRows = hasPrior
    ? ctx!.keys.map((k) => ({ type: k.type as KeyTypeKey, label: k.label, available: k.qty }))
    : siteKeys.map((k) => ({ type: k.type, label: k.label, available: k.site_total }));

  const lines = selectedLines(picks);
  const totalReturning = lines.reduce((n, l) => n + l.qty, 0);
  const totalOut = hasPrior ? ctx!.keys.reduce((n, k) => n + k.qty, 0) : 0;
  const isPartial = hasPrior && totalReturning < totalOut;

  // A return is a fact worth recording even when nobody can be told about it,
  // so there is no email gate here — only a note that the link cannot be sent.
  const canSubmit = !saving && !!account && !!holderName && lines.length > 0;

  const submit = async () => {
    if (!canSubmit || !account) return;
    setSaving(true); setError('');
    try {
      // Always the same shape: client, person, keys. The server decides what
      // that closes — there is no record id for the UI to choose or get wrong.
      const effectiveSignMode = email.trim() ? signMode : 'in_person';
      const r = await checkin({
        holder: holderName,
        holder_email: email.trim() || null,
        holder_type: holderType,
        holder_id: holder?.id ?? null,
        account_id: account.id,
        keys: lines,
        condition_on_return: condition,
        returned_at: hasPrior ? undefined : (returnedAt || null),
        notes: notes.trim() || null,
        on_behalf: (me?.name ?? '').trim().toLowerCase() !== holderName.trim().toLowerCase(),
        sign_mode: effectiveSignMode,
      });
      onDone();
      if (effectiveSignMode === 'in_person' && r.assignment) {
        setSigning(r.assignment);
        return;
      }
      setDone({
        mail: r.email, partial: r.partial, holder: holderName, link: r.signoff_link,
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
        {/* 1 — Client */}
        <div>
          <SectionLabel>Client</SectionLabel>
          <AccountPicker value={account} onSelect={setAccount} />
        </div>

        {/* 2 — Who is returning */}
        <div>
          <SectionLabel>Who is returning the keys</SectionLabel>
          <HolderPicker
            mode={mode} setMode={setMode}
            holder={holder} setHolder={setHolder}
            placeholder="— Select the person returning the keys —"
          />
          <div className="mt-3">
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Their email <span className="text-gray-400 font-normal">— receives the confirmation and sign-off link</span>
            </label>
            <input
              type="email"
              className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
            />
          </div>
        </div>

        {/* 3 — Keys */}
        <div>
          <SectionLabel>Keys being returned</SectionLabel>
          {!account ? (
            <p className="text-sm text-cw-muted">Choose a client above to list its key types.</p>
          ) : ctxLoading ? (
            <p className="text-sm text-cw-muted">Checking what is on record…</p>
          ) : (
            <KeyPickerList
              rows={keyRows}
              picks={picks}
              setPicks={setPicks}
              availableLabel={hasPrior ? 'checked out' : 'on record at this client'}
              emptyNote="No key inventory recorded for this client."
            />
          )}

          {/* §3 — one quiet line when a prior check-out was found, and nothing
              at all when there was not. The absence of a record is the normal
              path now, and a warning about the normal path is just noise. */}
          {hasPrior && ctx!.since && (
            <p className="text-[11px] text-cw-muted mt-2">
              Returning against check-out from {parseStamp(ctx!.since)?.toLocaleDateString(undefined, {
                month: 'short', day: 'numeric', year: 'numeric',
              }) ?? '—'}
            </p>
          )}
          {isPartial && (
            <p className="text-[11px] text-[#7a5a00] bg-[#fff8e6] border border-[#e8cf8a] rounded px-2 py-1.5 mt-2">
              Partial return — {totalOut - totalReturning} key{totalOut - totalReturning === 1 ? '' : 's'} will stay checked out to {holderName}.
            </p>
          )}
        </div>

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
              {!hasPrior && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Date returned</label>
                  <input
                    type="date"
                    className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
                    value={returnedAt}
                    onChange={(e) => setReturnedAt(e.target.value)}
                  />
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
                <textarea className="input h-16 resize-none focus:ring-[#C0272D] focus:border-[#C0272D]" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>
            </div>
          )}
        </div>

        {error && <ErrorBanner>{error}</ErrorBanner>}
      </div>

      {/* 4 — Signature, beside the button whose behaviour it changes. */}
      <div className="pt-4 border-t border-gray-200 mt-4 space-y-3">
        {email.trim() ? (
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
        ) : holderName ? (
          <p className="text-[11px] text-cw-muted">
            No email on file — sign here to capture a signature anyway.
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <button onClick={submit} disabled={!canSubmit} className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
            {saving ? 'Checking in…' : `Check In${totalReturning ? ` ${totalReturning} Key${totalReturning === 1 ? '' : 's'}` : ''}`}
          </button>
          <button onClick={onClose} className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:bg-gray-50 transition-colors">Cancel</button>
        </div>
      </div>
    </Modal>
  );
}
