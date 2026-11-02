export interface TaskBudgetInput {
  workerBudget: number | string;
  memoryBudgetMb: number | string;
  memoryBudgetScope?: string;
  sharedMemoryBudgetMb?: number;
  workerMemoryMb: number | string;
  maxConcurrentTasks?: number | string;
  reserveWorkers?: number | string;
  taskCgroupPidsMax?: number | string | null;
  pidsPerConcurrentTask?: number | string;
  pidsReserve?: number | string;
}

/** Bounded descriptor read shared by native receipt and continuation readers. */
export function readNativeArtifactBytes(file: string, byteLength: number, byteLimit: number,
  recordRead?: (count: number) => void): Buffer;
export interface NativeArtifactPin { ref: string; sha256: string; byteLength: number; segment?: number; }
export interface NativeCustodyIdentity { workspace: string; harness: string; runId: string; }
export interface NativeCustodyAuxiliary {
  role: string; state: 'produced' | 'not-requested' | 'not-produced' | 'not-applicable' | 'unavailable';
  path?: string; reason?: string; captureError?: string;
}
export interface NativeCustodyGroup {
  id: string; attempt: 'primary' | 'detail'; selected: string[]; runner: 'vitest' | 'node' | 'unsupported';
  armed: boolean; out: string | null; cwd?: string; auxiliary: NativeCustodyAuxiliary[];
  /** Inputs to the original Node load preload's termination-receipt producer. */
  processSources?: { preload: string | null; workspace: string | null; root: string | null };
}
export interface NativeCustodyLocator {
  manifest: NativeArtifactPin; identity: NativeCustodyIdentity; expectedHash: string;
  /** Producer capture seal; retain independently of any replacement manifest. */
  inventoryHash: string;
}
export interface NativeCustodyFamily {
  family: 'A' | 'B' | 'C' | 'D'; state: string; producer: string; reason?: string;
  entries: Array<{ original: string; artifact: NativeArtifactPin;
    /** An oversized OUT is reconstructed from these ordered ordinary capture objects.
     * artifact is the first part; sha256 covers the retained prefix (the whole OUT when complete). */
    chunked?: { byteLength: number; sha256: string; complete: boolean;
      parts: Array<{ offset: number; artifact: NativeArtifactPin }> } }>;
}
export interface NativeCustodyFamilyLimit { objects: number; bytes: number; }
export interface NativeCustodyLimits {
  objects: number; bytes: number; objectBytes: number; referenceOccurrences?: number;
  families?: Record<'A' | 'B' | 'C' | 'D' | 'auxiliary', NativeCustodyFamilyLimit>;
}
export interface NativeCustodyRetainedGroup {
  id: string; attempt: 'primary' | 'detail'; families: NativeCustodyFamily[];
  captureComplete: boolean | null;
  references: Array<{ location: string; codeRef: string; sha256: string; byteLength: number }>;
  referenceArtifacts?: Array<{ codeRef: string; sha256: string; byteLength: number }>;
  referenceGaps?: string[];
  auxiliary: Array<NativeCustodyAuxiliary & { artifact?: NativeArtifactPin }>;
  protocol?: unknown;
}
export interface NativeCustodyManifest {
  schemaVersion: 'native-proof-custody-v1' | 'native-proof-custody-v2' | 'native-proof-custody-v3';
  identity: NativeCustodyIdentity; expected: NativeCustodyGroup[];
  expectedHash: string; groups: NativeCustodyRetainedGroup[]; gaps: string[]; predecessor: NativeCustodyLocator | null;
  limits: NativeCustodyLimits;
  /** Bytes and objects read against the capture budgets (retained AND rejected objects). */
  bytesRead: number; bytesReadByFamily?: Record<'A' | 'B' | 'C' | 'D' | 'auxiliary', number>;
  objectsRead?: number; objectsReadByFamily?: Record<'A' | 'B' | 'C' | 'D' | 'auxiliary', number>;
  archiveLimits?: { segments: number; objects: number };
  segments?: Array<{ index: number; artifact: NativeArtifactPin; bytesRead: number; objectsRead: number;
    bytesReadByFamily: Record<'A' | 'B' | 'C' | 'D' | 'auxiliary', number>;
    objectsReadByFamily: Record<'A' | 'B' | 'C' | 'D' | 'auxiliary', number> }>;
  verdicts: { custody: 'complete' | 'partial'; execution: unknown; protocol: 'unqualified';
    producerRetirement: 'not-performed'; cleanup: unknown; nativeProof: 'unqualified'; acceptance: 'unmeasured' };
}
export function retainNativeProofPacket(directory: string, input: {
  identity: NativeCustodyIdentity; expected: NativeCustodyGroup[];
  observations: Array<{ id: string; out: string | null; captureComplete?: boolean }>;
  execution?: unknown; cleanup?: unknown; predecessor?: NativeCustodyLocator;
}): { directory: string; locator: NativeCustodyLocator; status: 'complete' | 'partial'; verified: true; manifest: NativeCustodyManifest };
export function verifyNativeProofPacket(directory: string, locator: NativeCustodyLocator,
  contract: { identity: NativeCustodyIdentity; expected: NativeCustodyGroup[] }):
  { status: 'complete' | 'partial'; verified: true; manifest: NativeCustodyManifest };
