// ── Key Forms tab ────────────────────────────────────────────────────────────
// The auditable artifact, listed. Every custody event leaves one here, and an
// audit can generate current-state forms for anyone on demand.
//
// Sending is deliberately allowed more than once — a resend is a normal audit
// action, not a mistake — and every send is logged with its recipients.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import {
  getKeyFormDocs, generateKeyFormDocs, sendKeyFormDoc, bulkSendKeyFormDocs,
  downloadKeyFormDocPdf, getHolders,
  type KeyFormDoc, type HolderOption,
} from '../lib/api';

const EVENT_FILTERS = [
  { key: 'all', label: 'All events' },
  { key: 'checkin', label: 'Check-in' },
  { key: 'checkout', label: 'Check-out' },
  { key: 'transfer', label: 'Transfer' },
  { key: 'reassignment', label: 'Reassignment' },
  { key: 'audit', label: 'Audit' },
];

const STATUS_FILTERS = [
  { key: 'all', label: 'All statuses' },
  { key: 'draft', label: 'Draft' },
  { key: 'sent', label: 'Sent' },
  { key: 'signed', label: 'Signed' },
  { key: 'unsigned', label: 'Unsigned' },
];

/** Status is the thing an auditor scans for, so it carries real colour. */
function StatusPill({ status, noEmail }: { status: string; noEmail: boolean }) {
  if (noEmail && status !== 'signed') {
    return (
      <span
        title="No email on file — this form cannot be sent to the holder"
        className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap bg-[#fbeaea] text-[#C0272D] border border-[#C0272D]"
      >
        Draft · no email
      </span>
    );
  }
  const style: Record<string, string> = {
    signed: 'bg-[#e8f5ea] text-[#2d7a3a] border-[#2d7a3a]',
    sent: 'bg-[#fff8e6] text-[#7a5a00] border-[#e8cf8a]',
    unsigned: 'bg-[#fbeaea] text-[#C0272D] border-[#C0272D]',
    draft: 'bg-[#f0f0ee] text-[#6b6b68] border-cw-border',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize border whitespace-nowrap ${style[status] ?? style.draft}`}>
      {status}
    </span>
  );
}

const fmt = (iso: string | null): string => {
  if (!iso) return '—';
  const d = new Date(/[Tt]|[Zz]$/.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
};

// ── Generate: one holder or several ──────────────────────────────────────────
function GenerateModal({ onClose, onDone }: { onClose: () => void; onDone: (n: number) => void }) {
  const [options, setOptions] = useState<{ employees: HolderOption[]; ics: HolderOption[] }>({ employees: [], ics: [] });
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Record<string, HolderOption>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { getHolders().then(setOptions).catch(() => {}); }, []);

  const all = useMemo(() => [...options.employees, ...options.ics], [options]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((o) => !q || o.name.toLowerCase().includes(q) || (o.email || '').toLowerCase().includes(q));
  }, [all, query]);

  const keyOf = (o: HolderOption) => `${o.type}:${o.id}`;
  const toggle = (o: HolderOption) => setPicked((p) => {
    const k = keyOf(o);
    const next = { ...p };
    if (next[k]) delete next[k]; else next[k] = o;
    return next;
  });

  const chosen = Object.values(picked);

  const run = async () => {
    if (!chosen.length) return;
    setBusy(true); setError('');
    try {
      const r = await generateKeyFormDocs(chosen.map((o) => ({ name: o.name, type: o.type, email: o.email })));
      onDone(r.count);
      onClose();
    } catch (e: any) { setError(e?.message || 'Could not generate'); }
    finally { setBusy(false); }
  };

  return (
    <Modal title="Generate Key Form" onClose={onClose} width="max-w-lg">
      <div className="space-y-4">
        <p className="text-sm text-cw-muted">
          Each person selected gets their own form listing every key they currently hold.
        </p>
        <input
          className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
          placeholder="Filter staff and IC vendors…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="border border-cw-border rounded max-h-64 overflow-y-auto divide-y divide-gray-100">
          {filtered.length === 0 && <div className="px-3 py-3 text-sm text-cw-muted">No matches.</div>}
          {filtered.map((o) => (
            <label key={keyOf(o)} className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-[#faf9f8]">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[#C0272D]"
                checked={!!picked[keyOf(o)]}
                onChange={() => toggle(o)}
              />
              <span className="font-medium text-[#1a1a1a]">{o.name}</span>
              <span className="text-xs text-cw-muted">{o.detail}</span>
              {!o.email && (
                <span className="ml-auto text-[10px] font-semibold text-[#C0272D]">no email</span>
              )}
            </label>
          ))}
        </div>
        {error && <div className="rounded border border-[#C0272D] bg-[#fbeaea] px-3 py-2 text-sm text-[#C0272D]">{error}</div>}
        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-cw-muted">{chosen.length} selected</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-secondary">Cancel</button>
            <button onClick={run} disabled={!chosen.length || busy} className="btn-primary">
              {busy ? 'Generating…' : `Generate ${chosen.length || ''}`.trim()}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── View one form ────────────────────────────────────────────────────────────
function ViewModal({ form, onClose }: { form: KeyFormDoc; onClose: () => void }) {
  const cols: { key: keyof KeyFormLineLike; label: string }[] = [
    { key: 'metal', label: 'Metal' }, { key: 'card', label: 'Card' },
    { key: 'fob', label: 'Fob' }, { key: 'dispenser', label: 'Dispenser' },
    { key: 'office', label: 'Office' },
  ];
  type KeyFormLineLike = { metal: number; card: number; fob: number; dispenser: number; office: number };
  return (
    <Modal title={`${form.form_no} — ${form.holder_name}`} onClose={onClose} width="max-w-3xl">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <div><span className="text-cw-muted">Role:</span> {form.holder_role || '—'}</div>
          <div><span className="text-cw-muted">Shift:</span> {form.holder_shift || '—'}</div>
          <div><span className="text-cw-muted">Contact:</span> {form.holder_email || <span className="text-[#C0272D]">no email on file</span>}</div>
          <div><span className="text-cw-muted">Event:</span> {form.event_label}</div>
          <div><span className="text-cw-muted">Generated:</span> {fmt(form.generated_at)}</div>
          <div><span className="text-cw-muted">By:</span> {form.generated_by || '—'}</div>
        </div>
        {form.event_note && <p className="text-xs text-cw-muted italic">{form.event_note}</p>}

        <div className="card overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-[#1a1a1a] text-white text-[11px]">
                <th className="text-left px-3 py-2 font-medium">Client</th>
                <th className="text-left px-3 py-2 font-medium">BC Client #</th>
                {cols.map((c) => <th key={c.key} className="text-center px-3 py-2 font-medium">{c.label}</th>)}
                <th className="text-center px-3 py-2 font-medium">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {form.clients.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-4 text-center text-cw-muted">This person currently holds no keys.</td></tr>
              )}
              {form.clients.map((c, i) => (
                <tr key={`${c.account_id}-${i}`} className={i % 2 === 0 ? 'bg-white' : 'bg-[#f4f4f2]'}>
                  <td className="px-3 py-2 font-medium">{c.client}</td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-600">{c.bc_client_number || '—'}</td>
                  {cols.map((col) => (
                    <td key={col.key} className="px-3 py-2 text-center">
                      {(c as any)[col.key] || <span className="text-gray-300">—</span>}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-center font-bold">{c.subtotal}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-[#C0272D] bg-[#f4f4f2]">
                <td colSpan={7} className="px-3 py-2 font-bold">Total keys held</td>
                <td className="px-3 py-2 text-center font-bold text-[#C0272D]">{form.total_keys}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="text-xs text-cw-muted">
          Access codes never appear on a Key Form.
          {form.sent_to.length > 0 && <> · Sent to: {form.sent_to.join(', ')}</>}
          {form.signed_at && <> · Signed {fmt(form.signed_at)} by {form.signature_typed_name}</>}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={() => downloadKeyFormDocPdf(form.id, form.form_no)} className="btn-secondary">
            Download PDF
          </button>
          <button onClick={onClose} className="btn-primary">Close</button>
        </div>
      </div>
    </Modal>
  );
}

// ── Send: to the holder, or anywhere ─────────────────────────────────────────
function SendModal({
  ids, label, onClose, onSent,
}: {
  ids: number[]; label: string; onClose: () => void; onSent: (msg: string) => void;
}) {
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setBusy(true); setError('');
    try {
      if (ids.length === 1) {
        const r = await sendKeyFormDoc(ids[0], to.trim() || null);
        onSent(r.ok
          ? `Sent to ${r.recipients.join(', ')}.`
          : `Not sent: ${r.error}. The attempt is logged.`);
      } else {
        const r = await bulkSendKeyFormDocs(ids, to.trim() || null);
        onSent(`${r.sent} of ${ids.length} sent${r.failed ? `, ${r.failed} failed` : ''}.`);
      }
      onClose();
    } catch (e: any) { setError(e?.message || 'Send failed'); }
    finally { setBusy(false); }
  };

  return (
    <Modal title={`Send ${label}`} onClose={onClose} width="max-w-md">
      <div className="space-y-4">
        <p className="text-sm text-cw-text">
          Goes to the holder's email on file and to City Wide. Add an address below to route a
          copy anywhere else — useful during an audit.
        </p>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Send to <span className="text-gray-400 font-normal">— optional extra recipient</span>
          </label>
          <input
            type="email"
            className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
            placeholder="auditor@example.com"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        {error && <div className="rounded border border-[#C0272D] bg-[#fbeaea] px-3 py-2 text-sm text-[#C0272D]">{error}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={run} disabled={busy} className="btn-primary">{busy ? 'Sending…' : 'Send'}</button>
        </div>
      </div>
    </Modal>
  );
}

export default function KeyFormsTab({ notify }: { notify: (m: string) => void }) {
  const [forms, setForms] = useState<KeyFormDoc[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [eventType, setEventType] = useState('all');
  const [status, setStatus] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [showGenerate, setShowGenerate] = useState(false);
  const [viewing, setViewing] = useState<KeyFormDoc | null>(null);
  const [sending, setSending] = useState<{ ids: number[]; label: string } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { limit: '100' };
      if (debounced) params.search = debounced;
      if (eventType !== 'all') params.event_type = eventType;
      if (status !== 'all') params.status = status;
      if (from) params.from = from;
      if (to) params.to = to;
      const d = await getKeyFormDocs(params);
      setForms(d.forms);
      setTotal(d.total);
    } finally { setLoading(false); }
  }, [debounced, eventType, status, from, to]);

  useEffect(() => { load(); }, [load]);
  // A filter change must never leave a stale tick behind on a hidden row.
  useEffect(() => { setSelected(new Set()); }, [debounced, eventType, status, from, to]);

  const toggle = (id: number) => setSelected((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const allOnPage = forms.length > 0 && forms.every((f) => selected.has(f.id));

  const afterSend = (msg: string) => { notify(msg); setSelected(new Set()); load(); };

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input max-w-xs focus:ring-[#C0272D] focus:border-[#C0272D]"
          placeholder="Search holder, client or form #…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="input w-auto" value={eventType} onChange={(e) => setEventType(e.target.value)}>
          {EVENT_FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUS_FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        <input type="date" className="input w-auto" value={from} onChange={(e) => setFrom(e.target.value)} title="Generated from" />
        <input type="date" className="input w-auto" value={to} onChange={(e) => setTo(e.target.value)} title="Generated to" />
        <span className="flex-1" />
        {selected.size > 0 && (
          <button
            onClick={() => setSending({ ids: [...selected], label: `${selected.size} forms` })}
            className="px-3 h-[34px] rounded text-sm font-medium bg-[#1a1a1a] text-white hover:bg-black transition-colors"
          >
            Send Selected ({selected.size})
          </button>
        )}
        <button onClick={() => setShowGenerate(true)} className="px-3 h-[34px] rounded text-sm font-medium bg-[#C0272D] text-white hover:bg-[#a82227] transition-colors">
          Generate Key Form
        </button>
      </div>

      <div className="card overflow-x-auto max-w-full">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-[#1a1a1a] text-white text-[11px]">
              <th className="w-10 px-2 py-3">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[#C0272D] cursor-pointer"
                  checked={allOnPage}
                  onChange={() => setSelected(allOnPage ? new Set() : new Set(forms.map((f) => f.id)))}
                  aria-label="Select all forms shown"
                />
              </th>
              <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Form ID</th>
              <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Holder</th>
              <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Type</th>
              <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Clients</th>
              <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Total Keys</th>
              <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Generated</th>
              <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Sent To</th>
              <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Status</th>
              <th className="px-3 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={10} className="px-4 py-8 text-center text-cw-muted">Loading…</td></tr>
            ) : forms.length === 0 ? (
              <tr><td colSpan={10} className="px-4 py-8 text-center text-cw-muted">
                No key forms yet. One is generated on every check-in, check-out, transfer and
                reassignment — or generate a current-state form above.
              </td></tr>
            ) : forms.map((f, i) => (
              <tr key={f.id} className={`border-b border-gray-100 ${selected.has(f.id) ? 'bg-[#fbeaea]' : i % 2 === 0 ? 'bg-white' : 'bg-[#f4f4f2]'}`}>
                <td className="px-2 py-3 text-center">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[#C0272D] cursor-pointer"
                    checked={selected.has(f.id)}
                    onChange={() => toggle(f.id)}
                    aria-label={`Select ${f.form_no}`}
                  />
                </td>
                <td className="px-3 py-3 font-mono text-xs">{f.form_no}</td>
                <td className="px-3 py-3">
                  <div className="font-medium text-[#1a1a1a] whitespace-nowrap">{f.holder_name}</div>
                  <div className="text-[11px] text-cw-muted">{f.holder_role}{f.holder_shift ? ` · ${f.holder_shift}` : ''}</div>
                </td>
                <td className="px-3 py-3 whitespace-nowrap">{f.event_label}</td>
                <td className="px-3 py-3 text-center">{f.clients_covered}</td>
                <td className="px-3 py-3 text-center font-bold">{f.total_keys}</td>
                <td className="px-3 py-3 text-xs text-gray-600 whitespace-nowrap">{fmt(f.generated_at)}</td>
                <td className="px-3 py-3 text-xs text-gray-600 max-w-[180px] truncate" title={f.sent_to.join(', ')}>
                  {f.sent_to.length ? f.sent_to.join(', ') : '—'}
                </td>
                <td className="px-3 py-3 text-center"><StatusPill status={f.status} noEmail={f.no_email} /></td>
                <td className="px-3 py-3 text-right whitespace-nowrap">
                  <div className="inline-flex items-center gap-2">
                    <button onClick={() => setViewing(f)} className="text-xs border border-[#1a1a1a] text-[#1a1a1a] rounded px-2 py-1 hover:border-[#C0272D] hover:text-[#C0272D] transition-colors">View</button>
                    <button
                      onClick={() => setSending({ ids: [f.id], label: f.form_no })}
                      className="text-xs border border-[#1a1a1a] text-[#1a1a1a] rounded px-2 py-1 hover:border-[#C0272D] hover:text-[#C0272D] transition-colors"
                    >
                      {f.send_count > 0 ? 'Resend' : 'Send'}
                    </button>
                    <button onClick={() => downloadKeyFormDocPdf(f.id, f.form_no)} className="text-xs text-[#C0272D] hover:underline">PDF</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-cw-muted">{total} form{total === 1 ? '' : 's'}</div>

      {showGenerate && (
        <GenerateModal
          onClose={() => setShowGenerate(false)}
          onDone={(n) => { notify(`${n} key form${n === 1 ? '' : 's'} generated.`); load(); }}
        />
      )}
      {viewing && <ViewModal form={viewing} onClose={() => setViewing(null)} />}
      {sending && (
        <SendModal
          ids={sending.ids}
          label={sending.label}
          onClose={() => setSending(null)}
          onSent={afterSend}
        />
      )}
    </div>
  );
}
