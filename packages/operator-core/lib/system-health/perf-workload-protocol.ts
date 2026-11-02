/**
 * Preregistration for matched perf-signals trials (host-memory-right-sizing
 * D-012). Reuses the perf evidence/results ledger; no monitor, table or mutable
 * runtime setting. A valid registration permits collecting a trial, never a
 * reduction/acceptance. Runtime oracles and the 24h soak remain separate gates.
 */
import { createHash } from 'node:crypto';
import type { PairedBlockPower, PairedPowerScenario } from '@papercusp/bench-metrics';
import { reproducePerfWorkloadPower } from './perf-workload-power';
import type { PerfWorkloadRun } from './perf-workload-run';
import type { PerfWorkloadEvaluation } from './perf-workload-evaluate';

function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export const PERF_WORKLOAD_POLICY = freeze({
  decisionRef: 'host-memory-right-sizing-2026-10-31#D-012',
  minimumCompletedPerArm: 10_000,
  minimumIndependentPairedRepeats: 3,
  minimumPretrialPower: 0.8,
  familyConfidence: 0.95,
  minimumBootstrapReplicates: 10_000,
  quantile: 'type-7',
  resampling: 'paired-hierarchical-circular-block-percentile-type7',
  blockLengthSource: 'baseline-autocorrelation-before-candidate',
  multiplicity: 'bonferroni-over-complete-journey-metric-stratum-family',
  strata: ['cold', 'warm', 'burst'],
  ratios: { p95Upper: 1.05, p99Upper: 1.10, throughputLower: 0.95 },
  censoring: 'retain-all-errors-and-timeouts-as-failures;latency-at-least-timeout-bound',
  unknown: 'keep-current-settings;zero-qualified-savings',
  memory: {
    positiveSavingLowerBoundAfterCoverageAndResidualUncertainty: true,
    allowances: 'matched-baseline-simultaneous-confidence-only',
    zeroBaselineSpillRemainsZero: true,
    noNewCorrectnessDisconnectTimeoutOomOrDataLoss: true,
    unexplainedPostWarmupGrowth: 'at-most-baseline-simultaneous-upper-bound',
  },
  gpu: {
    preserveModelDimensionsAndPins: true,
    everyPinnedMetricAndQueryStratum: true,
    includeAdversarialAndLongTail: true,
    candidateMinusBaselineLowerSimultaneousBound: 0,
    meetBaselineLowerConfidenceFloor: true,
    tolerance: 'at-most-baseline-repeatability;never-excuse-lost-correct-result',
    onUnknown: 'cpu-unchanged;zero-device-savings',
  },
  database: {
    oracle: 'committed-channel-payload-and-order;only-same-channel-payload-in-transaction-coalescing',
    noPrecommitRollbackLossDuplicationOrReordering: true,
    listenEffectiveAtCommit: true,
    resubscribeBeforeNewCommittedPublications: true,
    noInventedDisconnectedDurability: true,
    races: ['concurrent-publishers', 'pool-reassignment', 'prepared-session-affinity', 'reconnect'],
    replication: 'identical-seeded-row-checksums;lag-and-catchup-within-baseline-simultaneous-bounds',
    missingOracle: 'unknown',
  },
  soak: {
    minimumElapsedHours: 24, minimumNamedCycleOccurrences: 3,
    cycleRateFloor: 'upper-95-percent-baseline-daily-occurrence-rate',
    cycles: ['cold-start', 'burst', 'maintenance', 'reconnect', 'resume', 'fallback', 'vm-pressure'],
    minimumOverlapEpisodes: 30, overlapConcurrency: 'at-least-baseline-p95',
    overlapComponents: 'db+compiler+http;plus-qualified-inference-and-vm',
    maximumTelemetryIntervalMs: 5000, maximumTimestampJitterMs: 1000,
    missingSamplesAllowed: 0, interpolationAllowed: false,
    resets: ['lost-sample', 'config-change', 'source-change', 'runtime-change', 'rollback'],
  },
  lifecycle: {
    authorization: 'same-stable-process-and-owner-claim-wake-terminal-resumability-revision-at-one-linearization-boundary',
    retain: 'token-handle-revision-and-post-action-identity',
    race: 'protection-transition-between-final-read-and-delivery-invalidates-authorization',
    compilerOracle: 'same-consistent-source-config-reference-dependency-overlay-manifest',
    cancellationAndEvictionCannotConvertFullCheckToPartialSuccess: true,
    onUnknown: 'keep',
  },
  vm: {
    noGuestOomOrDataLoss: true, persistedDataAndResumeIntegrityChecksums: true,
    majorFaultAndSwapInRates: 'host-and-guest-noninferior-to-matched-baseline-simultaneous-bounds',
    noTrialAuthoredLargerAllowances: true, unqualifiedMemoryGiB: 32,
  },
} as const);

