import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';
import { encrypt } from '../src/lib/crypto';

const DB_PATH = path.join(__dirname, 'citywide.db');
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// ─── Manager ───────────────────────────────────────────────
const hash = bcrypt.hashSync('demo1234', 10);
db.prepare('INSERT INTO managers (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(
  'Cara Angeloni', 'cara@citywideboston.com', hash, 'admin'
);
console.log('✓ Manager seeded: cara@citywideboston.com / demo1234');

// ─── Accounts ──────────────────────────────────────────────
interface AccountSeed {
  name: string;
  total_keys?: number;
  am_keys?: number;
  ccm_keys?: number;
  contractor_keys?: number;
  key_code?: string;
  lockbox?: string | number;
  alarm_code?: string;
  door_code?: string;
  has_fob?: number;
  notes?: string;
}

const accounts: AccountSeed[] = [
  { name: 'AFC Methuen', total_keys: 6, ccm_keys: 1, contractor_keys: 5, alarm_code: '0700', notes: 'Same key works for all 6 locations. 3 keys for southern IC Crew and 2 for North Andover and Methuen crew' },
  { name: 'AFC North Andover', total_keys: 6, ccm_keys: 1, contractor_keys: 5, alarm_code: '2727', notes: 'Same key works for all 6 locations' },
  { name: 'AFC Urgent Care Bedford', total_keys: 6, ccm_keys: 1, contractor_keys: 5, alarm_code: '2727' },
  { name: 'AFC Urgent Care Burlington', total_keys: 6, ccm_keys: 1, contractor_keys: 5, alarm_code: '2727' },
  { name: 'AFC Urgent Care Stoneham', total_keys: 6, ccm_keys: 1, contractor_keys: 5, alarm_code: '2727' },
  { name: 'AFC Urgent Care Waltham', total_keys: 6, ccm_keys: 1, contractor_keys: 5, alarm_code: '2727' },
  { name: 'Beverly Bank', total_keys: 4, contractor_keys: 3, am_keys: 0, alarm_code: '7100', lockbox: '4' },
  { name: 'Beverly Bank Loan Center', total_keys: 2, contractor_keys: 2, alarm_code: '7100' },
  { name: 'Beverly Bank Salem', total_keys: 2, contractor_keys: 2, alarm_code: '7100' },
  { name: 'Beverly Bank 48 Enon Street', total_keys: 2, contractor_keys: 2, alarm_code: '7100' },
  { name: 'Lahey Health Behavioral Services Suite 2150', total_keys: 2, ccm_keys: 1, contractor_keys: 1, door_code: '7573*', notes: 'Supply Closet Code 7901' },
  { name: 'Lahey Health Behavioral Services 35 Congress', total_keys: 2, contractor_keys: 2 },
  { name: 'Winchester Savings Bank Cambridge St', total_keys: 1, contractor_keys: 1, alarm_code: '51515', notes: 'Call American Alarm before entering. Phone password 102531' },
  { name: 'Winchester Savings Bank Arlington', total_keys: 1, contractor_keys: 1, alarm_code: '51515', notes: 'Call American Alarm before entering' },
  { name: "St. Jean's Credit Union Highland Ave Salem", total_keys: 4, am_keys: 1, ccm_keys: 1, contractor_keys: 1, has_fob: 1, alarm_code: '9433', door_code: '5420*', notes: '4 key fobs. Call alarm company before entering. HIGHLAND AND LYNN USE SAME FOBS' },
  { name: "St. Jean's Credit Union Lynn", total_keys: 4, am_keys: 1, ccm_keys: 1, contractor_keys: 1, has_fob: 1, alarm_code: '9433', door_code: '5420*' },
  { name: 'Members Plus Credit Union Medford', total_keys: 2, contractor_keys: 2, has_fob: 1, alarm_code: '4922', notes: '2 Key FOBs' },
  { name: 'Members Plus Credit Union Plymouth', total_keys: 3, ccm_keys: 1, contractor_keys: 2, has_fob: 1 },
  { name: 'Essex Group Management Lynn', total_keys: 3, contractor_keys: 3, door_code: '9151#', alarm_code: '2020' },
  { name: 'DaVita Woburn Dialysis', total_keys: 2, contractor_keys: 2, door_code: '3243' },
  { name: 'Greentown Labs', total_keys: 10, am_keys: 1, ccm_keys: 1, contractor_keys: 8, has_fob: 1, notes: 'IC has 6 key fobs + 2 sets of closet keys' },
  { name: 'RK Centers Marlborough', total_keys: 6, am_keys: 2, ccm_keys: 2, contractor_keys: 2, notes: 'Each has entry key and supply key' },
  { name: 'Mill No. 5', total_keys: 10, am_keys: 4, ccm_keys: 4, contractor_keys: 10, has_fob: 1, notes: '2 elevator keys, 4 dispenser keys, 1 dumpster key, 2 fobs, 2 stair keys, 2 supply closet keys' },
  { name: 'Qinetiq Waltham', total_keys: 4, am_keys: 1, contractor_keys: 3, alarm_code: '65534', has_fob: 1, notes: 'Contractor has 3 key cards, AM has one' },
  { name: 'Ferguson Burlington', total_keys: 4, contractor_keys: 4, notes: 'Lanyard: front door, janitor closet, dumpster, dispenser key' },
  { name: 'Spectrum Health Systems Weymouth', total_keys: 3, contractor_keys: 1 },
  { name: 'Longfellow Club Wayland', total_keys: 4, ccm_keys: 1, contractor_keys: 2, lockbox: '21' },
  { name: 'Congregation BNai Shalom', total_keys: 3, am_keys: 1, ccm_keys: 1, contractor_keys: 1 },
  { name: 'BCM Controls Corp', total_keys: 4, ccm_keys: 1, contractor_keys: 2, has_fob: 1, notes: '4 key fobs #15670 15617 15613 15624' },
  { name: 'Haartz Corp', total_keys: 4, ccm_keys: 2, contractor_keys: 1 },
  { name: 'New England Utility Company', total_keys: 5, contractor_keys: 2 },
  { name: 'Sanghavi Law Office', total_keys: 0, door_code: '40915', notes: 'Alarm is auto-disarmed 4:30pm-7pm' },
  { name: 'School House at Lower Mills', total_keys: 2, contractor_keys: 1, door_code: '02468', lockbox: '30', notes: '2 master keys or use door code to get in' },
  { name: 'Asplundh Electrical', total_keys: 3, ccm_keys: 1, contractor_keys: 2, has_fob: 1, alarm_code: '395000', notes: '3 key fobs with master indoor key on site. Key Box code for master key is 0395' },
  { name: 'Cintas First Aid Woburn', total_keys: 1, contractor_keys: 1, door_code: '652165' },
  { name: 'HITEC Sensor Developments', total_keys: 4, has_fob: 1, lockbox: '42', alarm_code: '2241', notes: '2 key fobs exterior, 2 keys interior office. To Set: 2241+2 Away. To disarm: 2241+1 Off' },
  { name: 'PastorMed Dr Yuko McColgan', total_keys: 2, ccm_keys: 1, contractor_keys: 1, alarm_code: '2120' },
  { name: 'Barton Associates', total_keys: 3, ccm_keys: 1, contractor_keys: 2, door_code: '1300#', notes: 'No alarm code needed — building self activates at 11:30pm' },
  { name: 'Middlesex Digestive Health', total_keys: 1, contractor_keys: 1, alarm_code: '1234', notes: '1 Key IC only - requested more' },
  { name: 'Jim Organic Coffee', total_keys: 1, contractor_keys: 1, alarm_code: '619' },
  { name: 'Atlantic Plywood', total_keys: 1, contractor_keys: 1, alarm_code: '374936' },
  { name: 'Graybar Worcester', total_keys: 2, contractor_keys: 2, alarm_code: '101675', notes: '1 door key and 1 dumpster key' },
  { name: 'Locus Robotics', total_keys: 0, ccm_keys: 1, has_fob: 1, door_code: '1919', alarm_code: '1919', lockbox: '20' },
  { name: 'Murray Hills 27 Cambridge', total_keys: 1, contractor_keys: 1, alarm_code: '1234 Stay' },
  { name: 'KS Company Trust 1309 Beacon', total_keys: 0, door_code: 'TEAM*', notes: 'Door code listed is for back parking lot door' },
  { name: 'Clarke Distribution Boston', total_keys: 0, door_code: '1500*', notes: 'No keys, door code 1500*' },
  { name: 'Arsenal Apartments', total_keys: 4, am_keys: 1, contractor_keys: 3, has_fob: 1, notes: 'Key Fobs: 1 for AM, 3 for Crew' },
  { name: 'Ashland Properties', total_keys: 3, ccm_keys: 1, contractor_keys: 1, lockbox: '3', notes: '1 master key received 8-18-16' },
  { name: 'Plumb House', total_keys: 3, ccm_keys: 1, contractor_keys: 1, lockbox: '28' },
  { name: 'Soundown Inc', total_keys: 3, contractor_keys: 2, lockbox: '32' },
  { name: 'IDEXX Laboratories', total_keys: 5, am_keys: 1, ccm_keys: 1, contractor_keys: 3, has_fob: 1 },
  { name: 'Walnut Hill School', total_keys: 3, contractor_keys: 3 },
  { name: 'Atlas Distributing', total_keys: 2, contractor_keys: 2, alarm_code: '4455' },
  { name: 'FedEx Freight Northborough', total_keys: 3, contractor_keys: 3 },
  { name: 'FedEx Ground Northborough', total_keys: 2, contractor_keys: 2 },
  { name: 'Planned Parenthood Marlborough', total_keys: 2, contractor_keys: 2, alarm_code: '8810' },
  { name: 'Planned Parenthood Worcester', total_keys: 2, contractor_keys: 2 },
  { name: 'Planned Parenthood Boston', total_keys: 3, ccm_keys: 1, contractor_keys: 2 },
  { name: 'Building Pathways', total_keys: 2, ccm_keys: 1, contractor_keys: 1, door_code: '4422' },
  { name: 'Dearborn Academy', total_keys: 3, contractor_keys: 3 },
  { name: 'Evergreen Day School', total_keys: 2, contractor_keys: 2 },
  { name: 'More Than Words Boston', total_keys: 3, ccm_keys: 1, contractor_keys: 2 },
  { name: 'More Than Words Waltham', total_keys: 2, contractor_keys: 2 },
  { name: 'Wistia', total_keys: 4, am_keys: 1, ccm_keys: 1, contractor_keys: 2, has_fob: 1 },
  { name: 'ATI Physical Therapy Acton', total_keys: 2, contractor_keys: 2, alarm_code: '5566' },
  { name: 'Lowell Five Cent Savings', total_keys: 3, contractor_keys: 3, alarm_code: '7722' },
  { name: 'Middlesex Gastroenterology', total_keys: 2, contractor_keys: 2 },
  { name: 'Olympia Moving Storage', total_keys: 2, contractor_keys: 2 },
  { name: 'Peterson School Woburn', total_keys: 3, contractor_keys: 3 },
  { name: 'WiTricity', total_keys: 4, am_keys: 1, contractor_keys: 3, has_fob: 1 },
  { name: 'Haffner Oil', total_keys: 2, contractor_keys: 2, alarm_code: '3311' },
  { name: 'Berry Global Devens', total_keys: 4, contractor_keys: 4 },
  { name: 'Ideal Tape', total_keys: 3, contractor_keys: 3 },
  { name: 'A123 Systems', total_keys: 5, am_keys: 1, contractor_keys: 4, has_fob: 1 },
  { name: 'Stilla Technologies', total_keys: 2, ccm_keys: 1, contractor_keys: 1 },
  { name: 'Concord Oil', total_keys: 3, contractor_keys: 3, alarm_code: '8899' },
  { name: 'Cityside Subaru', total_keys: 4, contractor_keys: 4 },
  { name: 'James L McKeown Boys Girls Club', total_keys: 3, ccm_keys: 1, contractor_keys: 2 },
  { name: 'Advanced Instruments', total_keys: 4, ccm_keys: 1, contractor_keys: 3, has_fob: 1 },
  { name: 'Atrenne Computing Solutions', total_keys: 3, contractor_keys: 3 },
  { name: 'Charles River Bank Bellingham', total_keys: 2, contractor_keys: 2, alarm_code: '6644' },
  { name: 'Charles River Bank Medway', total_keys: 2, contractor_keys: 2, alarm_code: '6644' },
  { name: 'Charles River Bank Mendon', total_keys: 2, contractor_keys: 2, alarm_code: '6644' },
  { name: 'Owens and Minor', total_keys: 4, contractor_keys: 4 },
  { name: 'NSG Life Safety', total_keys: 2, contractor_keys: 2 },
  { name: 'Gilson JCC', total_keys: 5, am_keys: 1, ccm_keys: 1, contractor_keys: 3, has_fob: 1 },
  { name: 'Road to Responsibility Braintree', total_keys: 2, contractor_keys: 2 },
  { name: 'Road to Responsibility Norwell', total_keys: 2, contractor_keys: 2 },
  { name: 'Road to Responsibility Hingham', total_keys: 2, contractor_keys: 2 },
  { name: 'Road to Responsibility Taunton', total_keys: 2, contractor_keys: 2 },
  { name: 'Remtec', total_keys: 3, contractor_keys: 3 },
  { name: 'Victory Packaging', total_keys: 3, contractor_keys: 3 },
  { name: 'Shawmut Corporation', total_keys: 4, am_keys: 1, contractor_keys: 3 },
  { name: 'Weston Pediatrics', total_keys: 2, ccm_keys: 1, contractor_keys: 1 },
  { name: 'Anew Adult Day Care', total_keys: 3, contractor_keys: 3 },
  { name: 'Abel Womack', total_keys: 2, contractor_keys: 2 },
  { name: 'Allen Brothers Northeast', total_keys: 3, contractor_keys: 3, alarm_code: '5577' },
  { name: 'Home Market Foods Norwood', total_keys: 4, contractor_keys: 4 },
  { name: 'Altid Enterprises', total_keys: 2, contractor_keys: 2 },
  { name: 'American Superconductor', total_keys: 4, am_keys: 1, contractor_keys: 3, has_fob: 1 },
  { name: 'ConforMIS', total_keys: 3, ccm_keys: 1, contractor_keys: 2 },
  { name: 'Datacon', total_keys: 2, contractor_keys: 2 },
  { name: 'Fishman Transducers', total_keys: 3, contractor_keys: 3 },
  { name: 'Gebsco Realty Littleton', total_keys: 2, contractor_keys: 2, lockbox: '15' },
  { name: 'Gebsco Realty Sudbury', total_keys: 2, contractor_keys: 2, lockbox: '16' },
  { name: 'Massachusetts Mills Apartments', total_keys: 5, am_keys: 1, ccm_keys: 1, contractor_keys: 3, has_fob: 1 },
  { name: 'Qinetiq Devens', total_keys: 4, am_keys: 1, contractor_keys: 3, has_fob: 1 },
  { name: 'Qinetiq Franklin', total_keys: 3, contractor_keys: 3 },
  { name: 'Rayus Radiology Chelmsford', total_keys: 2, contractor_keys: 2 },
  { name: 'Stoneham Bank Billerica', total_keys: 2, contractor_keys: 2, alarm_code: '3344' },
  { name: 'Stoneham Bank Stoneham', total_keys: 2, contractor_keys: 2, alarm_code: '3344' },
  { name: 'North Shore Orthopedics', total_keys: 3, ccm_keys: 1, contractor_keys: 2 },
  { name: 'Birch Tree Montessori', total_keys: 2, contractor_keys: 2 },
  { name: 'Salem Hospital Marblehead', total_keys: 4, am_keys: 1, ccm_keys: 1, contractor_keys: 2 },
  { name: 'Wenham Museum', total_keys: 2, contractor_keys: 2 },
  { name: 'Republic Services Haverhill', total_keys: 3, contractor_keys: 3 },
  { name: 'Georgetown Library', total_keys: 2, contractor_keys: 2, alarm_code: '7788' },
  { name: 'New England Pickleball', total_keys: 3, contractor_keys: 3 },
  { name: 'BILH Primary Care Danvers', total_keys: 3, ccm_keys: 1, contractor_keys: 2 },
  { name: 'Middleton Family Medicine', total_keys: 2, contractor_keys: 2 },
  { name: 'Munters Amesbury', total_keys: 3, contractor_keys: 3 },
  { name: 'NETTTS Haverhill', total_keys: 2, contractor_keys: 2 },
  { name: 'NETTTS N. Andover', total_keys: 2, contractor_keys: 2 },
  { name: 'Putnam Pantry', total_keys: 2, contractor_keys: 2 },
  { name: "St. Michael's School", total_keys: 3, contractor_keys: 3 },
  { name: "St. Jean's Credit Union Lafayette St", total_keys: 3, am_keys: 1, ccm_keys: 1, contractor_keys: 1, has_fob: 1, alarm_code: '9433' },
  { name: "St. Jean's Credit Union Revere", total_keys: 3, am_keys: 1, ccm_keys: 1, contractor_keys: 1, has_fob: 1 },
  { name: 'Windham Professionals', total_keys: 2, contractor_keys: 2 },
  { name: 'All Creatures Veterinary Hospital', total_keys: 2, contractor_keys: 2 },
  { name: 'Axis New England', total_keys: 4, ccm_keys: 1, contractor_keys: 3, has_fob: 1 },
  { name: 'First Church Boxford', total_keys: 2, contractor_keys: 2 },
  { name: 'GMGI Blackburn', total_keys: 3, ccm_keys: 1, contractor_keys: 2 },
  { name: 'GMGI Main St', total_keys: 3, ccm_keys: 1, contractor_keys: 2 },
  { name: 'The Quarto Group', total_keys: 4, am_keys: 1, ccm_keys: 1, contractor_keys: 2 },
  { name: 'Triumph Modular', total_keys: 3, contractor_keys: 3 },
  { name: 'Opt Industries', total_keys: 3, contractor_keys: 3, has_fob: 1 },
  { name: 'AFC Urgent Care Boston', total_keys: 4, ccm_keys: 1, contractor_keys: 3, alarm_code: '2727' },
  { name: 'Element Care Brighton', total_keys: 2, ccm_keys: 1, contractor_keys: 1 },
  { name: 'Boston Public Schools Lombardo', total_keys: 3, ccm_keys: 1, contractor_keys: 2 },
  { name: 'Wellan Montessori', total_keys: 2, contractor_keys: 2 },
  { name: '1047 Commonwealth Ave', total_keys: 4, am_keys: 1, ccm_keys: 1, contractor_keys: 2, has_fob: 1 },
  { name: 'Tellier Properties Concord Ave', total_keys: 3, contractor_keys: 3 },
  { name: 'UN1F1ED2 Global Packaging', total_keys: 4, contractor_keys: 4 },
  { name: 'UN1F1ED2 Global Packaging Lancaster', total_keys: 3, contractor_keys: 3 },
  { name: 'Pall Corporation', total_keys: 5, am_keys: 1, contractor_keys: 4, has_fob: 1 },
  { name: 'Brandon School', total_keys: 3, contractor_keys: 3 },
  { name: 'CE Power', total_keys: 2, contractor_keys: 2, alarm_code: '6655' },
  { name: 'CLP Resources', total_keys: 2, contractor_keys: 2 },
  { name: 'Donnegan Systems', total_keys: 2, contractor_keys: 2 },
  { name: 'HBM Inc', total_keys: 3, contractor_keys: 3 },
  { name: 'NECC Student Center', total_keys: 4, ccm_keys: 1, contractor_keys: 3 },
  { name: 'RH White', total_keys: 3, contractor_keys: 3 },
  { name: 'Security Engineered Machinery', total_keys: 3, contractor_keys: 3 },
  { name: 'South Middlesex Opportunity Council', total_keys: 4, ccm_keys: 1, contractor_keys: 3 },
  { name: 'Spectrum Health Faris Center', total_keys: 3, contractor_keys: 3 },
  { name: 'Touchstone Community School', total_keys: 3, contractor_keys: 3 },
  { name: 'Veolia Marlborough', total_keys: 4, contractor_keys: 4 },
  { name: 'Willard Veterinary Clinic', total_keys: 2, contractor_keys: 2 },
];

