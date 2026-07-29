import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import Layout from '../components/Layout';
import Modal from '../components/Modal';
import SignaturePad, { type SignaturePadHandle } from '../components/SignaturePad';
import {
  createKeyForm, getKeyForms, getKeyForm, getStaff, getContractors,
  type KeyForm, type KeyFormFull,
} from '../lib/api';
import { downloadPdf, downloadJpeg, downloadPng, renderReceiptCanvas } from '../lib/formDoc';

type PartyType = 'employee' | 'contractor';
type Tab = PartyType | 'log';

// ── Small shared bits ──────────────────────────────────────
function PartyBadge({ type }: { type: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${type === 'contractor' ? 'border border-[#C0272D] text-[#C0272D]' : 'bg-[#1a1a1a] text-white'}`}>
      {type === 'contractor' ? 'Contractor' : 'Employee'}
    </span>
  );
}
function ActionBadge({ action }: { action: string }) {
  const isReturn = action === 'return';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold ${isReturn ? 'bg-[#e8f0e9] text-[#2d7a3a]' : 'bg-[#fbeaea] text-[#C0272D]'}`}>
      {isReturn ? 'Returned' : 'Received'}
    </span>
  );
}
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] font-bold uppercase tracking-widest text-[#1a1a1a] border-b border-gray-200 pb-1 mb-3">{children}</div>;
}
function DownloadButtons({ onPdf, onJpg, onPng, disabled }: { onPdf: () => void; onJpg: () => void; onPng: () => void; disabled?: boolean }) {
  const cls = 'text-xs border rounded px-2 py-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  return (
    <span className="inline-flex gap-1.5">
      <button disabled={disabled} onClick={onPdf} className={`${cls} border-[#C0272D] text-[#C0272D] hover:bg-[#C0272D] hover:text-white`}>PDF</button>
      <button disabled={disabled} onClick={onJpg} className={`${cls} border-[#1a1a1a] text-[#1a1a1a] hover:bg-[#1a1a1a] hover:text-white`}>JPEG</button>
      <button disabled={disabled} onClick={onPng} className={`${cls} border-[#1a1a1a] text-[#1a1a1a] hover:bg-[#1a1a1a] hover:text-white`}>PNG</button>
    </span>
  );
}

