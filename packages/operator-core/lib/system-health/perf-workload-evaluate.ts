/** Replay the complete D-012 performance family; memory/correctness/soak remain separate. */
import { pairedRatioStatistic, pairedBlockBootstrapCI, type PairedBlockInterval } from '@papercusp/bench-metrics';
import {
  PERF_WORKLOAD_POLICY, perfProtocolHash, verifyPerfWorkloadPrerequisites,
  type PerfProtocolEvidence, type PerfWorkloadProtocol,
} from './perf-workload-protocol';
import { perfWorkloadRunSeries, type PerfWorkloadRun } from './perf-workload-run';

type Baseline = Extract<PerfProtocolEvidence, { kind: 'baseline' }>;
type ReadEvidence = (ref: string) => Promise<PerfProtocolEvidence | null>;
export interface PerfWorkloadTrialRepeat {
  runRef: string;
  /** The baseline repeat whose PRETRIAL selected block lengths this repeat uses. */
  baselineRepeatId: string;
  independenceEvidenceRef: string;
}
export interface PerfWorkloadEvaluation {
  schemaVersion: 1;
  protocolHash: string;
  registrationRef: string;
  repeats: PerfWorkloadTrialRepeat[];
  /** Performance only: this is never authority to reduce memory or ship. */
  status: 'performance-noninferior' | 'performance-regressed' | 'unknown';
  reasons: string[];
  comparisons: Array<{ journey: string; stratum: string; metric: string; limit: number; interval: PairedBlockInterval }>;
  hash: string;
}

/** Derive baseline numbers ONLY from the retained raw collection. No qualification assertion. */
export function perfWorkloadBaselineBody(run: PerfWorkloadRun, runEvidenceRef: string, independenceEvidenceRef: string): Omit<Baseline, 'hash' | 'publishedAtMs'> | null {
  const series = perfWorkloadRunSeries(run);
  if (!series || run.plan.phase !== 'baseline' || !runEvidenceRef.trim() || !independenceEvidenceRef.trim()) return null;
  const manifests = run.groups.flatMap(group => group.arms.map(arm => arm.before!));
  const sourceManifestHash = perfProtocolHash(manifests[0].source);
  if (manifests.some(manifest => perfProtocolHash(manifest.source) !== sourceManifestHash)) return null;
  return {
    kind: 'baseline', endedAtMs: run.endedAtMs, sourceManifestHash,
    fixtureHash: perfProtocolHash({ groups: run.plan.groups }), independentRepeatId: run.plan.independentRepeatId,
    independenceEvidenceRef, runEvidenceRef,
    observations: series.map(group => ({ journey: group.journey, stratum: group.stratum,
      completedPerArm: group.a.latencyMs.length, allObservationsRetained: true })),
    series: series.flatMap(group => (['p95', 'p99', 'throughput'] as const).map(metric => ({
      journey: group.journey, stratum: group.stratum, metric,
      a: metric === 'throughput' ? group.a.throughput : group.a.latencyMs,
      b: metric === 'throughput' ? group.b.throughput : group.b.latencyMs,
    }))),
  };
}

