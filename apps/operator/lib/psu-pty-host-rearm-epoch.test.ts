// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  isCarryRespawnSuperseded,
  makeCarryRearmController,
  makeInjectMutex,
  shouldDeferWakeForPendingRespawn,
} from '../scripts/psu-pty-host.mjs';

type Carry = {
  mode: string;
  data: string;
  systemPromptAddendum: string;
  receivedAtMs: number;
};
type EventExtra = { reason?: string };
type Boundary = { deferred: boolean };
const carry = (receivedAtMs = 10): Carry => ({
  mode: 'carry-respawn',
  data: `continue epoch ${receivedAtMs}`,
  systemPromptAddendum: `saved state ${receivedAtMs}`,
  receivedAtMs,
});
const drain = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

function harness({
  waitAtPrompt = vi.fn(async (): Promise<Boundary> => ({ deferred: false })),
  waitIdle,
}: {
  waitAtPrompt?: ReturnType<typeof vi.fn<() => Promise<Boundary>>>;
  waitIdle?: () => Promise<Boundary>;
} = {}) {
  const events: { kind: string; reason?: string }[] = [];
  const recycle = vi.fn(async (_data: string, _opts: Record<string, unknown>) => {});
  const mutex = makeInjectMutex();
  let epochStartedAt = 0;
  const options = {
    acquireInject: () => mutex.acquire(),
    waitAtPrompt,
    waitIdle,
    recycle,
    emitEvent: (kind: string, extra: Record<string, unknown>) => events.push({ kind, ...extra }),
    isSuperseded: (msg: Carry) => isCarryRespawnSuperseded(msg.receivedAtMs, epochStartedAt),
    // An old CURRENT request remains must-deliver. Age and epoch identity
    // are deliberately different predicates.
    isStale: () => true,
    maxProductionAttempts: 3,
  };
  const controller = makeCarryRearmController(options);
  return {
    controller, events, recycle, mutex, waitAtPrompt,
    nextEpoch: (at = 20) => { epochStartedAt = at; },
  };
}

