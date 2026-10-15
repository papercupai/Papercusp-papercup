/**
 * Plan agent-multi-desktops-grid-2026-10-06, rubric bar R-2 (P-003 / D-005):
 * every computer verb drives the desktop the agent NAMED — not the most recent one,
 * not the env display, not another agent's desktop of the same name.
 *
 * desktop-target.test.ts proves the shared resolver. This file proves the WIRING:
 * each of the four verbs (capability:computer, computer:observe,
 * computer:click_element, computer:record) is called through its real handler with
 * `desktop`, and every X / AT-SPI process it launches is checked for the DISPLAY it
 * is bound to. Only the registry rows (Postgres) and the process launcher (X) are
 * substituted; resolveBoundDisplay, resolveAgentDesktop and the ownership check run
 * for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopSessionRecord } from '../../desktop/desktop-session-registry';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function row(over: Partial<DesktopSessionRecord>): DesktopSessionRecord {
  return {
    id: ID(1),
    workspaceId: 'ws',
    harnessSlug: 'pot-1',
    kind: 'kasmvnc',
    scope: 'agent',
    scopeRef: 'agent-a',
    name: 'desktop-1',
    hostRef: null,
    ownerPid: null,
    ownerBootId: null,
    display: ':120',
    displayGeometry: { width: 1280, height: 800, depth: 24 },
    captureGeometry: { width: 1280, height: 800 },
    state: 'ready',
    leaseHolder: 'agent-a',
    viewerMode: 'none',
    viewerActor: null,
    capabilities: {} as DesktopSessionRecord['capabilities'],
    ttlSec: null,
    taskId: 'task-1',
    idleAfterSec: null,
    frozenAt: null,
    createdAt: new Date('2026-10-06T00:00:00Z'),
    lastActiveAt: new Date('2026-10-06T00:00:00Z'),
    releasedAt: null,
    ...over,
  } as DesktopSessionRecord;
}

// agent-a owns two desktops; desktop-2 is the most recently used, so a verb that
// ignored `desktop` and fell back to "most recent" would drive :121 for desktop-1.
const A1 = row({ id: ID(1), name: 'desktop-1', display: ':120', lastActiveAt: new Date('2026-10-06T01:00:00Z') });
const A2 = row({ id: ID(2), name: 'desktop-2', display: ':121', lastActiveAt: new Date('2026-10-06T02:00:00Z') });
// agent-b has a desktop with the SAME name: a name lookup that ignored ownership would find it.
const B1 = row({ id: ID(3), scopeRef: 'agent-b', leaseHolder: 'agent-b', name: 'desktop-1', display: ':122', taskId: 'task-3' });
const ROWS = [A1, A2, B1];

const registry = vi.hoisted(() => ({
  getDesktopSession: vi.fn(),
  listDesktopSessions: vi.fn(),
  touchDesktopSession: vi.fn(),
  resolveDesktopForScope: vi.fn(),
  resolveLocalDesktopByDisplay: vi.fn(),
}));
vi.mock('../../desktop/desktop-session-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../desktop/desktop-session-registry')>()),
  ...registry,
}));
vi.mock('../../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace-registry')>()),
  activeWorkspaceId: () => 'ws',
}));

import { runComputerAction, __setComputerExecForTests, __resetComputerExec, type ComputerExec } from './computer';
import { runObserve, runClickElement } from './observe';
import { runRecordTrajectory } from './record-trajectory';
import { DesktopTargetError } from './desktop-target';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const busFor = (display: string) => `unix:path=/tmp/at-spi-bus-${display.slice(1)}`;

interface Call { bin: string; args: string[]; env?: Record<string, string> }

/** Launches nothing. Answers the a11y bus probe with a PER-DISPLAY bus, so the
 * gjs walker/action that follows is reached and its binding can be checked too. */
function recordingExec(): { exec: ComputerExec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ComputerExec = async (bin, args, opts) => {
    calls.push({ bin, args, env: opts.env });
    if (bin === 'import') return { status: 0, stdout: PNG, stderr: '' };
    if (bin === 'xprop') {
      const display = args[args.indexOf('-display') + 1]!;
      return { status: 0, stdout: Buffer.from(`AT_SPI_BUS(STRING) = "${busFor(display)}"`), stderr: '' };
    }
    if (bin === 'xdotool' && args[0] === 'getmouselocation') {
      return { status: 0, stdout: Buffer.from('X=10 Y=10 SCREEN=0 WINDOW=1'), stderr: '' };
    }
    return { status: 0, stdout: Buffer.alloc(0), stderr: '' };
  };
  return { exec, calls };
}

/** The identity shape a signed-spawn agent session presents (same as desktop-target.test.ts). */
const agentA = { uiClientId: 'agent-a', sigVerifiedSpawn: true, role: 'cup', harnessSlug: 'pot-1' } as never;

