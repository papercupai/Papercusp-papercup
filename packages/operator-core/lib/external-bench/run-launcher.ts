/**
 * UI-triggered bench run launcher + spend-safety teardown
 * (benchmark-evaluation-ui-2026-06-16 P-004 / P-005, D-002).
 *
 * Launches a REAL bench-engine run from inside the operator host (NOT a /tmp CLI
 * launcher): persist a bench_runs row (status=running) + return a run_id
 * immediately, drive runHiveBacklog as a DETACHED promise, stream per-task +
 * coordination rows into the operational store as bees collect, and finalize on
 * completion.
 *
 * SPEND-SAFETY (closes impartial-benchmark-suite D-022 — the orphan-respin gap):
 *   1. Every spawned hive's slug is persisted on the bench_runs row
 *      (setBenchRunHive) the instant it is minted.
 *   2. The detached run ALWAYS tears down in a finally — dissolveBenchHive (which
 *      stops the Queen wake, cancels every bee subtree, and DELETES the
 *      gym_autoloop_config + scout routine + learning-governor registrants via
 *      teardownHiveLearningLoop) — so a completed/errored/cancelled run leaves no
 *      armed learning loop to re-spin opus.
 *   3. A boot-time reaper (reapStaleBenchRuns, wired into host boot) finds any run
 *      left status=running/grading/pending by a CRASHED host (SIGKILL bypasses the
 *      finally), dissolves its hive, and freezes its status — so a :3170 restart
 *      can NEVER re-arm an orphan hive. This is the durable closure; the finally
 *      is the fast path.
 *
 * The in-process `activeRuns` map holds only EPHEMERAL runtime handles (the cancel
 * flag + the live hive slugs for a run executing in THIS process). The durable
 * truth is bench_runs.status in PG — the reaper rebuilds safety from it on boot.
 * (Not a "module-scoped state Map" in the storage-policy sense: a live promise +
 * cancel flag cannot be serialized; PG is the source of truth.)
 */
import type { BenchTask, TaskCheckout, GenerationStopReason } from './types';
import type { GatewayCarryTrialAttemptResult } from '../inference-gateway/gateway';
import type { FleetTaskResult, HiveBacklogResult, HiveBacklogRunRequest } from './hive-backlog';
import { runHiveBacklog } from './hive-backlog';
import { bindRealQueenBacklogDriver, dissolveBenchHive } from './hive-backlog-realqueen';
import { bindSuIndependentBacklogDriver, SU_INDEPENDENT_ARM } from './su-independent-backlog';
import { assertExternalBenchEnabled } from './gate';
import { resolveDb, type DbScope } from './reproducibility/db';
import {
  upsertBenchRun,
  setBenchRunHive,
  upsertBenchRunTask,
  taskRowFromFleetResult,
  setBenchRunEvents,
  setBenchRunStatus,
  recordRunCompletion,
  type BenchRunStatus,
} from './run-store';
import { loadBenchTaskSet } from './task-sets';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { defaultBenchResultsDir } from './preserved-runs';
import type { PapercuspUnifiedToolContext } from '../agent-tools/_tool-context';
import { currentBenchmarkProtocolSchema, requireCurrentBenchmarkAssignment, type CurrentBenchmarkProtocol } from './reproducibility/schema';
import { canonicalJson } from './reproducibility/canonical-json';
import { getPrereg, listRunResults } from './reproducibility/store';
import { requireCommittedPreregistration } from './reproducibility/prereg';
import { resolveBenchWorkspace } from './bench-workspace';
import { runArmGeneration } from './arm-generation';
import { cloneTaskRepo, extractDiff } from './clone';
import { FULL_SPINE_BLUEPRINT, type BenchHarnessDriver } from './run-loop';
import { createCurrentSuBenchHarness, currentBenchAssignmentId, currentBenchGatewayController,
  currentBenchProviderAuthenticator, currentBenchObservationReader, recoverCurrentBenchRun,
  currentBenchWorkloadProviderInputCapture, currentBenchWorkloadProviderInputReader, currentBenchWorkloadLockStateReader,
  currentBenchCodexRoute, requireCurrentBenchHostBinding, requireCurrentBenchNativeRunCost,
  currentBenchWorkloadToolResultReader, currentBenchWorkloadLockGrantReader,
  type CurrentBenchLockStateAllocation, type CurrentBenchNativeRunCost,
  type CurrentSuBenchOptions, type CurrentBenchObservationReaderOptions, type CurrentBenchTaskRequestCensus } from './current-su';
import { getLearningSpendPositions, registerLearningLoop, type LearningReservationResourceBudget } from '../learning-governor/store';
import type { FrontierSweNativeAssignment, FrontierSweProximusAssignment, FrontierSweLaunchAdapterConfig } from './frontier-swe-launch-adapter';
import { frontierSweAgentNetworkArgs, type FrontierSweEnvHandle } from './frontier-swe-seam';
import { prepareProximusRuntime, runProximusHost, readProximusAttemptPopulation, readProximusBilling, priceProximusAttempts } from './proximus-runtime';
import type { RunAgentInput } from './run-topology';
import { createCurrentStockBenchHarness } from './native-harness-runner';
import { CURRENT_STOCK_CODEX_BLUEPRINT, CURRENT_STOCK_CLAUDE_BLUEPRINT } from './current-su';
import { resolveContainerClaudeBinary } from './container-exec-target';
import { resolveSpawnHostOperatorBaseUrl } from '../mcp-base-url';
import { resolveCoordinationSpec } from './coordination-topology';
import { emitRollout } from './reproducibility/emit';
import type { runFrontierSweCurrentArm } from './frontier-swe-arm';

export { currentBenchSessionRequestDelta, currentBenchSessionUsageDelta,
  type CurrentBenchTaskRequestCensus } from './current-su';

/** A run actively executing in THIS host process (ephemeral; PG is durable truth). */
interface ActiveRun {
  runId: string;
  workspaceId: string;
  arm: string;
  taskSetId: string;
  taskIds?: string[];
  startedAtMs: number;
  potSlugs: Set<string>;
  cancelled: boolean;
  abort?: AbortController;
  stopCurrent?: () => Promise<void>;
  protocolRunId?: string;
}
const activeRuns = new Map<string, ActiveRun>();

export interface LaunchBenchRunInput {
  /** Single arm per run (a multi-arm compare launches one run per arm). */
  arm: string;
  /** '11-task-pilot' | 'swe-bench-pro-full' | 'custom'. */
  taskSetId: string;
  /** When taskSetId='custom', the explicit instance ids. */
  taskIds?: string[];
  suite?: string;
  /** opus — fail-closed (never silently downgraded). */
  model?: string;
  /** Fleet concurrency cap (maxSimultaneousAgents). */
  cap?: number;
  /** Per-task spend cap (USD). */
  maxUsdPerTask?: number;
  /** Per-task token cap. */
  maxTokensPerTask?: number;
  /** Per-run spend ceiling (USD) — advisory, recorded in config. */
  maxUsdPerRun?: number;
  /** Current execution is selected by a committed protocol, never a legacy arm fallback. */
  current?: {
    workspaceId: string;
    protocolRunId: string;
    preregHash: string;
    seed: number;
    observation: Pick<CurrentBenchObservationReaderOptions, 'runtimeWorkspaceId' | 'workerUnit' | 'gatewayUnit'>;
  };
}

/**
 * The persister-hook surface BOTH backlog driver binds (real-Queen + su-independent) accept — the
 * normalized seam `launchBenchRun` wires its bench_runs persistence through. Each bind reads only the
 * common fields it needs; `onHiveCreated` is meaningful for the hive arms and a harmless no-op for the
 * hive-less su-independent arm (it never fires). The enrolled/task shapes are narrowed to the fields the
 * launcher reads (`enrolled.task.instanceId`, the FleetTaskResult), so both concrete binds — which take
 * their own richer enrolled type — are assignable here (callback param contravariance).
 */
export type BenchDriverBinder = (opts: {
  workspaceId: string;
  onHiveCreated?: (hiveHome: string) => void | Promise<void>;
  onEnrolled?: (enrolled: { task: BenchTask }) => void | Promise<void>;
  onTaskCollected?: (result: FleetTaskResult) => void | Promise<void>;
}) => void;

/** Test/host injection seam — defaults wire the real engine. */
export interface LaunchDeps {
  scope?: DbScope;
  /** Run the backlog (default runHiveBacklog). */
  run?: (req: HiveBacklogRunRequest) => Promise<HiveBacklogResult>;
  /** Bind the backlog driver with the persister hooks (per-arm default: real-Queen / su-independent). */
  bindDriver?: BenchDriverBinder;
  /** Dissolve a spawned hive (default dissolveBenchHive). */
  dissolve?: (potSlug: string, workspaceId: string) => Promise<void>;
  /** Load the task set → BenchTask[] (default loadBenchTaskSet). */
  loadBacklog?: (taskSetId: string, taskIds?: string[]) => Promise<BenchTask[]>;
  /** Gate check (default assertExternalBenchEnabled). */
  assertEnabled?: () => Promise<void>;
  /** Deterministic run id (tests). Default embeds a timestamp. */
  runId?: string;
  /** Authenticated host context. The HTTP route supplies this; JSON cannot supply authority. */
  currentContext?: PapercuspUnifiedToolContext;
  currentRepoRoot?: string;
  /** Assignment-local runtime seam; production starts the maintained native gateway/driver. */
  currentTask?: (input: CurrentTaskInput) => Promise<{ driver: BenchHarnessDriver; stop(): Promise<void> }>;
  currentGeneration?: Pick<import('./types').GenerationPorts, 'clone' | 'extractDiff'>;
  /** Host-owned in-container run seam; never taken from the launch JSON. */
  currentFrontierArm?: typeof runFrontierSweCurrentArm;
  currentNative?: { start?: typeof startFrontierSweCurrentAssignment; resolveClaudeBinary?: typeof resolveContainerClaudeBinary };
  /** Trusted host seams; launch JSON cannot select an interpreter or assignment factory. */
  currentProximus?: { prepare?: typeof prepareProximusRuntime; start?: typeof startFrontierSweProximusAssignment };
}

export interface CurrentTaskInput {
  options: CurrentSuBenchOptions;
  protocol: CurrentBenchmarkProtocol;
  task: BenchTask;
  context: PapercuspUnifiedToolContext;
  scope: DbScope;
  resources: LearningReservationResourceBudget;
  loopId: string;
  /** The generation primitive has already cloned this exact assignment. */
  checkout: TaskCheckout;
  /** Operational run row retaining private host recovery pins. */
  hostRunId: string;
  observation: NonNullable<LaunchBenchRunInput['current']>['observation'];
}

/** Provider accounting is shared; host references never gain native options or observations. */
type CurrentBenchProviderTaskInput = Omit<CurrentTaskInput, 'options' | 'observation'> & {
  options: Omit<CurrentSuBenchOptions, 'agent'> & { agent: CurrentSuBenchOptions['agent'] | 'proximus' };
};

/** Retain private capture authority in the existing operational run checkpoint.
 * No candidate-selected paths or account aliases can allocate this host. Each
 * request's pins must commit before the gateway may reserve or forward it. */
