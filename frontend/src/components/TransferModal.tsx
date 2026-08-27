import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import {
  getAccounts, getCurrentHolders, getTransferable, getHolders, transferKeys,
  type CurrentHolder, type HolderOption, type KeyLine, type KeyTypeKey, type TransferResult,
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

function ClientPicker({
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

interface Pick { checked: boolean; qty: number }

/** One send outcome, stated plainly — never a silent failure. */
function SendLine({ label, ok, recipients, error }: {
  label: string; ok: boolean; recipients: string[]; error?: string;
}) {
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
  const [account, setAccount] = useState<{ id: number; name: string } | null>(presetAccount);
  const [holders, setHolders] = useState<CurrentHolder[]>([]);
  const [holdersLoading, setHoldersLoading] = useState(false);
  const [fromHolder, setFromHolder] = useState<string>(presetHolder ?? '');
  const [held, setHeld] = useState<KeyLine[]>([]);
  const [picks, setPicks] = useState<Record<string, Pick>>({});

  const [roster, setRoster] = useState<{ employees: HolderOption[]; ics: HolderOption[] }>({ employees: [], ics: [] });
  const [toQuery, setToQuery] = useState('');
  const [toHolder, setToHolder] = useState<HolderOption | null>(null);
  const [toEmail, setToEmail] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [notes, setNotes] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<TransferResult | null>(null);

  // Who currently holds keys AT this client — only they have anything to give.
  useEffect(() => {
    if (!account) { setHolders([]); setFromHolder(''); return; }
    setHoldersLoading(true);
    getCurrentHolders(account.id)
      .then((d) => {
        setHolders(d.holders);
        setFromHolder((cur) => (d.holders.some((h) => h.holder === cur) ? cur : ''));
      })
      .catch(() => setHolders([]))
      .finally(() => setHoldersLoading(false));
  }, [account]);

  useEffect(() => {
    getHolders().then(setRoster).catch(() => setRoster({ employees: [], ics: [] }));
  }, []);

  // Everything the FROM holder has out at this client, pre-checked in full —
  // the common case is handing over the whole set.
  useEffect(() => {
    if (!account || !fromHolder) { setHeld([]); setPicks({}); return; }
    getTransferable(account.id, fromHolder)
      .then((d) => {
        setHeld(d.keys);
        const next: Record<string, Pick> = {};
        for (const k of d.keys) next[k.type] = { checked: true, qty: k.qty };
        setPicks(next);
      })
      .catch(() => { setHeld([]); setPicks({}); });
  }, [account, fromHolder]);

  useEffect(() => { setToEmail(toHolder?.email ?? ''); }, [toHolder]);

  const filteredRoster = useMemo(() => {
    const q = toQuery.trim().toLowerCase();
    const match = (o: HolderOption) =>
      (!q || o.name.toLowerCase().includes(q) || (o.email || '').toLowerCase().includes(q))
      && o.name.trim().toLowerCase() !== fromHolder.trim().toLowerCase();
    return { employees: roster.employees.filter(match), ics: roster.ics.filter(match) };
  }, [roster, toQuery, fromHolder]);

  const lines = Object.entries(picks)
    .filter(([, p]) => p.checked && p.qty > 0)
    .map(([type, p]) => ({ type: type as KeyTypeKey, qty: p.qty }));
  const totalKeys = lines.reduce((n, l) => n + l.qty, 0);
  const partial = held.length > 0 && totalKeys < held.reduce((n, k) => n + k.qty, 0);
  const canSubmit = !!account && !!fromHolder && !!toHolder && lines.length > 0 && !saving;

  const setPick = (type: string, patch: Partial<Pick>) =>
    setPicks({ ...picks, [type]: { ...(picks[type] ?? { checked: false, qty: 1 }), ...patch } });

  const submit = async () => {
    if (!canSubmit || !account || !toHolder) return;
    setSaving(true); setError('');
    try {
      setDone(await transferKeys({
        account_id: account.id,
        from_holder: fromHolder,
        to_holder: toHolder.name,
        to_holder_type: toHolder.type,
        to_holder_id: toHolder.id,
        to_holder_email: toEmail.trim() || null,
        keys: lines,
        due_at: dueAt || null,
        notes: notes.trim() || null,
      }));
      onDone();
    } catch (e: any) {
      setError(e?.message || 'Transfer failed');
    } finally {
      setSaving(false);
    }
  };

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
            <SendLine label={`Return notice to ${done.from.holder}`} ok={done.email.from.ok} recipients={done.email.from.recipients} error={done.email.from.error} />
            <SendLine label={`Receipt notice to ${done.to.holder}`} ok={done.email.to.ok} recipients={done.email.to.recipients} error={done.email.to.error} />
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
    <Modal title="Transfer Keys" onClose={onClose} width="max-w-lg">
      <div className="space-y-5 max-h-[70vh] overflow-y-auto pr-1">
        <p className="text-xs text-cw-muted">
          Records keys passing directly from one person to another. Custody moves in one step — the keys are never
          shown as held by two people, or by nobody.
        </p>

        <div>
          <SectionLabel>Client</SectionLabel>
          <ClientPicker value={account} onSelect={(v) => { setAccount(v); setFromHolder(''); }} />
        </div>

        <div>
          <SectionLabel>From</SectionLabel>
          <select
            className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
            value={fromHolder}
            onChange={(e) => setFromHolder(e.target.value)}
            disabled={!account}
          >
            <option value="">
              {!account ? '— Select a client first —'
                : holdersLoading ? 'Loading current holders…'
                  : `— Who is handing the keys over (${holders.length}) —`}
            </option>
            {holders.map((h) => (
              <option key={h.holder} value={h.holder}>
                {h.holder} — {h.total_keys} key{h.total_keys === 1 ? '' : 's'} out
                {h.holder_type ? ` (${h.holder_type === 'ic' ? 'IC' : 'Employee'})` : ''}
              </option>
            ))}
          </select>
          {account && !holdersLoading && holders.length === 0 && (
            <p className="text-sm text-cw-muted mt-2">Nobody currently has keys out at {account.name}.</p>
          )}
        </div>

        {fromHolder && (
          <div>
            <SectionLabel>Keys being handed over</SectionLabel>
            {held.length === 0 ? (
              <p className="text-sm text-cw-muted">Loading what {fromHolder} has out…</p>
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
                {partial && (
                  <p className="text-[11px] text-[#7a5a00] bg-[#fff8e6] border border-[#e8cf8a] rounded px-2 py-1.5 mt-2">
                    Partial transfer — the unchecked keys stay checked out to {fromHolder}.
                  </p>
                )}
              </>
            )}
          </div>
        )}

        <div>
          <SectionLabel>To</SectionLabel>
          <div className="space-y-2">
            <input
              className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
              placeholder="Filter staff and IC vendors…"
              value={toQuery}
              onChange={(e) => setToQuery(e.target.value)}
            />
            <select
              className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
              value={toHolder ? `${toHolder.type}:${toHolder.id}` : ''}
              onChange={(e) => {
                const [type, id] = e.target.value.split(':');
                const list = type === 'ic' ? roster.ics : roster.employees;
                setToHolder(list.find((o) => String(o.id) === id) ?? null);
              }}
            >
              <option value="">— Select the person receiving the keys —</option>
              {filteredRoster.employees.length > 0 && (
                <optgroup label="City Wide Employees">
                  {filteredRoster.employees.map((o) => (
                    <option key={`employee:${o.id}`} value={`employee:${o.id}`}>
                      {o.name}{o.detail ? ` — ${o.detail}` : ''}
                    </option>
                  ))}
                </optgroup>
              )}
              {filteredRoster.ics.length > 0 && (
                <optgroup label="Independent Contractors">
                  {filteredRoster.ics.map((o) => (
                    <option key={`ic:${o.id}`} value={`ic:${o.id}`}>{o.name}</option>
                  ))}
                </optgroup>
              )}
            </select>
            <div>
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
        </div>

        <div>
          <SectionLabel>Details</SectionLabel>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Due back</label>
              <input type="date" className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
              <textarea className="input h-16 resize-none focus:ring-[#C0272D] focus:border-[#C0272D]" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
        </div>

        {error && <ErrorBanner>{error}</ErrorBanner>}
      </div>

      <div className="flex items-center gap-2 pt-4 border-t border-gray-200 mt-4">
        <button onClick={submit} disabled={!canSubmit} className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
          {saving ? 'Transferring…' : `Transfer${totalKeys ? ` ${totalKeys} Key${totalKeys === 1 ? '' : 's'}` : ''}`}
        </button>
        <button onClick={onClose} className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:bg-gray-50 transition-colors">Cancel</button>
        <span className="text-[11px] text-gray-400 ml-auto">Two signature forms · both holders and Cara emailed.</span>
      </div>
    </Modal>
  );
}
