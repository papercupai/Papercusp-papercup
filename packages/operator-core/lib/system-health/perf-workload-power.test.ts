import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prospectivePairedBlockPower, type PairedBlockPower } from '@papercusp/bench-metrics';
import { computePerfWorkloadPower, reproducePerfWorkloadPower, perfPowerComparisonId } from './perf-workload-power';
import { perfProtocolHash, type PerfProtocolEvidence, type PerfWorkloadProtocolInput } from './perf-workload-protocol';

// The real nested engine is exercised with exact tiny fixtures in intervals.test.
// This boundary suite tests 10k raw-input validation without performing a 54B-pair run.
vi.mock('@papercusp/bench-metrics', async importOriginal => ({
  ...await importOriginal<typeof import('@papercusp/bench-metrics')>(), prospectivePairedBlockPower: vi.fn(),
}));
const result: PairedBlockPower = { status: 'estimated', method: 'nested-paired-block-production-ci-fixed-monte-carlo-v1',
  assumption: 'conditional-on-preregistered-empirical-baseline-generator', simulations: 200, iterations: 10_000,
  seed: 4, familySize: 9, comparisonAlpha: (1 - 0.95) / 9, monteCarloFamilyAlpha: 0.05,
  scenarios: [{ id: 'unchanged', jointPasses: 200, lowerPowerBound: 0.9 }], lowerPowerBound: 0.9 };
const hash = (x: unknown) => perfProtocolHash(x);
function fixture() {
  const input: PerfWorkloadProtocolInput = { createdAtMs: 1000, planRevision: 28, planContentHash: hash('plan'),
    rubricRevision: 11, rubricContentHash: hash('rubric'), sourceManifestHash: hash('source'), fixtureHash: hash('fixture'),
    workload: [{ journey: 'http', operationMix: 'fixture', concurrency: 1, timeoutMs: 3000, oracleRef: 'oracle' }],
    baselineEvidenceRefs: ['b1', 'b2', 'b3'], comparisons: [], bootstrapReplicates: 10_000, seed: 4 };
  for (const stratum of ['cold', 'warm', 'burst'] as const) for (const metric of ['p95', 'p99', 'throughput'] as const)
    input.comparisons.push({ journey: 'http', stratum, metric, powerEvidenceRef: 'power',
      blockLengths: { r1: 1, r2: 1, r3: 1 }, blockEvidenceRefs: { r1: 'a', r2: 'b', r3: 'c' } });
  input.powerDesign = { simulations: 200, monteCarloFamilyAlpha: 0.05, maximumSampledPairs: 1,
    scenarios: [{ id: 'unchanged', candidateScales: Object.fromEntries(input.comparisons.map(row => [perfPowerComparisonId(row.journey, row.stratum, row.metric), 1])) }] };
  const baselines: Extract<PerfProtocolEvidence, { kind: 'baseline' }>[] = [1, 2, 3].map(n => ({
    kind: 'baseline', hash: hash(n), endedAtMs: 800, independentRepeatId: `r${n}`, independenceEvidenceRef: `ind:${n}`,
    sourceManifestHash: input.sourceManifestHash, fixtureHash: input.fixtureHash,
    observations: ['cold', 'warm', 'burst'].map(stratum => ({ journey: 'http', stratum: stratum as 'cold' | 'warm' | 'burst', completedPerArm: 10_000, allObservationsRetained: true })),
    series: input.comparisons.map(row => ({ journey: row.journey, stratum: row.stratum, metric: row.metric, a: Array(10_000).fill(10), b: Array(10_000).fill(10) })),
  }));
  return { input, baselines };
}
beforeEach(() => { vi.mocked(prospectivePairedBlockPower).mockReset().mockReturnValue(structuredClone(result)); });

describe('retained prospective joint power', () => {
  it('constructs the complete family with production quantiles/rate ratios and registered options', () => {
    const f = fixture();
    expect(computePerfWorkloadPower(f.input, f.baselines)).toEqual(result);
    const [family, scenarios, options] = vi.mocked(prospectivePairedBlockPower).mock.calls[0];
    expect(family).toHaveLength(9);
    expect(scenarios).toEqual(f.input.powerDesign!.scenarios);
    expect(options).toMatchObject({ iterations: 10_000, simulations: 200, maximumSampledPairs: 1, seed: 4 });
    expect(family[0].statistic([10, 20, 30, 40], [20, 40, 60, 80])).toBe(2);
    expect(family[2].statistic([0, 2], [2, 2])).toBe(2);
    expect(family[2].statistic([0, 0], [2, 2])).toBeNull();
  });
  it.each(['missing-series', 'short', 'deleted', 'fixture', 'family', 'nan', 'duplicate-repeat'] as const)
    ('keeps %s baseline unknown before running the engine', mutation => {
      const f = fixture();
      if (mutation === 'missing-series') delete f.baselines[0].series;
      if (mutation === 'short') f.baselines[0].series![0].a.pop();
      if (mutation === 'deleted') f.baselines[0].observations[0].allObservationsRetained = false;
      if (mutation === 'fixture') f.baselines[0].fixtureHash = hash('other');
      if (mutation === 'family') f.input.comparisons.pop();
      if (mutation === 'nan') f.baselines[0].series![0].b[0] = NaN;
      if (mutation === 'duplicate-repeat') f.baselines[0].independentRepeatId = 'r2';
      expect(computePerfWorkloadPower(f.input, f.baselines).status).toBe('unknown');
      expect(prospectivePairedBlockPower).not.toHaveBeenCalled();
    });
  it('requires exact replay of the full retained result, never merely a large scalar', () => {
    const f = fixture();
    const computation: Extract<PerfProtocolEvidence, { kind: 'power-computation' }> = { kind: 'power-computation', hash: hash('c'),
      endedAtMs: 900, protocolInputHash: hash('design'), result: structuredClone(result) };
    expect(reproducePerfWorkloadPower(f.input, f.baselines, computation)).toBe(true);
    if (computation.result.status !== 'estimated') throw new Error('fixture');
    computation.result.scenarios[0].jointPasses--;
    expect(reproducePerfWorkloadPower(f.input, f.baselines, computation)).toBe(false);
    vi.mocked(prospectivePairedBlockPower).mockReturnValue({ status: 'unknown', reason: 'prospective-computation-budget' });
    expect(reproducePerfWorkloadPower(f.input, f.baselines, computation)).toBe(false);
  });
  it('rejects favorable-only alternatives or incompatible p95/p99 generators', () => {
    const f = fixture();
    const scales = f.input.powerDesign!.scenarios[0].candidateScales as Record<string, number>;
    const key95 = perfPowerComparisonId('http', 'cold', 'p95');
    scales[key95] = 0.5;
    expect(computePerfWorkloadPower(f.input, f.baselines)).toMatchObject({ status: 'unknown', reason: 'missing-unchanged-baseline-alternative' });
    f.input.powerDesign!.scenarios.push({ id: 'unchanged-2', candidateScales: Object.fromEntries(Object.keys(scales).map(key => [key, 1])) });
    expect(computePerfWorkloadPower(f.input, f.baselines)).toMatchObject({ status: 'unknown', reason: 'inconsistent-latency-alternative' });
    scales[key95] = 1;
    f.baselines[0].series!.find(row => row.stratum === 'cold' && row.metric === 'p99')!.a[0] = 11;
    expect(computePerfWorkloadPower(f.input, f.baselines)).toMatchObject({ status: 'unknown', reason: 'inconsistent-latency-baseline' });
  });
});
