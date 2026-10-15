import { describe, expect, it } from 'vitest';
import {
  PARK_DELIVERY_GRACE_MS,
  checkParkDelivery,
  ownerNotificationText,
  runParkDeliveryCheck,
  type ParkDeliveryDeps,
  type ParkDeliveryState,
} from './park-delivery';

const EMITTED = '2026-10-13T10:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(EMITTED) + minutes * 60_000).toISOString();

function state(over: Partial<ParkDeliveryState> = {}): ParkDeliveryState {
  return {
    consultId: 'conv-park-1',
    workItemId: 'WI-1',
    parkerId: 'su-parker',
    verdict: 'proceed',
    emittedAt: EMITTED,
    parkerLastTurnAt: at(-30),
    parkerSessionState: 'parked',
    rewakeAttemptedAt: null,
    resumeAttemptedAt: null,
    resumeResult: null,
    ownerNotifiedAt: null,
    ...over,
  };
}

function fakeDeps(resumeOk: boolean | 'throw' = true) {
  const calls: string[] = [];
  const records: Array<Record<string, unknown>> = [];
  const deps: ParkDeliveryDeps = {
    rewake: async () => void calls.push('rewake'),
    resume: async () => {
      calls.push('resume');
      if (resumeOk === 'throw') throw new Error('launch failed');
      return resumeOk;
    },
    notifyOwner: async (_s, text) => void calls.push(`notify:${text}`),
    record: async (_s, patch) => void records.push(patch),
  };
  return { deps, calls, records };
}

describe('checkParkDelivery — re-wake after ten minutes without a turn (R-7)', () => {
  it('the grace is ten minutes', () => {
    expect(PARK_DELIVERY_GRACE_MS).toBe(600_000);
  });

  it('waits inside the grace', () => {
    expect(checkParkDelivery(state(), at(9))).toEqual({ kind: 'none', reason: 'within-grace' });
  });

  it('re-wakes a parked agent with no turn ten minutes after the verdict', () => {
    const a = checkParkDelivery(state(), at(10));
    expect(a.kind).toBe('rewake');
    expect(a.kind === 'rewake' && a.note).toContain('conv-park-1');
  });

  it('a turn after the verdict means delivered — no re-wake', () => {
    expect(checkParkDelivery(state({ parkerLastTurnAt: at(2) }), at(30))).toEqual({
      kind: 'none',
      reason: 'delivered',
    });
  });

  it('a turn BEFORE the verdict does not count as delivery', () => {
    expect(checkParkDelivery(state({ parkerLastTurnAt: at(-1) }), at(11)).kind).toBe('rewake');
  });

  it('re-wakes only once — waits on the re-wake inside its grace', () => {
    expect(checkParkDelivery(state({ rewakeAttemptedAt: at(10) }), at(15))).toEqual({
      kind: 'none',
      reason: 'awaiting-rewake-turn',
    });
  });
});

describe('checkParkDelivery — resume an ended session (R-20)', () => {
  it('an ended session is resumed instead of re-woken', () => {
    expect(checkParkDelivery(state({ parkerSessionState: 'ended' }), at(10)).kind).toBe('resume');
  });

  it('a re-wake with no turn after its grace escalates to a resume', () => {
    expect(checkParkDelivery(state({ rewakeAttemptedAt: at(10) }), at(20)).kind).toBe('resume');
  });

  it('waits on a successful resume inside its grace', () => {
    expect(
      checkParkDelivery(state({ rewakeAttemptedAt: at(10), resumeAttemptedAt: at(20), resumeResult: 'ok' }), at(25)),
    ).toEqual({ kind: 'none', reason: 'awaiting-resume-turn' });
  });
});

describe('checkParkDelivery — notify the owner on failure (R-21)', () => {
  it('a failed resume notifies the owner with the park ref', () => {
    const a = checkParkDelivery(state({ resumeAttemptedAt: at(20), resumeResult: 'failed' }), at(20));
    expect(a.kind).toBe('notify-owner');
    if (a.kind !== 'notify-owner') return;
    expect(a.failure).toBe('resume-failed');
    expect(a.text).toContain('conv-park-1');
    expect(a.text).toContain('WI-1');
  });

  it('no turn ten minutes after a successful resume notifies the owner', () => {
    const a = checkParkDelivery(state({ resumeAttemptedAt: at(20), resumeResult: 'ok' }), at(30));
    expect(a.kind === 'notify-owner' && a.failure).toBe('no-turn-after-resume');
  });

  it('notifies the owner only once', () => {
    expect(
      checkParkDelivery(
        state({ resumeAttemptedAt: at(20), resumeResult: 'failed', ownerNotifiedAt: at(21) }),
        at(60),
      ),
    ).toEqual({ kind: 'none', reason: 'owner-notified' });
  });

  it('the notification names the parker, the verdict and the failure', () => {
    const text = ownerNotificationText(state({ verdict: 'adopted' }), 'resume-failed');
    expect(text).toContain('su-parker');
    expect(text).toContain('"adopted"');
    expect(text).toContain('resuming the ended session failed');
  });

  it('rejects an invalid timestamp rather than guessing', () => {
    expect(() => checkParkDelivery(state({ emittedAt: 'nope' }), at(10))).toThrow(/invalid timestamp/);
  });
});

describe('runParkDeliveryCheck — applies the one owed step and records it', () => {
  it('re-wake records rewakeAttemptedAt', async () => {
    const { deps, calls, records } = fakeDeps();
    const r = await runParkDeliveryCheck(deps, state(), at(10));
    expect(r.action).toBe('rewake');
    expect(calls).toEqual(['rewake']);
    expect(records).toEqual([{ rewakeAttemptedAt: at(10) }]);
  });

  it('a resume that throws is recorded as failed, and the next check notifies the owner', async () => {
    const { deps, calls, records } = fakeDeps('throw');
    const s = state({ parkerSessionState: 'ended' });
    const r = await runParkDeliveryCheck(deps, s, at(10));
    expect(r).toMatchObject({ action: 'resume', resumeResult: 'failed' });
    expect(records).toEqual([{ resumeAttemptedAt: at(10), resumeResult: 'failed' }]);

    const next = await runParkDeliveryCheck(deps, { ...s, ...records[0] }, at(11));
    expect(next.action).toBe('notify-owner');
    expect(calls[calls.length - 1]).toMatch(/^notify:Park verdict not delivered: park conv-park-1/);
    expect(records[records.length - 1]).toEqual({ ownerNotifiedAt: at(11) });
  });

  it('a delivered verdict does nothing and records nothing', async () => {
    const { deps, calls, records } = fakeDeps();
    const r = await runParkDeliveryCheck(deps, state({ parkerLastTurnAt: at(1) }), at(30));
    expect(r).toEqual({ consultId: 'conv-park-1', action: 'none', reason: 'delivered' });
    expect(calls).toEqual([]);
    expect(records).toEqual([]);
  });
});