// ── The Employee / Contractor form ─────────────────────────
function KeyFormEntry({ partyType, onSaved }: { partyType: PartyType; onSaved: () => void }) {
  const [action, setAction] = useState<'receive' | 'return'>('receive');
  const [roster, setRoster] = useState<{ id: number; name: string; email: string | null }[]>([]);
  const [personId, setPersonId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [accounts, setAccounts] = useState('');
  const [keyDetails, setKeyDetails] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<KeyFormFull | null>(null);
  const sigRef = useRef<SignaturePadHandle>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (partyType === 'employee') {
          const staff = await getStaff({ includeInactive: false });
          if (alive) setRoster(staff.map((s) => ({ id: s.id, name: s.name, email: s.email })));
        } else {
          const cons = await getContractors();
          if (alive) setRoster((cons as any[]).map((c) => ({ id: c.id, name: c.name, email: c.email })));
        }
      } catch { /* roster is optional — manual entry still works */ }
    })();
    return () => { alive = false; };
  }, [partyType]);

  const pickRoster = (id: string) => {
    if (!id) { setPersonId(null); return; }
    const p = roster.find((r) => String(r.id) === id);
    if (p) { setPersonId(p.id); setName(p.name); setEmail(p.email || ''); }
  };

  const reset = () => {
    setAction('receive'); setPersonId(null); setName(''); setEmail('');
    setAccounts(''); setKeyDetails(''); setNotes(''); setError('');
    setSaved(null); sigRef.current?.clear();
  };

  const save = async () => {
    setError('');
    if (!name.trim()) { setError('Please enter or select a name.'); return; }
    const signature = sigRef.current?.toDataURL();
    if (!signature) { setError('A signature is required.'); return; }
    setSaving(true);
    try {
      const accountList = accounts.split(/\n/).map((s) => s.trim()).filter(Boolean);
      const res = await createKeyForm({
        party_type: partyType,
        action,
        person_name: name.trim(),
        person_id: personId,
        person_email: email.trim() || null,
        account_names: accountList,
        key_details: keyDetails.trim() || null,
        notes: notes.trim() || null,
        signature_data: signature,
      });
      // Merge the in-hand signature so downloads work immediately (the API list
      // shape omits the heavy signature blob).
      setSaved({ ...res.form, signature_data: signature } as KeyFormFull);
      onSaved();
    } catch (e: any) {
      setError(e?.message || 'Could not save the form.');
    } finally {
      setSaving(false);
    }
  };

  const partyName = partyType === 'employee' ? 'Employee' : 'Contractor';

  if (saved) {
    return (
      <div className="card p-6 max-w-2xl mx-auto text-center space-y-4">
        <div className="text-[#2d7a3a] text-4xl">✓</div>
        <div>
          <h2 className="text-lg font-bold text-[#1a1a1a]">Signature captured</h2>
          <p className="text-sm text-cw-muted mt-1">
            {saved.person_name} — {partyName} key {saved.action === 'return' ? 'return' : 'receipt'} logged. Download the signed document:
          </p>
        </div>
        <div className="flex justify-center">
          <DownloadButtons onPdf={() => downloadPdf(saved)} onJpg={() => downloadJpeg(saved)} onPng={() => downloadPng(saved)} />
        </div>
        <button onClick={reset} className="text-sm text-[#C0272D] hover:underline">+ New {partyName.toLowerCase()} form</button>
      </div>
    );
  }

  return (
    <div className="card p-6 max-w-2xl mx-auto space-y-5">
      {/* Action toggle */}
      <div>
        <SectionLabel>Action</SectionLabel>
        <div className="inline-flex rounded-lg border border-cw-border overflow-hidden">
          {(['receive', 'return'] as const).map((a) => (
            <button
              key={a}
              onClick={() => setAction(a)}
              className={`px-5 py-2 text-sm font-medium transition-colors ${action === a ? 'bg-[#C0272D] text-white' : 'bg-white text-[#1a1a1a] hover:bg-gray-50'}`}
            >
              {a === 'receive' ? 'Receiving key' : 'Returning key'}
            </button>
          ))}
        </div>
      </div>

      {/* Person */}
      <div>
        <SectionLabel>{partyName}</SectionLabel>
        <div className="space-y-3">
          {roster.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Choose from roster <span className="text-gray-400 font-normal">— optional</span></label>
              <select className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={personId ?? ''} onChange={(e) => pickRoster(e.target.value)}>
                <option value="">— Select {partyName.toLowerCase()} —</option>
                {roster.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">{partyName} Name *</label>
            <input className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={name} onChange={(e) => { setName(e.target.value); setPersonId(null); }} placeholder="Full name" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Email <span className="text-gray-400 font-normal">— optional</span></label>
            <input className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@citywideboston.com" />
          </div>
        </div>
      </div>

      {/* Keys */}
      <div>
        <SectionLabel>Keys</SectionLabel>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Accounts / Sites <span className="text-gray-400 font-normal">— one per line</span></label>
            <textarea className="input h-20 resize-none focus:ring-[#C0272D] focus:border-[#C0272D]" value={accounts} onChange={(e) => setAccounts(e.target.value)} placeholder={'CUSTOMER SITE 0001 LLC\nDEMO MEDICAL CENTER'} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Key Details <span className="text-gray-400 font-normal">— counts / types / tag #s</span></label>
            <input className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={keyDetails} onChange={(e) => setKeyDetails(e.target.value)} placeholder="e.g. 2 metal, 1 fob (tag #A17)" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Notes <span className="text-gray-400 font-normal">— optional</span></label>
            <textarea className="input h-16 resize-none focus:ring-[#C0272D] focus:border-[#C0272D]" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
      </div>

      {/* Signature */}
      <div>
        <SectionLabel>Electronic Signature</SectionLabel>
        <SignaturePad ref={sigRef} />
      </div>

      {error && <p className="text-sm text-[#C0272D] bg-[#fbeaea] border border-[#f0c9cb] rounded px-3 py-2">{error}</p>}

      <div className="flex gap-2 pt-2 border-t border-gray-200">
        <button onClick={save} disabled={saving} className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] disabled:opacity-50 transition-colors">
          {saving ? 'Saving…' : 'Capture Signature'}
        </button>
        <button onClick={reset} className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:bg-gray-50 transition-colors">Clear</button>
      </div>
    </div>
  );
}

// ── Signature log ──────────────────────────────────────────
const PARTY_CHIPS = [
  { key: 'all', label: 'All' },
  { key: 'employee', label: 'Employees' },
  { key: 'contractor', label: 'Contractors' },
];
const ACTION_CHIPS = [
  { key: 'all', label: 'All' },
  { key: 'receive', label: 'Received' },
  { key: 'return', label: 'Returned' },
];

