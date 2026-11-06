import { describe, expect, it } from 'vitest';
import {
  classifyMissionActivity, MISSION_POLICY, projectMissionContinuity, reduceMissionContinuity,
  type AcceptedMissionActivity, type MissionParent, type MissionState,
} from './mission-continuity';

const parent: MissionParent = {
  assignmentRef: 'plan:mission', ownerDirectiveRef: 'order:2642', objectiveRefs: ['plan:mission'],
  completionCriteriaRefs: ['plan:mission#Requirements'], accountableOwner: 'su-test',
  custodyGeneration: 1, assignmentRevision: 1, authorityRef: 'order:2642',
  disposition: 'ready', blockerRef: null, nextActionRef: 'plan:mission#P-002',
};
const activity = (patch: Partial<AcceptedMissionActivity> = {}): AcceptedMissionActivity => ({
  selectedRef: 'message:question', acceptedOperationRef: 'accept:1', accepted: true, changesFocus: true,
  displacedContinuationRef: 'WI-step', relationship: 'directed-obligation', selectionRevision: 1, ...patch,
});
const bound = (): MissionState => reduceMissionContinuity(null, {
  id: 'bind:1', kind: 'assignment-accepted', binding: parent, currentWorkRef: 'WI-step',
}, parent, 1_000).state;
const detour = (): MissionState => reduceMissionContinuity(bound(), {
  id: 'select:1', kind: 'activity-accepted', activity: activity(),
}, parent, 2_000).state;

describe('accepted displacement classification', () => {
  it.each([
    ['FYI', { accepted: false }, 'signal-only'],
    ['extra claim without focus change', { changesFocus: false }, 'signal-only'],
    ['unreceipted intent pivot', { acceptedOperationRef: null }, 'signal-only'],
    ['ordinary child', { relationship: 'same-assignment' }, 'progress'],
    ['blocking repair', { relationship: 'blocking-repair' }, 'detour'],
    ['directed answer', {}, 'detour'],
    ['unrecorded relationship', { relationship: 'unknown' }, 'unknown'],
    ['missing saved continuation', { displacedContinuationRef: null }, 'unknown'],
  ] as const)('%s', (_name, patch, classification) => {
    expect(classifyMissionActivity(activity(patch))).toBe(classification);
  });
});

