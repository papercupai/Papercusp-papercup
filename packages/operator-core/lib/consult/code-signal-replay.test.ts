import { describe, expect, it, vi } from 'vitest';
import { resolveQuestionCodeSubjects } from './code-subject-resolution';
import {
  REPLAY_BAR,
  REPLAY_SELECTOR,
  evaluateReplayBar,
  isReplayable,
  prefetchingResolver,
  replayCodeSignal,
  rescoreSnapshot,
  storedTop,
  type PersistedRouting,
  type ReplayCandidate,
  type ReplayDeps,
  type ReplaySnapshot,
} from './code-signal-replay';
import { DEFAULT_RECENCY_HALF_LIFE_DAYS, DEFAULT_WEIGHTS, freshnessOf, relevanceOf } from './relevance-router';

const W = DEFAULT_WEIGHTS;
const DAY = 86_400_000;
const FILE = 'packages/operator-core/lib/consult/relevance-router.ts';
// Midway between a 0.6-similarity candidate with no authorship and with full authorship.
const FLOOR = (relevanceOf({ similarity: 0.6, verification: 0, authorship: 0 }, W) + relevanceOf({ similarity: 0.6, verification: 0, authorship: 1 }, W)) / 2;
const SIM_FLOOR = 0.4;

type Spec = { ownerId: string; sim: number; auth?: number; ageDays: number; extra?: Partial<ReplayCandidate> };

/** Build a snapshot the way the router stores one: floors decide the qualified set, which fixes the freshness frame. */
function snapshot(specs: Spec[], over: Partial<ReplaySnapshot> = {}): ReplaySnapshot {
  const rows = specs.map((s) => {
    const signals = { similarity: s.sim, verification: 0, authorship: s.auth ?? 0 };
    const relevance = relevanceOf(signals, W);
    return { s, signals, relevance, qualified: s.sim >= SIM_FLOOR && relevance >= FLOOR };
  });
  const offsets = (rs: typeof rows) => rs.map((r) => -r.s.ageDays);
  const qualifiedOffsets = offsets(rows.filter((r) => r.qualified));
  const reference = Math.max(...(qualifiedOffsets.length ? qualifiedOffsets : offsets(rows)));
  return {
    relevanceFloor: FLOOR,
    simFloor: SIM_FLOOR,
    weights: W,
    recencyHalfLifeDays: DEFAULT_RECENCY_HALF_LIFE_DAYS,
    candidates: rows.map((r) => {
      const { freshness, relativeAgeDays } = freshnessOf(-r.s.ageDays * DAY, reference * DAY, DEFAULT_RECENCY_HALF_LIFE_DAYS);
      return { ownerId: r.s.ownerId, relevance: r.relevance, score: r.relevance * freshness, relativeAgeDays, signals: { ...r.signals, freshness }, ...r.s.extra };
    }),
    ...over,
  };
}

const editorFamiliarity = new Map([['editor', { edits: 2, reads: 0 }]]);

