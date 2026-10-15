import { describe, expect, it } from 'vitest';
import type { SymbolSite } from './contracts';
import {
  aggregateArm,
  applyAdjudication,
  decideBackend,
  FAIR_DECISION_BARS,
  hashKeys,
  hashPreregistration,
  poolCandidates,
  preregister,
  scoreCase,
  shuffledArmOrder,
  type AnswerKey,
  type ArmAggregate,
  type ArmAnswer,
  type ArmCapabilities,
  type CaseScore,
  type FairCase,
  type FairIntent,
  type RepScores,
} from './fair-comparison';
import { nativeEvaluationProtocol, nativeLanguageControls } from './fair-comparison-corpus';

const site = (path: string, line1: number): SymbolSite => ({ path, line1, kind: null });
const kase = (id: string, intent: FairIntent = 'callers'): FairCase => ({ id, intent, subject: 'foo', tags: [], source: 'authored' });
const key = (
  caseId: string,
  sites: string[],
  aliases: Record<string, string> = {},
  rejected: string[] = [],
  neutral: string[] = [],
): AnswerKey => ({
  caseId,
  sites,
  aliases,
  rejected,
  neutral,
});
const caps = (armId: string, intents: FairIntent[] = ['callers', 'callees', 'impact'], licence: ArmCapabilities['licence'] = 'permissive'): ArmCapabilities => ({
  armId,
  version: 'test',
  intents,
  licence,
});
const answer = (caseId: string, sites: SymbolSite[], status: ArmAnswer['status'] = 'answered'): ArmAnswer => ({
  caseId,
  status,
  sites,
  latencyMs: 10,
});

describe('scoreCase — outcome classes', () => {
  const k = key('c1', ['a.ts:1', 'b.ts:2']);

  it('scores an intent the arm did not declare as undeclared, never as wrong', () => {
    const s = scoreCase(kase('c1', 'text-search'), caps('x'), k, answer('c1', []));
    expect(s.outcome).toBe('undeclared');
    expect(s.f1).toBeNull();
    expect(s.confidentFalseEmpty).toBe(false);
  });

  it.each(['declined', 'crashed', 'timed-out', 'stale-index'] as const)('keeps %s separate from a wrong answer', (status) => {
    const s = scoreCase(kase('c1'), caps('x'), k, answer('c1', [], status));
    expect(s.outcome).toBe(status);
    expect(s.f1).toBeNull();
    expect(s.confidentFalseEmpty).toBe(false);
  });

  it('grades exact, partial and wrong answers by precision / recall / F1', () => {
    const exact = scoreCase(kase('c1'), caps('x'), k, answer('c1', [site('b.ts', 2), site('a.ts', 1)]));
    expect(exact).toMatchObject({ outcome: 'correct', precision: 1, recall: 1, f1: 1 });

    const partial = scoreCase(kase('c1'), caps('x'), key('c1', ['a.ts:1', 'b.ts:2'], {}, ['z.ts:9']), answer('c1', [site('a.ts', 1), site('z.ts', 9)]));
    expect(partial.outcome).toBe('partial');
    expect(partial.precision).toBe(0.5);
    expect(partial.recall).toBe(0.5);
    expect(partial.f1).toBeCloseTo(0.5);

    const wrong = scoreCase(kase('c1'), caps('x'), key('c1', ['a.ts:1'], {}, ['z.ts:9']), answer('c1', [site('z.ts', 9)]));
    expect(wrong).toMatchObject({ outcome: 'wrong', precision: 0, recall: 0, f1: 0, confidentFalseEmpty: false });
  });

  it('flags an EMPTY answer to a non-empty key as confident-false-empty', () => {
    const s = scoreCase(kase('c1'), caps('x'), k, answer('c1', []));
    expect(s).toMatchObject({ outcome: 'wrong', confidentFalseEmpty: true, absence: false });
  });

  it('scores an absence case: empty is correct, any site is an absence false positive', () => {
    const absent = key('c2', [], {}, ['q.ts:3']);
    const ok = scoreCase(kase('c2'), caps('x'), absent, answer('c2', []));
    expect(ok).toMatchObject({ outcome: 'correct', absence: true, absenceFalsePositive: false, confidentFalseEmpty: false });
    const bad = scoreCase(kase('c2'), caps('x'), absent, answer('c2', [site('q.ts', 3)]));
    expect(bad).toMatchObject({ outcome: 'wrong', absence: true, absenceFalsePositive: true });
  });

  it('maps an aliased site to its canonical site and collapses duplicates', () => {
    const aliased = key('c1', ['a.ts:10'], { 'a.ts:9': 'a.ts:10' });
    const s = scoreCase(kase('c1'), caps('x'), aliased, answer('c1', [site('a.ts', 9), site('a.ts', 10)]));
    expect(s).toMatchObject({ outcome: 'correct', precision: 1, recall: 1, unadjudicated: 0 });
  });

  it('neither credits nor penalises a NEUTRAL site (the subject declaration in a references answer)', () => {
    const k2 = key('c1', ['a.ts:1'], {}, [], ['decl.ts:5']);
    const withDecl = scoreCase(kase('c1'), caps('x'), k2, answer('c1', [site('a.ts', 1), site('decl.ts', 5)]));
    const withoutDecl = scoreCase(kase('c1'), caps('x'), k2, answer('c1', [site('a.ts', 1)]));
    expect(withDecl).toMatchObject({ outcome: 'correct', precision: 1, recall: 1, unadjudicated: 0 });
    expect(withoutDecl).toMatchObject({ outcome: 'correct', precision: 1, recall: 1 });
    // A neutral site alone is still an EMPTY answer to a non-empty key.
    const onlyDecl = scoreCase(kase('c1'), caps('x'), k2, answer('c1', [site('decl.ts', 5)]));
    expect(onlyDecl).toMatchObject({ outcome: 'wrong', confidentFalseEmpty: true });
    // On an absence case, returning only the declaration is NOT an absence false positive.
    const absent = key('c3', [], {}, [], ['decl.ts:5']);
    expect(scoreCase(kase('c3'), caps('x'), absent, answer('c3', [site('decl.ts', 5)]))).toMatchObject({
      outcome: 'correct',
      absenceFalsePositive: false,
    });
  });

  it('records a neutral verdict and refuses to flip it later', () => {
    const k2 = applyAdjudication(key('c1', ['a.ts:1']), [{ site: 'decl.ts:5', verdict: 'neutral', note: 'subject declaration' }]);
    expect(k2.neutral).toEqual(['decl.ts:5']);
    expect(poolCandidates(k2, [{ sites: [site('decl.ts', 5)] }])).toEqual([]);
    expect(() => applyAdjudication(k2, [{ site: 'decl.ts:5', verdict: 'valid', note: 'flip' }])).toThrow(/already neutral/);
    expect(hashKeys([k2])).not.toBe(hashKeys([key('c1', ['a.ts:1'])]));
  });

  it('counts returned sites the key has not ruled on as unadjudicated (a provisional score)', () => {
    const s = scoreCase(kase('c1'), caps('x'), k, answer('c1', [site('a.ts', 1), site('new.ts', 4)]));
    expect(s.unadjudicated).toBe(1);
    expect(s.outcome).toBe('partial');
  });
});

