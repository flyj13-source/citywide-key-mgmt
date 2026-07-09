import { useState } from 'react';
import Layout from '../components/Layout';
import Badge from '../components/Badge';
import { getAccountByCustomerId } from '../lib/api';

export default function ICChange() {
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
      const data = await getAccountByCustomerId(query.trim());
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
          <h1 className="text-xl font-bold">IC Change Lookup</h1>
          <p className="text-sm text-cw-muted mt-1">Search by BC Vendor Number to view current IC assignment</p>
        </div>

        <div className="flex gap-2">
          <input
            className="input flex-1"
            placeholder="e.g. 02014100020"
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
            No account found with BC Vendor Number <span className="font-mono font-medium">{query}</span>
          </div>
        )}

        {result && (
          <div className="card p-5 space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-bold text-[#1a1a1a]">{result.ic_company_name}</h2>
                <span className="font-mono text-sm text-cw-muted">{result.bc_vendor_number}</span>
              </div>
              <Badge variant={result.status === 'active' ? 'green' : 'gray'}>{result.status}</Badge>
              <Badge variant={result.record_type === 'customer' ? 'yellow' : 'gray'}>
                {result.record_type === 'customer' ? 'Customer' : 'IC Vendor'}
              </Badge>
            </div>

            <div className="grid grid-cols-2 gap-4 text-sm border-t border-cw-border pt-4">
              <div>
                <div className="text-xs text-cw-muted mb-1">Keys Y/N</div>
                <div className="font-medium">{result.keys_yn ? <span className="text-[#2d7a3a]">✓ Yes</span> : '—'}</div>
              </div>
              <div>
                <div className="text-xs text-cw-muted mb-1">Security App Y/N</div>
                <div className="font-medium">{result.security_app_yn ? <span className="text-[#2d7a3a]">✓ Yes</span> : '—'}</div>
              </div>
              <div>
                <div className="text-xs text-cw-muted mb-1">Metal Keys</div>
                <div className="font-medium">{result.metal_keys ?? 0}</div>
              </div>
              <div>
                <div className="text-xs text-cw-muted mb-1">Key Cards</div>
                <div className="font-medium">{result.key_cards ?? 0}</div>
              </div>
              <div>
                <div className="text-xs text-cw-muted mb-1">Key Fobs</div>
                <div className="font-medium">{result.has_fob ?? 0}</div>
              </div>
              <div>
                <div className="text-xs text-cw-muted mb-1">Dispenser Keys</div>
                <div className="font-medium">{result.dispenser_keys ?? 0}</div>
              </div>
            </div>

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
          </div>
        )}

        <p className="text-xs text-cw-muted border-t border-cw-border pt-4">
          To update IC assignment, use the <strong>Key Registry → Edit</strong>. Full IC reassignment workflow coming soon.
        </p>
      </div>
    </Layout>
  );
}