describe('rescoreSnapshot', () => {
  it('weights authorship enough that full code authorship can cross the floor (fixture precondition)', () => {
    expect(W.authorship).toBeGreaterThan(0.1 * W.similarity);
    expect(relevanceOf({ similarity: 0.65, verification: 0, authorship: 0 }, W)).toBeLessThan(FLOOR);
  });

  it('reproduces the stored ranking and qualification with no code signal (control)', () => {
    const snap = snapshot([
      { ownerId: 'expert', sim: 0.95, ageDays: 3 },
      { ownerId: 'editor', sim: 0.6, ageDays: 0 },
      { ownerId: 'bystander', sim: 0.65, ageDays: 1 },
    ]);
    const control = rescoreSnapshot(snap, null);
    expect(control.top).toBe(storedTop(snap));
    expect(control.top).toBe('expert');
    expect(control.qualified).toBe(1);
    for (const c of control.candidates) {
      const stored = snap.candidates.find((s) => s.ownerId === c.ownerId)!;
      expect(c.relevance).toBeCloseTo(stored.relevance!, 12);
      expect(c.score).toBeCloseTo(stored.score!, 12);
    }
  });

  it('lifts an editor of the named file over the floor, turning a no-qualified routing into a routed one', () => {
    const snap = snapshot([
      { ownerId: 'bystander', sim: 0.65, ageDays: 0 },
      { ownerId: 'editor', sim: 0.6, ageDays: 2 },
    ]);
    const control = rescoreSnapshot(snap, null);
    expect(control).toMatchObject({ top: null, qualified: 0, anyAuthorship: false });
    const treated = rescoreSnapshot(snap, editorFamiliarity);
    expect(treated).toMatchObject({ top: 'editor', qualified: 1, anyAuthorship: true });
    expect(treated.candidates.find((c) => c.ownerId === 'editor')!.authorship).toBe(1);
    expect(treated.candidates.find((c) => c.ownerId === 'bystander')!.authorship).toBe(0);
  });

  it('moves the freshness frame to the newly qualified candidate, as the live router would', () => {
    const snap = snapshot([
      { ownerId: 'bystander', sim: 0.65, ageDays: 0 },
      { ownerId: 'editor', sim: 0.6, ageDays: 5 },
    ]);
    const storedEditor = snap.candidates.find((c) => c.ownerId === 'editor')!;
    expect(storedEditor.signals!.freshness).toBeLessThan(1);
    const editor = rescoreSnapshot(snap, editorFamiliarity).candidates.find((c) => c.ownerId === 'editor')!;
    // The editor is now the newest QUALIFIED candidate, so its relative age is 0.
    expect(editor.score).toBeCloseTo(editor.relevance, 12);
  });

  it('never lets a candidate whose subject evidence was never measured newly qualify', () => {
    const specs: Spec[] = [{ ownerId: 'bystander', sim: 0.65, ageDays: 0 }, { ownerId: 'editor', sim: 0.6, ageDays: 2 }];
    const unmeasured = snapshot(specs, { subjectRefs: ['consult:get_feedback'] });
    expect(rescoreSnapshot(unmeasured, editorFamiliarity).qualified).toBe(0);
    const measured = snapshot(
      [specs[0]!, { ...specs[1]!, extra: { subjectEvidence: { status: 'supported' } } }],
      { subjectRefs: ['consult:get_feedback'] },
    );
    expect(rescoreSnapshot(measured, editorFamiliarity).top).toBe('editor');
  });

  it('keeps the stored path-substring authorship when it exceeds the code score', () => {
    const snap = snapshot([{ ownerId: 'pathy', sim: 0.9, auth: 0.5, ageDays: 0 }]);
    const treated = rescoreSnapshot(snap, new Map([['pathy', { edits: 0, reads: 1 }]]));
    expect(treated.candidates[0]!.authorship).toBe(0.5);
  });
});

describe('prefetchingResolver', () => {
  it('resolves each distinct identifier once in batches and isolates a failed batch', async () => {
    const resolve = vi.fn(async (ids: readonly string[]) => {
      if (ids.includes('brokenThing')) throw new Error('timeout');
      return new Map(ids.map((id) => [id, id === 'routeConsult' ? [FILE] : []]));
    });
    const cached = await prefetchingResolver(['does routeConsult work?', 'again routeConsult', 'is brokenThing ok?'], resolve, 1);
    expect(resolve).toHaveBeenCalledTimes(2);
    const ok = await resolveQuestionCodeSubjects('why does routeConsult drop people?', { resolveSymbol: cached });
    expect(ok).toMatchObject({ resolver: 'ok', files: [FILE] });
    const broken = await resolveQuestionCodeSubjects('is brokenThing ok?', { resolveSymbol: cached });
    expect(broken.resolver).toBe('unavailable');
  });
});