export async function currentBenchTaskProviderCapture(input: CurrentBenchProviderTaskInput, { readOnly = false }: { readOnly?: boolean } = {}) {
  const { options, protocol, task, resources, loopId, hostRunId } = input;
  const arm = protocol.arms.find(value => value.id === options.armId);
  if (!arm || arm.agent !== options.agent || !arm.account.trim() || ['auto', 'default'].includes(arm.account) ||
      arm.account !== options.account || arm.model !== options.model || arm.effort !== options.effort ||
      protocol.runId !== options.runId || !protocol.taskIds.includes(task.instanceId) || !protocol.seeds.includes(options.seed) ||
      canonicalJson(protocol) !== canonicalJson(options.preregistration.config) ||
      input.context.workspaceId !== options.workspaceId || !input.context.principal?.slug ||
      !Number.isSafeInteger(resources.requestsPerArm) || resources.requestsPerArm! < 1 || resources.requestsPerArm! > 10_000)
    throw new Error('Provider capture host requires an exact frozen account, assignment and authenticated checkout.');
  const accountingBinding = { workspaceId: options.workspaceId, loopId, runId: options.runId,
    preregHash: options.preregistration.preregHash,
    assignmentId: currentBenchAssignmentId(options.runId, arm.id, task.instanceId, options.seed) };
  const { sql, ws } = resolveDb(input.scope);
  if (ws !== resolveBenchWorkspace(options.workspaceId)) throw new Error('Provider capture host workspace differs.');
  const key = accountingBinding.assignmentId;
  type CaptureOptions = Parameters<typeof currentBenchWorkloadProviderInputCapture>[0];
  type Checkpoint = { allocation: Omit<CaptureOptions, 'recovery' | 'readOnly'>;
    recovery: ReturnType<ReturnType<typeof currentBenchWorkloadProviderInputCapture>['recoveryState']> };
  const expected = { accountingBinding, candidateCheckoutRoot: readOnly ? resolve(input.checkout.dir) : realpathSync(input.checkout.dir), model: arm.model,
    effort: arm.effort, accountId: arm.account, maxRequests: resources.requestsPerArm!, maxBytes: 16 * 1024 * 1024,
    ...(arm.agent === 'claude' ? { agent: 'claude' as const } : {}),
    // D-023: only a subscription arm records a payer, so API-key allocations keep their hash.
    ...(arm.payer === 'subscription' ? { payer: 'subscription' as const } : {}) };
  let capture!: ReturnType<typeof currentBenchWorkloadProviderInputCapture>;
  let checkpoint!: Checkpoint;
  await sql.begin(async tx => {
    const rows = await tx<{ status: string; config: { current?: { preregHash?: string }; loopId?: string;
      protocol?: unknown; providerInputCaptures?: Record<string, Checkpoint> } }[]>`
      SELECT status, config FROM harness_shared.bench_runs WHERE workspace_id = ${ws} AND id = ${hostRunId} FOR UPDATE`;
    const row = rows[0];
    if (!row || !readOnly && row.status !== 'running' || row.config?.current?.preregHash !== accountingBinding.preregHash ||
        row.config.loopId !== loopId || canonicalJson(row.config.protocol) !== canonicalJson(protocol))
      throw new Error('Provider capture host has no matching live operational checkpoint.');
    const saved = row.config.providerInputCaptures?.[key] as Checkpoint | undefined;
    if (saved) {
      const { captureRoot, ...allocation } = saved.allocation;
      if (canonicalJson(allocation) !== canonicalJson(expected)) throw new Error('Provider capture host allocation drifted.');
      capture = currentBenchWorkloadProviderInputCapture({ ...expected, captureRoot, recovery: saved.recovery, readOnly });
      checkpoint = saved;
    } else {
      if (readOnly) throw new Error('Read-only provider capture requires an existing host checkpoint.');
      const parent = defaultBenchResultsDir();
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      const captureRoot = realpathSync(mkdtempSync(join(parent, 'current-provider-input-')));
      const allocation = { ...expected, captureRoot };
      capture = currentBenchWorkloadProviderInputCapture(allocation);
      checkpoint = { allocation, recovery: capture.recoveryState() };
      await tx`UPDATE harness_shared.bench_runs SET config = jsonb_set(config, '{providerInputCaptures}',
        COALESCE(config->'providerInputCaptures', '{}'::jsonb) || ${JSON.stringify({ [key]: checkpoint })}::text::jsonb)
        WHERE workspace_id = ${ws} AND id = ${hostRunId}`;
    }
  });
  return { captureRoot: checkpoint.allocation.captureRoot, readCapture: capture.readCapture,
    allocation: Object.freeze(structuredClone(checkpoint.allocation)),
    recoveryState: capture.recoveryState,
    async captureProviderInput(attempt: Parameters<typeof capture.captureProviderInput>[0]) {
      await capture.captureProviderInput(attempt);
      const next = { allocation: checkpoint.allocation, recovery: capture.recoveryState() };
      const rows = await sql`UPDATE harness_shared.bench_runs
        SET config = jsonb_set(config, ${['providerInputCaptures', key]}::text[], ${JSON.stringify(next)}::text::jsonb)
        WHERE workspace_id = ${ws} AND id = ${hostRunId} AND status = 'running'
          AND config->'providerInputCaptures'->${key} = ${JSON.stringify(checkpoint)}::text::jsonb RETURNING id`;
      if (rows.length !== 1) throw new Error('Provider capture host checkpoint changed; request cannot be forwarded.');
      checkpoint = next;
    } };
}

type HostLockAllocation = Omit<CurrentBenchLockStateAllocation, 'workspaceId' | 'runId' | 'coordinationDomain'>;
type HostLockObservation = NonNullable<Awaited<ReturnType<ReturnType<typeof currentBenchWorkloadLockStateReader>>>>[number];
type HostLockGrantAllocation = Omit<Parameters<typeof currentBenchWorkloadLockGrantReader>[0], 'sql' | 'locksSql'>;
type HostLockGrantSelection = { receiptRef: string; transitionId: string; index: number };
type HostLockGrantPin = { allocation: HostLockGrantAllocation; observation: HostLockObservation; observationSha256: string };
type HostLockPin = { allocation: CurrentBenchLockStateAllocation; observation: HostLockObservation; observationSha256: string;
  lockGrant?: HostLockGrantPin };

function hostLockGrantAllocation(state: CurrentBenchLockStateAllocation, grant: HostLockGrantSelection): HostLockGrantAllocation {
  const waiter = state.receipt.waiter;
  if (state.receipt.phase !== 'granted' || !waiter?.lockId ||
      typeof grant.receiptRef !== 'string' || !grant.receiptRef.trim() || grant.receiptRef === state.receipt.receiptRef ||
      typeof grant.transitionId !== 'string' || !grant.transitionId.trim() ||
      !Number.isSafeInteger(grant.index) || grant.index < 0 || grant.index >= state.receipt.index)
    throw new Error('Lock grant capture requires a distinct exact bridge receipt preceding a granted state sample.');
  return { workspaceId: state.workspaceId, harnessSlug: state.harnessSlug, runId: state.runId,
    trialBindingHash: state.trialBindingHash, coordinationDomain: state.coordinationDomain, notBefore: state.notBefore,
    receipts: [{ ...grant, subjectId: state.receipt.subjectId, ticketId: waiter.ticketId, lockId: waiter.lockId,
      ownerId: waiter.ownerId, ownerLabel: waiter.ownerLabel, intent: waiter.intent,
      paths: structuredClone(state.receipt.paths), queuedAt: waiter.queuedAt }] };
}

/** Freeze a host-selected state sample before release/latch overwrite. The
 * existing operational checkpoint retains it; no event-stream persistence or
 * native invocation/denial/provider consumption is inferred from this sample. */
export async function freezeCurrentBenchTaskLockState(input: CurrentTaskInput, allocation: HostLockAllocation,
  ports: { locksSql?: import('postgres').Sql; grant?: HostLockGrantSelection } = {}): Promise<HostLockPin> {
  const frozen = structuredClone(allocation), options = structuredClone(input.options), protocol = structuredClone(input.protocol);
  const { hostRunId, loopId } = input;
  const { sql, ws } = resolveDb(input.scope);
  const key = currentBenchAssignmentId(options.runId, options.armId, input.task.instanceId, options.seed);
  const expected: CurrentBenchLockStateAllocation = { ...frozen, workspaceId: options.workspaceId,
    runId: options.runId, coordinationDomain: realpathSync(input.checkout.dir) };
  const expectedGrant = ports.grant ? hostLockGrantAllocation(expected, structuredClone(ports.grant)) : undefined;
  if (ws !== resolveBenchWorkspace(options.workspaceId) || input.context.workspaceId !== options.workspaceId ||
      !input.context.principal?.slug || canonicalJson(protocol) !== canonicalJson(options.preregistration.config) ||
      protocol.runId !== options.runId || !protocol.arms.some(arm => arm.id === options.armId) ||
      !protocol.taskIds.includes(input.task.instanceId) || !protocol.seeds.includes(options.seed))
    throw new Error('Lock state capture requires an authenticated frozen host assignment.');
  // Sample before taking the run-row lock. Otherwise concurrent captures can
  // occupy the entire host pool with row-lock waiters while the winning
  // transaction requests another connection for side-store inspection.
  // The observation records its own sample time; commit time is not state time.
  const reader = currentBenchWorkloadLockStateReader({ ...expected, sql, locksSql: ports.locksSql });
  const observed = await reader(frozen.receipt.receiptRef, { runId: options.runId, trialBindingHash: frozen.trialBindingHash });
  // Capture the independent live bridge authority before release or latch
  // overwrite. A granted state alone never supplies this transition receipt.
  const grantObserved = expectedGrant ? await currentBenchWorkloadLockGrantReader({ ...expectedGrant, sql,
    locksSql: ports.locksSql })(expectedGrant.receipts[0].receiptRef,
    { runId: options.runId, trialBindingHash: frozen.trialBindingHash }) : undefined;
  return sql.begin(async tx => {
    const rows = await tx<{ status: string; config: { current?: { preregHash?: string }; loopId?: string; protocol?: unknown;
      workloadLockStates?: Record<string, Record<string, HostLockPin>> } }[]>`SELECT status, config
      FROM harness_shared.bench_runs WHERE workspace_id = ${ws} AND id = ${hostRunId} FOR UPDATE`;
    const row = rows[0];
    if (rows.length !== 1 || row.config.current?.preregHash !== options.preregistration.preregHash ||
        row.config.loopId !== loopId || canonicalJson(row.config.protocol) !== canonicalJson(protocol))
      throw new Error('Lock state capture host checkpoint changed.');
    const slots = row.config.workloadLockStates?.[key] ?? {}, prior = slots[frozen.receipt.receiptRef];
    if (prior) {
      if (canonicalJson(prior.allocation) !== canonicalJson(expected) ||
          createHash('sha256').update(canonicalJson(prior.observation)).digest('hex') !== prior.observationSha256 ||
          canonicalJson(prior.lockGrant?.allocation ?? null) !== canonicalJson(expectedGrant ?? null) ||
          prior.lockGrant && createHash('sha256').update(canonicalJson(prior.lockGrant.observation)).digest('hex') !==
            prior.lockGrant.observationSha256)
        throw new Error('Lock state capture changed after its host pin was frozen.');
      return structuredClone(prior);
    }
    if (row.status !== 'running' || Object.values(slots).some(pin => pin.observation.index === frozen.receipt.index))
      throw new Error('Lock state capture requires a live host and a unique observation index.');
    if (observed?.length !== 1) throw new Error('Lock state capture could not verify the exact private side-store state.');
    const grantSource = grantObserved?.[0]?.metadata?.lockGrantSource as Record<string, unknown> | undefined;
    const stateSource = observed[0].metadata?.lockStateSource as Record<string, unknown> | undefined;
    if (expectedGrant && (grantObserved?.length !== 1 || Date.parse(grantObserved[0].at!) > Date.parse(observed[0].at!) ||
        grantSource?.rootDevice !== stateSource?.rootDevice || grantSource?.rootInode !== stateSource?.rootInode))
      throw new Error('Lock grant capture could not verify the exact live bridge before the state sample.');
    const observation = observed[0], pin: HostLockPin = { allocation: expected, observation,
      observationSha256: createHash('sha256').update(canonicalJson(observation)).digest('hex'),
      ...(expectedGrant && grantObserved ? { lockGrant: { allocation: expectedGrant, observation: grantObserved[0],
        observationSha256: createHash('sha256').update(canonicalJson(grantObserved[0])).digest('hex') } } : {}) };
    await tx`UPDATE harness_shared.bench_runs SET config = jsonb_set(config, '{workloadLockStates}',
      COALESCE(config->'workloadLockStates', '{}'::jsonb) ||
        ${JSON.stringify({ [key]: { ...slots, [frozen.receipt.receiptRef]: pin } })}::text::jsonb)
      WHERE workspace_id = ${ws} AND id = ${hostRunId}`;
    return structuredClone(pin);
  }) as Promise<HostLockPin>;
}

/** Historical inspection reads only the exact host-frozen observation. It
 * survives release/checkout cleanup, but never substitutes for call evidence. */
