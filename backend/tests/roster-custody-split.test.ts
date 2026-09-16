import { it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'v-'));
process.env.CITYWIDE_DB_DIR = D; delete process.env.DB_PATH;
process.env.JWT_SECRET='t'; process.env.ENCRYPTION_KEY=crypto.randomBytes(32).toString('hex'); process.env.SEED_PASSWORD='demo1234';
let app:any; let token=''; let db:DatabaseSync;
const auth=(r:any)=>r.set('Authorization',`Bearer ${token}`);
beforeAll(async()=>{ app=(await import('../src/index')).default; (await import('../src/lib/autoSeed')).autoSeedIfEmpty();
  const l=await request(app).post('/api/auth/login').send({email:'cara@citywideboston.com',password:'demo1234'}); token=l.body.token;
  db=new DatabaseSync(path.join(D,'citywide.db')); });
it('checked_out tracks custody, total_held tracks the grid', async () => {
  db.exec('DELETE FROM access_codes');
  db.exec('DELETE FROM access_codes');
  db.exec('DELETE FROM accounts; DELETE FROM key_assignments; DELETE FROM staff_managers');
  db.prepare("INSERT INTO staff_managers (name,manager_type,role_category,email,active) VALUES ('Jeremiah','account_manager','manager','j@cw.test',1)").run();
  const id=Number(db.prepare(`INSERT INTO accounts (ic_company_name,record_type,bc_client_number,account_manager,metal_keys,am_metal,am_keys) VALUES ('SITE A','customer','0101','Jeremiah',3,1,1)`).run().lastInsertRowid);
  await auth(request(app).post('/api/assignments/checkout')).send({account_id:id,holder:'Jeremiah',holder_email:'j@cw.test',holder_type:'employee',keys:[{type:'metal',qty:2}]});
  let m=(await auth(request(app).get('/api/staff-managers/roster?role=am'))).body.managers[0];
  expect(m.total_held).toBe(1);   // grid attribution
  expect(m.checked_out).toBe(2);  // open custody, multi-qty read correctly
  await auth(request(app).post('/api/assignments/checkin')).send({holder:'Jeremiah',account_id:id,keys:[{type:'metal',qty:2}]});
  m=(await auth(request(app).get('/api/staff-managers/roster?role=am'))).body.managers[0];
  expect(m.checked_out).toBe(0);  // custody closed
  expect(m.total_held).toBe(1);   // grid untouched — the divergence, now visible
});
