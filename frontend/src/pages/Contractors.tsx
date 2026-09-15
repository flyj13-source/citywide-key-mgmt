import { useEffect, useRef, useState } from 'react';
import Layout from '../components/Layout';
import Badge from '../components/Badge';
import Modal from '../components/Modal';
import { getContractors, inviteContractor, getAccounts, icLookup, type IcMatch } from '../lib/api';

export default function Contractors() {
  const [contractors, setContractors] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [showInvite, setShowInvite] = useState(false);
  const [form, setForm] = useState({
    name: '', email: '', bc_vendor_number: '', assigned_accounts: [] as string[],
  });
  const [accSearch, setAccSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [lastLink, setLastLink] = useState('');
  // Which IC record the fields were filled from, and the shortlist when a name
  // matched more than one. `null` means nothing has been matched.
  const [matched, setMatched] = useState<IcMatch | null>(null);
  const [nameMatches, setNameMatches] = useState<IcMatch[]>([]);
  // Suppresses the name lookup for one render after an autofill, so filling the
  // name from a match does not immediately re-search for that same name.
  const skipNameLookup = useRef(false);
  const vendorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Take an IC record into the form. Blank fields on the record never clobber
   *  something already typed — the lookup is a shortcut, not an overwrite. */
  const applyMatch = (m: IcMatch) => {
    skipNameLookup.current = true;
    setForm((f) => ({
      ...f,
      name: m.name || f.name,
      email: m.email || f.email,
      bc_vendor_number: m.bc_vendor_number || f.bc_vendor_number,
    }));
    setMatched(m);
    setNameMatches([]);
  };

  // ── Vendor number → IC record (exact, at most one) ───────────────────────
  useEffect(() => {
    const v = form.bc_vendor_number.trim();
    if (vendorTimer.current) clearTimeout(vendorTimer.current);
    if (!v) { setMatched(null); return; }
    vendorTimer.current = setTimeout(() => {
      icLookup('vendor', v)
        .then((r) => {
          const hit = r.matches[0];
          if (hit) applyMatch(hit);
          else setMatched(null);
        })
        .catch(() => setMatched(null));
    }, 300);
    return () => { if (vendorTimer.current) clearTimeout(vendorTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.bc_vendor_number]);

  // ── Name → IC records (several; the caller disambiguates) ────────────────
  useEffect(() => {
    if (skipNameLookup.current) { skipNameLookup.current = false; return; }
    const n = form.name.trim();
    if (nameTimer.current) clearTimeout(nameTimer.current);
    // Two characters is noise; it would match most of the registry.
    if (n.length < 3) { setNameMatches([]); return; }
    nameTimer.current = setTimeout(() => {
      icLookup('name', n)
        .then((r) => {
          if (r.matches.length === 1) applyMatch(r.matches[0]);
          else setNameMatches(r.matches);
        })
        .catch(() => setNameMatches([]));
    }, 300);
    return () => { if (nameTimer.current) clearTimeout(nameTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.name]);

  const resetForm = () => {
    setForm({ name: '', email: '', bc_vendor_number: '', assigned_accounts: [] });
    setMatched(null);
    setNameMatches([]);
  };

  useEffect(() => {
    getContractors().then(setContractors);
    getAccounts({ limit: '300' }).then((d) => setAccounts(d.accounts));
  }, []);

  const handleInvite = async () => {
    setSaving(true);
    try {
      const r = await inviteContractor(form);
      setLastLink(r.magic_link);
      getContractors().then(setContractors);
      resetForm();
      setShowInvite(false);
    } finally {
      setSaving(false);
    }
  };

  const toggleAccount = (name: string) => {
    setForm((f) => ({
      ...f,
      assigned_accounts: f.assigned_accounts.includes(name)
        ? f.assigned_accounts.filter((a) => a !== name)
        : [...f.assigned_accounts, name],
    }));
  };

  // `ic_company_name`, not `name`: the latter is the legacy column and is null
  // on every record created since the rename, so this list rendered blank rows
  // and the search threw on undefined.
  const accName = (a: any): string => a.ic_company_name ?? a.name ?? '';
  const filteredAccounts = accSearch
    ? accounts.filter((a) => accName(a).toLowerCase().includes(accSearch.toLowerCase()))
    : accounts;

  return (
    <Layout>
      <div className="p-6 max-w-5xl mx-auto space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">Contractor Portal</h1>
            <p className="text-sm text-cw-muted">Magic link e-signature system · PDF receipt generated on sign</p>
          </div>
          <button onClick={() => setShowInvite(true)} className="btn-primary">+ Invite Contractor</button>
        </div>

        {lastLink && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="text-sm font-medium text-blue-800 mb-1">Magic link generated</div>
            <div className="font-mono text-xs text-blue-700 break-all mb-2">{lastLink}</div>
            <div className="flex gap-2">
              <button onClick={() => { navigator.clipboard.writeText(lastLink); }} className="text-xs text-blue-700 hover:underline">Copy link</button>
              <button onClick={() => setLastLink('')} className="text-xs text-blue-500 hover:underline">Dismiss</button>
            </div>
          </div>
        )}

        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-cw-black text-white text-xs">
                <th className="text-left px-4 py-3 font-medium">Contractor</th>
                <th className="text-left px-4 py-3 font-medium">BC Vendor #</th>
                <th className="text-left px-4 py-3 font-medium">Email</th>
                <th className="text-center px-4 py-3 font-medium">Status</th>
                <th className="text-left px-4 py-3 font-medium">Accounts</th>
                <th className="text-left px-4 py-3 font-medium">Signed At</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cw-border">
              {contractors.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-cw-muted">No contractors yet</td></tr>
              ) : contractors.map((c) => {
                const accounts = JSON.parse(c.assigned_accounts || '[]');
                return (
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">{c.name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-cw-muted">
                      {c.bc_vendor_number || <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-cw-muted text-xs">{c.email}</td>
                    <td className="px-4 py-3 text-center">
                      <Badge variant={c.status === 'signed' ? 'green' : c.status === 'expired' ? 'red' : 'yellow'}>
                        {c.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-xs text-cw-muted">{accounts.length} accounts</td>
                    <td className="px-4 py-3 text-xs text-cw-muted">
                      {c.signed_at ? new Date(c.signed_at).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        {c.status === 'signed' && (
                          <a
                            href={`/api/contractors/${c.id}/pdf`}
                            className="text-xs text-cw-red hover:underline"
                            target="_blank"
                            rel="noreferrer"
                          >PDF</a>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {showInvite && (
        <Modal title="Invite Contractor" onClose={() => { setShowInvite(false); resetForm(); }} width="max-w-xl">
          <div className="space-y-4">
            <div className="relative">
              <label className="block text-xs font-medium text-cw-muted mb-1">Contractor Name</label>
              <input
                className="input"
                value={form.name}
                onChange={(e) => { setForm({ ...form, name: e.target.value }); setMatched(null); }}
                autoComplete="off"
              />
              {/* More than one IC matched the name — pick, rather than guess. */}
              {nameMatches.length > 1 && (
                <div className="absolute z-20 left-0 right-0 mt-1 bg-white border border-cw-border rounded shadow-lg max-h-52 overflow-y-auto">
                  <div className="px-3 py-1.5 text-[11px] text-cw-muted bg-[#f4f4f2] border-b border-cw-border">
                    {nameMatches.length} matching IC records
                  </div>
                  {nameMatches.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => applyMatch(m)}
                      className="w-full text-left px-3 py-2 hover:bg-gray-50 border-b border-gray-100 last:border-0"
                    >
                      <div className="text-sm font-medium text-[#1a1a1a]">{m.company}</div>
                      <div className="text-xs text-cw-muted">
                        {m.contact ? `${m.contact} · ` : ''}
                        {m.bc_vendor_number ?? 'no vendor #'}
                        {m.email ? ` · ${m.email}` : ' · no email'}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-cw-muted mb-1">
                BC Vendor Number
                <span className="ml-1 font-normal text-gray-400">— optional</span>
              </label>
              <input
                className="input font-mono"
                placeholder="e.g. 02014100020"
                value={form.bc_vendor_number}
                onChange={(e) => setForm({ ...form, bc_vendor_number: e.target.value })}
                autoComplete="off"
              />
              {matched && (
                <div className="mt-1.5 flex items-start gap-1.5 text-xs text-[#2d7a3a]">
                  <span className="font-bold leading-4">✓</span>
                  <span>
                    <span className="font-medium">Matched IC record</span>
                    <span className="block text-[#4a7a52]">
                      {matched.company}
                      {matched.bc_vendor_number ? ` · ${matched.bc_vendor_number}` : ''}
                    </span>
                  </span>
                </div>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-cw-muted mb-1">Email</label>
              <input type="email" className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-cw-muted mb-2">Assign Accounts ({form.assigned_accounts.length} selected)</label>
              <input
                className="input mb-2"
                placeholder="Search accounts…"
                value={accSearch}
                onChange={(e) => setAccSearch(e.target.value)}
              />
              <div className="max-h-48 overflow-y-auto border border-cw-border rounded divide-y divide-cw-border">
                {filteredAccounts.slice(0, 50).map((a) => (
                  <label key={a.id} className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer text-sm">
                    <input
                      type="checkbox"
                      checked={form.assigned_accounts.includes(accName(a))}
                      onChange={() => toggleAccount(accName(a))}
                    />
                    {accName(a)}
                  </label>
                ))}
              </div>
            </div>
            {form.assigned_accounts.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {form.assigned_accounts.map((name) => (
                  <span key={name} className="badge-gray text-xs">
                    {name}
                    <button onClick={() => toggleAccount(name)} className="ml-1 text-cw-muted hover:text-cw-text">×</button>
                  </span>
                ))}
              </div>
            )}
            <p className="text-xs text-cw-muted">A magic link (48hr TTL) will be generated. The contractor signs via canvas on their device and a PDF is created with their signature and SHA-256 hash.</p>
            <div className="flex gap-2">
              <button onClick={handleInvite} disabled={saving || !form.name || !form.email} className="btn-primary">
                {saving ? 'Generating link…' : 'Send Invitation'}
              </button>
              <button onClick={() => { setShowInvite(false); resetForm(); }} className="btn-secondary">Cancel</button>
            </div>
          </div>
        </Modal>
      )}
    </Layout>
  );
}