describe('pooled adjudication', () => {
  it('pools only sites no ruling covers, across every arm', () => {
    const k = key('c1', ['a.ts:1'], { 'a.ts:0': 'a.ts:1' }, ['r.ts:5']);
    const pool = poolCandidates(k, [
      { sites: [site('a.ts', 1), site('n.ts', 2)] },
      { sites: [site('a.ts', 0), site('r.ts', 5), site('n.ts', 2), site('m.ts', 7)] },
    ]);
    expect(pool).toEqual(['m.ts:7', 'n.ts:2']);
  });

  it('RESCORES every arm when a site only one engine found is ruled valid', () => {
    const before = key('c1', ['a.ts:1']);
    const armA = answer('c1', [site('a.ts', 1)]);
    const armB = answer('c1', [site('a.ts', 1), site('hidden.ts', 3)]);
    expect(scoreCase(kase('c1'), caps('A'), before, armA).outcome).toBe('correct');
    expect(scoreCase(kase('c1'), caps('B'), before, armB).outcome).toBe('partial');

    const pool = poolCandidates(before, [armA, armB]);
    expect(pool).toEqual(['hidden.ts:3']);
    const after = applyAdjudication(before, [{ site: 'hidden.ts:3', verdict: 'valid', note: 'dynamic call via registry' }]);

    const a = scoreCase(kase('c1'), caps('A'), after, armA);
    const b = scoreCase(kase('c1'), caps('B'), after, armB);
    expect(a).toMatchObject({ outcome: 'partial', recall: 0.5 });
    expect(b).toMatchObject({ outcome: 'correct', recall: 1, precision: 1, unadjudicated: 0 });
  });

  it('never mutates the input key', () => {
    const before = key('c1', ['a.ts:1']);
    applyAdjudication(before, [{ site: 'b.ts:2', verdict: 'valid', note: 'n' }]);
    expect(before.sites).toEqual(['a.ts:1']);
  });

  it('refuses a verdict that contradicts an earlier ruling', () => {
    const k = key('c1', ['a.ts:1'], {}, ['r.ts:5']);
    expect(() => applyAdjudication(k, [{ site: 'r.ts:5', verdict: 'valid', note: 'flip' }])).toThrow(/conflict/);
    expect(() => applyAdjudication(k, [{ site: 'a.ts:1', verdict: 'invalid', note: 'flip' }])).toThrow(/conflict/);
  });

  it('refuses an alias with no target, or one pointing at a non-valid site', () => {
    const k = key('c1', ['a.ts:1']);
    expect(() => applyAdjudication(k, [{ site: 'a.ts:0', verdict: 'alias', note: 'n' }])).toThrow(/aliasOf/);
    expect(() => applyAdjudication(k, [{ site: 'a.ts:0', verdict: 'alias', aliasOf: 'zz.ts:1', note: 'n' }])).toThrow(/not a valid site/);
  });

  it('hashes keys independently of order, and changes when a ruling changes', () => {
    const k1 = key('c1', ['b.ts:2', 'a.ts:1']);
    const k2 = key('c2', []);
    expect(hashKeys([k1, k2])).toBe(hashKeys([k2, key('c1', ['a.ts:1', 'b.ts:2'])]));
    expect(hashKeys([k1, k2])).not.toBe(hashKeys([key('c1', ['a.ts:1']), k2]));
  });
});

