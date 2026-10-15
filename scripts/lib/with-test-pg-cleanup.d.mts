export interface CleanupOwnedTestStateOptions {
  child?: { pid?: number } | null;
  childLifetime?: { terminate(): Promise<void> } | null;
  profileProcess?: { pid?: number } | null;
  profileLifetime?: { terminate(): Promise<void> } | null;
  /** Reap private ledger-owned scopes while the private database is available. */
  stopManagedTasks?: (() => Promise<void>) | null;
  pg?: { stop(): Promise<void>; health?(): unknown } | null;
  dataDir: string;
  runtimeRoot?: string | null;
  isolatedRuntime: boolean;
  /** Shared failures from pre-cleanup IPC and background instrumentation. */
  receiptFailures?: Error[];
  /** Wait for background receipts after stopping every receipt producer. */
  drainReceipts?: () => Promise<void>;
  cleanupStage(stage: string, detail?: Record<string, unknown>): void | Promise<void>;
  observePrivatePgStop(): () => void;
}

/** Attempts every independent stop and preserves state if any stop is unverified. */
export function cleanupOwnedTestState(state: CleanupOwnedTestStateOptions): Promise<void>;
