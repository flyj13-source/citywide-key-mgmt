// ── Key Forms tab ────────────────────────────────────────────────────────────
// The auditable artifact, listed. Every custody event leaves one here, and an
// audit can generate current-state forms for anyone on demand.
//
// Sending is deliberately allowed more than once — a resend is a normal audit
// action, not a mistake — and every send is logged with its recipients.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import CorrectionModal, { type CorrectionAction } from './CorrectionModal';
import { getManager } from '../lib/auth';
import {
  getKeyFormDocs, generateKeyFormDocs, sendKeyFormDoc, bulkSendKeyFormDocs, retryFailedKeyForms,
  bulkCorrectKeyForms,
  downloadKeyFormDocPdf, regenerateKeyForm, getHolders, exportKeyFormDocs, getHolderFormClients,
  type KeyFormDoc, type HolderOption, type LinkState, type LinkStateCounts,
} from '../lib/api';
import { useSearchParams } from 'react-router-dom';
import AccountPicker, { type PickedAccount } from './AccountPicker';

const EVENT_FILTERS = [
  { key: 'all', label: 'All events' },
  { key: 'checkin', label: 'Check-out' },
  { key: 'checkout', label: 'Check-in' },
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
  // Corrections. Voided forms are hidden from every other view.
  { key: 'voided', label: 'Voided' },
  { key: 'acknowledged_unsigned', label: 'Acknowledged · unsigned' },
  // Not a stored status: a failed send leaves the row 'unsigned', which is
  // also what a never-sent form reads as. The server filters on send_error.
  { key: 'send_failed', label: 'Failed to send' },
  // Signature-link states — derived from the link's expiry, not stored.
  { key: 'awaiting', label: 'Awaiting signature' },
  { key: 'expiring_soon', label: 'Expiring soon' },
  { key: 'expired', label: 'Expired' },
  // Retention: older than 12 months and not tied to open custody. Never deleted.
  { key: 'archived', label: 'Archived forms' },
];

/** Every value the status filter accepts, for validating a deep-linked one. */
const STATUS_KEYS = new Set(STATUS_FILTERS.map((f) => f.key));

/**
 * The four signature states, as chips. Colours match the pills: amber-orange
 * for a link inside its last 24 hours, red for one that has run out.
 */
const LINK_CHIPS: { key: LinkState; label: string; on: string; off: string }[] = [
  { key: 'signed', label: 'Signed',
    on: 'bg-[#2d7a3a] border-[#2d7a3a] text-white',
    off: 'bg-[#e8f5ea] border-[#2d7a3a] text-[#2d7a3a] hover:bg-[#d7eedb]' },
  { key: 'awaiting', label: 'Awaiting signature',
    on: 'bg-[#7a5a00] border-[#7a5a00] text-white',
    off: 'bg-[#fff8e6] border-[#e8cf8a] text-[#7a5a00] hover:bg-[#fdf0cc]' },
  { key: 'expiring_soon', label: 'Expiring soon',
    on: 'bg-[#d9730d] border-[#d9730d] text-white',
    off: 'bg-[#fff1e3] border-[#d9730d] text-[#b35c00] hover:bg-[#ffe3c7]' },
  { key: 'expired', label: 'Expired',
    on: 'bg-[#C0272D] border-[#C0272D] text-white',
    off: 'bg-[#fbeaea] border-[#C0272D] text-[#C0272D] hover:bg-[#f7d9da]' },
];

