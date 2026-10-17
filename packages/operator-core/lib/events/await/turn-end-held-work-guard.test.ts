import { describe, expect, it } from 'vitest';
import { INBOX_WAKE_KEY_PREFIX } from './store';
import {
  evaluateTurnEndHeldWorkStop,
  turnEndHeldWorkStopText,
  TURN_END_HELD_WORK_LISTED_CAP,
  type TurnEndHeldWorkDeps,
} from './turn-end-held-work-guard';
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
    ...over,
  };
}

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
  });

  it('lets the turn end when a deliberate wake is already queued', async () => {
    const text = await evaluateTurnEndHeldWorkStop({
      ownerId: OWNER,
      workspaceId: WS,
      deps: deps({ hasPendingDeliberateWakeDelivery: async () => true }),
    });
    expect(text).toBe('');
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
