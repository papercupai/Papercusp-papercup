/**
 * WI-10008194 — the wake pump / sweep must PAGE when it fails continuously, not only log.
 *
 * Replays the 2026-10-10 outage shape: bg-host booted code ahead of a withheld migration and every
 * pump kick + sweep failed with `column "turn_proof" of relation "event_wake_deliveries" does not
 * exist` for ~16 minutes with no alarm.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createPumpHealthTracker,
  isSchemaMismatchError,
  pumpFailureAlarmText,
  pumpFailureConditionKey,
  PUMP_FAILURE_ALARM_MIN_DURATION_MS,
  PUMP_FAILURE_ALARM_MIN_FAILURES,
  type PumpFailureAlarm,
} from './pump-health';

const OUTAGE_ERROR = new Error('column "turn_proof" of relation "event_wake_deliveries" does not exist');

function harness() {
  let t = Date.parse('2026-10-10T20:19:10Z');
  const raise = vi.fn(async (_a: PumpFailureAlarm) => {});
  const clear = vi.fn(async (_a: PumpFailureAlarm) => {});
  const log = vi.fn();
  const tracker = createPumpHealthTracker({ raise, clear, log, now: () => t });
  return {
    tracker,
    raise,
    clear,
    log,
    advance(ms: number) {
      t += ms;
    },
  };
}

describe('pump-health tracker — page on a sustained failure streak', () => {
  it('pages ONCE when a leg has failed >= minFailures times over >= minDuration (the 20:19Z outage shape)', () => {
    const h = harness();
    // The 30s sweeper alone: 5 failures spanning 2 minutes.
    for (let i = 0; i < PUMP_FAILURE_ALARM_MIN_FAILURES; i += 1) {
      if (i > 0) h.advance(30_000);
      h.tracker.recordFailure('papercusp-workspace', 'sweep', OUTAGE_ERROR);
    }
    expect(h.raise).toHaveBeenCalledTimes(1);
    const alarm = h.raise.mock.calls[0]![0];
    expect(alarm).toMatchObject({
      workspaceId: 'papercusp-workspace',
      leg: 'sweep',
      failures: PUMP_FAILURE_ALARM_MIN_FAILURES,
      failingMs: PUMP_FAILURE_ALARM_MIN_DURATION_MS,
      lastError: OUTAGE_ERROR.message,
      schemaMismatch: true,
    });

    // Still failing: one page per episode, never a storm.
    for (let i = 0; i < 20; i += 1) {
      h.advance(10_000);
      h.tracker.recordFailure('papercusp-workspace', 'sweep', OUTAGE_ERROR);
    }
    expect(h.raise).toHaveBeenCalledTimes(1);
    expect(h.clear).not.toHaveBeenCalled();
  });

  it('stays silent for a transient burst (many failures, short) and for a slow trickle (long, few failures)', () => {
    const burst = harness();
    for (let i = 0; i < 50; i += 1) {
      burst.advance(1_000); // 50 failures inside 50s — a pooler blip, not an outage
      burst.tracker.recordFailure('ws', 'pump', OUTAGE_ERROR);
    }
    expect(burst.raise).not.toHaveBeenCalled();

    const trickle = harness();
    for (let i = 0; i < PUMP_FAILURE_ALARM_MIN_FAILURES - 1; i += 1) {
      trickle.tracker.recordFailure('ws', 'pump', OUTAGE_ERROR);
      trickle.advance(10 * 60_000);
    }
    expect(trickle.raise).not.toHaveBeenCalled();
  });

  it('a success resets the streak; it resolves the page only when one was raised', () => {
    const h = harness();
    // An un-paged streak that recovers: nothing to resolve.
    h.tracker.recordFailure('ws', 'pump', OUTAGE_ERROR);
    h.advance(5 * 60_000);
    h.tracker.recordSuccess('ws', 'pump');
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.tracker.streaks()).toEqual([]);

    // The reset is real: the next failures start a NEW streak, so 4 more do not page.
    for (let i = 0; i < PUMP_FAILURE_ALARM_MIN_FAILURES - 1; i += 1) {
      h.advance(60_000);
      h.tracker.recordFailure('ws', 'pump', OUTAGE_ERROR);
    }
    expect(h.raise).not.toHaveBeenCalled();

    // The 5th pages; recovery resolves exactly that page.
    h.advance(60_000);
    h.tracker.recordFailure('ws', 'pump', OUTAGE_ERROR);
    expect(h.raise).toHaveBeenCalledTimes(1);
    h.advance(30_000);
    h.tracker.recordSuccess('ws', 'pump');
    expect(h.clear).toHaveBeenCalledTimes(1);
    expect(h.clear.mock.calls[0]![0]).toMatchObject({ workspaceId: 'ws', leg: 'pump', failures: 5 });
    h.tracker.recordSuccess('ws', 'pump');
    expect(h.clear).toHaveBeenCalledTimes(1);

    // A second outage is a second episode and pages again.
    for (let i = 0; i < PUMP_FAILURE_ALARM_MIN_FAILURES; i += 1) {
      h.tracker.recordFailure('ws', 'pump', OUTAGE_ERROR);
      h.advance(40_000);
    }
    h.tracker.recordFailure('ws', 'pump', OUTAGE_ERROR);
    expect(h.raise).toHaveBeenCalledTimes(2);
  });

  it('tracks legs and workspaces independently: a healthy pump does not mask a failing sweep', () => {
    const h = harness();
    for (let i = 0; i < PUMP_FAILURE_ALARM_MIN_FAILURES; i += 1) {
      h.tracker.recordFailure('ws-a', 'sweep', OUTAGE_ERROR);
      h.tracker.recordSuccess('ws-a', 'pump');
      h.tracker.recordSuccess('ws-b', 'sweep');
      h.advance(30_000);
    }
    expect(h.raise).toHaveBeenCalledTimes(1);
    expect(h.raise.mock.calls[0]![0]).toMatchObject({ workspaceId: 'ws-a', leg: 'sweep' });
    expect(h.tracker.streaks().map((s) => `${s.workspaceId}/${s.leg}/${s.alarmed}`)).toEqual(['ws-a/sweep/true']);
  });

  it('never throws into the pump when paging rejects or throws synchronously', async () => {
    const log = vi.fn();
    let t = 0;
    const tracker = createPumpHealthTracker({
      raise: () => Promise.reject(new Error('coord bus down')),
      clear: () => {
        throw new Error('sync boom');
      },
      log,
      now: () => t,
      minFailures: 1,
      minDurationMs: 0,
    });
    expect(() => tracker.recordFailure('ws', 'pump', OUTAGE_ERROR)).not.toThrow();
    t += 1;
    expect(() => tracker.recordSuccess('ws', 'pump')).not.toThrow();
    await vi.waitFor(() =>
      expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/wake-alarm failed \(non-fatal\): coord bus down/),
    );
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/wake-alarm resolve failed \(non-fatal\): sync boom/);
  });

  it('accepts non-Error throwables', () => {
    const h = harness();
    for (let i = 0; i < PUMP_FAILURE_ALARM_MIN_FAILURES; i += 1) {
      h.tracker.recordFailure('ws', 'pump', { code: 'XX000' });
      h.advance(PUMP_FAILURE_ALARM_MIN_DURATION_MS);
    }
    expect(h.raise.mock.calls[0]![0].lastError).toBe('{"code":"XX000"}');
  });
});

describe('pump-health alarm text', () => {
  const base: PumpFailureAlarm = {
    workspaceId: 'papercusp-workspace',
    leg: 'pump',
    failures: 37,
    failingSince: Date.parse('2026-10-10T20:28:00Z'),
    failingMs: 16 * 60_000,
    lastError: OUTAGE_ERROR.message,
    schemaMismatch: true,
  };

  it('classifies a missing column/relation as a code-ahead-of-schema mismatch', () => {
    expect(isSchemaMismatchError(OUTAGE_ERROR.message)).toBe(true);
    expect(isSchemaMismatchError('relation "harness_shared.event_wake_deliveries" does not exist')).toBe(true);
    expect(isSchemaMismatchError('column "short_user_turns_offset" does not exist')).toBe(true);
    expect(isSchemaMismatchError('Connection terminated unexpectedly')).toBe(false);
    expect(isSchemaMismatchError('function foo() does not exist')).toBe(false);
  });

  it('names the host, the impact and — for a schema mismatch — the withheld-migration cause', () => {
    const { summary, body } = pumpFailureAlarmText(base, 'bg-host:port-3271');
    expect(summary).toContain('bg-host:port-3271');
    expect(summary).toContain('wake pump FAILING for 16m');
    expect(summary).toContain('37 consecutive failures');
    expect(summary).toContain(OUTAGE_ERROR.message);
    expect(body).toContain('2026-10-10T20:28:00.000Z');
    expect(body).toMatch(/db:migrations/);
    expect(body).toMatch(/boot-migration-gate-withheld/);
    expect(body).toMatch(/resolves on the next successful pump run/);

    const generic = pumpFailureAlarmText({ ...base, schemaMismatch: false, lastError: 'boom' }, 'bg-host:port-3271');
    expect(generic.body).not.toMatch(/db:migrations/);
    expect(generic.body).toMatch(/logs:read/);
  });

  it('keys the condition by host, workspace and leg so recovery resolves the same page', () => {
    expect(pumpFailureConditionKey('bg-host:port-3271', 'papercusp-workspace', 'sweep')).toBe(
      'wake-pump-failing:bg-host:port-3271:papercusp-workspace:sweep',
    );
  });
});