export function currentBenchTaskLockStateReader(input: CurrentTaskInput, selection: {
  receiptRef: string; observationSha256: string; trialBindingHash: string;
  /** Separately selected host-frozen live bridge authority; no native call or
   * provider consumption is inferred from the queued-to-granted edge. */
  lockGrant?: { receiptRef: string; observationSha256: string; allocationSha256: string };
  /** Optional evidence pairing, not a claim that the call caused a transition.
   * Native business output and bridge grants remain separate authorities. */
  nativeCorrelation?: { before: { receiptRef: string; observationSha256: string; allocationSha256: string };
    allocationSha256: string;
    operation: 'locks:acquire' | 'locks:release';
    receipt: Parameters<typeof currentBenchWorkloadToolResultReader>[0]['receipts'][number];
    /** Exact native result consumed by a separately completed host request.
     * This does not assert that the state sample or bridge grant was consumed. */
    providerInput?: Extract<NativeProviderReceipt, { nativeSource: 'tool-result' }> };
}): import('../evaluation-trial/integrity').WorkloadEvidenceResolver['readObservations'] {
  const frozen = structuredClone(selection), { sql, ws } = resolveDb(input.scope);
  const { options, protocol, hostRunId, loopId } = input;
  const host = { hostRunId, loopId, preregHash: options.preregistration.preregHash, protocol: canonicalJson(protocol),
    runId: options.runId, workspaceId: resolveBenchWorkspace(options.workspaceId),
    domain: resolve(input.checkout.dir), key: currentBenchAssignmentId(options.runId, options.armId, input.task.instanceId, options.seed) };
  if (!/^[a-f0-9]{64}$/.test(frozen.observationSha256) || !/^[a-f0-9]{64}$/.test(frozen.trialBindingHash) ||
      !frozen.receiptRef.trim() || ws !== host.workspaceId || input.context.workspaceId !== options.workspaceId ||
      !input.context.principal?.slug || host.protocol !== canonicalJson(options.preregistration.config))
    throw new Error('Lock state inspection requires exact host observation pins.');
  const correlation = frozen.nativeCorrelation;
  if (frozen.lockGrant && (typeof frozen.lockGrant.receiptRef !== 'string' || !frozen.lockGrant.receiptRef.trim() ||
      frozen.lockGrant.receiptRef === frozen.receiptRef ||
      ![frozen.lockGrant.observationSha256, frozen.lockGrant.allocationSha256].every(value => /^[a-f0-9]{64}$/.test(value))))
    throw new Error('Lock grant inspection requires exact separate host observation and allocation pins.');
  if (correlation && (!['locks:acquire', 'locks:release'].includes(correlation.operation) ||
      !correlation.before.receiptRef.trim() || correlation.before.receiptRef === frozen.receiptRef ||
      ![correlation.before.observationSha256, correlation.before.allocationSha256, correlation.allocationSha256]
        .every(value => /^[a-f0-9]{64}$/.test(value)) || !correlation.receipt.dispatch ||
      correlation.receipt.dispatch.toolName !== correlation.operation))
    throw new Error('Lock state correlation requires distinct pinned samples and an exact native dispatch.');
  if (correlation?.providerInput) {
    const provider = correlation.providerInput as unknown as Record<string, unknown>;
    // Structurally extended receipts may also carry provider accounting fields.
    // Compare the native reader's contract, leaving request selection to the
    // independently pinned provider reader below.
    const nativeKeys = ['receiptRef', 'subjectId', 'taskId', 'ownerId', 'label', 'codexHome',
      'nativeSessionId', 'nativeTurnId', 'callRecordIndex', 'resultRecordIndex', 'callId', 'toolName',
      'sourceSha256', 'argumentsSha256', 'outputSha256', 'index', 'dispatch'] as const satisfies ReadonlyArray<keyof typeof correlation.receipt>;
    const selected = Object.fromEntries(nativeKeys.map(key => [key, correlation.receipt[key]]));
    const native = Object.fromEntries(nativeKeys.map(key => [key, provider[key]]));
    if (provider.nativeSource !== 'tool-result' || canonicalJson(native) !== canonicalJson(selected))
      throw new Error('Lock provider correlation requires the exact selected native tool-result receipt.');
  }
  return async (ref, binding) => {
    if (ref !== frozen.receiptRef || binding.runId !== host.runId || binding.trialBindingHash !== frozen.trialBindingHash) return null;
    const rows = await sql<{ config: { current?: { preregHash?: string }; loopId?: string; protocol?: unknown;
      workloadLockStates?: Record<string, Record<string, HostLockPin>> } }[]>`SELECT config FROM harness_shared.bench_runs
        WHERE workspace_id = ${ws} AND id = ${host.hostRunId}`;
    const config = rows[0]?.config, slots = config?.workloadLockStates?.[host.key], pin = slots?.[ref];
    const validPin = (candidate: HostLockPin | undefined, receiptRef: string, hash: string): candidate is HostLockPin =>
      !!candidate && candidate.observationSha256 === hash && candidate.allocation.runId === host.runId &&
      resolveBenchWorkspace(candidate.allocation.workspaceId) === ws &&
      candidate.allocation.coordinationDomain === host.domain &&
      candidate.allocation.trialBindingHash === frozen.trialBindingHash &&
      candidate.allocation.receipt.receiptRef === receiptRef &&
      candidate.observation.metadata?.receiptRef === receiptRef &&
      candidate.observation.metadata?.runId === host.runId &&
      candidate.observation.metadata?.trialBindingHash === frozen.trialBindingHash &&
      candidate.observation.index === candidate.allocation.receipt.index &&
      createHash('sha256').update(canonicalJson(candidate.observation)).digest('hex') === hash;
    if (rows.length !== 1 || config?.current?.preregHash !== host.preregHash || config.loopId !== host.loopId ||
        canonicalJson(config.protocol) !== host.protocol || !validPin(pin, ref, frozen.observationSha256)) return null;
    let result = structuredClone(pin.observation);
    if (correlation) {
      const before = slots?.[correlation.before.receiptRef];
      if (!validPin(before, correlation.before.receiptRef, correlation.before.observationSha256)) return null;
      const a = before.allocation, b = pin.allocation, receipt = correlation.receipt;
      const source = before.observation.metadata?.lockStateSource as Record<string, unknown> | undefined;
      const afterSource = pin.observation.metadata?.lockStateSource as Record<string, unknown> | undefined;
      const samePaths = (paths: unknown, expected: string[]) => Array.isArray(paths) &&
        canonicalJson([...paths].sort()) === canonicalJson([...expected].sort());
      if (createHash('sha256').update(canonicalJson(a)).digest('hex') !== correlation.before.allocationSha256 ||
          createHash('sha256').update(canonicalJson(b)).digest('hex') !== correlation.allocationSha256 ||
          a.harnessSlug !== b.harnessSlug || a.notBefore !== b.notBefore ||
          a.receipt.subjectId !== b.receipt.subjectId || receipt.subjectId !== b.receipt.subjectId ||
          !samePaths(a.receipt.paths, b.receipt.paths) ||
          canonicalJson(a.receipt.holder) !== canonicalJson(b.receipt.holder) ||
          canonicalJson(a.receipt.waiter ?? null) !== canonicalJson(b.receipt.waiter ?? null) ||
          before.observation.index >= receipt.index || receipt.index >= pin.observation.index ||
          source?.basis !== 'live-private-lock-side-store' || afterSource?.basis !== source.basis ||
          source.coordinationDomain !== host.domain || afterSource.coordinationDomain !== host.domain ||
          typeof source.rootDevice !== 'string' || typeof source.rootInode !== 'string' ||
          source.rootDevice !== afterSource.rootDevice || source.rootInode !== afterSource.rootInode) return null;
      const native = await currentBenchWorkloadToolResultReader({ sql, workspaceId: options.workspaceId,
        harnessSlug: b.harnessSlug, runId: host.runId, trialBindingHash: frozen.trialBindingHash,
        notBefore: a.notBefore, receipts: [receipt] })(receipt.receiptRef, binding);
      if (native?.length !== 1) return null;
      const observed = native[0], call = observed.metadata?.nativeToolSource as Record<string, unknown> | undefined;
      const dispatch = observed.metadata?.platformInvocationSource as Record<string, unknown> | undefined;
      const args = dispatch?.arguments as Record<string, unknown> | undefined;
      const actor = correlation.operation === 'locks:release' ? b.receipt.holder :
        [b.receipt.holder, b.receipt.waiter].find(row => row?.ownerId === receipt.ownerId);
      const times = [before.observation.at, call?.calledAt, dispatch?.invokedAt, observed.at, pin.observation.at]
        .map(value => typeof value === 'string' ? Date.parse(value) : NaN);
      if (!actor || actor.ownerId !== receipt.ownerId || dispatch?.toolName !== correlation.operation ||
          !times.every(Number.isFinite) || times.some((value, index) => index > 0 && value < times[index - 1]) ||
          !Number.isSafeInteger(dispatch.durationMs) || times[2] - Number(dispatch.durationMs) < times[1] ||
          !args || args.coordination_domain !== host.domain ||
          (correlation.operation === 'locks:acquire' ?
            !samePaths(args.paths, b.receipt.paths) || args.intent !== actor.intent || args.external_paths !== undefined :
            args.lock_id !== b.receipt.holder.lockId || args.lock_ids !== undefined || args.all_mine === true ||
              args.paths !== undefined && !samePaths(args.paths, b.receipt.paths))) return null;
      // Retain the native observation as a separately named authority. The
      // state content stays a state snapshot, including after checkout cleanup.
      // Neither dispatcher status nor unchanged contention means business denial.
      result = { ...result, metadata: { ...result.metadata,
        lockStateCorrelation: { basis: 'host-frozen-samples-and-native-dispatch', operation: correlation.operation,
          before: { observationSha256: before.observationSha256, observation: structuredClone(before.observation) },
          afterObservationSha256: pin.observationSha256, nativeObservation: structuredClone(observed) } } };
      if (correlation.providerInput) {
        const provider = await currentBenchTaskProviderInputReader(input, { harnessSlug: b.harnessSlug,
          trialBindingHash: frozen.trialBindingHash, notBefore: a.notBefore, receipts: [correlation.providerInput] });
        const consumed = await provider(receipt.receiptRef, binding), inputObservation = consumed?.[0];
        if (consumed?.length !== 1 || inputObservation?.kind !== 'input' || inputObservation.content !== observed.content ||
            canonicalJson(inputObservation.metadata?.nativeToolSource) !== canonicalJson(observed.metadata?.nativeToolSource) ||
            canonicalJson(inputObservation.metadata?.platformInvocationSource) !== canonicalJson(observed.metadata?.platformInvocationSource) ||
            (inputObservation.metadata?.providerInputSource as Record<string, unknown> | undefined)?.basis !==
              'completed-provider-request-input') return null;
        result.metadata = { ...result.metadata, lockProviderCorrelation: {
          basis: 'host-completed-request-and-exact-native-result', providerObservation: structuredClone(inputObservation) } };
      }
    }
    if (frozen.lockGrant) {
      const grant = pin.lockGrant, selected = frozen.lockGrant;
      if (!grant || grant.observationSha256 !== selected.observationSha256 ||
          createHash('sha256').update(canonicalJson(grant.observation)).digest('hex') !== selected.observationSha256 ||
          createHash('sha256').update(canonicalJson(grant.allocation)).digest('hex') !== selected.allocationSha256 ||
          grant.allocation.receipts.length !== 1) return null;
      const receipt = grant.allocation.receipts[0], observation = grant.observation;
      let expectedGrant: HostLockGrantAllocation;
      try { expectedGrant = hostLockGrantAllocation(pin.allocation, receipt); } catch { return null; }
      const source = observation.metadata?.lockGrantSource as Record<string, unknown> | undefined;
      const stateSource = pin.observation.metadata?.lockStateSource as Record<string, unknown> | undefined;
      const times = [pin.allocation.notBefore, observation.at, pin.observation.at, source?.expiresAt]
        .map(value => typeof value === 'string' ? Date.parse(value) : NaN);
      if (canonicalJson(grant.allocation) !== canonicalJson(expectedGrant) || receipt.receiptRef !== selected.receiptRef ||
          observation.index !== receipt.index || observation.name !== 'lock:grant' || observation.kind !== 'tool-result' ||
          observation.metadata?.receiptRef !== selected.receiptRef || observation.metadata?.runId !== host.runId ||
          observation.metadata?.trialBindingHash !== frozen.trialBindingHash ||
          source?.basis !== 'live-private-lock-side-store-and-bridge' || source.coordinationDomain !== host.domain ||
          stateSource?.basis !== 'live-private-lock-side-store' || stateSource.coordinationDomain !== host.domain ||
          typeof source.rootDevice !== 'string' || typeof source.rootInode !== 'string' ||
          source.rootDevice !== stateSource.rootDevice || source.rootInode !== stateSource.rootInode ||
          source.ticketId !== receipt.ticketId || source.lockId !== receipt.lockId || source.ownerId !== receipt.ownerId ||
          source.ownerLabel !== receipt.ownerLabel || source.queuedAt !== receipt.queuedAt ||
          canonicalJson(source.paths) !== canonicalJson(receipt.paths) || !times.every(Number.isFinite) ||
          times[0] > times[1] || times[1] > times[2] || times[2] >= times[3]) return null;
      result.metadata = { ...result.metadata, lockGrantCorrelation: { basis: 'host-frozen-lock-state-and-bridge-grant',
        observationSha256: grant.observationSha256, grantObservation: structuredClone(observation) } };
    }
    return [result];
  };
}

export type CurrentBenchSettledProviderCapture = NonNullable<ReturnType<
  ReturnType<typeof currentBenchWorkloadProviderInputCapture>['readCapture']>> & {
    reservationNoteSha256: string; settledAt: string;
  };

/** Freeze the final ledger note beside the existing host-owned request pins.
 * This evidence-only transaction can run after checkout cleanup; it grants no
 * generation authority and does not settle spend. Native input, billing and
 * downstream correctness still require their independent readers. */