/** Every display a launched process was bound to (env DISPLAY or an explicit -display). */
function displaysDriven(calls: Call[]): string[] {
  const out = new Set<string>();
  for (const c of calls) {
    if (c.env?.DISPLAY) out.add(c.env.DISPLAY);
    const i = c.args.indexOf('-display');
    if (i >= 0 && c.args[i + 1]) out.add(c.args[i + 1]!);
  }
  return [...out];
}

const settle = async (p: Promise<unknown>) => { try { await p; } catch { /* the binding is asserted, not the verb's verdict */ } };

beforeEach(() => {
  registry.getDesktopSession.mockImplementation(async ({ id }: { id: string }) => ROWS.find((r) => r.id === id) ?? null);
  registry.listDesktopSessions.mockImplementation(async (f: { scope?: string; scopeRef?: string }) =>
    ROWS.filter((r) => (!f.scope || r.scope === f.scope) && (!f.scopeRef || r.scopeRef === f.scopeRef)));
  registry.touchDesktopSession.mockResolvedValue(undefined);
  registry.resolveDesktopForScope.mockResolvedValue(null);
  registry.resolveLocalDesktopByDisplay.mockResolvedValue(null);
  // A display in the process env is the pre-P-003 fallback. Set it so a verb that
  // skipped the named-desktop path would visibly drive :99 instead.
  process.env.PAPERCUSP_COMPUTER_DISPLAY = ':99';
});
afterEach(() => {
  __resetComputerExec();
  vi.clearAllMocks();
  delete process.env.PAPERCUSP_COMPUTER_DISPLAY;
});

const VERBS: Array<{ verb: string; run: (desktop: string) => Promise<unknown>; launches: string }> = [
  { verb: 'capability:computer', launches: 'xdotool', run: (desktop) => runComputerAction({ action: 'left_click', coordinate: [10, 10], desktop }, agentA) },
  { verb: 'computer:observe', launches: 'gjs', run: (desktop) => runObserve({ desktop }, agentA) },
  { verb: 'computer:click_element', launches: 'gjs', run: (desktop) => runClickElement({ ref: '0/0/1', desktop }, agentA) },
];

describe('R-2: each computer verb drives the display of the desktop it names', () => {
  for (const { verb, run, launches } of VERBS) {
    for (const [name, want] of [['desktop-1', A1], ['desktop-2', A2]] as const) {
      it(`${verb} { desktop: '${name}' } binds every launched process to ${want.display}`, async () => {
        const { exec, calls } = recordingExec();
        __setComputerExecForTests(exec);
        await settle(run(name));

        // The driver itself ran, bound to the named desktop.
        const driver = calls.find((c) => c.bin === launches);
        expect(driver, `${verb} launched no ${launches}`).toBeDefined();
        expect(driver!.env?.DISPLAY).toBe(want.display);
        if (launches === 'gjs') expect(driver!.env?.AT_SPI_BUS_ADDRESS).toBe(busFor(want.display));
        // ...and nothing it launched touched any other display (not the most-recent
        // desktop, not agent-b's same-named desktop, not the env fallback :99).
        expect(displaysDriven(calls)).toEqual([want.display]);
        // Driving keeps the named desktop alive — and only that one.
        expect(registry.touchDesktopSession).toHaveBeenCalledWith(want.id);
        expect(registry.touchDesktopSession).toHaveBeenCalledTimes(1);
      });
    }
  }

  for (const [name, want] of [['desktop-1', A1], ['desktop-2', A2]] as const) {
    it(`computer:record { desktop: '${name}' } reports and records on ${want.display}`, async () => {
      const { exec, calls } = recordingExec();
      __setComputerExecForTests(exec);
      const r = (await runRecordTrajectory({ op: 'status', desktop: name } as never, agentA)) as { content: Array<{ text: string }> };
      expect(JSON.parse(r.content[0]!.text).display).toBe(want.display);
      expect(displaysDriven(calls).filter((d) => d !== want.display)).toEqual([]);
      expect(registry.touchDesktopSession).toHaveBeenCalledWith(want.id);
    });
  }

  it('a desktop id the caller does not own is refused before ANY process is launched, for every verb', async () => {
    for (const run of [...VERBS.map((v) => v.run), (desktop: string) => runRecordTrajectory({ op: 'status', desktop } as never, agentA)]) {
      const { exec, calls } = recordingExec();
      __setComputerExecForTests(exec);
      await expect(run(B1.id)).rejects.toBeInstanceOf(DesktopTargetError);
      expect(calls).toEqual([]);
    }
    expect(registry.touchDesktopSession).not.toHaveBeenCalled();
  });

  it('without `desktop` the verb drives the most recently used of the caller\'s desktops, never the env display', async () => {
    const { exec, calls } = recordingExec();
    __setComputerExecForTests(exec);
    await settle(runComputerAction({ action: 'left_click', coordinate: [10, 10] }, agentA));
    expect(displaysDriven(calls)).toEqual([A2.display]);
  });
});