const insertAccount = db.prepare(`
  INSERT INTO accounts (name, total_keys, am_keys, ccm_keys, contractor_keys, key_code, lockbox, alarm_code_encrypted, alarm_code_iv, door_code_encrypted, door_code_iv, has_fob, notes, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
`);

const seenNames = new Set<string>();
let inserted = 0;
for (const a of accounts) {
  if (seenNames.has(a.name)) continue;
  seenNames.add(a.name);

  let alarm_enc: string | null = null, alarm_iv: string | null = null;
  let door_enc: string | null = null, door_iv: string | null = null;

  if (a.alarm_code) {
    const { encrypted, iv } = encrypt(a.alarm_code);
    alarm_enc = encrypted; alarm_iv = iv;
  }
  if (a.door_code) {
    const { encrypted, iv } = encrypt(a.door_code);
    door_enc = encrypted; door_iv = iv;
  }

  insertAccount.run(
    a.name, a.total_keys ?? 0, a.am_keys ?? 0, a.ccm_keys ?? 0, a.contractor_keys ?? 0,
    a.key_code ?? null, a.lockbox ? String(a.lockbox) : null,
    alarm_enc, alarm_iv, door_enc, door_iv,
    a.has_fob ?? 0, a.notes ?? null
  );
  inserted++;
}
console.log(`✓ Seeded ${inserted} accounts`);

