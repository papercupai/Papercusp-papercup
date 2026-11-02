import { describe, expect, it, vi } from 'vitest';
// These orchestration tests isolate the separately tested, expensive replay engine.
vi.mock('./perf-workload-power', () => ({ reproducePerfWorkloadPower: vi.fn(() => true) }));
import { PERF_WORKLOAD_POLICY, perfProtocolHash, sealPerfWorkloadProtocol, verifyPerfWorkloadPrerequisites, normalizePerfWorkloadObservation,
  type PerfWorkloadProtocolInput, type PerfProtocolEvidence } from './perf-workload-protocol';

const hash = (text: string) => perfProtocolHash(text);
function fixture() {
  const proofs = new Map<string, PerfProtocolEvidence>();
  const input: PerfWorkloadProtocolInput = {
    createdAtMs: 1000, planRevision: 28, planContentHash: hash('plan'), rubricRevision: 11, rubricContentHash: hash('rubric'),
    sourceManifestHash: hash('source'), fixtureHash: hash('fixture'),
    workload: [{ journey: 'http', operationMix: 'pinned-fixture', concurrency: 4, timeoutMs: 3000, oracleRef: 'oracle:http' }],
    baselineEvidenceRefs: ['baseline:1', 'baseline:2', 'baseline:3'], comparisons: [], bootstrapReplicates: 10_000, seed: 4,
  };
  for (const stratum of PERF_WORKLOAD_POLICY.strata) for (const metric of ['p95', 'p99', 'throughput'] as const) {
    input.comparisons.push({ journey: 'http', stratum, metric, powerEvidenceRef: `power:${stratum}:${metric}`, blockLengths: { r1: 2, r2: 4, r3: 8 },
      blockEvidenceRefs: Object.fromEntries([1, 2, 3].map(n => [`r${n}`, `block:${n}:${stratum}:${metric}`])) });
    for (const n of [1, 2, 3]) proofs.set(`block:${n}:${stratum}:${metric}`, { kind: 'block-selection', hash: hash(`block:${n}:${stratum}:${metric}`),
      endedAtMs: 850, baselineHash: hash(`baseline:${n}`), independentRepeatId: `r${n}`, journey: 'http', stratum, metric,
      method: 'baseline-acf-noise-band-v1', blockLength: 2 ** n });
  }
  for (const n of [1, 2, 3]) {
    proofs.set(`independence:${n}`, { kind: 'independence', hash: hash(`independent:${n}`), independentRepeatId: `r${n}`, verified: true });
    proofs.set(`baseline:${n}`, { kind: 'baseline', hash: hash(`baseline:${n}`), endedAtMs: 800,
      sourceManifestHash: input.sourceManifestHash, fixtureHash: input.fixtureHash, independentRepeatId: `r${n}`,
      independenceEvidenceRef: `independence:${n}`, observations: PERF_WORKLOAD_POLICY.strata.map(stratum => ({ journey: 'http', stratum, completedPerArm: 10_000, allObservationsRetained: true })) });
  }
  const designHash = perfProtocolHash({ ...input, comparisons: input.comparisons.map(({ powerEvidenceRef: _ref, ...rest }) => rest) });
  proofs.set('power-computation', { kind: 'power-computation', hash: hash('power-computation'), endedAtMs: 900, protocolInputHash: designHash,
    result: { status: 'estimated', method: 'nested-paired-block-production-ci-fixed-monte-carlo-v1', assumption: 'conditional-on-preregistered-empirical-baseline-generator',
      simulations: 200, iterations: 10_000, seed: 4, familySize: 9, comparisonAlpha: (1 - 0.95) / 9,
      monteCarloFamilyAlpha: 0.05, scenarios: [{ id: 'fixture', jointPasses: 190, lowerPowerBound: 0.81 }], lowerPowerBound: 0.81 } });
  for (const comparison of input.comparisons) proofs.set(comparison.powerEvidenceRef, { kind: 'power', hash: hash(comparison.powerEvidenceRef),
    endedAtMs: 900, protocolInputHash: designHash, journey: comparison.journey, stratum: comparison.stratum, metric: comparison.metric,
    lowerPowerBound: 0.81, computationRef: 'power-computation', comparisonAlpha: (1 - 0.95) / 9, margin: comparison.metric === 'p95' ? 1.05 : comparison.metric === 'p99' ? 1.10 : 0.95 });
  const protocol = sealPerfWorkloadProtocol(input);
  proofs.set('registration', { kind: 'registration', hash: hash('registration'), protocolHash: protocol.hash, registeredAtMs: 1100 });
  // The real resolver adds a DB insertion timestamp without changing the hashed body.
  for (const proof of proofs.values()) proof.publishedAtMs = proof.kind === 'registration' ? 1100 : 950;
  const read = async (ref: string) => proofs.get(ref) ?? null;
  return { input, protocol, proofs, read };
}

