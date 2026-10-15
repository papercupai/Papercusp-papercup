import { describe, expect, it, vi } from 'vitest';
import {
  parkVerdictEventKey,
  resolvePark,
  runParkTriggers,
  type ParkAction,
  type ParkReply,
  type ParkState,
  type ParkTriggerDeps,
} from './park-resolver';

const T0 = '2026-10-12T12:00:00.000Z';
const DEADLINE = '2026-10-12T13:00:00.000Z';
const BEFORE = '2026-10-12T12:30:00.000Z';
const AFTER = '2026-10-12T13:00:01.000Z';

function park(over: Partial<ParkState> = {}): ParkState {
  return {
    consultId: 'conv-park-1',
    workItemId: 'WI-1',
    blockerRef: 'product-decision:pick-cache',
    parkerOwnerId: 'su-parker',
    question: 'Which cache backend?',
    defaultAction: 'Use the in-process LRU',
    deadlineAt: DEADLINE,
    ownerAuthority: false,
    ownerAuthorityTopic: null,
    replies: [],
    parkerResponses: [],
    ownerAnswer: null,
    reviewersExhausted: false,
    outcomes: [],
    ownerQuestionOpened: false,
    ...over,
  };
}

const objection = (over: Partial<ParkReply> = {}): ParkReply => ({
  id: 'post-obj-1',
  responderOwnerId: 'su-peer-a',
  at: '2026-10-12T12:10:00.000Z',
  stance: 'object',
  basis: 'alternative',
  reason: 'LRU loses state across restarts',
  alternative: 'Use the Postgres-backed cache',
  ...over,
});

const kinds = (actions: ParkAction[]) => actions.map((a) => a.kind);
const verdictPayload = (actions: ParkAction[]) =>
  actions.find((a): a is Extract<ParkAction, { kind: 'emit-verdict' }> => a.kind === 'emit-verdict')?.payload;

describe('resolvePark — silence proceeds at the deadline (R-5)', () => {
  it('a silent park at its deadline proceeds, clears its blocker and records peer review, never owner approval', () => {
    const d = resolvePark(park(), AFTER);
    expect(d.verdict).toBe('proceed');
    expect(kinds(d.actions)).toEqual(['record-outcome', 'clear-blocker', 'emit-verdict']);
    const clear = d.actions.find((a) => a.kind === 'clear-blocker');
    expect(clear).toMatchObject({ recordedAs: 'peer-review' });
    expect(verdictPayload(d.actions)?.recordedAs).toBe('peer-review');
  });

  it('supporting and no-view replies do not block proceed at the deadline', () => {
    const replies: ParkReply[] = [
      { id: 'p1', responderOwnerId: 'a', at: BEFORE, stance: 'support' },
      { id: 'p2', responderOwnerId: 'b', at: BEFORE, stance: 'no-view' },
    ];
    expect(resolvePark(park({ replies }), AFTER).verdict).toBe('proceed');
  });

  it('does not proceed before the deadline', () => {
    expect(resolvePark(park(), BEFORE)).toEqual({ verdict: null, actions: [] });
  });

  it('is idempotent once settled', () => {
    const settled = park({ outcomes: [{ verdict: 'proceed', at: AFTER }] });
    expect(resolvePark(settled, '2026-10-12T14:00:00.000Z')).toEqual({ verdict: null, actions: [] });
  });

  it('an objection withdrawn by its author no longer stands', () => {
    const replies: ParkReply[] = [objection(), { id: 'p3', responderOwnerId: 'su-peer-a', at: BEFORE, stance: 'support' }];
    expect(resolvePark(park({ replies, outcomes: [{ verdict: 'consider-alternative', at: BEFORE, objectionId: 'post-obj-1' }] }), AFTER).verdict).toBe('proceed');
  });
});

describe('resolvePark — verdict emit names the verdict (R-6)', () => {
  it('every outcome emits a payload with the verdict, the default, the alternative and the consult', () => {
    const cases: Array<[ParkState, string, string]> = [
      [park(), AFTER, 'proceed'],
      [park({ replies: [objection()] }), BEFORE, 'consider-alternative'],
      [park({ replies: [objection()], reviewersExhausted: true }), BEFORE, 'owner-deciding'],
      [park({ ownerAnswer: { at: BEFORE, text: 'Use Redis' } }), BEFORE, 'owner-decided'],
    ];
    for (const [state, now, verdict] of cases) {
      const p = verdictPayload(resolvePark(state, now).actions);
      expect(p, verdict).toBeDefined();
      expect(p!.verdict).toBe(verdict);
      expect(p!.consultId).toBe('conv-park-1');
      expect(p!.defaultAction).toBe('Use the in-process LRU');
      if (verdict === 'consider-alternative' || verdict === 'owner-deciding') {
        expect(p!.alternative).toBe('Use the Postgres-backed cache');
      }
    }
  });

  it('the verdict event key is per consult', () => {
    expect(parkVerdictEventKey('conv-park-1')).toBe('consult:park-verdict:conv-park-1');
  });
});

