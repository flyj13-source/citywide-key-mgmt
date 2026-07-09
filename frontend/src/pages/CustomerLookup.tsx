import { useState } from 'react';
import Layout from '../components/Layout';
import Badge from '../components/Badge';
import { getCustomerByBcNumber } from '../lib/api';

export default function CustomerLookup() {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<any>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(false);

  const search = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setResult(null);
    setNotFound(false);
    try {
      const data = await getCustomerByBcNumber(query.trim());
      setResult(data);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  };

  const activeAssignments = result?.assignments?.filter((a: any) => a.status === 'checked_out') ?? [];

  return (
    <Layout>
      <div className="p-6 max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-xl font-bold">Customer Lookup</h1>
          <p className="text-sm text-cw-muted mt-1">Search by BC Client Number to view key assignment details</p>
        </div>

        <div className="flex gap-2">
          <input
            className="input flex-1"
            placeholder="e.g. 01014200001"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && search()}
          />
          <button onClick={search} disabled={loading} className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] disabled:opacity-50 transition-colors">
            {loading ? 'Searching…' : 'Search'}
          </button>
        </div>

        {notFound && (
          <div className="card p-4 text-sm text-red-600">
            No customer found with BC Client # <span className="font-mono font-medium">{query}</span>
          </div>
        )}

        {result && (
          <div className="card p-5 space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-bold text-[#1a1a1a]">{result.ic_company_name}</h2>
                {result.bc_client_number && (
                  <div className="font-mono text-sm text-cw-muted">BC Client #: {result.bc_client_number}</div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={result.status === 'active' ? 'green' : 'gray'}>{result.status}</Badge>
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-[#1a1a1a] text-white">Customer</span>
              </div>
            </div>

            {/* Relationship info */}
            {(result.ic_name || result.bc_vendor_number || result.account_manager || result.ccm_manager) && (
              <div className="grid grid-cols-2 gap-3 border-t border-cw-border pt-4 text-sm">
                {result.ic_name && (
                  <div>
                    <div className="text-xs text-cw-muted mb-1">Independent Contractor</div>
                    <div className="font-medium">{result.ic_name}</div>
                    {result.bc_vendor_number && <div className="font-mono text-xs text-cw-muted">{result.bc_vendor_number}</div>}
                  </div>
                )}
                {result.account_manager && (
                  <div>
                    <div className="text-xs text-cw-muted mb-1">Account Manager</div>
                    <div className="font-medium">{result.account_manager}</div>
                  </div>
                )}
                {result.ccm_manager && (
                  <div>
                    <div className="text-xs text-cw-muted mb-1">Contract Compliance Manager</div>
                    <div className="font-medium">{result.ccm_manager}</div>
                  </div>
                )}
              </div>
            )}

            {/* Key counts */}
            <div className="grid grid-cols-3 gap-3 text-sm border-t border-cw-border pt-4">
              {[
                { label: 'Keys Y/N', value: result.keys_yn ? '✓ Yes' : '—', green: !!result.keys_yn },
                { label: 'Security App', value: result.security_app_yn ? '✓ Yes' : '—', green: !!result.security_app_yn },
                { label: 'Metal Keys', value: result.metal_keys ?? 0 },
                { label: 'Key Cards', value: result.key_cards ?? 0 },
                { label: 'Key Fobs', value: result.has_fob ?? 0 },
                { label: 'Dispenser Key', value: result.dispenser_keys ?? 0 },
                { label: 'AM Keys', value: result.am_keys ?? 0 },
                { label: 'CCM Keys', value: result.ccm_keys ?? 0 },
                { label: 'Contractor Keys', value: result.contractor_keys ?? 0 },
              ].map(({ label, value, green }) => (
                <div key={label}>
                  <div className="text-xs text-cw-muted mb-1">{label}</div>
                  <div className={`font-medium ${green ? 'text-[#2d7a3a]' : ''}`}>{value}</div>
                </div>
              ))}
            </div>

            {/* Access codes summary */}
            {(result.lockbox_code || result.door_code_encrypted || result.alarm_code_encrypted) && (
              <div className="border-t border-cw-border pt-3 text-sm text-cw-muted">
                {result.lockbox_code && <div>Lockbox: <span className="font-mono text-cw-text">{result.lockbox_code}</span></div>}
                {result.door_code_encrypted && <div>Door Code: <span className="italic">encrypted — view in Registry</span></div>}
                {result.alarm_code_encrypted && <div>Alarm Code: <span className="italic">encrypted — view in Registry</span></div>}
              </div>
            )}

            {/* Current key holders */}
            {activeAssignments.length > 0 && (
              <div className="border-t border-cw-border pt-4">
                <div className="text-xs font-semibold text-cw-muted uppercase tracking-wide mb-2">Current Key Holders</div>
                <div className="space-y-2">
                  {activeAssignments.map((a: any) => (
                    <div key={a.id} className="flex items-center justify-between text-sm bg-gray-50 rounded px-3 py-2">
                      <span className="font-medium">{a.assignee}</span>
                      <div className="flex items-center gap-2 text-xs text-cw-muted">
                        {a.keys_held && <span>({a.keys_held})</span>}
                        <Badge variant="yellow">Out</Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {result.notes && (
              <div className="border-t border-cw-border pt-3 text-sm text-yellow-800 bg-yellow-50 rounded p-3">
                <span className="font-medium">Notes: </span>{result.notes}
              </div>
            )}
          </div>
        )}

        <p className="text-xs text-cw-muted border-t border-cw-border pt-4">
          To update customer details, use <strong>Key Registry → Customers tab → Edit</strong>.
        </p>
      </div>
    </Layout>
  );
}
