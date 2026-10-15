import { describe, expect, it, vi } from 'vitest';
import {
  CHILD_PROOF_WINDOW_MS,
  goalModeInstrumentKey,
  type GoalModeComputedMetrics,
} from './goal-mode-computed-instruments';
import { evaluateScorecardInstrumentContract, resolveScorecardInstrumentSnapshots } from './scorecards';
import type { Rubric } from './rubrics';

const START = '2026-10-08T10:00:00.000Z';
const END = '2026-10-08T12:00:00.000Z';
const subject = { kind: 'agent-run', ref: 'su-holder', windowStart: START, windowEnd: END } as const;
const at = (minutes: number) => Date.parse(START) + minutes * 60_000;

const rubric = {
  rubricRef: 'goal-mode-e2e',
  criteria: [
    { key: 'never-implements', title: 'n', instrumentKey: goalModeInstrumentKey('never-implements') },
    { key: 'templates-mandate', title: 't', instrumentKey: goalModeInstrumentKey('templates-mandate') },
    { key: 'rubric-reuse-not-proliferation', title: 'r', instrumentKey: goalModeInstrumentKey('rubric-reuse-not-proliferation') },
  ],
} as unknown as Rubric;

function metrics(overrides: Partial<GoalModeComputedMetrics> = {}): GoalModeComputedMetrics {
  return {
    version: 1,
    window: { workspaceId: 'ws', goalId: 'goal-1', holderOwnerId: 'su-holder', windowStart: START, windowEnd: END },
    measuredAtMs: Date.parse(END) + 2 * CHILD_PROOF_WINDOW_MS,
    holderCalls: [{ tool: 'rubrics:propose', at: at(10), ok: true }],
    holderCallsTruncated: false,
    edits: [{ file: 'src/a.ts', at: at(20), via: 'PostToolUse:claude:Edit' }],
    coldWakes: [],
    descendantCompletions: [],
    peakWidth: { agents: 1, at: at(1) },
    maxAgents: 12,
    createdItems: { placed: 0, loose: 0, looseSample: [] },
    plansWritten: 0,
    startedPlans: [],
    demandAtStart: 0,
    closedInWindow: 0,
    ...overrides,
  };
}

describe('goal-mode computed instruments at the scorecard seam', () => {
  it('resolves one platform-computed snapshot per bound key, measuring once', async () => {
    const goalModeMetrics = vi.fn(async () => metrics());
    const snapshots = await resolveScorecardInstrumentSnapshots(
      { rubric, subject },
      { now: () => Date.parse(END) + 60_000, goalModeMetrics },
    );
    expect(goalModeMetrics).toHaveBeenCalledTimes(1);
    expect(snapshots?.[goalModeInstrumentKey('never-implements')]).toMatchObject({
      verdict: 'fail',
      provenance: 'platform-computed',
      value: { criterion: 'never-implements', goalId: 'goal-1', measure: { edits: 1 } },
    });
    expect(snapshots?.[goalModeInstrumentKey('templates-mandate')]).toMatchObject({
      verdict: 'unknown',
      value: { unknownReason: 'not-exercised' },
    });
    expect(snapshots?.[goalModeInstrumentKey('rubric-reuse-not-proliferation')]).toMatchObject({
      verdict: 'unknown',
      value: { unknownReason: 'needs-judgment' },
    });
  });

  it('reports an unavailable measurement as unknown, never as a verdict', async () => {
    const snapshots = await resolveScorecardInstrumentSnapshots(
      { rubric, subject },
      { goalModeMetrics: async () => null },
    );
    expect(snapshots?.[goalModeInstrumentKey('never-implements')]).toMatchObject({ verdict: 'unknown' });
    const broken = await resolveScorecardInstrumentSnapshots(
      { rubric, subject },
      { goalModeMetrics: async () => { throw new Error('pg down'); } },
    );
    expect(String((broken?.[goalModeInstrumentKey('never-implements')]?.value as { reason: string }).reason)).toContain('pg down');
  });

  it('flags a claimed pass over a computed fail or not-exercised, and defers on needs-judgment', async () => {
    const instrumentSnapshots = await resolveScorecardInstrumentSnapshots(
      { rubric, subject },
      { now: () => Date.parse(END) + 60_000, goalModeMetrics: async () => metrics() },
    );
    const nowMs = Date.parse(END) + 120_000;
    const claimed = evaluateScorecardInstrumentContract({
      rubric,
      nowMs,
      instrumentSnapshots,
      ratings: {
        'never-implements': { rating: 'pass', evidence: 'x' },
        'templates-mandate': { rating: 'pass', evidence: 'x' },
        'rubric-reuse-not-proliferation': { rating: 'pass', evidence: 'x' },
      } as never,
    });
    expect(claimed.positiveClaimContradictions.sort()).toEqual(
      [goalModeInstrumentKey('never-implements'), goalModeInstrumentKey('templates-mandate')].sort(),
    );
    // needs-judgment defers: neither a contradiction nor a verdict mismatch.
    expect(claimed.verdictMismatches).not.toContain(goalModeInstrumentKey('rubric-reuse-not-proliferation'));
    const honest = evaluateScorecardInstrumentContract({
      rubric,
      nowMs,
      instrumentSnapshots,
      ratings: {
        'never-implements': { rating: 'fail', evidence: 'x' },
        'templates-mandate': { rating: 'unknown', evidence: 'x', unknownReason: 'not-exercised' },
        'rubric-reuse-not-proliferation': { rating: 'fail', evidence: 'x' },
      } as never,
    });
    expect(honest.positiveClaimContradictions).toEqual([]);
  });

  it('a SELF-REPORTED fail never produces a positive-claim contradiction (only the platform can)', () => {
    const key = goalModeInstrumentKey('never-implements');
    const result = evaluateScorecardInstrumentContract({
      rubric,
      nowMs: Date.parse(END),
      instrumentSnapshots: { [key]: { verdict: 'fail', measuredAt: END } },
      ratings: { 'never-implements': { rating: 'pass', evidence: 'x' } } as never,
    });
    expect(result.positiveClaimContradictions).toEqual([]);
  });
});
