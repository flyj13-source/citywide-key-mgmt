import { PDFDocument, PDFFont, PDFImage, PDFPage, rgb } from 'pdf-lib';
import fs from 'fs';
import path from 'path';

// City Wide brand palette (shared with the front-end / QuickStart guide style).
export const CW_RED = rgb(0.753, 0.153, 0.176);   // #C0272D
export const CW_CHARCOAL = rgb(0.102, 0.102, 0.102); // #1a1a1a
export const CW_GREEN = rgb(0.176, 0.478, 0.227);  // #2d7a3a
export const CW_GRAY = rgb(0.42, 0.42, 0.408);
export const CW_LIGHT = rgb(0.95, 0.95, 0.95);
export const CW_BORDER = rgb(0.88, 0.88, 0.867);
export const WHITE = rgb(1, 1, 1);

// The CW logo is bundled into the backend (backend/src/assets) so PDFs are
// self-contained on Render. If it is ever missing (e.g. a slimmed container
// image), branding degrades gracefully to the charcoal bar + text — never an
// exception.
const LOGO_CANDIDATES = [
  path.join(__dirname, '../assets/cw-logo.png'),        // dist/lib → dist/assets (if copied)
  path.join(__dirname, '../../src/assets/cw-logo.png'), // dist/lib → src/assets (Render: full tree)
  path.join(process.cwd(), 'src/assets/cw-logo.png'),
];

let cachedLogoBytes: Buffer | null | undefined;
function logoBytes(): Buffer | null {
  if (cachedLogoBytes !== undefined) return cachedLogoBytes;
  for (const p of LOGO_CANDIDATES) {
    try {
      if (fs.existsSync(p)) { cachedLogoBytes = fs.readFileSync(p); return cachedLogoBytes; }
    } catch { /* try next */ }
  }
  cachedLogoBytes = null;
  return null;
}

export async function embedLogo(doc: PDFDocument): Promise<PDFImage | null> {
  const bytes = logoBytes();
  if (!bytes) return null;
  try {
    return await doc.embedPng(bytes);
  } catch {
    return null;
  }
}

/**
 * Draw the branded page header: charcoal bar, a white panel holding the CW logo
 * top-left, a red accent stripe under the bar, and the title/subtitle text.
 * Returns the Y coordinate just below the header where body content can begin.
 */
export function drawBrandedHeader(
  page: PDFPage,
  fonts: { bold: PDFFont; regular: PDFFont },
  logo: PDFImage | null,
  title: string,
  subtitle: string,
): number {
  const { width, height } = page.getSize();
  const barH = 84;

  // Charcoal header bar
  page.drawRectangle({ x: 0, y: height - barH, width, height: barH, color: CW_CHARCOAL });
  // Red accent stripe
  page.drawRectangle({ x: 0, y: height - barH - 4, width, height: 4, color: CW_RED });

  // White panel + logo, top-left
  const panelX = 36, panelY = height - barH + 14, panelW = 116, panelH = barH - 28;
  page.drawRectangle({ x: panelX, y: panelY, width: panelW, height: panelH, color: WHITE });
  if (logo) {
    const maxW = panelW - 16, maxH = panelH - 12;
    const scale = Math.min(maxW / logo.width, maxH / logo.height);
    const w = logo.width * scale, h = logo.height * scale;
    page.drawImage(logo, { x: panelX + (panelW - w) / 2, y: panelY + (panelH - h) / 2, width: w, height: h });
  } else {
    page.drawText('CITY WIDE', { x: panelX + 12, y: panelY + panelH / 2 - 4, size: 12, font: fonts.bold, color: CW_CHARCOAL });
  }

  // Title + subtitle to the right of the panel
  const textX = panelX + panelW + 20;
  page.drawText(title, { x: textX, y: height - 40, size: 17, font: fonts.bold, color: WHITE });
  page.drawText(subtitle, { x: textX, y: height - 60, size: 10, font: fonts.regular, color: rgb(0.7, 0.7, 0.7) });

  return height - barH - 4 - 24; // below the accent stripe, with padding
}

export function drawFooter(page: PDFPage, font: PDFFont, note: string): void {
  page.drawText(note, { x: 36, y: 24, size: 7, font, color: rgb(0.6, 0.6, 0.6) });
  page.drawText('City Wide Building Services · Boston, MA · Key Management System', {
    x: 36, y: 14, size: 7, font, color: rgb(0.6, 0.6, 0.6),
  });
}
