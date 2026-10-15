/**
 * desktop-provisioner.test.ts — pure-logic coverage: free-display selection
 * (never :0) and the host-display refusal. The live Xvfb path is exercised by
 * the end-to-end proof script, not here.
 */
import { describe, expect, it, vi } from 'vitest';
const registryReservations = vi.hoisted(() => ({ list: vi.fn(async () => [] as string[]) }));
vi.mock('../../desktop/desktop-session-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../desktop/desktop-session-registry')>()),
  listReservedLocalDesktopDisplays: registryReservations.list,
}));
import {
  assertDesktopPrerequisites,
  findFreeDisplayNumber,
  provisionSandboxDesktop,
  releaseDesktopResources,
  releaseDesktopProcesses,
} from './desktop-provisioner';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { X_SERVER_STDERR_TAIL_BYTES, describeXServerExit, watchXServer, xfceSessionLaunch } from './desktop-provisioner-core';

/** A child whose lifecycle the test drives: node sets exitCode/signalCode before 'exit'. */
function fakeXServer({ started = true }: { started?: boolean } = {}) {
  const child = Object.assign(new EventEmitter(), {
    // Node leaves `pid` undefined when the spawn itself failed.
    pid: started ? 4242 : undefined, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, stderr: new PassThrough(),
  });
  const exit = (code: number | null, signal: NodeJS.Signals | null) => {
    child.exitCode = code; child.signalCode = signal;
    child.emit('exit', code, signal);
    child.stderr.end();
    child.stderr.once('end', () => child.emit('close', code, signal));
  };
  return { child, asChild: child as unknown as ChildProcess, exit };
}

// WI-10004206: the X server was spawned stdio:'ignore' and never watched, so a dead one
// left a `ready` desktop and no record of why it died.
describe('watchXServer', () => {
  it('is alive until the server exits, then settles with its exit and stderr tail', async () => {
    const x = fakeXServer();
    const watch = watchXServer(x.asChild);
    expect(watch.isAlive()).toBe(true);
    expect(watch.exit()).toBeNull();
    x.child.stderr.write('Fatal server error:\n');
    x.child.stderr.write('Cannot establish any listening sockets\n');
    x.exit(1, null);
    expect(watch.isAlive()).toBe(false);
    await expect(watch.exited).resolves.toEqual({
      code: 1, signal: null, stderrTail: 'Fatal server error:\nCannot establish any listening sockets\n',
    });
    expect(watch.exit()).toEqual({ code: 1, signal: null, stderrTail: expect.stringContaining('listening sockets') });
  });

  it('keeps only a bounded tail of a chatty server', async () => {
    const x = fakeXServer();
    const watch = watchXServer(x.asChild);
    x.child.stderr.write('a'.repeat(X_SERVER_STDERR_TAIL_BYTES));
    x.child.stderr.write('LAST WORDS');
    x.exit(null, 'SIGKILL');
    const exit = await watch.exited;
    expect(exit.stderrTail).toHaveLength(X_SERVER_STDERR_TAIL_BYTES);
    expect(exit.stderrTail.endsWith('LAST WORDS')).toBe(true);
    expect(exit.signal).toBe('SIGKILL');
  });

  it('settles on a spawn that never started', async () => {
    const x = fakeXServer({ started: false });
    const watch = watchXServer(x.asChild);
    x.child.emit('error', new Error('spawn Xkasmvnc ENOENT'));
    await expect(watch.exited).resolves.toMatchObject({ code: null, signal: null, stderrTail: 'spawn Xkasmvnc ENOENT' });
    expect(watch.isAlive()).toBe(false);
  });

  it('describes an exit on one line, and says so when the server printed nothing', () => {
    expect(describeXServerExit(':110', { code: 0, signal: null, stderrTail: '  \n' }))
      .toBe('X server for :110 exited code=0 signal=-; it wrote nothing to stderr');
  });
});

