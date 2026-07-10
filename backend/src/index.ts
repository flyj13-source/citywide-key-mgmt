import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';

import { autoSeedIfEmpty } from './lib/autoSeed';
import authRouter from './routes/auth';
import importRouter from './routes/import';
import accountsRouter from './routes/accounts';
import assignmentsRouter from './routes/assignments';
import vaultRouter from './routes/vault';
import auditRouter from './routes/audit';
import staffRouter from './routes/staff';
import reportsRouter from './routes/reports';
import claudeRouter from './routes/claude';
import contractorsRouter from './routes/contractors';

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
app.use('/api/assignments', assignmentsRouter);
app.use('/api/vault', vaultRouter);
app.use('/api/audit', auditRouter);
app.use('/api/staff', staffRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/claude', claudeRouter);
app.use('/api/contractors', contractorsRouter);
// Public contractor routes (no JWT)
app.use('/api/contractor', contractorsRouter);

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

  console.log(`    Login: cara@citywideboston.com / demo1234\n`);
});

export default app;
