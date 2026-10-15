import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createDreamCapabilityFixture } from '../../test/dream-capability-fixture';
import { DREAM_BENCHMARK_LABELS } from '../../test/dream-benchmark-labels';
import independentReview from '../../test/dream-benchmark-review.fixture.json';
import { capabilityHash } from './capability-contracts';
import { dreamCapabilityRun, type DreamRunAssessment } from './dream-run-provenance';
import type { DreamRun } from './dream-run-store';
import type { DreamBenchmarkJudgment } from './dream-evaluation';
import { collectDreamQualitySignals, DREAM_QUALITY_POLICY, reportDreamQuality, sampleRejectedDreams } from './dream-quality';

const scope = { workspaceId: 'dream-quality-test', potSlug: 'papercusp', since: '2026-09-07T00:00:00.000Z', until: '2026-09-08T00:00:00.000Z' };
describe('Dream quality calibration and watchdog evidence', () => {
  let fixture: Awaited<ReturnType<typeof createDreamCapabilityFixture>>;
  beforeAll(async () => { fixture = await createDreamCapabilityFixture(scope.workspaceId, scope.potSlug); });
  afterAll(async () => { if (fixture) await rm(fixture.root, { recursive: true, force: true }); });
  function run(id: string, family = id): DreamRun {
    const value = structuredClone(fixture.run);
    Object.assign(value, { runId: id, cycleId: `cycle-${id}`, status: 'accepted', startedAt: '2026-09-07T12:00:00.000Z', updatedAt: '2026-09-07T13:00:00.000Z', completedAt: '2026-09-07T13:00:00.000Z' });
    const assessment: DreamRunAssessment = {
      schemaVersion: 'dream-run-assessment-v1', id: `assessment-${id}`, assessor: 'human:fixture-review',
      recordedAt: '2026-09-07T13:00:00.000Z', candidateHash: String(value.review!.candidateHash), evidenceHash: String(value.review!.evidenceHash),
      familyId: family, novelty: 'supported', usefulness: 'supported', maintainability: 'unknown',
      evidenceRefs: ['test:source-grounded-calibration'], experimentBatteryIds: [],
    };
    value.outcome!.assessments = [assessment];
    return value;
  }
  const codes = (r: ReturnType<typeof reportDreamQuality>) => r.faults.map(f => f.code);
  function benchmark() {
    return {
      labels: DREAM_BENCHMARK_LABELS,
      judgments: [
        ...DREAM_BENCHMARK_LABELS.filter(l => l.split === 'calibration').map(l => ({ id: l.id, verdict: l.expected, evidence: l.evidence })),
        ...(independentReview.judgments as DreamBenchmarkJudgment[]),
      ],
      expectedSourceHash: independentReview.sourceFileSha256,
      observedSourceHash: capabilityHash(readFileSync(new URL('../../test/dream-benchmark-cases.ts', import.meta.url), 'utf8')),
    };
  }

  it('leaves a sound all-accept batch unflagged solely for its acceptance rate', () => {
    const report = reportDreamQuality(Array.from({ length: 20 }, (_, i) => run(`good-${i}`)), scope, { benchmark: benchmark() });
    expect(report.reviewPassRate).toEqual({ numerator: 20, denominator: 20, value: 1 });
    expect(report.faults).toEqual([]);
    expect(report.calibration?.heldOut.falseAccept).toMatchObject({ numerator: 0, denominator: 9, value: 0 });
    expect(report.calibration?.heldOut.falseReject).toMatchObject({ numerator: 0, denominator: 3, value: 0 });
    expect(report.calibration?.heldOut.unverified).toBe(2);
  });

  it('exposes a known negative accepted by the reviewer with the full negative denominator', () => {
    const b = benchmark();
    b.judgments = b.judgments.map(j => j.id === 'H02' ? { ...j, verdict: 'accept' } : j);
    const report = reportDreamQuality([], scope, { benchmark: b });
    expect(report.calibration?.heldOut.falseAccept).toMatchObject({ numerator: 1, denominator: 9, value: 1 / 9 });
    expect(codes(report)).toContain('calibration-false-accept');
  });

  it('exposes a known positive rejected by an overstrict reviewer with the positive denominator', () => {
    const b = benchmark();
    b.judgments = b.judgments.map(j => j.id === 'H01' ? { ...j, verdict: 'reject' } : j);
    const report = reportDreamQuality([], scope, { benchmark: b });
    expect(report.calibration?.heldOut.falseReject).toMatchObject({ numerator: 1, denominator: 3, value: 1 / 3 });
    expect(codes(report)).toContain('calibration-false-reject');
  });

  it('retains missing judgments and refuses corrupt or stale calibration fixtures', () => {
    const b = benchmark(); b.judgments = b.judgments.filter(j => j.id !== 'H01');
    const missing = reportDreamQuality([], scope, { benchmark: b });
    expect(missing.calibration?.heldOut.positiveUnresolved).toMatchObject({ numerator: 1, denominator: 3 });
    expect(codes(missing)).toContain('unresolved-calibration');
    expect(codes(reportDreamQuality([], scope, { benchmark: { ...b, observedSourceHash: '0'.repeat(64) } }))).toContain('stale-calibration');
    expect(codes(reportDreamQuality([], scope, { benchmark: { ...b, judgments: [...b.judgments, b.judgments[0]!] } }))).toContain('invalid-calibration');
  });

  it('flags missing/stale evidence and unfinished reviews without confusing them with rejection', () => {
    const stale = run('stale');
    stale.review = { ...stale.review, verdict: 'unverified', reason: 'source-changed-during-review', coverage: { ...(stale.review!.coverage as object), unknown: ['Source hash changed'] } };
    const missing = run('missing'); missing.review = null; missing.outcome!.assessments = [];
    const report = reportDreamQuality([stale, missing], scope);
    expect(codes(report)).toEqual(expect.arrayContaining(['missing-or-stale-evidence', 'unresolved-review']));
    expect(report.rejectedReview.population).toBe(0);
  });

  it('accepts a persisted review-preflight refusal without reporting invalid or unresolved review provenance', () => {
    const preflight = run('review-preflight');
    preflight.status = 'rejected';
    preflight.review = {
      schemaVersion: 'dream-capability-preflight-v1',
      verdict: 'unverified',
      reason: 'search-unavailable',
    };
    preflight.outcome = {
      verdict: 'unverified',
      generationSkipped: true,
      capabilityRun: dreamCapabilityRun(preflight),
    };

    const report = reportDreamQuality([preflight], scope);

    expect(report.coverage).toEqual({ complete: true, inspected: 1, valid: 1 });
    expect(codes(report)).toEqual([]);
    expect(report.reviewPassRate).toEqual({ numerator: 0, denominator: 0, value: null });
  });

  it('flags accounting faults and family concentration even when every review accepts', () => {
    const repeated = Array.from({ length: 6 }, (_, i) => run(`repeat-${i}`, 'same-family'));
    expect(codes(reportDreamQuality(repeated, scope))).toContain('family-concentration');
    const wrong = run('wrong'); wrong.costUsd = 0.9;
    expect(codes(reportDreamQuality([wrong], scope))).toContain('accounting-mismatch');
    const unknown = run('unknown'); const p = dreamCapabilityRun(unknown)!;
    p.calls[1] = { ...p.calls[1]!, status: 'unknown', usage: null, error: 'lost reply' };
    unknown.outcome!.capabilityRun = p; unknown.costUsd = 0.15;
    const unknownReport = reportDreamQuality([unknown], scope);
    expect(codes(unknownReport)).toContain('unknown-accounting');
    expect(unknownReport.faults.find(f => f.code === 'unknown-accounting')).toMatchObject({
      identifiedRunCount: 1,
      runIds: ['unknown'],
    });
    const tooMuch = run('over-cap'); tooMuch.costUsd = 6;
    expect(codes(reportDreamQuality([tooMuch], scope))).toContain('budget-breach');
  });

  it('does not flag a recorded pre-call model-price refusal as unknown accounting', () => {
    const skipped = run('unpriced-model');
    skipped.status = 'error';
    skipped.review = null;
    skipped.costUsd = 0;
    const provenance = dreamCapabilityRun(skipped)!;
    skipped.outcome = {
      verdict: 'unverified',
      generationSkipped: true,
      capabilityRun: { ...provenance, calls: [] },
    };

    const report = reportDreamQuality([skipped], scope);

    expect(report.coverage).toMatchObject({ inspected: 1, valid: 1 });
    expect(codes(report)).not.toContain('unknown-accounting');
  });

  it('keeps corrupt rows visible and excludes in-flight calls, old rows and replayed deliveries', () => {
    const good = run('good'), corrupt = run('corrupt'), pending = run('pending'), old = run('old');
    (corrupt.outcome!.assessments as DreamRunAssessment[])[0]!.candidateHash = '0'.repeat(64);
    pending.status = 'running'; pending.review = null;
    old.startedAt = '2026-09-06T23:59:59Z';
    const report = reportDreamQuality([good, good, corrupt, pending, old], scope);
    expect(report.coverage).toEqual({ complete: true, inspected: 2, valid: 1 });
    expect(codes(report)).toEqual(['invalid-provenance']);
    expect(report.reviewPassRate?.denominator).toBe(1);
    expect(reportDreamQuality([corrupt], scope).latestEvidenceAt).toBe(corrupt.updatedAt);
    expect(() => reportDreamQuality([{ ...good, workspaceId: 'foreign' }], scope)).toThrow('workspace');
  });

  it('samples rejected proposals across reasons deterministically, without spending or treating them as truth', () => {
    const rows = Array.from({ length: 12 }, (_, i) => { const r = run(`reject-${i}`); r.status = 'rejected'; r.review = { ...r.review, verdict: 'reject', reason: i < 6 ? 'novelty' : 'feasibility' }; return r; });
    const sample = sampleRejectedDreams(rows, 4);
    expect(sample.population).toBe(12);
    expect(sample.sample).toHaveLength(4);
    expect(sample.sample.filter(r => r.reason === 'novelty')).toHaveLength(2);
    expect(sampleRejectedDreams([...rows].reverse(), 4)).toEqual(sample);
    expect(sampleRejectedDreams(rows, 0).sample).toEqual([]);
  });

  it('uses the existing ledger and emits stable scoped evidence, not a fresh clock-based incident every tick', async () => {
    const bad = run('bad'); bad.costUsd = 0.8;
    const reader = vi.fn(async () => [bad]);
    const result = await collectDreamQualitySignals({} as Sql, scope.workspaceId, Date.parse(scope.until), reader);
    expect(reader).toHaveBeenCalledWith(expect.anything(), { workspaceId: scope.workspaceId, limit: 500 });
    expect(result.signals).toContainEqual(expect.objectContaining({ source: 'dream-quality', key: 'papercusp:accounting-mismatch', scope: 'harness:papercusp', latestAt: bad.updatedAt }));
    expect(JSON.parse(result.note)).toMatchObject({ complete: true, fetched: 1 });
    await expect(collectDreamQualitySignals({} as Sql, scope.workspaceId, Date.parse(scope.until), async () => { throw new Error('ledger down'); })).rejects.toThrow('ledger down');
  });

  it('labels a capped scan as incomplete and never turns absent calibration into a zero error rate', async () => {
    const rows = Array.from({ length: DREAM_QUALITY_POLICY.scanLimit }, (_, i) => run(`cap-${i}`));
    const result = await collectDreamQualitySignals({} as Sql, scope.workspaceId, Date.parse(scope.until), async () => rows);
    expect(JSON.parse(result.note).complete).toBe(false);
    const report = reportDreamQuality([], scope);
    expect(report.calibration).toBeNull();
    expect(report.reviewPassRate).toMatchObject({ numerator: 0, denominator: 0, value: null });
  });
});