// ─── Staff Key Holders ─────────────────────────────────────
const staffAssignments = [
  { staff: 'Craig Kolesar', accounts: ['AFC Methuen','All Creatures Veterinary Hospital','Axis New England','Barton Associates','First Church Boxford','GMGI Blackburn','GMGI Main St','Middleton Family Medicine','Munters Amesbury','NETTTS Haverhill','NETTTS N. Andover','Putnam Pantry',"St. Michael's School","St. Jean's Credit Union Highland Ave Salem","St. Jean's Credit Union Lafayette St","St. Jean's Credit Union Lynn","St. Jean's Credit Union Revere",'Stoneham Bank Billerica','Stoneham Bank Stoneham','The Quarto Group','Windham Professionals','North Shore Orthopedics','Birch Tree Montessori','Salem Hospital Marblehead','Wenham Museum','Republic Services Haverhill','Georgetown Library','New England Pickleball'] },
  { staff: 'Domingo Reinoso', accounts: ['Axis New England','Barton Associates','First Church Boxford','GMGI Blackburn','GMGI Main St','Lahey Health Behavioral Services Suite 2150','Middleton Family Medicine','Munters Amesbury','NETTTS Haverhill','NETTTS N. Andover','Putnam Pantry',"St. Michael's School","St. Jean's Credit Union Highland Ave Salem","St. Jean's Credit Union Lafayette St","St. Jean's Credit Union Lynn","St. Jean's Credit Union Revere",'The Quarto Group','North Shore Orthopedics','Birch Tree Montessori','BILH Primary Care Danvers','Salem Hospital Marblehead','Wenham Museum','Georgetown Library'] },
  { staff: 'Juan Carlos', accounts: ['IDEXX Laboratories','RK Centers Marlborough','Walnut Hill School','UN1F1ED2 Global Packaging','Pall Corporation','Atlas Distributing','Brandon School','CE Power','CLP Resources','Congregation BNai Shalom','Donnegan Systems','FedEx Freight Northborough','FedEx Ground Northborough','HBM Inc','NECC Student Center','Planned Parenthood Marlborough','Planned Parenthood Worcester','RH White','Security Engineered Machinery','South Middlesex Opportunity Council','Spectrum Health Faris Center','Touchstone Community School','Veolia Marlborough'] },
  { staff: 'Ben Pritchard', accounts: ['1047 Commonwealth Ave','Building Pathways','Dearborn Academy','Evergreen Day School','Greentown Labs','More Than Words Boston','More Than Words Waltham','Planned Parenthood Boston','Wellan Montessori','Wistia','Opt Industries','AFC Urgent Care Boston','Element Care Brighton','Boston Public Schools Lombardo'] },
  { staff: 'Francisco Santana', accounts: ['ATI Physical Therapy Acton','Haartz Corp','Lowell Five Cent Savings','Middlesex Gastroenterology','Olympia Moving Storage','Peterson School Woburn','Stoneham Bank Billerica','Stoneham Bank Stoneham','WiTricity','Haffner Oil','Triumph Modular','Berry Global Devens','Ideal Tape'] },
  { staff: 'Steve Gloria', accounts: ['Tellier Properties Concord Ave','A123 Systems','Atlantic Plywood','Stilla Technologies','Concord Oil','Qinetiq Waltham','Cityside Subaru','James L McKeown Boys Girls Club'] },
  { staff: 'Odvin Rivas', accounts: ['Advanced Instruments','Atrenne Computing Solutions','Charles River Bank Bellingham','Charles River Bank Medway','Charles River Bank Mendon','Members Plus Credit Union Plymouth','Owens and Minor','Plumb House','NSG Life Safety','Gilson JCC','Road to Responsibility Braintree','Road to Responsibility Norwell','Road to Responsibility Hingham','Road to Responsibility Taunton','Remtec','Willard Veterinary Clinic','Victory Packaging','Shawmut Corporation'] },
  { staff: 'Felix Maldonado', accounts: ['Tellier Properties Concord Ave','Weston Pediatrics','Anew Adult Day Care','Concord Oil','Abel Womack','Cityside Subaru','James L McKeown Boys Girls Club'] },
  { staff: 'Jesse Rose', accounts: ['Allen Brothers Northeast','Home Market Foods Norwood','Owens and Minor','Qinetiq Franklin','AFC Urgent Care Boston'] },
  { staff: 'Nick Valcourt', accounts: ['Altid Enterprises','American Superconductor','ConforMIS','Datacon','Fishman Transducers','Gebsco Realty Littleton','Gebsco Realty Sudbury','Massachusetts Mills Apartments','Qinetiq Devens','UN1F1ED2 Global Packaging Lancaster','Shawmut Corporation','Rayus Radiology Chelmsford'] },
];

