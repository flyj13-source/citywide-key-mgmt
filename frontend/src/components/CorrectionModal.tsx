import { useState } from 'react';
import Modal from './Modal';
import { CORRECTION_MIN_REASON } from '../lib/api';

// ── Correction modal ─────────────────────────────────────────────────────────
// One component for both corrections, because the shape of the decision is the
// same — say what you are doing and why — but the WORDS are deliberately not
// shared. Voiding says the record should not exist; acknowledging says it
// should, and only the signature is missing. Blurring those two is the whole
// risk of this feature, so the copy keeps them apart.

export type CorrectionAction = 'void' | 'acknowledge';

const COPY: Record<CorrectionAction, {
  title: string;
  lead: string;
  detail: string;
  confirm: string;
  placeholder: string;
  examples: string[];
}> = {
  void: {
    title: 'Void record',
    lead: 'This record should not exist.',
    detail:
      'It leaves active custody, overdue and the holder’s key totals, and any signature link '
      + 'stops working immediately. Nothing is deleted — it stays in the audit log and under the '
      + 'Voided filter with your name and reason on it.',
    confirm: 'Void record',
    placeholder: 'Why should this record not exist?',
    examples: ['entered in error', 'wrong holder selected', 'duplicate of another record'],
  },
  acknowledge: {
    title: 'Mark acknowledged without signature',
    lead: 'The record is correct — the signature is not coming.',
    detail:
      'The keys stay checked out and still count. Only the signature is settled: reminders stop, '
      + 'the link is retired, and the record shows as Acknowledged — never as Signed. The audit '
      + 'trail will say plainly that no signature was collected.',
    confirm: 'Mark acknowledged',
    placeholder: 'Why will no signature be collected?',
    examples: [
      'holder left the company',
      'contractor will not sign, keys confirmed by phone',
      'paper copy signed and filed',
    ],
  },
};

export default function CorrectionModal({
  action, target, count, sample, onClose, onConfirm, offerNotice = false,
}: {
  action: CorrectionAction;
  /** "record" / "form" — used in the count line. */
  target: string;
  /** How many records this applies to. 1 for a single row. */
  count: number;
  /** Up to five names, listed so a bulk action is never blind. */
  sample?: string[];
  onClose: () => void;
  onConfirm: (reason: string, notifyHolder: boolean) => Promise<void>;
  /** Void only: offer to tell the holder the request is withdrawn. */
  offerNotice?: boolean;
}) {
  const c = COPY[action];
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const trimmed = reason.trim();
  const short = trimmed.length > 0 && trimmed.length < CORRECTION_MIN_REASON;
  const ready = trimmed.length >= CORRECTION_MIN_REASON;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true); setError('');
    try {
      await onConfirm(trimmed, notify);
    } catch (e: any) {
      setError(e?.message || 'Could not apply the correction');
      setBusy(false);
    }
  };

  return (
    <Modal title={c.title} onClose={onClose} width="max-w-lg">
      <div className="space-y-4">
        <div className={`rounded border-2 px-4 py-3 ${
          action === 'void'
            ? 'border-[#C0272D] bg-[#fbeaea]'
            : 'border-[#e8cf8a] bg-[#fff8e6]'
        }`}>
          <div className={`text-sm font-semibold ${action === 'void' ? 'text-[#C0272D]' : 'text-[#7a5a00]'}`}>
            {c.lead}
          </div>
          <p className="text-sm text-[#1a1a1a] mt-1">{c.detail}</p>
        </div>

        {/* A bulk action is never blind: the count and the first five names. */}
        {count > 1 && (
          <div className="rounded border border-cw-border bg-[#f4f4f2] px-3 py-2 text-sm">
            <div className="font-semibold text-[#1a1a1a]">
              {count} {target}{count === 1 ? '' : 's'} selected
            </div>
            {sample && sample.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-xs text-cw-muted">
                {sample.slice(0, 5).map((s, i) => <li key={`${s}-${i}`}>· {s}</li>)}
                {count > sample.slice(0, 5).length && (
                  <li className="text-gray-400">…and {count - sample.slice(0, 5).length} more</li>
                )}
              </ul>
            )}
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-cw-text mb-1">
            Reason <span className="text-cw-muted font-normal">— this becomes the audit record</span>
          </label>
          <textarea
            className="input h-20 resize-none focus:ring-[#C0272D] focus:border-[#C0272D]"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={c.placeholder}
            autoFocus
          />
          <div className="flex flex-wrap items-center gap-2 mt-1.5">
            <span className="text-[11px] text-gray-400">e.g.</span>
            {c.examples.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => setReason(ex)}
                className="text-[11px] px-2 py-0.5 rounded-full border border-cw-border text-cw-muted hover:border-[#1a1a1a] hover:text-[#1a1a1a] transition-colors"
              >
                {ex}
              </button>
            ))}
          </div>
          {short && (
            <p className="text-[11px] text-[#C0272D] mt-1">
              {CORRECTION_MIN_REASON - trimmed.length} more character
              {CORRECTION_MIN_REASON - trimmed.length === 1 ? '' : 's'} — it has to mean something to
              whoever reads it later.
            </p>
          )}
        </div>

        {offerNotice && action === 'void' && (
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              className="h-4 w-4 mt-0.5 accent-[#C0272D]"
              checked={notify}
              onChange={(e) => setNotify(e.target.checked)}
            />
            <span className="text-cw-text">
              Email the holder that the signature is no longer required
              <span className="block text-[11px] text-gray-400">
                Optional. Says the record was withdrawn — never that keys came back.
              </span>
            </span>
          </label>
        )}

        {error && (
          <p className="text-sm text-[#C0272D] bg-[#fbeaea] border border-[#f0c9cb] rounded px-3 py-2">{error}</p>
        )}
      </div>

      <div className="flex items-center gap-2 pt-4 border-t border-gray-200 mt-4">
        <button
          onClick={submit}
          disabled={!ready || busy}
          className={`px-4 py-2 text-white text-sm font-medium rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${
            action === 'void' ? 'bg-[#C0272D] hover:bg-[#a82227]' : 'bg-[#1a1a1a] hover:bg-black'
          }`}
        >
          {busy ? 'Applying…' : count > 1 ? `${c.confirm} (${count})` : c.confirm}
        </button>
        <button
          onClick={onClose}
          disabled={busy}
          className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:bg-gray-50 transition-colors"
        >
          Cancel
        </button>
        <span className="text-[11px] text-gray-400 ml-auto">Nothing is deleted.</span>
      </div>
    </Modal>
  );
}