/** Custody only: these helpers never create execution or acceptance proof. */
export function createNativeArtifactPersister(evidenceRoot: string): {
  root: string; persist: (bytes: Buffer, suffix: string) => NativeArtifactPin;
};
export function retainReporterEvaluatorArtifacts(payload: unknown, out: string,
  persist: (bytes: Buffer, suffix: string) => NativeArtifactPin):
  NonNullable<ReturnType<typeof writeBudgetedTaskNativeExecutionReceipt>['observation']['processTrace']['reporter']['evaluatorArtifacts']>;
export function readNativeProcessTraceArtifacts(out: string, startedAtMs?: number, finishedAtMs?: number): {
  sourceRoot: string;
  rows: Array<{ row: Record<string, any>; bytes: Buffer }>;
  population: { artifactLimit: number; artifactsVisited: number; eventByteLimit: number;
    eventBytesRead: number; complete: boolean; truncatedBy: string | null };
};

export interface NativeNpmLifecycleDiagnostics {
  scope: 'direct-root-npm-spawn-close'; status: 'observed' | 'unknown'; gaps: string[];
  root: { pid: number; processIdentity: string;
    entry: { ref: string; sha256: string; byteLength: number } } | null;
  spans: Array<{ event: string; script: string; observerPid: number; observerProcessIdentity: string;
    childPid: number; childIdentity: string; command: string; argv: string[]; cwd: string;
    shell: boolean | string; stdioAccessible: { stdout: boolean; stderr: boolean };
    startedAtMs: number; closedAtMs: number; exitCode: number | null; signal: string | null;
    spawn: { ref: string; sha256: string; byteLength: number };
    close: { ref: string; sha256: string; byteLength: number } }>;
}

export function syncBudgetedTaskNativeExecutionReceipt(saved: ReturnType<typeof writeBudgetedTaskNativeExecutionReceipt>): void;
export function writeBudgetedTaskNativeExecutionReceipt(evidenceRoot: string, input: {
  task: string; attempt: string; cwd: string; command: string[]; originalCommand?: string | null;
  /** Requested command and environment before diagnostic preload/wrapper additions. Values are never retained. */
  invocation?: { command: string[]; environmentSha256: string };
  /** Captured physical provenance; independently validated for current-only composition. */
  currentExecution?: { schemaVersion: 1; fingerprint: string | null; childPid: number; childIdentity: string;
    sourceBefore: { commit: string; clean: boolean } | null; sourceAfter: { commit: string; clean: boolean } | null };
  startedAtMs: number; finishedAtMs: number; exitCode: number | null; signal: string | null;
  error: string | null; captureComplete: boolean; stdout: Buffer; stderr: Buffer;
  before?: Array<{ path: string; sha256: string }> | null;
  after?: Array<{ path: string; sha256: string }> | null;
  processTrace?: { out: string; rootPid: number | null } | null;
}): { root: string; receipt: { ref: string; sha256: string; byteLength: number };
  logs: Record<'stdout' | 'stderr', { ref: string; sha256: string; byteLength: number }>;
  observation: { kind: 'affected-task-native-execution'; sourceInputsUnchanged: boolean;
    orderedChainQualified: false; runtimeClosure: 'unmeasured'; operationalAcceptance: false;
    steps: never[]; gaps: string[];
    processTrace: { scope: string; gaps: string[];
      /** Referenced returned-source bytes only; never a complete runtime census. */
      loaderSources?: { scope: 'referenced-loader-source'; status: 'retained' | 'partial' | 'unobserved';
        referenceLimit: number; artifactByteLimit: number; totalByteLimit: number;
        referencesVisited: number; bytesRead: number; bytesRetained: number; gaps: string[];
        entries: Array<{ processIdentity: string; pid: number; loadId: number; url: string;
          artifact: { ref: string; sha256: string; byteLength: number } }> };
      /** Observed direct root npm spans only; inherited shell streams remain unknown. */
      npmLifecycle: NativeNpmLifecycleDiagnostics;
      /** Diagnostic bytes and observed process/time binding; never a pass qualification. */
      reporter: { status: 'bound' | 'unknown'; gaps: string[];
        artifact: { ref: string; sha256: string; byteLength: number } | null;
        /** Referenced protocol bytes only; duplicates retain their observation locations. */
        evaluatorArtifacts?: { scope: 'referenced-evaluator-code'; status: 'retained' | 'partial' | 'unobserved';
          referenceLimit: number; artifactByteLimit: number; totalByteLimit: number;
          referencesVisited: number; bytesRead: number; bytesRetained: number; gaps: string[];
          entries: Array<{ location: string; id: string;
            artifact: { ref: string; sha256: string; byteLength: number } }> };
        process: { pid: number; ppid: number; processIdentity: string;
          entry: { ref: string; sha256: string; byteLength: number };
          exit: { ref: string; sha256: string; byteLength: number } | null;
          lifecycle: { childPid: number; childIdentity: string;
            spawn: { ref: string; sha256: string; byteLength: number };
            close: { ref: string; sha256: string; byteLength: number } } | null;
          startedAtMs: number; finishedAtMs: number } | null };
      /** Completeness is for the directory scan, not shell/runtime coverage. */
      population: { artifactLimit: number; artifactsVisited: number; eventByteLimit: number;
        eventBytesRead: number; complete: boolean; truncatedBy: 'artifact-count' | 'event-bytes' | null } | null;
      streams: Array<{ processIdentity: string; pid: number; role: string; scope: string;
        observedByteLength: number; captureComplete: boolean;
        artifact: { ref: string; sha256: string; byteLength: number } }>;
      events: Array<{ [key: string]: unknown; artifact: { ref: string; sha256: string; byteLength: number } }> };
    execution: { command: string[]; cwd: string; startedAtMs: number; finishedAtMs: number;
      childWallMs: number; exitCode: number | null; signal: string | null; error: string | null;
      captureComplete: boolean; logs: Record<'stdout' | 'stderr', { ref: string; sha256: string; byteLength: number }> } } };

