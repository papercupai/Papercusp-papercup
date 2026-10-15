import { describe, expect, it } from 'vitest';

import type { GatewayListenerReadiness, GatewayReadinessDeps } from './restart';
import { waitForGatewayRestartReadiness } from './restart';

/**
 * WI-10005747 (EI-24792459933326276) — `dev:restart target:gateway` reported `ready:false` for a
 * restart that succeeded: the readiness wait probed the listener ONCE at the instant MainPID
 * changed and returned on the first miss (and on one failed /healthz), instead of polling to the
 * same 20s deadline as the PID phase. These tests drive the wait with a VIRTUAL clock and injected
 * probes, so they are instant and deterministic.
 */

const WAIT_MS = 20_000;
const POLL_MS = 250;
const OLD_PID = 4242;
const NEW_PID = 5252;

type Timeline = {
  /** virtual ms at which MainPID flips from OLD_PID to NEW_PID (Infinity = never) */
  pidAtMs: number;
  /** virtual ms at which the new PID owns the listener (Infinity = never) */
  listenerAtMs: number;
  /** virtual ms at which /healthz first answers (Infinity = never) */
  healthAtMs: number;
};

function harness(timeline: Timeline, opts: { serviceReadsFailAfterPidChange?: boolean } = {}) {
  let t = 0;
  const calls = { service: 0, listener: 0, health: 0 };
  const deps: GatewayReadinessDeps = {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    waitMs: WAIT_MS,
    pollMs: POLL_MS,
    readService: async () => {
      calls.service += 1;
      if (t >= timeline.pidAtMs) {
        return opts.serviceReadsFailAfterPidChange && calls.service > 1 && t > timeline.pidAtMs + POLL_MS
          ? null
          : { mainPid: NEW_PID };
      }
      return { mainPid: OLD_PID };
    },
    probeListener: async (pid): Promise<GatewayListenerReadiness> => {
      calls.listener += 1;
      const ownedByPid = t >= timeline.listenerAtMs;
      return {
        port: 8788,
        checked: true,
        ownedByPid,
        ownerVisible: true,
        observedPids: ownedByPid ? [pid] : [],
        detail: ownedByPid ? `listener belongs to ${pid}` : 'no listener was observed on :8788',
      };
    },
    probeHealth: async () => {
      calls.health += 1;
      return t >= timeline.healthAtMs
        ? { reachable: true, detail: 'HTTP 200' }
        : { reachable: false, detail: 'ConnectionRefused' };
    },
  };
  return { deps, calls, clock: () => t };
}

describe('waitForGatewayRestartReadiness polls the listener + health to the deadline (WI-10005747)', () => {
  it('(a) pid at 1s, listener at 12s, health at 13s -> ready:true (the old code returned ready:false at ~1s)', async () => {
    const { deps, calls } = harness({ pidAtMs: 1_000, listenerAtMs: 12_000, healthAtMs: 13_000 });
    const out = await waitForGatewayRestartReadiness(OLD_PID, deps);
    expect(out).toMatchObject({
      ready: true,
      pidChanged: true,
      observedPid: NEW_PID,
      listener: { ownedByPid: true },
      health: { reachable: true },
    });
    expect(out.waitedMs).toBeGreaterThanOrEqual(13_000);
    expect(out.waitedMs).toBeLessThan(WAIT_MS);
    expect(calls.listener).toBeGreaterThan(1);
  });

  it('(b) the listener never appears -> ready:false only AFTER the full budget, with the last listener evidence', async () => {
    const { deps, calls } = harness({ pidAtMs: 1_000, listenerAtMs: Infinity, healthAtMs: Infinity });
    const out = await waitForGatewayRestartReadiness(OLD_PID, deps);
    expect(out).toMatchObject({
      ready: false,
      pidChanged: true,
      observedPid: NEW_PID,
      listener: { ownedByPid: false, detail: expect.stringContaining('no listener') },
      health: null,
    });
    expect(out.waitedMs).toBeGreaterThanOrEqual(WAIT_MS);
    expect(calls.listener).toBeGreaterThan(10);
    expect(calls.health).toBe(0);
  });

  it('(c) the first /healthz fails and a later one succeeds -> ready:true', async () => {
    const { deps, calls } = harness({ pidAtMs: 500, listenerAtMs: 500, healthAtMs: 750 });
    const out = await waitForGatewayRestartReadiness(OLD_PID, deps);
    expect(out).toMatchObject({ ready: true, health: { reachable: true } });
    expect(calls.health).toBeGreaterThanOrEqual(2);
  });

  it('(d) listener up but /healthz never answers -> ready:false after the budget, carrying the last health failure', async () => {
    const { deps } = harness({ pidAtMs: 0, listenerAtMs: 0, healthAtMs: Infinity });
    const out = await waitForGatewayRestartReadiness(OLD_PID, deps);
    expect(out).toMatchObject({
      ready: false,
      pidChanged: true,
      listener: { ownedByPid: true },
      health: { reachable: false, detail: 'ConnectionRefused' },
    });
    expect(out.waitedMs).toBeGreaterThanOrEqual(WAIT_MS);
  });

  it('CALIBRATION: the PID never changes -> ready:false, pidChanged:false, never probes the listener', async () => {
    const { deps, calls } = harness({ pidAtMs: Infinity, listenerAtMs: 0, healthAtMs: 0 });
    const out = await waitForGatewayRestartReadiness(OLD_PID, deps);
    expect(out).toMatchObject({ ready: false, pidChanged: false, observedPid: OLD_PID, listener: null, health: null });
    expect(out.waitedMs).toBeGreaterThanOrEqual(WAIT_MS);
    expect(calls.listener).toBe(0);
    expect(calls.health).toBe(0);
  });

  it('the replacement PID is sticky: a fail-soft empty service read after the change does not forget it', async () => {
    const { deps } = harness(
      { pidAtMs: 200, listenerAtMs: 5_000, healthAtMs: 5_000 },
      { serviceReadsFailAfterPidChange: true },
    );
    const out = await waitForGatewayRestartReadiness(OLD_PID, deps);
    expect(out).toMatchObject({ ready: true, pidChanged: true, observedPid: NEW_PID });
  });
});
