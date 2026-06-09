import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getContractorByToken, signContractor } from '../lib/api';

export default function ContractorPortal() {
  const { token } = useParams<{ token: string }>();
  const [contractor, setContractor] = useState<any>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState(false);
  const [signed, setSigned] = useState(false);
  const [pdfPath, setPdfPath] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (!token) return;
    getContractorByToken(token)
      .then((d) => {
        if (d.error) { setError(d.error); }
        else { setContractor(d); if (d.status === 'signed') setSigned(true); }
      })
      .catch(() => setError('Failed to load'))
      .finally(() => setLoading(false));
  }, [token]);

  const getPos = (e: React.MouseEvent | React.TouchEvent, canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect();
    if ('touches' in e) {
      return { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top };
    }
    return { x: (e as React.MouseEvent).clientX - rect.left, y: (e as React.MouseEvent).clientY - rect.top };
  };

  const startDraw = (e: React.MouseEvent | React.TouchEvent) => {
    drawing.current = true;
    const canvas = canvasRef.current!;
    const pos = getPos(e, canvas);
    lastPos.current = pos;
    const ctx = canvas.getContext('2d')!;
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
  };

  const draw = (e: React.MouseEvent | React.TouchEvent) => {
    if (!drawing.current) return;
    e.preventDefault();
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const pos = getPos(e, canvas);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    lastPos.current = pos;
  };

  const stopDraw = () => { drawing.current = false; };

  const clearCanvas = () => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  };

  const handleSign = async () => {
    const canvas = canvasRef.current!;
    const signatureData = canvas.toDataURL('image/png');
    const blank = document.createElement('canvas');
    blank.width = canvas.width;
    blank.height = canvas.height;
    if (signatureData === blank.toDataURL('image/png')) {
      alert('Please provide your signature before submitting.');
      return;
    }
    setSigning(true);
    try {
      const r = await signContractor(token!, signatureData);
      if (r.success) { setSigned(true); setPdfPath(r.pdf_path); }
      else { setError(r.error || 'Signing failed'); }
    } catch (e: any) { setError(e.message); }
    finally { setSigning(false); }
  };

  if (loading) return (
    <div className="min-h-screen bg-cw-bg flex items-center justify-center">
      <div className="text-cw-muted">Loading…</div>
    </div>
  );

  if (error) return (
    <div className="min-h-screen bg-cw-bg flex items-center justify-center p-4">
      <div className="bg-white border border-red-200 rounded-lg p-6 max-w-md text-center">
        <div className="text-red-600 text-lg font-semibold mb-2">Link Error</div>
        <div className="text-cw-muted text-sm">{error}</div>
        <p className="text-xs text-cw-muted mt-3">Contact City Wide Boston to request a new link.</p>
      </div>
    </div>
  );

  if (signed) return (
    <div className="min-h-screen bg-cw-bg flex items-center justify-center p-4">
      <div className="bg-white border border-green-200 rounded-lg p-8 max-w-md text-center">
        <div className="text-green-600 text-4xl mb-3">✓</div>
        <div className="text-xl font-bold text-cw-text mb-2">Receipt Acknowledged</div>
        <p className="text-sm text-cw-muted mb-4">
          Thank you, {contractor?.name}. Your signed PDF receipt has been generated and stored securely with City Wide Boston.
        </p>
        {pdfPath && (
          <p className="text-xs text-cw-muted">PDF: {pdfPath}</p>
        )}
        <div className="mt-4 text-xs text-cw-muted">City Wide Building Services · Boston, MA</div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-cw-bg">
      {/* Header */}
      <div className="bg-cw-black px-6 py-4 flex items-center justify-between">
        <div>
          <div className="text-white font-bold">City Wide Building Services</div>
          <div className="text-gray-400 text-xs tracking-widest uppercase">Boston</div>
        </div>
        <div className="w-6 h-6 bg-cw-red rounded-sm"></div>
      </div>

      <div className="max-w-2xl mx-auto p-6 space-y-6">
        <div className="bg-white border border-cw-border rounded-lg p-6">
          <h1 className="text-xl font-bold mb-1">Key Receipt Acknowledgement</h1>
          <p className="text-sm text-cw-muted">
            Hello <strong>{contractor?.name}</strong>, please review your assigned keys below and provide your electronic signature.
          </p>
        </div>

        {/* Assigned accounts */}
        <div className="bg-white border border-cw-border rounded-lg overflow-hidden">
          <div className="px-5 py-3 bg-cw-black">
            <h2 className="text-white font-semibold text-sm">Assigned Accounts ({contractor?.assigned_accounts?.length})</h2>
          </div>
          <div className="divide-y divide-cw-border">
            {contractor?.assigned_accounts?.map((acc: string) => (
              <div key={acc} className="px-5 py-3 flex items-center gap-2 text-sm">
                <span className="text-cw-red">•</span>
                {acc}
              </div>
            ))}
          </div>
        </div>

        {/* Agreement */}
        <div className="bg-white border border-cw-border rounded-lg p-5 text-sm text-cw-muted space-y-2">
          <p className="font-medium text-cw-text">By signing below, I acknowledge that:</p>
          <ul className="list-disc list-inside space-y-1">
            <li>I have received the keys listed above</li>
            <li>I will safeguard all keys and access credentials</li>
            <li>I will not duplicate or share keys with unauthorized personnel</li>
            <li>I will return all keys immediately upon request or contract termination</li>
            <li>I will report any lost or stolen keys to City Wide Boston within 24 hours</li>
          </ul>
        </div>

        {/* Signature canvas */}
        <div className="bg-white border border-cw-border rounded-lg p-5">
          <h2 className="font-semibold text-sm mb-3">Electronic Signature</h2>
          <div className="border-2 border-dashed border-cw-border rounded-lg overflow-hidden" style={{ touchAction: 'none' }}>
            <canvas
              ref={canvasRef}
              width={560}
              height={150}
              className="w-full cursor-crosshair bg-gray-50"
              onMouseDown={startDraw}
              onMouseMove={draw}
              onMouseUp={stopDraw}
              onMouseLeave={stopDraw}
              onTouchStart={startDraw}
              onTouchMove={draw}
              onTouchEnd={stopDraw}
            />
          </div>
          <div className="flex items-center justify-between mt-2">
            <p className="text-xs text-cw-muted">Sign with your mouse or finger</p>
            <button onClick={clearCanvas} className="text-xs text-cw-muted hover:text-cw-text">Clear</button>
          </div>
        </div>

        <button onClick={handleSign} disabled={signing} className="btn-primary w-full py-3 text-base">
          {signing ? 'Generating signed PDF…' : 'Submit Signature & Acknowledge Receipt'}
        </button>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        <p className="text-center text-xs text-cw-muted">
          City Wide Building Services · Boston, MA<br />
          This link expires 48 hours after issuance.
        </p>
      </div>
    </div>
  );
}