export interface BudgetedTaskComparisonInput {
  selection: { kind: "full-gate"; coverage: "complete"; unenumerated: string[];
    originalRef: string; originalSha256: string; files: string[];
    fileOccurrences?: Array<{ task: string; step: number | null; command: string;
      file: string; kind: "test-file" | "check-input" }> };
  source: { commit: string; receiptSha256: string; dependencySha256: string;
    runtimeClosureSha256: string; files: Array<{ path: string; sha256: string }> };
  tasks: Array<{ id: string; files: string[] }>;
  baseline: TaskBudgetInput;
  candidate: TaskBudgetInput;
  envelope: { hardMemoryMb: number; pidsMax: number; heapMb: number };
  estimates: Array<{ task: string; ms: number; originalRef: string; originalSha256: string }>;
}
export interface BudgetedTaskComparisonManifest extends BudgetedTaskComparisonInput {
  schemaVersion: 1;
  kind: "budgeted-task-comparison";
  order: string[];
  fileSetSha256: string;
  manifestSha256: string;
}
export interface BudgetedTaskComparisonCohort {
  side: "baseline" | "candidate";
  repeat: number;
  runId: string;
  originalRef: string;
  originalSha256: string;
  manifestSha256: string;
  sourceUnchanged: boolean;
  sourceReceiptSha256: string;
  dependencySha256: string;
  runtimeClosureSha256: string;
  policy: TaskBudgetInput;
  envelope: BudgetedTaskComparisonInput["envelope"];
  wallMs: number;
  acquiredWaitsMs: number[];
  executionWallMs: number;
  memory: { pairedSamples: number; maxAnonPerAllocatedWorkerMb: number; oomKills: number };
  stats: { memoryReadings: number; lastMemAvailableMb: number; observedMaxWorkers: number;
    observedMaxTasks: number; observedMaxMemoryMb: number };
  /** Actual scheduler START order, not the declaration-ordered result array. */
  children: Array<{ task: string; lane: "primary" | "reserved"; files: string[];
    code: number; signal: string | null; childWallMs: number; resultLine: string;
    originalRef: string; originalSha256: string; expectedCgroup: string; runGroup: string;
    deadlineEpochMs: number; cgroupObservations: Array<{ pid: number; cgroupPath: string;
      runGroup: string; deadlineEpochMs: number | string; vitestFork?: boolean; phase?: string }> }>;
}
export function prepareBudgetedTaskComparison(input: BudgetedTaskComparisonInput): BudgetedTaskComparisonManifest;
export function evaluateBudgetedTaskComparison(manifest: BudgetedTaskComparisonManifest,
  cohorts: BudgetedTaskComparisonCohort[]): { assertions: Array<{ name: string; passed: boolean }>;
    baselineWallMs: number | null; candidateWallMs: number | null; ratio: number | null;
    operationalAcceptance: false; fileSetSha256: string | null };