describe('WI-10002078 — production carry re-arms cannot outlive their child epoch', () => {
  it('retires an obsolete retry before waiting on the successor prompt', async () => {
    const h = harness();
    const release = await h.mutex.acquire();
    h.controller.schedule(carry());
    expect(shouldDeferWakeForPendingRespawn('turn', h.controller.pendingCount())).toBe(true);
    h.nextEpoch();
    release();
    await drain();
    expect(h.waitAtPrompt).not.toHaveBeenCalled();
    expect(h.recycle).not.toHaveBeenCalled();
    expect(h.events.at(-1)).toMatchObject({ kind: 'respawn-carry-dropped', reason: 'superseded' });
    expect(shouldDeferWakeForPendingRespawn('turn', h.controller.pendingCount())).toBe(false);
  });

  it.each([true, false])('rechecks epoch after a prompt wait (deferred=%s)', async (deferred) => {
    let settle!: (value: Boundary) => void;
    const waitAtPrompt = vi.fn(() => new Promise<Boundary>((resolve) => { settle = resolve; }));
    const h = harness({ waitAtPrompt });
    h.controller.schedule(carry());
    await drain();
    h.nextEpoch();
    settle({ deferred });
    await drain();
    expect(h.recycle).not.toHaveBeenCalled();
    expect(h.waitAtPrompt).toHaveBeenCalledTimes(1);
    expect(h.events.at(-1)).toMatchObject({ kind: 'respawn-carry-dropped', reason: 'superseded' });
    expect(h.controller.pendingCount()).toBe(0);
  });

  it('does not drop a newer carry that replaces the obsolete payload during the gate wait', async () => {
    let settle!: (value: Boundary) => void;
    const waitAtPrompt = vi.fn()
      .mockImplementationOnce(() => new Promise<Boundary>((resolve) => { settle = resolve; }))
      .mockResolvedValue({ deferred: false });
    const h = harness({ waitAtPrompt });
    h.controller.schedule(carry());
    await drain();
    h.nextEpoch();
    const fresh = carry(30);
    expect(h.controller.schedule(fresh)).toBe('superseded');
    settle({ deferred: true });
    await drain();
    expect(h.recycle).toHaveBeenCalledTimes(1);
    expect(h.recycle.mock.calls[0]?.[0]).toBe(fresh.data);
    expect(h.events.some((event) => event.reason === 'superseded')).toBe(false);
    expect(h.controller.pendingCount()).toBe(0);
  });

  it('keeps an aged current-epoch carry until its safe boundary, without dropping or interrupting it', async () => {
    const waitAtPrompt = vi.fn()
      .mockResolvedValueOnce({ deferred: true })
      .mockResolvedValueOnce({ deferred: true })
      .mockResolvedValue({ deferred: false });
    const h = harness({ waitAtPrompt });
    h.controller.schedule(carry());
    await drain();
    expect(h.waitAtPrompt).toHaveBeenCalledTimes(3);
    expect(h.recycle).toHaveBeenCalledTimes(1);
    expect(h.events.filter((event) => event.kind === 'respawn-carry-dropped')).toEqual([]);
    expect(h.controller.pendingCount()).toBe(0);
  });

  it('does not recycle through a deferred human-input gate', async () => {
    const waitIdle = vi.fn(async () => ({ deferred: true }));
    const h = harness({ waitIdle });
    h.controller.schedule(carry());
    await drain();
    expect(h.recycle).not.toHaveBeenCalled();
    expect(h.waitAtPrompt).not.toHaveBeenCalled();
    expect(h.events.at(-1)).toMatchObject({
      kind: 'respawn-carry-dropped', reason: 'owner-input-cap',
    });
  });

  it('yields between unbounded production retries while owner input remains staged', async () => {
    const yieldAfterDefer = vi.fn(async () => {});
    const h = harness();
    const controller = makeCarryRearmController({
      acquireInject: () => h.mutex.acquire(),
      hasPendingOwnerInput: () => true,
      waitAtPrompt: vi.fn(async () => ({ deferred: false })),
      recycle: h.recycle,
      emitEvent: (kind: string, extra: EventExtra) => h.events.push({ kind, ...extra }),
      maxProductionAttempts: 2,
      yieldAfterDefer,
    });
    controller.schedule(carry());
    await drain();
    expect(yieldAfterDefer).toHaveBeenCalled();
    expect(h.recycle).not.toHaveBeenCalled();
    expect(h.events.at(-1)).toMatchObject({
      kind: 'respawn-carry-dropped',
      reason: 'owner-input-cap',
    });
  });

  it('waits for owner input to clear before retrying the carry', async () => {
    let pending = true;
    const h = harness();
    const controller = makeCarryRearmController({
      acquireInject: () => h.mutex.acquire(),
      hasPendingOwnerInput: () => pending,
      waitForOwnerInputClear: async () => {
        pending = false;
        return { deferred: false };
      },
      waitAtPrompt: vi.fn(async () => ({ deferred: false })),
      recycle: h.recycle,
      emitEvent: (kind: string, extra: EventExtra) => h.events.push({ kind, ...extra }),
      maxProductionAttempts: 2,
    });
    controller.schedule(carry());
    await drain();
    expect(h.recycle).toHaveBeenCalledTimes(1);
    expect(h.events.filter((event) => event.kind === 'respawn-carry-dropped')).toEqual([]);
  });

  it('does not clear another accepted first attempt when one same-owner attempt finishes', () => {
    const h = harness();
    const first = carry(10);
    const second = carry(11);
    h.controller.beginFirstAttempt(first);
    h.controller.beginFirstAttempt(second);
    h.controller.endFirstAttempt(first);
    expect(shouldDeferWakeForPendingRespawn('turn', h.controller.pendingCount())).toBe(true);
    h.controller.endFirstAttempt(first); // duplicate finalization is harmless
    expect(shouldDeferWakeForPendingRespawn('turn', h.controller.pendingCount())).toBe(true);
    h.controller.endFirstAttempt(second);
    expect(h.controller.pendingCount()).toBe(0);
  });
});