describe('resolvePark — owner-authority parks (R-14, R-17)', () => {
  const owner = park({ ownerAuthority: true, ownerAuthorityTopic: 'spend' });

  it('an owner-authority park at its deadline never proceeds; it becomes one owner question with both options', () => {
    const d = resolvePark(owner, AFTER);
    expect(d.verdict).toBe('owner-deciding');
    expect(kinds(d.actions)).not.toContain('clear-blocker');
    const ask = d.actions.find((a) => a.kind === 'ask-owner');
    expect(ask).toMatchObject({ options: ['Use the in-process LRU', 'Do not take the default action'] });
  });

  it('the owner question is asked exactly once', () => {
    const asked = { ...owner, outcomes: [{ verdict: 'owner-deciding' as const, at: AFTER }], ownerQuestionOpened: true };
    expect(resolvePark(asked, '2026-10-12T15:00:00.000Z')).toEqual({ verdict: null, actions: [] });
  });
});

describe('resolvePark — a standing objection returns to the parked agent (R-16)', () => {
  it('an objection wakes the parked agent with consider-alternative and blocks proceed', () => {
    const d = resolvePark(park({ replies: [objection()] }), BEFORE);
    expect(d.verdict).toBe('consider-alternative');
    expect(kinds(d.actions)).toEqual(['record-outcome', 'emit-verdict']);
  });

  it('a park never proceeds while an objection stands, even past the deadline', () => {
    const notified = park({
      replies: [objection()],
      outcomes: [{ verdict: 'consider-alternative', at: BEFORE, objectionId: 'post-obj-1' }],
    });
    const d = resolvePark(notified, AFTER);
    expect(d.verdict).not.toBe('proceed');
    expect(kinds(d.actions)).not.toContain('clear-blocker');
  });

  it('adopting the alternative settles the park as peer review and clears the blocker', () => {
    const d = resolvePark(
      park({
        replies: [objection()],
        parkerResponses: [{ kind: 'adopt', at: BEFORE, text: 'Switching to Postgres' }],
        outcomes: [{ verdict: 'consider-alternative', at: '2026-10-12T12:11:00.000Z', objectionId: 'post-obj-1' }],
      }),
      BEFORE,
    );
    expect(d.verdict).toBe('adopted');
    expect(d.actions.find((a) => a.kind === 'clear-blocker')).toMatchObject({ recordedAs: 'peer-review' });
  });

  it('a rebuttal advances the cascade holding both positions, once, without dropping the objection', () => {
    const state = park({
      replies: [objection()],
      parkerResponses: [{ kind: 'rebut', at: BEFORE, text: 'Restarts are rare; state is rebuildable' }],
      outcomes: [{ verdict: 'consider-alternative', at: '2026-10-12T12:11:00.000Z', objectionId: 'post-obj-1' }],
    });
    const d = resolvePark(state, BEFORE);
    const adv = d.actions.find((a) => a.kind === 'advance-cascade');
    expect(adv).toMatchObject({
      positions: {
        default: 'Use the in-process LRU',
        rebuttal: 'Restarts are rare; state is rebuildable',
        objection: 'LRU loses state across restarts',
        alternative: 'Use the Postgres-backed cache',
      },
    });
    expect(kinds(d.actions)).not.toContain('emit-verdict');
    expect(kinds(d.actions)).not.toContain('clear-blocker');
    // Applying the recorded marker makes the next resolve a no-op for this rebuttal.
    const marker = d.actions.find((a) => a.kind === 'record-outcome') as Extract<ParkAction, { kind: 'record-outcome' }>;
    const again = resolvePark({ ...state, outcomes: [...state.outcomes, marker.outcome] }, BEFORE);
    expect(kinds(again.actions)).not.toContain('advance-cascade');
  });
});

