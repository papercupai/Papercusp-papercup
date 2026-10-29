import { describe, expect, it, vi } from 'vitest';
import { INBOX_WAKE_KEY_PREFIX } from './store';
import {
  classifyTurnEndRewakeDelivery,
  evaluateTurnEndHeldWorkStop,
  isFreshPendingCarryRespawn,
  turnEndHeldWorkStopText,
  TURN_END_HELD_WORK_LISTED_CAP,
  type TurnEndHeldWorkDeps,
} from './turn-end-held-work-guard';
import { turnEndRewakeKey, type TurnEndRewakeOutcome } from './turn-end-rewake';
import type { HeldWorkItem, WakeSourceAwait } from './wake-source-predicate';

// WI-6554700010015550: the incident shape. An AUTO session holding two items ends an inbox-wake
// turn with no loop armed, and only the platform's standing inbox keepalive is registered.
const OWNER = 'su-test-owner';
const WS = 'ws-test';
const FUTURE = new Date(Date.now() + 30 * 60_000).toISOString();

const held = (id: string, eventRef?: string): HeldWorkItem => ({
  id,
  harness: 'papercusp',
  status: 'blocked',
  eventBlockers: eventRef ? [{ ref: eventRef, summary: 'waiting', recheckAt: null }] : [],
});

const inboxKeepalive: WakeSourceAwait = {
  subscriberId: OWNER,
  eventKey: `${INBOX_WAKE_KEY_PREFIX}${OWNER}`,
  expiresTs: null,
  timeoutBehavior: 'expire',
  once: false,
};

function deps(over: Partial<TurnEndHeldWorkDeps> = {}): Partial<TurnEndHeldWorkDeps> {
  return {
    getModes: async () => [{ mode: 'auto' }],
    readHeldWorkItems: async () => [held('WI-1'), held('WI-2')],
    getLoopActive: async () => false,
    listParkedAwaits: async () => [inboxKeepalive],
    readAwaitTargets: async () => new Map(),
    hasPendingDeliberateWakeDelivery: async () => false,
    hasFreshPendingCarryRespawn: async () => false,
    armRewake: async () => ({ kind: 'armed', attempt: 1, timeoutSec: 900 }),
    cancelRewake: async () => undefined,
    ...over,
  };
}

