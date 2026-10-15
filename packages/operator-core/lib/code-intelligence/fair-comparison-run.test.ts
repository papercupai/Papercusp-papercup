import { describe, expect, it } from 'vitest';
import type { SymbolSite } from './contracts';
import { preregister, type AnswerKey, type ArmCapabilities, type FairCase } from './fair-comparison';
import { guardedArm, type FairArm } from './fair-comparison-arms';
import { preregMismatch, runArm, scoreRuns, type FairArmFactory, type ResourceStage } from './fair-comparison-run';
import { nativeEvaluationProtocol, nativeLanguageControls } from './fair-comparison-corpus';

const cases: FairCase[] = [
  { id: 'c-callers', intent: 'callers', subject: 'f', tags: [], source: 'authored' },
  { id: 'c-def', intent: 'definition', subject: 'f', tags: [], source: 'authored' },
];
const keys: AnswerKey[] = [
  { caseId: 'c-callers', sites: ['a.ts:3'], aliases: {}, rejected: [], neutral: ['a.ts:1'] },
  { caseId: 'c-def', sites: ['a.ts:1'], aliases: {}, rejected: [], neutral: [] },
];
const capsA: ArmCapabilities = { armId: 'arm-a', version: '1', intents: ['callers', 'definition'], licence: 'first-party' };
const capsB: ArmCapabilities = { armId: 'arm-b', version: '2', intents: ['callers'], licence: 'permissive' };
const prereg = preregister({ cases, keys, arms: [capsA, capsB], reps: 3, seed: 7 });
const site = (k: string): SymbolSite => ({ path: k.split(':')[0]!, line1: Number(k.split(':')[1]), kind: null });

function fakeArm(caps: ArmCapabilities, answers: Record<string, string[]>, opts: { indexOk?: boolean; asked?: string[] } = {}): FairArm & { closed: () => boolean } {
  let closed = false;
  const arm = guardedArm({
    capabilities: caps,
    unavailable: null,
    index: async () => ({ wallMs: 1, peakRssKb: null, ok: opts.indexOk ?? true, error: opts.indexOk === false ? 'boom' : null, loadAvg1: null }),
    ask: async (k) => {
      opts.asked?.push(k.id);
      return { sites: (answers[k.id] ?? []).map(site), error: null };
    },
    close: async () => {
      closed = true;
    },
  });
  return Object.assign(arm, { closed: () => closed });
}

describe('preregistration is enforced before an arm runs', () => {
  it('refuses an unregistered arm, a changed version or intent set, and a changed corpus', () => {
    expect(preregMismatch({ ...capsA, armId: 'other' }, cases, prereg)).toMatch(/not in preregistration/);
    expect(preregMismatch({ ...capsA, version: '9' }, cases, prereg)).toMatch(/version/);
    expect(preregMismatch({ ...capsA, intents: ['callers'] }, cases, prereg)).toMatch(/intents differ/);
    expect(preregMismatch(capsA, cases.slice(0, 1), prereg)).toMatch(/corpus differs/);
    expect(preregMismatch(capsA, [...cases].reverse(), prereg)).toBeNull();
  });
  it('runArm throws on a mismatch instead of producing answers', async () => {
    await expect(runArm(fakeArm({ ...capsA, version: '9' }, {}), cases, prereg)).rejects.toThrow(/run refused/);
  });
  it('rejects changed same-id corpus and budget before indexing or querying', async () => {
    const asked: string[] = [];
    const arm = fakeArm(capsA, {}, { asked });
    const changed = [{ ...cases[0]!, subject: 'different', language: 'go' }, cases[1]!];
    await expect(runArm(arm, changed, prereg)).rejects.toThrow(/corpus semantics/);
    await expect(runArm(arm, cases, { ...prereg, budgets: { ...prereg.budgets, rssMbMax: 999 } }))
      .rejects.toThrow(/budget differs/);
    expect(asked).toEqual([]);
    expect(arm.closed()).toBe(false);
  });
});

describe('runArm', () => {
  it('indexes once, answers every case once per rep in a seeded order, and closes the arm', async () => {
    const asked: string[] = [];
    const arm = fakeArm(capsA, { 'c-callers': ['a.ts:3'] }, { asked });
    const run = await runArm(arm, cases, prereg, () => 't');
    expect(run.reps.map((r) => r.rep)).toEqual([1, 2, 3]);
    expect(run.reps.every((r) => r.answers.length === cases.length)).toBe(true);
    expect(asked).toHaveLength(6);
    expect(run.preregHash).toBe(prereg.hash);
    expect(arm.closed()).toBe(true);
    const again: string[] = [];
    await runArm(fakeArm(capsA, {}, { asked: again }), cases, prereg);
    expect(again).toEqual(asked);
  });
  it('a failed index yields no reps (reported, never scored as wrong)', async () => {
    const run = await runArm(fakeArm(capsA, {}, { indexOk: false }), cases, prereg);
    expect(run.index?.ok).toBe(false);
    expect(run.reps).toEqual([]);
  });
});

