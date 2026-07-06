import { pushQueue, loadSyncHelpers } from './queue';
import { flushAi, pendingAiCount } from './aiQueue';

export interface SyncStatus {
  online: boolean;
  lastPullAt: string | null;
  queuedWrites: number;
  queuedAi: number;
  syncing: boolean;
  lastError: string | null;
}

export interface EngineOptions {
  remote: string;                 // Render base URL
  localPort: number;              // embedded backend port
  backendDir: string;             // backend/dist absolute path
  onStatus: (s: SyncStatus) => void;
  isOnline: () => boolean;        // net.isOnline()
}

const HEALTH_MS = 30_000;         // connectivity poll
const PULL_MS = 5 * 60_000;       // periodic pull while online
const TOKEN_KEY = 'render_sync_token';
const LAST_PULL_KEY = 'last_pull_at';

// Pull these resources from Render → upsert into local SQLite (server wins).
const PULL_ENDPOINTS: Array<{ path: string; table: string; field: string }> = [
  { path: '/api/accounts?limit=1000', table: 'accounts', field: 'accounts' },
  { path: '/api/assignments?limit=1000', table: 'key_assignments', field: 'assignments' },
  { path: '/api/audit?limit=1000', table: 'audit_log', field: 'logs' },
  { path: '/api/contractors', table: 'contractors', field: '' }, // returns a bare array
];

export class SyncEngine {
  status: SyncStatus = {
    online: false,
    lastPullAt: null,
    queuedWrites: 0,
    queuedAi: 0,
    syncing: false,
    lastError: null,
  };

  private opts: EngineOptions;
  private helpers: ReturnType<typeof loadSyncHelpers>;
  private timer: NodeJS.Timeout | null = null;
  private lastPullTs = 0;
  private wasOnline = false;

  constructor(opts: EngineOptions) {
    this.opts = opts;
    this.helpers = loadSyncHelpers(opts.backendDir);
    this.status.lastPullAt = this.helpers.getMeta(LAST_PULL_KEY);
    this.refreshCounts();
  }

  start() {
    this.emit();
    this.tick(); // immediate first check
    this.timer = setInterval(() => this.tick(), HEALTH_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Manual trigger from the UI (Sync now). */
  async syncNow() {
    const reachable = await this.ping();
    this.setOnline(reachable);
    if (reachable) await this.runCycle();
    else this.emit();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async tick() {
    const reachable = this.opts.isOnline() ? await this.ping() : false;
    const cameOnline = reachable && !this.wasOnline;
    this.setOnline(reachable);

    if (reachable) {
      const stale = Date.now() - this.lastPullTs > PULL_MS;
      if (cameOnline || stale) await this.runCycle();
    } else {
      this.emit();
    }
    this.wasOnline = reachable;
  }

  private async runCycle() {
    if (this.status.syncing) return;
    this.status.syncing = true;
    this.status.lastError = null;
    this.emit();
    try {
      const token = await this.ensureToken();
      if (token) {
        await this.pull(token);                                   // server → local
        await pushQueue({                                         // local → server
          remote: this.opts.remote,
          token,
          backendDir: this.opts.backendDir,
        });
      }
      await flushAi(this.opts.backendDir);                        // answer queued AI
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      const firstFailure = !this.status.lastError; // audit once per failure streak
      this.status.lastError = msg;
      if (firstFailure) {
        try { this.helpers.auditSyncError(msg); } catch { /* db may be busy */ }
      }
    } finally {
      this.status.syncing = false;
      this.refreshCounts();
      this.emit();
    }
  }

  /** GET /api/health on Render — true when reachable. */
  private async ping(): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${this.opts.remote}/api/health`, { signal: ctrl.signal });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Obtain (and cache) a Render JWT using sync credentials. */
  private async ensureToken(): Promise<string | null> {
    const cached = this.helpers.getMeta(TOKEN_KEY);
    if (cached) return cached;

    const email = process.env.CITYWIDE_SYNC_EMAIL || 'cara@citywideboston.com';
    const password = process.env.CITYWIDE_SYNC_PASSWORD || 'demo1234';
    try {
      const res = await fetch(`${this.opts.remote}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { token?: string };
      if (data.token) this.helpers.setMeta(TOKEN_KEY, data.token);
      return data.token ?? null;
    } catch {
      return null;
    }
  }

  /** Pull server resources and upsert locally (server wins on pull). */
  private async pull(token: string) {
    const headers = { Authorization: `Bearer ${token}` };
    for (const ep of PULL_ENDPOINTS) {
      const res = await fetch(`${this.opts.remote}${ep.path}`, { headers });
      if (res.status === 401) {
        // Token expired — drop it so the next cycle re-authenticates.
        this.helpers.setMeta(TOKEN_KEY, '');
        throw new Error('sync token expired');
      }
      if (!res.ok) continue;
      const body = await res.json();
      const rows: any[] = ep.field ? body[ep.field] : body;
      if (Array.isArray(rows) && rows.length) this.helpers.upsertRows(ep.table, rows);
    }
    const now = new Date().toISOString();
    this.helpers.setMeta(LAST_PULL_KEY, now);
    this.status.lastPullAt = now;
    this.lastPullTs = Date.now();
  }

  private setOnline(online: boolean) {
    this.status.online = online;
  }

  private refreshCounts() {
    this.status.queuedWrites = this.helpers.pendingCount();
    this.status.queuedAi = pendingAiCount(this.opts.backendDir);
  }

  private emit() {
    this.opts.onStatus({ ...this.status });
  }
}