export interface BudgetedTaskComparisonArtifactPins {
  manifest: { ref: string; sha256: string };
  source: { ref: string };
  dependencies: { ref: string };
  runtimeClosure: { ref: string };
  cohorts: Array<{ ref: string; sha256: string }>;
}
export interface BudgetedTaskCommandPreparationPins {
  mode: "command-preparation";
  repositoryRoot: string;
  selection: { ref: string; sha256: string };
  commands: Array<{ task: string; step: number | null;
    receipt: { ref: string; sha256: string };
    /** Required only for a receipt pin referring to an original native voice JSONL transcript. */
    nativeEvent?: { sessionId: string; eventId: string };
    logs: Record<"stdout" | "stderr" | "beforeStdout" | "afterStdout", { ref: string; sha256: string }> &
      Partial<Record<"beforeStderr" | "afterStderr", { ref: string; sha256: string }>> }>;
  /** ORIGINAL parent binds all lifecycle/test occurrences; standalone passes cannot qualify a chain. */
  chains?: Array<{ task: string; receipt: { ref: string; sha256: string };
    logs: Record<"stdout" | "stderr", { ref: string; sha256: string }>;
    steps: Array<{ phase: "pre" | "test" | "post"; step: number | null;
      format: "command-preparation" | "node-test" | "vitest-json" | "vitest-native-run";
      receipt: { ref: string; sha256: string };
      logs?: Record<"stdout" | "stderr" | "report", { ref: string; sha256: string }> }> }>;
}
export function readBudgetedTaskComparisonArtifacts(evidenceRoot: string,
  pins: BudgetedTaskCommandPreparationPins): Promise<{ mode: "command-preparation";
    selection: unknown; commands: Array<{ task: string; step: number | null;
      kind: "command-check" | "npm-lifecycle"; check?: string; script?: string; command: string;
      inputs: Array<{ path: string; sha256: string }>; fileOccurrences: unknown[];
      receipt: { ref: string; sha256: string }; childWallMs: number | null; scriptsExecuted: number;
      startedAtMs: number; finishedAtMs: number;
      scriptOrder: string[]; diagnostics?: { filesChecked: number; errors: number; warnings: number; hints: number };
      nativeEvent?: { sessionId: string; eventId: string }; nativeExecutionWallMs?: number;
      durationScope?: "discovery-and-command"; voiceResult?: { clientTools: number } }>;
    originalArtifactsResolved: true; currentDeclaredInputsMatched: true;
    chains: Array<{ task: string; receipt: { ref: string; sha256: string }; steps: unknown[];
      startedAtMs: number; finishedAtMs: number; orderedOccurrencesQualified: true }>;
    orderedChainQualified: boolean;
    orderedChainCoverage: { population: string[]; qualified: string[]; missing: string[] };
    runtimeClosure: "unmeasured";
    operationalAcceptance: false; populationSha256: string }>;
export function readBudgetedTaskComparisonArtifacts(evidenceRoot: string,
  pins: BudgetedTaskComparisonArtifactPins): Promise<{ manifest: BudgetedTaskComparisonManifest;
    cohorts: BudgetedTaskComparisonCohort[]; originalArtifactsResolved: true; populationSha256: string }>;

export interface ResolvedTaskBudget {
  workerBudget: number;
  memoryBudgetMb: number;
  memoryBudgetScope?: string;
  sharedMemoryBudgetMb?: number;
  workerMemoryMb: number;
  memoryWorkerBudget: number;
  effectiveWorkerBudget: number;
  maxConcurrentTasks: number;
  configuredMaxConcurrentTasks: number;
  pidsMaxConcurrentTasks: number | null;
  taskCgroupPidsMax: number | null;
  pidsPerConcurrentTask: number;
  pidsReserve: number;
  taskBoundBy: "pids" | "ceiling";
  reserveWorkers: number;
  mode: "parallel" | "serial";
  primaryWorkers: number;
  reserveLaneWorkers: number;
  /**
   * Which constraint actually bound the budget. `resolveTaskBudget` always sets it
   * (budgeted-task-scheduler.mjs:140), but `formatTaskBudgetMarker` re-derives it with a
   * `??` fallback for stats objects assembled elsewhere — so it is optional here to keep
   * both callers representable.
   */
  boundBy?: "memory" | "ceiling";
  /**
   * The measured available memory, present only when the caller measured it — its
   * ABSENCE is meaningful (the marker omits the field rather than printing a guess), so
   * this is nullable as well as optional.
   */
  memAvailableMb?: number | string | null;
  /** Hard memory.max of the current task cgroup, when finite. */
  taskCgroupMemoryMaxMb?: number | string | null;
}

export interface TaskAllocation {
  lane: "primary" | "reserved" | "serial";
  workers: number;
  memoryMb: number;
}

/**
 * What `formatTaskBudgetObservedMarker` ACCEPTS. The admission terms are optional here on
 * purpose: the formatter is deliberately defensive so a hand-built stats object (tests, older
 * callers) still renders the legacy marker string. That tolerance is a real part of the
 * contract, so it is stated in the type rather than left to a runtime `?? `.
 */
