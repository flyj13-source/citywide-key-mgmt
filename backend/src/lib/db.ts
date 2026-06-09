import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';

// Use process.cwd() (always the backend/ root) rather than __dirname so the
// path is correct whether running via ts-node (src/lib/) or node dist/index.js.
const dbDir = path.join(process.cwd(), 'database');
const DB_PATH = path.join(dbDir, 'citywide.db');

// Ensure the database directory exists (Render cold starts from a clean image)
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);

// Apply WAL mode and foreign keys
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Apply schema (CREATE TABLE IF NOT EXISTS — safe to run every startup)
const schemaPath = path.join(process.cwd(), 'database', 'schema.sql');
if (fs.existsSync(schemaPath)) {
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);
}

export default db;