describe('repetitions', () => {
  it('produces a reproducible permutation per seed', () => {
    const arms = ['rg', 'lsp', 'ntp', 'gnx', 'cbm', 'cg', 'trace', 'cgc'];
    const a = shuffledArmOrder(arms, 42);
    expect(shuffledArmOrder(arms, 42)).toEqual(a);
    expect([...a].sort()).toEqual([...arms].sort());
    const orders = new Set([1, 2, 3, 4, 5].map((seed) => shuffledArmOrder(arms, seed).join(',')));
    expect(orders.size).toBeGreaterThan(1);
    expect(arms).toEqual(['rg', 'lsp', 'ntp', 'gnx', 'cbm', 'cg', 'trace', 'cgc']);
  });

  const cases = [kase('k1', 'callers'), kase('k2', 'callees'), kase('k3', 'impact'), kase('k4', 'text-search'), kase('k5', 'callers')];
  const keys: Record<string, AnswerKey> = {
    k1: key('k1', ['a.ts:1']),
    k2: key('k2', ['b.ts:2']),
    k3: key('k3', ['c.ts:3']),
    k4: key('k4', ['d.ts:4']),
    k5: key('k5', []),
  };
  const run = (c: ArmCapabilities, rep: number, answers: Record<string, ArmAnswer>): RepScores => ({
    rep,
    scores: cases.map((k) => scoreCase(k, c, keys[k.id]!, answers[k.id]!)),
  });

  it('aggregates failure rate, instability, coverage and the two "no callers" rates', () => {
    const c = caps('arm');
    const good = {
      k1: answer('k1', [site('a.ts', 1)]),
      k2: answer('k2', [site('b.ts', 2)]),
      k3: answer('k3', [site('c.ts', 3)]),
      k4: answer('k4', []),
      k5: answer('k5', []),
    };
    const flaky = {
      ...good,
      k2: answer('k2', [], 'crashed'),
      k3: answer('k3', []),
      k5: answer('k5', [site('x.ts', 1)]),
    };
    const agg = aggregateArm(c, ['callers', 'callees', 'impact', 'text-search'], [run(c, 0, good), run(c, 1, flaky), run(c, 2, good)]);
    expect(agg.reps).toBe(3);
    expect(agg.coverage).toBe(0.75);
    expect(agg.declaresGraphIntents).toBe(true);
    expect(agg.outcomeCounts.undeclared).toBe(3);
    expect(agg.outcomeCounts.crashed).toBe(1);
    // 12 declared attempts (4 declared cases x 3 reps), one crash
    expect(agg.failureRate).toBeCloseTo(1 / 12);
    expect(agg.unstableCases).toEqual(['k2', 'k3', 'k5']);
    // rep 1: answered non-absence = k1,k3 -> k3 empty -> CFE 1/2; reps 0/2 -> 0
    expect(agg.confidentFalseEmptyRate).toEqual({ median: 0, min: 0, max: 0.5 });
    expect(agg.absenceFalsePositiveRate).toEqual({ median: 0, min: 0, max: 1 });
    // rep 1 effective F1 over declared (k1=1, k2=0 crash, k3=0, k5=0) = 0.25
    expect(agg.effectiveF1.min).toBeCloseTo(0.25);
    expect(agg.effectiveF1.median).toBe(1);
  });
});