export async function freezeCurrentBenchTaskProviderReservation(
  input: CurrentTaskInput, reservationId: string,
): Promise<CurrentBenchSettledProviderCapture> {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(reservationId))
    throw new Error('Provider settlement capture requires an exact reservation.');
  const { sql, ws } = resolveDb(input.scope);
  const hostRunId = input.hostRunId, loopId = input.loopId;
  const protocol = canonicalJson(input.protocol), preregHash = input.options.preregistration.preregHash;
  const host = await currentBenchTaskProviderCapture(input, { readOnly: true });
  const captured = host.readCapture(reservationId);
  if (!captured) throw new Error('Provider settlement capture requires an acknowledged host request.');
  const key = captured.accountingBinding.assignmentId;
  type Checkpoint = { allocation: typeof host.allocation; recovery: ReturnType<typeof host.recoveryState>;
    settledProviderInputs?: Record<string, CurrentBenchSettledProviderCapture> };
  return sql.begin(async tx => {
    const runs = await tx<{ config: { current?: { preregHash?: string }; loopId?: string;
      protocol?: unknown; providerInputCaptures?: Record<string, Checkpoint> } }[]>`
      SELECT config FROM harness_shared.bench_runs WHERE workspace_id = ${ws} AND id = ${hostRunId} FOR UPDATE`;
    const config = runs[0]?.config, saved = config?.providerInputCaptures?.[key];
    if (runs.length !== 1 || !saved || config?.current?.preregHash !== preregHash || config.loopId !== loopId ||
        canonicalJson(config.protocol) !== protocol || canonicalJson(saved.allocation) !== canonicalJson(host.allocation) ||
        canonicalJson(saved.recovery) !== canonicalJson(host.recoveryState()))
      throw new Error('Provider settlement capture host checkpoint changed.');
    const rows = await tx<{ note: string | null; status: string; settled_at: Date | null }[]>`
      SELECT note, status, settled_at FROM harness_shared.learning_spend_reservations
       WHERE workspace_id = ${ws} AND id = ${reservationId}::uuid AND loop_id = ${loopId}
         AND arm_id = ${key} AND attempt_kind = 'evaluation'
         AND run_ref = ${`manifest:${preregHash}/attempt:${reservationId}`} FOR UPDATE`;
    const row = rows[0];
    if (rows.length !== 1 || row.status !== 'settled' || typeof row.note !== 'string' ||
        !(row.settled_at instanceof Date) || !Number.isFinite(row.settled_at.getTime()))
      throw new Error('Provider settlement capture requires a settled matching ledger reservation.');
    let note: { nativeGatewayAttempt?: Record<string, unknown>; nativeGatewayAttemptResult?: Record<string, unknown> };
    try { note = JSON.parse(row.note); } catch { throw new Error('Provider settlement capture has an invalid ledger note.'); }
    const attempt = note?.nativeGatewayAttempt, result = note?.nativeGatewayAttemptResult;
    const completion = result?.providerCompletion as Record<string, unknown> | undefined;
    const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const present = (value: unknown) => typeof value === 'string' && !!value.trim();
    const identity = { attemptId: reservationId, manifestSha256: preregHash, armId: key,
      nativeSessionId: captured.nativeSessionId, nativeTurnId: captured.nativeTurnId,
      accountId: captured.accountId, bodySha256: captured.bodySha256,
      ...(captured.agent === 'claude' ? { transport: 'anthropic-http', target: 'https://api.anthropic.com/v1/messages',
        credentialHeader: 'x-api-key', anthropicVersion: captured.anthropicVersion, anthropicBeta: captured.anthropicBeta }
        : currentBenchCodexRoute(captured.payer ?? 'api-key')) };
    if (!attempt || !result || Object.entries(identity).some(([field, value]) => attempt[field] !== value || result[field] !== value) ||
        !digest(attempt.credentialSha256) || result.credentialSha256 !== attempt.credentialSha256 ||
        !present(attempt.clockId) || result.clockId !== attempt.clockId || result.reservationRef !== reservationId ||
        result.outcome !== 'response-completed' || result.responseStatus !== 200 ||
        !digest(result.responseSha256) || typeof result.responseBytes !== 'number' ||
        !Number.isSafeInteger(result.responseBytes) || result.responseBytes <= 0 || result.costUsdMeasurementMissing !== true ||
        completion?.model !== captured.model || !present(completion?.responseId) ||
        completion.providerEffort !== null && completion.providerEffort !== captured.effort ||
        canonicalJson(host.readCapture(reservationId)) !== canonicalJson(captured))
      throw new Error('Provider settlement capture does not match the completed host request.');
    const receipt = { ...captured, reservationNoteSha256: createHash('sha256').update(row.note).digest('hex'),
      settledAt: row.settled_at.toISOString() };
    const prior = saved.settledProviderInputs?.[reservationId];
    if (prior && canonicalJson(prior) !== canonicalJson(receipt))
      throw new Error('Provider settlement capture changed after its host pin was frozen.');
    if (!prior) {
      const next = { ...saved, settledProviderInputs: { ...saved.settledProviderInputs, [reservationId]: receipt } };
      await tx`UPDATE harness_shared.bench_runs SET config = jsonb_set(config,
        ${['providerInputCaptures', key]}::text[], ${JSON.stringify(next)}::text::jsonb)
        WHERE workspace_id = ${ws} AND id = ${hostRunId}`;
    }
    return Object.freeze(receipt);
  });
}

type ProviderInputAllocation = Parameters<typeof currentBenchWorkloadProviderInputReader>[0];
type HostProviderFields = 'reservationNoteSha256' | 'settledAt' | 'bodyRef' | 'bodyPath' | 'maxBytes' | 'model' | 'effort' | 'accountId';
type NativeProviderReceipt<T = ProviderInputAllocation['receipts'][number]> =
  T extends unknown ? Omit<T, HostProviderFields> : never;

/** Compose native input with already frozen host settlement pins. Inspection
 * never allocates, freezes or settles a reservation. Native call authority,
 * lock transitions, billing and downstream grades remain separate receipts. */
export async function currentBenchTaskProviderInputReader(input: CurrentTaskInput, allocation: {
  harnessSlug: string; trialBindingHash: string; notBefore: string; receipts: NativeProviderReceipt[];
}): Promise<ReturnType<typeof currentBenchWorkloadProviderInputReader>> {
  const frozen = structuredClone(allocation);
  const hostRunId = input.hostRunId, loopId = input.loopId, protocol = canonicalJson(input.protocol);
  const preregHash = input.options.preregistration.preregHash;
  const host = await currentBenchTaskProviderCapture(input, { readOnly: true });
  const { sql, ws } = resolveDb(input.scope), key = host.allocation.accountingBinding.assignmentId;
  const rows = await sql<{ config: { current?: { preregHash?: string }; loopId?: string; protocol?: unknown; providerInputCaptures?: Record<string, {
    allocation: typeof host.allocation; recovery: ReturnType<typeof host.recoveryState>;
    settledProviderInputs?: Record<string, CurrentBenchSettledProviderCapture>;
  }> } }[]>`SELECT config FROM harness_shared.bench_runs WHERE workspace_id = ${ws} AND id = ${hostRunId}`;
  const saved = rows[0]?.config?.providerInputCaptures?.[key];
  if (rows.length !== 1 || rows[0].config?.current?.preregHash !== preregHash ||
      rows[0].config.loopId !== loopId || canonicalJson(rows[0].config.protocol) !== protocol ||
      !saved || canonicalJson(saved.allocation) !== canonicalJson(host.allocation) ||
      canonicalJson(saved.recovery) !== canonicalJson(host.recoveryState()) || !frozen.receipts.length)
    throw new Error('Provider input composition requires an unchanged host checkpoint and native receipts.');
  const receipts = frozen.receipts.map(native => {
    const pin = saved.settledProviderInputs?.[native.reservationId];
    const captured = host.readCapture(native.reservationId);
    if (!pin || !captured) throw new Error('Provider input composition requires an explicitly frozen settlement pin.');
    const { reservationNoteSha256, settledAt, ...request } = pin;
    if (typeof reservationNoteSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(reservationNoteSha256) ||
        typeof settledAt !== 'string' || !Number.isFinite(Date.parse(settledAt)) ||
        new Date(settledAt).toISOString() !== settledAt || canonicalJson(request) !== canonicalJson(captured) ||
        (pin.agent === 'claude' ? native.agent !== 'claude'
          : native.agent === 'claude' || native.nativeSessionId !== pin.nativeSessionId || native.nativeTurnId !== pin.nativeTurnId))
      throw new Error('Provider input composition differs from the acknowledged native host request.');
    return { ...native, reservationNoteSha256, settledAt, bodyRef: pin.bodyRef, bodyPath: pin.bodyPath,
      maxBytes: host.allocation.maxBytes, model: pin.model, effort: pin.effort, accountId: pin.accountId };
  });
  return currentBenchWorkloadProviderInputReader({ ...frozen, sql, workspaceId: host.allocation.accountingBinding.workspaceId,
    runId: host.allocation.accountingBinding.runId, checkoutRoot: host.captureRoot, accountingBinding: host.allocation.accountingBinding,
    ...(host.allocation.payer ? { payer: host.allocation.payer } : {}), receipts });
}

/** Resolve the frozen controls once, before any durable run or native launch. */
export function currentBenchLaunchSelection(input: LaunchBenchRunInput, config: unknown) {
  if (!input.current) throw new Error('Current benchmark launch requires its protocol selection.');
  const current = input.current;
  resolveBenchWorkspace(current.workspaceId);
  if (!current.workspaceId.trim() || !/^[a-f0-9]{64}$/.test(current.preregHash)) throw new Error('Invalid current benchmark workspace/hash.');
  const protocol = currentBenchmarkProtocolSchema.parse(config);
  const arm = protocol.arms.find(value => value.id === input.arm);
  if (protocol.runId !== current.protocolRunId || !protocol.seeds.includes(current.seed) || !arm) {
    throw new Error('Current benchmark launch is not in the frozen protocol.');
  }
  // The stock-native adapter is a separate execution route. It must never fall
  // through to a Queen or become a second su treatment under a baseline label.
  const hostReference = arm.id === 'baseline' && arm.agent === 'proximus' &&
    input.suite === 'frontier-swe' && protocol.grader.family === 'frontier-swe';
  const claudeReference = arm.id === 'baseline' && arm.agent === 'claude' &&
    input.suite === 'frontier-swe' && protocol.grader.family === 'frontier-swe' &&
    (arm.payer ?? 'api-key') === 'api-key' &&
    (!arm.control || arm.control.topology === 'stock-native-reference') &&
    arm.account === arm.account.trim() && !['auto', 'default'].includes(arm.account) &&
    /^claude\/\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(arm.runtime.clientVersion);
  if (!['papercusp', 'baseline'].includes(arm.id) || arm.agent !== 'codex' && !hostReference && !claudeReference)
    throw new Error('Unsupported current benchmark execution arm/client.');
  if (input.taskSetId !== 'custom' || input.taskIds && canonicalJson(input.taskIds) !== canonicalJson(protocol.taskIds) ||
      input.model !== undefined && input.model !== arm.model || input.cap !== undefined && input.cap !== 1 ||
      input.maxUsdPerTask !== undefined && input.maxUsdPerTask !== arm.generationBudget.maxUsd ||
      input.maxTokensPerTask !== undefined && input.maxTokensPerTask !== arm.generationBudget.maxTokens ||
      input.maxUsdPerRun !== undefined && input.maxUsdPerRun !== protocol.aggregateBudgetUsd) {
    throw new Error('Current benchmark launch controls drift from its frozen protocol.');
  }
  const id = createHash('sha256').update(canonicalJson({ workspaceId: current.workspaceId,
    protocolRunId: protocol.runId, preregHash: current.preregHash, arm: arm.id, seed: current.seed })).digest('hex');
  // Preserve the narrowed client in the returned type; host references have
  // their own driver and must never widen CurrentSuBenchOptions by accident.
  return { protocol, arm: { ...arm, agent: arm.agent === 'codex' ? 'codex' as const :
    arm.agent === 'claude' ? 'claude' as const : 'proximus' as const }, runId: `current-${id}` };
}

