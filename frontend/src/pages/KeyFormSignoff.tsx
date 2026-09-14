// ── Public Key Form acknowledgement ──────────────────────────────────────────
// Opened from a 48h tokenized link. No login. The signer sees every client they
// hold keys at and confirms the whole statement in one signature.

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import SignaturePad, { type SignaturePadHandle } from '../components/SignaturePad';
import { CWLogoSidebar } from '../components/CWLogo';
import { getKeyFormDocByToken, signKeyFormDoc } from '../lib/api';

const fmt = (iso: string | null): string => {
  if (!iso) return '—';
  const d = new Date(/[Tt]|[Zz]$/.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
};

const COLS = [
  { key: 'metal', label: 'Metal' }, { key: 'card', label: 'Card' },
  { key: 'fob', label: 'Fob' }, { key: 'dispenser', label: 'Dispenser' },
  { key: 'office', label: 'Office' },
] as const;

export default function KeyFormSignoff() {
  const { token = '' } = useParams();
  const [data, setData] = useState<any>(null);
  const [loadError, setLoadError] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [typedName, setTypedName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<any>(null);
  const sigRef = useRef<SignaturePadHandle>(null);

  useEffect(() => {
    getKeyFormDocByToken(token)
      .then((d) => (d?.error ? setLoadError(d.error) : setData(d)))
      .catch(() => setLoadError('Could not load this form.'));
  }, [token]);

  const submit = async () => {
    setError('');
    if (!sigRef.current || sigRef.current.isEmpty()) { setError('Please sign in the box above.'); return; }
    if (!typedName.trim()) { setError('Please type your full name to confirm.'); return; }
    setSaving(true);
    try {
      const dataUrl = sigRef.current.toDataURL();
      if (!dataUrl) { setError('Please sign in the box above.'); return; }
      const r = await signKeyFormDoc(token, dataUrl, typedName.trim());
      if (r?.error) setError(r.error); else setDone(r);
    } catch { setError('Could not submit the signature.'); }
    finally { setSaving(false); }
  };

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen bg-cw-bg py-8 px-4">
      <div className="max-w-3xl mx-auto space-y-5">
        <div className="bg-white rounded-lg p-4 flex items-center justify-center">
          <CWLogoSidebar className="w-40 h-auto" />
        </div>
        {children}
      </div>
    </div>
  );

  if (loadError) return shell(
    <div className="bg-white border border-[#C0272D] rounded-lg p-6 text-center">
      <div className="text-3xl mb-2">⚠</div>
      <p className="text-sm text-[#C0272D]">{loadError}</p>
    </div>
  );
  if (!data) return shell(<div className="text-center text-sm text-cw-muted py-10">Loading…</div>);

  if (done) return shell(
    <div className="bg-white border border-cw-border rounded-lg p-6 text-center space-y-2">
      <div className="text-3xl">✓</div>
      <h1 className="text-lg font-bold">Key Form acknowledged</h1>
      <p className="text-sm text-cw-muted">
        Thank you, {data.holder}. {done.form_no} has been stored securely with City Wide Boston,
        and a signed copy has been emailed to you.
      </p>
    </div>
  );

  const sum = (rows: any[]) => rows.reduce((n: number, c: any) => n + c.subtotal, 0);
  const held: any[] = data.clients ?? [];
  // A check-in link is a RETURN RECEIPT: what came back is the subject, and
  // the remaining position is context. Anything else states a position.
  const isReturn = data.doc_kind === 'return_receipt';
  const returned: any[] = data.returned ?? [];

  /** One titled table. `emptyText` is what it says when it has no rows. */
  const table = (
    heading: string, rows: any[], totalLabel: string, emptyText: string, accent: boolean,
  ) => (
    <div className="bg-white border border-cw-border rounded-lg overflow-hidden">
      <div className={`px-5 py-3 flex items-center justify-between ${accent ? 'bg-cw-black' : 'bg-[#4a4a48]'}`}>
        <h2 className="text-white font-semibold text-sm">{heading}</h2>
        <span className="text-white/60 text-xs">
          {data.holder_role} · generated {fmt(data.generated_at)}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#f4f4f2] text-xs uppercase tracking-wide text-cw-muted">
              <th className="text-left px-4 py-2 font-semibold">Client</th>
              <th className="text-left px-3 py-2 font-semibold">BC #</th>
              {COLS.map((c) => <th key={c.key} className="text-center px-2 py-2 font-semibold">{c.label}</th>)}
              <th className="text-center px-3 py-2 font-semibold">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-6 text-center text-cw-muted">{emptyText}</td></tr>
            )}
            {rows.map((c: any, i: number) => (
              <tr key={i} className="border-t border-gray-100">
                <td className="px-4 py-2.5 font-medium">{c.client}</td>
                <td className="px-3 py-2.5 font-mono text-xs text-gray-600">{c.bc_client_number || '—'}</td>
                {COLS.map((col) => (
                  <td key={col.key} className="px-2 py-2.5 text-center">
                    {c[col.key] || <span className="text-gray-300">—</span>}
                  </td>
                ))}
                <td className="px-3 py-2.5 text-center font-bold">{c.subtotal}</td>
              </tr>
            ))}
            <tr className={`border-t-2 bg-[#f4f4f2] ${accent ? 'border-cw-red' : 'border-gray-300'}`}>
              <td colSpan={7} className="px-4 py-2.5 font-bold">{totalLabel}</td>
              <td className={`px-3 py-2.5 text-center font-bold ${accent ? 'text-cw-red' : 'text-cw-text'}`}>
                {sum(rows)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );

  return shell(
    <>
      <div className="bg-white border border-cw-border rounded-lg p-6">
        <h1 className="text-xl font-bold mb-1">
          {isReturn ? 'Key Return Receipt' : 'Key Form'} {data.form_no}
        </h1>
        <p className="text-sm text-cw-muted">
          {isReturn ? (
            <>Hello <strong>{data.holder}</strong>, please confirm you have returned the keys
            listed below to City Wide Boston.</>
          ) : (
            <>Hello <strong>{data.holder}</strong>, please confirm the keys below are the ones you
            currently hold for City Wide Boston.</>
          )}
        </p>
        <p className="mt-3 text-sm font-semibold text-[#C0272D]">
          {isReturn
            ? 'You are signing for the return below. Anything still on record is shown underneath.'
            : 'This is a statement of everything on record in your name.'}
        </p>
      </div>

      {isReturn ? (
        <>
          {table('Keys returned', returned, 'Total keys returned',
            'No keys were recorded on this return.', true)}
          {/* Empty here is a normal outcome — they returned everything. */}
          {table('Remaining keys on record', held, 'Total still held',
            'No keys remain on record in your name.', false)}
        </>
      ) : (
        table('Keys held', held, 'Total keys held',
          'No keys are currently on record in your name.', true)
      )}

      <div className="bg-white border border-cw-border rounded-lg p-5 space-y-4">
        <label className="flex items-start gap-3 text-sm cursor-pointer">
          <input
            type="checkbox"
            className="h-4 w-4 mt-0.5 accent-[#C0272D]"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>
            {isReturn ? (
              <>
                <strong>
                  I confirm I have returned the keys listed above to City Wide Boston
                  on {fmt(data.generated_at).split(',').slice(0, 2).join(',')}.
                </strong>
                <span className="block text-xs text-cw-muted mt-1">
                  Any keys still shown on record above remain in my possession under the same
                  terms · I will safeguard them · I will not duplicate or share them with
                  unauthorized personnel · I will return them upon request or at the end of my
                  assignment · I will report any loss within 24 hours.
                </span>
              </>
            ) : (
              <>
                <strong>I confirm I currently hold these keys.</strong>
                <span className="block text-xs text-cw-muted mt-1">
                  I will safeguard all keys and access credentials · I will not duplicate or share keys
                  with unauthorized personnel · I will return all keys immediately upon request or at the
                  end of my assignment · I will report any lost or stolen keys within 24 hours.
                </span>
              </>
            )}
          </span>
        </label>

        <div>
          <div className="text-xs font-medium text-gray-600 mb-1">Electronic signature</div>
          <SignaturePad ref={sigRef} />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Type your full name to confirm
            <span className="block text-[11px] text-gray-400 font-normal">
              Must match the holder on this form: {data.holder}
            </span>
          </label>
          <input
            className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
            placeholder={data.holder}
          />
        </div>

        {error && (
          <div className="rounded border border-[#C0272D] bg-[#fbeaea] px-3 py-2 text-sm text-[#C0272D]">{error}</div>
        )}

        <button
          onClick={submit}
          disabled={!acknowledged || saving}
          className="w-full px-4 py-3 bg-[#C0272D] text-white font-medium rounded hover:bg-[#a82227] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? 'Submitting…' : 'Submit signature & confirm'}
        </button>
      </div>
    </>
  );
}
