/**
 * gc-desktop-sessions — the actuation and its safety envelope.
 * (agent-virtual-desktops-2026-08-23 P-005 / WI-40868.)
 *
 * The ladder itself is tested purely in desktop/desktop-lifecycle.test.ts. What
 * is tested HERE is the part a pure function cannot express: the ORDER in which
 * real side effects happen, and what the sweep does when one of them fails.
 *
 * The assertion that earns its place most is `thaws a frozen session BEFORE
 * killing it`. A signal delivered to a frozen cgroup is QUEUED, not handled —
 * the processes are stopped at the scheduler — so a reap that skips the thaw
 * reports "signalled" against a subtree that never dies and keeps holding its
 * display. It fails as a hang, hours later, in a sweep nobody is watching, and
 * it is invisible to every test that only asserts "kill was called".
 */
import { describe, expect, it, vi } from 'vitest';
import { gcDesktopSessions, type GcDesktopSessionsDeps } from './gc-desktop-sessions';
import type { DesktopSessionRecord } from '../../desktop/desktop-session-registry';
import type { ControlOutcome } from '../../task-manager/control';

const NOW = Date.UTC(2026, 7, 23, 12, 0, 0);
const ago = (sec: number) => new Date(NOW - sec * 1000);
const HOUR = 3600;

const ok = (taskId: string, action: string): ControlOutcome => ({ ok: true, taskId, action });
const fail = (taskId: string, action: string): ControlOutcome => ({
  ok: false,
  taskId,
  action,
  error: 'command_failed',
  detail: 'boom',
});

function session(over: Partial<DesktopSessionRecord> = {}): DesktopSessionRecord {
  return {
    id: 'ds-1',
    workspaceId: 'ws',
    harnessSlug: 'papercusp',
    kind: 'xvfb-local',
    scope: 'pot',
    scopeRef: 'pot-a',
    name: null,
    hostRef: null,
    ownerPid: 4242,
    ownerBootId: 'boot-1',
    display: ':110',
    displayGeometry: { width: 1024, height: 768, depth: 24 },
    captureGeometry: { width: 1024, height: 768 },
    state: 'ready',
    leaseHolder: null,
    viewerMode: 'none',
    viewerActor: null,
    capabilities: {},
    ttlSec: null,
    taskId: 'task-1',
    idleAfterSec: null,
    frozenAt: null,
    createdAt: ago(24 * HOUR),
    lastActiveAt: ago(5),
    releasedAt: null,
    ...over,
  };
}

/** A deps double that RECORDS the call order — the property under test. */
describe('P-004: agent desktops die with their owning session (D-007)', () => {
  it("reaps an active agent desktop whose owner session has ended, keeps a live owner's, never asks about pot rows", async () => {
    const dead = session({ id: 'agent-dead', scope: 'agent', scopeRef: 'owner-ended', taskId: 'task-dead' });
    const alive = session({ id: 'agent-live', scope: 'agent', scopeRef: 'owner-live', taskId: 'task-live' });
    const pot = session({ id: 'pot-row', taskId: 'task-pot' });
    const ownerSessionStates = vi.fn(async () => new Map<string, string | null>([['owner-ended', 'ended'], ['owner-live', 'live']]));
    const { d } = deps([dead, alive, pot], { ownerSessionStates });
    const res = await gcDesktopSessions({ now: NOW, deps: d });
    expect(ownerSessionStates).toHaveBeenCalledWith(['owner-ended', 'owner-live']);
    expect(res.reaped).toBe(1);
    expect(d.kill).toHaveBeenCalledWith('task-dead');
    expect(d.kill).not.toHaveBeenCalledWith('task-live');
    expect(res.sessions.find((s) => s.id === 'agent-dead')?.reason).toContain('has ended');
  });

  it('an unreadable oracle leaves agent desktops to the ordinary ladder', async () => {
    const row = session({ id: 'agent-x', scope: 'agent', scopeRef: 'owner-x', taskId: 'task-x' });
    const { d } = deps([row], { ownerSessionStates: vi.fn(async () => { throw new Error('pg down'); }) });
    const res = await gcDesktopSessions({ now: NOW, deps: d });
    expect(res.reaped).toBe(0);
    expect(d.kill).not.toHaveBeenCalled();
  });

  it('does not consult the oracle when there are no agent desktops', async () => {
    const { d } = deps([session()]);
    await gcDesktopSessions({ now: NOW, deps: d });
    expect(d.ownerSessionStates).not.toHaveBeenCalled();
  });
});

