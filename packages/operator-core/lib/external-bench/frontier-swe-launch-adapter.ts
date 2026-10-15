/** D-026..D-033: the FrontierSWE runAgent composes the maintained native su driver.
 * The host registers an observer checkout; the pinned Codex binary edits /app INSIDE the
 * task container. Grading remains owned by the FrontierSWE seam, never this adapter.
 */
import type { PapercuspUnifiedToolContext } from '../agent-tools/_tool-context';
import { createCurrentSuBenchHarness, CURRENT_STOCK_CODEX_BLUEPRINT, requireCurrentBenchNativeRunCost, type CurrentSuBenchObservations,
  type CurrentSuBenchOptions, type CurrentBenchNativeRunCost, type CurrentBenchSessionBudget } from './current-su';
import { createCurrentStockBenchHarness } from './native-harness-runner';
import { startBenchEgress, sweepBenchEgress, type BenchEgress, type BenchEgressConfig } from './bench-egress';
import { startCodexHookBridge, type CodexHookBridge } from './codex-hook-bridge';
import { validateDockerExecTarget, type DockerExecTarget } from './container-exec-target';
import { makeFrontierSweCloneGradeSeam, type FrontierSweEnvHandle, type FrontierSweSeamConfig } from './frontier-swe-seam';
import { FULL_SPINE_BLUEPRINT, type BenchHarnessDriver } from './run-loop';
import { generationStatusForStopReason, type GenerationBudget, type TaskCheckout } from './types';
import type { AgentRunOutput, RunAgentInput } from './run-topology';
import { currentBenchSessionUsageDelta, type CurrentBenchTaskRequestCensus } from './run-launcher';
import { runRepeatedSessions } from './repeated-session';
import { assertBenchWorkspace } from './bench-workspace';

export interface FrontierSweNativeAssignment {
  options: CurrentSuBenchOptions;
  observations: CurrentSuBenchObservations;
  /** Observer-only host checkout for the existing registry/context lifecycle; agent tools use /app. */
  checkout: TaskCheckout;
  /** Exact pre-registered caps. Remaining wall headroom uses options.driveTimeoutMs. */
  generationBudget?: GenerationBudget;
  /** Host-read actual paired treatment spend, never a candidate-supplied cap. */
  repeatedSession?: Readonly<{ treatmentCostUsd: number; maxSessions: number }>;
  issueSessionBudget?(budget: GenerationBudget, beforeCost?: CurrentBenchNativeRunCost | null): CurrentBenchSessionBudget;
  /** Complete controller-issued reservation/capture population. Repeated
   * sessions consume deltas from this value; they never re-sum a cumulative
   * request count or widen the frozen assignment budget. */
  readRequestCensus?(): Promise<CurrentBenchTaskRequestCensus>;
  /** Exact native request count from this assignment's accounting ledger, including failed requests. */
  readModelCalls(): Promise<number>;
  stop(): Promise<void>;
}

export interface FrontierSweLaunchAdapterConfig {
  runId: string;
  /** Protocol identity can span multiple separately owned arm/seed runtime runs. */
  protocolRunId?: string;
  signal?: AbortSignal;
  context: PapercuspUnifiedToolContext;
  /** The exact origin psu writes into Codex config; the relay reaches this loopback service. */
  mcpOrigin: string;
  /** Trusted hook records, outside every container mount. */
  hookRecordDir: string;
  /** Reuses currentBenchGatewayController and the frozen assignment/accounting/context planes. */
  startAssignment(input: RunAgentInput<FrontierSweEnvHandle>): Promise<FrontierSweNativeAssignment>;
  seam?: Omit<FrontierSweSeamConfig, 'egress' | 'inContainerCodex'>;
  egress?: Pick<BenchEgressConfig, 'exec' | 'sidecarImage' | 'workRoot' | 'readyTimeoutMs' | 'readyPollMs'>;
}

export interface FrontierSweLaunchAdapterPorts {
  startBridge: typeof startCodexHookBridge;
  startEgress: typeof startBenchEgress;
  sweep: typeof sweepBenchEgress;
  createDriver: (options: CurrentSuBenchOptions, context: PapercuspUnifiedToolContext,
    observations: CurrentSuBenchObservations) => BenchHarnessDriver;
}
const livePorts: FrontierSweLaunchAdapterPorts = {
  startBridge: startCodexHookBridge, startEgress: startBenchEgress,
  sweep: sweepBenchEgress,
  createDriver: (options, context, observations) => options.armId === 'baseline'
    ? createCurrentStockBenchHarness(options, context, observations)
    : createCurrentSuBenchHarness(options, context, observations),
};