describe('replayCodeSignal', () => {
  it('reports before/after shares, top changes and no-qualified rates, measuring familiarity as of each routing', async () => {
    const routings: PersistedRouting[] = [
      {
        consultId: 'c-code', workspaceId: 'ws', question: 'why does routeConsult drop candidates?', createdAt: '2026-10-10T00:00:00.000Z',
        snapshot: snapshot([{ ownerId: 'bystander', sim: 0.65, ageDays: 0 }, { ownerId: 'editor', sim: 0.6, ageDays: 2 }]),
      },
      {
        consultId: 'c-prose', workspaceId: 'ws', question: 'how should a fleet leader pace wake-ups?', createdAt: '2026-10-11T00:00:00.000Z',
        snapshot: snapshot([{ ownerId: 'pathy', sim: 0.9, auth: 0.5, ageDays: 0 }]),
      },
      { consultId: 'c-empty', workspaceId: 'ws', question: 'anyone?', createdAt: '2026-10-12T00:00:00.000Z', snapshot: snapshot([]) },
    ];
    const measureFamiliarity = vi.fn<ReplayDeps['measureFamiliarity']>(async () => ({ byOwner: editorFamiliarity, edits: 'measured', reads: 'measured' }));
    const loadRoutings = vi.fn<ReplayDeps['loadRoutings']>(async () => routings);
    const report = await replayCodeSignal({ days: 30, until: new Date('2026-10-21T00:00:00Z') }, {
      loadRoutings,
      resolveSymbol: async (ids) => new Map(ids.map((id) => [id, id === 'routeConsult' ? [FILE] : []])),
      measureFamiliarity,
    });
    expect(loadRoutings).toHaveBeenCalledWith({ since: '2026-09-21T00:00:00.000Z', until: '2026-10-21T00:00:00.000Z' });
    expect(measureFamiliarity).toHaveBeenCalledTimes(1);
    expect(measureFamiliarity).toHaveBeenCalledWith({ workspaceId: 'ws', owners: ['bystander', 'editor'], files: [FILE], before: '2026-10-10T00:00:00.000Z' });
    expect(report).toMatchObject({
      routings: 3,
      codeRelated: 1,
      resolverUnavailable: 0,
      familiarityUnmeasured: 0,
      controlDrift: 0,
      anyCodeSignal: { before: { count: 1, of: 3 }, after: { count: 2, of: 3 } },
      anyCodeSignalCodeRelated: { before: { count: 0, of: 1 }, after: { count: 1, of: 1 } },
      topCandidateChanges: { count: 1, of: 3 },
      noQualified: { before: { count: 2, of: 3 }, after: { count: 1, of: 3 } },
      noQualifiedCodeRelated: { before: { count: 1, of: 1 }, after: { count: 0, of: 1 } },
    });
    expect(report.examples).toEqual([{ consultId: 'c-code', createdAt: '2026-10-10T00:00:00.000Z', files: [FILE], before: null, after: 'editor' }]);
    expect(report.unreplayable).toBe(0);
  });

  it('keeps an older-format snapshot at its stored outcome, never measures it, and counts it unreplayable', async () => {
    const legacy = snapshot([{ ownerId: 'bystander', sim: 0.65, ageDays: 0 }, { ownerId: 'editor', sim: 0.6, ageDays: 2 }]);
    expect(isReplayable(legacy)).toBe(true);
    legacy.candidates[0]!.relevance = 0.99; // stored relevance no longer recomputes from its stored signals
    expect(isReplayable(legacy)).toBe(false);
    const measureFamiliarity = vi.fn<ReplayDeps['measureFamiliarity']>(async () => ({ byOwner: editorFamiliarity, edits: 'measured', reads: 'measured' }));
    const report = await replayCodeSignal({ days: 30, until: new Date('2026-10-21T00:00:00Z') }, {
      loadRoutings: async () => [{ consultId: 'c-legacy', workspaceId: 'ws', question: 'why does routeConsult drop candidates?', createdAt: '2026-10-10T00:00:00.000Z', snapshot: legacy }],
      resolveSymbol: async (ids) => new Map(ids.map((id) => [id, [FILE]])),
      measureFamiliarity,
    });
    expect(measureFamiliarity).not.toHaveBeenCalled();
    expect(report).toMatchObject({ unreplayable: 1, controlDrift: 0, codeRelated: 1, topCandidateChanges: { count: 0 }, examples: [] });
    // Before == after == the stored outcome: the stored relevance 0.99 qualifies the bystander.
    expect(report.noQualified).toEqual({ before: { count: 0, of: 1, share: 0 }, after: { count: 0, of: 1, share: 0 } });
  });

  it('measures efficacy on the paired replayable code-related cohort and reports legacy routings only as attrition', async () => {
    const legacy = snapshot([{ ownerId: 'bystander', sim: 0.65, auth: 0.5, ageDays: 0 }]);
    legacy.candidates[0]!.relevance = 0.99; // older format: does not recompute
    const routings: PersistedRouting[] = [
      { consultId: 'c-code', workspaceId: 'ws', question: 'why does routeConsult drop candidates?', createdAt: '2026-10-10T00:00:00.000Z',
        snapshot: snapshot([{ ownerId: 'bystander', sim: 0.65, ageDays: 0 }, { ownerId: 'editor', sim: 0.6, ageDays: 2 }]) },
      { consultId: 'c-legacy', workspaceId: 'ws', question: 'and routeConsult again?', createdAt: '2026-10-11T00:00:00.000Z', snapshot: legacy },
      { consultId: 'c-prose', workspaceId: 'ws', question: 'how should a fleet leader pace wake-ups?', createdAt: '2026-10-12T00:00:00.000Z',
        snapshot: snapshot([{ ownerId: 'pathy', sim: 0.9, auth: 0.5, ageDays: 0 }]) },
    ];
    const report = await replayCodeSignal({ days: 30, until: new Date('2026-10-21T00:00:00Z'), buildSha: 'abc1234' }, {
      loadRoutings: async () => routings,
      resolveSymbol: async (ids) => new Map(ids.map((id) => [id, id === 'routeConsult' ? [FILE] : []])),
      measureFamiliarity: async () => ({ byOwner: editorFamiliarity, edits: 'measured', reads: 'measured' }),
    });
    expect(report.selector).toBe(REPLAY_SELECTOR);
    expect(report.buildSha).toBe('abc1234');
    expect(report.attrition).toEqual({ routings: 3, replayable: 2, unreplayable: 1, codeRelated: 2, unreplayableCodeRelated: 1 });
    // The legacy routing's stored authorship would count as a control signal if it entered the cohort; it must not.
    expect(report.cohort).toEqual({
      pairedCodeRelated: 1,
      codeSignal: { control: { count: 0, of: 1, share: 0 }, treated: { count: 1, of: 1, share: 1 } },
      topCandidateChanges: { count: 1, of: 1, share: 1 },
      noQualified: { control: { count: 1, of: 1, share: 1 }, treated: { count: 0, of: 1, share: 0 } },
      resolverUnavailable: { count: 0, of: 2, share: 0 },
      familiarityUnmeasured: { count: 0, of: 1, share: 0 },
    });
    // The whole-population share still mixes in the legacy row: 1 of 2 code-related before, not 0.
    expect(report.anyCodeSignalCodeRelated.before).toEqual({ count: 1, of: 2, share: 0.5 });
    // One paired routing is below the 30-routing minimum, so the bar is not met despite the rise.
    expect(report.decision).toEqual({ pass: false, failures: ['paired cohort 1 < 30'] });
  });
});

