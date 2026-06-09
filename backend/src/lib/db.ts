import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';

// Use process.cwd() (always the backend/ root) rather than __dirname so the
// path is correct whether we're running via ts-node (src/lib/) or compiled
// node dist/index.js (dist/src/lib/).
const DB_PATH = path.join(process.cwd(), 'database', 'citywide.db');

const db = new DatabaseSync(DB_PATH);

// Apply WAL mode and foreign keys
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Run schema on first open
const schemaPath = path.join(process.cwd(), 'database', 'schema.sql');
if (fs.existsSync(schemaPath)) {
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);
}

export default db;