describe('resolvePark — unresolved disagreement reaches the owner (R-17)', () => {
  it('a standing objection with exhausted reviewers becomes one owner question with both options', () => {
    const d = resolvePark(
      park({
        replies: [objection()],
        parkerResponses: [{ kind: 'rebut', at: BEFORE, text: 'No' }],
        reviewersExhausted: true,
        outcomes: [{ verdict: 'consider-alternative', at: BEFORE, objectionId: 'post-obj-1' }],
      }),
      BEFORE,
    );
    expect(d.verdict).toBe('owner-deciding');
    const asks = d.actions.filter((a) => a.kind === 'ask-owner');
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ options: ['Use the in-process LRU', 'Use the Postgres-backed cache'] });
  });
});

describe('resolvePark — an owner answer settles the park (R-18)', () => {
  it('an owner answer before any peer reply resolves to owner-decided with the owner text', () => {
    const d = resolvePark(park({ ownerAnswer: { at: T0, text: 'Use Redis' } }), BEFORE);
    expect(d.verdict).toBe('owner-decided');
    expect(verdictPayload(d.actions)).toMatchObject({ ownerText: 'Use Redis', recordedAs: 'owner' });
    expect(d.actions.find((a) => a.kind === 'clear-blocker')).toMatchObject({ recordedAs: 'owner' });
  });

  it('an owner answer after peer replies overrides a standing objection', () => {
    const d = resolvePark(park({ replies: [objection()], ownerAnswer: { at: BEFORE, text: 'Keep LRU' } }), BEFORE);
    expect(d.verdict).toBe('owner-decided');
  });

  it('no later peer reply overrides an owner decision', () => {
    const decided = park({
      ownerAnswer: { at: BEFORE, text: 'Keep LRU' },
      outcomes: [{ verdict: 'owner-decided', at: BEFORE }],
      replies: [objection({ at: AFTER, id: 'late' })],
    });
    expect(resolvePark(decided, '2026-10-12T14:00:00.000Z')).toEqual({ verdict: null, actions: [] });
  });
});

describe('resolvePark — intermediate replies do not wake the parked agent (R-19)', () => {
  it('a support reply before the deadline emits nothing', () => {
    const d = resolvePark(park({ replies: [{ id: 's', responderOwnerId: 'a', at: BEFORE, stance: 'support' }] }), BEFORE);
    expect(d).toEqual({ verdict: null, actions: [] });
  });

  it('a second reply on an already-notified objection emits nothing', () => {
    const d = resolvePark(
      park({
        replies: [objection(), { id: 's', responderOwnerId: 'b', at: BEFORE, stance: 'support' }],
        outcomes: [{ verdict: 'consider-alternative', at: BEFORE, objectionId: 'post-obj-1' }],
      }),
      BEFORE,
    );
    expect(kinds(d.actions)).not.toContain('emit-verdict');
  });
});

