import { contextBridge, ipcRenderer } from 'electron';

export interface SyncStatus {
  online: boolean;
  lastPullAt: string | null;
  queuedWrites: number;
  queuedAi: number;
  syncing: boolean;
  lastError: string | null;
}

type StatusListener = (status: SyncStatus) => void;

// window.cwSync — read by Layout.tsx (online/offline footer) and the AI panel.
contextBridge.exposeInMainWorld('cwSync', {
  /** Current snapshot (also useful on first paint before the first push). */
  getStatus: (): Promise<SyncStatus | null> => ipcRenderer.invoke('cw-sync:get-status'),

  /** Force a pull/push/AI-flush cycle now. */
  syncNow: (): Promise<SyncStatus | null> => ipcRenderer.invoke('cw-sync:sync-now'),

  /** Subscribe to live status changes. Returns an unsubscribe fn. */
  onStatus: (cb: StatusListener) => {
    const handler = (_e: unknown, status: SyncStatus) => cb(status);
    ipcRenderer.on('cw-sync:status', handler);
    return () => ipcRenderer.removeListener('cw-sync:status', handler);
  },

  /** True inside the Electron desktop build (used to pick HashRouter). */
  isDesktop: true,
});