function SignatureLog({ reloadKey }: { reloadKey: number }) {
  const [forms, setForms] = useState<KeyForm[]>([]);
  const [loading, setLoading] = useState(true);
  const [party, setParty] = useState('all');
  const [action, setAction] = useState('all');
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ form: KeyFormFull; src: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getKeyForms();
      setForms(data.forms);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load, reloadKey]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return forms.filter((f) =>
      (party === 'all' || f.party_type === party) &&
      (action === 'all' || f.action === action) &&
      (!q || f.person_name.toLowerCase().includes(q) ||
        (f.collected_by || '').toLowerCase().includes(q) ||
        f.account_names.join(' ').toLowerCase().includes(q))
    );
  }, [forms, party, action, search]);

  // Downloads from the log fetch the full record (with the signature blob) first.
  const withFull = async (id: number, fn: (f: KeyFormFull) => Promise<void>) => {
    setBusyId(id);
    try {
      const { form } = await getKeyForm(id);
      await fn(form);
    } finally {
      setBusyId(null);
    }
  };
  const openPreview = async (id: number) => {
    setBusyId(id);
    try {
      const { form } = await getKeyForm(id);
      const canvas = await renderReceiptCanvas(form);
      setPreview({ form, src: canvas.toDataURL('image/png') });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex border-b border-cw-border gap-5">
          {PARTY_CHIPS.map((c) => (
            <button key={c.key} onClick={() => setParty(c.key)} className={`pb-2 text-sm font-medium border-b-2 -mb-px transition-colors ${party === c.key ? 'border-[#C0272D] text-[#C0272D]' : 'border-transparent text-[#6b6b68] hover:text-[#1a1a1a]'}`}>{c.label}</button>
          ))}
        </div>
        <div className="flex gap-2">
          {ACTION_CHIPS.map((c) => (
            <button key={c.key} onClick={() => setAction(c.key)} className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${action === c.key ? 'border-[#C0272D] bg-[#fbeaea] text-[#C0272D]' : 'border-cw-border text-[#6b6b68] hover:text-[#1a1a1a]'}`}>{c.label}</button>
          ))}
        </div>
        <div className="flex-1" />
        <input className="input max-w-xs focus:ring-[#C0272D] focus:border-[#C0272D]" placeholder="Search name, site, collector…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="card overflow-x-auto max-w-full">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-[#1a1a1a] text-white text-xs">
              <th className="text-left px-4 py-3 font-medium whitespace-nowrap">Signed</th>
              <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Type</th>
              <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Action</th>
              <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Name</th>
              <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Accounts / Sites</th>
              <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Collected by</th>
              <th className="text-right px-4 py-3 font-medium whitespace-nowrap">Document</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-cw-muted">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-cw-muted">No signatures collected yet</td></tr>
            ) : filtered.map((f, i) => (
              <tr key={f.id} className={`border-b border-gray-100 ${i % 2 === 0 ? 'bg-white' : 'bg-[#f4f4f2]'}`}>
                <td className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">{new Date(f.signed_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                <td className="px-3 py-3"><PartyBadge type={f.party_type} /></td>
                <td className="px-3 py-3 text-center"><ActionBadge action={f.action} /></td>
                <td className="px-3 py-3 font-medium text-[#1a1a1a] whitespace-nowrap">{f.person_name}</td>
                <td className="px-3 py-3 text-xs text-gray-700 max-w-[220px] truncate" title={f.account_names.join(', ')}>{f.account_names.length ? f.account_names.join(', ') : '—'}</td>
                <td className="px-3 py-3 text-xs text-gray-600 whitespace-nowrap">{f.collected_by || '—'}</td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <span className="inline-flex items-center gap-2">
                    <button disabled={busyId === f.id} onClick={() => openPreview(f.id)} className="text-xs text-[#C0272D] hover:underline disabled:opacity-40">View</button>
                    <DownloadButtons
                      disabled={busyId === f.id}
                      onPdf={() => withFull(f.id, downloadPdf)}
                      onJpg={() => withFull(f.id, downloadJpeg)}
                      onPng={() => withFull(f.id, downloadPng)}
                    />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {preview && (
        <Modal title={`${preview.form.person_name} — ${preview.form.party_type === 'contractor' ? 'Contractor' : 'Employee'} Key ${preview.form.action === 'return' ? 'Return' : 'Receipt'}`} onClose={() => setPreview(null)} width="max-w-2xl">
          <img src={preview.src} alt="Signed key form" className="w-full border border-cw-border rounded" />
          <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-gray-200">
            <DownloadButtons onPdf={() => downloadPdf(preview.form)} onJpg={() => downloadJpeg(preview.form)} onPng={() => downloadPng(preview.form)} />
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────
export default function Forms() {
  const [tab, setTab] = useState<Tab>('employee');
  const [reloadKey, setReloadKey] = useState(0);

  const tabs: { key: Tab; label: string }[] = [
    { key: 'employee', label: 'Employee Key Form' },
    { key: 'contractor', label: 'Contractor Key Form' },
    { key: 'log', label: 'Signature Log' },
  ];

  return (
    <Layout>
      <div className="p-6 max-w-full mx-auto space-y-4">
        <div>
          <h1 className="text-xl font-bold text-[#1a1a1a]">Key Sign-Off</h1>
          <p className="text-sm text-cw-muted">Capture in-person signatures when employees and contractors receive or return keys.</p>
        </div>

        <div className="flex border-b border-cw-border gap-6">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`pb-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === t.key ? 'border-[#C0272D] text-[#C0272D]' : 'border-transparent text-[#6b6b68] hover:text-[#1a1a1a]'}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'employee' && <KeyFormEntry partyType="employee" onSaved={() => setReloadKey((k) => k + 1)} />}
        {tab === 'contractor' && <KeyFormEntry partyType="contractor" onSaved={() => setReloadKey((k) => k + 1)} />}
        {tab === 'log' && <SignatureLog reloadKey={reloadKey} />}
      </div>
    </Layout>
  );
}
