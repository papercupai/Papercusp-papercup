import { describe, it, expect } from 'vitest';
import {
  deriveWakeReachability,
  probeWakeReachability,
  type WakeReachabilityInput,
} from './wake-reachability';

/** A reachable baseline: standing await present, exited+resumable (the common console-loop path). */
const BASE: WakeReachabilityInput = {
  wakeable: true,
  ended: true,
  pid: null,
  pidAlive: false,
  hasPsuHost: false,
  hasManagedPty: false,
  resumable: true,
  presenceFresh: false,
};

describe('deriveWakeReachability — channel ladder mirrors executeWake', () => {
  it('gate 1: no standing await ⇒ none + loud no-session-now warning (the WI-655 root cause)', () => {
    const v = deriveWakeReachability({ ...BASE, wakeable: false, hasPsuHost: true });
    expect(v.reachable).toBe(false);
    expect(v.channel).toBe('none');
    expect(v.warning).toMatch(/no inbox-wake watch is armed/i);
    expect(v.warning).toMatch(/no-session-now/i);
  });

  // WI-36685 — gate 1 used to discard every liveness signal before returning, so "this session is
  // gone" and "this session is alive but nobody wired its doorbell" were byte-identical verdicts
  // with opposite remedies. `reachable`/`channel` are unchanged (asserted above and below);
  // `awaitRepairable` is the distinction that was missing.
  describe('gate 1 repairability (WI-36685)', () => {
    it('no await + a live psu-host socket ⇒ awaitRepairable, naming the channel a re-arm would restore', () => {
      const v = deriveWakeReachability({ ...BASE, wakeable: false, ended: false, pid: 1, pidAlive: true, hasPsuHost: true });
      expect(v.reachable).toBe(false); // unchanged — a wake right now still would not land
      expect(v.channel).toBe('none'); // unchanged
      expect(v.awaitRepairable).toBe(true);
      expect(v.wouldBeChannel).toBe('psu-socket');
      expect(v.warning).toMatch(/REPAIRABLE/);
    });

    it('no await + resumable ⇒ repairable via resume', () => {
      const v = deriveWakeReachability({ ...BASE, wakeable: false });
      expect(v.awaitRepairable).toBe(true);
      expect(v.wouldBeChannel).toBe('resume');
      expect(v.summary).toContain('resumable handle');
      expect(v.summary).not.toContain('otherwise live');
      expect(v.warning).toContain('starts a fresh process');
      expect(v.warning).not.toContain('the process is alive and injectable');
      expect(v.durableWhileAlive).toBe(false);
    });

    it('a repairable resume of an uninjectable live process still waits for its exit', () => {
      const v = deriveWakeReachability({
        ...BASE, wakeable: false, ended: false, pid: 17, pidAlive: true,
      });
      expect(v.wouldBeChannel).toBe('resume');
      expect(v.summary).toContain('after the previous process exits');
      expect(v.warning).toContain('once the previous process has exited');
      expect(v.warning).not.toContain('would take the resume channel the moment');
    });

    it('CONTROL — no await AND nothing live/resumable (a corpse) ⇒ NOT repairable', () => {
      // The load-bearing case: without this, `awaitRepairable` would just be "!wakeable" renamed,
      // and every caller keying a repair on it would happily arm a watch for a dead session.
      const v = deriveWakeReachability({
        ...BASE,
        wakeable: false,
        ended: true,
        resumable: false,
        presenceFresh: false,
      });
      expect(v.awaitRepairable).toBe(false);
      expect(v.wouldBeChannel).toBeNull();
      expect(v.warning).not.toMatch(/REPAIRABLE/);
    });

    it('CONTROL — no await + alive but only inbox-only ⇒ NOT repairable (arming would not produce a turn)', () => {
      const v = deriveWakeReachability({
        ...BASE,
        wakeable: false,
        ended: false,
        pid: 5,
        pidAlive: true,
        resumable: false,
        presenceFresh: true,
      });
      // As-if-armed this owner reaches `inbox-only`, which is reachable:false — wakes would park
      // rather than become a fresh turn, so a re-arm changes how it LOOKS and not what it does.
      expect(v.awaitRepairable).toBe(false);
      expect(v.wouldBeChannel).toBeNull();
    });

    it('a satisfied gate never reports repairability (nothing was blocking)', () => {
      for (const i of [
        { ...BASE },
        { ...BASE, ended: false, pid: 1, pidAlive: true, hasPsuHost: true },
        { ...BASE, ended: true, resumable: false, presenceFresh: false },
      ]) {
        const v = deriveWakeReachability(i);
        expect(v.awaitRepairable).toBe(false);
        expect(v.wouldBeChannel).toBeNull();
      }
    });
  });

  it('psu-host socket ⇒ reachable via psu-socket, durable while alive (best path, beats pid logic)', () => {
    const v = deriveWakeReachability({ ...BASE, ended: false, pid: 123, pidAlive: true, hasPsuHost: true, resumable: false });
    expect(v).toMatchObject({ reachable: true, channel: 'psu-socket', durableWhileAlive: true });
    expect(v.warning).toBeUndefined();
  });

  it('live managed pty ⇒ reachable via managed-pty, durable while alive', () => {
    const v = deriveWakeReachability({ ...BASE, ended: false, pid: 999, pidAlive: true, hasManagedPty: true, resumable: false });
    expect(v).toMatchObject({ reachable: true, channel: 'managed-pty', durableWhileAlive: true });
    expect(v.warning).toBeUndefined();
  });

  it('exited + resumable ⇒ reachable via resume, NOT durable while alive, no warning', () => {
    const v = deriveWakeReachability({ ...BASE, ended: true, resumable: true });
    expect(v).toMatchObject({ reachable: true, channel: 'resume', durableWhileAlive: false });
    expect(v.warning).toBeUndefined();
  });

  it('ALIVE + uninjectable + resumable ⇒ resume but DEGRADED (the dead-zone warning)', () => {
    // The exact shape of a resumed/curl-driven su session: alive, no psu-host, no managed pty,
    // resumable handle. Reachable in principle (resume after exit) but a persistent process parks.
    const v = deriveWakeReachability({
      ...BASE,
      ended: false,
      pid: 555,
      pidAlive: true,
      hasPsuHost: false,
      hasManagedPty: false,
      resumable: true,
      presenceFresh: true,
    });
    expect(v).toMatchObject({ reachable: true, channel: 'resume', durableWhileAlive: false });
    expect(v.warning).toMatch(/PARK as inbox-only until it exits/i);
  });

  it('alive + uninjectable + NOT resumable ⇒ inbox-only, NOT reachable, loud warning', () => {
    const v = deriveWakeReachability({
      ...BASE,
      ended: false,
      pid: 777,
      pidAlive: true,
      resumable: false,
      presenceFresh: true,
    });
    expect(v).toMatchObject({ reachable: false, channel: 'inbox-only' });
    expect(v.warning).toMatch(/NOT wake-reachable as a fresh turn/i);
  });

  it('exited + not resumable + presence fresh ⇒ inbox-only, not reachable', () => {
    const v = deriveWakeReachability({ ...BASE, ended: true, resumable: false, presenceFresh: true });
    expect(v).toMatchObject({ reachable: false, channel: 'inbox-only' });
  });

  it('dead: exited + not resumable + not present ⇒ none, not reachable', () => {
    const v = deriveWakeReachability({ ...BASE, ended: true, resumable: false, presenceFresh: false });
    expect(v).toMatchObject({ reachable: false, channel: 'none' });
    expect(v.warning).toMatch(/dead session/i);
  });

  it('no-pid + fresh presence (hook-bootstrapped) treated alive; uninjectable+unresumable ⇒ inbox-only', () => {
    const v = deriveWakeReachability({
      ...BASE,
      ended: false,
      pid: null,
      pidAlive: false,
      resumable: false,
      presenceFresh: true,
    });
    expect(v).toMatchObject({ reachable: false, channel: 'inbox-only' });
  });
});