function localOrigin(value: string): { origin: string; port: number } {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('FrontierSWE adapter requires an exact loopback HTTP origin.');
  }
  return { origin: url.origin, port: Number(url.port || 80) };
}

/** Exported so fail-closed wrapper wiring is tested independently of model spend. */
export function frontierSweDockerTarget(handle: FrontierSweEnvHandle, bridge: CodexHookBridge,
  egress: BenchEgress, gatewayOrigin: string, mcpOrigin: string, stockNative = false): DockerExecTarget {
  const mounts = handle.inContainerCodex;
  if (!mounts || !handle.taskNetwork) throw new Error('FrontierSWE native assignment requires its Codex mounts and task network.');
  const target: DockerExecTarget = {
    kind: 'docker-exec', containerId: handle.containerId, workdir: '/app', binPath: mounts.binPath,
    sessionRelocation: { sessionEnv: 'CODEX_HOME', roots: mounts.roots },
    ...(stockNative ? {} : { hookBridge: { url: egress.originFor('hooks'), recordDir: bridge.recordDir } }),
    originRewrites: [
      { from: localOrigin(gatewayOrigin).origin, to: egress.originFor('gw') },
      ...(stockNative ? [] : [{ from: localOrigin(mcpOrigin).origin, to: egress.originFor('mcp') }]),
    ],
  };
  validateDockerExecTarget(target);
  return target;
}

