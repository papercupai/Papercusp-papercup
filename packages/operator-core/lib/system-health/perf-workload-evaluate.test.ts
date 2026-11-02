import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pairedBlockBootstrapCI } from '@papercusp/bench-metrics';
import { evaluatePerfWorkloadRuns, intactPerfWorkloadEvaluation, perfWorkloadBaselineBody } from './perf-workload-evaluate';
import { perfProtocolHash, sealPerfWorkloadProtocol, verifyPerfWorkloadPrerequisites, type PerfProtocolEvidence, type PerfWorkloadProtocolInput } from './perf-workload-protocol';
import { perfWorkloadRunSeries, type PerfWorkloadRun, type PerfWorkloadManifest } from './perf-workload-run';

// Boundary tests: the real collector's hash/series checks and exact interval
// engine have their own suites. Never execute 9 x 10k x 30k inner pairs here.
vi.mock('@papercusp/bench-metrics', async original => ({ ...await original<typeof import('@papercusp/bench-metrics')>(), pairedBlockBootstrapCI: vi.fn() }));
vi.mock('./perf-workload-protocol', async original => ({ ...await original<typeof import('./perf-workload-protocol')>(), verifyPerfWorkloadPrerequisites: vi.fn() }));
vi.mock('./perf-workload-run', async original => ({ ...await original<typeof import('./perf-workload-run')>(), perfWorkloadRunSeries: vi.fn() }));
const hash = perfProtocolHash;
const manifest: PerfWorkloadManifest = { source: { fixture: 'source' }, configuration: { fixture: true },
  runtime: { fixture: true }, host: { fixture: true }, workload: { fixture: true }, fixture: { fixture: true } };
const values = Array(10_000).fill(10) as number[];
const strata = ['cold', 'warm', 'burst'] as const;
const derived = () => strata.map(stratum => ({ journey: 'http', stratum,
  a: { latencyMs: values, throughput: values, failures: 0 }, b: { latencyMs: values, throughput: values, failures: 0 } }));
