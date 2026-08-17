import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import SignaturePad, { type SignaturePadHandle } from '../components/SignaturePad';
import { CWLogoSidebar } from '../components/CWLogo';
import { getSignoffByToken, submitSignoff, type KeyLine } from '../lib/api';

// ── Public key check-out sign-off ────────────────────────────────────────────
// Reached from the tokenized link in the check-out email (48h TTL, no login).
// Applies to City Wide employees AND independent contractors alike.

interface SignoffView {
  id: number;
  holder: string;
  holder_type: 'employee' | 'ic';
  client: string;
  keys: KeyLine[];
  total_keys: number;
  checked_out_at: string;
  due_at: string | null;
  recorded_by: string | null;
  signed_at: string | null;
}

const hasZone = (s: string) => /[Tt]/.test(s) || /[Zz]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s);

const fmt = (iso: string | null): string => {
  if (!iso) return '—';
  const d = new Date(hasZone(iso) ? iso : `${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};

// A bare due date has no time — read it at midday UTC so it never slips a day.
const fmtDay = (iso: string | null): string => {
  if (!iso) return 'No due date';
  const d = new Date(hasZone(iso) ? iso : `${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-cw-bg">
      <div className="bg-cw-black px-6 py-4 flex items-center justify-between">
        <div className="bg-white rounded-md px-3 py-2">
          <CWLogoSidebar className="w-28 h-auto" />
        </div>
        <div className="text-right">
          <div className="text-white font-bold text-sm">City Wide Building Services</div>
          <div className="text-gray-400 text-[10px] tracking-widest uppercase">Boston · Key Management</div>
        </div>
      </div>
      <div className="h-1 bg-cw-red" />
      <div className="max-w-2xl mx-auto p-6 space-y-6">{children}</div>
    </div>
  );
}

export default function KeySignoff() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<SignoffView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [acknowledged, setAcknowledged] = useState(false);
  const [signing, setSigning] = useState(false);
  const [signed, setSigned] = useState(false);
  const [pdfNote, setPdfNote] = useState<string | null>(null);
  const padRef = useRef<SignaturePadHandle>(null);

  useEffect(() => {
    if (!token) return;
    getSignoffByToken(token)
      .then((d: any) => {
        if (d?.error) setError(d.error);
        else { setData(d); if (d.signed_at) setSigned(true); }
      })
      .catch(() => setError('Could not load this key receipt.'))
      .finally(() => setLoading(false));
  }, [token]);

  const submit = async () => {
    const signature = padRef.current?.toDataURL();
    if (!signature) { setError('Please sign in the box before submitting.'); return; }
    setSigning(true); setError('');
    try {
      const r: any = await submitSignoff(token!, signature);
      if (r?.success) {
        setSigned(true);
        if (r.pdf_error) setPdfNote(`Your signature was recorded, but the PDF receipt could not be generated (${r.pdf_error}). City Wide has been notified.`);
      } else {
        setError(r?.error || 'Signing failed. Please try again.');
      }
    } catch (e: any) {
      setError(e?.message || 'Signing failed. Please try again.');
    } finally {
      setSigning(false);
    }
  };

  if (loading) {
    return <Shell><div className="text-cw-muted text-sm">Loading…</div></Shell>;
  }

  if (error && !data) {
    return (
      <Shell>
        <div className="bg-white border border-red-200 rounded-lg p-6 text-center">
          <div className="text-[#C0272D] text-lg font-semibold mb-2">Link Error</div>
          <div className="text-cw-muted text-sm">{error}</div>
          <p className="text-xs text-cw-muted mt-3">Contact City Wide Boston to request a new link.</p>
        </div>
      </Shell>
    );
  }

  if (signed) {
    return (
      <Shell>
        <div className="bg-white border border-green-200 rounded-lg p-8 text-center">
          <div className="text-green-600 text-4xl mb-3">✓</div>
          <div className="text-xl font-bold text-cw-text mb-2">Receipt acknowledged</div>
          <p className="text-sm text-cw-muted">
            Thank you, {data?.holder}. Your signed receipt for <strong>{data?.client}</strong> has been stored securely
            with City Wide Boston.
          </p>
          {pdfNote && (
            <p className="text-xs text-[#7a5a00] bg-[#fff8e6] border border-[#e8cf8a] rounded px-3 py-2 mt-4">{pdfNote}</p>
          )}
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="bg-white border border-cw-border rounded-lg p-6">
        <h1 className="text-xl font-bold mb-1">Key Receipt Acknowledgement</h1>
        <p className="text-sm text-cw-muted">
          Hello <strong>{data?.holder}</strong>, please review the keys below and sign to confirm you received them.
        </p>
      </div>

      <div className="bg-white border border-cw-border rounded-lg overflow-hidden">
        <div className="px-5 py-3 bg-cw-black">
          <h2 className="text-white font-semibold text-sm">Check-out details</h2>
        </div>
        <dl className="px-5 py-4 text-sm grid grid-cols-[130px_1fr] gap-y-2">
          <dt className="text-cw-muted">Client</dt><dd className="font-medium">{data?.client}</dd>
          <dt className="text-cw-muted">Holder</dt>
          <dd className="font-medium">{data?.holder} <span className="text-cw-muted font-normal">({data?.holder_type === 'ic' ? 'Independent Contractor' : 'City Wide Employee'})</span></dd>
          <dt className="text-cw-muted">Checked out</dt><dd className="font-medium">{fmt(data?.checked_out_at ?? null)}</dd>
          <dt className="text-cw-muted">Due back</dt><dd className="font-medium">{fmtDay(data?.due_at ?? null)}</dd>
          {data?.recorded_by && (<><dt className="text-cw-muted">Recorded by</dt><dd className="font-medium">{data.recorded_by}</dd></>)}
        </dl>
        <table className="w-full text-sm border-t border-cw-border">
          <thead>
            <tr className="bg-[#f4f4f2] text-xs uppercase tracking-wide text-cw-muted">
              <th className="text-left px-5 py-2 font-semibold">Key type</th>
              <th className="text-right px-5 py-2 font-semibold">Qty</th>
            </tr>
          </thead>
          <tbody>
            {data?.keys.map((k) => (
              <tr key={k.type} className="border-t border-gray-100">
                <td className="px-5 py-2.5">{k.label}</td>
                <td className="px-5 py-2.5 text-right font-semibold">{k.qty}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-cw-red bg-[#f4f4f2]">
              <td className="px-5 py-2.5 font-bold">Total</td>
              <td className="px-5 py-2.5 text-right font-bold text-cw-red">{data?.total_keys}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="bg-white border border-cw-border rounded-lg p-5 space-y-4">
        <label className="flex items-start gap-3 text-sm cursor-pointer">
          <input
            type="checkbox"
            className="h-4 w-4 mt-0.5 accent-[#C0272D]"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span className="text-cw-text font-medium">I acknowledge receipt of these keys</span>
        </label>
        <ul className="list-disc list-inside space-y-1 text-xs text-cw-muted pl-7">
          <li>I will safeguard all keys and access credentials</li>
          <li>I will not duplicate or share keys with unauthorized personnel</li>
          <li>I will return all keys immediately upon request or at the end of my assignment</li>
          <li>I will report any lost or stolen keys to City Wide Boston within 24 hours</li>
        </ul>
      </div>

      <div className="bg-white border border-cw-border rounded-lg p-5">
        <h2 className="font-semibold text-sm mb-3">Electronic signature</h2>
        <SignaturePad ref={padRef} />
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded px-4 py-3 text-sm text-red-700">{error}</div>}

      <button
        onClick={submit}
        disabled={signing || !acknowledged}
        className="w-full py-3 text-base bg-[#C0272D] text-white font-medium rounded hover:bg-[#a82227] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {signing ? 'Generating signed receipt…' : 'Submit signature & acknowledge receipt'}
      </button>

      <p className="text-center text-xs text-cw-muted">
        City Wide Building Services · Boston, MA<br />
        This link expires 48 hours after it was issued.
      </p>
    </Shell>
  );
}