function deps(sessions: DesktopSessionRecord[], over: Partial<GcDesktopSessionsDeps> = {}) {
  const calls: string[] = [];
  const d: GcDesktopSessionsDeps = {
    list: vi.fn(async () => sessions) as unknown as GcDesktopSessionsDeps['list'],
    ownerSessionStates: vi.fn(async () => new Map<string, string | null>()),
    freeze: vi.fn(async (t: string) => {
      calls.push(`freeze:${t}`);
      return ok(t, 'freeze');
    }),
    thaw: vi.fn(async (t: string) => {
      calls.push(`thaw:${t}`);
      return ok(t, 'thaw');
    }),
    kill: vi.fn(async (t: string) => {
      calls.push(`kill:${t}`);
      return ok(t, 'kill');
    }),
    markIdle: vi.fn(async (id: string) => {
      calls.push(`markIdle:${id}`);
      return true;
    }),
    markFrozen: vi.fn(async (id: string) => {
      calls.push(`markFrozen:${id}`);
      return true;
    }),
    close: vi.fn(async (id: string) => {
      calls.push(`close:${id}`);
      return true;
    }),
    // Default: the live row is exactly the snapshot (nobody touched it mid-sweep).
    reread: vi.fn(async (s: DesktopSessionRecord) => sessions.find((x) => x.id === s.id)),
    ...over,
  };
  return { d, calls };
}

describe('gcDesktopSessions — actuation ordering', () => {
  it('THAWS a frozen session before killing it (a signal into a frozen cgroup is queued, not handled)', async () => {
    const { d, calls } = deps([
      session({ state: 'frozen', frozenAt: ago(30 * HOUR), lastActiveAt: ago(40 * HOUR) }),
    ]);
    const res = await gcDesktopSessions({ now: NOW, deps: d });

    expect(res.reaped).toBe(1);
    expect(calls).toEqual(['thaw:task-1', 'kill:task-1', 'close:ds-1']);
    // Stated as an index comparison too, so the intent survives a future test
    // that legitimately adds another call to the sequence.
    expect(calls.indexOf('thaw:task-1')).toBeLessThan(calls.indexOf('kill:task-1'));
  });

  it('does NOT thaw a session that was never frozen', async () => {
    const { d, calls } = deps([session({ ttlSec: 60, lastActiveAt: ago(2 * HOUR) })]);
    await gcDesktopSessions({ now: NOW, deps: d });
    expect(calls).toEqual(['kill:task-1', 'close:ds-1']);
  });

  it('writes the frozen row only AFTER the freezer reports success', async () => {
    const { d, calls } = deps([session({ state: 'idle', lastActiveAt: ago(4 * HOUR) })]);
    const res = await gcDesktopSessions({ now: NOW, deps: d });
    expect(res.frozen).toBe(1);
    expect(calls).toEqual(['freeze:task-1', 'markFrozen:ds-1']);
  });

  it('leaves the row alone when the freeze FAILS — a row saying frozen over a running cgroup is a lie', async () => {
    const { d, calls } = deps([session({ state: 'idle', lastActiveAt: ago(4 * HOUR) })], {
      freeze: vi.fn(async (t: string) => fail(t, 'freeze')),
    });
    const res = await gcDesktopSessions({ now: NOW, deps: d });

    expect(res.frozen).toBe(0);
    expect(res.failed).toBe(1);
    expect(calls).not.toContain('markFrozen:ds-1');
    expect(res.sessions[0]?.failed).toMatch(/freeze failed/);
  });

  it('still closes the row when the kill fails, and says so', async () => {
    // Documented trade: an open row keeps its display reserved in the uniqueness
    // index, so an unkillable session is worse left open than closed loudly.
    const { d } = deps([session({ ttlSec: 60, lastActiveAt: ago(2 * HOUR) })], {
      kill: vi.fn(async (t: string) => fail(t, 'kill')),
    });
    const res = await gcDesktopSessions({ now: NOW, deps: d });

    expect(res.reaped).toBe(1);
    expect(res.failed).toBe(1);
    expect(d.close).toHaveBeenCalledWith('ds-1');
    expect(res.sessions[0]?.failed).toMatch(/kill failed/);
  });
});