describe('immutable D-012 workload preregistration', () => {
  it('hashes canonical JSON, preserving order-sensitive fixtures and refusing unmeasured numbers', () => {
    expect(perfProtocolHash({ a: 1, b: 2 })).toBe(perfProtocolHash({ b: 2, a: 1 }));
    expect(perfProtocolHash([1, 2])).not.toBe(perfProtocolHash([2, 1]));
    for (const value of [NaN, Infinity, { a: undefined }, new Date(), Array(2)]) expect(() => perfProtocolHash(value)).toThrow(TypeError);
  });

  it('seals an independent frozen snapshot; caller mutation cannot rewrite registered inputs', () => {
    const { input, protocol } = fixture();
    const before = protocol.hash;
    input.workload[0].timeoutMs++;
    expect(protocol.input.workload[0].timeoutMs).toBe(3000);
    expect(Object.isFrozen(protocol.input.workload[0])).toBe(true);
    expect(protocol.hash).toBe(before);
    expect(sealPerfWorkloadProtocol(input).hash).not.toBe(before);
    expect(Object.isFrozen(PERF_WORKLOAD_POLICY.soak.cycles)).toBe(true);
  });

  it('permits a trial only with all cold/warm/burst comparisons and read-back pretrial evidence', async () => {
    const { protocol, read } = fixture();
    expect(await verifyPerfWorkloadPrerequisites(protocol, 'registration', 1200, read)).toEqual({ status: 'ready-for-trial', reasons: [] });
  });

  it('rejects late/backdated publication, source changes and a forged policy', async () => {
    const f = fixture();
    expect((await verifyPerfWorkloadPrerequisites(f.protocol, 'registration', 1100, f.read)).reasons).toContain('missing-or-late-immutable-registration');
    const changed = structuredClone(f.protocol);
    changed.input.fixtureHash = hash('different');
    expect((await verifyPerfWorkloadPrerequisites(changed, 'registration', 1200, f.read)).reasons).toContain('protocol-or-policy-changed');
    changed.policyHash = hash('weaker-policy');
    expect((await verifyPerfWorkloadPrerequisites(changed, 'registration', 1200, f.read)).status).toBe('unknown');
  });

  it.each(['registration', 'baseline:1', 'power:cold:p95', 'power-computation', 'block:1:cold:p95', 'independence:1'])
    ('rejects %s with missing or late ledger publication despite early authored timestamps', async ref => {
      const f = fixture();
      const proof = f.proofs.get(ref)!;
      delete proof.publishedAtMs;
      expect((await verifyPerfWorkloadPrerequisites(f.protocol, 'registration', 1200, f.read)).status).toBe('unknown');
      proof.publishedAtMs = 1200;
      expect((await verifyPerfWorkloadPrerequisites(f.protocol, 'registration', 1200, f.read)).status).toBe('unknown');
    });

  it('does not mistake a caller scalar, missing record or failed evidence lookup for power', async () => {
    const f = fixture();
    const proof = f.proofs.get('power:cold:p95');
    if (proof?.kind !== 'power') throw new Error('fixture');
    delete proof.computationRef;
    expect((await verifyPerfWorkloadPrerequisites(f.protocol, 'registration', 1200, f.read)).reasons).toContain('missing-or-unreproducible-joint-power-computation');
    f.proofs.delete('power:cold:p95');
    expect((await verifyPerfWorkloadPrerequisites(f.protocol, 'registration', 1200, f.read)).reasons).toContain('missing-unmatched-or-underpowered-pretrial-proof');
    expect((await verifyPerfWorkloadPrerequisites(f.protocol, 'registration', 1200, async () => { throw new Error('unavailable'); })).status).toBe('unknown');
    expect((await verifyPerfWorkloadPrerequisites(f.protocol, 'registration', 1200, () => { throw new Error('synchronous failure'); })).status).toBe('unknown');
  });

  it('requires the exact joint result and alpha emitted by the production CI', async () => {
    const f = fixture();
    const proof = f.proofs.get('power:cold:p95');
    if (proof?.kind !== 'power') throw new Error('fixture');
    // A literal .05 has different binary rounding from the production 1-.95.
    expect((await verifyPerfWorkloadPrerequisites(f.protocol, 'registration', 1200, f.read)).status).toBe('ready-for-trial');
    proof.comparisonAlpha = 0.05 / 9;
    expect((await verifyPerfWorkloadPrerequisites(f.protocol, 'registration', 1200, f.read)).reasons).toContain('missing-unmatched-or-underpowered-pretrial-proof');
    proof.comparisonAlpha = (1 - 0.95) / 9;
    proof.lowerPowerBound = 0.82;
    expect((await verifyPerfWorkloadPrerequisites(f.protocol, 'registration', 1200, f.read)).status).toBe('unknown');
  });

  it.each(['underpowered', 'wrong-family', 'wrong-margin', 'posttrial', 'wrong-design'] as const)('keeps %s power unknown', async mutation => {
    const f = fixture();
    const proof = f.proofs.get('power:cold:p95');
    if (proof?.kind !== 'power') throw new Error('fixture');
    if (mutation === 'underpowered') proof.lowerPowerBound = 0.79;
    if (mutation === 'wrong-family') proof.comparisonAlpha = 0.05;
    if (mutation === 'wrong-margin') proof.margin = 1.06;
    if (mutation === 'posttrial') proof.endedAtMs = 1200;
    if (mutation === 'wrong-design') proof.protocolInputHash = hash('other');
    expect((await verifyPerfWorkloadPrerequisites(f.protocol, 'registration', 1200, f.read)).reasons).toContain('missing-unmatched-or-underpowered-pretrial-proof');
  });

  it.each(['missing', 'duplicated', 'under-count', 'deleted-error', 'changed-fixture', 'no-independence', 'late'] as const)
    ('rejects %s baseline evidence', async mutation => {
      const f = fixture();
      const baseline = f.proofs.get('baseline:1');
      if (baseline?.kind !== 'baseline') throw new Error('fixture');
      if (mutation === 'missing') f.proofs.delete('baseline:1');
      if (mutation === 'duplicated') baseline.independentRepeatId = 'r2';
      if (mutation === 'under-count') baseline.observations[0].completedPerArm = 9999;
      if (mutation === 'deleted-error') baseline.observations[0].allObservationsRetained = false;
      if (mutation === 'changed-fixture') baseline.fixtureHash = hash('other');
      if (mutation === 'no-independence') f.proofs.delete('independence:1');
      if (mutation === 'late') baseline.endedAtMs = 1000;
      expect((await verifyPerfWorkloadPrerequisites(f.protocol, 'registration', 1200, f.read)).status).toBe('unknown');
    });

  it('requires the full family and repeat block lengths selected before the candidate', async () => {
    const f = fixture();
    f.input.comparisons.pop();
    delete f.input.comparisons[0].blockLengths.r2;
    const protocol = sealPerfWorkloadProtocol(f.input);
    const result = await verifyPerfWorkloadPrerequisites(protocol, 'registration', 1200, f.read);
    expect(result.reasons).toContain('incomplete-comparison-family');
    expect(result.reasons).toContain('missing-or-invalid-baseline-block-length');
  });

  it('requires actual matched baseline ACF evidence, even when a caller supplied plausible block lengths', async () => {
    const f = fixture();
    const proof = f.proofs.get('block:1:cold:p95');
    if (proof?.kind !== 'block-selection') throw new Error('fixture');
    proof.baselineHash = hash('other-baseline');
    expect((await verifyPerfWorkloadPrerequisites(f.protocol, 'registration', 1200, f.read)).reasons).toContain('missing-or-unmatched-baseline-autocorrelation-proof');
  });
});

