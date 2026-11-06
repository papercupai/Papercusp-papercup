import { knownTaskSets } from './task-sets';
import { SWE_BENCH_PRO_V1_PIN } from './swe-bench-pro-pin';
import { currentBenchmarkProtocolSchema } from './reproducibility/schema';
import type { DbScope } from './reproducibility/db';

// Per-task opus cost basis: the m3 real-Queen pass cost $33.98 over 11 tasks
// (~$3.09/task). Round up for a conservative pre-launch estimate.
const PER_TASK_USD = 3.5;
// Rough per-task wall minutes (a SWE-bench Pro task on the hive); time is the
// looser estimate, labelled rough in the UI.
const PER_TASK_WALL_MIN = 18;

export interface BenchLaunchEstimate {
  taskSetId: string;
  taskCount: number;
  cap: number;
  perTaskUsd: number;
  estCostUsd: number;
  estWallMin: number;
  basis: string;
}

export function estimateBenchLaunch({
  taskSetId = '11-task-pilot',
  cap = 5,
}: {
  taskSetId?: string;
  cap?: number;
}): BenchLaunchEstimate {
  const safeCap = Math.max(1, Number(cap) || 5);
  const set = knownTaskSets().find((s) => s.id === taskSetId);
  // The full-set count comes from the pinned population (WI-6554700010008394), never a literal.
  const taskCount = set?.count ?? (taskSetId === 'swe-bench-pro-full' ? SWE_BENCH_PRO_V1_PIN.taskCount : 11);
  const estCostUsd = Math.round(taskCount * PER_TASK_USD * 100) / 100;
  // Parallel wall ≈ ceil(N/cap) waves × per-task wall (rough).
  const waves = Math.ceil(taskCount / safeCap);
  const estWallMin = waves * PER_TASK_WALL_MIN;
  return {
    taskSetId,
    taskCount,
    cap: safeCap,
    perTaskUsd: PER_TASK_USD,
    estCostUsd,
    estWallMin,
    basis: 'per-task cost from the m3 real-Queen pass ($33.98 / 11 ≈ $3.09/task, opus); time is rough.',
  };
}

/** Extend the existing estimate read with committed current protocol controls.
 * This is launch preflight, not measured generation or provider billing. */
