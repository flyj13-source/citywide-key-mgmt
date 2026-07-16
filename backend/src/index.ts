import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';

import db, { DATABASE_FILE } from './lib/db';
import { autoSeedIfEmpty } from './lib/autoSeed';
import authRouter from './routes/auth';
import importRouter from './routes/import';
import accountsRouter from './routes/accounts';
import managersRouter from './routes/managers';
import assignmentsRouter from './routes/assignments';
import vaultRouter from './routes/vault';
import auditRouter from './routes/audit';
import staffRouter from './routes/staff';
import reportsRouter from './routes/reports';
import claudeRouter from './routes/claude';
import contractorsRouter from './routes/contractors';
import backupsRouter from './routes/backups';

// Catch crashes before the health check has a chance to respond
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

const app = express();
const PORT = process.env.PORT ?? 3001;

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
];
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '25mb' }));
app.use(morgan('dev'));

app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// ── Desktop offline sync: capture successful local mutations ────────────────
// When running inside Electron, every write that succeeds locally is appended
// to sync_queue so the sync engine can replay it against Render on reconnect.
if (process.env.CITYWIDE_DESKTOP === '1') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { enqueueMiddleware } = require('./lib/syncQueue');
  app.use('/api', enqueueMiddleware);
}

// ── Health check — registered first so Railway can reach it immediately ──────
app.get('/api/health', (_req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/accounts/import', importRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/managers', managersRouter);
app.use('/api/assignments', assignmentsRouter);
app.use('/api/vault', vaultRouter);
app.use('/api/audit', auditRouter);
app.use('/api/staff', staffRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/backups', backupsRouter);
app.use('/api/claude', claudeRouter);
app.use('/api/contractors', contractorsRouter);
// Public contractor routes (no JWT)
app.use('/api/contractor', contractorsRouter);

// ── Tier 3 boot self-check ──────────────────────────────────────────────────
// One grep-able line per start proving WHERE the DB lives and whether it is on
// the Render persistent disk. If it is not, data is ephemeral and every
// deploy/restart wipes it — make that impossible to miss in the logs.
export function bootSelfCheck(): string {
  const count = (sql: string): number => {
    try {
      return (Object.assign({}, db.prepare(sql).get()) as any).c as number;
    } catch {
      return -1;
    }
  };
  const tables = count("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table'");
  const customers = count("SELECT COUNT(*) AS c FROM accounts WHERE record_type = 'customer'");
  const ics = count("SELECT COUNT(*) AS c FROM accounts WHERE record_type = 'ic' OR record_type IS NULL");
  const onMount = DATABASE_FILE.startsWith('/data');

  const line = `BOOT: db=${DATABASE_FILE} onMount=${onMount} tables=${tables} customers=${customers} ics=${ics}`;
  console.log(line);
  if (!onMount) {
    console.log('\x1b[41m\x1b[97m WARNING: DATABASE IS EPHEMERAL — DATA WILL NOT PERSIST \x1b[0m');
    console.log(
      'WARNING: DATABASE IS EPHEMERAL — DATA WILL NOT PERSIST ' +
      `(DB_PATH=${DATABASE_FILE} is not on the /data mounted disk — set DB_PATH=/data/citywide.db)`
    );
  }
  return line;
}

// Only bind a port when run directly (node dist/index.js). When imported by the
// test suite we just want the `app` object for supertest — no open listener.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🔑  City Wide Boston Key Management API`);
    console.log(`    Server running on port ${PORT}`);
    console.log(`    Health: http://localhost:${PORT}/api/health`);

    // Seed runs AFTER the server is listening and the disk is mounted.
    // Guards inside autoSeedIfEmpty() are idempotent — safe on every restart.
    try {
      autoSeedIfEmpty();
    } catch (err) {
      console.error('[seed] autoSeedIfEmpty failed:', err);
    }

    bootSelfCheck();
    console.log(`    Login: cara@citywideboston.com / demo1234\n`);
  });
}

export default app;