/** Records the rewake calls the gate makes (WI-6554700010018567). */
function rewakeSpy(outcome: TurnEndRewakeOutcome | Error = { kind: 'armed', attempt: 1, timeoutSec: 900 }) {
  const calls = { armed: [] as string[][], cancelled: 0 };
  return {
    calls,
    deps: {
      armRewake: async (input: { ownerId: string; held: readonly HeldWorkItem[] }) => {
        calls.armed.push(input.held.map((h) => h.id));
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
      cancelRewake: async () => {
        calls.cancelled += 1;
      },
    } satisfies Partial<TurnEndHeldWorkDeps>,
  };
}

const rewakeAwait: WakeSourceAwait = {
  subscriberId: OWNER,
  eventKey: turnEndRewakeKey(OWNER),
  expiresTs: FUTURE,
  timeoutBehavior: 'wake',
  once: true,
};

function deliveryDeps(over: NonNullable<Parameters<typeof classifyTurnEndRewakeDelivery>[0]['deps']> = {}) {
  return {
    resolveRecipientWorkspace: async () => WS,
    getModes: async () => [{ mode: 'auto' }],
    readHeldWorkItems: async () => [held('WI-1')],
    getLoopActive: async () => false,
    listParkedAwaits: async () => [inboxKeepalive, rewakeAwait],
    readAwaitTargets: async () => new Map<string, never[]>(),
    hasPendingDeliberateWakeDelivery: async () => false,
    ...over,
  };
}

describe('turn-end rewake delivery freshness (EI-26908413306331308)', () => {
  it('supersedes a fired fallback when a newer dependency await guarantees a wake', async () => {
    const dependency: WakeSourceAwait = {
      subscriberId: OWNER,
      eventKey: 'work-item:done:WI-9',
      expiresTs: FUTURE,
      timeoutBehavior: 'wake',
      once: true,
    };
    const checkPending = vi.fn(async () => false);
    await expect(classifyTurnEndRewakeDelivery({
      ownerId: OWNER,
      excludeDeliveryIds: [91],
      deps: deliveryDeps({
        listParkedAwaits: async () => [inboxKeepalive, rewakeAwait, dependency],
        hasPendingDeliberateWakeDelivery: checkPending,
      }),
    })).resolves.toEqual({ kind: 'obsolete', reason: 'a current bounded wake is already guaranteed' });
    expect(checkPending).toHaveBeenCalledWith(OWNER, [91]);
  });

  it('keeps the fallback when held work still has no other guaranteed wake', async () => {
    await expect(classifyTurnEndRewakeDelivery({
      ownerId: OWNER,
      excludeDeliveryIds: [92],
      deps: deliveryDeps(),
    })).resolves.toEqual({ kind: 'keep' });
  });

  it('fails open when freshness reads fail', async () => {
    await expect(classifyTurnEndRewakeDelivery({
      ownerId: OWNER,
      deps: deliveryDeps({ listParkedAwaits: async () => { throw new Error('read failed'); } }),
    })).resolves.toMatchObject({ kind: 'keep' });
  });
});

describe('turn-end rewake timer (WI-6554700010018567)', () => {
  it('arms the timer when it refuses, and says so in the refusal', async () => {
    const spy = rewakeSpy();
    const text = await evaluateTurnEndHeldWorkStop({ ownerId: OWNER, workspaceId: WS, deps: deps(spy.deps) });
    expect(text).toContain('TURN-END REFUSED');
    expect(text).toContain('Rewake timer set');
    expect(text).toContain('15 min');
    expect(spy.calls.armed).toEqual([['WI-1', 'WI-2']]);
    expect(spy.calls.cancelled).toBe(0);
  });

  it('does not count its own pending timer as a wake source, so a later stop is still refused', async () => {
    const spy = rewakeSpy();
    const text = await evaluateTurnEndHeldWorkStop({
      ownerId: OWNER,
      workspaceId: WS,
      deps: deps({ ...spy.deps, listParkedAwaits: async () => [inboxKeepalive, rewakeAwait] }),
    });
    expect(text).toContain('TURN-END REFUSED');
    expect(spy.calls.armed).toHaveLength(1);
    expect(spy.calls.cancelled).toBe(0);
  });

  it('reports an exhausted budget instead of arming', async () => {
    const spy = rewakeSpy({ kind: 'exhausted', firedWithoutProgress: 2 });
    const text = await evaluateTurnEndHeldWorkStop({ ownerId: OWNER, workspaceId: WS, deps: deps(spy.deps) });
    expect(text).toContain('TURN-END REFUSED');
    expect(text).toContain('No rewake timer: 2 timed rewakes');
  });

  it('still refuses when arming the timer fails', async () => {
    const spy = rewakeSpy(new Error('db down'));
    const text = await evaluateTurnEndHeldWorkStop({ ownerId: OWNER, workspaceId: WS, deps: deps(spy.deps) });
    expect(text).toContain('TURN-END REFUSED');
    expect(text).not.toContain('Rewake timer');
  });

  it('cancels the pending timer when a stop is known safe', async () => {
    const safeShapes: Array<Partial<TurnEndHeldWorkDeps>> = [
      { readHeldWorkItems: async () => [] },
      { getLoopActive: async () => true },
      { hasPendingDeliberateWakeDelivery: async () => true },
      {
        listParkedAwaits: async () => [
          inboxKeepalive,
          rewakeAwait,
          { subscriberId: OWNER, eventKey: 'gate:green', expiresTs: FUTURE, timeoutBehavior: 'wake', once: true },
        ],
      },
    ];
    for (const shape of safeShapes) {
      const spy = rewakeSpy();
      const text = await evaluateTurnEndHeldWorkStop({
        ownerId: OWNER,
        workspaceId: WS,
        deps: deps({ ...spy.deps, ...shape }),
      });
      expect(text).toBe('');
      expect(spy.calls.cancelled).toBe(1);
      expect(spy.calls.armed).toHaveLength(0);
    }
  });

  it('touches no timer outside an autonomy mode or on an unknown loop status', async () => {
    for (const shape of [{ getModes: async () => [] }, { getLoopActive: async () => null }] as Array<
      Partial<TurnEndHeldWorkDeps>
    >) {
      const spy = rewakeSpy();
      const text = await evaluateTurnEndHeldWorkStop({
        ownerId: OWNER,
        workspaceId: WS,
        deps: deps({ ...spy.deps, ...shape }),
      });
      expect(text).toBe('');
      expect(spy.calls).toEqual({ armed: [], cancelled: 0 });
    }
  });
});

describe('turn-end held-work guard (WI-6554700010015550)', () => {
  it('refuses the incident shape: AUTO + held work + no loop + only the inbox keepalive', async () => {
    const text = await evaluateTurnEndHeldWorkStop({ ownerId: OWNER, workspaceId: WS, deps: deps() });
    expect(text).toContain('TURN-END REFUSED');
    expect(text).toContain('[WI-1, WI-2]');
    expect(text).toContain('auto mode');
    expect(text).toContain('does not finish your lane');
  });

  it('lets the turn end with no autonomy mode, even while holding work', async () => {
    const text = await evaluateTurnEndHeldWorkStop({
      ownerId: OWNER,
      workspaceId: WS,
      deps: deps({ getModes: async () => [{ mode: 'ideate' }] }),
    });
    expect(text).toBe('');
  });

  it('lets the turn end when nothing is held', async () => {
    const text = await evaluateTurnEndHeldWorkStop({
      ownerId: OWNER,
      workspaceId: WS,
      deps: deps({ readHeldWorkItems: async () => [] }),
    });
    expect(text).toBe('');
  });

  it('lets the turn end when an engine loop is armed', async () => {
    const text = await evaluateTurnEndHeldWorkStop({
      ownerId: OWNER,
      workspaceId: WS,
      deps: deps({ getLoopActive: async () => true }),
    });
    expect(text).toBe('');
  });

  it('lets the turn end when a bounded wake-on-timeout await exists', async () => {
    const timed: WakeSourceAwait = {
      subscriberId: OWNER,
      eventKey: 'release:green:papercusp',
      expiresTs: FUTURE,
      timeoutBehavior: 'wake',
      once: true,
    };
    const text = await evaluateTurnEndHeldWorkStop({
      ownerId: OWNER,
      workspaceId: WS,
      deps: deps({ listParkedAwaits: async () => [inboxKeepalive, timed] }),
    });
    expect(text).toBe('');
  });

  it('still refuses when the only extra await is UNBOUNDED (it cannot guarantee a wake)', async () => {
    const untimed: WakeSourceAwait = {
      subscriberId: OWNER,
      eventKey: 'release:green:papercusp',
      expiresTs: null,
      timeoutBehavior: null,
      once: true,
    };
    const text = await evaluateTurnEndHeldWorkStop({
      ownerId: OWNER,
      workspaceId: WS,
      deps: deps({ listParkedAwaits: async () => [inboxKeepalive, untimed] }),
    });
    expect(text).toContain('TURN-END REFUSED');
    expect(text).toContain('no bounded wake is guaranteed after this turn');
    expect(text).toContain('An unbounded event wait may still wake if its event arrives');
    expect(text).toContain('Arm a bounded wake');
    expect(text).not.toContain('nothing will wake you after this turn');
  });

  it('lets the turn end when a deliberate wake is already queued', async () => {
    const text = await evaluateTurnEndHeldWorkStop({
      ownerId: OWNER,
      workspaceId: WS,
      deps: deps({ hasPendingDeliberateWakeDelivery: async () => true }),
    });
    expect(text).toBe('');
  });

  it('allows a recent accepted carry only after retaining a bounded fallback wake', async () => {
    const owners: string[] = [];
    const spy = rewakeSpy();
    const text = await evaluateTurnEndHeldWorkStop({
      ownerId: OWNER,
      workspaceId: WS,
      deps: deps({
        ...spy.deps,
        hasFreshPendingCarryRespawn: async (ownerId) => {
          owners.push(ownerId);
          return true;
        },
      }),
    });
    expect(text).toBe('');
    expect(owners).toEqual([OWNER]);
    expect(spy.calls.cancelled).toBe(0);
    expect(spy.calls.armed).toEqual([['WI-1', 'WI-2']]);
  });

  it('still refuses a pending carry when no bounded fallback can be armed', async () => {
    const spy = rewakeSpy({ kind: 'exhausted', firedWithoutProgress: 2 });
    const text = await evaluateTurnEndHeldWorkStop({
      ownerId: OWNER,
      workspaceId: WS,
      deps: deps({
        ...spy.deps,
        hasFreshPendingCarryRespawn: async () => true,
      }),
    });
    expect(text).toContain('TURN-END REFUSED');
    expect(text).toContain('No rewake timer: 2 timed rewakes');
    expect(spy.calls.cancelled).toBe(0);
    expect(spy.calls.armed).toEqual([['WI-1', 'WI-2']]);
  });

  it('does not treat stale or undated pending carry-respawns as a wake source', () => {
    const capMs = 5 * 60_000;
    expect(isFreshPendingCarryRespawn({ outcome: 'pending', ageMs: 1_000, capMs })).toBe(true);
    expect(isFreshPendingCarryRespawn({ outcome: 'pending', ageMs: capMs + 120_001, capMs })).toBe(false);
    expect(isFreshPendingCarryRespawn({ outcome: 'pending', ageMs: null, capMs })).toBe(false);
    expect(isFreshPendingCarryRespawn({ outcome: 'dropped', ageMs: 1_000, capMs })).toBe(false);
    expect(isFreshPendingCarryRespawn({ outcome: 'delivered', ageMs: 1_000, capMs })).toBe(false);
  });

  it('never refuses on an unknown loop status or a failed read (positive-finding-only)', async () => {
    const unknownLoop = await evaluateTurnEndHeldWorkStop({
      ownerId: OWNER,
      workspaceId: WS,
      deps: deps({ getLoopActive: async () => null }),
    });
    expect(unknownLoop).toBe('');
    const failedRead = await evaluateTurnEndHeldWorkStop({
      ownerId: OWNER,
      workspaceId: WS,
      deps: deps({
        readHeldWorkItems: async () => {
          throw new Error('db down');
        },
      }),
    });
    expect(failedRead).toBe('');
  });

  it('suggests awaiting the event a held item names as its blocker', () => {
    const text = turnEndHeldWorkStopText({
      autonomyModes: ['auto'],
      held: [held('WI-9', 'work-item:done:WI-7')],
      loopActive: false,
      guaranteedWake: false,
    });
    expect(text).toContain("events:await { event: 'work-item:done:WI-7', timeout_sec: 1800, on_timeout: 'wake' }");
  });

  it('caps the listed ids and summarises the rest', () => {
    const many = Array.from({ length: TURN_END_HELD_WORK_LISTED_CAP + 3 }, (_, i) => held(`WI-${i + 1}`));
    const text = turnEndHeldWorkStopText({ autonomyModes: ['auto'], held: many, loopActive: false, guaranteedWake: false });
    expect(text).toContain(`${many.length} unfinished work-item(s)`);
    expect(text).toContain(', +3 more]');
    expect(text).not.toContain(`WI-${TURN_END_HELD_WORK_LISTED_CAP + 1},`);
  });
});