export interface TaskSchedulerObserved extends ResolvedTaskBudget {
  observedMaxWorkers: number;
  observedMaxMemoryMb: number;
  observedMaxTasks: number;
  memoryReadings?: number | null;
  admissionClamps?: number | null;
  minAdmittedWorkers?: number | null;
  lastMemAvailableMb?: number | null;
}

/**
 * What `runBudgetedTasks` PRODUCES — the same shape with every admission term REQUIRED, because
 * a real run always populates all four. Keeping them required here is what stops a future
 * change from silently dropping one and under-reporting the clamp.
 */
export interface TaskSchedulerStats extends TaskSchedulerObserved {
  /**
   * How many times admission re-measured available memory, or `null` when no
   * `readMemAvailableMb` was supplied. `null` and `0` are DIFFERENT facts — "nobody measured"
   * vs "a reader was wired but never consulted" — and `formatTaskBudgetObservedMarker`
   * distinguishes them by exactly this null (EI-20801764054303492).
   */
  memoryReadings: number | null;
  /** Admissions the memory reading narrowed below the lane width. */
  admissionClamps: number;
  /** Narrowest width ever admitted, or `null` when no reader was supplied. */
  minAdmittedWorkers: number | null;
  /** Last finite reading, or `null` when unread/unreadable. */
  lastMemAvailableMb: number | null;
}

export function formatTaskBudgetObservedMarker(
  stats: TaskSchedulerObserved,
): string;

export interface ScheduledTaskResult<Task, Value> {
  task: Task;
  index: number;
  allocation: TaskAllocation;
  value: Value;
}

export interface BudgetedTaskRun<Task, Value> {
  results: Array<ScheduledTaskResult<Task, Awaited<Value>>>;
  stats: TaskSchedulerStats;
}

export interface AffectedBlastRadius {
  kind: "scoped" | "near-tree-wide";
  reason:
    | "path-closure"
    | "root-manifest-or-config"
    | "all-requested"
    | "derivation-degraded";
  triggerPaths: string[];
}

export interface AffectedTaskShard<Task> {
  index: number;
  tasks: Task[];
  taskKeys: string[];
}

export interface AffectedTaskShardPlan<Task> {
  blastRadius: AffectedBlastRadius;
  maxTasksPerShard: number;
  taskCount: number;
  shards: Array<AffectedTaskShard<Task>>;
}

export interface BudgetedTaskWallProjection {
  /** History-based elapsed-wall projection; unknown task durations contribute zero. */
  projectedWallMs: number;
  /** Serial-equivalent sum retained for diagnosis; it is not elapsed wall time. */
  knownWorkMs: number;
  knownTasks: number;
  unknownTasks: number;
  mode: "parallel" | "serial";
  maxConcurrentTasks: number;
}

export interface DurationHistoryEntry {
  durationMs: number;
  samples: number;
  updatedAt: string;
  /**
   * Decayed high-water duration. OPTIONAL because a legacy entry written before the peak was
   * tracked has no `peakMs`, and every reader (timeoutDurationEstimate, mergeDurationHistory)
   * treats a missing value as "seed from the EWMA" rather than zero.
   */
  peakMs?: number;
}

export interface DurationHistory {
  version: number;
  tasks: Record<string, DurationHistoryEntry>;
}

export const DURATION_HISTORY_VERSION: number;
export const PIDS_PER_CONCURRENT_TASK: number;
export const PIDS_RESERVE: number;

export function resolveGlobalWorkerBudget(input: {
  affectedWorkerBudget?: number | string;
  vitestMaxWorkers?: number | string;
  vitestMaxForks?: number | string;
  vitestMaxThreads?: number | string;
  fallback: number | string;
}): number;

/**
 * WI-10002092: `taskCgroupMemoryMaxMb` arms the credibility test that stops an inherited
 * `--max-old-space-size` heap CEILING being read as a per-worker RESERVATION. Omit it (or pass
 * the `null` an unbounded/unreadable cgroup yields) and every heap candidate stands, which is the
 * pre-fix behaviour. `onNotice` reports each disregarded candidate.
 */
export function resolveWorkerMemoryMb(input: {
  affectedWorkerMemoryMb?: number | string;
  nodeOptions?: string;
  fallback: number | string;
  taskCgroupMemoryMaxMb?: number | string | null;
  cgroupReserveFraction?: number;
  onNotice?: (line: string) => void;
}): number;

/**
 * Headroom held back from MemAvailable before any worker token is paid for — shared by the
 * startup budget (resolveMemoryBudgetMb) and the per-admission re-check
 * (admissibleWorkersForMemory) so the two rails cannot drift apart (EI-20801764054303492).
 */
export const MEMORY_RESERVE_FRACTION: number;