/** Artifact readers own hash/scope integrity; absent or failed reads stay unknown. */
export async function evaluatePerfWorkloadRuns(protocol: PerfWorkloadProtocol, registrationRef: string,
  repeats: readonly PerfWorkloadTrialRepeat[], readEvidence: ReadEvidence): Promise<PerfWorkloadEvaluation> {
  // Freeze the inputs before the first asynchronous read, including the reader's objects.
  const pinned = structuredClone(protocol);
  const trial = structuredClone([...repeats]);
  const reasons = new Set<string>();
  const comparisons: PerfWorkloadEvaluation['comparisons'] = [];
  const cache = new Map<string, Promise<PerfProtocolEvidence | null>>();
  const read = (ref: string) => {
    if (!cache.has(ref)) cache.set(ref, Promise.resolve().then(() => readEvidence(ref)).then(row => row && structuredClone(row)).catch(() => null));
    return cache.get(ref)!;
  };
  const finish = (regressed = false): PerfWorkloadEvaluation => {
    const body = { schemaVersion: 1 as const, protocolHash: pinned.hash, registrationRef, repeats: trial,
      status: reasons.size ? 'unknown' as const : regressed ? 'performance-regressed' as const : 'performance-noninferior' as const,
      reasons: [...reasons].sort(), comparisons };
    return { ...body, hash: perfProtocolHash(body) };
  };
  try {
    const minimum = PERF_WORKLOAD_POLICY.minimumIndependentPairedRepeats;
    if (trial.length < minimum || new Set(trial.map(row => row.runRef)).size !== trial.length ||
        new Set(trial.map(row => row.baselineRepeatId)).size !== trial.length ||
        new Set(trial.map(row => row.independenceEvidenceRef)).size !== trial.length) reasons.add('missing-or-duplicate-trial-repeat');
    const runRows = await Promise.all(trial.map(row => read(row.runRef)));
    const runs: PerfWorkloadRun[] = [];
    for (const row of runRows) {
      if (row?.kind !== 'matched-run' || row.capture.plan.phase !== 'candidate' || row.endedAtMs !== row.capture.endedAtMs ||
          !Number.isFinite(row.publishedAtMs) || row.publishedAtMs! < row.endedAtMs) reasons.add('missing-or-unretained-candidate');
      else runs.push(row.capture);
    }
    if (runs.length !== trial.length || !runs.length) return finish();
    if (new Set(runs.map(run => run.hash)).size !== runs.length ||
        new Set(runs.map(run => run.plan.independentRepeatId)).size !== runs.length) reasons.add('duplicate-candidate-identity');
    const prerequisites = await verifyPerfWorkloadPrerequisites(pinned, registrationRef, Math.min(...runs.map(run => run.startedAtMs)), read);
    if (prerequisites.status !== 'ready-for-trial') for (const reason of prerequisites.reasons) reasons.add(`prerequisite:${reason}`);
    // Full runtime/source/configuration/host/fixture snapshots must be pinned BEFORE the trial.
    const manifestPins = pinned.input.trialManifestHashes;
    if (!manifestPins || !['a', 'b'].every(arm => /^[a-f0-9]{64}$/.test(manifestPins[arm as 'a' | 'b']))) reasons.add('missing-pretrial-manifest-pins');
    const baselines = await Promise.all(pinned.input.baselineEvidenceRefs.map(read));
    if (baselines.some(row => row?.kind !== 'baseline')) reasons.add('missing-baseline');
    const byRepeat = new Map(baselines.filter((row): row is Baseline => row?.kind === 'baseline').map(row => [row.independentRepeatId, row]));
    if (trial.length !== byRepeat.size || trial.some(row => !byRepeat.has(row.baselineRepeatId))) reasons.add('unmatched-baseline-repeats');
    const series = runs.map(perfWorkloadRunSeries);
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      const baseline = byRepeat.get(trial[i].baselineRepeatId);
      const independence = await read(trial[i].independenceEvidenceRef);
      if (independence?.kind !== 'independence' || !independence.verified || independence.independentRepeatId !== run.plan.independentRepeatId ||
          !Number.isFinite(independence.publishedAtMs) || independence.publishedAtMs! >= run.startedAtMs) reasons.add('missing-pretrial-repeat-independence');
      if (perfProtocolHash({ groups: run.plan.groups }) !== pinned.input.fixtureHash ||
          !manifestPins || perfProtocolHash(run.plan.expectedManifestHashes) !== perfProtocolHash(manifestPins)) reasons.add('candidate-manifest-or-schedule-drift');
      if (!series[i]) reasons.add('incomplete-raw-candidate');
      // Bind stored baseline series back to their raw collection, rather than trusting scalars.
      const baselineRaw = baseline?.runEvidenceRef ? await read(baseline.runEvidenceRef) : null;
      const derived = baselineRaw?.kind === 'matched-run' ? perfWorkloadBaselineBody(baselineRaw.capture, baseline!.runEvidenceRef!, baseline!.independenceEvidenceRef) : null;
      if (!baseline || !derived || baselineRaw?.kind !== 'matched-run' || baselineRaw.endedAtMs !== baselineRaw.capture.endedAtMs ||
          !Number.isFinite(baselineRaw.publishedAtMs) || baselineRaw.publishedAtMs! >= pinned.input.createdAtMs ||
          baselineRaw.publishedAtMs! < baselineRaw.endedAtMs ||
          perfProtocolHash(derived) !== perfProtocolHash((({ hash: _hash, publishedAtMs: _published, ...body }) => body)(baseline))) reasons.add('baseline-raw-series-mismatch');
      for (const group of run.groups) {
        const workload = pinned.input.workload.find(row => row.journey === group.journey);
        const plan = run.plan.groups.find(row => row.journey === group.journey && row.stratum === group.stratum);
        if (!workload || !plan || workload.concurrency !== plan.concurrency || plan.requests.some(row => row.timeoutMs !== workload.timeoutMs)) reasons.add('candidate-workload-drift');
        for (const arm of group.arms) if (!arm.before || perfProtocolHash(arm.before.source) !== pinned.input.sourceManifestHash && arm.arm === 'a') reasons.add('baseline-arm-source-drift');
        // Every scheduled pair must be classified. New failures are a hard regression,
        // irrespective of a fast latency statistic or a passing throughput interval.
        for (const arm of group.arms) for (const row of arm.requests) {
          if (!['success', 'timeout', 'error', 'disconnect', 'not-dispatched'].includes(row.outcome) ||
              row.outcome === 'success' && (!row.oracleMatched || row.censored)) reasons.add('invalid-response-oracle');
        }
      }
    }
    const familyKeys = new Set(pinned.input.comparisons.map(row => JSON.stringify([row.journey, row.stratum])));
    for (const groups of series) if (groups && (groups.length !== familyKeys.size || groups.some(group => !familyKeys.has(JSON.stringify([group.journey, group.stratum]))))) reasons.add('incomplete-candidate-family');
    if (reasons.size) return finish();
    let regressed = false;
    for (let i = 0; i < runs.length; i++) {
      const baselineRaw = await read(byRepeat.get(trial[i].baselineRepeatId)!.runEvidenceRef!);
      if (baselineRaw?.kind !== 'matched-run') throw new Error('baseline disappeared');
      for (const group of runs[i].groups) {
        const baselineGroup = baselineRaw.capture.groups.find(row => row.journey === group.journey && row.stratum === group.stratum)!;
        for (const arm of group.arms) for (let j = 0; j < arm.requests.length; j++) {
          const before = baselineGroup.arms.find(row => row.arm === arm.arm)!.requests[j];
          const after = arm.requests[j];
          if (after.outcome !== 'success' && (before.outcome !== after.outcome || before.diagnostic !== after.diagnostic)) regressed = true;
        }
      }
    }
    for (const comparison of pinned.input.comparisons) {
      const isRate = comparison.metric === 'throughput';
      const quantile = comparison.metric === 'p95' ? 0.95 : 0.99;
      const samples = series.map((groups, i) => {
        const group = groups!.find(row => row.journey === comparison.journey && row.stratum === comparison.stratum)!;
        if (group.a.latencyMs.length < PERF_WORKLOAD_POLICY.minimumCompletedPerArm || group.b.latencyMs.length < PERF_WORKLOAD_POLICY.minimumCompletedPerArm) reasons.add('insufficient-candidate-count');
        return { repeatId: trial[i].baselineRepeatId, a: isRate ? group.a.throughput : group.a.latencyMs,
          b: isRate ? group.b.throughput : group.b.latencyMs, blockLength: comparison.blockLengths[trial[i].baselineRepeatId] };
      });
      if (samples.some(sample => sample.a.length < PERF_WORKLOAD_POLICY.minimumCompletedPerArm || sample.b.length < PERF_WORKLOAD_POLICY.minimumCompletedPerArm)) continue;
      const interval = pairedBlockBootstrapCI(samples, pairedRatioStatistic(isRate ? 'mean' : quantile),
        { familySize: pinned.input.comparisons.length, familyConfidence: PERF_WORKLOAD_POLICY.familyConfidence,
        iterations: pinned.input.bootstrapReplicates, seed: pinned.input.seed });
      const limit = isRate ? PERF_WORKLOAD_POLICY.ratios.throughputLower : comparison.metric === 'p95' ? PERF_WORKLOAD_POLICY.ratios.p95Upper : PERF_WORKLOAD_POLICY.ratios.p99Upper;
      comparisons.push({ journey: comparison.journey, stratum: comparison.stratum, metric: comparison.metric, limit, interval });
      if (interval.status === 'unknown') reasons.add(`interval:${interval.reason}`);
      else if (isRate ? interval.interval.lower < limit : interval.interval.upper > limit) regressed = true;
    }
    return finish(regressed);
  } catch { reasons.add('unreadable-or-invalid-evaluation-input'); return finish(); }
}

/** Hash integrity only; evaluated performance is not memory/soak/shipment acceptance. */
export function intactPerfWorkloadEvaluation(value: unknown): value is PerfWorkloadEvaluation {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const { hash, ...body } = value as PerfWorkloadEvaluation;
    return body.schemaVersion === 1 && /^[a-f0-9]{64}$/.test(body.protocolHash) &&
      ['performance-noninferior', 'performance-regressed', 'unknown'].includes(body.status) &&
      Array.isArray(body.repeats) && Array.isArray(body.reasons) && Array.isArray(body.comparisons) && perfProtocolHash(body) === hash;
  } catch { return false; }
}