describe('runParkTriggers', () => {
  function deps(state: ParkState | null): ParkTriggerDeps & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      loadPark: vi.fn(async () => state),
      recordOutcome: vi.fn(async () => void calls.push('record')),
      clearBlocker: vi.fn(async () => void calls.push('clear')),
      emitVerdict: vi.fn(async (key: string) => void calls.push(`emit:${key}`)),
      advanceCascade: vi.fn(async () => void calls.push('advance')),
      askOwner: vi.fn(async () => void calls.push('ask')),
    };
  }

  it('applies a silent-proceed decision in order: record, clear the blocker, emit the verdict', async () => {
    const d = deps(park());
    const r = await runParkTriggers(d, 'conv-park-1', AFTER);
    expect(r?.verdict).toBe('proceed');
    expect(d.calls).toEqual(['record', 'clear', 'emit:consult:park-verdict:conv-park-1']);
  });

  it.each([
    { verdict: 'proceed', state: park(), now: AFTER, alternative: null, objectionReason: null, ownerText: null, cleared: true },
    { verdict: 'consider-alternative', state: park({ replies: [objection()] }), now: BEFORE,
      alternative: 'Use the Postgres-backed cache', objectionReason: 'LRU loses state across restarts', ownerText: null, cleared: false },
    { verdict: 'owner-deciding', state: park({ replies: [objection()], reviewersExhausted: true }), now: BEFORE,
      alternative: 'Use the Postgres-backed cache', objectionReason: 'LRU loses state across restarts', ownerText: null, cleared: false },
    { verdict: 'owner-decided', state: park({ ownerAnswer: { at: BEFORE, text: 'Use Redis' } }), now: BEFORE,
      alternative: null, objectionReason: null, ownerText: 'Use Redis', cleared: true },
    { verdict: 'adopted', state: park({ replies: [objection()], parkerResponses: [{ kind: 'adopt', at: BEFORE, text: 'Adopting Postgres' }] }), now: BEFORE,
      alternative: 'Use the Postgres-backed cache', objectionReason: 'LRU loses state across restarts', ownerText: null, cleared: true },
  ])('forwards the exact $verdict payload to the parker verdict event', async ({ verdict, state, now, alternative, objectionReason, ownerText, cleared }) => {
    const d = deps(state);
    const result = await runParkTriggers(d, 'conv-park-1', now);
    expect(result?.verdict).toBe(verdict);
    expect(d.loadPark).toHaveBeenCalledExactlyOnceWith('conv-park-1');
    expect(d.emitVerdict).toHaveBeenCalledExactlyOnceWith('consult:park-verdict:conv-park-1', {
      verdict, consultId: 'conv-park-1', workItemId: 'WI-1', blockerRef: 'product-decision:pick-cache',
      defaultAction: 'Use the in-process LRU', alternative, objectionReason, ownerText,
      recordedAs: verdict === 'owner-decided' ? 'owner' : 'peer-review',
    });
    expect(d.recordOutcome).toHaveBeenCalledExactlyOnceWith(state, {
      verdict, at: now, objectionId: alternative ? 'post-obj-1' : null,
    });
    expect(d.clearBlocker).toHaveBeenCalledTimes(cleared ? 1 : 0);
    if (cleared) {
      expect(d.clearBlocker).toHaveBeenCalledWith(state, {
        recordedAs: verdict === 'owner-decided' ? 'owner' : 'peer-review',
        note: verdict === 'proceed'
          ? 'Peer review: no standing objection at the deadline; proceeding with the default: Use the in-process LRU'
          : verdict === 'adopted'
            ? "Peer review: adopted the reviewer's alternative: Use the Postgres-backed cache"
            : 'Owner decided: Use Redis',
      });
    }
    expect(d.advanceCascade).not.toHaveBeenCalled();
    expect(d.askOwner).toHaveBeenCalledTimes(verdict === 'owner-deciding' ? 1 : 0);
  });

  it('forwards both rebuttal positions to the cascade without waking or clearing the parker', async () => {
    const state = park({
      replies: [objection()],
      parkerResponses: [{ kind: 'rebut', at: BEFORE, text: 'Restarts are rare; state is rebuildable' }],
      outcomes: [{ verdict: 'consider-alternative', at: '2026-10-12T12:11:00.000Z', objectionId: 'post-obj-1' }],
    });
    const d = deps(state);
    const result = await runParkTriggers(d, 'conv-park-1', BEFORE);
    expect(result?.applied).toEqual(['advance-cascade', 'record-outcome']);
    expect(d.advanceCascade).toHaveBeenCalledExactlyOnceWith(state, {
      default: 'Use the in-process LRU', rebuttal: 'Restarts are rare; state is rebuildable',
      objection: 'LRU loses state across restarts', alternative: 'Use the Postgres-backed cache',
    });
    expect(d.emitVerdict).not.toHaveBeenCalled();
    expect(d.clearBlocker).not.toHaveBeenCalled();
    expect(d.askOwner).not.toHaveBeenCalled();
  });

  it.each([
    { reason: 'exhausted disagreement', state: park({ replies: [objection()], reviewersExhausted: true }), alternative: 'Use the Postgres-backed cache', question: 'Which cache backend?' },
    { reason: 'owner authority', state: park({ ownerAuthority: true, ownerAuthorityTopic: 'spend' }), alternative: 'Do not take the default action', question: 'Which cache backend? [owner-authority: spend]' },
  ])('forwards exactly the two owner options for $reason', async ({ state, alternative, question }) => {
    const d = deps(state);
    await runParkTriggers(d, 'conv-park-1', AFTER);
    expect(d.askOwner).toHaveBeenCalledExactlyOnceWith(state, {
      question, options: ['Use the in-process LRU', alternative],
    });
    expect(d.clearBlocker).not.toHaveBeenCalled();
    expect(d.advanceCascade).not.toHaveBeenCalled();
  });

  it('returns null for a consult that is not a park', async () => {
    expect(await runParkTriggers(deps(null), 'conv-x', AFTER)).toBeNull();
  });

  it('an intermediate reply applies nothing (no wake)', async () => {
    const d = deps(park({ replies: [{ id: 's', responderOwnerId: 'a', at: BEFORE, stance: 'support' }] }));
    await runParkTriggers(d, 'conv-park-1', BEFORE);
    expect(d.calls).toEqual([]);
  });
});