/** One bridge/egress per run; one gateway binding at a time, on the seam's per-task network. */
export async function startFrontierSweLaunchAdapter(config: FrontierSweLaunchAdapterConfig,
  ports: FrontierSweLaunchAdapterPorts = livePorts) {
  const mcp = localOrigin(config.mcpOrigin);
  if (!config.context.workspaceId?.trim()) throw new Error('FrontierSWE adapter needs its concrete benchmark workspace.');
  assertBenchWorkspace(config.context.workspaceId);
  if (!config.runId.trim()) throw new Error('FrontierSWE adapter needs a stable run id.');
  const bridge = await ports.startBridge({ recordDir: config.hookRecordDir });
  let egress: BenchEgress;
  try {
    egress = await ports.startEgress({ ...config.egress, runId: config.runId, endpoints: [
      { name: 'gw', listenPort: 8788, perTask: true },
      { name: 'mcp', listenPort: 9071, targetPort: mcp.port },
      { name: 'hooks', listenPort: 9081, targetPort: bridge.port },
    ] });
  } catch (error) {
    try { await ports.sweep(config.runId, config.egress?.exec); } finally { await bridge.stop(); }
    throw error;
  }
  let seam: ReturnType<typeof makeFrontierSweCloneGradeSeam>;
  try {
    seam = makeFrontierSweCloneGradeSeam({ ...config.seam, egress, inContainerCodex: true });
  } catch (error) {
    try { await egress.stop(); } finally {
      try { await ports.sweep(config.runId, config.egress?.exec); } finally { await bridge.stop(); }
    }
    throw error;
  }
  let closed = false;
  let inFlight: Promise<AgentRunOutput> | undefined;
  let stopping: Promise<{ errors: string[] }> | undefined;
  const runAgent = (input: RunAgentInput<FrontierSweEnvHandle>): Promise<AgentRunOutput> => {
    if (closed || config.signal?.aborted) return Promise.reject(new Error('FrontierSWE adapter is stopped or cancelled.'));
    if (inFlight) return Promise.reject(new Error('FrontierSWE adapter permits one metered assignment at a time.'));
    const run = async (): Promise<AgentRunOutput> => {
      if (!['worker', 'solver'].includes(input.role) || input.candidates?.length) {
        throw new Error('Current FrontierSWE native adapter runs a single solver; judge/leader/pair roles are not supported.');
      }
      if (!input.handle.inContainerCodex || !input.handle.taskNetwork) {
        throw new Error('FrontierSWE adapter refuses a host-only task handle.');
      }
      let assignment: FrontierSweNativeAssignment | undefined;
      let unbind: (() => void) | undefined;
      try {
        assignment = await config.startAssignment(input);
        const { options, observations } = assignment;
        if (options.runId !== (config.protocolRunId ?? config.runId) || options.armId !== input.arm ||
          !['papercusp', 'baseline'].includes(options.armId) || options.agent !== 'codex' ||
          options.workspaceId !== config.context.workspaceId || !observations.nativeGateway) {
          throw new Error('FrontierSWE assignment differs from its run/arm/workspace or lacks its native gateway.');
        }
        const gateway = localOrigin(observations.nativeGateway.baseURL);
        unbind = egress.bindTaskEndpoint(input.handle.taskNetwork, 'gw', gateway.port);
        const stockNative = options.armId === 'baseline';
        const target = frontierSweDockerTarget(input.handle, bridge, egress, gateway.origin, mcp.origin, stockNative);
        let before: CurrentBenchTaskRequestCensus | undefined, beforeCost: CurrentBenchNativeRunCost | null = null;
        const repeated = assignment.repeatedSession;
        if (repeated) {
          if (!stockNative || !assignment.issueSessionBudget || !assignment.readRequestCensus)
            throw new Error('Repeated sessions require a stock assignment with host allowances and complete request accounting.');
          before = await assignment.readRequestCensus();
          if (before.requests.length) throw new Error('Repeated-session assignment already contains native requests.');
        }
        const runSession = async (sessionInput: RunAgentInput<FrontierSweEnvHandle>, grant?: CurrentBenchSessionBudget): Promise<AgentRunOutput> => {
        const sessionOptions = grant ? { ...options, driveTimeoutMs: Math.min(options.driveTimeoutMs ?? Infinity,
          grant.budget.maxWallClockMs ?? Infinity) } : options;
        const driver = ports.createDriver(sessionOptions, config.context, { ...observations, containerExec: target,
          ...(grant ? { sessionBudget: grant } : {}) });
        const result = await driver.spinRunAndCost({ blueprintId: stockNative ? CURRENT_STOCK_CODEX_BLUEPRINT : FULL_SPINE_BLUEPRINT,
          task: repeated ? { ...input.task, problemStatement: `${input.task.problemStatement}\n\n${sessionInput.directive}` } : input.task,
          checkout: assignment!.checkout, budget: grant?.budget ?? assignment!.generationBudget ?? {
            ...(input.attemptBudget.maxCostUsd !== undefined ? { maxUsd: input.attemptBudget.maxCostUsd } : {}),
            ...(input.attemptBudget.maxTokens !== undefined ? { maxTokens: input.attemptBudget.maxTokens } : {}),
            ...(input.attemptBudget.maxWallMs !== undefined ? { maxWallClockMs: input.attemptBudget.maxWallMs } : {}),
          } });
        const usage = result.telemetry;
        // Preserve the known new subtotal even when complete accounting fails.
        // A later cumulative receipt must never charge earlier sessions twice.
        let measured = repeated ? { tokensIn: Math.max(0, usage.tokensIn - (beforeCost?.tokensIn ?? 0)),
          tokensOut: Math.max(0, usage.tokensOut - (beforeCost?.tokensOut ?? 0)),
          costUsd: Math.max(0, usage.costUsd - (beforeCost?.costUsd ?? 0)),
          tokensCacheRead: Math.max(0, (usage.tokensCacheRead ?? 0) - (beforeCost?.tokensCacheRead ?? 0)),
          tokensCacheWrite: Math.max(0, (usage.tokensCacheWrite ?? 0) - (beforeCost?.tokensCacheWrite ?? 0)),
          turns: Math.max(0, usage.turns - (beforeCost?.turns ?? 0)) } :
          { tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, costUsd: usage.costUsd,
            tokensCacheRead: usage.tokensCacheRead, tokensCacheWrite: usage.tokensCacheWrite, turns: usage.turns };
        let modelCalls = 0, measurementError: string | undefined;
        try {
          if (assignment!.readRequestCensus) {
            const census = await assignment!.readRequestCensus();
            if (repeated) {
              const afterCost = requireCurrentBenchNativeRunCost({ ...usage,
                costUsdMeasurementMissing: usage.armMeta?.costUsdMeasurementMissing === true });
              const sources = afterCost.armMeta?.nativeCostAccounting?.sources;
              const previous = new Set(beforeCost?.armMeta.nativeCostAccounting.sources.map(source => source.nativeSessionId) ?? []);
              const added = sources?.filter(source => !previous.has(source.nativeSessionId));
              if (!added || added.length !== 1) throw new Error('Fresh native session requires exactly one new source receipt.');
              const delta = currentBenchSessionUsageDelta({ before: before!, after: census,
                beforeCost, afterCost, nativeSessionId: added[0].nativeSessionId });
              modelCalls = delta.modelCalls;
              measured = { tokensIn: delta.tokensIn, tokensOut: delta.tokensOut, costUsd: delta.normalizedCostUsd,
                tokensCacheRead: delta.tokensCacheRead, tokensCacheWrite: delta.tokensCacheWrite, turns: delta.turns };
              before = census; beforeCost = structuredClone(afterCost);
            } else modelCalls = census.requests.length;
          } else modelCalls = await assignment!.readModelCalls();
          if (!Number.isSafeInteger(modelCalls) || modelCalls < 0) throw new Error('FrontierSWE native model-call count is unmeasured.');
        } catch (error) {
          modelCalls = 0; measurementError = error instanceof Error ? error.message : String(error);
        }
        return {
          submission: { containerId: input.handle.containerId, instanceId: input.task.instanceId },
          status: usage.armMeta?.costUsdMeasurementMissing || measurementError ? 'error' : generationStatusForStopReason(usage.stopReason),
          modelCalls, ...measured, capped: usage.stopReason === 'budget-exhausted', error: measurementError ?? usage.generationError,
          armMeta: { ...usage.armMeta, nativeUsage: { stopReason: usage.stopReason,
            tokensCacheRead: usage.tokensCacheRead ?? 0, tokensCacheWrite: usage.tokensCacheWrite ?? 0 },
            ...(measurementError ? { modelCallsMeasurementMissing: true } : {}) },
          traceRef: usage.trajectoryRef, executionPath: stockNative ? 'stock-native-reference' : 'modernization-launch-adapter',
        };
        };
        if (!repeated) return await runSession(input);
        const result = await runRepeatedSessions(input, { ...repeated,
          openFreshSession: async sessionInput => {
            const left = sessionInput.attemptBudget;
            const grant = assignment!.issueSessionBudget!({
              ...(left.maxCostUsd !== undefined ? { maxUsd: left.maxCostUsd } : {}),
              ...(left.maxTokens !== undefined ? { maxTokens: left.maxTokens } : {}),
              ...(left.maxWallMs !== undefined ? { maxWallClockMs: left.maxWallMs } : {}),
            }, beforeCost);
            return runSession(sessionInput, grant);
          } });
        const last = result.sessions.at(-1);
        // Zero treatment spend opens no session. The unchanged task container
        // still supplies the same submission marker as every executed session.
        return { ...result.usage, submission: result.sessions.length ? result.submission :
          { containerId: input.handle.containerId, instanceId: input.task.instanceId },
          status: result.stop === 'error' ? 'error' : 'completed', error: result.error,
          capped: result.stop !== 'matched-cost', traceRef: last?.traceRef, executionPath: 'stock-native-reference',
          armMeta: { ...last?.armMeta, repeatedSession: { ...repeated, stop: result.stop,
            sessions: result.sessions.map(session => ({ traceRef: session.traceRef, status: session.status,
              modelCalls: session.modelCalls, costUsd: session.costUsd, armMeta: session.armMeta })) },
            nativeUsage: { stopReason: result.stop === 'error' ? 'error' : result.stop === 'matched-cost' ? 'done' : 'budget-exhausted',
              tokensCacheRead: result.usage.tokensCacheRead ?? 0, tokensCacheWrite: result.usage.tokensCacheWrite ?? 0 } } };
      } finally {
        unbind?.();
        if (assignment) {
          try { await assignment.stop(); } finally { await assignment.checkout.cleanup(); }
        }
      }
    };
    const promise = run();
    inFlight = promise;
    // Do not create an unhandled rejection from a detached finally chain.
    void promise.then(() => { inFlight = undefined; }, () => { inFlight = undefined; });
    return promise;
  };
  return {
    seam, runAgent, egress,
    stop(): Promise<{ errors: string[] }> {
      if (stopping) return stopping;
      closed = true;
      stopping = (async () => {
        const errors: string[] = [];
        try { await inFlight; } catch { /* trial error is returned to its caller; cleanup still runs */ }
        for (const operation of [() => egress.stop(), () => ports.sweep(config.runId, config.egress?.exec)]) {
          try { errors.push(...(await operation()).errors); } catch (e) { errors.push(String(e)); }
        }
        try { await bridge.stop(); } catch (e) { errors.push(String(e)); }
        return { errors };
      })();
      return stopping;
    },
  };
}