/** Canonical JSON rejects non-finite/undefined values instead of silently losing them. */
export function perfProtocolHash(value: unknown): string {
  const canonical = (input: unknown): string => {
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return JSON.stringify(input);
    if (typeof input === 'number' && Number.isFinite(input)) return JSON.stringify(input);
    if (Array.isArray(input)) {
      if (Object.keys(input).length !== input.length) throw new TypeError('perfProtocolHash: dense JSON arrays required');
      return `[${input.map(canonical).join(',')}]`;
    }
    if (input && typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype) {
      return `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${canonical((input as Record<string, unknown>)[key])}`).join(',')}}`;
    }
    throw new TypeError('perfProtocolHash: finite plain JSON required');
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export type PerfWorkloadStratum = typeof PERF_WORKLOAD_POLICY.strata[number];
export type PerfWorkloadMetric = 'p95' | 'p99' | 'throughput';
export interface PerfWorkloadBaselineSeries {
  journey: string; stratum: PerfWorkloadStratum; metric: PerfWorkloadMetric;
  /** Ordered paired observations; throughput values require equal exposure bins. */
  a: number[]; b: number[];
}
export interface PerfWorkloadComparison {
  journey: string;
  stratum: PerfWorkloadStratum;
  metric: PerfWorkloadMetric;
  /** Evidence is read by ref, never a caller-authored scalar power assertion. */
  powerEvidenceRef: string;
  /** Per-repeat lengths selected from baseline autocorrelation, before candidate. */
  blockLengths: Record<string, number>;
  blockEvidenceRefs: Record<string, string>;
}
export interface PerfWorkloadProtocolInput {
  createdAtMs: number;
  planRevision: number;
  planContentHash: string;
  rubricRevision: number;
  rubricContentHash: string;
  sourceManifestHash: string;
  fixtureHash: string;
  /** Full manifests for both trial arms, sealed before candidate collection. */
  trialManifestHashes?: { a: string; b: string };
  /** Include the executable operation mix, concurrency, timeout and oracle pins. */
  workload: Array<{ journey: string; operationMix: string; concurrency: number; timeoutMs: number; oracleRef: string }>;
  baselineEvidenceRefs: string[];
  comparisons: PerfWorkloadComparison[];
  bootstrapReplicates: number;
  seed: number;
  /** Fixed outer count; no optional stopping or surrogate inference rule. */
  powerDesign?: { simulations: number; monteCarloFamilyAlpha: number; maximumSampledPairs: number; scenarios: PairedPowerScenario[] };
}
export interface PerfWorkloadProtocol {
  schemaVersion: 1;
  policyHash: string;
  input: PerfWorkloadProtocolInput;
  hash: string;
}

/** Immutable snapshot. Publication/readback in the ledger is checked separately. */
export function sealPerfWorkloadProtocol(input: PerfWorkloadProtocolInput): PerfWorkloadProtocol {
  const snapshot = structuredClone(input);
  const body = { schemaVersion: 1 as const, policyHash: perfProtocolHash(PERF_WORKLOAD_POLICY), input: snapshot };
  return freeze({ ...body, hash: perfProtocolHash(body) });
}

export type PerfProtocolEvidence = ({
  kind: 'evaluation'; hash: string; endedAtMs: number; evaluation: PerfWorkloadEvaluation;
} | {
  kind: 'matched-run'; hash: string; endedAtMs: number; capture: PerfWorkloadRun;
} | {
  kind: 'baseline'; hash: string; endedAtMs: number; sourceManifestHash: string; fixtureHash: string;
  independentRepeatId: string; independenceEvidenceRef: string;
  /** Exact retained raw collection from which observations/series were derived. */
  runEvidenceRef?: string;
  observations: Array<{ journey: string; stratum: PerfWorkloadStratum; completedPerArm: number; allObservationsRetained: boolean }>;
  series?: PerfWorkloadBaselineSeries[];
} | {
  kind: 'power'; hash: string; endedAtMs: number; protocolInputHash: string;
  journey: string; stratum: PerfWorkloadStratum; metric: PerfWorkloadMetric;
  lowerPowerBound: number; comparisonAlpha: number; margin: number;
  computationRef?: string;
} | {
  kind: 'power-computation'; hash: string; endedAtMs: number; protocolInputHash: string;
  /** Entire joint family result; independently reproduced from baseline bytes. */
  result: PairedBlockPower;
} | {
  kind: 'block-selection'; hash: string; endedAtMs: number; baselineHash: string;
  independentRepeatId: string; journey: string; stratum: PerfWorkloadStratum; metric: PerfWorkloadMetric;
  method: 'baseline-acf-noise-band-v1'; blockLength: number;
} | { kind: 'independence'; hash: string; independentRepeatId: string; verified: true }
  | { kind: 'registration'; hash: string; registeredAtMs: number; protocolHash: string }) & {
    /** Resolver-added DB clock metadata; never part of the authored/hashed artifact. */
    publishedAtMs?: number;
  };

/**
 * `readEvidence` must resolve immutable, hash-verified artifacts from the existing
 * results ledger. Missing evidence fails closed. This function does not produce
 * performance acceptance; it checks prerequisites to START collecting a trial.
 */
export async function verifyPerfWorkloadPrerequisites(
  protocol: PerfWorkloadProtocol,
  registrationRef: string,
  candidateStartedAtMs: number,
  readEvidence: (ref: string) => Promise<PerfProtocolEvidence | null>,
): Promise<{ status: 'ready-for-trial' | 'unknown'; reasons: string[] }> {
  const reasons = new Set<string>();
  const reject = (reason: string) => { reasons.add(reason); };
  const { input, hash, ...body } = protocol;
  if (hash !== perfProtocolHash({ ...body, input }) || protocol.policyHash !== perfProtocolHash(PERF_WORKLOAD_POLICY)) reject('protocol-or-policy-changed');
  const sha = (value: string) => /^[a-f0-9]{64}$/.test(value);
  if (![input.planContentHash, input.rubricContentHash, input.sourceManifestHash, input.fixtureHash].every(sha) ||
      !Number.isSafeInteger(input.planRevision) || input.planRevision < 1 || !Number.isSafeInteger(input.rubricRevision) || input.rubricRevision < 1 ||
      !Number.isSafeInteger(input.seed) || !Number.isSafeInteger(input.bootstrapReplicates) || input.bootstrapReplicates < 10_000 ||
      !Number.isFinite(input.createdAtMs) || !Number.isFinite(candidateStartedAtMs)) reject('invalid-protocol-metadata');
  const cache = new Map<string, Promise<PerfProtocolEvidence | null>>();
  const read = (ref: string) => {
    if (!cache.has(ref)) cache.set(ref, ref.trim() ? Promise.resolve().then(() => readEvidence(ref)).catch(() => null) : Promise.resolve(null));
    return cache.get(ref)!;
  };
  const publishedBefore = (evidence: PerfProtocolEvidence, boundary: number) =>
    typeof evidence.publishedAtMs === 'number' && Number.isFinite(evidence.publishedAtMs) && evidence.publishedAtMs < boundary;
  const registration = await read(registrationRef);
  if (registration?.kind !== 'registration' || !sha(registration.hash) || registration.protocolHash !== hash ||
      !Number.isFinite(registration.registeredAtMs) || input.createdAtMs > registration.registeredAtMs ||
      registration.registeredAtMs >= candidateStartedAtMs || !publishedBefore(registration, candidateStartedAtMs) ||
      registration.publishedAtMs! < registration.registeredAtMs) reject('missing-or-late-immutable-registration');
  const journeys = new Set<string>();
  for (const workload of input.workload) {
    if (!workload.journey.trim() || journeys.has(workload.journey) || !workload.operationMix.trim() || !workload.oracleRef.trim() ||
        !Number.isSafeInteger(workload.concurrency) || workload.concurrency < 1 || !Number.isFinite(workload.timeoutMs) || workload.timeoutMs <= 0) reject('invalid-workload');
    journeys.add(workload.journey);
  }
  if (!journeys.size) reject('missing-workload');
  const key = (journey: string, stratum: string, metric: string) => JSON.stringify([journey, stratum, metric]);
  const expected = new Set([...journeys].flatMap(journey => PERF_WORKLOAD_POLICY.strata.flatMap(stratum =>
    (['p95', 'p99', 'throughput'] as const).map(metric => key(journey, stratum, metric)))));
  const seen = new Set<string>();
  const baselines: Extract<PerfProtocolEvidence, { kind: 'baseline' }>[] = [];
  for (const ref of input.baselineEvidenceRefs) {
    const baseline = await read(ref);
    if (baseline?.kind !== 'baseline' || !sha(baseline.hash) || !Number.isFinite(baseline.endedAtMs) || baseline.endedAtMs >= input.createdAtMs ||
        !publishedBefore(baseline, input.createdAtMs) || baseline.publishedAtMs! < baseline.endedAtMs ||
        baseline.sourceManifestHash !== input.sourceManifestHash || baseline.fixtureHash !== input.fixtureHash) {
      reject('missing-late-or-unmatched-baseline'); continue;
    }
    const independence = await read(baseline.independenceEvidenceRef);
    if (!baseline.independentRepeatId.trim() || independence?.kind !== 'independence' || !sha(independence.hash) ||
        !independence.verified || independence.independentRepeatId !== baseline.independentRepeatId ||
        !publishedBefore(independence, input.createdAtMs)) reject('unverified-repeat-independence');
    if (baselines.some(other => other.independentRepeatId === baseline.independentRepeatId || other.hash === baseline.hash)) reject('duplicate-baseline-repeat');
    baselines.push(baseline);
  }
  if (baselines.length < 3) reject('insufficient-baseline-repeats');
  const powerComputations = new Map<string, Promise<boolean>>();
  for (const comparison of input.comparisons) {
    const identity = key(comparison.journey, comparison.stratum, comparison.metric);
    if (!expected.has(identity) || seen.has(identity)) reject('unexpected-or-duplicate-comparison');
    seen.add(identity);
    for (const baseline of baselines) {
      const observations = baseline.observations.filter(row => row.journey === comparison.journey && row.stratum === comparison.stratum);
      // Requiring 10k in each repeat is conservative; the protocol never relaxes the per-arm floor.
      if (observations.length !== 1 || !Number.isSafeInteger(observations[0].completedPerArm) || observations[0].completedPerArm < 10_000 || !observations[0].allObservationsRetained) reject('insufficient-or-censored-baseline');
      const length = comparison.blockLengths[baseline.independentRepeatId];
      if (!Number.isSafeInteger(length) || length < 1 || length > (observations[0]?.completedPerArm ?? 0)) reject('missing-or-invalid-baseline-block-length');
      const block = await read(comparison.blockEvidenceRefs[baseline.independentRepeatId] ?? '');
      if (block?.kind !== 'block-selection' || !sha(block.hash) || block.baselineHash !== baseline.hash ||
          block.independentRepeatId !== baseline.independentRepeatId || block.journey !== comparison.journey ||
          block.stratum !== comparison.stratum || block.metric !== comparison.metric || block.method !== 'baseline-acf-noise-band-v1' ||
          block.blockLength !== length || !Number.isFinite(block.endedAtMs) || block.endedAtMs >= input.createdAtMs ||
          !publishedBefore(block, input.createdAtMs) || block.publishedAtMs! < block.endedAtMs) reject('missing-or-unmatched-baseline-autocorrelation-proof');
    }
    if (Object.keys(comparison.blockLengths).length !== baselines.length) reject('block-length-repeat-set-mismatch');
    if (Object.keys(comparison.blockEvidenceRefs).length !== baselines.length) reject('block-evidence-repeat-set-mismatch');
    const power = await read(comparison.powerEvidenceRef);
    const margin = comparison.metric === 'p95' ? 1.05 : comparison.metric === 'p99' ? 1.10 : 0.95;
    // The evidence hashes the design excluding proof refs, avoiding a hash cycle.
    const design = { ...input, comparisons: input.comparisons.map(({ powerEvidenceRef: _ref, ...rest }) => rest) };
    const computationRef = power?.kind === 'power' ? power.computationRef ?? '' : '';
    if (!powerComputations.has(computationRef)) powerComputations.set(computationRef, (async () => {
      const computation = await read(computationRef);
      return computation?.kind === 'power-computation' && sha(computation.hash) &&
        Number.isFinite(computation.endedAtMs) && computation.endedAtMs < input.createdAtMs &&
        publishedBefore(computation, input.createdAtMs) && computation.publishedAtMs! >= computation.endedAtMs &&
        computation.protocolInputHash === perfProtocolHash(design) && reproducePerfWorkloadPower(input, baselines, computation);
    })().catch(() => false));
    if (!await powerComputations.get(computationRef)) reject('missing-or-unreproducible-joint-power-computation');
    const computation = await read(computationRef);
    const computedBound = computation?.kind === 'power-computation' && computation.result.status === 'estimated' ? computation.result.lowerPowerBound : null;
    if (power?.kind !== 'power' || !sha(power.hash) || power.protocolInputHash !== perfProtocolHash(design) ||
        power.journey !== comparison.journey || power.stratum !== comparison.stratum || power.metric !== comparison.metric ||
        !Number.isFinite(power.endedAtMs) || power.endedAtMs >= input.createdAtMs ||
        !publishedBefore(power, input.createdAtMs) || power.publishedAtMs! < power.endedAtMs ||
        !Number.isFinite(power.lowerPowerBound) || power.lowerPowerBound < 0.8 || power.lowerPowerBound > 1 ||
        power.lowerPowerBound !== computedBound ||
        power.comparisonAlpha !== (1 - PERF_WORKLOAD_POLICY.familyConfidence) / expected.size || power.margin !== margin) reject('missing-unmatched-or-underpowered-pretrial-proof');
  }
  if (seen.size !== expected.size || [...expected].some(identity => !seen.has(identity))) reject('incomplete-comparison-family');
  if (input.bootstrapReplicates * ((1 - PERF_WORKLOAD_POLICY.familyConfidence) / expected.size) / 2 < 20) reject('insufficient-bootstrap-tail-resolution');
  return { status: reasons.size ? 'unknown' : 'ready-for-trial', reasons: [...reasons].sort() };
}

/** Preserve failed/censored observations; no slow or failed request is deleted. */
export function normalizePerfWorkloadObservation(observation: {
  outcome: 'success' | 'timeout' | 'error' | 'disconnect';
  elapsedMs: number | null;
  timeoutMs: number;
  censored: boolean;
}): { status: 'measured'; latencyMs: number; failed: boolean } | { status: 'unknown'; reason: string } {
  if (!['success', 'timeout', 'error', 'disconnect'].includes(observation.outcome) ||
      !Number.isFinite(observation.timeoutMs) || observation.timeoutMs <= 0 ||
      (observation.elapsedMs !== null && (!Number.isFinite(observation.elapsedMs) || observation.elapsedMs < 0))) {
    return { status: 'unknown', reason: 'invalid-observation' };
  }
  if (observation.outcome === 'success' && (observation.elapsedMs === null || observation.censored)) {
    return { status: 'unknown', reason: 'incomplete-success' };
  }
  const failed = observation.outcome !== 'success';
  const latencyMs = observation.censored || observation.outcome === 'timeout' || observation.elapsedMs === null
    ? Math.max(observation.elapsedMs ?? 0, observation.timeoutMs) : observation.elapsedMs;
  return { status: 'measured', latencyMs, failed };
}
