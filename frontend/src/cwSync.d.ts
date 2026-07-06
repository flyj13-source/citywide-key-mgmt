// Bridge exposed by the Electron preload (desktop build only).
export interface CwSyncStatus {
  online: boolean;
  lastPullAt: string | null;
  queuedWrites: number;
  queuedAi: number;
  syncing: boolean;
  lastError: string | null;
}

interface CwSyncBridge {
  getStatus(): Promise<CwSyncStatus | null>;
  syncNow(): Promise<CwSyncStatus | null>;
  onStatus(cb: (status: CwSyncStatus) => void): () => void;
  isDesktop: boolean;
}

declare global {
  interface Window {
    cwSync?: CwSyncBridge;
  }
}

export {};
