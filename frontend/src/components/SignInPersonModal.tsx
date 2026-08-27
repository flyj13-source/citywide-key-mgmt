import { useRef, useState } from 'react';
import Modal from './Modal';
import SignaturePad, { type SignaturePadHandle } from './SignaturePad';
import { getManager } from '../lib/auth';
import { signInPerson, type Assignment, type MailOutcome } from '../lib/api';

// ── In-person (wet) signature ────────────────────────────────────────────────
// The fallback that makes every unsigned record recoverable: the same canvas as
// the emailed portal, opened directly in the app so a manager can capture a
// signature on a tablet at handover. The witness is recorded, because "they
// signed remotely" and "someone watched them sign" are different claims.
export default function SignInPersonModal({
  assignment, kind, onClose, onDone,
}: {
  assignment: Assignment;
  /** Which direction is being signed — a return is acknowledged, not received. */
  kind: 'checkout' | 'checkin';
  onClose: () => void;
  onDone: () => void;
}) {
  const me = getManager();
  const padRef = useRef<SignaturePadHandle>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ mail: MailOutcome; pdfError: string | null } | null>(null);

  const submit = async () => {
    const signature = padRef.current?.toDataURL();
    if (!signature) { setError('Ask them to sign in the box before submitting.'); return; }
    setSaving(true); setError('');
    try {
      const r = await signInPerson(assignment.id, signature, kind);
      setDone({ mail: r.email, pdfError: r.pdf_error });
      onDone();
    } catch (e: any) {
      setError(e?.message || 'Could not save the signature');
    } finally { setSaving(false); }
  };

  if (done) {
    return (
      <Modal title="Signature captured" onClose={onClose} width="max-w-lg">
        <div className="space-y-4">
          <p className="text-sm text-cw-text">
            <span className="font-semibold">{assignment.holder}</span> signed for{' '}
            {assignment.total_keys} key{assignment.total_keys === 1 ? '' : 's'} at{' '}
            <span className="font-semibold">{assignment.account_name}</span>, witnessed by {me?.name}.
          </p>
          {done.pdfError ? (
            <div className="text-sm bg-[#fff8e6] border border-[#e8cf8a] text-[#7a5a00] rounded px-3 py-2">
              ⚠ The signature is saved, but the PDF receipt failed to generate ({done.pdfError}).
            </div>
          ) : done.mail.ok ? (
            <div className="text-sm bg-green-50 border border-green-200 text-green-800 rounded px-3 py-2">
              ✓ Signed receipt sent to {done.mail.recipients.join(', ')}
            </div>
          ) : (
            <div className="text-sm bg-[#fff8e6] border border-[#e8cf8a] text-[#7a5a00] rounded px-3 py-2">
              ⚠ The signature is saved and the record is now Signed, but the receipt email did not send
              {done.mail.error ? `: ${done.mail.error}` : '.'} The PDF is downloadable from the registry.
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
    <Modal title={kind === 'checkin' ? 'Sign for return, in person' : 'Sign in person'} onClose={onClose} width="max-w-lg">
      <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
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

        {assignment.signature_status === 'signature_unavailable' && (
          <p className="text-xs text-[#7a5a00] bg-[#fff8e6] border border-[#e8cf8a] rounded px-3 py-2">
            This record has no email on file{assignment.no_email_reason ? ` (${assignment.no_email_reason})` : ''}.
            Capturing a signature here resolves it.
          </p>
        )}

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
          The signed PDF goes to {assignment.holder_email ? `${assignment.holder_email}, ` : ''}Cara
          {assignment.counterparty_name ? `, and ${assignment.counterparty_name}` : ''}.
        </p>

        {error && <p className="text-sm text-[#C0272D] bg-[#fbeaea] border border-[#f0c9cb] rounded px-3 py-2">{error}</p>}
      </div>

      <div className="flex gap-2 pt-4 border-t border-gray-200 mt-4">
        <button
          onClick={submit}
          disabled={saving || !acknowledged}
          className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? 'Saving signature…' : 'Capture signature'}
        </button>
        <button onClick={onClose} className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:bg-gray-50 transition-colors">Cancel</button>
      </div>
    </Modal>
  );
}