const agg = (armId: string, licence: ArmCapabilities['licence'], f1: number, over: Partial<ArmAggregate> = {}): ArmAggregate => {
  const s = (v: number | null) => ({ median: v, min: v, max: v });
  return {
    armId,
    licence,
    reps: 3,
    coverage: 1,
    declaresGraphIntents: true,
    outcomeCounts: { correct: 0, partial: 0, wrong: 0, declined: 0, crashed: 0, 'timed-out': 0, 'stale-index': 0, undeclared: 0 },
    failureRate: 0,
    unadjudicated: 0,
    unstableCases: [],
    effectiveF1: s(f1),
    graphEffectiveF1: s(f1),
    answeredF1: s(f1),
    precision: s(f1),
    recall: s(f1),
    confidentFalseEmptyRate: s(0),
    graphConfidentFalseEmptyRate: s(0),
    absenceFalsePositiveRate: s(0),
    latencyMs: s(5),
    ...over,
  };
};

describe('decideBackend — the preregistered rule', () => {
  const prereg = { reps: 3 };

  it('keeps GitNexus when it is clearly best', () => {
    const d = decideBackend([agg('gitnexus', 'noncommercial', 0.9), agg('cbm', 'permissive', 0.7), agg('ntp', 'first-party', 0.6)], prereg);
    expect(d).toMatchObject({ kind: 'keep', arm: 'gitnexus' });
  });

  it('switches to a permissive arm that ties GitNexus within the margin', () => {
    const d = decideBackend([agg('gitnexus', 'noncommercial', 0.9), agg('cbm', 'permissive', 0.87)], prereg);
    expect(d).toMatchObject({ kind: 'switch', arm: 'cbm' });
  });

  it('drops third-party graphs when the first-party arm ties the best', () => {
    const d = decideBackend([agg('gitnexus', 'noncommercial', 0.9), agg('cbm', 'permissive', 0.89), agg('ntp', 'first-party', 0.86)], prereg);
    expect(d).toMatchObject({ kind: 'drop-third-party', arm: 'ntp' });
  });

  it('does not let a tie on F1 excuse a worse confident-false-empty rate', () => {
    const d = decideBackend(
      [
        agg('gitnexus', 'noncommercial', 0.9),
        agg('cbm', 'permissive', 0.9, { graphConfidentFalseEmptyRate: { median: 0.2, min: 0.2, max: 0.2 } }),
      ],
      prereg,
    );
    expect(d).toMatchObject({ kind: 'keep', arm: 'gitnexus' });
  });

  it('excludes arms over the failure bar or without every graph intent', () => {
    const d = decideBackend(
      [
        agg('gitnexus', 'noncommercial', 0.8),
        agg('cbm', 'permissive', 0.95, { failureRate: FAIR_DECISION_BARS.maxFailureRate + 0.01 }),
        agg('ntp', 'first-party', 0.95, { declaresGraphIntents: false }),
      ],
      prereg,
    );
    expect(d).toMatchObject({ kind: 'keep', arm: 'gitnexus' });
  });

  it('is inconclusive with unadjudicated sites, short repetitions, or no eligible arm', () => {
    expect(decideBackend([agg('a', 'permissive', 0.9, { unadjudicated: 2 })], prereg).kind).toBe('inconclusive');
    expect(decideBackend([agg('a', 'permissive', 0.9, { reps: 2 })], prereg).kind).toBe('inconclusive');
    expect(decideBackend([agg('a', 'permissive', 0.9, { declaresGraphIntents: false })], prereg).kind).toBe('inconclusive');
  });
});