describe('native rearm preserves loop-instance delivery provenance', () => {
  type Wake = { mode: string; data: string; deliveryId: string; routineId?: string; fireNumber?: number };
  async function wakeHarness() {
    const mutex = makeInjectMutex();
    const release = await mutex.acquire();
    const delivered: Wake[] = [];
    const settled: { ids: string[]; delivered: boolean }[] = [];
    const controller = makeCarryRearmController({
      acquireInject: () => mutex.acquire(),
      waitAtPrompt: async () => ({ deferred: false }),
      recycle: async () => {},
      performDelivery: async (message: Wake) => {
        delivered.push(message);
        return { delivered: true };
      },
      onSettlement: (messages: Wake[], outcome: { delivered: boolean }) => {
        settled.push({ ids: messages.map(message => message.deliveryId), delivered: outcome.delivered });
      },
      emitEvent: () => {},
      maxProductionAttempts: 1,
    });
    return { controller, release, delivered, settled };
  }
  const loop: Wake = {
    mode: 'turn', routineId: 'storage-loop', fireNumber: 26, deliveryId: 'loop-26',
    data: 'loop-origin storage continuation',
  };
  const inbox: Wake = { mode: 'turn', deliveryId: 'review', data: 'inbox-origin source review' };

  it.each([true, false])('delivers both loop and inbox text without folding their proof IDs (loop first=%s)', async loopFirst => {
    const h = await wakeHarness();
    h.controller.schedule(loopFirst ? loop : inbox);
    h.controller.schedule(loopFirst ? inbox : loop);
    h.release();
    await drain();

    expect(h.delivered.map(message => message.data)).toEqual(loopFirst ? [loop.data, inbox.data] : [inbox.data, loop.data]);
    expect(h.settled).toEqual((loopFirst ? [loop, inbox] : [inbox, loop])
      .map(message => ({ ids: [message.deliveryId], delivered: true })));
    expect(h.controller.pendingCount()).toBe(0);
  });

  it('keeps distinct loop instances independent even when both fires use turn mode', async () => {
    const h = await wakeHarness();
    const other = { ...loop, routineId: 'another-loop', deliveryId: 'other-1', fireNumber: 1, data: 'other loop text' };
    h.controller.schedule(loop);
    h.controller.schedule(other);
    h.release();
    await drain();

    expect(h.delivered).toEqual([loop, other]);
    expect(h.settled.map(row => row.ids)).toEqual([[loop.deliveryId], [other.deliveryId]]);
  });

  it('still folds successive fires of the same loop into one latest payload and settlement', async () => {
    const h = await wakeHarness();
    const newer = { ...loop, deliveryId: 'loop-27', fireNumber: 27, data: 'newest loop text' };
    expect(h.controller.schedule(loop)).toBe('queued');
    expect(h.controller.schedule(newer)).toBe('superseded');
    h.release();
    await drain();

    expect(h.delivered).toEqual([newer]);
    expect(h.settled).toEqual([{ ids: [loop.deliveryId, newer.deliveryId], delivered: true }]);
  });

  it('refreshes the pending loop checkpoint without replacing a separately pending inbox wake', async () => {
    const h = await wakeHarness();
    h.controller.schedule(loop);
    h.controller.schedule(inbox);
    const refreshed = h.controller.refreshPendingMessage({ ...loop, data: 'fresh checkpoint' });
    h.release();
    await drain();

    expect(refreshed).toBe(true);
    expect(h.delivered.map(message => message.data)).toEqual(['fresh checkpoint', inbox.data]);
    expect(h.settled.map(row => row.ids)).toEqual([[loop.deliveryId], [inbox.deliveryId]]);
  });
});

describe('EI-27244198558252718 — a long production re-poll is never silent', () => {
  it('reports still-pending with the defer reason and native veto, then stays must-deliver', async () => {
    let clock = 0;
    const events: Record<string, unknown>[] = [];
    const recycle = vi.fn(async () => {});
    const mutex = makeInjectMutex();
    let refusals = 4;
    // Each prompt wait burns 6 simulated minutes and refuses on the native veto,
    // the su-f9f01e3c shape (quiet pty, retained gate), until the gate clears.
    const waitAtPrompt = vi.fn(async () => {
      clock += 6 * 60_000;
      if (refusals > 0) {
        refusals -= 1;
        return { deferred: true, reason: 'agent-busy', maxQuietForMs: 360_000, quietMs: 1500, nativeBusy: true };
      }
      return { deferred: false };
    });
    const controller = makeCarryRearmController({
      acquireInject: () => mutex.acquire(),
      waitAtPrompt,
      recycle,
      emitEvent: (kind: string, extra: Record<string, unknown>) => events.push({ kind, ...extra }),
      now: () => clock,
      stallReportEveryMs: 15 * 60_000,
    });
    expect(controller.schedule(carry())).toBe('queued');
    for (let i = 0; i < 40 && recycle.mock.calls.length === 0; i += 1) await drain();
    expect(recycle).toHaveBeenCalledTimes(1);
    const stalls = events.filter((e) => e.kind === 'respawn-rearm-still-pending');
    // Refusals at 6/12/18/24 min; the 15-min report fires before attempt 4 (18 min).
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toMatchObject({
      mode: 'carry-respawn', reason: 'busy-gate-expired', nativeBusy: true,
      pendingForMs: 18 * 60_000, attempts: 3, observedMaxQuietMs: 360_000,
    });
    expect(events.some((e) => e.kind === 'respawn-carry-dropped')).toBe(false);
    expect(shouldDeferWakeForPendingRespawn('turn', controller.pendingCount())).toBe(false);
  });

  it('can be disabled and never reports drills', async () => {
    let clock = 0;
    const events: { kind: string }[] = [];
    const mutex = makeInjectMutex();
    const make = (stallReportEveryMs: number) => makeCarryRearmController({
      acquireInject: () => mutex.acquire(),
      waitAtPrompt: vi.fn(async () => { clock += 60 * 60_000; return { deferred: true }; }),
      recycle: vi.fn(async () => {}),
      emitEvent: (kind: string) => events.push({ kind }),
      now: () => clock,
      stallReportEveryMs,
      maxProductionAttempts: 3,
      maxDrillAttempts: 3,
    });
    make(0).schedule(carry());
    make(60_000).schedule({ ...carry(), drillId: 'drill-1' } as Carry & { drillId: string });
    for (let i = 0; i < 20; i += 1) await drain();
    expect(events.filter((e) => e.kind.endsWith('still-pending'))).toEqual([]);
    expect(events.filter((e) => e.kind.endsWith('dropped'))).toHaveLength(2);
  });
});