function currentBenchResources(protocol: CurrentBenchmarkProtocol): LearningReservationResourceBudget {
  const budget = protocol.arms[0].generationBudget;
  const ceiling = Math.max(...protocol.priceSchedule.rates.map(rate => rate.inputTokenCeiling ?? 0));
  if (!Number.isSafeInteger(ceiling) || ceiling <= 0) throw new Error('Current native launch requires frozen provider input ceilings.');
  const requestsPerArm = 64;
  // D-023: a subscription request reserves the frozen model maximum output
  // (its backend rejects max_output_tokens); the API-key route keeps 4096.
  const subscription = protocol.arms[0].payer === 'subscription';
  const output = subscription ? Math.max(...protocol.priceSchedule.rates.map(rate => rate.outputTokenCeiling ?? 0))
    : Math.min(budget.maxTokens ?? 4096, 4096);
  if (!Number.isSafeInteger(output) || output <= 0) throw new Error('Current native launch requires a frozen per-request output ceiling.');
  const armIds = protocol.arms.flatMap(arm => protocol.taskIds.flatMap(taskId =>
    protocol.seeds.map(seed => currentBenchAssignmentId(protocol.runId, arm.id, taskId, seed)))).sort();
  const resources = { inputTokens: ceiling * requestsPerArm, outputTokens: output * requestsPerArm,
    requestsPerArm, totalTokensPerArm: budget.maxTokens, armIds, usdPerArm: budget.maxUsd,
    maxOpenUsd: protocol.maxInFlightUsd, wallClockMsPerArm: budget.maxWallClockMs,
    wallClockMs: budget.maxWallClockMs * armIds.length };
  if (!Number.isSafeInteger(resources.inputTokens) || !Number.isSafeInteger(resources.wallClockMs)) throw new Error('Invalid current benchmark resource bounds.');
  return resources;
}

/** The shared production assignment authority used by host and in-container native runs. */
export async function startCurrentBenchTaskAssignment(input: CurrentTaskInput): Promise<
  Pick<FrontierSweNativeAssignment, 'options' | 'observations' | 'stop' | 'readModelCalls' | 'readRequestCensus' | 'issueSessionBudget'>> {
  const { options, protocol, task, context, scope, resources, loopId } = input;
  const capture = await currentBenchTaskProviderCapture(input);
  const currentArm = protocol.arms.find(arm => arm.id === options.armId)!;
  const auth = currentBenchProviderAuthenticator({ workspaceId: options.workspaceId, preregHash: options.preregistration.preregHash,
    protocol, armId: options.armId, taskId: task.instanceId, seed: options.seed });
  const controller = currentBenchGatewayController({ workspaceId: options.workspaceId, loopId, token: randomBytes(32).toString('hex'),
    preregHash: options.preregistration.preregHash, protocol, armId: options.armId, taskId: task.instanceId, seed: options.seed,
    resources, ...(currentArm.payer === 'subscription' ? {} : {
      outputTokenLimit: Math.min(4096, currentArm.generationBudget.maxTokens ?? 4096) }),
    authenticateProvider: auth.authenticateProvider, captureProviderInput: capture.captureProviderInput },
    { enabled: async () => true, getSql: async () => resolveDb(scope).sql });
  let host: Awaited<ReturnType<typeof controller.startNativeGateway>> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    auth.revoke(); controller.revoke();
    return stopping ??= Promise.resolve().then(() => host?.stop());
  };
  try {
    host = await controller.startNativeGateway(context.log);
    const observeIdentity = currentBenchObservationReader({ ...scope, ...input.observation,
      workspaceId: options.workspaceId, gatewayBaseUrl: host.nativeGateway.baseURL }, undefined, host);
    const observations = { ...host, observeIdentity,
      admit: async () => ({ admitted: !options.signal?.aborted, receiptRef: `governor:${options.workspaceId}/${loopId}#${options.preregistration.preregHash}` }) };
    const readRequestCensus = async () => {
      // Session accounting inherits the existing controller-issued lifetime.
      // A copied gateway or a stopped assignment cannot issue fresh evidence.
      requireCurrentBenchHostBinding(observations, options);
      const census = await readCurrentBenchTaskRequestCensus(input, capture);
      requireCurrentBenchHostBinding(observations, options);
      return census;
    };
    return { options, observations, stop, readRequestCensus, issueSessionBudget: host.issueSessionBudget,
      readModelCalls: async () => (await readRequestCensus()).requests.length };
  } catch (error) { await stop(); throw error; }
}

/** Complete reservation-ledger coverage, not proof that no inference bypassed
 * the gateway. These receipts measure usage; they grant no session/spend authority. */
/** Retain the complete host-captured request population so repeated sessions
 * can measure a delta rather than summing successive cumulative call counts. */
export async function readCurrentBenchTaskRequestCensus(input: CurrentTaskInput,
  capture: Pick<Awaited<ReturnType<typeof currentBenchTaskProviderCapture>>, 'readCapture'>): Promise<CurrentBenchTaskRequestCensus> {
  const { options, scope, loopId, task } = input;
  const { sql, ws } = resolveDb(scope);
  if (ws !== options.workspaceId) throw new Error('Native request census workspace differs from its assignment.');
  const assignmentId = currentBenchAssignmentId(options.runId, options.armId, task.instanceId, options.seed);
  const { census } = await getLearningSpendPositions(sql,
    { workspaceId: options.workspaceId, loopId, includeReservations: true });
  if (!census || census.status !== 'complete') throw new Error('Native model request census is unavailable.');
  const ids = new Set<string>(), messages = new Set<string>();
  const requests: CurrentBenchTaskRequestCensus['requests'][number][] = [];
  const binding = Object.freeze({ workspaceId: options.workspaceId, loopId, runId: options.runId,
    preregHash: options.preregistration.preregHash, assignmentId });
  for (const row of census.reservations) {
    if (row.workspaceId !== options.workspaceId || row.loopId !== loopId || ids.has(row.id))
      throw new Error('Native model request census has duplicate or foreign reservations.');
    ids.add(row.id);
    if (row.resources?.armId !== assignmentId) continue;
    const note = JSON.parse(row.note ?? 'null'), attempt = note?.nativeGatewayAttempt;
    const captured = capture.readCapture(row.id);
    if (!attempt || attempt.attemptId !== row.id || attempt.armId !== assignmentId ||
        attempt.manifestSha256 !== options.preregistration.preregHash || !captured ||
        canonicalJson(captured.accountingBinding) !== canonicalJson(binding) ||
        attempt.nativeSessionId !== captured.nativeSessionId || attempt.nativeTurnId !== captured.nativeTurnId ||
        attempt.bodySha256 !== captured.bodySha256 || attempt.accountId !== captured.accountId ||
        (options.agent === 'claude') !== (captured.agent === 'claude'))
      throw new Error('Native model request census differs from its frozen input capture.');
    // Each reservation is one admitted native model request. Include retries,
    // failed responses and refused sends; do not infer calls from agent turns.
    if (captured.agent === 'claude') {
      const result = note.nativeGatewayAttemptResult as GatewayCarryTrialAttemptResult | undefined;
      if (attempt.transport !== 'anthropic-http' || attempt.target !== 'https://api.anthropic.com/v1/messages' ||
          attempt.credentialHeader !== 'x-api-key' || attempt.anthropicVersion !== captured.anthropicVersion ||
          attempt.anthropicBeta !== captured.anthropicBeta || result &&
          (result.reservationRef !== row.id || Object.entries(attempt).some(([key, value]) =>
            result[key as keyof GatewayCarryTrialAttemptResult] !== value)))
        throw new Error('Claude request census differs from its captured provider identity.');
      let nativeMessageId: string | undefined;
      if (result?.outcome === 'response-completed') {
        const completion = result.providerCompletion;
        if (result.responseStatus < 200 || result.responseStatus >= 300 ||
            !/^[a-f0-9]{64}$/.test(result.responseSha256) || !Number.isSafeInteger(result.responseBytes) || result.responseBytes <= 0 ||
            typeof completion?.responseId !== 'string' || !completion.responseId.trim() || completion.responseId.length > 500 ||
            messages.has(completion.responseId) || completion.model !== captured.model ||
            completion.providerEffort !== null && completion.providerEffort !== captured.effort)
          throw new Error('Claude request census has an invalid or reused provider message.');
        nativeMessageId = completion.responseId; messages.add(nativeMessageId);
      }
      requests.push(Object.freeze({ agent: 'claude', reservationId: row.id, bodySha256: captured.bodySha256,
        ...(nativeMessageId ? { nativeMessageId } : {}) }));
    } else requests.push(Object.freeze({ reservationId: row.id, nativeSessionId: captured.nativeSessionId,
      nativeTurnId: captured.nativeTurnId, bodySha256: captured.bodySha256 }));
  }
  return Object.freeze({ binding, populationSha256: census.populationSha256,
    requests: Object.freeze(requests.sort((a, b) => a.reservationId.localeCompare(b.reservationId))) });
}

/** Count admitted native requests, including failed sends, from that same census. */
export async function readCurrentBenchTaskModelCalls(input: CurrentTaskInput,
  capture: Pick<Awaited<ReturnType<typeof currentBenchTaskProviderCapture>>, 'readCapture'>): Promise<number> {
  return (await readCurrentBenchTaskRequestCensus(input, capture)).requests.length;
}

async function liveCurrentTask(input: CurrentTaskInput) {
  const assignment = await startCurrentBenchTaskAssignment(input);
  try {
    const create = input.options.armId === 'baseline' ? createCurrentStockBenchHarness : createCurrentSuBenchHarness;
    return { driver: create(assignment.options, input.context, assignment.observations), stop: assignment.stop };
  } catch (error) { await assignment.stop(); throw error; }
}

/** Read the paired task's actual, completely accounted native spend from the
 * existing result ledger. Equal frozen ceilings alone cannot establish a match. */
export async function readCurrentBenchRepeatedSessionControl(
  input: Pick<CurrentTaskInput, 'options' | 'protocol' | 'task' | 'scope'>,
  read = listRunResults,
): Promise<NonNullable<FrontierSweNativeAssignment['repeatedSession']> | undefined> {
  const { options, protocol, task, scope } = input;
  const arm = protocol.arms.find(arm => arm.id === options.armId);
  const repeated = arm?.control?.repeatedSession;
  if (arm?.control?.topology !== 'repeated-session') return undefined;
  if (options.armId !== 'baseline' || !repeated) throw new Error('Repeated sessions require the frozen stock baseline.');
  const treatment = protocol.arms.find(arm => arm.id === repeated.matchedCostOf);
  const rows = (await read({ ...scope, runId: protocol.runId, suite: task.benchmark })).filter(row =>
    row.taskId === task.instanceId && row.arm === repeated.matchedCostOf && row.seed === options.seed);
  const row = rows[0];
  if (!treatment || rows.length !== 1 || row.runId !== protocol.runId || row.suite !== task.benchmark ||
      row.preregHash !== options.preregistration.preregHash || row.modelId !== treatment.model ||
      row.priceTableVersion !== protocol.priceSchedule.version || row.harnessVersion !== treatment.runtime.sourceRevision ||
      row.graderFamily !== protocol.grader.family || row.graderVersion !== protocol.grader.version ||
      row.generationStatus === 'error' || row.armMeta?.costUsdMeasurementMissing === true)
    throw new Error('Repeated sessions require one completed paired treatment with matching frozen provenance.');
  const accounting = requireCurrentBenchNativeRunCost({ ...row,
    tokensCacheRead: row.tokensCacheRead ?? 0, tokensCacheWrite: row.tokensCacheWrite ?? 0,
    costUsdMeasurementMissing: false, armMeta: row.armMeta }).armMeta.nativeCostAccounting;
  if (accounting.preregHash !== options.preregistration.preregHash || accounting.priceTableVersion !== protocol.priceSchedule.version)
    throw new Error('Paired treatment native source accounting differs from its frozen protocol.');
  return Object.freeze({ treatmentCostUsd: accounting.normalizedCostUsd, maxSessions: repeated.maxSessions });
}