export async function estimateCurrentBenchLaunch(input: {
  workspaceId: string; protocolRunId: string; arm: string; seed: number;
}, scope: DbScope = {}, ports?: {
  readPrereg: typeof import('./reproducibility/store').getPrereg;
  verify: typeof import('./reproducibility/prereg').requireCommittedPreregistration;
  readAccounts: typeof import('../deployment/account-pool-store').loadAccountPool;
  supportsBearer: typeof import('../inference-gateway/credential-store').credentialRefSupportsOpenAiBearer;
  /** D-023 subscription payer; a port set without it supports no subscription account. */
  supportsSubscription?: (credentialRef: string) => Promise<boolean>;
  readRuntimes: typeof import('../runtime-vintage').listRuntimeVintage;
  measure: typeof import('../runtime-vintage').measureRuntimeVintageEnvironment;
  enabled(): Promise<boolean>;
  runtimeWorkspaceId: string; pid: number;
}) {
  try {
    const { resolveBenchWorkspace } = await import('./bench-workspace');
    const workspaceId = resolveBenchWorkspace(input.workspaceId);
    const io = ports ?? {
      readPrereg: (await import('./reproducibility/store')).getPrereg,
      verify: (await import('./reproducibility/prereg')).requireCommittedPreregistration,
      readAccounts: (await import('../deployment/account-pool-store')).loadAccountPool,
      supportsBearer: (await import('../inference-gateway/credential-store')).credentialRefSupportsOpenAiBearer,
      supportsSubscription: (await import('./current-su')).currentBenchSupportsCodexSubscription,
      readRuntimes: (await import('../runtime-vintage')).listRuntimeVintage,
      measure: (await import('../runtime-vintage')).measureRuntimeVintageEnvironment,
      enabled: () => import('./gate').then(gate => gate.isExternalBenchEnabled()),
      runtimeWorkspaceId: (await import('../workspace-registry')).activeWorkspaceId(), pid: process.pid,
    };
    const db = { ...scope, workspaceId };
    const prereg = await io.readPrereg({ runId: input.protocolRunId }, db);
    if (!prereg) throw new Error('No registered protocol in this benchmark workspace.');
    if (!Array.isArray(prereg.suites) || prereg.suites.length !== 1 ||
        typeof prereg.suites[0] !== 'string' || !prereg.suites[0].trim())
      throw new Error('Select a protocol with a single registered suite before launch.');
    const suite = prereg.suites[0];
    const protocol = currentBenchmarkProtocolSchema.parse(prereg.config);
    if (!protocol.sampling) throw new Error('The protocol lacks a frozen repository sampling policy.');
    const arm = protocol.arms.find(value => value.id === input.arm);
    if (!arm || !['papercusp', 'baseline'].includes(arm.id) || arm.agent !== 'codex' || !protocol.seeds.includes(input.seed))
      throw new Error('Select a registered current Codex arm and seed.');
    if (!['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(arm.effort))
      throw new Error('The registered native effort is unsupported.');
    const rate = protocol.priceSchedule.rates.find(rate => rate.model === arm.model)!;
    const { currentBenchRateContract, currentBenchArmPayer } = await import('./current-su');
    const payer = currentBenchArmPayer(arm), contract = currentBenchRateContract(payer, rate);
    if (!contract || rate.inputTokenCeilingSourceSha256 !== contract)
      throw new Error(payer === 'subscription' ? 'The protocol lacks the supported subscription provider-limit contract.'
        : 'The protocol lacks the supported provider input-count contract.');
    await io.verify(protocol.runId, { preregHash: prereg.preregHash, config: protocol }, db);
    if (!await io.enabled()) throw new Error('Benchmark execution is disabled; enable papercusp-external-bench in workspace settings.');
    const accounts = (await io.readAccounts(workspaceId)).accounts.filter(account =>
      (account.provider ?? 'claude') === 'codex' && (['auto', 'default'].includes(arm.account) || account.id === arm.account));
    const supports = payer === 'subscription' ? io.supportsSubscription ?? (async () => false) : io.supportsBearer;
    if (!(await Promise.all(accounts.map(account => supports(account.credentialRef)))).some(Boolean))
      throw new Error(payer === 'subscription'
        ? 'Register a Codex subscription account (codex-cli:<CODEX_HOME> with a ChatGPT login) in this benchmark workspace.'
        : 'Register an OpenAI API bearer account in this benchmark workspace; a subscription account needs a protocol frozen with the subscription payer.');
    const rows = await io.readRuntimes(io.runtimeWorkspaceId, scope.sql);
    const host = rows.filter(row => row.pid === io.pid);
    if (host.length !== 1 || host[0].treeSha !== arm.runtime.sourceRevision ||
        io.measure(host, [host[0].unit]) !== arm.runtime.runtimeRevision)
      throw new Error('The loaded execution host differs from the frozen runtime; calibrate and register a new protocol.');
    return { ready: true as const, suite, arm: arm.id, taskCount: protocol.taskIds.length, perTaskUsd: arm.generationBudget.maxUsd,
      estCostUsd: Math.min(protocol.aggregateBudgetUsd, protocol.taskIds.length * arm.generationBudget.maxUsd),
      estWallMin: protocol.taskIds.length * arm.generationBudget.maxWallClockMs / 60000,
      aggregateBudgetUsd: protocol.aggregateBudgetUsd, model: arm.model, effort: arm.effort, account: arm.account,
      payer, costBasis: payer === 'subscription' ? 'list-price-equivalent' as const : 'metered' as const,
      basis: payer === 'subscription'
        ? 'Frozen per-assignment and aggregate ceilings in list-price-equivalent USD: a ChatGPT subscription pays, so these are provider-reported usage at frozen list prices, not money spent.'
        : 'Frozen per-assignment and aggregate ceilings; actual spend and time are measured after execution.',
      seeds: protocol.seeds, taskIds: protocol.taskIds,
      current: { workspaceId, protocolRunId: protocol.runId, preregHash: prereg.preregHash, seed: input.seed,
        observation: { runtimeWorkspaceId: io.runtimeWorkspaceId, workerUnit: host[0].unit, gatewayUnit: host[0].unit } } };
  } catch (error) {
    return { ready: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}
