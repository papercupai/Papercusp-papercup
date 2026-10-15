import { describe, expect, it } from 'vitest';
import type { CodeIntelAnswer } from './contracts';
import { buildReplayTrace, classifyReplayAnswer, evaluateReplayLadder, evaluateReplayTriplet,
  runReplay, scoreReplay, type ReplayClass, type ReplayMode, type ReplayOracle, type ReplaySample } from './lsp-fleet-replay';

const site = { path: 'fixture.ts', line1: 2, kind: 'function' };
const answer = (overrides: Partial<CodeIntelAnswer> = {}): CodeIntelAnswer => ({
  backend: 'lsp-adapter', intent: 'definition', query: 'fixture', sites: [site],
  error: null, latencyMs: 1, freshness: { health: 'healthy', staleVsDisk: false, indexedAt: null, indexedCommit: null },
  truncation: { truncated: false, totalAvailable: 1, continuation: null }, ...overrides,
});
const oracle: ReplayOracle = { sites: [site], sourceFingerprint: 'source', oracleFingerprint: 'frozen-independent-oracle' };
const oracles: Record<ReplayClass, ReplayOracle> = { definition: oracle, 'hot-references': oracle };
let trialSequence = 0;
function report(mode: ReplayMode, concurrency = 1000, cheapEnd = 10, hotEnd = 100) {
  const population = buildReplayTrace(concurrency, mode, `${mode}-${++trialSequence}-${cheapEnd}-${hotEnd}`);
  const samples: ReplaySample[] = population.map(request => ({ request, issuedAtMs: 0,
    settledAtMs: request.queryClass === 'definition' ? cheapEnd : hotEnd, answer: answer(), transportError: null }));
  return scoreReplay(concurrency, mode, population, samples, oracles);
}
function triplet(concurrency = 1000, cheapEnd = 10, hotEnd = 100) {
  return { trialId: `trial-${++trialSequence}`, definition: report('definition', concurrency), references: report('hot-references', concurrency),
    mixed: report('mixed', concurrency, cheapEnd, hotEnd), qualification: { qualified: true, fingerprint: 'source+binary+config+oracle', reasons: [] } };
}