describe('preregister', () => {
  const cases = [kase('k1'), kase('k2')];
  const keys = [key('k1', ['a.ts:1']), key('k2', [])];

  it('refuses a corpus case with no answer key', () => {
    expect(() => preregister({ cases, keys: [keys[0]!], arms: [caps('a')], reps: 3, seed: 1 })).toThrow(/no answer key for k2/);
  });

  it('is stable under arm/intent ordering and moves when a declaration moves', () => {
    const a = preregister({ cases, keys, arms: [caps('a', ['callers', 'callees']), caps('b')], reps: 3, seed: 1 });
    const b = preregister({ cases: [...cases].reverse(), keys, arms: [caps('b'), caps('a', ['callees', 'callers'])], reps: 3, seed: 1 });
    expect(b.hash).toBe(a.hash);
    const c = preregister({ cases, keys, arms: [caps('a', ['callers']), caps('b')], reps: 3, seed: 1 });
    expect(c.hash).not.toBe(a.hash);
    expect(a.keyHash).toBe(hashKeys(keys));
  });

  it.each([
    { subject: 'other' }, { intent: 'references' as const }, { anchorFile: 'different.ts' },
    { depth: 3 }, { tags: ['absence' as const] }, { language: 'python' },
    { configuration: 'unconfigured' as const }, { sourceState: 'deleted' as const },
    { sourceFingerprint: 'changed-content' }, { taskRef: 'WI-fixture-task' },
  ])('pins changed case semantics despite unchanged ids: %j', change => {
    const input = { cases, keys, arms: [caps('a')], reps: 3, seed: 1 };
    const original = preregister(input);
    expect(preregister({ ...input, cases: [{ ...cases[0]!, ...change }, cases[1]!] }).hash).not.toBe(original.hash);
  });

  it('freezes resource ceilings before results and isolates caller mutations', () => {
    const input = { cases, keys, arms: [caps('a')], reps: 3, seed: 1 };
    const original = preregister(input);
    const budgets = { ...original.budgets, warmQueryMsMax: original.budgets.warmQueryMsMax + 1 };
    const changed = preregister({ ...input, budgets });
    expect(changed.hash).not.toBe(original.hash);
    budgets.warmQueryMsMax += 1;
    expect(changed.budgets.warmQueryMsMax).toBe(original.budgets.warmQueryMsMax + 1);
    expect(Object.isFrozen(changed)).toBe(true);
    expect(Object.isFrozen(changed.budgets)).toBe(true);
    expect(() => preregister({ ...input, budgets: { ...budgets, rssMbMax: NaN } })).toThrow(/budgets/);
    expect(() => preregister({ ...input, budgets: {} as typeof budgets })).toThrow(/budgets/);
    expect(() => preregister({ ...input, cases: [cases[0]!, cases[0]!] })).toThrow(/duplicate case/);
  });
});

// Keep a compile-time witness that CaseScore carries the absence flag the rates depend on.
const _witness: Pick<CaseScore, 'absence'> = { absence: true };
void _witness;

describe('native evaluation preregistration', () => {
  const controls = nativeLanguageControls();
  const protocol = nativeEvaluationProtocol('a'.repeat(40), controls.files,
    ['javascript', 'typescript', 'rust', 'python', 'go'].map(language => ({ language, refs: [], unavailable: 'unit fixture has no real-task observations' })));
  const input = { cases: controls.cases, keys: controls.keys, arms: [caps('a')], reps: 3, seed: 20261009, protocol };

  it('freezes measurement methods, thresholds, source/config fixtures and unavailable real task coverage', () => {
    const mutable = structuredClone(protocol);
    const registered = preregister({ ...input, protocol: mutable });
    expect(hashPreregistration(JSON.parse(JSON.stringify(registered)))).toBe(registered.hash);
    (mutable.measurements[0] as { method: string }).method = 'parent RSS instead of cgroup';
    expect(registered.protocol!.measurements[0]!.method).not.toBe(mutable.measurements[0]!.method);
    expect(Object.isFrozen(registered.protocol!.measurements[0])).toBe(true);
    expect(preregister({ ...input, protocol: mutable }).hash).not.toBe(registered.hash);
    expect(hashPreregistration({ ...registered, protocol: { ...protocol,
      correctness: { ...protocol.correctness, maxConfidentFalseEmptyRate: 1 } } })).not.toBe(registered.hash);
  });

  it('rejects missing strata, measurements, configuration pins and invented real task coverage', () => {
    const without = (fragment: string) => controls.cases.filter(c => !c.id.includes(fragment));
    const reduced = (fragment: string) => { const cases = without(fragment); return { ...input, cases, keys: controls.keys.filter(k => cases.some(c => c.id === k.caseId)) }; };
    expect(() => preregister(reduced('python-definition-absence'))).toThrow(/positive\/absence/);
    expect(() => preregister(reduced('unconfigured'))).toThrow(/configuration\/freshness/);
    expect(() => preregister({ ...input, protocol: { ...protocol, measurements: protocol.measurements.slice(1) } })).toThrow(/measurement/);
    expect(() => preregister({ ...input, protocol: { ...protocol, fixtureHash: '' } })).toThrow(/protocol needs/);
    expect(() => preregister({ ...input, protocol: { ...protocol, realTaskCoverage: protocol.realTaskCoverage.map(c => ({ ...c, refs: ['invented-real-task'] })) } })).toThrow(/ungrounded/);
  });
});
