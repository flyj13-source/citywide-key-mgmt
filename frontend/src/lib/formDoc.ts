import type { KeyFormFull } from './api';

// Renders a signed key form into a single, print-quality document and exports it
// as PNG, JPEG, or PDF — all from ONE canvas so every format is pixel-identical.
// Everything runs in the browser; the source data is the stored form record.

const CW_RED = '#C0272D';
const BLACK = '#1a1a1a';
const GRAY = '#6b6b68';
const LIGHT = '#f4f4f2';

// Logical page (letter ratio); backing store is 2× for crispness.
const W = 850;
const H = 1100;
const SCALE = 2;
const MARGIN = 60;

const partyLabel = (p: string) => (p === 'contractor' ? 'Contractor' : 'Employee');
const actionVerb = (a: string) => (a === 'return' ? 'Returned' : 'Received');

export function docTitle(form: { party_type: string; action: string }): string {
  return `${partyLabel(form.party_type)} Key ${form.action === 'return' ? 'Return' : 'Receipt'} Acknowledgement`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number): number {
  const words = text.split(/\s+/);
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, y);
      line = word;
      y += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) { ctx.fillText(line, x, y); y += lineHeight; }
  return y;
}

const agreementText = (form: { party_type: string; action: string }): string => {
  const who = form.party_type === 'contractor' ? 'contractor' : 'employee';
  if (form.action === 'return') {
    return `I, the undersigned ${who}, confirm that I have returned the key(s) listed above to City Wide Boston in good condition, and that I no longer retain any keys or access credentials for the account(s) noted, except where explicitly stated.`;
  }
  return `I, the undersigned ${who}, acknowledge that I have received the key(s) listed above and agree to: (1) safeguard all keys and access credentials, (2) not duplicate or share keys with unauthorized personnel, (3) return all keys immediately upon request or separation, and (4) report any lost or stolen keys to City Wide Boston within 24 hours.`;
};