describe('findFreeDisplayNumber', () => {
  it('returns the lowest free number ≥ base (skips locked displays)', () => {
    const locked = new Set(['/tmp/.X110-lock', '/tmp/.X111-lock']);
    expect(findFreeDisplayNumber(110, 250, (p) => locked.has(p))).toBe(112);
  });

  it('skips database reservations as well as filesystem locks', () => {
    const locked = new Set(['/tmp/.X111-lock']);
    expect(findFreeDisplayNumber(110, 250, (p) => locked.has(p), new Set([110, 112])))
      .toBe(113);
  });

  it('never returns :0 even if base is 0', () => {
    expect(findFreeDisplayNumber(0, 250, () => false)).toBe(1);
  });

  it('throws when the whole range is taken', () => {
    expect(() => findFreeDisplayNumber(110, 112, () => true)).toThrow(/no free X display/);
  });
});

describe('operator display reservations', () => {
  it('loads live registry reservations before local allocation', async () => {
    registryReservations.list.mockResolvedValue(Array.from({ length: 141 }, (_, index) => `:${110 + index}`));
    await expect(provisionSandboxDesktop({})).rejects.toThrow(/no free X display number/);
    expect(registryReservations.list).toHaveBeenCalledTimes(1);
  });
});

describe('provisionSandboxDesktop — safety', () => {
  it('refuses an explicit host display :0', async () => {
    await expect(provisionSandboxDesktop({ displayNumber: 0 })).rejects.toThrow(/host :0 \/ invalid|refusing/);
  });
  it('refuses a negative display number', async () => {
    await expect(provisionSandboxDesktop({ displayNumber: -5 })).rejects.toThrow(/refusing/);
  });
  it('names an absent X server before waiting for a display or starting children', async () => {
    await expect(provisionSandboxDesktop({
      displayNumber: 249,
      xServerBinaryPath: '/nonexistent/papercusp-test-X-server',
      readyTimeoutMs: 0,
    })).rejects.toThrow(/missing xvfb prerequisites: .*\/nonexistent\/papercusp-test-X-server/);
  });
});