/**
 * WI-10006636 — the sweep classifies from ONE snapshot and acts on each row later.
 * A computer verb that drives a desktop in between must not have it frozen or
 * killed out from under it. `reread` is the live row at actuation time; a row
 * whose clock moved past the snapshot is a desktop someone is using.
 */
describe('gcDesktopSessions — a desktop driven mid-sweep is not frozen or reaped off the stale snapshot', () => {
  const touchedNow = (s: DesktopSessionRecord): DesktopSessionRecord => ({
    ...s,
    state: s.state === 'idle' ? 'ready' : s.state,
    lastActiveAt: new Date(NOW),
  });

  it('does not reap a lease-expired desktop that a computer verb touched after the scan', async () => {
    const snap = session({ ttlSec: 60, lastActiveAt: ago(2 * HOUR) });
    const { d, calls } = deps([snap], { reread: vi.fn(async () => touchedNow(snap)) });
    const res = await gcDesktopSessions({ now: NOW, deps: d });

    expect(calls).toEqual([]);
    expect(res.reaped).toBe(0);
    expect(res.stoodDown).toBe(1);
    expect(res.sessions[0]?.stoodDown).toMatch(/driven since the scan/);
  });

  it('does not reap a long-frozen desktop that its owner thawed and drove after the scan', async () => {
    // prepareDesktopForDrive thaws + markThawed (state → ready, frozen_at NULL,
    // clock bumped) before the verb's input lands — the live row says so.
    const snap = session({ state: 'frozen', frozenAt: ago(30 * HOUR), lastActiveAt: ago(40 * HOUR) });
    const thawedAndDriven = { ...snap, state: 'ready' as const, frozenAt: null, lastActiveAt: new Date(NOW) };
    const { d, calls } = deps([snap], { reread: vi.fn(async () => thawedAndDriven) });
    const res = await gcDesktopSessions({ now: NOW, deps: d });

    expect(calls).toEqual([]);
    expect(res.reaped).toBe(0);
  });

  it("does not reap an ended owner's agent desktop while a verb is still driving it — it waits a sweep", async () => {
    const snap = session({ scope: 'agent', scopeRef: 'su-gone', lastActiveAt: ago(5) });
    const { d, calls } = deps([snap], {
      ownerSessionStates: vi.fn(async () => new Map([['su-gone', 'ended']])),
      reread: vi.fn(async () => touchedNow(snap)),
    });
    const res = await gcDesktopSessions({ now: NOW, deps: d });

    expect(calls).toEqual([]);
    expect(res.stoodDown).toBe(1);
  });

  it('does not freeze an idle desktop that was driven after the scan', async () => {
    const snap = session({ state: 'idle', lastActiveAt: ago(4 * HOUR) });
    const { d, calls } = deps([snap], { reread: vi.fn(async () => touchedNow(snap)) });
    const res = await gcDesktopSessions({ now: NOW, deps: d });

    expect(calls).toEqual([]);
    expect(res.frozen).toBe(0);
  });

  it('passes the snapshot clock to the row write, so the database refuses a freeze over a later touch', async () => {
    const snap = session({ state: 'idle', lastActiveAt: ago(4 * HOUR) });
    const { d } = deps([snap]);
    await gcDesktopSessions({ now: NOW, deps: d });
    expect(d.markFrozen).toHaveBeenCalledWith('ds-1', snap.lastActiveAt);
  });

  it('THAWS IT BACK when a verb touches it while the freezer runs (the guarded row write refused)', async () => {
    const snap = session({ state: 'idle', lastActiveAt: ago(4 * HOUR) });
    // First read (the pre-actuation re-check) still matches the snapshot; the
    // touch lands inside the freeze window, so the read after the refusal sees it.
    const reread = vi
      .fn<(s: DesktopSessionRecord) => Promise<DesktopSessionRecord | undefined>>()
      .mockResolvedValueOnce(snap)
      .mockResolvedValueOnce(touchedNow(snap));
    const { d, calls } = deps([snap], {
      reread,
      markFrozen: vi.fn(async (id: string) => {
        calls.push(`markFrozen:${id}`);
        return false;
      }),
    });
    const res = await gcDesktopSessions({ now: NOW, deps: d });

    expect(calls).toEqual(['freeze:task-1', 'markFrozen:ds-1', 'thaw:task-1']);
    expect(res.frozen).toBe(0);
    expect(res.stoodDown).toBe(1);
    expect(res.sessions[0]?.stoodDown).toMatch(/thawed back/);
  });

  it('does NOT thaw back when a concurrent sweep already recorded the freeze (the row would become a lie)', async () => {
    const snap = session({ state: 'idle', lastActiveAt: ago(4 * HOUR) });
    const reread = vi
      .fn<(s: DesktopSessionRecord) => Promise<DesktopSessionRecord | undefined>>()
      .mockResolvedValueOnce(snap)
      .mockResolvedValueOnce({ ...snap, state: 'frozen', frozenAt: new Date(NOW) });
    const { d, calls } = deps([snap], {
      reread,
      markFrozen: vi.fn(async (id: string) => {
        calls.push(`markFrozen:${id}`);
        return false;
      }),
    });
    await gcDesktopSessions({ now: NOW, deps: d });

    expect(calls).toEqual(['freeze:task-1', 'markFrozen:ds-1']);
  });

  it('reports a failed thaw-back loudly — suspended processes under a live row are the hang this prevents', async () => {
    const snap = session({ state: 'idle', lastActiveAt: ago(4 * HOUR) });
    const reread = vi
      .fn<(s: DesktopSessionRecord) => Promise<DesktopSessionRecord | undefined>>()
      .mockResolvedValueOnce(snap)
      .mockResolvedValueOnce(touchedNow(snap));
    const { d } = deps([snap], {
      reread,
      markFrozen: vi.fn(async () => false),
      thaw: vi.fn(async (t: string) => fail(t, 'thaw')),
    });
    const res = await gcDesktopSessions({ now: NOW, deps: d });

    expect(res.failed).toBe(1);
    expect(res.sessions[0]?.failed).toMatch(/thaw-back failed/);
  });

  it('stands down when the row cannot be re-read — acting blind could kill a desktop mid-verb', async () => {
    const { d, calls } = deps([session({ ttlSec: 60, lastActiveAt: ago(2 * HOUR) })], {
      reread: vi.fn(async () => {
        throw new Error('pg down');
      }),
    });
    const res = await gcDesktopSessions({ now: NOW, deps: d });

    expect(calls).toEqual([]);
    expect(res.sessions[0]?.stoodDown).toMatch(/could not re-read/);
  });

  it('stands down when the row was closed since the scan (someone else released it)', async () => {
    const snap = session({ ttlSec: 60, lastActiveAt: ago(2 * HOUR) });
    const { d, calls } = deps([snap], {
      reread: vi.fn(async () => ({ ...snap, state: 'released' as const, releasedAt: new Date(NOW) })),
    });
    await gcDesktopSessions({ now: NOW, deps: d });
    expect(calls).toEqual([]);
  });

  it('stands down when the live row re-judges differently, clock unchanged (a concurrent sweep froze it first)', async () => {
    const snap = session({ state: 'idle', lastActiveAt: ago(4 * HOUR) });
    const { d, calls } = deps([snap], {
      reread: vi.fn(async () => ({ ...snap, state: 'frozen' as const, frozenAt: new Date(NOW) })),
    });
    const res = await gcDesktopSessions({ now: NOW, deps: d });

    expect(calls).toEqual([]);
    expect(res.sessions[0]?.stoodDown).toMatch(/re-judged as keep/);
  });

  it('acts normally when the live row matches the snapshot', async () => {
    const { d, calls } = deps([session({ ttlSec: 60, lastActiveAt: ago(2 * HOUR) })]);
    const res = await gcDesktopSessions({ now: NOW, deps: d });
    expect(calls).toEqual(['kill:task-1', 'close:ds-1']);
    expect(res.stoodDown).toBe(0);
  });
});