export async function renderReceiptCanvas(form: KeyFormFull): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(SCALE, SCALE);
  ctx.textBaseline = 'alphabetic';

  // Background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // Header bar
  ctx.fillStyle = BLACK;
  ctx.fillRect(0, 0, W, 92);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 28px Helvetica, Arial, sans-serif';
  ctx.fillText('CITY WIDE BOSTON', MARGIN, 46);
  ctx.fillStyle = '#b8b8b8';
  ctx.font = '14px Helvetica, Arial, sans-serif';
  ctx.fillText('Key Management System', MARGIN, 70);
  ctx.fillStyle = CW_RED;
  ctx.fillRect(0, 92, W, 6);

  let y = 150;

  // Title
  ctx.fillStyle = BLACK;
  ctx.font = 'bold 24px Helvetica, Arial, sans-serif';
  ctx.fillText(docTitle(form), MARGIN, y);
  y += 34;

  // Field grid
  const drawField = (label: string, value: string) => {
    ctx.fillStyle = GRAY;
    ctx.font = 'bold 12px Helvetica, Arial, sans-serif';
    ctx.fillText(label.toUpperCase(), MARGIN, y);
    ctx.fillStyle = BLACK;
    ctx.font = '15px Helvetica, Arial, sans-serif';
    ctx.fillText(value || '—', MARGIN + 190, y);
    y += 26;
  };
  const signedDate = new Date(form.signed_at).toLocaleString('en-US', { timeZone: 'America/New_York' });
  drawField('Name', form.person_name);
  drawField('Type', partyLabel(form.party_type));
  drawField('Action', `${actionVerb(form.action)} key(s)`);
  if (form.person_email) drawField('Email', form.person_email);
  drawField('Date signed', signedDate);
  if (form.collected_by) drawField('Collected by', form.collected_by);
  y += 6;

  // Section helper
  const sectionHeader = (label: string) => {
    ctx.fillStyle = LIGHT;
    ctx.fillRect(MARGIN, y - 15, W - MARGIN * 2, 24);
    ctx.fillStyle = BLACK;
    ctx.font = 'bold 12px Helvetica, Arial, sans-serif';
    ctx.fillText(label.toUpperCase(), MARGIN + 8, y + 2);
    y += 28;
  };

  // Accounts / sites
  sectionHeader('Accounts / Sites');
  ctx.fillStyle = BLACK;
  ctx.font = '14px Helvetica, Arial, sans-serif';
  if (form.account_names.length === 0) {
    ctx.fillStyle = GRAY;
    ctx.fillText('None specified', MARGIN + 12, y);
    y += 22;
  } else {
    for (const acc of form.account_names) {
      ctx.fillStyle = CW_RED;
      ctx.fillText('•', MARGIN + 12, y);
      ctx.fillStyle = BLACK;
      y = wrapText(ctx, acc, MARGIN + 28, y, W - MARGIN * 2 - 40, 20);
      y += 2;
    }
  }
  y += 8;

  // Key details
  if (form.key_details) {
    sectionHeader('Key Details');
    ctx.fillStyle = BLACK;
    ctx.font = '14px Helvetica, Arial, sans-serif';
    y = wrapText(ctx, form.key_details, MARGIN + 4, y, W - MARGIN * 2 - 8, 20);
    y += 12;
  }

  // Notes
  if (form.notes) {
    sectionHeader('Notes');
    ctx.fillStyle = BLACK;
    ctx.font = '14px Helvetica, Arial, sans-serif';
    y = wrapText(ctx, form.notes, MARGIN + 4, y, W - MARGIN * 2 - 8, 20);
    y += 12;
  }

  // Agreement
  y += 4;
  ctx.fillStyle = GRAY;
  ctx.font = '13px Helvetica, Arial, sans-serif';
  y = wrapText(ctx, agreementText(form), MARGIN, y, W - MARGIN * 2, 19);
  y += 24;

  // Signature
  if (form.signature_data && form.signature_data.startsWith('data:image')) {
    try {
      const img = await loadImage(form.signature_data);
      const boxW = 340, boxH = 120;
      const scale = Math.min(boxW / img.width, boxH / img.height, 1);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.strokeStyle = '#e0e0dc';
      ctx.lineWidth = 1;
      ctx.strokeRect(MARGIN, y, boxW, boxH);
      ctx.drawImage(img, MARGIN + (boxW - w) / 2, y + (boxH - h) / 2, w, h);
      y += boxH + 10;
    } catch { /* signature render is best-effort */ }
  }
  ctx.strokeStyle = '#a8a8a8';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(MARGIN, y);
  ctx.lineTo(MARGIN + 300, y);
  ctx.stroke();
  y += 18;
  ctx.fillStyle = GRAY;
  ctx.font = '12px Helvetica, Arial, sans-serif';
  ctx.fillText(`${form.person_name} — Electronic Signature`, MARGIN, y);

  // Footer
  ctx.fillStyle = '#a8a8a8';
  ctx.font = '9px Helvetica, Arial, sans-serif';
  ctx.fillText(`SHA-256: ${form.signature_hash.slice(0, 48)}`, MARGIN, H - 44);
  ctx.fillText('City Wide Boston · Boston, MA · Generated by the Key Management System', MARGIN, H - 28);

  return canvas;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(',');
  const mime = /:(.*?);/.exec(head)?.[1] || 'application/octet-stream';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function baseName(form: KeyFormFull): string {
  const name = form.person_name.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
  const date = new Date(form.signed_at).toISOString().slice(0, 10);
  const action = form.action === 'return' ? 'Return' : 'Receipt';
  return `CityWide_${partyLabel(form.party_type)}_${action}_${name}_${date}`;
}

export async function downloadPng(form: KeyFormFull) {
  const canvas = await renderReceiptCanvas(form);
  triggerDownload(dataUrlToBlob(canvas.toDataURL('image/png')), `${baseName(form)}.png`);
}

export async function downloadJpeg(form: KeyFormFull) {
  const canvas = await renderReceiptCanvas(form);
  triggerDownload(dataUrlToBlob(canvas.toDataURL('image/jpeg', 0.95)), `${baseName(form)}.jpg`);
}

export async function downloadPdf(form: KeyFormFull) {
  // Lazy-load pdf-lib so it only ships when a PDF is actually generated.
  const { PDFDocument } = await import('pdf-lib');
  const canvas = await renderReceiptCanvas(form);
  const pngBytes = new Uint8Array(await dataUrlToBlob(canvas.toDataURL('image/png')).arrayBuffer());
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const img = await doc.embedPng(pngBytes);
  const margin = 24;
  const maxW = 612 - margin * 2;
  const maxH = 792 - margin * 2;
  const scale = Math.min(maxW / img.width, maxH / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  page.drawImage(img, { x: (612 - w) / 2, y: 792 - margin - h, width: w, height: h });
  const bytes = await doc.save();
  // Copy into a plain ArrayBuffer so it is a valid BlobPart regardless of the
  // Uint8Array's backing-buffer type.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  triggerDownload(new Blob([ab], { type: 'application/pdf' }), `${baseName(form)}.pdf`);
}
