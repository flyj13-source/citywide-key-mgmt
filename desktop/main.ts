import { app, BrowserWindow, ipcMain, shell, net } from 'electron';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { autoUpdater } from 'electron-updater';

import { SyncEngine, SyncStatus } from './sync/engine';

// ── Auto-updater (silent: installs on next quit, no prompts) ─────────────────
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.autoDownload = true;
autoUpdater.logger = null; // suppress file logging; we use console below

autoUpdater.on('checking-for-update', () => console.log('[updater] checking for update'));
autoUpdater.on('update-available', (info) => console.log('[updater] update available:', info.version));
autoUpdater.on('update-not-available', () => console.log('[updater] up to date'));
autoUpdater.on('update-downloaded', (info) => console.log('[updater] downloaded', info.version, '— will install on next quit'));
autoUpdater.on('error', (err) => console.error('[updater] error:', err.message));

const PORT = 3001;
const REMOTE = 'https://citywide-backend-0xuj.onrender.com';

// ── Resource resolution (dev vs packaged) ───────────────────────────────────
// Packaged: extraResources land in process.resourcesPath/{backend,frontend}.
// Dev:      compiled desktop code lives in desktop/dist, siblings ../../{backend,frontend}.
const RES = app.isPackaged
  ? process.resourcesPath
  : path.join(__dirname, '..', '..');

const BACKEND_DIR = path.join(RES, 'backend', 'dist');
const SCHEMA_PATH = path.join(RES, 'backend', 'database', 'schema.sql');
const SEED_DB = path.join(RES, 'backend', 'seed', 'citywide.db'); // packaged copy
const SEED_DB_DEV = path.join(RES, 'backend', 'database', 'citywide.db'); // dev source
const FRONTEND_INDEX = path.join(RES, 'frontend', 'dist', 'index.html');

// %APPDATA%/CityWideKMS on Windows (app.getPath('userData') respects productName)
const DATA_DIR = app.getPath('userData');
const DB_FILE = path.join(DATA_DIR, 'citywide.db');

let mainWindow: BrowserWindow | null = null;
let engine: SyncEngine | null = null;

/** Copy the bundled seed DB into userData on first launch (empty-DB seed). */
function ensureSeededDatabase() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) return; // already have a local DB — keep offline data

  const template = fs.existsSync(SEED_DB) ? SEED_DB : SEED_DB_DEV;
  if (fs.existsSync(template)) {
    fs.copyFileSync(template, DB_FILE);
    // WAL sidecars from the template are stale for a fresh copy — drop them.
    for (const ext of ['-wal', '-shm']) {
      const s = template + ext;
      if (fs.existsSync(s)) {
        try { fs.copyFileSync(s, DB_FILE + ext); } catch { /* non-fatal */ }
      }
    }
    console.log(`[main] seeded local DB from ${path.basename(template)}`);
  } else {
    console.log('[main] no seed template found — backend will create an empty schema');
  }
}

/** Configure env then boot the compiled Express app inside this process. */
function bootBackend() {
  process.env.CITYWIDE_DESKTOP = '1';
  process.env.CITYWIDE_DB_DIR = DATA_DIR;
  process.env.CITYWIDE_SCHEMA_PATH = SCHEMA_PATH;
  process.env.CITYWIDE_BACKEND_DIR = BACKEND_DIR;
  process.env.PORT = String(PORT);
  // Secrets: prefer real env; fall back to the project defaults so the app runs
  // out of the box. Production installers should inject these.
  process.env.JWT_SECRET ||= 'citywide-boston-dev-secret-change-in-production';
  process.env.ENCRYPTION_KEY ||= '6369747977696465626f73746f6e6b657976617532303234212121';
  process.env.FRONTEND_URL ||= `http://localhost:${PORT}`;

  // Requiring the compiled entry self-starts the server (app.listen).
  require(path.join(BACKEND_DIR, 'index.js'));
  console.log(`[main] embedded backend booting on :${PORT}`);
}

/** Resolve once the health endpoint answers, so the window never loads early. */
function waitForBackend(timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`http://localhost:${PORT}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
      req.setTimeout(1000, () => req.destroy());
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) return reject(new Error('backend did not start'));
      setTimeout(tick, 250);
    };
    tick();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#111111',
    title: 'City Wide KMS',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(FRONTEND_INDEX);

  // Open external links (e.g. contractor portal) in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function broadcastStatus(status: SyncStatus) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('cw-sync:status', status);
  }
}

app.whenReady().then(async () => {
  ensureSeededDatabase();
  bootBackend();

  try {
    await waitForBackend();
  } catch (e) {
    console.error('[main]', e);
  }

  // Start the sync engine (connectivity polling, pull/push, AI queue flush).
  engine = new SyncEngine({
    remote: REMOTE,
    localPort: PORT,
    backendDir: BACKEND_DIR,
    onStatus: broadcastStatus,
    isOnline: () => net.isOnline(),
  });
  engine.start();

  ipcMain.handle('cw-sync:get-status', () => engine?.status ?? null);
  ipcMain.handle('cw-sync:sync-now', async () => { await engine?.syncNow(); return engine?.status; });

  createWindow();

  // Check for updates on launch (packaged only) then every 4 hours.
  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch((e) => console.error('[updater]', e.message));
    setInterval(() => {
      autoUpdater.checkForUpdates().catch((e) => console.error('[updater]', e.message));
    }, 4 * 60 * 60 * 1000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  engine?.stop();
  if (process.platform !== 'darwin') app.quit();
});