export function resolveMemoryBudgetMb(input: {
  affectedGlobalMemoryMb?: number | string;
  memAvailableMb?: number | string | null;
  taskCgroupMemoryMaxMb?: number | string | null;
  workerBudget: number | string;
  workerMemoryMb: number | string;
  reserveFraction?: number;
  cgroupReserveFraction?: number;
}): number;

export { readTaskCgroupMemoryMaxMb } from './task-cgroup-limits.mjs';

export function readTaskCgroupPidsMax(input?: {
  readFile?: (path: string, encoding: string) => string | Buffer;
  procCgroupPath?: string;
  cgroupRoot?: string;
}): number | null;

export function readTaskCgroupPidsEventMax(input?: {
  readFile?: (path: string, encoding: string) => string | Buffer;
  procCgroupPath?: string;
  cgroupRoot?: string;
}): number | null;

/** THIS task cgroup's memory use; each field is null when its file is unreadable. */
export interface TaskCgroupMemoryUsage {
  /** memory.stat `anon`: the non-reclaimable demand. */
  anonMb: number | null;
  /** memory.peak: the cumulative high-water mark, INCLUDING reclaimable page cache. */
  peakMb: number | null;
  /** memory.events `oom_kill`: cumulative over the cgroup's life. */
  oomKills: number | null;
}

export function readTaskCgroupMemoryUsage(input?: {
  readFile?: (path: string, encoding: string) => string | Buffer;
  procCgroupPath?: string;
  cgroupRoot?: string;
}): TaskCgroupMemoryUsage | null;

export interface CgroupMemoryObservation {
  samples: number;
  /** Sampled maximum, so a LOWER bound on the true anon peak. */
  maxAnonMb: number | null;
  peakMb: number | null;
  /** oom_kill delta over this run (not the cgroup's lifetime count). */
  oomKills: number | null;
  pairedSamples?: number;
  /** Maximum sampled anon / active scheduler grant. Not a resident-fork count. */
  maxAnonPerAllocatedWorkerMb?: number | null;
}

export function createCgroupMemoryObserver(input?: {
  read?: () => TaskCgroupMemoryUsage | null;
}): {
  sample(): void;
  summary(): CgroupMemoryObservation;
  withWorkers<T>(workers: number, run: () => T | Promise<T>): Promise<T>;
};

export function formatCgroupMemoryObservedMarker(
  summary: CgroupMemoryObservation,
  input?: { observedMaxWorkers?: number | null },
): string;

export function pidsEventRefusalDelta(input: {
  start: number | null;
  end: number | null;
  hasFailures: boolean;
}): number;

export function classifyAffectedBlastRadius(input?: {
  changedPaths?: string[];
  runAll?: boolean;
  derivationDegraded?: boolean;
}): AffectedBlastRadius;

export function planAffectedTaskShards<Task>(
  tasks: Task[],
  options?: {
    blastRadius?: AffectedBlastRadius;
    maxTasksPerShard?: number | string;
    taskKey?: (task: Task, index: number) => string | number;
  },
): AffectedTaskShardPlan<Task>;

/**
 * Project elapsed wall time using the scheduler's actual longest/shortest concurrent lanes.
 * This is a history-based estimate, not a lower-bound proof; `knownWorkMs` is the separate
 * serial-equivalent sum and `unknownTasks` makes uncovered work explicit.
 */
export function estimateBudgetedTaskWallMs<Task>(
  plan: AffectedTaskShardPlan<Task>,
  options: TaskBudgetInput & {
    estimateMs?: (task: Task, index: number) => number | null | undefined;
  },
): BudgetedTaskWallProjection;

export const NARROWED_TASK_FLOOR_MS: number;

export interface AffectedRunEta {
  projectedSec: number;
  workSec: number;
  knownTasks: number;
  tasks: number;
  unknownTasks: number;
  concurrency: number;
  narrowedTasks: number;
  heaviest: { key: string; sec: number } | null;
}

export function projectAffectedRunEta<Task>(
  plan: AffectedTaskShardPlan<Task>,
  options: TaskBudgetInput & {
    estimateMs?: (task: Task, index: number) => number | null | undefined;
    narrowedShare?: (task: Task, index: number) => number | null | undefined;
    taskKey?: (task: Task, index: number) => string;
  },
): AffectedRunEta;

export function formatAffectedEtaLine(
  eta: AffectedRunEta | { error: string } | null | undefined,
): string;

export function formatAffectedTaskShardMarker(
  plan: AffectedTaskShardPlan<unknown>,
  taskCgroupMemoryMaxMb?: number | null,
): string;

export function resolveTaskBudget(input: TaskBudgetInput): ResolvedTaskBudget;

/**
 * Per-admission memory re-check: clamps a lane's worker count to what the measured
 * MemAvailable (minus the reserve fraction) can afford. A missing/broken reading returns the
 * configured lane width unchanged — an instrument failure must never read as "no memory".
 */