describe('fresh protocol repetitions', () => {
  const controls = nativeLanguageControls();
  const pinnedCases = controls.cases.filter(kase => kase.language === 'typescript');
  const pinnedKeys = controls.keys.filter(key => pinnedCases.some(kase => kase.id === key.caseId));
  const protocol = { ...nativeEvaluationProtocol('b'.repeat(40), controls.files, [
    { language: 'typescript', refs: [], unavailable: 'authored controls only; real tasks unmeasured' },
  ]), languages: ['typescript'] };
  const registered = preregister({ cases: pinnedCases, keys: pinnedKeys, arms: [capsA], reps: 3, seed: 7, protocol });
  function factory(events: string[], opts: { reused?: boolean; missing?: boolean; failedRep?: number; throwingRep?: number } = {}): FairArmFactory {
    return { capabilities: capsA, unavailable: null, async create(rep) {
      events.push(`create:${rep}`);
      const id = opts.reused ? 1 : rep;
      const arm = fakeArm(capsA, { 'c-callers': ['a.ts:3'], 'c-def': ['a.ts:1'] });
      return { identity: { taskId: `task:${id}`, cgroupPath: `/task-${id}`, treeRoot: `/tree-${id}`,
        home: `/home-${id}`, sourceCommit: protocol.sourceCommit, runtimeVersion: 'test-v1' },
      arm: { ...arm, index: async () => {
        events.push(`index:${rep}`);
        if (opts.throwingRep === rep) throw new Error('setup crashed');
        return { wallMs: 1, peakRssKb: 999999, ok: opts.failedRep !== rep, error: opts.failedRep === rep ? 'setup failed' : null, loadAvg1: null };
      }, query: async kase => { events.push(`query:${rep}:${kase.id}`); return arm.query(kase); },
      close: async () => { events.push(`close:${rep}`); await arm.close?.(); } },
      sampleResources: async (stage: ResourceStage) => {
        events.push(`sample:${rep}:${stage}`);
        return { sampledAt: '2026-10-14T18:00:00Z', memoryCurrentBytes: opts.missing ? null : rep * 1048576,
          memoryPeakBytes: opts.missing ? null : (rep + 1) * 1048576, peakChildProcesses: opts.missing ? null : 0,
          indexFiles: opts.missing ? null : [], unknown: [] };
      } };
    } };
  }
  it('refuses a protocol on a reused legacy arm before indexing; unavailable controls remain unscored', async () => {
    const arm = fakeArm(capsA, {});
    await expect(runArm(arm, pinnedCases, registered)).rejects.toThrow(/fresh repetition factory/);
    expect(arm.closed()).toBe(false);
    expect((await runArm({ ...arm, unavailable: 'not installed' }, pinnedCases, registered)).reps).toEqual([]);
  });
  it('creates, indexes and closes three independent tasks, preserving cold, warm-up and warm answers in order', async () => {
    const events: string[] = [];
    const run = await runArm(factory(events), pinnedCases, registered);
    expect(run.measurementMode).toBe('fresh-repetitions');
    expect(run.reps.map(rep => rep.identity?.taskId)).toEqual(['task:1', 'task:2', 'task:3']);
    for (const rep of run.reps) {
      expect(rep.coldAnswers).toHaveLength(2);
      expect(rep.warmupAnswers).toHaveLength(pinnedCases.length);
      expect(rep.answers).toHaveLength(pinnedCases.length);
      expect(rep.resources?.ready.memoryCurrentBytes).toBe(rep.rep * 1048576);
      const sequence = events.filter(event => event.split(':')[1] === String(rep.rep));
      expect(sequence[0]).toBe(`create:${rep.rep}`);
      expect(sequence[1]).toBe(`index:${rep.rep}`);
      expect(sequence[2]).toBe(`sample:${rep.rep}:ready`);
      const warmIndex = sequence.indexOf(`sample:${rep.rep}:warm`);
      const finalIndex = sequence.indexOf(`sample:${rep.rep}:final`);
      expect(sequence.slice(3, warmIndex)).toHaveLength(2 + pinnedCases.length);
      expect(sequence.slice(warmIndex + 1, finalIndex)).toHaveLength(pinnedCases.length);
      expect(sequence.at(-2)).toBe(`sample:${rep.rep}:final`);
      expect(sequence.at(-1)).toBe(`close:${rep.rep}`);
    }
    expect(scoreRuns([run], pinnedCases, pinnedKeys, {}, registered).decision.reason).not.toMatch(/measurements unqualified/);
  });
  it('rejects a reused task/tree/home before its second index, but still closes it', async () => {
    const events: string[] = [];
    await expect(runArm(factory(events, { reused: true }), pinnedCases, registered)).rejects.toThrow(/reused or omitted taskId/);
    expect(events).not.toContain('index:2');
    expect(events.at(-1)).toBe('close:2');
  });
  it('keeps failed setup attempts and continues fresh repetitions without inventing answers', async () => {
    const events: string[] = [];
    const run = await runArm(factory(events, { failedRep: 2, throwingRep: 3 }), pinnedCases, registered);
    expect(run.reps.map(rep => rep.outcome)).toEqual(['completed', 'setup-failed', 'setup-failed']);
    expect(run.reps.slice(1).every(rep => rep.answers.length === 0 && rep.coldAnswers?.length === 0)).toBe(true);
    expect(run.reps[2]?.index?.error).toContain('setup crashed');
    expect(events.filter(event => event.startsWith('close:'))).toEqual(['close:1', 'close:2', 'close:3']);
    expect(scoreRuns([run], pinnedCases, pinnedKeys, {}, registered).decision.reason).toContain('setup-incomplete');
  });
  it('does not substitute a parent RSS reading for missing task memory or an unread index census', async () => {
    const run = await runArm(factory([], { missing: true }), pinnedCases, registered);
    expect(run.reps[0]?.index?.peakRssKb).toBe(999999);
    expect(run.reps[0]?.resources?.final.memoryPeakBytes).toBeNull();
    expect(run.reps[0]?.resources?.ready.indexFiles).toBeNull();
    const decision = scoreRuns([run], pinnedCases, pinnedKeys, {}, registered).decision;
    expect(decision.kind).toBe('inconclusive');
    expect(decision.reason).toContain('resources-unmeasured');
  });
  it('rejects saved legacy warmth as protocol measurement proof', async () => {
    const run = await runArm(factory([]), pinnedCases, registered);
    const legacy = { ...run, measurementMode: undefined };
    expect(scoreRuns([legacy], pinnedCases, pinnedKeys, {}, registered).decision.reason).toContain('legacy-measurements');
  });
  it('retains factory startup errors as failed attempts, including the raw error', async () => {
    const base = factory([]);
    const run = await runArm({ ...base, create: async rep => {
      if (rep === 2) throw new Error('task creation refused');
      return base.create(rep);
    } }, pinnedCases, registered);
    expect(run.reps[1]?.setupError).toContain('task creation refused');
    expect(run.reps[1]?.answers).toEqual([]);
    expect(run.reps[2]?.outcome).toBe('completed');
    expect(scoreRuns([run], pinnedCases, pinnedKeys, {}, registered).decision.reason).toContain('rep2:setup-incomplete');
  });
  it('keeps unreadable and over-budget task measurements inconclusive after JSON round-trip', async () => {
    const run = await runArm(factory([]), pinnedCases, registered);
    const saved = JSON.parse(JSON.stringify(run)) as typeof run;
    const rep = saved.reps[0]!;
    const ready = rep.resources!.ready;
    const changed = { ...saved, reps: [{ ...rep, resources: { ...rep.resources!, ready: {
      ...ready, indexFiles: [{ path: 'cache/index', bytes: (registered.budgets.indexDiskMbMax + 1) * 1048576 }],
    } } }, ...saved.reps.slice(1)] };
    expect(scoreRuns([changed], pinnedCases, pinnedKeys, {}, registered).decision.reason).toContain('ready-index-budget');
    const unreadable = { ...saved, reps: [{ ...rep, resources: { ...rep.resources!, ready: {
      ...ready, unknown: ['memory.current unreadable'],
    } } }, ...saved.reps.slice(1)] };
    expect(scoreRuns([unreadable], pinnedCases, pinnedKeys, {}, registered).decision.reason).toContain('ready-resources-unmeasured');
  });
  it.each([undefined, null, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses an unmeasured or invalid descendant-process peak (%s)', async peakChildProcesses => {
      const run = await runArm(factory([]), pinnedCases, registered);
      const rep = run.reps[0]!;
      const changed = { ...run, reps: [{ ...rep, resources: { ...rep.resources!, final: {
        ...rep.resources!.final, peakChildProcesses,
      } } }, ...run.reps.slice(1)] };
      const decision = scoreRuns([changed], pinnedCases, pinnedKeys, {}, registered).decision;
      expect(decision.kind).toBe('inconclusive');
      expect(decision.reason).toContain('final-child-processes-unmeasured');
    },
  );
  it('enforces the frozen child-process ceiling after saving and reloading a run', async () => {
    const run = await runArm(factory([]), pinnedCases, registered);
    const saved = JSON.parse(JSON.stringify(run)) as typeof run;
    const rep = saved.reps[0]!;
    const withPeak = (peakChildProcesses: number) => ({ ...saved, reps: [{ ...rep, resources: {
      ...rep.resources!, final: { ...rep.resources!.final, peakChildProcesses },
    } }, ...saved.reps.slice(1)] });
    expect(scoreRuns([withPeak(registered.budgets.childProcMax)], pinnedCases, pinnedKeys, {}, registered)
      .decision.reason).not.toContain('child-process-budget');
    const overBudget = scoreRuns([withPeak(registered.budgets.childProcMax + 1)], pinnedCases, pinnedKeys, {}, registered).decision;
    expect(overBudget.kind).toBe('inconclusive');
    expect(overBudget.reason).toContain('final-child-process-budget');
    expect(registered.budgets.childProcMax).toBe(1);
  });
});

