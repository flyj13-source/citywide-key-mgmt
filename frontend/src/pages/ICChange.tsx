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
          <p className="text-sm text-cw-muted mt-1">Search by Customer ID to view current IC assignment</p>
        </div>

        <div className="flex gap-2">
          <input
            className="input flex-1"
            placeholder="Enter Customer ID (e.g. CW-1001)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && search()}
          />
          <button onClick={search} disabled={loading} className="btn-primary">
            {loading ? 'Searching…' : 'Search'}
          </button>
        </div>

        {notFound && (
          <div className="card p-4 text-sm text-red-600">
            No account found with Customer ID <span className="font-mono font-medium">{query}</span>
          </div>
        )}

        {result && (
          <div className="card p-5 space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-bold">{result.name}</h2>
                <span className="font-mono text-sm text-cw-muted">{result.customer_id}</span>
              </div>
              <Badge variant={result.status === 'active' ? 'green' : 'gray'}>{result.status}</Badge>
            </div>

            <div className="grid grid-cols-2 gap-4 text-sm border-t border-cw-border pt-4">
              <div>
                <div className="text-xs text-cw-muted mb-1">IC Name</div>
                <div className="font-medium">{result.ic_name || <span className="italic text-cw-muted">Not assigned</span>}</div>
              </div>
              <div>
                <div className="text-xs text-cw-muted mb-1">IC ID Number</div>
                <div className="font-medium">{result.ic_id_number || <span className="text-cw-muted">—</span>}</div>
              </div>
              <div>
                <div className="text-xs text-cw-muted mb-1">Total Keys</div>
                <div className="font-medium">{result.total_keys}</div>
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
          To update IC assignment, use the <strong>Key Registry → Edit Account</strong>. Full IC reassignment workflow coming soon.
        </p>
      </div>
    </Layout>
  );
}