const raw = (id: string, phase: 'baseline' | 'candidate'): PerfWorkloadRun => {
  const groups = strata.map(stratum => ({ journey: 'http', stratum, armOrder: ['a', 'b'] as ['a', 'b'],
    concurrency: 1, exposureMs: 100, maximumStartLatenessMs: 10,
    requests: [{ id: 'request', path: '/fixture', atMs: 0, timeoutMs: 20, maximumResponseBytes: 10, expectedStatus: 200, expectedBodySha256: hash('response') }] }));
  const plan = { independentRepeatId: id, phase, origins: { a: 'http://localhost:1', b: 'http://localhost:2' },
    expectedManifestHashes: { a: hash(manifest), b: hash(manifest) }, groups };
  const body = { schemaVersion: 1 as const, plan, planHash: hash(plan), startedAtMs: phase === 'baseline' ? 100 : 2000,
    endedAtMs: phase === 'baseline' ? 200 : 2100, status: 'collected' as const, reasons: [],
    groups: groups.map(group => ({ journey: group.journey, stratum: group.stratum,
      arms: (['a', 'b'] as const).map(arm => ({ arm, before: manifest, after: manifest, preparation: { fixture: true }, elapsedMs: 100,
        requests: [{ id: 'request', scheduledAtMs: 0, startedAtMs: 0, elapsedMs: 10, outcome: 'success' as const, censored: false,
          responseStatus: 200, responseBytes: 2, responseSha256: hash('response'), oracleMatched: true, diagnostic: null, preparation: { fixture: true } }] })) })) };
  return { ...body, hash: hash(body) };
};
function fixture() {
  const proofs = new Map<string, PerfProtocolEvidence>();
  const input: PerfWorkloadProtocolInput = { createdAtMs: 1000, planRevision: 28, planContentHash: hash('plan'), rubricRevision: 11,
    rubricContentHash: hash('rubric'), sourceManifestHash: hash(manifest.source), fixtureHash: hash({ groups: raw('x', 'baseline').plan.groups }),
    trialManifestHashes: { a: hash(manifest), b: hash(manifest) },
    workload: [{ journey: 'http', operationMix: 'fixture', concurrency: 1, timeoutMs: 20, oracleRef: 'oracle' }],
    baselineEvidenceRefs: [], comparisons: [], bootstrapReplicates: 10_000, seed: 4 };
  const repeats = [1, 2, 3].map(n => {
    const baseline = raw(`b${n}`, 'baseline'); const candidate = raw(`c${n}`, 'candidate');
    const body = perfWorkloadBaselineBody(baseline, `baseline-raw:${n}`, `baseline-ind:${n}`)!;
    proofs.set(`baseline:${n}`, { ...body, hash: hash(body), publishedAtMs: 300 });
    proofs.set(`baseline-raw:${n}`, { kind: 'matched-run', hash: hash(['baseline', n]), endedAtMs: 200, capture: baseline, publishedAtMs: 250 });
    proofs.set(`candidate:${n}`, { kind: 'matched-run', hash: hash(['candidate', n]), endedAtMs: 2100, capture: candidate, publishedAtMs: 2200 });
    proofs.set(`candidate-ind:${n}`, { kind: 'independence', hash: hash(['independence', n]), independentRepeatId: `c${n}`, verified: true, publishedAtMs: 500 });
    input.baselineEvidenceRefs.push(`baseline:${n}`);
    return { runRef: `candidate:${n}`, baselineRepeatId: `b${n}`, independenceEvidenceRef: `candidate-ind:${n}` };
  });
  for (const stratum of strata) for (const metric of ['p95', 'p99', 'throughput'] as const) input.comparisons.push({
    journey: 'http', stratum, metric, powerEvidenceRef: 'power', blockLengths: { b1: 1, b2: 2, b3: 3 }, blockEvidenceRefs: { b1: 'acf1', b2: 'acf2', b3: 'acf3' } });
  return { input, proofs, repeats, read: async (ref: string) => proofs.get(ref) ?? null };
}
beforeEach(() => {
  vi.mocked(perfWorkloadRunSeries).mockReset().mockImplementation(() => derived());
  vi.mocked(verifyPerfWorkloadPrerequisites).mockReset().mockResolvedValue({ status: 'ready-for-trial', reasons: [] });
  vi.mocked(pairedBlockBootstrapCI).mockReset().mockReturnValue({ status: 'measured',
    interval: { point: 1, lower: 1, upper: 1, ci: 1 - (1 - 0.95) / 9 },
    method: 'paired-hierarchical-circular-block-percentile-type7', independentRepeats: 3, pairs: 30_000,
    iterations: 10_000, seed: 4, familySize: 9, familyConfidence: 0.95, comparisonAlpha: (1 - 0.95) / 9 });
});
describe('retained matched-workload performance evaluation', () => {
  it('replays prerequisites and raw lineage, then uses the complete frozen family and baseline block lengths', async () => {
    const f = fixture(); const protocol = sealPerfWorkloadProtocol(f.input);
    const result = await evaluatePerfWorkloadRuns(protocol, 'registration', f.repeats, f.read);
    expect(result.status).toBe('performance-noninferior');
    expect(result.comparisons).toHaveLength(9);
    expect(intactPerfWorkloadEvaluation(result)).toBe(true);
    expect(verifyPerfWorkloadPrerequisites).toHaveBeenCalledWith(protocol, 'registration', 2000, expect.any(Function));
    const [samples, statistic, options] = vi.mocked(pairedBlockBootstrapCI).mock.calls[0];
    expect(samples.map(row => row.blockLength)).toEqual([1, 2, 3]);
    expect(options).toEqual({ familySize: 9, familyConfidence: 0.95, iterations: 10_000, seed: 4 });
    expect(statistic([10, 20], [20, 40])).toBe(2);
    expect(statistic([0, 0], [1, 1])).toBeNull();
    result.status = 'unknown'; expect(intactPerfWorkloadEvaluation(result)).toBe(false);
  });
  it.each(['missing-run', 'missing-raw', 'changed-baseline-series', 'late-independence', 'duplicate-repeat', 'manifest-drift', 'missing-pins'] as const)
    ('keeps %s unknown, before any CI computation', async mutation => {
      const f = fixture();
      if (mutation === 'missing-run') f.proofs.delete('candidate:1');
      if (mutation === 'missing-raw') f.proofs.delete('baseline-raw:1');
      if (mutation === 'changed-baseline-series') { const b = f.proofs.get('baseline:1')!; if (b.kind === 'baseline') b.series = []; }
      if (mutation === 'late-independence') f.proofs.get('candidate-ind:1')!.publishedAtMs = 2000;
      if (mutation === 'duplicate-repeat') f.repeats[1] = f.repeats[0];
      if (mutation === 'manifest-drift') { const c = f.proofs.get('candidate:1')!; if (c.kind === 'matched-run') c.capture.plan.expectedManifestHashes.b = hash('changed'); }
      if (mutation === 'missing-pins') delete f.input.trialManifestHashes;
      expect((await evaluatePerfWorkloadRuns(sealPerfWorkloadProtocol(f.input), 'registration', f.repeats, f.read)).status).toBe('unknown');
      expect(pairedBlockBootstrapCI).not.toHaveBeenCalled();
    });
  it('keeps insufficient power or a failed resolver unknown', async () => {
    const f = fixture();
    vi.mocked(verifyPerfWorkloadPrerequisites).mockResolvedValue({ status: 'unknown', reasons: ['underpowered'] });
    const result = await evaluatePerfWorkloadRuns(sealPerfWorkloadProtocol(f.input), 'registration', f.repeats, f.read);
    expect(result.reasons).toContain('prerequisite:underpowered');
    expect(pairedBlockBootstrapCI).not.toHaveBeenCalled();
    expect((await evaluatePerfWorkloadRuns(sealPerfWorkloadProtocol(f.input), 'registration', f.repeats, async () => { throw new Error('unavailable'); })).status).toBe('unknown');
  });
  it('uses the simultaneous interval boundary and retains undefined-resample uncertainty', async () => {
    const f = fixture();
    vi.mocked(pairedBlockBootstrapCI).mockReturnValue({ status: 'unknown', reason: 'undefined-bootstrap-statistic' });
    const result = await evaluatePerfWorkloadRuns(sealPerfWorkloadProtocol(f.input), 'registration', f.repeats, f.read);
    expect(result.status).toBe('unknown'); expect(result.comparisons).toHaveLength(9);
    expect(result.reasons).toContain('interval:undefined-bootstrap-statistic');
  });
  it('rejects new correctness failures even when all numerical intervals pass', async () => {
    const f = fixture(); const c = f.proofs.get('candidate:1')!;
    if (c.kind !== 'matched-run') throw new Error('fixture');
    c.capture.groups[0].arms[1].requests[0].outcome = 'error';
    c.capture.groups[0].arms[1].requests[0].oracleMatched = false;
    const { hash: _hash, ...body } = c.capture;
    c.capture.hash = hash(body);
    expect((await evaluatePerfWorkloadRuns(sealPerfWorkloadProtocol(f.input), 'registration', f.repeats, f.read)).status).toBe('performance-regressed');
  });
  it('rejects a ratio outside the fixed simultaneous bounds', async () => {
    const f = fixture(); const measured = vi.mocked(pairedBlockBootstrapCI).getMockImplementation()!;
    // Use the exact returned interval shape, changing only its bounds.
    const interval = measured([], () => 1, { familySize: 9 });
    if (interval.status !== 'measured') throw new Error('fixture');
    vi.mocked(pairedBlockBootstrapCI).mockReturnValue({ ...interval, interval: { ...interval.interval, lower: 0.949, upper: 1.051 } });
    expect((await evaluatePerfWorkloadRuns(sealPerfWorkloadProtocol(f.input), 'registration', f.repeats, f.read)).status).toBe('performance-regressed');
  });
  it('keeps a sparse candidate unknown without lowering the required sample size', async () => {
    const f = fixture();
    vi.mocked(perfWorkloadRunSeries).mockImplementation(run => run.plan.phase === 'baseline' ? derived() : derived().map(group => ({ ...group,
      a: { ...group.a, latencyMs: values.slice(1), throughput: values.slice(1) },
      b: { ...group.b, latencyMs: values.slice(1), throughput: values.slice(1) } })));
    const result = await evaluatePerfWorkloadRuns(sealPerfWorkloadProtocol(f.input), 'registration', f.repeats, f.read);
    expect(result.status).toBe('unknown'); expect(result.reasons).toContain('insufficient-candidate-count');
    expect(pairedBlockBootstrapCI).not.toHaveBeenCalled();
  });
  it('cannot derive a baseline from missing raw series or a candidate run', () => {
    vi.mocked(perfWorkloadRunSeries).mockReturnValue(null);
    expect(perfWorkloadBaselineBody(raw('b', 'baseline'), 'raw', 'ind')).toBeNull();
    vi.mocked(perfWorkloadRunSeries).mockReturnValue(derived());
    expect(perfWorkloadBaselineBody(raw('c', 'candidate'), 'raw', 'ind')).toBeNull();
  });
});