describe('desktop prerequisites', () => {
  it('reports the absent stack on a headless host, including the readiness probe', () => {
    expect(() => assertDesktopPrerequisites({}, () => false))
      .toThrow(/missing xvfb prerequisites: Xvfb, xdpyinfo, openbox.*optional desktop pack provides KasmVNC/);
  });

  it('accepts a complete KasmVNC stack without requiring Xvfb', () => {
    const installed = new Set(['Xkasmvnc', 'xdpyinfo', 'openbox', 'kasmvncpasswd']);
    expect(() => assertDesktopPrerequisites({ xServer: 'kasmvnc' }, (binary) => installed.has(binary)))
      .not.toThrow();
  });

  it('requires credential tooling before trying to mint KasmVNC credentials', () => {
    expect(() => assertDesktopPrerequisites({ xServer: 'kasmvnc' }, (binary) => binary !== 'kasmvncpasswd'))
      .toThrow(/missing kasmvnc prerequisites: kasmvncpasswd/);
  });

  it('requires xsetroot only when a root colour is requested, and refuses a malformed colour', () => {
    const installed = new Set(['Xkasmvnc', 'xdpyinfo', 'openbox', 'kasmvncpasswd']);
    const has = (binary: string) => installed.has(binary);
    expect(() => assertDesktopPrerequisites({ xServer: 'kasmvnc' }, has)).not.toThrow();
    expect(() => assertDesktopPrerequisites({ xServer: 'kasmvnc', rootColor: '#4b5563' }, has))
      .toThrow(/missing kasmvnc prerequisites: xsetroot/);
    expect(() => assertDesktopPrerequisites({ xServer: 'kasmvnc', rootColor: 'grey; rm -rf /' }, () => true))
      .toThrow(/rootColor must be #rrggbb/);
  });

  it('requires the XFCE session binaries instead of openbox for an xfce desktop (WI-10002863)', () => {
    const installed = new Set(['Xkasmvnc', 'xdpyinfo', 'openbox', 'kasmvncpasswd']);
    expect(() => assertDesktopPrerequisites({ xServer: 'kasmvnc', desktopSession: 'xfce' }, (b) => installed.has(b)))
      .toThrow(/missing kasmvnc prerequisites: xfce4-session, dbus-run-session/);
    const xfce = new Set(['Xkasmvnc', 'xdpyinfo', 'kasmvncpasswd', 'xfce4-session', 'dbus-run-session']);
    expect(() => assertDesktopPrerequisites({ xServer: 'kasmvnc', desktopSession: 'xfce' }, (b) => xfce.has(b))).not.toThrow();
  });

  it('honors a custom server, existing credentials, and a disabled window manager', () => {
    const installed = new Set(['/opt/kasm/Xkasmvnc', 'xdpyinfo']);
    expect(() => assertDesktopPrerequisites({
      xServer: 'kasmvnc', xServerBinaryPath: '/opt/kasm/Xkasmvnc',
      kasmvncPasswordFile: '/run/desktop/passwd', windowManager: false,
    }, (binary) => installed.has(binary))).not.toThrow();
  });
});

describe('xfceSessionLaunch (WI-10002863)', () => {
  const xEnv = { DISPLAY: ':110', PATH: '/usr/bin:/bin', HOME: '/elsewhere', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/host/bus' };
  const a11yEnv = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/pc-a11y/bus', AT_SPI_BUS_ADDRESS: 'unix:path=/tmp/at-spi/bus_110' };

  it('runs xfce4-session on its own full bus, keeping this desktop\'s a11y bus', () => {
    const launch = xfceSessionLaunch(xEnv, a11yEnv, '/var/lib/papercusp-desktop');
    expect([launch.command, ...launch.args]).toEqual(['dbus-run-session', '--', 'xfce4-session']);
    // Neither the host bus nor the a11y bus's minimal bus: xfconfd cannot activate on either.
    expect(launch.env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
    expect(launch.env.AT_SPI_BUS_ADDRESS).toBe('unix:path=/tmp/at-spi/bus_110');
    expect(launch.env.DISPLAY).toBe(':110');
    expect(launch.env.HOME).toBe('/var/lib/papercusp-desktop');
  });

  it('hides at-spi\'s autostart so the session cannot republish AT_SPI_BUS on the root', () => {
    const { autostartOverride } = xfceSessionLaunch(xEnv, a11yEnv, '/var/lib/papercusp-desktop');
    expect(autostartOverride.path).toBe('/var/lib/papercusp-desktop/.config/autostart/at-spi-dbus-bus.desktop');
    expect(autostartOverride.content).toMatch(/^Hidden=true$/m);
  });

  it('still launches without an a11y bus (accessibility disabled)', () => {
    const launch = xfceSessionLaunch(xEnv, undefined, '/h');
    expect(launch.env.AT_SPI_BUS_ADDRESS).toBeUndefined();
    expect(launch.env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
  });
});

describe('releaseDesktopProcesses — managed teardown', () => {
  const root = {
    taskId: 'task-root',
    scopeUnit: 'pc-task-root.scope',
    confined: true,
    ledgered: true,
  };

  it('kills the managed task before touching systemd-run client handles', async () => {
    const events: string[] = [];
    const clients = [
      { kill: vi.fn((signal: NodeJS.Signals) => { events.push(`client-1:${signal}`); return true; }) },
      { kill: vi.fn((signal: NodeJS.Signals) => { events.push(`client-2:${signal}`); return true; }) },
    ];
    const killTask = vi.fn(async (_taskId: string, options: { includeSubtree?: boolean } = {}) => {
      events.push(`task:${options.includeSubtree === true ? 'subtree' : 'root'}`);
      return { ok: true as const, taskId: 'task-root', action: 'kill' };
    });
    const markManagedTeardown = vi.fn(() => {
      events.push('mark');
      return () => {};
    });

    await releaseDesktopProcesses(clients, root, { killTask, markManagedTeardown, sleep: async () => {} });

    expect(markManagedTeardown).toHaveBeenCalledTimes(2);
    expect(events[2]).toBe('task:subtree');
    expect(events).toEqual([
      'mark',
      'mark',
      'task:subtree',
      'client-2:SIGTERM',
      'client-1:SIGTERM',
      'client-1:SIGKILL',
      'client-2:SIGKILL',
    ]);
  });

  it('uses the validated scope handle when the ledger is unavailable', async () => {
    const events: string[] = [];
    const clients = [{ kill: vi.fn((signal: NodeJS.Signals) => { events.push(`client:${signal}`); return true; }) }];
    const killTask = vi.fn();
    const killScopeUnit = vi.fn(async (scopeUnit: string) => {
      events.push(`scope:${scopeUnit}`);
      return { ok: true as const, scopeUnit, action: 'kill' };
    });

    await releaseDesktopProcesses(clients, { ...root, ledgered: false }, { killTask, killScopeUnit, sleep: async () => {} });

    expect(killTask).not.toHaveBeenCalled();
    expect(events).toEqual(['scope:pc-task-root.scope', 'client:SIGTERM', 'client:SIGKILL']);
  });

  it('leaves client handles untouched when managed teardown is refused', async () => {
    const client = { kill: vi.fn(() => true) };
    const killTask = vi.fn(async () => ({
      ok: false as const,
      taskId: 'task-root',
      action: 'kill',
      error: 'command_failed' as const,
      detail: 'systemctl unavailable',
    }));
    const clearMarker = vi.fn();
    const markManagedTeardown = vi.fn(() => clearMarker);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await releaseDesktopProcesses([client], root, { killTask, markManagedTeardown, sleep: async () => {} });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('leaving client handles untouched'));
      expect(markManagedTeardown).toHaveBeenCalledTimes(1);
      expect(clearMarker).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }

    expect(client.kill).not.toHaveBeenCalled();
  });

  // WI-1199802. A scope systemd has already collected is the state this function exists to
  // REACH, so it must not be reported as a refusal. Both consequences are asserted together
  // because the old behaviour got both wrong at once: it warned (which vitest-fail-on-console
  // then converted into red tests in suites that had actually passed), and it took the
  // refusal's early return, skipping the client-handle sweep entirely.
  it('treats an already-collected scope as success — no warning, and the client sweep still runs', async () => {
    const events: string[] = [];
    const client = {
      kill: vi.fn((signal: NodeJS.Signals) => { events.push(`client:${signal}`); return true; }),
    };
    const killScopeUnit = vi.fn(async (scopeUnit: string) => ({
      ok: false as const,
      scopeUnit,
      action: 'kill',
      error: 'already_gone' as const,
      detail: `scope ${scopeUnit} is no longer known to systemd — its transient scope was collected, so its process subtree is already gone`,
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await releaseDesktopProcesses([client], { ...root, ledgered: false }, {
        killTask: vi.fn(),
        killScopeUnit,
        sleep: async () => {},
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }

    expect(events).toEqual(['client:SIGTERM', 'client:SIGKILL']);
  });

  // The CONTROL for the test above: a genuine refusal must keep BOTH of the old behaviours.
  // Without this, "stop warning on already_gone" could be over-applied to every !ok outcome
  // and nothing here would notice — the lookalike-cgroup refusal is security-relevant.
  it('still refuses loudly when the scope resolves to a foreign cgroup', async () => {
    const client = { kill: vi.fn(() => true) };
    const killScopeUnit = vi.fn(async (scopeUnit: string) => ({
      ok: false as const,
      scopeUnit,
      action: 'kill',
      error: 'no_target' as const,
      detail: `systemd returned no validated Papercusp cgroup for scope ${scopeUnit}`,
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await releaseDesktopProcesses([client], { ...root, ledgered: false }, {
        killTask: vi.fn(),
        killScopeUnit,
        sleep: async () => {},
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('leaving client handles untouched'));
    } finally {
      warn.mockRestore();
    }

    expect(client.kill).not.toHaveBeenCalled();
  });
});

describe('releaseDesktopResources — owned accessibility teardown', () => {
  const root = {
    taskId: 'task-root',
    scopeUnit: 'pc-task-root.scope',
    confined: true,
    ledgered: true,
  };

  it('releases the a11y daemon even when managed desktop teardown is refused', async () => {
    const release = vi.fn();
    const client = { kill: vi.fn(() => true) };
    const killTask = vi.fn(async () => ({
      ok: false as const,
      taskId: 'task-root',
      action: 'kill',
      error: 'command_failed' as const,
      detail: 'systemctl unavailable',
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await releaseDesktopResources([client], root, { release }, {
        killTask,
        markManagedTeardown: () => () => {},
        sleep: async () => {},
      });
    } finally {
      warn.mockRestore();
    }

    expect(release).toHaveBeenCalledOnce();
    expect(client.kill).not.toHaveBeenCalled();
  });
});
