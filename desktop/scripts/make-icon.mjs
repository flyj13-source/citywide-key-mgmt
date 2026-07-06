// Generate desktop/build/icon.ico from the City Wide logo.
// macOS-only toolchain: uses `sips` to rasterize/resize, then packs a real
// PNG-embedded .ico container (no ImageMagick required).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.resolve(ROOT, '..', 'frontend', 'src', 'assets', 'cw-logo.png');
const OUT_DIR = path.join(ROOT, 'build');
const OUT = path.join(OUT_DIR, 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

fs.mkdirSync(OUT_DIR, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwicon-'));

// 1) Pad the (700×500) logo to a square on a white card, matching the sidebar.
const square = path.join(tmp, 'square.png');
execSync(
  `sips -s format png --padToHeightWidth 512 512 --padColor FFFFFF ${JSON.stringify(SRC)} --out ${JSON.stringify(square)}`,
  { stdio: 'ignore' }
);

// 2) Resize to each icon size.
const pngs = SIZES.map((size) => {
  const p = path.join(tmp, `icon-${size}.png`);
  execSync(`sips -z ${size} ${size} ${JSON.stringify(square)} --out ${JSON.stringify(p)}`, { stdio: 'ignore' });
  return { size, buf: fs.readFileSync(p) };
});

// 3) Assemble the ICO (6-byte header + 16-byte dir entries + PNG blobs).
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);           // reserved
header.writeUInt16LE(1, 2);           // type: icon
header.writeUInt16LE(pngs.length, 4); // image count

const entries = [];
const blobs = [];
let offset = 6 + pngs.length * 16;
for (const { size, buf } of pngs) {
  const e = Buffer.alloc(16);
  e.writeUInt8(size >= 256 ? 0 : size, 0); // width  (0 ⇒ 256)
  e.writeUInt8(size >= 256 ? 0 : size, 1); // height (0 ⇒ 256)
  e.writeUInt8(0, 2);                       // palette
  e.writeUInt8(0, 3);                       // reserved
  e.writeUInt16LE(1, 4);                    // color planes
  e.writeUInt16LE(32, 6);                   // bits per pixel
  e.writeUInt32LE(buf.length, 8);           // size of PNG data
  e.writeUInt32LE(offset, 12);              // offset of PNG data
  offset += buf.length;
  entries.push(e);
  blobs.push(buf);
}

fs.writeFileSync(OUT, Buffer.concat([header, ...entries, ...blobs]));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`✓ wrote ${OUT} (${fs.statSync(OUT).size} bytes, ${pngs.length} sizes)`);
