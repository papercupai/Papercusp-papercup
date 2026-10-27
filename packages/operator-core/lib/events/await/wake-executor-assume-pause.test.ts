import { describe, expect, it, vi } from 'vitest';
import { makeDelivery } from '../../../test/_multi-session-testbed';
import { executeWake, type ExecuteWakeDeps } from './wake-executor';

describe('managed takeover caller wake fence', () => {
  it('R-5 caller wakes quiesce while target wakes remain live', async () => {
    const resumePlanRun = vi.fn<NonNullable<ExecuteWakeDeps['resumePlanRun']>>(async () => ({ ok: true as const }));
    let paused = true;
    const deps: ExecuteWakeDeps = {
      getSessionLifecycle: async owner => owner === 'caller' && paused
        ? { assumeCaller: { transitionKey: 'fixture' } } : null,
      resolveWakeModeFn: async () => 'auto', resumePlanRun,
      prepareAmbientPushBlock: null, prepareInboxWakeHeldWorkReminder: null,
      tagTurn: ((args: { text: string; origin: string }) => ({ taggedText: args.text,
        envelope: '', nonce: 'fixture', origin: args.origin, ledgerWritten: true })) as never,
    };
    const delivery = (owner: string, runId: number) => makeDelivery({ subscriberId: owner,
      eventKey: 'fixture:takeover-ready', summary: 'Continue the saved responsibility',
      wakeHandle: { kind: 'plan-run', runId } });
    expect(await executeWake(delivery('caller', 41), deps)).toMatchObject({ kind: 'park' });
    expect(resumePlanRun).not.toHaveBeenCalled();
    expect(await executeWake(delivery('target', 42), deps))
      .toEqual({ kind: 'delivered', channel: 'plan-run-resume' });
    expect(resumePlanRun).toHaveBeenCalledExactlyOnceWith({ runId: 42,
      wakeText: expect.stringContaining('Continue the saved responsibility') });
    // The durable return acknowledgement removes this caller's pause. The
    // unchanged delivery can then continue its own responsibility, not target's.
    paused = false;
    expect(await executeWake(delivery('caller', 41), deps))
      .toEqual({ kind: 'delivered', channel: 'plan-run-resume' });
    expect(resumePlanRun.mock.calls.map(([call]) => call.runId)).toEqual([42, 41]);
  });

  it.each(['loop:caller', 'owner-gui:resume', 'coord:inbox-wake:caller'])(
    'retains %s before any manual-mode bypass or execution effect', async eventKey => {
      const effects = vi.fn();
      const deps: ExecuteWakeDeps = {
        getSessionLifecycle: async () => ({ assumeCaller: { transitionKey: 'fixture' } }),
        resolveWakeModeFn: effects, findPsuHost: effects, spawnManagedPty: effects, injectPsuHost: effects,
      };
      expect(await executeWake(makeDelivery({ subscriberId: 'caller', eventKey }), deps))
        .toMatchObject({ kind: 'park', reason: expect.stringContaining('paused') });
      expect(effects).not.toHaveBeenCalled();
    },
  );

  it.each([null, false, 'corrupt'])( 'fails closed on malformed pause marker %s', async assumeCaller => {
    expect(await executeWake(makeDelivery({ subscriberId: 'caller' }), {
      getSessionLifecycle: async () => ({ assumeCaller }),
    })).toMatchObject({ kind: 'park' });
  });

  it('retains the delivery when lifecycle custody cannot be read', async () => {
    const effect = vi.fn();
    expect(await executeWake(makeDelivery({ subscriberId: 'caller' }), {
      getSessionLifecycle: async () => { throw new Error('storage unavailable'); }, findPsuHost: effect,
    })).toMatchObject({ kind: 'park', reason: expect.stringContaining('unknown') });
    expect(effect).not.toHaveBeenCalled();
  });
});
