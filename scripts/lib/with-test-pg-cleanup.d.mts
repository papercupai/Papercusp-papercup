/** Remove only dependency signal handlers that have actually been registered. */
export function unhookRegisteredExitSignals(exitHook: {
  hookedEvents(): string[];
  unhookEvent(event: string): void;
}): void;

export const PRIVATE_TEST_PG_RELEASE_TOKEN_ENV: 'PAPERCUSP_PRIVATE_TEST_PG_RELEASE_TOKEN';

/** Cache an owned stop and optional one-time preparation. Preparation failures
 * remain visible across retries without preventing the owned resource stop. */
export function createSingleFlightStop(
  stop: () => Promise<unknown>, beforeStop?: () => Promise<unknown>,
): () => Promise<unknown>;

/** Authenticate a direct child request, stop the owned private PG, and return its correlated receipt. */
export function createPrivateTestPgReleaseHandler(options: {
  token: string;
  stop: () => Promise<unknown>;
  respond(message: { kind: string; token: string; requestId: string; ok: boolean; error?: string }): Promise<void>;
}): (message: unknown) => Promise<boolean>;

/** Ask the owning with-test-pg parent to stop its cluster and await the matching acknowledgement. */
export function requestPrivateTestPgRelease(token: string, options?: {
  processRef?: NodeJS.Process;
  timeoutMs?: number;
}): Promise<true>;

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

/** Remove owned private state, retrying transient filesystem removal failures. */
export function removePrivateState<Path extends import('node:fs').PathLike>(
  path: Path,
  remove?: (path: Path, options: import('node:fs').RmOptions) => Promise<void>,
): Promise<void>;
