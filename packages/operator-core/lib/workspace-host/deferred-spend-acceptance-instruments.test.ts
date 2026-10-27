import { describe, expect, it, vi } from 'vitest';
import { DEFERRED_SPEND_INSTRUMENT_KEYS as keys, measureDeferredSpendAcceptance } from './deferred-spend-acceptance-instruments';
import { deferredSpendFingerprint, evaluateDeferredSpendEvidence } from './deferred-spend-acceptance-contract';
import { deferredSpendSourceHash, deferredSpendSourceManifest } from './deferred-spend-source-census';
import { getRegisteredInstrument } from '../rubric-instrument-registry';
import { resolveScorecardInstrumentSnapshots } from '../scorecards';
import { deferredSpendAcceptanceFixture as fixture } from './deferred-spend-acceptance-fixtures';

const at = '2026-10-25T20:00:02Z';

describe('DS-P010-DISTINCT-OBSERVATIONS', () => {
  it('baseline: real P007/P008/P009 source composition validates coverage and retains its derivation', async () => {
    const f = fixture(); f.identity.subject.kind = 'source';
    const result = await f.compose();
    expect(evaluateDeferredSpendEvidence({ expectedIdentity: f.identity, requiredSlices: ['retained-spend-population'] }, result.r007).verdict).toBe('pass');
    expect(evaluateDeferredSpendEvidence({ expectedIdentity: f.identity, requiredSlices: ['source-census', 'action-boundary'] }, result.r008).verdict).toBe('pass');
    expect(f.hostReads).toHaveBeenCalledTimes(1); expect(f.actionReads).toHaveBeenCalledTimes(1);
    expect(result.source).toMatchObject({ census: { identity: f.sourceIdentity },
      derivation: { state: 'same-source-identity', inputIdentity: f.sourceIdentity, outputIdentity: f.sourceIdentity,
        mapping: [{ from: 'source-r008', to: 'source-census', originalSliceHash: expect.any(String), evidenceRefs: ['source:complete'] }] } });
    expect((await f.run()).criteria.r007.verdict).toBe('unknown'); // Source-only proof cannot be a live measurement.
  });
  it('counterexample: an attributable forbidden source effect propagates through the validated derivation', async () => {
    const f = fixture();
    const source = f.inputs.source;
    const file = source.snapshot.files[1];
    file.text = "export function collect() { destroyHost('prohibited'); return 'consistent-read-only'; }";
    file.contentHash = deferredSpendSourceHash(file.text);
    source.snapshot.roots[0].members[0].contentHash = file.contentHash;
    source.snapshot.identity.censusSelectors.productionRoots[0].contentHash = deferredSpendFingerprint(source.snapshot.roots[0].members);
    source.snapshot.identity.sourceManifestHash = deferredSpendFingerprint(deferredSpendSourceManifest(source.snapshot.files));
    source.request.expectedIdentity = structuredClone(source.snapshot.identity);
    Object.assign(f.identity, structuredClone(source.snapshot.identity));
    const result = await f.compose();
    const evaluated = evaluateDeferredSpendEvidence({ expectedIdentity: f.identity,
      requiredSlices: ['source-census', 'action-boundary'] }, result.r008);
    expect(evaluated.verdict).toBe('fail');
    expect(evaluated.slices[0].violations[0].reason).toContain('src/collector.ts');
    expect(evaluated.slices[1].verdict).toBe('pass');
  });
  it('baseline: one durable live manifest retains separate R007 pass and unjoined R008 unknown', async () => {
    const f = fixture(); const result = await f.run();
    expect(result.criteria.r007.verdict, JSON.stringify(result)).toBe('pass'); expect(result.criteria.r008.verdict).toBe('unknown');
    expect(result.criteria.r008.reasons.join(';')).toContain('source-to-live join');
    expect(f.read).toHaveBeenCalledTimes(1); expect(f.persist).toHaveBeenCalledTimes(1);
    const [harness, path, bytes] = f.persist.mock.calls[0];
    const manifest = JSON.parse(bytes);
    expect(result.manifestRef).toBe('artifact:' + harness + ':' + path);
    expect(deferredSpendFingerprint(manifest)).toBe(result.manifestHash);
    expect(manifest.source.snapshot.identity.subject.kind).toBe('source');
    expect(manifest.source.census.identity.subject.kind).toBe('source');
    expect(manifest.source.derivation).toMatchObject({ state: 'unjoined', outputIdentity: null, mapping: [] });
    expect(manifest.inputs.r008.slices.map((slice: { id: string }) => slice.id)).toEqual(['action-boundary']);
  });
  it('counterexample: R007 pass never masks an attributable R008 violation with an unjoined source', async () => {
    const f = fixture(); f.records.operations.push(f.row('03-prohibited', 'original', 'provision'));
    const result = await f.run();
    expect(result.criteria.r007.verdict).toBe('pass'); expect(result.criteria.r008.verdict).toBe('fail');
    expect(result.criteria.r008.evidence?.slices[0].violations[0].member).toBe('operations:03-prohibited');
  });
  it('counterexample: R007 read failure cannot erase a measured R008 violation', async () => {
    const f = fixture(); f.records.operations.push(f.row('03-prohibited', 'original', 'provision'));
    f.inputs.population.dependencies.withSnapshot = async () => { throw new Error('unreadable'); };
    const result = await f.run();
    expect(result.criteria.r007.verdict).toBe('unknown'); expect(result.criteria.r008.verdict).toBe('fail');
  });
  it.each(['hostId', 'processId', 'buildId', 'runtimeGeneration'] as const)('counterexample: missing serving %s stays unknown', async field => {
    const f = fixture(); f.identity.observation.serving[field] = '';
    const result = await f.run(); expect(result.criteria.r007.verdict).toBe('unknown');
    expect(result.criteria.r008.verdict).toBe('unknown'); expect(f.persist).not.toHaveBeenCalled();
  });
  it.each(['source', 'foreign-workspace', 'foreign-interval'] as const)('counterexample: %s cannot become live proof', async defect => {
    const f = fixture();
    if (defect === 'source') f.identity.subject.kind = 'source';
    if (defect === 'foreign-workspace') f.request.workspaceId = 'other';
    if (defect === 'foreign-interval') f.request.windowStart = '2026-10-25T18:00:00Z';
    const result = await f.run();
    expect(result.criteria.r007.verdict).toBe('unknown'); expect(result.criteria.r008.verdict).toBe('unknown');
    expect(f.hostReads).not.toHaveBeenCalled();
  });
  it.each(['identity', 'selectors', 'missing-control', 'missing-bytes'] as const)('counterexample: invalid source %s cannot pass through the derived slice', async defect => {
    const f = fixture(); f.identity.subject.kind = 'source';
    if (defect === 'identity') f.inputs.source.snapshot.identity.observation.id = 'other';
    if (defect === 'selectors') f.inputs.source.request.expectedIdentity.censusSelectors.base.treeHash = 'd'.repeat(64);
    if (defect === 'missing-control') f.inputs.source.request.controls = [];
    if (defect === 'missing-bytes') f.inputs.source.snapshot.files = [];
    const result = await f.compose();
    expect(evaluateDeferredSpendEvidence({ expectedIdentity: f.identity, requiredSlices: ['source-census', 'action-boundary'] }, result.r008).verdict).toBe('unknown');
  });
  it.each(['reader', 'persistence'] as const)('counterexample: %s failure cannot preserve success', async defect => {
    const f = fixture(); (defect === 'reader' ? f.read : f.persist).mockRejectedValueOnce(new Error('unreadable'));
    const result = await f.run();
    expect(result.criteria.r007.verdict).toBe('unknown'); expect(result.criteria.r008.verdict).toBe('unknown');
    expect(result.manifestRef).toBeUndefined();
  });
  it('counterexample: absent runtime adapter is explicit unknown without an invented identity', async () => {
    const result = await measureDeferredSpendAcceptance(fixture().request);
    expect(result.criteria.r007.verdict).toBe('unknown'); expect(result.identity).toBeUndefined();
  });
  it('baseline: registry resolves both keys and scorecards measures their shared collector once', async () => {
    const f = fixture(); for (const key of Object.values(keys)) expect(getRegisteredInstrument(key)?.evaluator).toBe('platform');
    const measured = vi.fn(f.run);
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric: f.rubric, subject: f.subject }, {
      deferredSpend: measured, now: () => Date.parse(at),
    });
    expect(measured).toHaveBeenCalledTimes(1); expect(f.hostReads).toHaveBeenCalledTimes(1); expect(f.actionReads).toHaveBeenCalledTimes(1);
    expect(snapshots?.[keys.r007]).toMatchObject({ verdict: 'pass', provenance: 'platform-computed', evidenceRef: expect.stringContaining('artifact:papercusp:') });
    expect(snapshots?.[keys.r008]).toMatchObject({ verdict: 'unknown', provenance: 'platform-computed' });
  });
  it('counterexample: forged caller passes are replaced by two distinct measured outcomes', async () => {
    const f = fixture(); f.records.operations.push(f.row('03-prohibited', 'original', 'provision'));
    const supplied = Object.fromEntries(Object.values(keys).map(key => [key, { verdict: 'pass' as const, provenance: 'platform-computed' as const, measuredAt: at }]));
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric: f.rubric, subject: f.subject, supplied }, { deferredSpend: f.run, now: () => Date.parse(at) });
    expect(snapshots?.[keys.r007]?.verdict).toBe('pass'); expect(snapshots?.[keys.r008]?.verdict).toBe('fail');
  });
  it.each(['resolver-error', 'missing-identity', 'wrong-plan', 'wrong-harness'] as const)('counterexample: %s cannot preserve caller success', async defect => {
    const f = fixture();
    if (defect === 'missing-identity') f.identity.observation.serving.buildId = '';
    if (defect === 'wrong-plan') f.subject.ref = 'other';
    if (defect === 'wrong-harness') f.rubric.subjectHarnessSlug = 'other';
    const measured = defect === 'resolver-error' ? vi.fn(async () => { throw new Error('unavailable'); }) : vi.fn(f.run);
    const supplied = Object.fromEntries(Object.values(keys).map(key => [key, { verdict: 'pass' as const, provenance: 'platform-computed' as const, measuredAt: at }]));
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric: f.rubric, subject: f.subject, supplied }, { deferredSpend: measured, now: () => Date.parse(at) });
    for (const key of Object.values(keys)) expect(snapshots?.[key]?.verdict).toBe('unknown');
  });
  it('baseline: the composed path performs only retained reads, with no provider request', async () => {
    const f = fixture(); const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider trap'));
    try { expect((await f.run()).criteria.r007.verdict).toBe('pass'); expect(provider).not.toHaveBeenCalled(); }
    finally { provider.mockRestore(); }
  });
});
