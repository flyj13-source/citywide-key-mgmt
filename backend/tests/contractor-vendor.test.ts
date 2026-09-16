// BC Vendor Number on a contractor invitation.
//
// The number is what ties a signature to a registry record: a name alone is
// ambiguous, since one contact can work for two vendors and one vendor can have
// two contacts. These cover the column, the bidirectional lookup that saves
// re-entry, and the number reaching the signed document.
import { it, expect, describe, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';

const D = fs.mkdtempSync(path.join(os.tmpdir(), 'contractor-'));
process.env.CITYWIDE_DB_DIR = D; delete process.env.DB_PATH;
process.env.JWT_SECRET = 't';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SEED_PASSWORD = 'demo1234';

let app: any; let token = ''; let db: DatabaseSync;
const auth = (r: any) => r.set('Authorization', `Bearer ${token}`);
const obj = (r: any) => Object.assign({}, r);

const addIC = (o: Record<string, any>) => {
  const cols = Object.keys(o);
  return Number(db.prepare(
    `INSERT INTO accounts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
  ).run(...cols.map((c) => o[c])).lastInsertRowid);
};

beforeAll(async () => {
  app = (await import('../src/index')).default;
  (await import('../src/lib/autoSeed')).autoSeedIfEmpty();
  const l = await request(app).post('/api/auth/login')
    .send({ email: 'cara@citywideboston.com', password: 'demo1234' });
  token = l.body.token;
  db = new DatabaseSync(path.join(D, 'citywide.db'));
});

beforeEach(() => {
  db.exec('DELETE FROM access_codes');
  db.exec('DELETE FROM key_assignments; DELETE FROM accounts; DELETE FROM contractors');
});

describe('SCHEMA', () => {
  it('contractors carries bc_vendor_number', () => {
    const cols = (db.prepare('PRAGMA table_info(contractors)').all() as any[]).map((c) => obj(c).name);
    expect(cols).toContain('bc_vendor_number');
  });
});

describe('BIDIRECTIONAL IC LOOKUP', () => {
  beforeEach(() => {
    addIC({
      ic_company_name: 'ALVES CLEANING SERVICES INC', record_type: 'ic',
      bc_vendor_number: '02014100020', ic_email: 'alves@vendor.test',
      ic_primary_contact: 'Maria Alves',
    });
    addIC({
      ic_company_name: 'ALVES JANITORIAL LLC', record_type: 'ic',
      bc_vendor_number: '02014100077', ic_email: 'aj@vendor.test',
      ic_primary_contact: 'Rui Alves',
    });
    addIC({
      ic_company_name: 'SHARP CLEANING CORPORATION', record_type: 'ic',
      bc_vendor_number: '02014100044', ic_email: 'sharp@vendor.test',
    });
  });

  it('a vendor number resolves to exactly one record, with name and email', async () => {
    const res = await auth(request(app).get('/api/contractors/ic-lookup?vendor=02014100020'));
    expect(res.status).toBe(200);
    expect(res.body.by).toBe('vendor');
    expect(res.body.matches).toHaveLength(1);
    expect(res.body.matches[0]).toMatchObject({
      company: 'ALVES CLEANING SERVICES INC',
      contact: 'Maria Alves',
      email: 'alves@vendor.test',
      bc_vendor_number: '02014100020',
    });
    // The named contact is the better default for "Contractor Name" — they are
    // the person who signs.
    expect(res.body.matches[0].name).toBe('Maria Alves');
  });

  it('falls back to the company name when no contact is on file', async () => {
    const res = await auth(request(app).get('/api/contractors/ic-lookup?vendor=02014100044'));
    expect(res.body.matches[0].name).toBe('SHARP CLEANING CORPORATION');
  });

  it('a name returns EVERY match so the caller can disambiguate', async () => {
    const res = await auth(request(app).get('/api/contractors/ic-lookup?name=ALVES'));
    expect(res.body.by).toBe('name');
    expect(res.body.matches).toHaveLength(2);
    expect(res.body.matches.map((m: any) => m.bc_vendor_number).sort())
      .toEqual(['02014100020', '02014100077']);
  });

  it('searches the primary contact as well as the company', async () => {
    const res = await auth(request(app).get('/api/contractors/ic-lookup?name=Rui'));
    expect(res.body.matches).toHaveLength(1);
    expect(res.body.matches[0].company).toBe('ALVES JANITORIAL LLC');
  });

  it('never returns customers, only IC records', async () => {
    addIC({
      ic_company_name: 'ALVES MEDICAL CENTER', record_type: 'customer',
      bc_client_number: '01014200001',
    });
    const res = await auth(request(app).get('/api/contractors/ic-lookup?name=ALVES'));
    expect(res.body.matches.map((m: any) => m.company)).not.toContain('ALVES MEDICAL CENTER');
  });

  it('excludes archived IC records', async () => {
    addIC({
      ic_company_name: 'GONE CLEANING', record_type: 'ic',
      bc_vendor_number: '02014100999', archived: 1,
    });
    const res = await auth(request(app).get('/api/contractors/ic-lookup?vendor=02014100999'));
    expect(res.body.matches).toEqual([]);
  });

  it('is not shadowed by the magic-token route, and requires auth', async () => {
    // Unauthenticated must be refused, not silently treated as a token lookup.
    const anon = await request(app).get('/api/contractors/ic-lookup?vendor=02014100020');
    expect([401, 403]).toContain(anon.status);
    // And it is reachable at all — a 404 here would mean /:token swallowed it.
    const ok = await auth(request(app).get('/api/contractors/ic-lookup?vendor=02014100020'));
    expect(ok.status).toBe(200);
  });

  it('an empty query returns nothing rather than the whole registry', async () => {
    const res = await auth(request(app).get('/api/contractors/ic-lookup'));
    expect(res.body.matches).toEqual([]);
    expect(res.body.by).toBeNull();
  });
});

describe('INVITE STORES THE VENDOR NUMBER', () => {
  it('saves it on a new invitation', async () => {
    const res = await auth(request(app).post('/api/contractors/invite')).send({
      name: 'Maria Alves', email: 'alves@vendor.test',
      bc_vendor_number: '02014100020', assigned_accounts: ['SITE A'],
    });
    expect(res.status).toBe(200);
    const row = obj(db.prepare('SELECT * FROM contractors WHERE email = ?').get('alves@vendor.test') as any);
    expect(row.bc_vendor_number).toBe('02014100020');
  });

  it('is optional — an invite without one still works', async () => {
    const res = await auth(request(app).post('/api/contractors/invite')).send({
      name: 'No Vendor', email: 'nv@vendor.test', assigned_accounts: [],
    });
    expect(res.status).toBe(200);
    const row = obj(db.prepare('SELECT * FROM contractors WHERE email = ?').get('nv@vendor.test') as any);
    expect(row.bc_vendor_number).toBeNull();
  });

  it('a re-invite with a blank field does not erase a number already on file', async () => {
    await auth(request(app).post('/api/contractors/invite')).send({
      name: 'Maria Alves', email: 'alves@vendor.test',
      bc_vendor_number: '02014100020', assigned_accounts: [],
    });
    await auth(request(app).post('/api/contractors/invite')).send({
      name: 'Maria Alves', email: 'alves@vendor.test', assigned_accounts: ['SITE B'],
    });
    const row = obj(db.prepare('SELECT * FROM contractors WHERE email = ?').get('alves@vendor.test') as any);
    expect(row.bc_vendor_number).toBe('02014100020');
    // …but the rest of the re-invite did apply.
    expect(JSON.parse(row.assigned_accounts)).toEqual(['SITE B']);
  });

  it('a re-invite CAN change the number when one is supplied', async () => {
    await auth(request(app).post('/api/contractors/invite')).send({
      name: 'Maria Alves', email: 'alves@vendor.test',
      bc_vendor_number: '02014100020', assigned_accounts: [],
    });
    await auth(request(app).post('/api/contractors/invite')).send({
      name: 'Maria Alves', email: 'alves@vendor.test',
      bc_vendor_number: '02014100077', assigned_accounts: [],
    });
    const row = obj(db.prepare('SELECT * FROM contractors WHERE email = ?').get('alves@vendor.test') as any);
    expect(row.bc_vendor_number).toBe('02014100077');
  });
});

describe('THE SIGNED DOCUMENT NAMES THE VENDOR', () => {
  const invite = async (vendor?: string) => {
    const res = await auth(request(app).post('/api/contractors/invite')).send({
      name: 'Maria Alves', email: 'alves@vendor.test',
      ...(vendor ? { bc_vendor_number: vendor } : {}),
      assigned_accounts: ['RIDGEWAY PLAZA'],
    });
    return res.body.token as string;
  };

  it('the magic-link payload carries it', async () => {
    const t = await invite('02014100020');
    const res = await request(app).get(`/api/contractor/${t}`);
    expect(res.status).toBe(200);
    expect(res.body.bc_vendor_number).toBe('02014100020');
  });

  it('the generated PDF renders it', async () => {
    const t = await invite('02014100020');
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const sign = await request(app).post(`/api/contractor/${t}/sign`).send({ signature_data: png });
    expect(sign.status).toBe(200);

    const row = obj(db.prepare('SELECT pdf_path FROM contractors WHERE email = ?').get('alves@vendor.test') as any);
    expect(fs.existsSync(row.pdf_path)).toBe(true);

    const text = pdfText(fs.readFileSync(row.pdf_path));
    expect(text).toContain('BC Vendor Number');
    expect(text).toContain('02014100020');
    // …and on the signature line, so the attribution is unambiguous.
    expect(text).toMatch(/Maria Alves \(BC Vendor 02014100020\)/);
  });

  it('a contractor with no number still produces a valid PDF', async () => {
    const t = await invite();
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const sign = await request(app).post(`/api/contractor/${t}/sign`).send({ signature_data: png });
    expect(sign.status).toBe(200);
    const row = obj(db.prepare('SELECT pdf_path FROM contractors WHERE email = ?').get('alves@vendor.test') as any);
    const text = pdfText(fs.readFileSync(row.pdf_path));
    // The label is still printed, so a reader can see the field was left blank
    // rather than wondering whether the document simply omits it.
    expect(text).toContain('BC Vendor Number');
    expect(text).toContain('Not provided');
  });
});

/** Pull the drawn text out of a pdf-lib document (hex-encoded Tj operands). */
function pdfText(buf: Buffer): string {
  const zlib = require('zlib');
  let raw = '';
  const re = /stream\r?\n([\s\S]*?)endstream/g;
  const s = buf.toString('latin1');
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    try { raw += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { /* not deflate */ }
  }
  const out: string[] = [];
  const tj = /<([0-9A-Fa-f]+)>\s*Tj/g;
  let t: RegExpExecArray | null;
  while ((t = tj.exec(raw)) !== null) out.push(Buffer.from(t[1], 'hex').toString('latin1'));
  return out.join('\n');
}
