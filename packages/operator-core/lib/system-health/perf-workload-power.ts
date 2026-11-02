/** Exact prospective power adapter for the existing immutable perf evidence. */
import { pairedRatioStatistic, prospectivePairedBlockPower, type PairedPowerComparison } from '@papercusp/bench-metrics';
import { PERF_WORKLOAD_POLICY, perfProtocolHash, type PerfWorkloadProtocolInput, type PerfProtocolEvidence } from './perf-workload-protocol';

type Baseline = Extract<PerfProtocolEvidence, { kind: 'baseline' }>;
type Computation = Extract<PerfProtocolEvidence, { kind: 'power-computation' }>;

/** Stable family identity is also the scenario's candidateScales key. */
export function perfPowerComparisonId(journey: string, stratum: string, metric: string): string {
  return JSON.stringify([journey, stratum, metric]);
}

/**
 * Every input number comes from retained baseline series and preregistered design.
 * This function cannot certify baseline independence/generator adequacy; callers
 * separately verify their evidence and publication chronology before starting.
 */
export function computePerfWorkloadPower(input: PerfWorkloadProtocolInput, baselines: readonly Baseline[]) {
  const design = input.powerDesign;
  if (!design || design.simulations < 200 || !Number.isFinite(design.monteCarloFamilyAlpha) ||
      design.monteCarloFamilyAlpha <= 0 || design.monteCarloFamilyAlpha > 0.05 || !design.scenarios.length ||
      baselines.length < PERF_WORKLOAD_POLICY.minimumIndependentPairedRepeats ||
      new Set(baselines.map(row => row.independentRepeatId)).size !== baselines.length ||
      new Set(baselines.map(row => row.hash)).size !== baselines.length) return { status: 'unknown' as const, reason: 'missing-or-invalid-prospective-design' };
  const family: PairedPowerComparison[] = [];
  const expected = new Set(input.workload.flatMap(row => PERF_WORKLOAD_POLICY.strata.flatMap(stratum =>
    (['p95', 'p99', 'throughput'] as const).map(metric => perfPowerComparisonId(row.journey, stratum, metric)))));
  for (const comparison of input.comparisons) {
    const id = perfPowerComparisonId(comparison.journey, comparison.stratum, comparison.metric);
    if (!expected.delete(id)) return { status: 'unknown' as const, reason: 'incomplete-power-family' };
    const repeats = [];
    for (const baseline of baselines) {
      const series = baseline.series?.filter(row => row.journey === comparison.journey && row.stratum === comparison.stratum && row.metric === comparison.metric);
      const counts = baseline.observations.filter(row => row.journey === comparison.journey && row.stratum === comparison.stratum);
      if (baseline.sourceManifestHash !== input.sourceManifestHash || baseline.fixtureHash !== input.fixtureHash ||
          series?.length !== 1 || counts.length !== 1 || !counts[0].allObservationsRetained ||
          series[0].a.length !== counts[0].completedPerArm || series[0].b.length !== counts[0].completedPerArm ||
          counts[0].completedPerArm < PERF_WORKLOAD_POLICY.minimumCompletedPerArm ||
          series[0].a.some(x => !Number.isFinite(x) || x < 0) || series[0].b.some(x => !Number.isFinite(x) || x < 0)) {
        return { status: 'unknown' as const, reason: 'missing-or-unmatched-raw-power-baseline' };
      }
      repeats.push({ repeatId: baseline.independentRepeatId, a: series[0].a, b: series[0].b, blockLength: comparison.blockLengths[baseline.independentRepeatId] });
    }
    const quantile = comparison.metric === 'p95' ? 0.95 : 0.99;
    family.push({ id, repeats, direction: comparison.metric === 'throughput' ? 'lower' : 'upper',
      limit: comparison.metric === 'p95' ? 1.05 : comparison.metric === 'p99' ? 1.10 : 0.95,
      statistic: pairedRatioStatistic(comparison.metric === 'throughput' ? 'mean' : quantile) });
  }
  if (expected.size || !family.length) return { status: 'unknown' as const, reason: 'incomplete-power-family' };
  if (!design.scenarios.some(scenario => family.every(member => scenario.candidateScales[member.id] === 1))) {
    return { status: 'unknown' as const, reason: 'missing-unchanged-baseline-alternative' };
  }
  for (const comparison of input.comparisons.filter(row => row.metric === 'p95')) {
    const p95 = perfPowerComparisonId(comparison.journey, comparison.stratum, 'p95');
    const p99 = perfPowerComparisonId(comparison.journey, comparison.stratum, 'p99');
    if (design.scenarios.some(scenario => scenario.candidateScales[p95] !== scenario.candidateScales[p99])) {
      return { status: 'unknown' as const, reason: 'inconsistent-latency-alternative' };
    }
    for (const baseline of baselines) {
      const rows = baseline.series!.filter(row => row.journey === comparison.journey && row.stratum === comparison.stratum);
      const a = rows.find(row => row.metric === 'p95')!;
      const b = rows.find(row => row.metric === 'p99')!;
      if (a.a.some((value, i) => value !== b.a[i]) || a.b.some((value, i) => value !== b.b[i])) {
        return { status: 'unknown' as const, reason: 'inconsistent-latency-baseline' };
      }
    }
  }
  try {
    return prospectivePairedBlockPower(family, design.scenarios, { simulations: design.simulations,
      iterations: input.bootstrapReplicates, seed: input.seed, familyConfidence: PERF_WORKLOAD_POLICY.familyConfidence,
      monteCarloFamilyAlpha: design.monteCarloFamilyAlpha, maximumSampledPairs: design.maximumSampledPairs });
  } catch { return { status: 'unknown' as const, reason: 'invalid-or-uncomputable-power-design' }; }
}

/** Exact replay; neither a caller scalar nor an artifact-integrity PASS suffices. */
export function reproducePerfWorkloadPower(input: PerfWorkloadProtocolInput, baselines: readonly Baseline[], computation: Computation): boolean {
  const result = computePerfWorkloadPower(input, baselines);
  return result.status === 'estimated' && result.lowerPowerBound >= PERF_WORKLOAD_POLICY.minimumPretrialPower &&
    perfProtocolHash(result) === perfProtocolHash(computation.result);
}
