import { BENCHMARK_CAPABILITIES, type ArmControl, type CurrentBenchmarkProtocol } from './schema';
import type { CurrentBenchNativeRunCost } from '../current-su';

/** Closed native receipts, with separate uncached/cache tokens and billed dollars. */
export function currentNativeCostFixture(sessionIds: string[], preregHash = 'a'.repeat(64)): CurrentBenchNativeRunCost {
  const sources = sessionIds.map((nativeSessionId, index) => ({ nativeSessionId,
    sourceSha256: String(index + 1).padStart(64, '0'), sourceComplete: true,
    usageEventKeys: [`${nativeSessionId}:usage`], nativeTurnIds: [`${nativeSessionId}:turn`],
    tokensIn: 8, tokensOut: 2, tokensCacheRead: 5, tokensCacheWrite: 1, turns: 1,
    normalizedCostUsd: 0.2, billedKnownSubtotalUsd: 0.4, billedCostUsd: 0.4 }));
  const n = sources.length;
  return { tokensIn: n * 8, tokensOut: n * 2, tokensCacheRead: n * 5, tokensCacheWrite: n,
    costUsd: n * 0.2, turns: n, costUsdMeasurementMissing: false,
    armMeta: { nativeCostAccounting: { basis: 'frozen-normalized-native-source', priceTableVersion: 'frozen-prices-v1', preregHash,
      normalizedCostUsd: n * 0.2, billedKnownSubtotalUsd: n * 0.4, billedCostUsd: n * 0.4,
      sourceCensusComplete: true, attemptAccountingComplete: true, missingSources: 0, missingBills: 0,
      participantTaskIds: sessionIds.map(id => `task:${id}`), sources } } };
}

/** Every capability set to one toggle. */
export function allCapabilities(toggle: 'on' | 'off'): ArmControl['capabilities'] {
  return Object.fromEntries(BENCHMARK_CAPABILITIES.map(capability => [capability, toggle])) as ArmControl['capabilities'];
}

/**
 * One solver frozen across every topology: the stock-native reference, solo,
 * independent, coordinated, a coordinated single-capability ablation, an ensemble
 * and a fresh-session baseline paired to the coordinated treatment.
 */
export function controlledProtocolFixture(): CurrentBenchmarkProtocol {
  const protocol = currentProtocolFixture();
  const template = protocol.arms[0];
  const shared = { solverGroup: 'fixture-solver', solverToolsHash: 'f'.repeat(64) };
  const arm = (id: string, control: ArmControl) => ({ ...structuredClone(template), id, control });
  protocol.arms = [
    arm('stock', { topology: 'stock-native-reference', ...shared, capabilities: allCapabilities('off') }),
    arm('solo', { topology: 'solo', ...shared, capabilities: allCapabilities('on') }),
    arm('independent', { topology: 'independent', ...shared, capabilities: allCapabilities('on') }),
    arm('coordinated', { topology: 'coordinated', ...shared, capabilities: allCapabilities('on') }),
    arm('coordinated-no-locks', { topology: 'coordinated', ...shared,
      capabilities: { ...allCapabilities('on'), locks: 'off' }, ablation: { of: 'coordinated', treatment: 'locks' } }),
    arm('ensemble', { topology: 'ensemble', ...shared, capabilities: allCapabilities('on'), ensemble: {
      candidates: 3, isolation: 'independent',
      selector: { id: 'fixture-judge', kind: 'judge-agent', charged: true, onUnavailable: 'first-candidate' } } }),
    arm('repeated-session', { topology: 'repeated-session', ...shared, capabilities: allCapabilities('off'), repeatedSession: {
      matchedCostOf: 'coordinated', maxSessions: 4, workspace: 'same-task', sessionContext: 'fresh-native', submission: 'last-session' } }),
  ];
  return protocol;
}

/** Shared no-inference fixture; runtime/context pins are deliberately synthetic. */
export function currentProtocolFixture(runId = 'run-1', maxWallClockMs = 100): CurrentBenchmarkProtocol {
  const arm = (id: string) => ({
    id, agent: 'codex' as const, model: 'configured-alias', effort: 'high', account: 'auto',
    generationBudget: { maxUsd: 3, maxWallClockMs },
    runtime: { sourceRevision: 'fixture-source', runtimeRevision: 'fixture-runtime', clientVersion: 'fixture-client', promptHash: 'a'.repeat(64), toolsHash: 'b'.repeat(64) },
  });
  return {
    schemaVersion: 1, runId, taskIds: ['t1'], seeds: [1], arms: [arm('papercusp'), arm('baseline')],
    aggregateBudgetUsd: 60, maxInFlightUsd: 3,
    sampling: { unit: 'repository', taskRepositories: { t1: 'fixture-repo', 'withheld-1': 'withheld-repo' },
      ci: 0.95, bootstrapSeed: 12345, bootstrapIterations: 10000 },
    priceSchedule: { version: 'frozen-prices-v1', rates: [{ model: 'configured-alias', inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 2 }] },
    grader: { family: 'official', version: 'pinned', imageDigest: 'fixture-image-digest' },
    context: { corpusHash: 'c'.repeat(64), memoryHash: 'd'.repeat(64), corpusRef: 'fixture:corpus', memoryRef: 'fixture:memory',
      isolation: 'fresh-per-assignment', forbiddenSources: ['other-arm-solutions', 'hidden-grader-answers'] },
    exclusions: [], stopping: { maxAttemptsPerAssignment: 1, budgetAction: 'record-cap-outcome', graderOutage: 'repair-or-inconclusive', superiorityClaim: 'withheld-confirmation-only' },
    confirmation: { taskIds: ['withheld-1'], seeds: [2], plannedPairedTasks: 1, minimumEffect: 0.2, alpha: 0.05, power: 0.8, method: 'paired-binomial-power-plan-fixture' },
  };
}