const insertStaff = db.prepare('INSERT INTO staff_key_holders (staff_name, account) VALUES (?, ?)');
let staffRows = 0;
for (const s of staffAssignments) {
  for (const acc of s.accounts) {
    insertStaff.run(s.staff, acc);
    staffRows++;
  }
}
console.log(`✓ Seeded ${staffRows} staff key assignments across ${staffAssignments.length} staff members`);

// ─── Sample active assignments ─────────────────────────────
const sampleAssignments = [
  { account: 'Greentown Labs', assignee: 'Ben Pritchard', keys: '3 key fobs + closet key', due: '2026-06-15' },
  { account: 'Mill No. 5', assignee: 'Craig Kolesar', keys: '2 fobs + elevator key', due: '2026-06-20' },
  { account: 'Qinetiq Waltham', assignee: 'Steve Gloria', keys: '1 key card', due: '2026-05-30' },
  { account: 'RK Centers Marlborough', assignee: 'Juan Carlos', keys: 'Entry key + supply key', due: '2026-07-01' },
  { account: "St. Jean's Credit Union Highland Ave Salem", assignee: 'Craig Kolesar', keys: '2 key fobs', due: '2026-06-30' },
  { account: 'Arsenal Apartments', assignee: 'Ben Pritchard', keys: '3 key fobs', due: '2026-05-15' },
  { account: 'Haartz Corp', assignee: 'Francisco Santana', keys: '2 keys', due: '2026-05-20' },
  { account: 'Members Plus Credit Union Medford', assignee: 'Odvin Rivas', keys: '2 key fobs', due: '2026-06-10' },
];

const insertAssignment = db.prepare(`
  INSERT INTO key_assignments (account_id, account_name, assignee, key_type, keys_held, due_at, status)
  SELECT id, ?, ?, 'physical', ?, ?, 'checked_out' FROM accounts WHERE name = ?
`);

for (const a of sampleAssignments) {
  insertAssignment.run(a.account, a.assignee, a.keys, a.due, a.account);
}
console.log(`✓ Seeded ${sampleAssignments.length} active key assignments`);

db.prepare('INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)').run(
  'system_seed', null, null, 'System', JSON.stringify({ accounts: inserted, staff: staffRows, version: '1.0' })
);

console.log('\n✅ Database seeded successfully!');
console.log('   Login: cara@citywideboston.com / demo1234\n');
db.close();
