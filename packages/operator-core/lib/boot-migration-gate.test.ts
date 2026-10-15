/**
 * WI-10002822 — the background host's boot migration gate must recover IN PLACE.
 *
 * The incident this guards (2026-09-23): the gate failed at boot, the migrations were
 * applied out of band 1h39m later, and the tower's whole P2P substrate stayed down
 * until a human restarted bg-host, with no alarm. These tests replay that episode
 * against the real gate loop with a fake clock: fail → still failing → page once →
 * applied out of band → the gate RETURNS (the caller then boots the substrate).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BootMigrateResult } from './db-boot-migrate';

// Typed with the real signatures so `mock.calls[n][0]` is the real input type
// (an untyped `vi.fn(async () => {})` records calls as the empty tuple `[]`).
type NotifyAttention = typeof import('./attention-notify').notifyAttention;
type SevereEventBroadcastModule = typeof import('./severe-event-broadcast');
const notifyAttention = vi.fn<NotifyAttention>(async () => {});
const broadcastSevereEvent = vi.fn<SevereEventBroadcastModule['broadcastSevereEvent']>(async () => true);
const broadcastSevereEventResolved = vi.fn<SevereEventBroadcastModule['broadcastSevereEventResolved']>(async () => true);
vi.mock('./attention-notify', () => ({ notifyAttention: (...a: Parameters<NotifyAttention>) => notifyAttention(...a) }));
vi.mock('./severe-event-broadcast', () => ({
  broadcastSevereEvent: (...a: Parameters<SevereEventBroadcastModule['broadcastSevereEvent']>) => broadcastSevereEvent(...a),
  broadcastSevereEventResolved: (...a: Parameters<SevereEventBroadcastModule['broadcastSevereEventResolved']>) =>
    broadcastSevereEventResolved(...a),
}));

import {
  awaitBootMigrationGate,
  bootMigrationFailureSummary,
  bootMigrationGateConditionKey,
  clearBootMigrationGateAlarm,
  raiseBootMigrationGateAlarm,
  type BootMigrationGateAlarm,
  type BootMigrationGateDeps,
} from './boot-migration-gate';

const PENDING: BootMigrateResult = {
  applied: 0,
  failed: [
    { file: '1206-a.sql', error: 'pre-destructive snapshot admission failed (SQLSTATE 55000)' },
    { file: '1207-b.sql', error: 'pre-destructive snapshot admission failed (SQLSTATE 55000)' },
  ],
};
const CLEAN: BootMigrateResult = { applied: 0, failed: [] };

const MIN = 60_000;

/** A fake clock that only moves when the gate sleeps, plus call recorders. */
function harness(opts: {
  atBoot: BootMigrateResult | null;
  /** Result of the Nth retry (1-based); defaults to PENDING. */
  retry: (n: number) => BootMigrateResult | null;
  alarmAfterMs?: number;
}) {
  let clock = 1_000_000;
  const calls = {
    applyAtBoot: 0,
    applyRetry: 0,
    sleeps: [] as number[],
    withheld: [] as string[],
    raised: [] as BootMigrationGateAlarm[],
    cleared: [] as BootMigrationGateAlarm[],
    logs: [] as string[],
    errors: [] as string[],
  };
  const deps: BootMigrationGateDeps = {
    applyAtBoot: async () => {
      calls.applyAtBoot += 1;
      return opts.atBoot;
    },
    applyRetry: async () => {
      calls.applyRetry += 1;
      return opts.retry(calls.applyRetry);
    },
    onWithheld: (summary) => {
      calls.withheld.push(summary);
    },
    raiseAlarm: async (alarm) => {
      calls.raised.push(alarm);
    },
    clearAlarm: async (alarm) => {
      calls.cleared.push(alarm);
    },
    sleep: async (ms) => {
      calls.sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    log: (line) => calls.logs.push(line),
    error: (line) => calls.errors.push(line),
    retryIntervalMs: MIN,
    alarmAfterMs: opts.alarmAfterMs ?? 10 * MIN,
  };
  return { deps, calls };
}

beforeEach(() => {
  notifyAttention.mockClear();
  broadcastSevereEvent.mockClear();
  broadcastSevereEventResolved.mockClear();
});

describe('awaitBootMigrationGate', () => {
  it('passes straight through on a clean boot: no retry, no withhold, no sleep', async () => {
    const { deps, calls } = harness({ atBoot: CLEAN, retry: () => PENDING });
    const out = await awaitBootMigrationGate(deps);
    expect(out).toEqual({ result: CLEAN, recoveredInPlace: false, retries: 0, withheldMs: 0, alarmed: false });
    expect(calls.applyRetry).toBe(0);
    expect(calls.withheld).toEqual([]);
    expect(calls.sleeps).toEqual([]);
  });

  it('replays the 2026-09-23 outage: withheld at boot, applied out of band, recovers IN PLACE with one page', async () => {
    // Out-of-band apply lands before the 15th retry (15 minutes withheld).
    const { deps, calls } = harness({ atBoot: PENDING, retry: (n) => (n >= 15 ? CLEAN : PENDING) });
    const out = await awaitBootMigrationGate(deps);

    // The gate RETURNS — this is what lets host-bootstrap fall through into the
    // substrate boot without a restart. Before WI-10002822 it returned early forever.
    expect(out.recoveredInPlace).toBe(true);
    expect(out.result).toEqual(CLEAN);
    expect(out.retries).toBe(15);
    expect(out.withheldMs).toBe(15 * MIN);

    // The boot entry is called exactly once; every retry uses applyRetry.
    expect(calls.applyAtBoot).toBe(1);
    expect(calls.applyRetry).toBe(15);
    expect(calls.sleeps).toEqual(Array(15).fill(MIN));

    // The fail-closed routing decision is published once, with the pending files.
    expect(calls.withheld).toEqual(['2 migration(s) remain pending: 1206-a.sql, 1207-b.sql']);
    expect(calls.errors[0]).toMatch(/BACKGROUND STARTUP WITHHELD/);
    expect(calls.errors[0]).toMatch(/no restart needed/);

    // Paged exactly once, at the first retry at/after the 10-minute threshold…
    expect(out.alarmed).toBe(true);
    expect(calls.raised).toHaveLength(1);
    expect(calls.raised[0]).toMatchObject({ withheldMs: 10 * MIN, retries: 10 });
    // …and retracted on recovery.
    expect(calls.cleared).toHaveLength(1);
    expect(calls.cleared[0]).toMatchObject({ withheldMs: 15 * MIN, retries: 15 });
    expect(calls.logs.join('\n')).toMatch(/RECOVERED after 900s withheld \(15 retries\)/);
  });

  it('does not page (or retract) when the gate recovers before the alarm threshold', async () => {
    const { deps, calls } = harness({ atBoot: PENDING, retry: (n) => (n >= 3 ? CLEAN : PENDING) });
    const out = await awaitBootMigrationGate(deps);
    expect(out).toMatchObject({ recoveredInPlace: true, retries: 3, alarmed: false });
    expect(calls.raised).toEqual([]);
    expect(calls.cleared).toEqual([]);
  });

  it('keeps request startup withheld past eight failed checks, then recovers and clears its alarm in place', async () => {
    const { deps, calls } = harness({ atBoot: null, retry: (n) => n >= 12 ? CLEAN : PENDING });
    deps.plane = 'request';
    const out = await awaitBootMigrationGate(deps);
    expect(out).toMatchObject({ result: CLEAN, retries: 12, recoveredInPlace: true, alarmed: true });
    expect(calls.applyAtBoot).toBe(1);
    expect(calls.applyRetry).toBe(12);
    expect(calls.errors[0]).toMatch(/REQUEST STARTUP WITHHELD.*HTTP stays closed/);
    expect(calls.errors.join('\n')).not.toContain('request plane may still start');
    expect(calls.logs.join('\n')).toContain('starting the request plane in place');
    expect(calls.raised).toHaveLength(1);
    expect(calls.cleared).toHaveLength(1);
  });

  it('treats an undetermined (null) result as failed and keeps retrying through applyRetry', async () => {
    // A null at boot is what the once-per-process guard returns on a second call;
    // if the retry re-used that entry the gate could never pass. It must not.
    const { deps, calls } = harness({ atBoot: null, retry: (n) => (n === 1 ? null : CLEAN) });
    const out = await awaitBootMigrationGate(deps);
    expect(calls.withheld).toEqual(['migration state could not be determined']);
    expect(out).toMatchObject({ recoveredInPlace: true, retries: 2 });
    expect(calls.applyAtBoot).toBe(1);
  });

  it('never resolves while the gate stays failed, and pages only once however long it lasts', async () => {
    let retries = 0;
    const { deps, calls } = harness({
      atBoot: PENDING,
      retry: () => {
        retries += 1;
        if (retries > 40) throw new Error('stop-the-test');
        return PENDING;
      },
    });
    await expect(awaitBootMigrationGate(deps)).rejects.toThrow('stop-the-test');
    expect(calls.raised).toHaveLength(1);
    expect(calls.cleared).toEqual([]);
  });

  it('logs when the pending set changes, so the withheld reason stays current', async () => {
    const one: BootMigrateResult = { applied: 1, failed: [PENDING.failed[1]] };
    const { deps, calls } = harness({ atBoot: PENDING, retry: (n) => (n === 1 ? one : n === 2 ? one : CLEAN) });
    await awaitBootMigrationGate(deps);
    const stillWithheld = calls.errors.filter((l) => l.includes('still withheld'));
    expect(stillWithheld).toEqual(['[boot-migrate] background plane still withheld: 1 migration(s) remain pending: 1207-b.sql']);
  });
});

describe('bootMigrationFailureSummary', () => {
  it('names every pending file, or says the state is undetermined', () => {
    expect(bootMigrationFailureSummary(PENDING)).toBe('2 migration(s) remain pending: 1206-a.sql, 1207-b.sql');
    expect(bootMigrationFailureSummary(null)).toBe('migration state could not be determined');
  });
});

describe('production alarm legs', () => {
  const alarm: BootMigrationGateAlarm = {
    failureSummary: '2 migration(s) remain pending: 1206-a.sql, 1207-b.sql',
    withheldSince: Date.UTC(2026, 8, 23, 21, 50, 32),
    withheldMs: 12 * MIN,
    retries: 12,
  };

  it('pages the owner urgently and broadcasts a one-shot severe event keyed to this host', async () => {
    await raiseBootMigrationGateAlarm(alarm, 'bg-host:port-3271');
    expect(notifyAttention).toHaveBeenCalledTimes(1);
    expect(notifyAttention.mock.calls[0]).toEqual([
      expect.objectContaining({ kind: 'intervention', importance: 'urgent' }),
    ]);
    expect(broadcastSevereEvent).toHaveBeenCalledTimes(1);
    expect(broadcastSevereEvent.mock.calls[0]).toEqual([
      expect.objectContaining({
        conditionKey: bootMigrationGateConditionKey('bg-host:port-3271'),
        oneShot: true,
        summary: expect.stringMatching(/WITHHELD for 12m — 2 migration\(s\) remain pending/),
      }),
    ]);
  });

  it('resolves the same condition key on recovery', async () => {
    await clearBootMigrationGateAlarm(alarm, 'bg-host:port-3271');
    expect(broadcastSevereEventResolved).toHaveBeenCalledTimes(1);
    expect(broadcastSevereEventResolved.mock.calls[0]).toEqual([
      expect.objectContaining({ conditionKey: 'boot-migration-gate-withheld:bg-host:port-3271' }),
    ]);
  });

  it('request-only alarms name the closed HTTP plane and resolve the same condition', async () => {
    await raiseBootMigrationGateAlarm(alarm, 'request-host:port-3270', 'request');
    expect(notifyAttention.mock.calls[0][0]).toMatchObject({
      title: expect.stringContaining('Request plane withheld'),
      body: expect.stringContaining('request plane (HTTP)'),
    });
    expect(notifyAttention.mock.calls[0][0].body).not.toContain('replicating through this host is dark');
    await clearBootMigrationGateAlarm(alarm, 'request-host:port-3270', 'request');
    expect(broadcastSevereEventResolved.mock.calls[0][0]).toMatchObject({
      conditionKey: 'boot-migration-gate-withheld:request-host:port-3270',
      summary: expect.stringContaining('request plane (HTTP)'),
    });
  });

  it('never throws when a paging channel fails — a broken alarm must not wedge the retry loop', async () => {
    notifyAttention.mockRejectedValueOnce(new Error('pg down'));
    broadcastSevereEvent.mockRejectedValueOnce(new Error('coord down'));
    broadcastSevereEventResolved.mockRejectedValueOnce(new Error('coord down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(raiseBootMigrationGateAlarm(alarm, 'h')).resolves.toBeUndefined();
      await expect(clearBootMigrationGateAlarm(alarm, 'h')).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });
});