/** Status is the thing an auditor scans for, so it carries real colour. */
function StatusPill({ status, noEmail, form }: { status: string; noEmail: boolean; form?: KeyFormDoc }) {
  // Corrections outrank everything else the pill would say — including the
  // no-email warning, which is moot once the form is voided or settled.
  if (status === 'voided') {
    return (
      <span
        title="Voided — this form should not exist"
        className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap bg-[#eeeeec] text-[#6b6b68] border border-[#d5d5d1] line-through"
      >
        Voided
      </span>
    );
  }
  if (status === 'superseded') {
    return (
      <span
        title="Replaced by a newer form generated from current data. Kept, because it may already have been sent."
        className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap bg-[#eeeeec] text-[#6b6b68] border border-[#d5d5d1]"
      >
        Superseded
      </span>
    );
  }
  if (status === 'acknowledged_unsigned') {
    return (
      <span
        title="Acknowledged without a signature — no signature was collected"
        className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap bg-[#f2efe6] text-[#7a6a45] border border-[#ddd2b6]"
      >
        Ackd · unsigned
      </span>
    );
  }
  // Every form is signable, so the pill answers ONE question: has the
  // signature landed? Signed, or awaiting it.
  if (status === 'signed') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap border bg-[#e8f5ea] text-[#2d7a3a] border-[#2d7a3a]">
        Signed
      </span>
    );
  }
  // Still waiting. WHICH kind of waiting is the link's state: comfortably
  // open, inside its last 24 hours, or run out.
  const state = form?.link_state ?? 'awaiting';
  const expires = form?.link_expires_at ? fmtWhen(form.link_expires_at) : null;
  const cycle = form && form.link_renewals > 0
    ? ` · renewed ${form.link_renewals} of ${form.link_max_renewals}` : '';
  const pill = state === 'expired'
    ? {
      label: 'Expired',
      cls: 'bg-[#fbeaea] text-[#C0272D] border-[#C0272D]',
      title: form?.link_exhausted_at
        ? `Link expired unsigned after ${form.link_max_renewals} automatic renewals. `
          + 'It will not renew again on its own — resend it or follow up with the holder.'
        : 'Link expired unsigned. A fresh 5-day link is minted automatically.',
    }
    : state === 'expiring_soon'
      ? {
        label: 'Expiring soon',
        cls: 'bg-[#fff1e3] text-[#b35c00] border-[#d9730d]',
        title: `Link expires ${expires ?? 'within 24 hours'}${cycle}`,
      }
      : {
        label: 'Awaiting signature',
        cls: 'bg-[#fff8e6] text-[#7a5a00] border-[#e8cf8a]',
        title: expires ? `Link open until ${expires}${cycle}` : undefined,
      };
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span
        title={pill.title}
        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${pill.cls}`}
      >
        {pill.label}
      </span>
      {form?.link_exhausted_at && (
        <span
          title="Automatic renewals used up — needs manual attention"
          className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold border bg-white text-[#C0272D] border-[#C0272D]"
        >
          needs attention
        </span>
      )}
      {/* A DELIVERY problem, not a missing signature path: the link exists and
          opens on a device handed to the holder. Shown beside the state rather
          than replacing it, so a form is never read as unsignable. */}
      {noEmail && (
        <span
          title="No email on file — the link cannot be emailed. Open it on a device with the holder to collect the signature in person."
          className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold border bg-[#fbeaea] text-[#C0272D] border-[#C0272D]"
        >
          no email
        </span>
      )}
    </span>
  );
}

/** "Sep 23, 4:05 PM" in Boston time — the moment a link runs out. */
const fmtWhen = (iso: string): string => {
  const d = new Date(/[Tt]|[Zz]$/.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
};

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
function GenerateModal({ onClose, onDone }: { onClose: () => void; onDone: (n: number, skipped: string[]) => void }) {
  const [options, setOptions] = useState<{ employees: HolderOption[]; ics: HolderOption[] }>({ employees: [], ics: [] });
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Record<string, HolderOption>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Full picture (default): one form each, every client. Client by client:
  // one form per selected client, each separately signable.
  const [coverage, setCoverage] = useState<'full' | 'client'>('full');
  const [clientOpts, setClientOpts] = useState<{ account_id: number; client: string; bc_client_number: string | null; keys: number }[]>([]);
  const [pickedClients, setPickedClients] = useState<Set<number>>(new Set());

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
  const chosenKey = chosen.map(keyOf).sort().join('|');

  // The clients the chosen holder(s) have keys at — only those can produce a
  // form, so only those are offered.
  useEffect(() => {
    if (coverage !== 'client' || !chosen.length) { setClientOpts([]); return; }
    let cancelled = false;
    Promise.all(chosen.map((o) => getHolderFormClients(o.name, o.type).catch(() => ({ clients: [] }))))
      .then((rs) => {
        if (cancelled) return;
        const by = new Map<number, { account_id: number; client: string; bc_client_number: string | null; keys: number }>();
        for (const r of rs) for (const c of r.clients) {
          const prev = by.get(c.account_id);
          by.set(c.account_id, prev ? { ...prev, keys: prev.keys + c.keys } : c);
        }
        const list = [...by.values()].sort((a, b) => a.client.localeCompare(b.client));
        setClientOpts(list);
        setPickedClients((p) => new Set([...p].filter((id) => by.has(id))));
      });
    return () => { cancelled = true; };
  }, [coverage, chosenKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const formsToMake = coverage === 'client' ? chosen.length * pickedClients.size : chosen.length;
  const canRun = chosen.length > 0 && (coverage === 'full' || pickedClients.size > 0);

  const run = async () => {
    if (!canRun) return;
    setBusy(true); setError('');
    try {
      const r = await generateKeyFormDocs(
        chosen.map((o) => ({ name: o.name, type: o.type, email: o.email })),
        coverage === 'client' ? { coverage: 'client', account_ids: [...pickedClients] } : { coverage: 'full' },
      );
      onDone(r.count, r.skipped ?? []);
      onClose();
    } catch (e: any) { setError(e?.message || 'Could not generate'); }
    finally { setBusy(false); }
  };

  return (
    <Modal title="Generate Key Form" onClose={onClose} width="max-w-lg">
      <div className="space-y-4">
        <div className="space-y-2">
          {([
            ['full', 'Full picture', 'One form per person, covering every client they hold keys at.'],
            ['client', 'Client by client', 'Pick one or more clients; one form per client, each signed separately.'],
          ] as const).map(([k, label, hint]) => (
            <label key={k} className="flex items-start gap-2.5 text-sm cursor-pointer">
              <input
                type="radio" name="coverage" className="mt-0.5 accent-[#C0272D]"
                checked={coverage === k} onChange={() => setCoverage(k)}
              />
              <span>
                <span className="font-medium text-[#1a1a1a]">{label}</span>
                <span className="block text-xs text-cw-muted">{hint}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="text-xs text-cw-muted">
          Anyone holding nothing is skipped — a holdings form with no keys on it has nothing to sign.
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
        {coverage === 'client' && (
          <div>
            <div className="text-xs font-semibold text-[#1a1a1a] mb-1">
              Clients {chosen.length > 1 && <span className="font-normal text-cw-muted">— a form for each person at each client</span>}
            </div>
            {!chosen.length ? (
              <p className="text-xs text-cw-muted">Choose a person above to list the clients they hold keys at.</p>
            ) : clientOpts.length === 0 ? (
              <p className="text-xs text-cw-muted">No keys on record at any client.</p>
            ) : (
              <div className="border border-cw-border rounded max-h-44 overflow-y-auto divide-y divide-gray-100">
                {clientOpts.map((c) => (
                  <label key={c.account_id} className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-[#faf9f8]">
                    <input
                      type="checkbox" className="h-4 w-4 accent-[#C0272D]"
                      checked={pickedClients.has(c.account_id)}
                      onChange={() => setPickedClients((p) => {
                        const n = new Set(p);
                        if (n.has(c.account_id)) n.delete(c.account_id); else n.add(c.account_id);
                        return n;
                      })}
                    />
                    <span className="font-medium text-[#1a1a1a]">{c.client}</span>
                    {c.bc_client_number && <span className="text-xs text-cw-muted font-mono">{c.bc_client_number}</span>}
                    <span className="ml-auto text-xs text-cw-muted">{c.keys} key{c.keys === 1 ? '' : 's'}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        {error && <div className="rounded border border-[#C0272D] bg-[#fbeaea] px-3 py-2 text-sm text-[#C0272D]">{error}</div>}
        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-cw-muted">
            {chosen.length} selected{coverage === 'client' && pickedClients.size ? ` · ${pickedClients.size} client${pickedClients.size === 1 ? '' : 's'}` : ''}
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-secondary">Cancel</button>
            <button onClick={run} disabled={!canRun || busy} className="btn-primary">
              {busy ? 'Generating…' : `Generate ${formsToMake || ''} form${formsToMake === 1 ? '' : 's'}`.replace('  ', ' ')}
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
    <Modal
      title={`${form.form_no} · ${form.doc_title ?? 'Key Form'} — ${form.holder_name}`}
      onClose={onClose}
      width="max-w-3xl"
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <div><span className="text-cw-muted">Role:</span> {form.holder_role || '—'}</div>
          <div><span className="text-cw-muted">Contact:</span> {form.holder_email || <span className="text-[#C0272D]">no email on file</span>}</div>
          <div><span className="text-cw-muted">Event:</span> {form.event_label}</div>
          {form.counterparty_name && (
            <div><span className="text-cw-muted">Counterparty:</span> {form.counterparty_name}</div>
          )}
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
                <tr><td colSpan={8} className="px-3 py-4 text-center text-cw-muted">
                  {form.doc_kind === 'return_receipt'
                    ? 'No keys recorded on this return.'
                    : 'This person currently holds no keys.'}
                </td></tr>
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
                <td colSpan={7} className="px-3 py-2 font-bold">
                  {form.total_label.toLowerCase().replace(/^./, (c) => c.toUpperCase())}
                </td>
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

export default function KeyFormsTab({
  notify, fixedAccountId, fixedHolder,
}: {
  notify: (m: string) => void;
  /**
   * Contextual use: pinned to one client (client detail page) or one holder
   * (IC / staff detail). Shows the complete history — archived forms included —
   * and hides Generate, which belongs to the main tab.
   */
  fixedAccountId?: number;
  fixedHolder?: string;
}) {
  const embedded = fixedAccountId != null || !!fixedHolder;
  const [client, setClient] = useState<PickedAccount | null>(null);
  const [archivedCount, setArchivedCount] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [forms, setForms] = useState<KeyFormDoc[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [eventType, setEventType] = useState('all');
  // A deep link (the dashboard's Expiring soon / Expired cards) can open the
  // tab pre-filtered: /registry?tab=keyforms&forms_status=expired
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState(() => {
    const s = searchParams.get('forms_status') ?? 'all';
    return STATUS_KEYS.has(s) ? s : 'all';
  });
  const [linkCounts, setLinkCounts] = useState<LinkStateCounts | null>(null);
  // Unfiltered backlog of forms whose last send failed — the chip shows it
  // from any view, because a queue you cannot see is a queue you forget.
  const [failedCount, setFailedCount] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [retryResult, setRetryResult] = useState<string | null>(null);
  const canCorrect = !!getManager()?.can_delete;
  const [correcting, setCorrecting] = useState<{ action: CorrectionAction; ids: number[] } | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [showGenerate, setShowGenerate] = useState(false);
  const [viewing, setViewing] = useState<KeyFormDoc | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [sending, setSending] = useState<{ ids: number[]; label: string } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  // One builder, so the table and its Excel export can never disagree.
  const params = useMemo(() => {
    const p: Record<string, string> = {};
    if (debounced) p.search = debounced;
    if (eventType !== 'all') p.event_type = eventType;
    if (status !== 'all') p.status = status;
    if (from) p.from = from;
    if (to) p.to = to;
    const acct = fixedAccountId ?? client?.id;
    if (acct) p.account_id = String(acct);
    if (fixedHolder) p.holder = fixedHolder;
    // A client's or holder's own page shows the whole history, archived too.
    if (embedded && status !== 'archived') p.archived = 'all';
    return p;
  }, [debounced, eventType, status, from, to, client, fixedAccountId, fixedHolder, embedded]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await getKeyFormDocs({ ...params, limit: '100' });
      setForms(d.forms);
      setTotal(d.total);
      setFailedCount(d.failed_count ?? 0);
      setLinkCounts(d.link_counts ?? null);
      setArchivedCount(d.archived_count ?? 0);
    } finally { setLoading(false); }
  }, [params]);

  useEffect(() => { load(); }, [load]);
  // A filter change must never leave a stale tick behind on a hidden row.
  useEffect(() => { setSelected(new Set()); }, [params]);

  const toggle = (id: number) => setSelected((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const allOnPage = forms.length > 0 && forms.every((f) => selected.has(f.id));

  const afterSend = (msg: string) => { notify(msg); setSelected(new Set()); load(); };

  const regenerate = async (f: KeyFormDoc) => {
    setBusyId(f.id);
    try {
      const r = await regenerateKeyForm(f.id);
      const moved = r.form.total_keys !== f.total_keys;
      notify(
        `${r.form.form_no} generated from current data — ${r.form.total_keys} key`
        + `${r.form.total_keys === 1 ? '' : 's'}`
        + (moved ? ` (was ${f.total_keys} on ${f.form_no})` : ` (unchanged from ${f.form_no})`)
        + `. ${f.form_no} is kept, marked superseded.`,
      );
      load();
    } catch (e: any) {
      notify(e?.message || 'Could not regenerate this form');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input max-w-xs focus:ring-[#C0272D] focus:border-[#C0272D]"
          placeholder="Search form #, holder, IC, client, BC Client # or BC Vendor #…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {fixedAccountId == null && (
          <div className="w-72">
            <AccountPicker value={client} onSelect={setClient} placeholder="Client — any" />
          </div>
        )}
        <select className="input !w-auto" value={eventType} onChange={(e) => setEventType(e.target.value)}>
          {EVENT_FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        <select className="input !w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUS_FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>

        {/* Signature states — always shown, with live counts, so the backlog is
            visible from any filter. Click to filter; click again to clear. */}
        {linkCounts && LINK_CHIPS.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setStatus(status === c.key ? 'all' : c.key)}
            className={`inline-flex items-center gap-1.5 h-[34px] px-3 rounded text-sm font-medium border transition-colors ${
              status === c.key ? c.on : c.off
            }`}
          >
            {c.label}
            <span className="tabular-nums font-semibold">{linkCounts[c.key]}</span>
          </button>
        ))}

        {/* Only present when there is actually a backlog. */}
        {failedCount > 0 && (
          <>
            <button
              type="button"
              onClick={() => setStatus(status === 'send_failed' ? 'all' : 'send_failed')}
              className={`inline-flex items-center gap-1.5 h-[34px] px-3 rounded text-sm font-medium border transition-colors ${
                status === 'send_failed'
                  ? 'bg-[#C0272D] border-[#C0272D] text-white'
                  : 'bg-[#fbeaea] border-[#C0272D] text-[#C0272D] hover:bg-[#f7d9da]'
              }`}
              title="Forms whose last send was rejected by the mail server"
            >
              {failedCount} failed to send
            </button>
            <button
              type="button"
              disabled={retrying}
              onClick={async () => {
                setRetrying(true); setRetryResult(null);
                try {
                  const r = await retryFailedKeyForms();
                  setFailedCount(r.remaining);
                  const firstError = r.results.find((x) => !x.ok)?.error;
                  setRetryResult(
                    r.failed === 0
                      ? `✓ All ${r.sent} form${r.sent === 1 ? '' : 's'} sent.`
                      : r.stopped_early
                        // Stopped at the first rejection rather than repeating
                        // it across the whole backlog.
                        ? `Stopped after the first rejection — ${r.remaining} form${r.remaining === 1 ? '' : 's'} still queued. ${firstError ?? ''}`
                        : `${r.sent} sent, ${r.failed} still failing${firstError ? ` — ${firstError}` : ''}`
                  );
                  load();
                } catch (e: any) {
                  setRetryResult(e?.message || 'Retry failed');
                } finally { setRetrying(false); }
              }}
              className="inline-flex items-center gap-1.5 h-[34px] px-3 rounded text-sm font-medium bg-white border border-[#1a1a1a] text-[#1a1a1a] hover:border-[#C0272D] hover:text-[#C0272D] disabled:opacity-50 transition-colors"
              title="Re-send every failed form, oldest first"
            >
              {retrying ? 'Retrying…' : 'Retry all failed'}
            </button>
          </>
        )}
        <input type="date" className="input !w-auto" value={from} onChange={(e) => setFrom(e.target.value)} title="Generated from" />
        <input type="date" className="input !w-auto" value={to} onChange={(e) => setTo(e.target.value)} title="Generated to" />
        <span className="flex-1" />
        {selected.size > 0 && (
          <button
            onClick={() => setSending({ ids: [...selected], label: `${selected.size} forms` })}
            className="px-3 h-[34px] rounded text-sm font-medium bg-[#1a1a1a] text-white hover:bg-black transition-colors"
          >
            Send Selected ({selected.size})
          </button>
        )}
        {selected.size > 0 && canCorrect && (
          <>
            <button
              onClick={() => setCorrecting({ action: 'acknowledge', ids: [...selected] })}
              className="px-3 h-[34px] rounded text-sm font-medium bg-white border border-[#1a1a1a] text-[#1a1a1a] hover:border-[#7a6a45] hover:text-[#7a6a45] transition-colors"
            >
              Mark acknowledged
            </button>
            <button
              onClick={() => setCorrecting({ action: 'void', ids: [...selected] })}
              className="px-3 h-[34px] rounded text-sm font-medium bg-[#C0272D] text-white hover:bg-[#a82227] transition-colors"
            >
              Void selected
            </button>
          </>
        )}
        {/* Retention: forms past 12 months live here — never deleted. */}
        {archivedCount > 0 && !embedded && (
          <button
            type="button"
            onClick={() => setStatus(status === 'archived' ? 'all' : 'archived')}
            className={`inline-flex items-center gap-1.5 h-[34px] px-3 rounded text-sm font-medium border transition-colors ${
              status === 'archived'
                ? 'bg-[#6b6b68] border-[#6b6b68] text-white'
                : 'bg-[#eeeeec] border-[#d5d5d1] text-[#6b6b68] hover:bg-[#e4e4e1]'
            }`}
            title="Older than 12 months and not tied to open custody. Still searchable and downloadable."
          >
            Archived forms <span className="tabular-nums font-semibold">{archivedCount}</span>
          </button>
        )}
        <button
          type="button"
          disabled={exporting || total === 0}
          onClick={async () => {
            setExporting(true);
            try { await exportKeyFormDocs(params); }
            catch (e: any) { notify(e?.message || 'Could not export'); }
            finally { setExporting(false); }
          }}
          className="px-3 h-[34px] rounded text-sm font-medium border border-[#1a1a1a] text-[#1a1a1a] hover:bg-gray-50 disabled:opacity-50 transition-colors"
          title="Every form matching these filters, not just this page"
        >
          {exporting ? 'Exporting…' : `Export ${total} to Excel`}
        </button>
        {!embedded && (
          <button onClick={() => setShowGenerate(true)} className="px-3 h-[34px] rounded text-sm font-medium bg-[#C0272D] text-white hover:bg-[#a82227] transition-colors">
            Generate Key Form
          </button>
        )}
      </div>

      {correcting && (
        <CorrectionModal
          action={correcting.action}
          target="form"
          count={correcting.ids.length}
          sample={forms.filter((f) => correcting.ids.includes(f.id)).map((f) => `${f.form_no} — ${f.holder_name}`)}
          onClose={() => setCorrecting(null)}
          onConfirm={async (reason) => {
            const r = await bulkCorrectKeyForms(correcting.action, correcting.ids, reason);
            const skipped = r.skipped.length ? `, ${r.skipped.length} skipped` : '';
            setRetryResult(
              `✓ ${r.applied} form${r.applied === 1 ? '' : 's'} `
              + `${correcting.action === 'void' ? 'voided' : 'acknowledged'}${skipped}.`
            );
            setCorrecting(null);
            setSelected(new Set());
            load();
          }}
        />
      )}

      {retryResult && (
        <div className={`rounded border px-3 py-2 text-sm ${
          retryResult.startsWith('✓')
            ? 'border-green-200 bg-green-50 text-green-800'
            : 'border-[#C0272D] bg-[#fbeaea] text-[#C0272D]'
        }`}>
          {retryResult}
          <button
            onClick={() => setRetryResult(null)}
            className="ml-3 underline text-xs opacity-70 hover:opacity-100"
          >
            dismiss
          </button>
        </div>
      )}

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
              <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Client</th>
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
              <tr><td colSpan={11} className="px-4 py-8 text-center text-cw-muted">Loading…</td></tr>
            ) : forms.length === 0 ? (
              <tr><td colSpan={11} className="px-4 py-8 text-center text-cw-muted">
                No key forms yet. One is generated on every check-out, check-in, transfer and
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
                  <div className="text-[11px] text-cw-muted">{f.holder_role}</div>
                </td>
                <td className="px-3 py-3 max-w-[220px]">
                  {f.clients.length === 1 ? (
                    <>
                      <div className="truncate" title={f.clients[0].client}>{f.clients[0].client}</div>
                      {f.clients[0].bc_client_number && (
                        <div className="text-[11px] text-cw-muted font-mono">{f.clients[0].bc_client_number}</div>
                      )}
                    </>
                  ) : f.clients.length > 1 ? (
                    <span
                      className="underline decoration-dotted cursor-help whitespace-nowrap"
                      title={f.clients.map((c) => c.client).join('\n')}
                    >
                      {f.clients.length} clients
                    </span>
                  ) : <span className="text-gray-300">—</span>}
                  {f.archived && (
                    <span className="ml-1 inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#eeeeec] text-[#6b6b68]">archived</span>
                  )}
                </td>
                <td className="px-3 py-3 whitespace-nowrap">
                  {f.event_label}
                  {f.form_coverage === 'client' && <div className="text-[11px] text-cw-muted">one client</div>}
                </td>
                <td className="px-3 py-3 text-center">{f.clients_covered}</td>
                <td className="px-3 py-3 text-center font-bold">{f.total_keys}</td>
                <td className="px-3 py-3 text-xs text-gray-600 whitespace-nowrap">{fmt(f.generated_at)}</td>
                <td className="px-3 py-3 text-xs text-gray-600 max-w-[180px] truncate" title={f.sent_to.join(', ')}>
                  {f.sent_to.length ? f.sent_to.join(', ') : '—'}
                </td>
                <td className="px-3 py-3 text-center"><StatusPill status={f.status} noEmail={f.no_email} form={f} /></td>
                <td className="px-3 py-3 text-right whitespace-nowrap">
                  <div className="inline-flex items-center gap-2">
                    <button onClick={() => setViewing(f)} className="text-xs border border-[#1a1a1a] text-[#1a1a1a] rounded px-2 py-1 hover:border-[#C0272D] hover:text-[#C0272D] transition-colors">View</button>
                    <button
                      onClick={() => setSending({ ids: [f.id], label: f.form_no })}
                      className="text-xs border border-[#1a1a1a] text-[#1a1a1a] rounded px-2 py-1 hover:border-[#C0272D] hover:text-[#C0272D] transition-colors"
                    >
                      {f.send_count > 0 ? 'Resend' : 'Send'}
                    </button>
                    {/* A form states a position. When that position has moved
                        on, the fix is a NEW form that says so — never a quiet
                        rewrite of one somebody may already have been sent. */}
                    {f.status !== 'signed' && f.status !== 'superseded' && f.status !== 'voided' && (
                      <button
                        onClick={() => regenerate(f)}
                        disabled={busyId === f.id}
                        title="Generate a fresh form at the holder's current position. This one is kept, marked superseded."
                        className="text-xs border border-[#1a1a1a] text-[#1a1a1a] rounded px-2 py-1 hover:border-[#C0272D] hover:text-[#C0272D] disabled:opacity-50 transition-colors"
                      >
                        {busyId === f.id ? '…' : 'Regenerate'}
                      </button>
                    )}
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
          onDone={(n, skipped) => {
            // Skipped holders are named, never swallowed: a run that covered
            // fewer people than were selected must not read as full success.
            const tail = skipped.length
              ? ` ${skipped.length} skipped with no keys on record (${skipped.join(', ')}) — record a return receipt for them instead.`
              : '';
            notify(`${n} key form${n === 1 ? '' : 's'} generated.${tail}`);
            load();
          }}
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
