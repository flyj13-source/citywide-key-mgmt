import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import Layout from '../components/Layout';
import Badge from '../components/Badge';
import YesNo from '../components/YesNo';
import { getAccount, revealCode, getAccessCodes, revealAccessCode, type AccessCode } from '../lib/api';
import { QuickCustodyButtons, useCustodyContext } from '../components/QuickCustody';
import { CheckOutModal, CheckInModal } from '../components/CustodyModals';
import { ActionButton, ActionRow, ActionGroup } from '../components/ActionRow';
import { IconCheckOut, IconCheckIn } from '../components/Icons';

function MetricCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="card p-4 text-center">
      <div className="text-2xl font-bold text-[#1a1a1a]">{value}</div>
      <div className="text-xs text-cw-muted mt-1">{label}</div>
    </div>
  );
}

// One holder row in the Key Holders card: total first, then per-type chips.
// The "N keys" total is that holder's column total (metal+card+fob+dispenser).
function RoleHolder({ title, name, total, metal, card, fob, dispenser }: {
  title: string; name?: string; total: number;
  metal: number; card: number; fob: number; dispenser: number;
}) {
  const chips = ([[metal, 'metal'], [card, 'card'], [fob, 'fob'], [dispenser, 'dispenser']] as [number, string][])
    .filter(([n]) => (n || 0) > 0);
  return (
    <div className="py-2">
      <div className="flex items-center justify-between">
        <div>
          <span className="font-medium text-cw-text">{title}</span>
          {name && <span className="ml-2 text-cw-muted text-xs">{name}</span>}
        </div>
        <span className={`font-semibold ${total > 0 ? 'text-[#1a1a1a]' : 'text-gray-300'}`}>
          {total > 0 ? `${total} key${total !== 1 ? 's' : ''}` : '—'}
        </span>
      </div>
      {chips.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {chips.map(([n, label]) => (
            <span key={label} className="inline-flex items-center rounded-full bg-gray-100 text-gray-700 text-[10px] font-medium px-1.5 py-0.5">
              {n} {label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function CodeReveal({ accountId, type, hasCode }: { accountId: number; type: 'door' | 'alarm' | 'door_access'; hasCode: boolean }) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!hasCode) return <span className="text-cw-muted">—</span>;

  if (revealed) {
    return (
      <span className="font-mono text-sm bg-gray-100 px-2 py-1 rounded select-all">
        {revealed}
        <button onClick={() => setRevealed(null)} className="ml-2 text-xs text-cw-muted hover:text-cw-text">hide</button>
      </span>
    );
  }

  return (
    <button
      onClick={async () => { setLoading(true); try { const d = await revealCode(accountId, type); setRevealed(d.code); } finally { setLoading(false); } }}
      disabled={loading}
      className="text-xs border border-[#C0272D] text-[#C0272D] rounded px-2 py-0.5 hover:bg-[#C0272D] hover:text-white transition-colors"
    >
      {loading ? 'Revealing…' : 'Reveal'}
    </button>
  );
}

/**
 * A labeled access-code row. Same masked + reveal behaviour as the Door Codes
 * tab, and the same single audited endpoint behind it — the value lives in
 * state for five seconds and is never stored.
 */
function AccessCodeReveal({ id }: { id: number }) {
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (code === null) return;
    const t = setTimeout(() => setCode(null), 5000);
    return () => clearTimeout(t);
  }, [code]);

  if (code !== null) {
    return (
      <span className="font-mono text-sm bg-[#fff8e6] border border-[#e8cf8a] px-2 py-0.5 rounded select-all">
        {code}
        <button onClick={() => setCode(null)} className="ml-2 text-xs text-cw-muted hover:text-cw-text">hide</button>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      {err && <span className="text-xs text-[#C0272D]">{err}</span>}
      <span className="font-mono text-gray-400 tracking-widest select-none">••••</span>
      <button
        onClick={async () => {
          setLoading(true); setErr('');
          try { setCode((await revealAccessCode(id)).code); }
          catch (e: any) { setErr(e?.message || 'Could not reveal'); }
          finally { setLoading(false); }
        }}
        disabled={loading}
        className="text-xs border border-[#C0272D] text-[#C0272D] rounded px-2 py-0.5 hover:bg-[#C0272D] hover:text-white transition-colors disabled:opacity-50"
      >
        {loading ? '…' : 'Reveal'}
      </button>
    </span>
  );
}

export default function AccountDetail() {
  const { accountId } = useParams<{ accountId: string }>();
  const navigate = useNavigate();
  const [account, setAccount] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [codes, setCodes] = useState<AccessCode[]>([]);
  const [checkOutOpen, setCheckOutOpen] = useState(false);
  const [checkInOpen, setCheckInOpen] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    if (!accountId) return;
    getAccount(Number(accountId))
      .then(setAccount)
      .catch(() => setError('Account not found'))
      .finally(() => setLoading(false));
    // Separate call: codes live in their own table and carry no ciphertext here.
    getAccessCodes({ account_id: String(accountId), include_test: '1' })
      .then((r) => setCodes(r.codes))
      .catch(() => setCodes([]));
  }, [accountId]);
  useEffect(() => { load(); }, [load]);

  // One click from the registry row, so this is where a handover actually
  // starts: the client is already known, and so is everything that follows
  // from it.
  const snapshot = useMemo(
    () => (account ? { id: account.id, name: account.ic_company_name } : null),
    [account],
  );
  const { checkoutCtx, checkinCtx } = useCustodyContext(snapshot);

  if (loading) return <Layout><div className="p-8 text-cw-muted">Loading…</div></Layout>;
  if (error || !account) return <Layout><div className="p-8 text-red-500">{error || 'Not found'}</div></Layout>;

  const activeAssignments = (account.assignments || []).filter((a: any) => a.status === 'checked_out');
  const pastAssignments = (account.assignments || []).filter((a: any) => a.status !== 'checked_out');

  return (
    <Layout>
      <div className="p-6 max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <button onClick={() => navigate('/registry')} className="text-xs text-cw-muted hover:text-cw-text mb-2 block">← Key Registry</button>
            <h1 className="text-xl font-bold text-[#1a1a1a]">{account.ic_company_name}</h1>
            <div className="flex items-center gap-3 mt-1">
              {account.bc_client_number && (
                <span className="font-mono text-sm text-cw-muted">BC# {account.bc_client_number}</span>
              )}
              {account.bc_vendor_number && (
                <span className="font-mono text-sm text-cw-muted">Vendor# {account.bc_vendor_number}</span>
              )}
              <Badge variant={account.status === 'active' ? 'green' : 'gray'}>{account.status}</Badge>
              <Badge variant={account.record_type === 'customer' ? 'yellow' : 'gray'}>
                {account.record_type === 'customer' ? 'Customer' : 'IC Vendor'}
              </Badge>
            </div>
          </div>

          {/* The handover happens here. The standard transaction is one
              click; the "…" forms are the same thing with the defaults
              already filled in, for when it is not the standard one. */}
          <ActionRow>
            <ActionGroup label="Daily custody">
              <QuickCustodyButtons
                checkoutCtx={checkoutCtx}
                checkinCtx={checkinCtx}
                onDone={load}
                onError={setNotice}
              />
              <ActionButton
                weight={checkoutCtx?.can_quick_checkout ? 'secondary' : 'primary'}
                icon={<IconCheckOut />}
                label={checkoutCtx?.can_quick_checkout ? 'Check In…' : 'Check In'}
                onClick={() => setCheckOutOpen(true)}
                title="Change the holder, keys or due date"
              />
              <ActionButton
                weight={checkinCtx?.can_quick_checkin ? 'secondary' : 'primary'}
                icon={<IconCheckIn />}
                label={checkinCtx?.can_quick_checkin ? 'Check Out…' : 'Check Out'}
                onClick={() => setCheckInOpen(true)}
                title="Return a subset, or change the condition"
              />
            </ActionGroup>
          </ActionRow>
        </div>

        {notice && (
          <p className="text-sm text-[#C0272D] bg-[#fbeaea] border border-[#f0c9cb] rounded px-3 py-2">{notice}</p>
        )}

        {checkOutOpen && (
          <CheckOutModal
            presetAccount={snapshot}
            onClose={() => setCheckOutOpen(false)}
            onDone={load}
          />
        )}
        {checkInOpen && (
          <CheckInModal
            presetAccount={snapshot}
            onClose={() => setCheckInOpen(false)}
            onDone={load}
          />
        )}

        {/* Key Inventory */}
        <div>
          <h2 className="text-sm font-semibold text-cw-muted uppercase tracking-wide mb-3">Key Inventory</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <MetricCard label="Keys Y/N" value={<YesNo value={account.keys_yn} label="Keys" size="lg" />} />
            <MetricCard label="Security App" value={<YesNo value={account.security_app_yn} label="Security app" size="lg" />} />
            <MetricCard label="Metal Keys" value={account.metal_keys ?? 0} />
            <MetricCard label="Key Cards" value={account.key_cards ?? 0} />
            <MetricCard label="Key Fobs" value={account.has_fob ?? 0} />
            <MetricCard label="Dispenser Keys" value={account.dispenser_keys ?? 0} />
            {account.record_type === 'customer' && <>
              <MetricCard label="AM Keys" value={account.am_keys ?? 0} />
              <MetricCard label="CCM Keys" value={account.ccm_keys ?? 0} />
              <MetricCard label="Contractor Keys" value={account.contractor_keys ?? 0} />
              <MetricCard label="Office Keys" value={account.office_keys_held ?? 0} />
            </>}
          </div>
        </div>

        {/* Key Holders by Role */}
        {account.record_type === 'customer' && (account.am_keys > 0 || account.ccm_keys > 0 || account.contractor_keys > 0 || account.office_keys_held > 0 || account.ic_name || account.account_manager || account.ccm_manager) && (
          <div className="card p-4">
            <h2 className="text-sm font-semibold text-cw-muted uppercase tracking-wide mb-3">Key Holders by Role</h2>
            <div className="divide-y divide-gray-100 text-sm">
              {(account.ic_name || account.contractor_keys > 0) && (
                <RoleHolder title="Independent Contractor" name={account.ic_name}
                  total={account.contractor_keys} metal={account.contractor_metal}
                  card={account.contractor_card} fob={account.contractor_fob} dispenser={account.contractor_dispenser} />
              )}
              {(account.account_manager || account.am_keys > 0) && (
                <RoleHolder title="Account Manager" name={account.account_manager}
                  total={account.am_keys} metal={account.am_metal}
                  card={account.am_card} fob={account.am_fob} dispenser={account.am_dispenser} />
              )}
              {(account.ccm_manager || account.ccm_keys > 0) && (
                <RoleHolder title="Contract Compliance Mgr" name={account.ccm_manager}
                  total={account.ccm_keys} metal={account.ccm_metal}
                  card={account.ccm_card} fob={account.ccm_fob} dispenser={account.ccm_dispenser} />
              )}
              {account.office_keys_held > 0 && (
                <RoleHolder title="Office"
                  total={account.office_keys_held} metal={account.office_metal}
                  card={account.office_card} fob={account.office_fob} dispenser={account.office_dispenser} />
              )}
            </div>
          </div>
        )}

        {/* Access Codes — this client's labeled codes, from access_codes */}
        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-cw-muted uppercase tracking-wide">
              Access Codes {codes.length > 0 && <span className="text-gray-400">({codes.length})</span>}
            </h2>
            <Link to="/registry?tab=doorcodes" className="text-xs text-[#C0272D] hover:underline">
              All door codes →
            </Link>
          </div>

          <div className="divide-y divide-gray-100 text-sm">
            {codes.length === 0 && (
              <div className="py-2 text-cw-muted text-xs">
                No access codes recorded for this client.
              </div>
            )}
            {codes.map((c) => (
              <div key={c.id} className="flex items-center justify-between py-2 gap-3">
                <div className="min-w-0">
                  <span className="text-cw-text">{c.label}</span>
                  {c.notes && <span className="block text-[11px] text-cw-muted truncate">{c.notes}</span>}
                </div>
                <AccessCodeReveal id={c.id} />
              </div>
            ))}

            {/* The lockbox code is plain text on the client row, not a secret in
                access_codes, so it stays here. */}
            <div className="flex items-center justify-between py-2">
              <span className="text-cw-muted">Lockbox Code</span>
              <span className="font-mono text-sm">{account.lockbox_code || '—'}</span>
            </div>
          </div>

          {/* The pre-migration columns. Shown only while they still hold
              something, so a value that never migrated stays reachable rather
              than disappearing behind the new table. */}
          {(account.door_code_encrypted || account.alarm_code_encrypted || account.door_access_code_encrypted) && (
            <div className="mt-3 pt-3 border-t border-gray-200">
              <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-2">
                Legacy fields on the client record
              </div>
              <div className="divide-y divide-gray-100 text-sm">
                {account.door_code_encrypted && (
                  <div className="flex items-center justify-between py-2">
                    <span className="text-cw-muted">Door Code</span>
                    <CodeReveal accountId={account.id} type="door" hasCode />
                  </div>
                )}
                {account.alarm_code_encrypted && (
                  <div className="flex items-center justify-between py-2">
                    <span className="text-cw-muted">Alarm Code</span>
                    <CodeReveal accountId={account.id} type="alarm" hasCode />
                  </div>
                )}
                {account.door_access_code_encrypted && (
                  <div className="flex items-center justify-between py-2">
                    <span className="text-cw-muted">Door Access Code</span>
                    <CodeReveal accountId={account.id} type="door_access" hasCode />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Current Key Holders */}
        <div>
          <h2 className="text-sm font-semibold text-cw-muted uppercase tracking-wide mb-3">
            Current Key Holders
            {activeAssignments.length > 0 && (
              <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-800 text-xs">{activeAssignments.length} out</span>
            )}
          </h2>
          {activeAssignments.length === 0 ? (
            <p className="text-sm text-cw-muted">No keys currently checked in.</p>
          ) : (
            <div className="space-y-2">
              {activeAssignments.map((a: any) => (
                <div key={a.id} className="card p-3 flex items-center justify-between text-sm">
                  <div>
                    <span className="font-medium">{a.assignee}</span>
                    {a.keys_held && <span className="text-cw-muted ml-2 text-xs">({a.keys_held})</span>}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-cw-muted">
                    <span>Out: {new Date(a.checked_out_at).toLocaleDateString()}</span>
                    {a.due_at && <span>Due: {new Date(a.due_at).toLocaleDateString()}</span>}
                    <Badge variant="yellow">Checked In</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Notes */}
        {account.notes && (
          <div className="bg-yellow-50 border border-yellow-200 rounded p-4 text-sm text-yellow-800">
            <span className="font-medium">Notes: </span>{account.notes}
          </div>
        )}

        {/* Past Assignments */}
        {pastAssignments.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-cw-muted uppercase tracking-wide mb-3">Past Assignments</h2>
            <div className="space-y-2">
              {pastAssignments.map((a: any) => (
                <div key={a.id} className="card p-3 flex items-center justify-between text-sm opacity-70">
                  <div>
                    <span className="font-medium">{a.assignee}</span>
                    {a.keys_held && <span className="text-cw-muted ml-2 text-xs">({a.keys_held})</span>}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-cw-muted">
                    <span>{new Date(a.checked_out_at).toLocaleDateString()}</span>
                    <Badge variant="green">Returned</Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
