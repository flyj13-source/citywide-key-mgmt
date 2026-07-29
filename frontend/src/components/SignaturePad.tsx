import { forwardRef, useImperativeHandle, useRef } from 'react';

export interface SignaturePadHandle {
  /** PNG data URL, or null if nothing has been drawn. */
  toDataURL: () => string | null;
  clear: () => void;
  isEmpty: () => boolean;
}

// Reusable e-signature canvas — mouse + touch, transparent background so the
// stroke composites cleanly onto whatever document it is embedded in. Exposes
// an imperative handle (toDataURL / clear / isEmpty) so parents read it on save.
const SignaturePad = forwardRef<SignaturePadHandle, { width?: number; height?: number }>(
  function SignaturePad({ width = 560, height = 160 }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const drawing = useRef(false);
    const dirty = useRef(false);

    const pos = (e: React.MouseEvent | React.TouchEvent) => {
      const canvas = canvasRef.current!;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const p = 'touches' in e ? e.touches[0] : (e as React.MouseEvent);
      return { x: (p.clientX - rect.left) * scaleX, y: (p.clientY - rect.top) * scaleY };
    };

    const start = (e: React.MouseEvent | React.TouchEvent) => {
      drawing.current = true;
      const ctx = canvasRef.current!.getContext('2d')!;
      const { x, y } = pos(e);
      ctx.beginPath();
      ctx.moveTo(x, y);
    };
    const move = (e: React.MouseEvent | React.TouchEvent) => {
      if (!drawing.current) return;
      e.preventDefault();
      const ctx = canvasRef.current!.getContext('2d')!;
      const { x, y } = pos(e);
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#1a1a1a';
      ctx.lineTo(x, y);
      ctx.stroke();
      dirty.current = true;
    };
    const stop = () => { drawing.current = false; };

    const clear = () => {
      const canvas = canvasRef.current!;
      canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height);
      dirty.current = false;
    };

    useImperativeHandle(ref, () => ({
      toDataURL: () => (dirty.current ? canvasRef.current!.toDataURL('image/png') : null),
      clear,
      isEmpty: () => !dirty.current,
    }));

    return (
      <div>
        <div className="border-2 border-dashed border-cw-border rounded-lg overflow-hidden" style={{ touchAction: 'none' }}>
          <canvas
            ref={canvasRef}
            width={width}
            height={height}
            className="w-full cursor-crosshair bg-gray-50"
            onMouseDown={start}
            onMouseMove={move}
            onMouseUp={stop}
            onMouseLeave={stop}
            onTouchStart={start}
            onTouchMove={move}
            onTouchEnd={stop}
          />
        </div>
        <div className="flex items-center justify-between mt-2">
          <p className="text-xs text-cw-muted">Sign with your mouse or finger</p>
          <button type="button" onClick={clear} className="text-xs text-cw-muted hover:text-[#C0272D]">Clear</button>
        </div>
      </div>
    );
  }
);

export default SignaturePad;
