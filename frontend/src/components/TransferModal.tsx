import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import HolderList, { sameHolder } from './HolderList';
import { SignNowStep } from './CustodyModals';
import {
  getHolders, getHoldersWithCustody, transferKeys,
  type Assignment, type HolderOption, type HolderWithCustody, type KeyLine,
  type KeyTypeKey, type TransferResult,
} from '../lib/api';

// ── Person-to-person key transfer ────────────────────────────────────────────
// Keys that move straight from one person to another never pass through the
// office, so recording it as "check in, then check out" leaves a window where
// the registry says nobody holds keys that are in someone's pocket. This modal
// drives ONE atomic server operation instead.

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-bold uppercase tracking-widest text-[#1a1a1a] border-b border-gray-200 pb-1 mb-3">
      {children}
    </div>
  );
}

function ErrorBanner({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-[#C0272D] bg-[#fbeaea] border border-[#f0c9cb] rounded px-3 py-2">{children}</p>;
}

interface Pick { checked: boolean; qty: number }

/** One send outcome, stated plainly — never a silent failure. */
function SendLine({ label, ok, recipients, error, suppressed }: {
  label: string; ok: boolean; recipients: string[]; error?: string; suppressed?: boolean;
}) {
  // A deliberately suppressed send is neither a failure nor a success — saying
  // either would be a lie about what happened. Note this is NOT `skipped`,
  // which also covers "no address" and "no mail provider": those are problems
  // and must keep reading as warnings.
  if (suppressed) return <li className="text-cw-muted">· {label} — not needed, signed here</li>;
  return ok
    ? <li className="text-green-800">✓ {label} — sent to {recipients.join(', ')}</li>
    : <li className="text-[#7a5a00]">⚠ {label} — not sent{error ? `: ${error}` : '.'}</li>;
}

export default function TransferModal({
  presetAccount, presetHolder, onClose, onDone,
}: {
  presetAccount: { id: number; name: string } | null;
  presetHolder?: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  // ── From ──────────────────────────────────────────────────────────────────
  // The person handing keys over comes FIRST, because they are the one
  // standing there. Which of their sites the keys belong to is something the
  // record already knows, so it is inferred below rather than asked.
  const [custody, setCustody] = useState<HolderWithCustody[]>([]);
  const [custodyLoading, setCustodyLoading] = useState(true);
  const [fromQuery, setFromQuery] = useState('');
  const [fromHolder, setFromHolder] = useState<string>(presetHolder ?? '');

  const [roster, setRoster] = useState<{ employees: HolderOption[]; ics: HolderOption[] }>({ employees: [], ics: [] });
  const [toQuery, setToQuery] = useState('');
  const [toHolder, setToHolder] = useState<HolderOption | null>(null);
  const [toEmail, setToEmail] = useState('');

  const [account, setAccount] = useState<{ id: number; name: string } | null>(presetAccount);
  const [held, setHeld] = useState<KeyLine[]>([]);
  const [picks, setPicks] = useState<Record<string, Pick>>({});

  // ── Mode ────────────────────────────────────────────────────────────────
  // Keys and accounts are genuinely separate things to move: keys change hands
  // to cover a shift without the account moving, and an account is reassigned
  // with the metal following later.
  const [mode, setMode] = useState<'keys' | 'accounts' | 'both'>('keys');
  const [accountRole, setAccountRole] = useState<'am' | 'ccm'>('am');
  const movesKeys = mode === 'keys' || mode === 'both';
  const movesAccounts = mode === 'accounts' || mode === 'both';

  const [signMode, setSignMode] = useState<'in_person' | 'email'>('in_person');
  const [dueAt, setDueAt] = useState('');
  const [notes, setNotes] = useState('');
  const [showMore, setShowMore] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<TransferResult | null>(null);
  const [signing, setSigning] = useState<Assignment | null>(null);

  useEffect(() => {
    setCustodyLoading(true);
    getHoldersWithCustody(true)
      .then((d) => setCustody(d.holders))
      .catch(() => setCustody([]))
      .finally(() => setCustodyLoading(false));
    getHolders().then(setRoster).catch(() => setRoster({ employees: [], ics: [] }));
  }, []);

  const fromRecord = useMemo(
    () => custody.find((h) => h.holder.trim().toLowerCase() === fromHolder.trim().toLowerCase()) ?? null,
    [custody, fromHolder],
  );

  // ── Client, inferred where it can be ──────────────────────────────────────
  // Most people hold keys at exactly one site, and asking them to name it is
  // asking a question with one possible answer. It is only a real choice when
  // they hold keys at more than one, and even then the list is theirs alone.
  useEffect(() => {
    if (!fromRecord) return;
    setAccount((cur) => {
      if (cur && fromRecord.sites.some((s) => s.account_id === cur.id)) return cur;
      const only = fromRecord.sites.length === 1 ? fromRecord.sites[0] : null;
      return only ? { id: only.account_id, name: only.account_name } : null;
    });
  }, [fromRecord]);

  // ── Keys, pre-filled from what they actually hold ─────────────────────────
  // The source custody records are never shown or chosen: the server allocates
  // the transfer across them oldest-first, closing and splitting as needed.
  const site = useMemo(
    () => (fromRecord && account ? fromRecord.sites.find((s) => s.account_id === account.id) ?? null : null),
    [fromRecord, account],
  );

  useEffect(() => {
    if (!site) { setHeld([]); setPicks({}); return; }
    setHeld(site.keys);
    setPicks(Object.fromEntries(site.keys.map((k) => [k.type, { checked: true, qty: k.qty }])));
  }, [site]);

  useEffect(() => { setToEmail(toHolder?.email ?? ''); }, [toHolder]);

  // A recipient who is also the person handing over is not a transfer.
  useEffect(() => {
    if (toHolder && fromHolder && toHolder.name.trim().toLowerCase() === fromHolder.trim().toLowerCase()) {
      setToHolder(null);
    }
  }, [fromHolder, toHolder]);

  const lines = Object.entries(picks)
    .filter(([, p]) => p.checked && p.qty > 0)
    .map(([type, p]) => ({ type: type as KeyTypeKey, qty: p.qty }));
  const totalKeys = lines.reduce((n, l) => n + l.qty, 0);
  const partial = held.length > 0 && totalKeys < held.reduce((n, k) => n + k.qty, 0);

  const filteredFrom = useMemo(() => {
    const q = fromQuery.trim().toLowerCase();
    return custody.filter((h) => !q || h.holder.toLowerCase().includes(q)
      || h.sites.some((s) => s.account_name.toLowerCase().includes(q)));
  }, [custody, fromQuery]);

  // An accounts-only move needs no keys — requiring them would block the very
  // case where the metal has not moved yet.
  const canSubmit = !!fromHolder && !!toHolder && !!account && !saving
    && toHolder.name.trim().toLowerCase() !== fromHolder.trim().toLowerCase()
    && (!movesKeys || lines.length > 0);

  const setPick = (type: string, patch: Partial<Pick>) =>
    setPicks({ ...picks, [type]: { ...(picks[type] ?? { checked: false, qty: 1 }), ...patch } });

  const submit = async () => {
    if (!canSubmit || !account || !toHolder) return;
    setSaving(true); setError('');
    try {
      const effectiveSignMode = toEmail.trim() ? signMode : 'in_person';
      const r = await transferKeys({
        account_id: account.id,
        from_holder: fromHolder,
        to_holder: toHolder.name,
        to_holder_type: toHolder.type,
        to_holder_id: toHolder.id,
        to_holder_email: toEmail.trim() || null,
        mode,
        account_role: accountRole,
        keys: movesKeys ? lines : [],
        due_at: dueAt || null,
        notes: notes.trim() || null,
        sign_mode: effectiveSignMode,
      });
      onDone();
      // The receiver is the one present, so they sign here. The person handing
      // over is emailed either way — they may already have walked off.
      if (effectiveSignMode === 'in_person' && movesKeys && r.to?.assignment) {
        setSigning(r.to.assignment);
        setDone(r);
        return;
      }
      setDone(r);
    } catch (e: any) {
      setError(e?.message || 'Transfer failed');
    } finally {
      setSaving(false);
    }
  };

  if (signing) {
    return (
      <Modal title="Sign for receipt" onClose={onClose} width="max-w-lg">
        <SignNowStep
          assignment={signing}
          kind="checkout"
          intro={
            <div className="text-sm bg-green-50 border border-green-200 text-green-800 rounded px-3 py-2">
              ✓ Transfer recorded. {signing.holder} signs for receipt; {fromHolder} has been emailed to confirm
              the handover.
            </div>
          }
          onSigned={() => setSigning(null)}
          onSkip={() => setSigning(null)}
        />
      </Modal>
    );
  }

  if (done) {
    return (
      <Modal title="Keys transferred" onClose={onClose} width="max-w-lg">
        <div className="space-y-4">
          <div className="text-sm text-cw-text">
            <span className="font-semibold">{done.total_keys}</span> key{done.total_keys === 1 ? '' : 's'} moved from{' '}
            <span className="font-semibold">{done.from.holder}</span> to{' '}
            <span className="font-semibold">{done.to.holder}</span> at{' '}
            <span className="font-semibold">{account?.name}</span>.
          </div>

          <div className="text-sm bg-[#fff8e6] border border-[#e8cf8a] text-[#7a5a00] rounded px-3 py-2">
            <div className="font-semibold">Awaiting signatures ({done.signatures.signed} of {done.signatures.total})</div>
            <p className="mt-1 text-xs">
              The transfer is not complete until both people sign: {done.from.holder} confirms the return,
              and {done.to.holder} confirms receipt. Each link expires in 48 hours.
            </p>
          </div>

          <ul className="text-sm space-y-1">
            <SendLine label={`Return notice to ${done.from.holder}`} ok={done.email.from.ok} recipients={done.email.from.recipients} error={done.email.from.error} suppressed={done.email.from.suppressed} />
            <SendLine label={`Receipt notice to ${done.to.holder}`} ok={done.email.to.ok} recipients={done.email.to.recipients} error={done.email.to.error} suppressed={done.email.to.suppressed} />
          </ul>

          <div className="text-xs text-cw-muted space-y-2">
            <div>
              <div className="font-semibold text-[#1a1a1a]">{done.from.holder} — sign the return</div>
              <div className="mt-1 font-mono break-all bg-gray-50 border border-cw-border rounded px-2 py-1.5">{done.from.signoff_link}</div>
            </div>
            <div>
              <div className="font-semibold text-[#1a1a1a]">{done.to.holder} — sign for receipt</div>
              <div className="mt-1 font-mono break-all bg-gray-50 border border-cw-border rounded px-2 py-1.5">{done.to.signoff_link}</div>
            </div>
          </div>
        </div>
        <div className="flex gap-2 pt-4 border-t border-gray-200 mt-4">
          <button onClick={onClose} className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] transition-colors">Done</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Transfer" onClose={onClose} width="max-w-lg">
      <div className="space-y-5 max-h-[70vh] overflow-y-auto pr-1">
        <p className="text-xs text-cw-muted">
          Moves custody directly from one person to another in one step — never leaving keys shown as held by
          two people, or by nobody.
        </p>

        {/* 1 — From */}
        <div>
          <SectionLabel>From</SectionLabel>
          <input
            className="input focus:ring-[#C0272D] focus:border-[#C0272D] mb-2"
            placeholder="Filter the people currently holding keys…"
            value={fromQuery}
            onChange={(e) => setFromQuery(e.target.value)}
          />
          <div className="border border-cw-border rounded max-h-44 overflow-y-auto divide-y divide-gray-100">
            {custodyLoading ? (
              <div className="px-3 py-3 text-sm text-cw-muted">Loading current custody…</div>
            ) : filteredFrom.length === 0 ? (
              <div className="px-3 py-3 text-sm text-cw-muted">
                {custody.length === 0
                  ? 'Nobody currently has keys checked out.'
                  : `Nobody holding keys matches “${fromQuery.trim()}”`}
              </div>
            ) : filteredFrom.map((h) => {
              const selected = h.holder.trim().toLowerCase() === fromHolder.trim().toLowerCase();
              return (
                <button
                  key={h.holder}
                  type="button"
                  onClick={() => { setFromHolder(h.holder); setAccount(null); }}
                  className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${
                    selected ? 'bg-[#fbeaea]' : 'hover:bg-gray-50'
                  }`}
                >
                  <span className="truncate text-[#1a1a1a]">{h.holder}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-cw-muted">
                    {h.total_keys} key{h.total_keys === 1 ? '' : 's'}
                    {h.client_count > 1 ? ` · ${h.client_count} clients` : ''}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 2 — To */}
        <div>
          <SectionLabel>To</SectionLabel>
          <input
            className="input focus:ring-[#C0272D] focus:border-[#C0272D] mb-2"
            placeholder="Filter staff and IC vendors…"
            value={toQuery}
            onChange={(e) => setToQuery(e.target.value)}
          />
          <HolderList
            options={roster}
            query={toQuery}
            value={toHolder}
            onSelect={setToHolder}
            exclude={fromHolder}
            emptyNote="— Select the person receiving the keys —"
          />
          <div className="mt-3">
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Their email <span className="text-gray-400 font-normal">— receives the notification + signature link</span>
            </label>
            <input
              type="email"
              className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
              value={toEmail}
              onChange={(e) => setToEmail(e.target.value)}
              placeholder="name@example.com"
            />
          </div>
        </div>

        {/* 3 — Client. Only a question when this person holds keys at more
             than one site; otherwise it is already answered. */}
        <div>
          <SectionLabel>Client</SectionLabel>
          {!fromRecord ? (
            <p className="text-sm text-cw-muted">Choose who is handing the keys over first.</p>
          ) : fromRecord.sites.length === 1 && account ? (
            <div className="flex items-center gap-2 border border-cw-border rounded px-3 py-2 bg-[#faf9f8] text-sm">
              <span className="font-medium text-[#1a1a1a] truncate">{account.name}</span>
              <span className="ml-auto shrink-0 text-[11px] text-cw-muted">
                the only site {fromRecord.holder} holds keys at
              </span>
            </div>
          ) : (
            <div className="border border-cw-border rounded divide-y divide-gray-100">
              {fromRecord.sites.map((s) => (
                <button
                  key={s.account_id}
                  type="button"
                  onClick={() => setAccount({ id: s.account_id, name: s.account_name })}
                  className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${
                    account?.id === s.account_id ? 'bg-[#fbeaea]' : 'hover:bg-gray-50'
                  }`}
                >
                  <span className="truncate text-[#1a1a1a]">{s.account_name}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-cw-muted">
                    {s.total_keys} key{s.total_keys === 1 ? '' : 's'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 4 — Keys */}
        {movesKeys && (
          <div>
            <SectionLabel>Keys being handed over</SectionLabel>
            {!site ? (
              <p className="text-sm text-cw-muted">Choose who is handing over, and which client.</p>
            ) : held.length === 0 ? (
              <p className="text-sm text-cw-muted">Nothing is on record as out at this client.</p>
            ) : (
              <>
                <div className="border border-cw-border rounded divide-y divide-gray-100">
                  {held.map((k) => {
                    const pick = picks[k.type] ?? { checked: false, qty: 1 };
                    const boxId = `xfer-${k.type}`;
                    return (
                      <div key={k.type} className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-[#faf9f8]">
                        <input
                          id={boxId}
                          type="checkbox"
                          className="h-4 w-4 accent-[#C0272D] cursor-pointer"
                          checked={!!pick.checked}
                          onChange={(e) => setPick(k.type, { checked: e.target.checked, qty: Math.min(pick.qty || 1, k.qty) || 1 })}
                        />
                        <label htmlFor={boxId} className="font-medium text-[#1a1a1a] whitespace-nowrap min-w-[7.5rem] cursor-pointer">
                          {k.label}
                        </label>
                        <span className="flex-1 text-xs text-cw-muted whitespace-nowrap">
                          (out: <span className="font-semibold text-[#1a1a1a]">{k.qty}</span>)
                        </span>
                        <input
                          type="number"
                          min={1}
                          max={k.qty}
                          disabled={!pick.checked}
                          value={pick.qty}
                          onChange={(e) => setPick(k.type, { qty: Math.max(1, Math.min(Number(e.target.value) || 1, k.qty)) })}
                          className="input w-16 text-center px-1 py-1 disabled:bg-gray-100 disabled:text-gray-400 focus:ring-[#C0272D] focus:border-[#C0272D]"
                          aria-label={`${k.label} quantity`}
                        />
                      </div>
                    );
                  })}
                </div>
                {/* The one quiet line. Which records these keys came out on is
                    resolved server-side and never shown as a choice. */}
                {site.since && (
                  <p className="text-[11px] text-cw-muted mt-2">
                    Moving against check-out from {new Date(site.since).toLocaleDateString(undefined, {
                      month: 'short', day: 'numeric', year: 'numeric',
                    })}
                  </p>
                )}
                {partial && (
                  <p className="text-[11px] text-[#7a5a00] bg-[#fff8e6] border border-[#e8cf8a] rounded px-2 py-1.5 mt-2">
                    Partial transfer — the unchecked keys stay checked out to {fromHolder}.
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {/* 5 — Mode */}
        <div>
          <SectionLabel>What is moving</SectionLabel>
          <div className="space-y-1.5">
            {([
              ['keys', 'Keys only', 'Physical keys move; the manager assignment is unchanged.'],
              ['accounts', 'Accounts only', 'Manager reassignment; the keys stay where they are.'],
              ['both', 'Keys and accounts', 'Both move together.'],
            ] as const).map(([val, label, hint]) => (
              <label key={val} className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="radio"
                  className="accent-[#C0272D] mt-0.5"
                  checked={mode === val}
                  onChange={() => setMode(val)}
                />
                <span>
                  <span className={mode === val ? 'font-medium text-[#1a1a1a]' : ''}>{label}</span>
                  <span className="block text-[11px] text-gray-400">{hint}</span>
                </span>
              </label>
            ))}
          </div>
          {movesAccounts && (
            <div className="mt-3">
              <label className="block text-xs font-medium text-gray-600 mb-1">Which assignment moves</label>
              <select
                className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
                value={accountRole}
                onChange={(e) => setAccountRole(e.target.value as 'am' | 'ccm')}
              >
                <option value="am">Account Manager</option>
                <option value="ccm">Contract Compliance Manager</option>
              </select>
            </div>
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
                {dueAt ? `due ${dueAt}` : 'no due date'}{notes.trim() ? ' · notes added' : ''}
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

      {/* 6 — Signature, then 7 — Confirm. */}
      <div className="pt-4 border-t border-gray-200 mt-4 space-y-3">
        {movesKeys && toEmail.trim() && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-xs font-medium text-[#1a1a1a]">Signature</span>
            {([
              ['in_person', 'Sign here now', 'the receiver is here'],
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
            {saving ? 'Transferring…' : `Transfer${totalKeys ? ` ${totalKeys} Key${totalKeys === 1 ? '' : 's'}` : ''}`}
          </button>
          <button onClick={onClose} className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:bg-gray-50 transition-colors">Cancel</button>
          <span className="text-[11px] text-gray-400 ml-auto">Two signature forms · both holders and Cara emailed.</span>
        </div>
      </div>
    </Modal>
  );
}