describe('P012 fixed-count oracle replay', () => {
  it('freezes 1000 actor IDs, the exact 2:1 population and matched solo class counts', () => {
    const mixed = buildReplayTrace(1000, 'mixed', 'run');
    expect(mixed).toEqual(buildReplayTrace(1000, 'mixed', 'run'));
    expect(new Set(mixed.map(request => request.id)).size).toBe(3000);
    expect(new Set(mixed.map(request => request.actorId)).size).toBe(1000);
    expect(mixed.filter(request => request.queryClass === 'definition')).toHaveLength(2000);
    expect(mixed.filter(request => request.queryClass === 'hot-references')).toHaveLength(1000);
    expect(buildReplayTrace(1000, 'definition', 'solo')).toHaveLength(2000);
    expect(buildReplayTrace(1000, 'hot-references', 'solo')).toHaveLength(1000);
    for (const queryClass of ['definition', 'hot-references'] as const) {
      const actors = (rows: ReturnType<typeof buildReplayTrace>) => [...new Set(rows.filter(request => request.queryClass === queryClass).map(request => request.actorId.split('/').at(-1)))];
      expect(actors(mixed)).toEqual(actors(buildReplayTrace(1000, queryClass, 'solo')));
    }
  });
  it('retains rejected requests and continues the frozen sequence without shortening the tail', async () => {
    let clock = 0;
    const result = await runReplay({ concurrency: 3, mode: 'mixed', runId: 'rejected', oracles,
      now: () => ++clock, execute: async request => {
        if (request.queryClass === 'hot-references') throw new Error('deadline');
        return answer();
      } });
    expect(result.complete).toBe(true);
    expect(result.samples).toHaveLength(9);
    expect(result.failures).toHaveLength(3);
    expect(result.classes['hot-references']).toMatchObject({ issued: 3, settled: 3, usefulCorrect: 0 });
  });
  it('distinguishes certified false empties and stale replies from honest refusals', () => {
    expect(classifyReplayAnswer(answer({ sites: [] }), oracle)).toMatchObject({ certifiedFalseEmpty: true, usefulCorrect: false });
    expect(classifyReplayAnswer(answer({ sites: [], error: 'unprovisioned' }), oracle)).toMatchObject({ certifiedFalseEmpty: false, usefulCorrect: false });
    expect(classifyReplayAnswer(answer({ freshness: { ...answer().freshness, staleVsDisk: true } }), oracle))
      .toMatchObject({ certifiedStale: true, usefulCorrect: false });
    expect(classifyReplayAnswer(answer({ freshness: { ...answer().freshness, staleVsDisk: null } }), oracle).usefulCorrect).toBe(false);
    expect(classifyReplayAnswer(answer(), { ...oracle, sites: [{ ...site, line1: 3 }], staleSites: [site] }).certifiedStale).toBe(true);
  });
  it('rejects incorrect, duplicate and silently partial sites; verifies facade truncation against the independent total', () => {
    expect(classifyReplayAnswer(answer({ sites: [{ ...site, line1: 3 }] }), oracle).usefulCorrect).toBe(false);
    expect(classifyReplayAnswer(answer({ sites: [site, site] }), oracle).usefulCorrect).toBe(false);
    const larger = { ...oracle, sites: [site, { ...site, line1: 3 }] };
    expect(classifyReplayAnswer(answer(), larger).usefulCorrect).toBe(false);
    expect(classifyReplayAnswer(answer({ truncation: { truncated: true, totalAvailable: 2, continuation: null } }), larger).usefulCorrect).toBe(false);
    expect(classifyReplayAnswer(answer({ truncation: { truncated: true, totalAvailable: 1, continuation: null } }), larger).usefulCorrect).toBe(false);
  });
  it('invalidates omitted, duplicated, unissued or altered terminal IDs', () => {
    const original = report('mixed', 3);
    const score = (samples: ReplaySample[]) => scoreReplay(3, 'mixed', original.population, samples, oracles);
    expect(score(original.samples.slice(1)).complete).toBe(false);
    expect(score([...original.samples, original.samples[0]]).accountingErrors).toContain(`duplicate-terminal:${original.samples[0].request.id}`);
    expect(score([{ ...original.samples[0], request: { ...original.samples[0].request, actorId: 'forged' } }, ...original.samples.slice(1)]).complete).toBe(false);
    expect(score([...original.samples, { ...original.samples[0], request: { ...original.samples[0].request, id: 'unissued' } }]).complete).toBe(false);
  });
  it('uses each class full settlement interval so a long hot tail cannot distort cheap throughput', () => {
    const result = report('mixed');
    expect(result.classes.definition).toMatchObject({ elapsedMs: 10, usefulPerSec: 200000, p95Ms: 10 });
    expect(result.classes['hot-references']).toMatchObject({ elapsedMs: 100, usefulPerSec: 10000, p95Ms: 100 });
    expect(evaluateReplayTriplet(triplet())).toMatchObject({ qualified: true, cheapRateFactor: 1, hotRateFactor: 1, cheapLatencyFactor: 1, violations: [] });
  });
  it('protects both classes and refuses unqualified or nonoverlapping concurrent trials', () => {
    expect(evaluateReplayTriplet(triplet(1000, 25, 250)).violations).toEqual(['cheap-rate', 'hot-rate', 'cheap-tail']);
    const t = triplet();
    expect(evaluateReplayTriplet({ ...t, mixed: { ...t.mixed, classesOverlap: false } }).unknown).toContain('no-class-overlap');
    expect(evaluateReplayTriplet({ ...t, qualification: { qualified: false, fingerprint: '', reasons: ['binary-changed'] } }).qualified).toBe(false);
    expect(evaluateReplayTriplet({ ...t, mixed: { ...t.mixed, sourceFingerprint: 'other' } }).unknown).toContain('unmatched-triplet');
    expect(evaluateReplayTriplet({ ...t, mixed: { ...t.mixed, failures: [{ id: 'sacrificed-hot', reasons: ['refused'] }] } }).broken).toContain('incorrect-expected-success');
  });
  it('requires three triplets through 1000 and separates controls, unknown, degraded and broken', () => {
    const levels = [1, 8, 1000];
    const trials = levels.flatMap(level => Array.from({ length: 3 }, () => triplet(level)));
    expect(evaluateReplayLadder(trials, levels).rating).toBe('healthy');
    expect(evaluateReplayLadder(trials.slice(1), levels).rating).toBe('unknown');
    expect(evaluateReplayLadder([...trials.slice(0, 8), trials[7]], levels).unknown).toContain('reused-trial');
    expect(evaluateReplayLadder(trials, [1, 8]).unknown).toContain('missing-1000-level');
    const one = [...trials]; one[7] = triplet(1000, 25);
    expect(evaluateReplayLadder(one, levels).rating).toBe('degraded');
    one[8] = triplet(1000, 25);
    expect(evaluateReplayLadder(one, levels).rating).toBe('broken');
    const latencyOnly = [...trials];
    for (const index of [7, 8]) {
      const t = triplet(1000);
      latencyOnly[index] = { ...t, mixed: { ...t.mixed, classes: { ...t.mixed.classes,
        definition: { ...t.mixed.classes.definition, p95Ms: 25 } } } };
    }
    expect(evaluateReplayLadder(latencyOnly, levels).rating).toBe('degraded');
  });
});
