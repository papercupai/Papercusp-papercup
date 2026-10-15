/**
 * prepareDesktopForDrive — what a computer:* verb does to its desktop before any
 * input lands (WI-10006636).
 *
 * Two properties, both about never sending input into a suspended X server:
 *
 *  1. THAW-AFTER-FREEZE. A desktop the lifecycle sweep froze while its owner was
 *     away is thawed (processes first, row second) BEFORE the touch, so the
 *     verb's input reaches a running display.
 *  2. A FREEZE THAT LANDS UNDER A LIVE DRIVE. The verb resolved the desktop as
 *     `ready`, then the sweep froze it before the touch. The touch reports the
 *     post-touch state; `frozen` means thaw now. Paired with the sweep's guarded
 *     row write (gc-desktop-sessions.test.ts), either ordering ends thawed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareDesktopForDrive, type DesktopTargetDeps } from './desktop-target';
import type { DesktopSessionRecord, DesktopState } from '../../desktop/desktop-session-registry';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

function session(over: Partial<DesktopSessionRecord> = {}): DesktopSessionRecord {
  return {
    id: 'ds-1',
    workspaceId: 'ws',
    harnessSlug: 'papercusp',
    kind: 'xvfb-local',
    scope: 'agent',
    scopeRef: 'su-me',
    name: 'work',
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
    createdAt: new Date(NOW - 3_600_000),
    lastActiveAt: new Date(NOW - 7_200_000),
    releasedAt: null,
    ...over,
  };
}

/** A deps double that records the ORDER of calls — the property under test. */
function deps(touchReturns: DesktopState | undefined, over: Partial<DesktopTargetDeps> = {}) {
  const calls: string[] = [];
  const d: DesktopTargetDeps = {
    thaw: vi.fn(async (taskId: string) => {
      calls.push(`thaw:${taskId}`);
    }),
    markThawed: vi.fn(async (id: string) => {
      calls.push(`markThawed:${id}`);
      return true;
    }) as unknown as DesktopTargetDeps['markThawed'],
    touch: vi.fn(async (id: string) => {
      calls.push(`touch:${id}`);
      return touchReturns;
    }) as unknown as DesktopTargetDeps['touch'],
    ...over,
  };
  return { d, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('prepareDesktopForDrive — thaw-after-freeze', () => {
  it('thaws a frozen desktop (processes, then row) BEFORE the touch and the input', async () => {
    const { d, calls } = deps('ready');
    await prepareDesktopForDrive(session({ state: 'frozen', frozenAt: new Date(NOW - 1_800_000) }), d);
    expect(calls).toEqual(['thaw:task-1', 'markThawed:ds-1', 'touch:ds-1']);
  });

  it('does not thaw a desktop that is not frozen', async () => {
    const { d, calls } = deps('ready');
    await prepareDesktopForDrive(session({ state: 'idle' }), d);
    expect(calls).toEqual(['touch:ds-1']);
  });

  it('still touches when the thaw throws, and says so (driving it may hang)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { d, calls } = deps('ready', {
      thaw: vi.fn(async () => {
        throw new Error('cgroup gone');
      }),
    });
    await prepareDesktopForDrive(session({ state: 'frozen', frozenAt: new Date(NOW) }), d);
    expect(calls).toEqual(['touch:ds-1']);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/thawing frozen desktop ds-1 before driving it failed/));
  });
});

describe('prepareDesktopForDrive — a freeze that lands between resolution and the touch', () => {
  it('thaws when the touch reports the desktop frozen under a live drive', async () => {
    const { d, calls } = deps('frozen');
    await prepareDesktopForDrive(session({ state: 'ready' }), d);
    expect(calls).toEqual(['touch:ds-1', 'thaw:task-1', 'markThawed:ds-1']);
  });

  it('does not thaw twice when it already thawed at resolution', async () => {
    const { d, calls } = deps('frozen');
    await prepareDesktopForDrive(session({ state: 'frozen', frozenAt: new Date(NOW) }), d);
    expect(calls.filter((c) => c.startsWith('thaw:'))).toHaveLength(1);
  });

  it('leaves a desktop alone when the touch finds no live row (reaped or released)', async () => {
    const { d, calls } = deps(undefined);
    await prepareDesktopForDrive(session({ state: 'ready' }), d);
    expect(calls).toEqual(['touch:ds-1']);
  });

  it('cannot thaw an unenrolled desktop (no task) and does not pretend to', async () => {
    const { d, calls } = deps('frozen');
    await prepareDesktopForDrive(session({ state: 'ready', taskId: null }), d);
    expect(calls).toEqual(['touch:ds-1']);
  });
});