describe('mission reducer', () => {
  it('keeps the parent and its criteria across ordinary child progress', () => {
    const { state, consequences } = reduceMissionContinuity(bound(), {
      id: 'progress', kind: 'activity-accepted', activity: activity({ relationship: 'same-assignment' }),
    }, parent, 2_000);
    expect(state.binding?.assignmentRef).toBe(parent.assignmentRef);
    expect(state.binding?.completionCriteriaRefs).toEqual(parent.completionCriteriaRefs);
    expect(state.frames).toEqual([]);
    expect(consequences).toEqual([]);
  });

  it('returns from a completed detour using fresh parent disposition, not child acceptance', () => {
    const result = reduceMissionContinuity(detour(), { id: 'done', kind: 'child-ended', childRef: 'message:question', terminal: true },
      { ...parent, assignmentRevision: 2, nextActionRef: 'plan:mission#P-003' }, 3_000);
    expect(result.state.currentWorkRef).toBe('WI-step');
    expect(result.state.disposition).toBe('ready');
    expect(result.state.frames).toEqual([]);
    expect(result.consequences).toMatchObject([{ assignmentRevision: 2, continuationRef: 'plan:mission#P-003' }]);
  });

  it('never equates child completion or empty claims with parent completion', () => {
    const state = reduceMissionContinuity(detour(), { id: 'done', kind: 'child-ended', childRef: 'message:question', terminal: true }, parent, 3_000).state;
    const recovered = reduceMissionContinuity(state, { id: 'recover', kind: 'recovered' }, parent, 4_000);
    expect(recovered.state.binding?.assignmentRef).toBe('plan:mission');
    expect(recovered.state.disposition).toBe('ready');
    expect(recovered.consequences).toEqual([]);
  });

  it('preserves frames and deadlines on recovery without a synthetic interruption', () => {
    const before = detour();
    const result = reduceMissionContinuity(before, { id: 'recover', kind: 'recovered' }, parent, 500_000);
    expect(result.state.frames).toEqual(before.frames);
    expect(result.consequences).toEqual([]);
  });

  it('caps nested budgets at the original deadline and unwinds in order', () => {
    const first = detour();
    const second = reduceMissionContinuity(first, { id: 'select:2', kind: 'activity-accepted', activity: activity({
      selectedRef: 'WI-repair', acceptedOperationRef: 'accept:2', relationship: 'blocking-repair',
      displacedContinuationRef: 'message:question', selectionRevision: 2,
    }) }, parent, 500_000).state;
    expect(second.frames[1].absoluteDeadline).toBe(first.frames[0].absoluteDeadline);
    const outerDone = reduceMissionContinuity(second, { id: 'outer-done', kind: 'child-ended', childRef: 'message:question', terminal: true }, parent, 501_000);
    expect(outerDone.state.currentWorkRef).toBe('WI-repair');
    expect(outerDone.consequences).toEqual([]);
    const innerDone = reduceMissionContinuity(outerDone.state, { id: 'inner-done', kind: 'child-ended', childRef: 'WI-repair', terminal: true }, parent, 502_000);
    expect(innerDone.state.frames).toEqual([]);
    expect(innerDone.state.currentWorkRef).toBe('WI-step');
    expect(innerDone.consequences).toHaveLength(1);
  });

  it('expires against absolute time once, including after restart', () => {
    const before = detour();
    const deadline = 2_000 + MISSION_POLICY.directedMs;
    const early = reduceMissionContinuity(before, { id: 'early', kind: 'budget-expired' }, parent, deadline - 1);
    expect(early.consequences).toEqual([]);
    const expired = reduceMissionContinuity(early.state, { id: 'expiry', kind: 'budget-expired' }, parent, deadline);
    expect(expired.consequences).toMatchObject([{ kind: 'budget-exhausted', absoluteDeadline: deadline }]);
    expect(reduceMissionContinuity(expired.state, { id: 'expiry-replay', kind: 'budget-expired' }, parent, deadline + 100).consequences).toEqual([]);
  });

  it.each(['complete', 'cancelled', 'transferred'] as const)('invalidates returns when the parent is %s', disposition => {
    const result = reduceMissionContinuity(detour(), { id: 'done', kind: 'child-ended', childRef: 'message:question', terminal: true }, { ...parent, disposition }, 3_000);
    expect(result.state.frames).toEqual([]);
    expect(result.consequences).toEqual([]);
    expect(result.state.nextActionRef).toBeNull();
  });

  it('never wakes across custody changes or adopts a peer assignment', () => {
    const result = reduceMissionContinuity(detour(), { id: 'done', kind: 'child-ended', childRef: 'message:question', terminal: true },
      { ...parent, accountableOwner: 'su-peer', custodyGeneration: 2 }, 3_000);
    expect(result.state.disposition).toBe('transferred');
    expect(result.state.binding?.accountableOwner).toBe('su-test');
    expect(result.consequences).toEqual([]);
  });

  it('retains an unknown parent and its frames on read failure', () => {
    const before = detour();
    const result = reduceMissionContinuity(before, { id: 'recover', kind: 'recovered' }, null, 3_000);
    expect(result.state.frames).toEqual(before.frames);
    expect(result.state.stateAvailability).toBe('unknown');
    expect(result.state.binding?.assignmentRef).toBe(parent.assignmentRef);
    expect(result.consequences).toEqual([]);
  });

  it('retries the same completion receipt after a parent read failure', () => {
    const event = { id: 'retry-done', kind: 'child-ended' as const, childRef: 'message:question', terminal: true };
    const unavailable = reduceMissionContinuity(detour(), event, null, 3_000);
    const retried = reduceMissionContinuity(unavailable.state, event, parent, 4_000);
    expect(retried.state.frames).toEqual([]);
    expect(retried.consequences).toHaveLength(1);
  });

  it('returns to an unfinished outer detour before the root step', () => {
    const nested = reduceMissionContinuity(detour(), { id: 'nested', kind: 'activity-accepted', activity: activity({
      selectedRef: 'WI-repair', acceptedOperationRef: 'accept:2', relationship: 'blocking-repair',
      displacedContinuationRef: 'message:question', selectionRevision: 2,
    }) }, parent, 3_000).state;
    const result = reduceMissionContinuity(nested, { id: 'inner-done', kind: 'child-ended', childRef: 'WI-repair', terminal: true }, parent, 4_000);
    expect(result.consequences).toMatchObject([{ continuationRef: 'message:question' }]);
    expect(result.state.frames).toHaveLength(1);
  });

  it('does not wake a blocked parent', () => {
    const result = reduceMissionContinuity(detour(), { id: 'done', kind: 'child-ended', childRef: 'message:question', terminal: true },
      { ...parent, disposition: 'blocked', blockerRef: 'WI-blocker' }, 3_000);
    expect(result.state.blockerRef).toBe('WI-blocker');
    expect(result.consequences).toEqual([]);
  });

  it('ignores nonterminal child signals, duplicates and old selections', () => {
    const before = detour();
    expect(reduceMissionContinuity(before, { id: 'not-done', kind: 'child-ended', childRef: 'message:question', terminal: false }, parent, 3_000).state.frames).toEqual(before.frames);
    expect(reduceMissionContinuity(before, { id: 'select:1', kind: 'recovered' }, parent, 3_000).classification).toBe('duplicate');
    expect(reduceMissionContinuity(before, { id: 'old-selection', kind: 'activity-accepted', activity: activity() }, parent, 3_000).classification).toBe('stale');
  });

  it('keeps ambiguous selection explicit and does not silently replace an assignment', () => {
    const before = bound();
    const unknown = reduceMissionContinuity(before, { id: 'unknown', kind: 'activity-accepted', activity: activity({ relationship: 'unknown' }) }, parent, 2_000);
    expect(unknown.state.unknownReason).toBe('ambiguous-accepted-selection');
    const replaced = reduceMissionContinuity(before, { id: 'replace', kind: 'assignment-accepted', binding: { ...parent, assignmentRef: 'plan:other' }, currentWorkRef: 'WI-other' }, parent, 2_000);
    expect(replaced.classification).toBe('stale');
    expect(replaced.state.binding?.assignmentRef).toBe('plan:mission');
  });

  it('does not mutate inputs and discloses bounded frame omissions', () => {
    const before = detour();
    const snapshot = structuredClone(before);
    reduceMissionContinuity(before, { id: 'done', kind: 'child-ended', childRef: 'message:question', terminal: true }, parent, 3_000);
    expect(before).toEqual(snapshot);
    expect(projectMissionContinuity(before, 0)).toMatchObject({ interruptionFrames: [], omittedFrames: ['accept:1'] });
  });
});