describe('probeWakeReachability — IO seam wiring (injected deps, fail-soft)', () => {
  const liveHandle = {
    handle: {
      kind: 'adv-session' as const,
      advSessionId: 42,
      agent: 'claude',
      sessionId: 'uuid-1',
      ompThreadId: null,
      cwd: '/tmp/x',
      pid: 4242,
    },
    note: 'ok',
  };

  it('no standing await ⇒ none, regardless of a live resumable session', async () => {
    const v = await probeWakeReachability('su-x', {
      captureHandle: async () => liveHandle,
      getSession: async () => ({ endedAt: null, pid: 4242 }) as any,
      findPsuHost: async () => null,
      findPty: () => null,
      presence: async () => ({ stale: false, revoked: false }) as any,
      listAwaits: async () => [], // ← no standing await
      alive: () => true,
    });
    expect(v.channel).toBe('none');
    expect(v.reachable).toBe(false);
  });

  it('live psu-host socket ⇒ psu-socket', async () => {
    const v = await probeWakeReachability('su-x', {
      captureHandle: async () => liveHandle,
      getSession: async () => ({ endedAt: null, pid: 4242 }) as any,
      findPsuHost: async () => ({ sock: '/run/psu.sock' }) as any,
      findPty: () => null,
      presence: async () => ({ stale: false, revoked: false }) as any,
      listAwaits: async () => [{ id: 1 }] as any,
      alive: () => true,
    });
    expect(v).toMatchObject({ reachable: true, channel: 'psu-socket' });
  });

  it('exited claude session with native id ⇒ resume', async () => {
    const v = await probeWakeReachability('su-x', {
      captureHandle: async () => liveHandle,
      getSession: async () => ({ endedAt: '2026-06-23T00:00:00Z', pid: 4242 }) as any,
      findPsuHost: async () => null,
      findPty: () => null,
      presence: async () => ({ stale: true, revoked: false }) as any,
      listAwaits: async () => [{ id: 1 }] as any,
      alive: () => false,
    });
    expect(v).toMatchObject({ reachable: true, channel: 'resume' });
  });

  it('fail-soft: a throwing dep degrades to a conservative signal, never throws', async () => {
    const v = await probeWakeReachability('su-x', {
      captureHandle: async () => {
        throw new Error('boom');
      },
      getSession: async () => {
        throw new Error('boom');
      },
      findPsuHost: async () => {
        throw new Error('boom');
      },
      findPty: () => {
        throw new Error('boom');
      },
      presence: async () => {
        throw new Error('boom');
      },
      listAwaits: async () => {
        throw new Error('boom');
      },
      alive: () => false,
    });
    // Everything failed ⇒ no await, no handle, no presence ⇒ none (not reachable), but it RETURNED.
    expect(v.reachable).toBe(false);
    expect(v.channel).toBe('none');
  });
});