/** Observer metadata lives on the host; the solver's repository remains only in /app. */
export async function startFrontierSweCurrentAssignment(
  input: RunAgentInput<FrontierSweEnvHandle>,
  host: Omit<CurrentTaskInput, 'task' | 'checkout'>,
  ports: {
    start?: typeof startCurrentBenchTaskAssignment;
    observer?: (task: BenchTask) => Promise<TaskCheckout>;
    readResults?: typeof listRunResults;
  } = {},
): Promise<FrontierSweNativeAssignment> {
  const { task, handle, attemptBudget } = input;
  const options = { ...host.options, preregistration: { ...host.options.preregistration,
    config: structuredClone(host.options.preregistration.config) } };
  const protocol = currentBenchmarkProtocolSchema.parse(host.protocol);
  const arm = protocol.arms.find(arm => arm.id === options.armId);
  // Native assignment authority is shared, but Claude remains an explicit
  // stock reference with its own measured CLI, never a su treatment or Codex fallback.
  const nativeHandle = options.agent === 'claude'
    ? options.armId === 'baseline' && (arm?.payer ?? 'api-key') === 'api-key' &&
      (!arm?.control || arm.control.topology === 'stock-native-reference') &&
      !handle.inContainerCodex && handle.inContainerClaude &&
      arm?.runtime.clientVersion === `claude/${handle.inContainerClaude.version}` &&
      /^[a-f0-9]{64}$/.test(handle.inContainerClaude.sha256)
    : options.agent === 'codex' && handle.inContainerCodex && !handle.inContainerClaude;
  if (!arm || arm.agent !== options.agent || input.arm !== options.armId ||
      !['papercusp', 'baseline'].includes(options.armId) || !nativeHandle ||
      task.benchmark !== 'frontier-swe' || task.instanceId !== handle.instanceId ||
      !handle.taskNetwork || !protocol.taskIds.includes(task.instanceId) ||
      options.runId !== protocol.runId || !protocol.seeds.includes(options.seed) ||
      options.model !== arm.model || options.effort !== arm.effort || options.account !== arm.account ||
      canonicalJson(options.preregistration.config) !== canonicalJson(protocol) ||
      options.workspaceId !== host.context.workspaceId || !host.context.principal?.slug ||
      options.signal?.aborted || !['worker', 'solver'].includes(input.role) || input.candidates?.length)
    throw new Error('FrontierSWE host assignment differs from its frozen native task.');
  const remaining = { maxUsd: attemptBudget.maxCostUsd, maxTokens: attemptBudget.maxTokens,
    maxWallClockMs: attemptBudget.maxWallMs };
  for (const key of ['maxUsd', 'maxTokens', 'maxWallClockMs'] as const) {
    const cap = arm.generationBudget[key], left = remaining[key];
    if (cap !== undefined && (left === undefined || !Number.isFinite(left) || left <= 0 || left > cap))
      throw new Error('FrontierSWE assignment budget is missing, exhausted or wider than the frozen cap.');
    // Cost/token caps stay exact: each host pass runs one frozen assignment.
    if (key !== 'maxWallClockMs' && cap !== left)
      throw new Error('FrontierSWE assignment requires the exact frozen cost and token cap.');
  }
  options.driveTimeoutMs = Math.min(options.driveTimeoutMs ?? Infinity,
    remaining.maxWallClockMs ?? arm.generationBudget.maxWallClockMs);
  const repeatedSession = await readCurrentBenchRepeatedSessionControl({ options, protocol, task, scope: host.scope }, ports.readResults);
  const checkout = await (ports.observer ?? (async (task: BenchTask) => {
    const parent = defaultBenchResultsDir();
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(join(parent, 'frontier-observer-'));
    return { dir, repo: `frontier-swe:${task.instanceId}`, baseCommit: protocol.grader.version,
      cleanup: async () => { rmSync(dir, { recursive: true, force: true }); } };
  }))(task);
  try {
    const assignment = await (ports.start ?? startCurrentBenchTaskAssignment)({ ...host, options, protocol, task, checkout });
    return { ...assignment, checkout, generationBudget: { ...arm.generationBudget },
      ...(repeatedSession ? { repeatedSession } : {}) };
  } catch (error) { await checkout.cleanup(); throw error; }
}

/** Host-only factory. This reuses capture/governor/billing authority and
 * intentionally issues neither a native session nor an accepted grade. */
export async function startFrontierSweProximusAssignment(
  input: RunAgentInput<FrontierSweEnvHandle>,
  host: Omit<CurrentBenchProviderTaskInput, 'task' | 'checkout' | 'observation'> & { pythonBin: string },
  ports: Partial<{
    capture: (input: CurrentBenchProviderTaskInput) => Promise<Pick<Awaited<ReturnType<typeof currentBenchTaskProviderCapture>>, 'captureProviderInput'>>;
    authenticate: typeof currentBenchProviderAuthenticator;
    controller: typeof currentBenchGatewayController;
    run: typeof runProximusHost;
    population: typeof readProximusAttemptPopulation;
    billing: typeof readProximusBilling;
  }> = {},
): Promise<FrontierSweProximusAssignment> {
  const trial = structuredClone(input), protocol = currentBenchmarkProtocolSchema.parse(host.protocol);
  const options = { ...host.options, preregistration: { ...host.options.preregistration,
    config: structuredClone(host.options.preregistration.config) } };
  const { task, handle, attemptBudget } = trial;
  const arm = protocol.arms.find(value => value.id === options.armId)!;
  const { sql, ws } = resolveDb(host.scope);
  if (!arm || arm.agent !== 'proximus' || options.agent !== 'proximus' || options.armId !== 'baseline' || trial.arm !== 'baseline' ||
      task.benchmark !== 'frontier-swe' || task.instanceId !== handle.instanceId ||
      !handle.containerId.trim() || handle.image !== protocol.grader.images?.[task.instanceId] ||
      handle.inContainerCodex || handle.taskNetwork || trial.candidates?.length || !['solver', 'worker'].includes(trial.role) ||
      ws !== options.workspaceId || host.context.workspaceId !== ws || !host.context.principal?.slug ||
      options.model !== arm.model || options.effort !== arm.effort || options.account !== arm.account ||
      !arm.account.trim() || ['auto', 'default'].includes(arm.account) ||
      canonicalJson(options.preregistration.config) !== canonicalJson(protocol) || !isAbsolute(host.pythonBin) ||
      attemptBudget.maxCostUsd !== arm.generationBudget.maxUsd || attemptBudget.maxTokens !== arm.generationBudget.maxTokens)
    throw new Error('FrontierSWE Proximus host assignment differs from its frozen task/account/caps.');
  const execution = { runId: options.runId, armId: options.armId, taskId: task.instanceId, seed: options.seed,
    agent: options.agent, model: options.model, effort: options.effort, account: options.account,
    budget: structuredClone(arm.generationBudget), topology: 'stock-native-reference' as const };
  requireCurrentBenchmarkAssignment(protocol, execution);
  const maxWallClockMs = Math.min(options.driveTimeoutMs ?? arm.generationBudget.maxWallClockMs,
    attemptBudget.maxWallMs ?? arm.generationBudget.maxWallClockMs);
  if (!Number.isSafeInteger(maxWallClockMs) || maxWallClockMs <= 0 ||
      !Number.isSafeInteger(attemptBudget.maxWallMs) || attemptBudget.maxWallMs! > arm.generationBudget.maxWallClockMs ||
      !task.problemStatement.trim() || options.signal?.aborted)
    throw new Error('FrontierSWE Proximus host deadline/instruction is invalid or cancelled.');
  const networkArgs = frontierSweAgentNetworkArgs(task);
  const network = networkArgs[0] === '--network' ? networkArgs[1] : 'bridge';
  const networkMode = network === 'none' ? (task.graderMeta?.networkMode === 'allowlist' ? 'allowlist' : 'no-network') : 'public';
  const pythonBin = host.pythonBin, context = host.context;
  const resources = structuredClone(host.resources), scope = { ...host.scope }, loopId = host.loopId, hostRunId = host.hostRunId;
  await requireCommittedPreregistration(protocol.runId, options.preregistration, { ...scope, repoRoot: options.preregistration.repoRoot });
  if (options.signal?.aborted) throw new Error('FrontierSWE Proximus host assignment cancelled during preparation.');
  const parent = defaultBenchResultsDir();
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // Keep official trajectory artifacts after stop. The operational run owns
  // retention; stop closes authority, rather than deleting acceptance evidence.
  const trialDir = mkdtempSync(join(parent, 'frontier-proximus-'));
  const capture = await (ports.capture ?? currentBenchTaskProviderCapture)({ options, protocol, task, context, scope,
    resources, loopId, hostRunId, checkout: { dir: trialDir, repo: `frontier-swe:${task.instanceId}`,
      baseCommit: protocol.grader.version, cleanup: async () => {} } });
  if (options.signal?.aborted) throw new Error('FrontierSWE Proximus host assignment cancelled during capture.');
  const auth = (ports.authenticate ?? currentBenchProviderAuthenticator)({ workspaceId: ws,
    preregHash: options.preregistration.preregHash, protocol, armId: arm.id, taskId: task.instanceId, seed: options.seed });
  const outputTokenLimit = Math.min(4096, arm.generationBudget.maxTokens ?? 4096,
    protocol.priceSchedule.rates.find(rate => rate.model === arm.model)!.outputTokenCeiling!);
  let controller: ReturnType<typeof currentBenchGatewayController> | undefined;
  let gateway: Awaited<ReturnType<NonNullable<typeof controller>['startHostGateway']>> | undefined;
  let closing: Promise<void> | undefined, stopping: Promise<void> | undefined;
  let running: ReturnType<FrontierSweProximusAssignment['execute']> | undefined;
  const abort = new AbortController();
  const closeGateway = () => {
    auth.revoke(); controller?.revoke();
    return closing ??= Promise.resolve().then(() => gateway?.stop());
  };
  const cancel = () => { abort.abort(); void closeGateway().catch(() => {}); };
  try {
    controller = (ports.controller ?? currentBenchGatewayController)({ workspaceId: ws, loopId, token: randomBytes(32).toString('hex'),
      preregHash: options.preregistration.preregHash, protocol, armId: arm.id, taskId: task.instanceId, seed: options.seed,
      resources, outputTokenLimit, authenticateProvider: auth.authenticateProvider, captureProviderInput: capture.captureProviderInput },
      { enabled: async () => true, getSql: async () => sql });
    gateway = await controller.startHostGateway(context.log);
    if (options.signal?.aborted) throw new Error('FrontierSWE Proximus host assignment cancelled during gateway startup.');
    options.signal?.addEventListener('abort', cancel, { once: true });
    // Abort can occur between checking and subscribing.
    if (options.signal?.aborted) cancel();
    const binding = structuredClone(gateway.accountingBinding);
    const execute: FrontierSweProximusAssignment['execute'] = () => {
      if (running || closing || abort.signal.aborted) return Promise.reject(new Error('Proximus assignment is consumed, stopped or cancelled.'));
      running = (async () => {
        const timer = setTimeout(cancel, maxWallClockMs);
        try {
          const process = await (ports.run ?? runProximusHost)(protocol, { ...execution,
            handle, pythonBin, trialDir, instruction: task.problemStatement,
            maxWallClockMs, outputTokenLimit, network, networkMode, gateway: gateway!, signal: abort.signal });
          // Revoke future sends before the stable census/bill read. A result
          // cannot authorize another execution or restore a spent gateway.
          await closeGateway();
          const readCensus = async () =>
            (await getLearningSpendPositions(sql, { workspaceId: ws, loopId, includeReservations: true })).census;
          const attempts = await (ports.population ?? readProximusAttemptPopulation)(binding, readCensus);
          const billing = await (ports.billing ?? readProximusBilling)(sql, binding, readCensus);
          if (abort.signal.aborted) throw new Error('Proximus assignment was cancelled or exceeded its deadline.');
          return { process, attempts, billing, pricing: priceProximusAttempts(protocol, attempts) };
        } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); await closeGateway(); }
      })();
      return running;
    };
    return Object.freeze({ agent: 'proximus', runId: protocol.runId, armId: 'baseline', workspaceId: ws,
      taskId: task.instanceId, containerId: handle.containerId, image: handle.image, execute,
      stop() {
        abort.abort(); options.signal?.removeEventListener('abort', cancel);
        const closed = closeGateway();
        return stopping ??= (async () => { try { await closed; } finally { await running?.catch(() => {}); } })();
      } });
  } catch (error) { options.signal?.removeEventListener('abort', cancel); await closeGateway(); throw error; }
}

/** Restart/cancel recovery uses durable native task labels, independently of a vanished gateway. */
async function retireCurrentRun(workspaceId: string, runId: string): Promise<void> {
  const [{ listTasks }, { killTask }] = await Promise.all([import('../task-manager/store'), import('../task-manager/control')]);
  await recoverCurrentBenchRun({ listTasks, killTask: id => killTask(id, {
    includeSubtree: true, reapTerminalResidue: true, escalateAfterMs: 5000 }) }, { workspaceId, runId });
}