describe('gcDesktopSessions — an unenrolled desktop is reported, never silently skipped', () => {
  it('cannot freeze a session with no task_id, and says exactly that', async () => {
    const { d } = deps([
      session({ taskId: null, state: 'idle', lastActiveAt: ago(4 * HOUR) }),
    ]);
    const res = await gcDesktopSessions({ now: NOW, deps: d });

    expect(res.frozen).toBe(0);
    expect(res.failed).toBe(1);
    expect(d.freeze).not.toHaveBeenCalled();
    expect(res.sessions[0]?.failed).toMatch(/cannot freeze an unenrolled desktop/);
  });

  it('reaps the RECORD of an unenrolled session but reports that the processes survived', async () => {
    const { d } = deps([session({ taskId: null, ttlSec: 60, lastActiveAt: ago(2 * HOUR) })]);
    const res = await gcDesktopSessions({ now: NOW, deps: d });

    expect(res.reaped).toBe(1);
    expect(d.kill).not.toHaveBeenCalled();
    expect(d.close).toHaveBeenCalledWith('ds-1');
    expect(res.sessions[0]?.failed).toMatch(/processes were not reclaimed/);
  });
});

describe('gcDesktopSessions — the safety envelope', () => {
  it('actuates nothing under dryRun but still reports what it would do', async () => {
    const { d, calls } = deps([
      session({ id: 'a', state: 'idle', lastActiveAt: ago(4 * HOUR) }),
      session({ id: 'b', display: ':111', ttlSec: 60, lastActiveAt: ago(2 * HOUR) }),
    ]);
    const res = await gcDesktopSessions({ now: NOW, dryRun: true, deps: d });

    expect(calls).toEqual([]);
    expect(res.frozen).toBe(1);
    expect(res.reaped).toBe(1);
    expect(res.dryRun).toBe(true);
  });

  it('caps ACTIONS per run and reports the deferrals rather than hiding them', async () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      session({ id: `ds-${i}`, display: `:${200 + i}`, taskId: `t-${i}`, state: 'idle', lastActiveAt: ago(4 * HOUR) }),
    );
    const { d } = deps(many);
    const res = await gcDesktopSessions({ now: NOW, maxPerRun: 2, deps: d });

    expect(res.frozen).toBe(2);
    expect(d.freeze).toHaveBeenCalledTimes(2);
    expect(res.sessions.filter((s) => s.failed?.includes('per-run cap'))).toHaveLength(3);
    expect(res.scanned).toBe(5);
  });

  it('never touches a protected display, and keeps it VISIBLE in the report', async () => {
    const { d, calls } = deps([
      session({ display: ':0', ttlSec: 60, lastActiveAt: ago(48 * HOUR) }),
    ]);
    const res = await gcDesktopSessions({ now: NOW, deps: d });

    expect(calls).toEqual([]);
    expect(res.reaped).toBe(0);
    expect(res.refused).toBe(1);
    // A permanently-skipped session that says nothing is indistinguishable from
    // a governor that is not running.
    expect(res.sessions[0]?.refused).toBe(true);
  });

  it("never touches a scope='workspace' desktop", async () => {
    const { d, calls } = deps([
      session({ scope: 'workspace', ttlSec: 60, lastActiveAt: ago(48 * HOUR) }),
    ]);
    const res = await gcDesktopSessions({ now: NOW, deps: d });
    expect(calls).toEqual([]);
    expect(res.refused).toBe(1);
  });

  it('reads only THIS host by default — it can only freeze cgroups it can reach', async () => {
    const { d } = deps([]);
    await gcDesktopSessions({ now: NOW, deps: d });
    expect(d.list).toHaveBeenCalledWith({ hostRef: null });
  });

  it('leaves busy desktops out of the report entirely (an hourly log should be quiet)', async () => {
    const { d, calls } = deps([session({ lastActiveAt: ago(5) })]);
    const res = await gcDesktopSessions({ now: NOW, deps: d });
    expect(calls).toEqual([]);
    expect(res.sessions).toEqual([]);
    expect(res.scanned).toBe(1);
  });
});
