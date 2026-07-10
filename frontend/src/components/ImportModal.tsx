import { useState, useRef, DragEvent } from 'react';
import Modal from './Modal';
import { previewImport, confirmImport, downloadImportTemplate } from '../lib/api';

type Step = 'upload' | 'preview' | 'done';

interface ImportResult { valid: any[]; warnings: any[]; errors: any[]; total: number; }

export default function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState<Step>('upload');
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [summary, setSummary] = useState<{ inserted: number; skipped: number; errors?: any[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    if (!file.name.match(/\.(xlsx|xls|csv)$/i)) {
      setError('Please upload an .xlsx, .xls, or .csv file'); return;
    }
    setLoading(true); setError('');
    try {
      const res = await previewImport(file);
      setResult(res);
      setStep('preview');
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const handleConfirm = async () => {
    if (!result) return;
    setLoading(true); setError('');
    try {
      const res = await confirmImport(result.valid);
      setSummary(res);
      setStep('done');
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const statusIcon = (type: 'valid' | 'warning' | 'error') => {
    if (type === 'valid') return <span className="text-green-600 font-bold">✓</span>;
    if (type === 'warning') return <span className="text-amber-500 font-bold">⚠</span>;
    return <span className="text-red-600 font-bold">✕</span>;
  };

  return (
    <Modal title="Import from Excel / CSV" onClose={onClose} width="max-w-3xl">
      {/* Step 1 — Upload */}
      {step === 'upload' && (
        <div className="space-y-4">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
            className={`border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors ${
              dragging ? 'border-[#C0272D] bg-red-50' : 'border-cw-border hover:border-[#C0272D] hover:bg-red-50'
            }`}
          >
            <div className="text-3xl mb-3">📂</div>
            <div className="font-medium text-sm text-cw-text">Drag & drop your file here</div>
            <div className="text-xs text-cw-muted mt-1">or click to browse — .xlsx, .xls, .csv accepted</div>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={onFileInput} />
          </div>

          {loading && <div className="text-sm text-center text-cw-muted">Parsing file…</div>}
          {error && <div className="text-sm text-red-600">{error}</div>}

          <div className="flex items-center justify-between text-xs text-cw-muted pt-1">
            <span>Columns must match the template headers</span>
            <button
              onClick={(e) => { e.stopPropagation(); downloadImportTemplate(); }}
              className="text-[#C0272D] hover:underline font-medium"
            >
              ↓ Download blank template
            </button>
          </div>
        </div>
      )}

      {/* Step 2 — Preview */}
      {step === 'preview' && result && (
        <div className="space-y-4">
          {/* Counts */}
          <div className="flex gap-3">
            <div className="flex-1 bg-green-50 border border-green-200 rounded p-3 text-center">
              <div className="text-xl font-bold text-green-700">{result.valid.length}</div>
              <div className="text-xs text-green-600">Ready to import</div>
            </div>
            <div className="flex-1 bg-amber-50 border border-amber-200 rounded p-3 text-center">
              <div className="text-xl font-bold text-amber-600">{result.warnings.length}</div>
              <div className="text-xs text-amber-500">Warnings (will skip)</div>
            </div>
            <div className="flex-1 bg-red-50 border border-red-200 rounded p-3 text-center">
              <div className="text-xl font-bold text-red-600">{result.errors.length}</div>
              <div className="text-xs text-red-500">Errors (invalid)</div>
            </div>
          </div>

          {/* Table */}
          <div className="overflow-auto max-h-64 border border-cw-border rounded text-xs">
            <table className="w-full whitespace-nowrap">
              <thead>
                <tr className="bg-cw-black text-white">
                  <th className="px-3 py-2 text-left font-medium w-8"></th>
                  <th className="px-3 py-2 text-left font-medium">Row</th>
                  <th className="px-3 py-2 text-left font-medium">Client Name</th>
                  <th className="px-3 py-2 text-left font-medium">BC Client #</th>
                  <th className="px-3 py-2 text-left font-medium">Keys</th>
                  <th className="px-3 py-2 text-left font-medium">Status / Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cw-border">
                {result.valid.map((r, i) => (
                  <tr key={i} className="bg-green-50/40">
                    <td className="px-3 py-1.5 text-center">{statusIcon('valid')}</td>
                    <td className="px-3 py-1.5 text-cw-muted">{r._row}</td>
                    <td className="px-3 py-1.5 font-medium">{r.ic_company_name}</td>
                    <td className="px-3 py-1.5 font-mono text-cw-muted">{r.bc_client_number || '—'}</td>
                    <td className="px-3 py-1.5 text-cw-muted">{r.metal_keys || 0}M/{r.key_cards || 0}C</td>
                    <td className="px-3 py-1.5 text-green-700 text-xs">Valid</td>
                  </tr>
                ))}
                {result.warnings.map((w, i) => (
                  <tr key={`w${i}`} className="bg-amber-50/40">
                    <td className="px-3 py-1.5 text-center">{statusIcon('warning')}</td>
                    <td className="px-3 py-1.5 text-cw-muted">{w.row}</td>
                    <td className="px-3 py-1.5 font-medium">{w.data.ic_company_name}</td>
                    <td className="px-3 py-1.5 font-mono text-cw-muted">{w.data.bc_client_number || '—'}</td>
                    <td className="px-3 py-1.5 text-cw-muted">{w.data.metal_keys || 0}M/{w.data.key_cards || 0}C</td>
                    <td className="px-3 py-1.5 text-amber-600 text-xs max-w-[200px] truncate">{w.message}</td>
                  </tr>
                ))}
                {result.errors.map((e, i) => (
                  <tr key={`e${i}`} className="bg-red-50/40">
                    <td className="px-3 py-1.5 text-center">{statusIcon('error')}</td>
                    <td className="px-3 py-1.5 text-cw-muted">{e.row}</td>
                    <td className="px-3 py-1.5 text-red-600">{String(e.raw?.ic_company_name || '').trim() || '(empty)'}</td>
                    <td className="px-3 py-1.5">—</td>
                    <td className="px-3 py-1.5">—</td>
                    <td className="px-3 py-1.5 text-red-600 text-xs max-w-[200px] truncate">{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {error && <div className="text-sm text-red-600">{error}</div>}

          <div className="flex gap-2 pt-1">
            <button
              onClick={handleConfirm}
              disabled={loading || result.valid.length === 0}
              className="btn-primary"
            >
              {loading ? 'Importing…' : `Import ${result.valid.length} valid account${result.valid.length !== 1 ? 's' : ''}`}
            </button>
            <button onClick={() => { setStep('upload'); setResult(null); setError(''); }} className="btn-secondary">
              ← Back
            </button>
          </div>
        </div>
      )}

      {/* Step 3 — Done */}
      {step === 'done' && summary && (
        <div className="space-y-4 text-center py-4">
          <div className="text-4xl">{summary.inserted > 0 ? '✅' : '⚠️'}</div>
          <div>
            <div className="text-lg font-bold text-cw-text">{summary.inserted} account{summary.inserted !== 1 ? 's' : ''} imported</div>
            {summary.skipped > 0 && (
              <div className="text-sm text-cw-muted mt-1">{summary.skipped} skipped (duplicates or invalid)</div>
            )}
            {(summary.errors?.length ?? 0) > 0 && (
              <div className="text-sm text-red-600 mt-1">{summary.errors!.length} row{summary.errors!.length !== 1 ? 's' : ''} had insert errors</div>
            )}
          </div>
          <div className="flex gap-2 justify-center pt-2">
            <button onClick={() => { onDone(); onClose(); }} className="btn-primary">
              View Registry →
            </button>
            <button onClick={() => { setStep('upload'); setResult(null); setSummary(null); }} className="btn-secondary">
              Import another file
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