export function admissibleWorkersForMemory(input: {
  laneWorkers: number | string;
  workerMemoryMb: number | string;
  memAvailableMb?: number | string | null;
  reserveFraction?: number;
}): number;

/**
 * WI-1490656 — observability + bounding for the shared `papercusp-test-process-admission`
 * mutex every scheduler invocation acquires.
 */
export interface AdmissionNoticeInfo {
  kind: 'queued' | 'granted' | 'yielded';
  /** Present on `queued`: how long this acquisition has been waiting so far. */
  elapsedMs?: number;
  /** Present on `granted`: how long this acquisition ended up queued. */
  waitedMs?: number;
  /** The bound this acquisition was actually given. */
  budgetMs: number;
}

export interface SharedAdmissionOptions {
  /** Recheck this launcher deadline after task admission; null disables the inherited deadline. */
  deadlineEpochMs?: number | null;
  /**
   * Sink for queue notices. DEFAULTS to `console.error`, which cannot reach the
   * affected-tests run log — the runner injects a sink that writes both, so a queued run
   * explains itself in the file its own BEGIN line tells a triager to grep.
   */
  onAdmissionNotice?: (line: string, info: AdmissionNoticeInfo) => void;
  /** Fires once per acquisition, with how long it queued and the bound it was given. */
  onAdmissionAcquired?: (info: { waitedMs: number; budgetMs: number; queueChargeMs?: number }) => void;
  /** Opt in to shared task-sized worker/memory leases. Equal keys exclude each other; '*' excludes every task. */
  taskAdmissionKey?: (task: any) => string;
  /** Defer before queueing when a release-gate holder's measured age reaches this waiter's remaining queue budget. */
  deferWhenHolderOlderThanBudget?: boolean;
  /**
   * EI-21917992245424964 — a self-description published into the admission mutex's owner
   * record, so a BLOCKED peer can judge whether waiting is worth it without a coord
   * round-trip and without this holder being awake to answer.
   *
   * Scalars only (bounded and key-capped by `fs-mutex`); anything else is dropped rather
   * than coerced, so a missing field keeps reading as "not declared".
   */
  admissionIntent?: Record<string, string | number | boolean>;
}

/**
 * EI-21917992245424964 — render a holder's owner record as ONE decision-shaped line for the
 * queued notice, which is re-announced for the whole wait. Emits `intent=undeclared` rather
 * than omitting the field, and falls open to the raw text on any parse failure.
 */
export function formatAdmissionHolder(ownerText: unknown, now?: number): string;

/**
 * WI-2142172 — render the WAITER's own prognosis as a clause appended to the queued notice:
 * can this caller plausibly be admitted before its budget runs out?
 *
 * Returns "" when there is nothing sound to say. The holder's `etaProjectedSec` is a
 * concurrency-aware history projection, not a proof, so warning text keeps the uncertainty
 * explicit (`PROJECTED TO STARVE` at >=1.0 of the remaining budget, `ADMISSION AT RISK` at
 * >=0.5) and never certifies safety. An ETA covering 0 tasks is reported as `PROSPECT UNKNOWN`
 * rather than skipped. Legacy holders that only publish `etaMinSec` are also unknown because
 * their serial-equivalent sum cannot establish wall time. Falls open to "" on any parse
 * failure; it prints while a caller is already blocked and must never be the thing that throws.
 */
export function formatAdmissionProspect(
  ownerText: unknown,
  waiter: { elapsedMs: number; budgetMs: number },
  now?: number,
): string;

/**
 * WI-1639265 — the launcher-published wall-clock deadline, absolute epoch ms.
 *
 * Must stay byte-identical to `TASK_DEADLINE_EPOCH_MS_ENV` in
 * `packages/operator-core/lib/systemd-scope.ts` (the producer); an ABSENT variable
 * legitimately means "no deadline was set", so a rename on either side would silently
 * restore the pre-fix behaviour. Pinned by `affected-tests-deadline-admission.test.ts`.
 */
export const TASK_DEADLINE_EPOCH_MS_ENV: 'PAPERCUSP_TASK_DEADLINE_EPOCH_MS';

/** The deadline, or null for UNKNOWN — never "unbounded and fine". */
export function readTaskDeadlineEpochMs(
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
): number | null;

export const TASK_DEADLINE_REFUSAL_MARKER: 'TASK_DEADLINE_REFUSAL';

/**
 * `knownEstimateMs` is a history-based lane-aware wall projection, not summed work
 * or a guaranteed lower bound. Unknown tasks contribute zero and are reported separately.
 */
export function formatTaskDeadlineRefusal(input: {
  remainingMs: number;
  knownEstimateMs: number;
  knownTasks: number;
  unknownTasks: number;
}): string;