describe('scoreRuns', () => {
  it('refuses reinterpreting saved answers with a changed question, seed key or budget', async () => {
    const run = await runArm(fakeArm(capsA, {}), cases, prereg);
    expect(() => scoreRuns([run], [{ ...cases[0]!, subject: 'changed' }, cases[1]!], keys, {}, prereg))
      .toThrow(/corpus semantics changed/);
    expect(() => scoreRuns([run], cases, [{ ...keys[0]!, sites: [] }, keys[1]!], {}, prereg))
      .toThrow(/seed answer key changed/);
    expect(() => scoreRuns([run], cases, keys, {}, { ...prereg, budgets: { ...prereg.budgets, rssMbMax: 999 } }))
      .toThrow(/changed preregistration content or budget/);
  });
  it('lists every unadjudicated site with the arms that named it, and stays inconclusive', async () => {
    const a = await runArm(fakeArm(capsA, { 'c-callers': ['a.ts:3', 'b.ts:9'], 'c-def': ['a.ts:1'] }), cases, prereg);
    const b = await runArm(fakeArm(capsB, { 'c-callers': ['b.ts:9', 'c.ts:2'] }), cases, prereg);
    const scored = scoreRuns([a, b], cases, keys, {}, prereg);
    expect(scored.pending).toEqual([{ caseId: 'c-callers', sites: ['b.ts:9', 'c.ts:2'], namedBy: { 'b.ts:9': ['arm-a', 'arm-b'], 'c.ts:2': ['arm-b'] } }]);
    expect(scored.decision.kind).toBe('inconclusive');
  });
  it('applies recorded verdicts so the pooled key credits the arm that found a new valid site', async () => {
    const a = await runArm(fakeArm(capsA, { 'c-callers': ['a.ts:3', 'b.ts:9'], 'c-def': ['a.ts:1'] }), cases, prereg);
    const b = await runArm(fakeArm(capsB, { 'c-callers': ['a.ts:3'] }), cases, prereg);
    const scored = scoreRuns([a, b], cases, keys, { 'c-callers': [{ site: 'b.ts:9', verdict: 'valid', note: 'a real caller' }] }, prereg);
    expect(scored.pending).toEqual([]);
    expect(scored.keys.find((k) => k.caseId === 'c-callers')?.sites).toEqual(['a.ts:3', 'b.ts:9']);
    const f1 = (id: string) => scored.aggregates.find((x) => x.armId === id);
    expect(f1('arm-a')).toBeDefined();
    expect(f1('arm-b')).toBeDefined();
  });
  it('refuses runs made under another preregistration', async () => {
    const other = preregister({ cases, keys, arms: [capsA, capsB], reps: 3, seed: 8 });
    const a = await runArm(fakeArm(capsA, {}), cases, other);
    expect(() => scoreRuns([a], cases, keys, {}, prereg)).toThrow(/another preregistration/);
  });
  it('refuses two runs of the same arm, so a superseded run is never scored beside its rerun', async () => {
    const failed = await runArm(fakeArm(capsA, { 'c-def': ['a.ts:1'] }), cases, prereg);
    const rerun = await runArm(fakeArm(capsA, { 'c-def': ['a.ts:1'], 'c-callers': ['a.ts:3'] }), cases, prereg);
    const b = await runArm(fakeArm(capsB, {}), cases, prereg);
    expect(() => scoreRuns([failed, b, rerun], cases, keys, {}, prereg)).toThrow(/more than one run for arm\(s\) arm-a/);
    // Control: the same runs with the superseded one removed score normally.
    expect(scoreRuns([b, rerun], cases, keys, {}, prereg).aggregates.filter((x) => x.armId === 'arm-a')).toHaveLength(1);
  });
});