describe('conservative censored workload observations', () => {
  it('retains a timeout at the greater of elapsed time and timeout bound', () => {
    for (const elapsedMs of [null, 5, 5000]) expect(normalizePerfWorkloadObservation({ outcome: 'timeout', elapsedMs, timeoutMs: 3000, censored: true }))
      .toEqual({ status: 'measured', latencyMs: Math.max(elapsedMs ?? 0, 3000), failed: true });
  });
  it('keeps fast errors and disconnects as failures; unknown latency is bounded, never dropped', () => {
    expect(normalizePerfWorkloadObservation({ outcome: 'error', elapsedMs: 5, timeoutMs: 3000, censored: false }))
      .toEqual({ status: 'measured', latencyMs: 5, failed: true });
    expect(normalizePerfWorkloadObservation({ outcome: 'disconnect', elapsedMs: null, timeoutMs: 3000, censored: true }))
      .toEqual({ status: 'measured', latencyMs: 3000, failed: true });
  });
  it('keeps incomplete successes and invalid timing unknown', () => {
    expect(normalizePerfWorkloadObservation({ outcome: 'success', elapsedMs: null, timeoutMs: 3000, censored: false }).status).toBe('unknown');
    expect(normalizePerfWorkloadObservation({ outcome: 'success', elapsedMs: 10, timeoutMs: 3000, censored: true }).status).toBe('unknown');
    expect(normalizePerfWorkloadObservation({ outcome: 'error', elapsedMs: NaN, timeoutMs: 3000, censored: false }).status).toBe('unknown');
  });
});
