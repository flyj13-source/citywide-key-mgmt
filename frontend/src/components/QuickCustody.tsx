// ── One-click custody ────────────────────────────────────────────────────────
// The standard case, standing at a handover: this client's keys, to the
// contractor already assigned to it, due on the usual window, signed on the
// spot. Every one of those is a default the system already knows, so the
// button executes them rather than opening a form to have them re-entered.
//
// Anything non-standard — a different holder, a subset of keys, a note — goes
// through "More options…", which is the full form with the same defaults
// already filled in. Nothing is removed, only pre-answered.

import { useEffect, useState } from 'react';
import Modal from './Modal';
import { ActionButton } from './ActionRow';
import { SignNowStep } from './CustodyModals';
import { IconCheckOut, IconCheckIn } from './Icons';
import {
  getCheckoutContext, getCheckinContext, checkout, checkin, resendSignoff,
  type CheckoutContext, type CheckinContext, type Assignment, type MailOutcome,
} from '../lib/api';

/** Long client and vendor names would blow the row width open. */
const short = (s: string, n = 22) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function useCustodyContext(account: { id: number; name: string } | null) {
  const [checkoutCtx, setCheckoutCtx] = useState<CheckoutContext | null>(null);
  const [checkinCtx, setCheckinCtx] = useState<CheckinContext | null>(null);

  useEffect(() => {
    if (!account) { setCheckoutCtx(null); setCheckinCtx(null); return; }
    let cancelled = false;
    getCheckoutContext(account.id)
      .then((c) => { if (!cancelled) setCheckoutCtx(c); })
      .catch(() => { if (!cancelled) setCheckoutCtx(null); });
    getCheckinContext(account.id)
      .then((c) => { if (!cancelled) setCheckinCtx(c); })
      .catch(() => { if (!cancelled) setCheckinCtx(null); });
    return () => { cancelled = true; };
  }, [account?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return { checkoutCtx, checkinCtx };
}

type Pending =
  | { kind: 'checkout' | 'checkin'; assignment: Assignment }
  | null;

export function QuickCustodyButtons({
  checkoutCtx, checkinCtx, onDone, onError,
}: {
  checkoutCtx: CheckoutContext | null;
  checkinCtx: CheckinContext | null;
  /** Refresh the registry — the keys have already moved by the time this runs. */
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [result, setResult] = useState<{ text: string; warning?: string } | null>(null);

  const quickCheckout = async () => {
    if (!checkoutCtx?.suggested_holder || busy) return;
    const h = checkoutCtx.suggested_holder;
    setBusy(true);
    try {
      const r = await checkout({
        account_id: checkoutCtx.account.id,
        account_name: checkoutCtx.account.name,
        holder: h.name,
        holder_email: h.email,
        holder_type: h.type,
        holder_id: h.id,
        keys: checkoutCtx.keys.filter((k) => k.suggested > 0).map((k) => ({ type: k.type, qty: k.suggested })),
        due_at: checkoutCtx.due_at,
        on_behalf: true,
        sign_mode: 'in_person',
        // A holder with no address cannot be sent a link, and the quick path
        // has no field to type a reason into — say plainly what happened.
        no_email_reason: h.email ? null : 'One-click check-out; no address on file for this holder.',
      });
      onDone();
      setPending({ kind: 'checkout', assignment: r.assignment });
    } catch (e: any) {
      onError(e?.message || 'Check-out failed');
    } finally { setBusy(false); }
  };

  const quickCheckin = async () => {
    if (!checkinCtx?.suggested_assignment_id || busy) return;
    setBusy(true);
    try {
      const r = await checkin({
        id: checkinCtx.suggested_assignment_id,
        condition_on_return: checkinCtx.condition,
        sign_mode: 'in_person',
      });
      onDone();
      if (r.assignment) setPending({ kind: 'checkin', assignment: r.assignment });
      else setResult({ text: 'Keys returned.' });
    } catch (e: any) {
      onError(e?.message || 'Check-in failed');
    } finally { setBusy(false); }
  };

  const emailInstead = async () => {
    if (!pending) return;
    try {
      const r = await resendSignoff(pending.assignment.id, pending.kind);
      setResult(
        r.email.ok
          ? { text: `Sign-off link emailed to ${r.email.recipients.join(', ')}.` }
          : { text: 'The record is saved.', warning: `The sign-off link did not send${r.email.error ? `: ${r.email.error}` : '.'}` }
      );
    } catch (e: any) {
      setResult({ text: 'The record is saved.', warning: e?.message || 'Could not send the sign-off link' });
    }
    setPending(null);
  };

  const canCheckout = !!checkoutCtx?.can_quick_checkout && !!checkoutCtx.suggested_holder;
  const canCheckin = !!checkinCtx?.can_quick_checkin;

  return (
    <>
      {canCheckout && checkoutCtx?.suggested_holder && (
        <ActionButton
          weight="primary"
          icon={<IconCheckOut />}
          label={`Check out to ${short(checkoutCtx.suggested_holder.name)}`}
          disabled={busy}
          onClick={quickCheckout}
          title={
            `${checkoutCtx.suggested_total} key${checkoutCtx.suggested_total === 1 ? '' : 's'} ` +
            `to ${checkoutCtx.suggested_holder.name} (${checkoutCtx.suggested_holder.reason}), ` +
            `due ${checkoutCtx.due_at}. Signature captured on this device.`
          }
        />
      )}
      {canCheckin && checkinCtx?.suggested_holder && (
        <ActionButton
          weight="primary"
          icon={<IconCheckIn />}
          label={`Check in from ${short(checkinCtx.suggested_holder.name)}`}
          disabled={busy}
          onClick={quickCheckin}
          title={`Return everything ${checkinCtx.suggested_holder.name} has out at this client, in good condition.`}
        />
      )}

      {pending && (
        <Modal
          title={pending.kind === 'checkin' ? 'Sign for the return' : 'Sign for the keys'}
          onClose={() => setPending(null)}
          width="max-w-lg"
        >
          <SignNowStep
            assignment={pending.assignment}
            kind={pending.kind}
            intro={
              <div className="text-sm bg-green-50 border border-green-200 text-green-800 rounded px-3 py-2">
                ✓ {pending.kind === 'checkin'
                  ? `Return recorded for ${pending.assignment.holder}.`
                  : `${pending.assignment.total_keys} key${pending.assignment.total_keys === 1 ? '' : 's'} recorded to ${pending.assignment.holder}.`}
                {' '}One signature and this is complete.
              </div>
            }
            onSigned={({ pdfError }: { mail: MailOutcome; pdfError: string | null }) => {
              setPending(null);
              setResult({
                text: `Signed by ${pending.assignment.holder}. The receipt is on its way.`,
                warning: pdfError ? `The signature is saved, but the PDF failed to generate (${pdfError}).` : undefined,
              });
            }}
            onSkip={emailInstead}
          />
        </Modal>
      )}

      {result && (
        <Modal title="Done" onClose={() => setResult(null)} width="max-w-md">
          <div className="space-y-3">
            <p className="text-sm text-cw-text">{result.text}</p>
            {result.warning && (
              <div className="text-sm bg-[#fff8e6] border border-[#e8cf8a] text-[#7a5a00] rounded px-3 py-2">
                ⚠ {result.warning}
              </div>
            )}
          </div>
          <div className="flex gap-2 pt-4 border-t border-gray-200 mt-4">
            <button
              onClick={() => setResult(null)}
              className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] transition-colors"
            >
              Done
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