describe('evaluateReplayBar', () => {
  const s = (count: number, of: number) => ({ count, of, share: of > 0 ? count / of : 0 });
  const passing = {
    controlDrift: 0,
    cohort: {
      pairedCodeRelated: 40,
      codeSignal: { control: s(4, 40), treated: s(9, 40) },
      topCandidateChanges: s(2, 40),
      noQualified: { control: s(10, 40), treated: s(10, 40) },
      resolverUnavailable: s(1, 60),
      familiarityUnmeasured: s(1, 40),
    },
  };

  it('passes when every R-6 condition holds, with no-qualified equal to its control', () => {
    expect(REPLAY_BAR).toEqual({ minPairedCohort: 30, maxUnavailableShare: 0.05 });
    expect(evaluateReplayBar(passing)).toEqual({ pass: true, failures: [] });
  });

  it('names each condition that fails', () => {
    const failing = {
      controlDrift: 2,
      cohort: {
        ...passing.cohort,
        codeSignal: { control: s(9, 40), treated: s(9, 40) },
        topCandidateChanges: s(0, 40),
        noQualified: { control: s(10, 40), treated: s(11, 40) },
        resolverUnavailable: s(3, 60),
        familiarityUnmeasured: s(2, 40),
      },
    };
    expect(evaluateReplayBar(failing).failures).toEqual([
      'controlDrift 2 != 0',
      'code-signal share did not rise: control 9/40, treated 9/40',
      'no top-candidate change in the paired cohort',
      'no-qualified share rose: control 10/40, treated 11/40',
      'resolver unavailable 3/60 >= 0.05',
      'familiarity unmeasured 2/40 >= 0.05',
    ]);
    expect(evaluateReplayBar(failing).pass).toBe(false);
  });
});