/** Does this error mean "we were never going to fit inside our own deadline"? */
export function isTaskDeadlineRefusal(error: unknown): boolean;

/** The whole-invocation queue budget shared across every shard of one run. */
export const SHARED_TEST_PROCESS_ADMISSION_RUN_BUDGET_MS: number;

/**
 * WI-1746759: which admission lane this process belongs in — the release gate gets its own,
 * everyone else shares one, so the gate's per-shard re-queueing cannot be starved by (and
 * cannot starve) ad-hoc agent runs.
 *
 * ⚠ Keyed on `PC_HEAVY_RELEASE_GATE === "1"` ONLY, never `GREEN_CHECKPOINT` — agents export
 * that second marker by hand to reproduce the gate's skip-set, so keying a private lane off
 * it would let any agent leave the queue its peers wait in.
 */
export function admissionMutexName(env?: Record<string, string | undefined>): string;

/**
 * True when an error means "never admitted" rather than "a test failed". A caller that
 * misclassifies it exits with no verdict, which the green-checkpoint records as a lost run.
 */
export function isSharedAdmissionTimeout(error: unknown): boolean;

/** True when a release-gate waiter deferred before spending its budget behind an aged holder. */
export function isSharedAdmissionDeferral(error: unknown): boolean;

export function runBudgetedTasks<Task, Value>(
  tasks: Task[],
  options: TaskBudgetInput & SharedAdmissionOptions & {
    /** Bound for THIS acquisition. Defaults to the per-acquisition admission timeout. */
    admissionTimeoutMs?: number;
    estimateMs?: (task: Task, index: number) => number | null | undefined;
    /**
     * OPT-IN live memory reading, consulted before every admission after the run's first.
     * ABSENT ⇒ allocations are byte-identical to the pre-clamp scheduler (the back-compat
     * contract). Present ⇒ admission may only ever admit FEWER workers, never more. A reader
     * that returns null/non-finite, or throws, leaves the lane width unchanged: a broken
     * instrument must not read as "no memory" (EI-20801764054303492).
     */
    readMemAvailableMb?: () => number | null | undefined;
    runTask: (
      task: Task,
      allocation: TaskAllocation,
      index: number,
    ) => Value | Promise<Value>;
    onTaskSettled?: (
      entry: ScheduledTaskResult<Task, Awaited<Value>>,
    ) => void | Promise<void>;
  },
): Promise<BudgetedTaskRun<Task, Value>>;

export function runBudgetedTaskShards<Task, Value>(
  plan: AffectedTaskShardPlan<Task>,
  options: TaskBudgetInput & SharedAdmissionOptions & {
    /**
     * Total queue time this run may spend across ALL shards. Each shard is its own
     * acquisition whose own timeout restarts at zero, so without one shared budget an
     * N-shard run's real admission bound is N × the per-acquisition timeout.
     */
    admissionRunBudgetMs?: number;
    /**
     * WI-1639265: the caller's absolute wall-clock deadline, epoch ms. OMITTED reads it from
     * `TASK_DEADLINE_EPOCH_MS_ENV`; an explicit `null` means "this caller has no deadline"
     * and skips every deadline check, which is the pre-fix behaviour exactly.
     */
    deadlineEpochMs?: number | null;
    estimateMs?: (task: Task, index: number) => number | null | undefined;
    readMemAvailableMb?: () => number | null | undefined;
    runTask: (
      task: Task,
      allocation: TaskAllocation,
      index: number,
    ) => Value | Promise<Value>;
    onTaskSettled?: (
      entry: ScheduledTaskResult<Task, Awaited<Value>>,
    ) => void | Promise<void>;
  },
): Promise<
  BudgetedTaskRun<Task, Value> & {
    shardStats: Array<
      TaskSchedulerStats & { index: number; taskCount: number }
    >;
    shardPlan: AffectedTaskShardPlan<Task>;
  }
>;

export function emptyDurationHistory(): DurationHistory;

export function readDurationHistory(path: string): DurationHistory;

export function durationEstimate(
  history: DurationHistory,
  key: string,
): number | null;

/**
 * Like {@link durationEstimate}, but for sizing a TIMEOUT rather than for ordering: it returns
 * the max of the EWMA and the decayed peak, so a bimodal task's slow mode keeps its headroom
 * through a run of fast completions.
 */
export function timeoutDurationEstimate(
  history: DurationHistory,
  key: string,
): number | null;

export function mergeDurationHistory(
  history: DurationHistory,
  observations: Array<{ key: string; durationMs: number }>,
  now?: string,
): DurationHistory;

export function writeDurationHistoryAtomic(
  path: string,
  history: DurationHistory,
  nonce?: string,
): void;

export function formatTaskBudgetMarker(
  stats: ResolvedTaskBudget,
  prefix?: string,
): string;