async function launchCurrentBenchRun(input: LaunchBenchRunInput, deps: LaunchDeps): Promise<{ runId: string; done: Promise<void> }> {
  const current = input.current!, context = deps.currentContext;
  const scope = { ...deps.scope, workspaceId: resolveBenchWorkspace(current.workspaceId) };
  const { sql, ws } = resolveDb(scope);
  if (!context?.principal?.slug || context.workspaceId !== ws) throw new Error('Current benchmark launch requires authenticated isolated host authority.');
  const prereg = await getPrereg({ runId: current.protocolRunId, preregHash: current.preregHash }, scope);
  if (!prereg) throw new Error('Current benchmark pre-registration was not found.');
  const { protocol, arm, runId } = currentBenchLaunchSelection(input, prereg.config);
  const frontier = input.suite === 'frontier-swe';
  if (frontier && protocol.grader.family !== 'frontier-swe') throw new Error('FrontierSWE requires its frozen official grader.');
  if (!['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(arm.effort)) throw new Error('Unsupported frozen native effort.');
  const registration = { preregHash: prereg.preregHash, config: protocol, repoRoot: deps.currentRepoRoot };
  await requireCommittedPreregistration(protocol.runId, registration, { ...scope, repoRoot: deps.currentRepoRoot });
  const loaded = await (deps.loadBacklog ?? loadBenchTaskSet)(frontier ? 'frontier-swe-v2-custom' : 'custom', protocol.taskIds);
  if (canonicalJson(loaded.map(task => task.instanceId).sort()) !== canonicalJson([...protocol.taskIds].sort()) ||
      loaded.some(task => task.benchmark !== (input.suite ?? 'swe-bench-pro'))) throw new Error('Current benchmark task loader differs from the frozen roster/suite.');
  const backlog = protocol.taskIds.map(id => loaded.find(task => task.instanceId === id)!);
  // Freeze host bytes before allocating a run. The existing container seam
  // rechecks this hash and the protocol's CLI version in each actual task image.
  const claudeBinary = arm.agent === 'claude'
    ? realpathSync((deps.currentNative?.resolveClaudeBinary ?? resolveContainerClaudeBinary)()) : undefined;
  const claude = claudeBinary ? { claudeBinary, version: arm.runtime.clientVersion.slice('claude/'.length),
    sha256: createHash('sha256').update(readFileSync(claudeBinary)).digest('hex') } : undefined;
  // Installation and confined byte measurement precede every durable allocation.
  // A frozen interpreter path alone is not evidence of the installed runtime.
  const prepared = arm.agent === 'proximus'
    ? await (deps.currentProximus?.prepare ?? prepareProximusRuntime)({ signal: context.signal }) : undefined;
  if (prepared && (!isAbsolute(prepared.pythonBin) || prepared.runtime.schemaVersion !== 1 ||
      !Number.isSafeInteger(prepared.runtime.fileCount) || prepared.runtime.fileCount <= 0 ||
      prepared.runtime.sourceRevision !== arm.runtime.sourceRevision ||
      prepared.runtime.clientVersion !== arm.runtime.clientVersion ||
      prepared.runtime.runtimeRevision !== arm.runtime.runtimeRevision ||
      prepared.runtime.harborVersion !== arm.runtime.proximus?.harborVersion))
    throw new Error('Proximus prepared runtime differs from its frozen protocol.');
  if (arm.agent === 'proximus') context.signal?.throwIfAborted();
  const resources = currentBenchResources(protocol), loopId = `benchmark:${prereg.preregHash}`;
  const meta = { reservationBinding: prereg.preregHash, reservationResourceBudget: resources };
  const loop = await registerLearningLoop(sql, { workspaceId: ws, loopId, ifMissing: true, budgetKind: 'lifetime',
    budgetUsd: protocol.aggregateBudgetUsd, enabled: true, enforcement: 'governor', meta });
  if (!loop.enabled || loop.budgetKind !== 'lifetime' || loop.budgetUsd !== protocol.aggregateBudgetUsd ||
      canonicalJson(loop.meta) !== canonicalJson(meta)) throw new Error('Current benchmark governor registration differs from the frozen policy.');
  await sql.begin(async tx => {
    // Store helpers only use the tagged-query surface. Keep this transaction
    // confined to this callback despite DbScope's existing pool-client type.
    const transactionScope = { ...scope, sql: tx as unknown as typeof sql };
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`benchmark-launch:${ws}`}, 0))`;
    await assertNoActiveRun(transactionScope);
    if ((await tx`SELECT id FROM harness_shared.bench_runs WHERE workspace_id = ${ws} AND id = ${runId}`).length) {
      throw new Error('Current benchmark arm/seed already has a durable attempt; use a new frozen protocol.');
    }
    await upsertBenchRun({ id: runId, arm: arm.id, taskSetId: 'custom', suite: input.suite ?? 'swe-bench-pro', model: arm.model,
      source: 'ui', status: 'running', taskCount: backlog.length,
      config: { current: { ...current, protocolRunId: protocol.runId }, protocol, resources, loopId } }, transactionScope);
    for (const task of backlog) await upsertBenchRunTask(runId, { instanceId: task.instanceId, taskStatus: 'todo' }, transactionScope);
  });
  const abort = new AbortController();
  const active: ActiveRun = { runId, workspaceId: ws, arm: arm.id, taskSetId: 'custom', taskIds: protocol.taskIds,
    startedAtMs: Date.now(), potSlugs: new Set(), cancelled: false, abort, protocolRunId: protocol.runId };
  activeRuns.set(runId, active);
  const run = async (req: HiveBacklogRunRequest): Promise<HiveBacklogResult> => {
    const taskResults: FleetTaskResult[] = [];
    if (frontier) {
      const execute = deps.currentFrontierArm ?? (await import('./frontier-swe-arm')).runFrontierSweCurrentArm;
      const options = { workspaceId: ws, runId: protocol.runId, armId: arm.id, seed: current.seed,
        agent: arm.agent, model: arm.model, effort: arm.effort as CurrentSuBenchOptions['effort'], account: arm.account,
        preregistration: registration, signal: abort.signal, driveTimeoutMs: arm.generationBudget.maxWallClockMs };
      const frozenBudget = arm.generationBudget;
      const host = { protocol, context, scope, resources, loopId, hostRunId: runId };
      const ownAssignment = <T extends { stop(): Promise<void> }>(assignment: T): T => {
        active.stopCurrent = assignment.stop;
        return { ...assignment, stop: async () => { try { await assignment.stop(); } finally { active.stopCurrent = undefined; } } };
      };
      const launch: FrontierSweLaunchAdapterConfig = arm.agent === 'proximus'
        ? { execution: 'proximus-host', runId, protocolRunId: protocol.runId, context, signal: abort.signal,
          startAssignment: async trial => {
            await upsertBenchRunTask(runId, { instanceId: trial.task.instanceId, taskStatus: 'in_progress' }, scope);
            return ownAssignment(await (deps.currentProximus?.start ?? startFrontierSweProximusAssignment)(trial,
              { ...host, options: { ...options, agent: 'proximus' }, pythonBin: prepared!.pythonBin }));
          } }
        : { runId, protocolRunId: protocol.runId, context, signal: abort.signal,
          ...(claude ? { execution: 'claude-native' as const, seam: { inContainerClaude: claude } } : {}),
          mcpOrigin: resolveSpawnHostOperatorBaseUrl(), hookRecordDir: join(defaultBenchResultsDir(), 'frontier-hooks', runId),
          startAssignment: async trial => {
            await upsertBenchRunTask(runId, { instanceId: trial.task.instanceId, taskStatus: 'in_progress' }, scope);
            return ownAssignment(await (deps.currentNative?.start ?? startFrontierSweCurrentAssignment)(trial,
              { ...host, options: { ...options, agent: arm.agent === 'claude' ? 'claude' : 'codex' }, observation: current.observation }));
          } };
      await execute({ spec: resolveCoordinationSpec({ id: arm.id, spine: { claimModel: 'self-claim-fifo' } }),
        runId, seed: current.seed, backlog, cap: 1,
        budget: { maxCostUsd: frozenBudget.maxUsd, maxTokens: frozenBudget.maxTokens, maxWallMs: frozenBudget.maxWallClockMs },
        rowMeta: { version: protocol.grader.version, modelId: arm.model,
          harnessVersion: arm.runtime.sourceRevision, preregHash: prereg.preregHash, rolloutId: runId,
          priceTableVersion: protocol.priceSchedule.version },
        launch,
        onResult: async row => {
          const native = row.armMeta?.nativeUsage as { stopReason?: GenerationStopReason; tokensCacheRead?: number; tokensCacheWrite?: number } | undefined;
          const usage = arm.agent === 'proximus'
            ? (row.armMeta?.hostReference as { attempts?: { knownUsage?: { tokensCacheRead?: number; tokensCacheWrite?: number } } } | undefined)?.attempts?.knownUsage
            : native;
          const stopReason = row.generationStatus === 'error' ? 'error' : row.generationStatus === 'timeout' ? 'timeout' :
            native?.stopReason ?? (row.capped ? 'budget-exhausted' : 'done');
          const result: FleetTaskResult = { attempt: { arm: arm.id,
            blueprintId: arm.agent === 'proximus' ? 'proximus-host' : arm.id === 'baseline'
              ? arm.agent === 'claude' ? CURRENT_STOCK_CLAUDE_BLUEPRINT : CURRENT_STOCK_CODEX_BLUEPRINT : FULL_SPINE_BLUEPRINT,
            instanceId: row.taskId, seed: String(current.seed), diff: '', tokensIn: row.tokensIn, tokensOut: row.tokensOut,
            tokensCacheRead: usage?.tokensCacheRead, tokensCacheWrite: usage?.tokensCacheWrite,
            costUsd: row.costUsd, turns: row.turns, wallClockMs: row.wallClockMs, trajectoryRef: row.traceRefs?.[0] ?? '',
            stopReason, generationError: row.generationError ?? undefined,
            armMeta: { ...row.armMeta, score: row.score, graderStatus: row.graderStatus, graderDetail: row.graderDetail } },
            cupId: currentBenchAssignmentId(protocol.runId, arm.id, row.taskId, current.seed),
            placedAtMs: Date.now() - row.wallClockMs, startedAtMs: Date.now() - row.wallClockMs,
            finishedAtMs: Date.now(), disposition: 'spawn' };
          await emitRollout({ runId: protocol.runId, preregHash: prereg.preregHash, suite: 'frontier-swe', taskId: row.taskId,
            arm: arm.id, seed: current.seed, modality: 'in-container', fleetRunId: runId,
            generation: { status: row.generationStatus, error: row.generationError, tokensIn: row.tokensIn, tokensOut: row.tokensOut,
              tokensTotal: row.tokensTotal, tokensCacheRead: usage?.tokensCacheRead ?? null, tokensCacheWrite: usage?.tokensCacheWrite ?? null,
              wallClockMs: row.wallClockMs, turns: row.turns, budgetTokens: row.budgetTokens, capped: row.capped,
              modelId: arm.model, harnessVersion: row.harnessVersion, trajectoryRef: result.attempt.trajectoryRef,
              trajectoryKind: arm.agent === 'proximus' ? 'proximus-host' : arm.agent === 'claude' ? 'native-claude' : 'native-codex', armMeta: result.attempt.armMeta },
            grading: { resolved: row.resolved, status: row.graderStatus, family: protocol.grader.family,
              version: protocol.grader.version, score: row.score, structuredOutput: row.graderDetail },
            provenance: { configSnapshot: protocol, harnessGitSha: arm.runtime.sourceRevision } }, scope);
          taskResults.push(result);
          await upsertBenchRunTask(runId, { ...taskRowFromFleetResult(result), taskStatus: 'graded', resolved: row.resolved }, scope);
        } });
      return { arm: req.arm, suite: req.suite, runId, seed: current.seed, startedAtMs: active.startedAtMs,
        finishedAtMs: Date.now(), taskResults, coordEvents: [], peakConcurrentBees: taskResults.length ? 1 : 0, runError: null };
    }
    for (const task of backlog) {
      if (abort.signal.aborted) break;
      await upsertBenchRunTask(runId, { instanceId: task.instanceId, taskStatus: 'in_progress' }, scope);
      const options: CurrentSuBenchOptions = { workspaceId: ws, runId: protocol.runId, armId: arm.id, seed: current.seed,
        agent: 'codex', model: arm.model, effort: arm.effort as CurrentSuBenchOptions['effort'], account: arm.account,
        preregistration: registration, signal: abort.signal, driveTimeoutMs: arm.generationBudget.maxWallClockMs };
      const startedAtMs = Date.now();
      let owned: Awaited<ReturnType<NonNullable<LaunchDeps['currentTask']>>> | undefined;
      try {
        const attempt = await runArmGeneration({ arm: arm.id, blueprintId: arm.id === 'baseline' ? CURRENT_STOCK_CODEX_BLUEPRINT : FULL_SPINE_BLUEPRINT, task,
          seed: String(current.seed), budget: arm.generationBudget }, {
          clone: deps.currentGeneration?.clone ?? cloneTaskRepo, extractDiff: deps.currentGeneration?.extractDiff ?? extractDiff,
          instantiate: async (blueprintId, task, checkout, budget) => {
            if (abort.signal.aborted) throw new Error('Current benchmark assignment cancelled before host allocation.');
            owned = await (deps.currentTask ?? liveCurrentTask)({ options, protocol, task, context, scope, resources, loopId,
              checkout, hostRunId: runId, observation: current.observation });
            active.stopCurrent = owned.stop;
            try { return await owned.driver.spinRunAndCost({ blueprintId, task, checkout, budget }); }
            finally { await owned.stop(); owned = undefined; active.stopCurrent = undefined; }
          } });
        const result: FleetTaskResult = { attempt, cupId: currentBenchAssignmentId(protocol.runId, arm.id, task.instanceId, current.seed),
          placedAtMs: startedAtMs, startedAtMs, finishedAtMs: Date.now(), disposition: 'spawn' };
        taskResults.push(result);
        await upsertBenchRunTask(runId, taskRowFromFleetResult(result), scope);
      } finally { await owned?.stop(); active.stopCurrent = undefined; }
    }
    return { arm: req.arm, suite: req.suite, runId, seed: current.seed, startedAtMs: active.startedAtMs,
      finishedAtMs: Date.now(), taskResults, coordEvents: [], peakConcurrentBees: taskResults.length ? 1 : 0, runError: null };
  };
  const req: HiveBacklogRunRequest = { arm: arm.id as HiveBacklogRunRequest['arm'], suite: (input.suite ?? 'swe-bench-pro') as HiveBacklogRunRequest['suite'],
    runId, seed: current.seed, backlog, budget: arm.generationBudget };
  return { runId, done: executeDetached(active, req, run, deps.dissolve ?? dissolveBenchHive, scope) };
}

const ACTIVE_STATES: BenchRunStatus[] = ['pending', 'running', 'grading'];

/** Throw if a run is already in flight (single-active-run — the spend-safety + D-005 gate). */
export async function assertNoActiveRun(opts: DbScope = {}): Promise<void> {
  const { sql, ws } = resolveDb(opts);
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM harness_shared.bench_runs
     WHERE workspace_id = ${ws} AND status = ANY(${ACTIVE_STATES as unknown as string[]})
     LIMIT 1
  `;
  if (rows.length > 0) {
    throw new Error(`conflicting_run_active: run ${rows[0].id} is still in flight — cancel it before launching another`);
  }
}

/**
 * Launch a bench run. Persists status=running, kicks the engine DETACHED, and
 * returns the run_id immediately. The caller (the launch route) does NOT await
 * the run — it streams live via @papercusp/sync.
 */
export async function launchBenchRun(
  input: LaunchBenchRunInput,
  deps: LaunchDeps = {},
): Promise<{ runId: string; done: Promise<void> }> {
  const assertEnabled = deps.assertEnabled ?? (() => assertExternalBenchEnabled('system'));
  await assertEnabled();

  if (input.current) return launchCurrentBenchRun(input, deps);
  if (input.arm === 'papercusp') throw new Error('Current Papercusp execution requires a committed frozen protocol; legacy launch is refused.');

  const scope = deps.scope ?? {};
  const { ws } = resolveDb(scope);
  await assertNoActiveRun(scope);

  const model = input.model ?? 'opus';
  const suite = input.suite ?? 'swe-bench-pro';
  const runId = deps.runId ?? `ui-${input.arm}-${Date.now()}`;
  const loadBacklog = deps.loadBacklog ?? loadBenchTaskSet;
  const run = deps.run ?? runHiveBacklog;
  // Per-arm driver selection (same mechanism the engine already uses: ONE bound HiveBacklogDriver per
  // run, picked by arm). 'su-independent' → the independent-su-agents pool driver (NO queen/hive); every
  // other arm → the real-Queen driver, which itself branches on 'hive-realqueen' vs 'fifo-noqueen'. A
  // test/host may override with deps.bindDriver. Both binds share the {workspaceId, onEnrolled,
  // onTaskCollected} persister surface; onHiveCreated is a no-op for the hive-less su-independent arm.
  const bindDriver = deps.bindDriver ?? (input.arm === SU_INDEPENDENT_ARM ? bindSuIndependentBacklogDriver : bindRealQueenBacklogDriver);
  const dissolve = deps.dissolve ?? dissolveBenchHive;

  const backlog = await loadBacklog(input.taskSetId, input.taskIds);

  await upsertBenchRun(
    {
      id: runId,
      arm: input.arm,
      taskSetId: input.taskSetId,
      suite,
      model,
      source: 'ui',
      status: 'running',
      taskCount: backlog.length,
      config: {
        arm: input.arm,
        taskSetId: input.taskSetId,
        taskIds: input.taskIds ?? null,
        model,
        cap: input.cap ?? null,
        maxUsdPerTask: input.maxUsdPerTask ?? null,
        maxTokensPerTask: input.maxTokensPerTask ?? null,
        maxUsdPerRun: input.maxUsdPerRun ?? null,
      },
    },
    scope,
  );

  // Seed per-task rows as todo so the live monitor shows the full task set up-front.
  for (const t of backlog) {
    await upsertBenchRunTask(runId, { instanceId: t.instanceId, taskStatus: 'todo' }, scope);
  }

  const active: ActiveRun = {
    runId,
    workspaceId: ws,
    arm: input.arm,
    taskSetId: input.taskSetId,
    taskIds: input.taskIds,
    startedAtMs: Date.now(),
    potSlugs: new Set(),
    cancelled: false,
  };
  activeRuns.set(runId, active);

  // Wire the persister durability hooks onto the real-Queen driver.
  bindDriver({
    workspaceId: ws,
    onHiveCreated: (hiveHome: string) => {
      active.potSlugs.add(hiveHome);
      void setBenchRunHive(runId, hiveHome, scope).catch(() => {});
    },
    onEnrolled: (e) => {
      void upsertBenchRunTask(runId, { instanceId: e.task.instanceId, taskStatus: 'in_progress' }, scope).catch(() => {});
    },
    onTaskCollected: (tr) => {
      void upsertBenchRunTask(runId, taskRowFromFleetResult(tr), scope).catch(() => {});
    },
  });

  const req: HiveBacklogRunRequest = {
    arm: input.arm as HiveBacklogRunRequest['arm'],
    suite: suite as HiveBacklogRunRequest['suite'],
    runId,
    seed: 1,
    backlog,
    budget: { maxUsd: input.maxUsdPerTask ?? 10, maxTokens: input.maxTokensPerTask ?? 4_000_000 },
  };

  // DETACHED — the route does NOT await `done`. Always tears down in the finally
  // (the fast path; the boot reaper is the SIGKILL-resilient backstop). `done` is
  // returned so tests / advanced callers can await completion.
  const done = executeDetached(active, req, run, dissolve, scope);

  return { runId, done };
}

/** Heartbeat interval (ms) the live run bumps bench_runs.updated_at on, so the
 *  boot reaper can tell a crashed host (stale heartbeat) from a run legitimately
 *  in flight in ANOTHER live host (fresh heartbeat). */
const HEARTBEAT_MS = 60_000;

/** Bump a run's updated_at — the liveness heartbeat. */
async function touchBenchRun(runId: string, opts: DbScope): Promise<void> {
  const { sql, ws } = resolveDb(opts);
  await sql`UPDATE harness_shared.bench_runs SET updated_at = now() WHERE id = ${runId} AND workspace_id = ${ws}`;
}

async function executeDetached(
  active: ActiveRun,
  req: HiveBacklogRunRequest,
  run: (req: HiveBacklogRunRequest) => Promise<HiveBacklogResult>,
  dissolve: (potSlug: string, workspaceId: string) => Promise<void>,
  scope: DbScope,
): Promise<void> {
  const { runId } = active;
  // Liveness heartbeat — unref'd so it never keeps the process alive on its own.
  const heartbeat = setInterval(() => void touchBenchRun(runId, scope).catch(() => {}), HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
  try {
    const result = await run(req);
    if (active.cancelled) return; // cancelBenchRun already froze the status
    // Write the on-disk snapshot (PreservedArmRun + diffs + sample) so the run is
    // gradeable (P-010) + exportable (P-013), exactly like a CLI run. Best-effort.
    if (result.taskResults.length > 0) {
      try {
        const { writeRunSnapshot } = await import('./run-snapshot');
        writeRunSnapshot({
          runId,
          arm: active.arm,
          result,
          startedAtMs: active.startedAtMs,
          taskSetId: active.taskSetId,
          taskIds: active.taskIds,
        });
      } catch (error) {
        if (active.protocolRunId) throw error;
        /* snapshot is best-effort — the PG store already has the live truth */
      }
    }
    await setBenchRunEvents(runId, result.coordEvents ?? [], scope);
    await recordRunCompletion(
      runId,
      {
        peakConcurrentBees: result.peakConcurrentBees,
        wallMs: Math.max(0, result.finishedAtMs - result.startedAtMs),
        runError: result.runError ?? null,
      },
      scope,
    );
  } catch (e) {
    if (!active.cancelled) {
      await setBenchRunStatus(runId, 'error', { runError: e instanceof Error ? e.message : String(e) }, scope).catch(() => {});
    }
  } finally {
    clearInterval(heartbeat);
    // ALWAYS dissolve every hive this run minted — no orphan learning loop survives.
    for (const slug of active.potSlugs) {
      await dissolve(slug, active.workspaceId).catch(() => {});
    }
    activeRuns.delete(runId);
  }
}

/** Cancel an in-flight run: freeze status, dissolve its hive (stops spend). */
export async function cancelBenchRun(
  runId: string,
  deps: { scope?: DbScope; dissolve?: (potSlug: string, workspaceId: string) => Promise<void> } = {},
): Promise<{ cancelled: boolean }> {
  const scope = deps.scope ?? {};
  const { sql, ws } = resolveDb(scope);
  const dissolve = deps.dissolve ?? dissolveBenchHive;

  const rows = await sql<{ status: string; pot_slug: string | null; config: Record<string, unknown> | null }[]>`
    SELECT status, pot_slug, config FROM harness_shared.bench_runs
     WHERE id = ${runId} AND workspace_id = ${ws} LIMIT 1
  `;
  const row = rows[0];
  if (!row) return { cancelled: false };

  const active = activeRuns.get(runId);
  if (active) active.cancelled = true;
  active?.abort?.abort();
  await active?.stopCurrent?.();
  const protocolRunId = active?.protocolRunId ?? storedCurrentRunId(row.config);
  if (protocolRunId) await retireCurrentRun(ws, protocolRunId);

  // Freeze status FIRST so the detached completion handler won't overwrite it.
  await setBenchRunStatus(runId, 'cancelled', { runError: 'cancelled by operator' }, scope);

  // Dissolve every known hive (the in-flight set + the persisted slug).
  const slugs = new Set<string>(active?.potSlugs ?? []);
  if (row.pot_slug) slugs.add(row.pot_slug);
  for (const slug of slugs) await dissolve(slug, ws).catch(() => {});

  return { cancelled: true };
}

/**
 * Boot-time reaper (P-005, the D-022 durable closure). Any run left in an active
 * state by a crashed host (the finally never ran) is orphaned — its hive may
 * still carry an armed learning loop that re-spins opus on restart. Dissolve each
 * orphan's hive (deactivating its learning loops) and freeze its status to a
 * terminal state.
 *
 * HEARTBEAT-GATED: only runs whose liveness heartbeat (updated_at) is older than
 * `staleAfterSec` are reaped — so a run legitimately in flight in ANOTHER live
 * host (fresh heartbeat) is NOT killed by this host's boot sweep. Pass
 * staleAfterSec=0 to reap every active run regardless (tests / a forced sweep).
 * Idempotent; call once at host boot. Returns the runs reaped.
 */
export async function reapStaleBenchRuns(
  deps: {
    scope?: DbScope;
    dissolve?: (potSlug: string, workspaceId: string) => Promise<void>;
    /** Assignment task retirement seam; tests keep native control inside their private runtime. */
    retireCurrent?: typeof retireCurrentRun;
    staleAfterSec?: number;
  } = {},
): Promise<{ reaped: string[] }> {
  const scope = deps.scope ?? {};
  const { sql, ws } = resolveDb(scope);
  const dissolve = deps.dissolve ?? dissolveBenchHive;
  const staleAfterSec = deps.staleAfterSec ?? 180;

  const rows = await sql<{ id: string; pot_slug: string | null; config: Record<string, unknown> | null }[]>`
    SELECT id, pot_slug, config FROM harness_shared.bench_runs
     WHERE workspace_id = ${ws}
       AND status = ANY(${ACTIVE_STATES as unknown as string[]})
       AND updated_at < now() - make_interval(secs => ${staleAfterSec})
  `;
  const reaped: string[] = [];
  for (const r of rows) {
    const protocolRunId = storedCurrentRunId(r.config);
    if (protocolRunId) await (deps.retireCurrent ?? retireCurrentRun)(ws, protocolRunId);
    if (r.pot_slug) {
      await dissolve(r.pot_slug, ws).catch(() => {});
    }
    await setBenchRunStatus(
      r.id,
      'error',
      { runError: 'reaped: operator restarted while this run was in flight (spend-safety teardown)' },
      scope,
    ).catch(() => {});
    reaped.push(r.id);
  }
  return { reaped };
}

function storedCurrentRunId(config: Record<string, unknown> | null): string | null {
  if (!config || !config.current) return null;
  const protocol = currentBenchmarkProtocolSchema.parse(config.protocol);
  const current = config.current as Record<string, unknown>;
  if (current.protocolRunId !== protocol.runId) throw new Error('Current benchmark recovery protocol binding is invalid.');
  return protocol.runId;
}

/** Test-only — clear the in-process active-run registry between tests. */
export function _resetActiveRunsForTests(): void {
  activeRuns.clear();
}
