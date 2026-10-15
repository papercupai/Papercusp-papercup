/**
 * managed-spawn-payload-env.test.ts — WI-40906.
 *
 * THE PROPERTY: a caller-supplied `spawnOptions.env` belongs to the PAYLOAD and must
 * never reach the `systemd-run` client that confines it.
 *
 * WHY: a `--scope` payload is forked from the systemd-run client, so it inherits the
 * client's environment — which made `spawn(systemd-run …, { env })` look like it set
 * the payload's env. It does. It also sets the CLIENT's, and the client needs its own:
 * `systemd-run --user` reaches the user manager over `$DBUS_SESSION_BUS_ADDRESS`.
 * Redirect that variable and the launch dies before the payload ever execs:
 *
 *     Failed to start transient scope unit:
 *       The name org.freedesktop.systemd1 was not provided by any .service files
 *
 * Measured live 2026-08-23. A sandbox desktop publishes its own accessibility bus and
 * hands apps `DBUS_SESSION_BUS_ADDRESS` for it, so EVERY GUI app launched into such a
 * desktop failed to start — silently, because the caller passes `stdio: 'ignore'` and
 * `managedSpawn` then returned a healthy-looking handle for a process that had never
 * run. Xvfb and the window manager came up fine (they are spawned before that bus
 * exists), which is what made it read as "GTK apps don't work here" for a day.
 *
 * The guard is written against the CLIENT's spawn options rather than the fix's
 * internals, so it stays true of any future mechanism that keeps the two environments
 * apart — and `legacyCoupledLaunch` below is a permanently-kept wrong implementation
 * proving the assertion can still fail (the repo's falsifiability rule, without
 * mutating the shared tree to demonstrate it).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { ChildProcess, SpawnOptions, spawn as nodeSpawn } from 'node:child_process';

vi.mock('./enabled', () => ({
  isTaskManagerEnabled: async () => true,
  taskManagerEnabledSync: () => true,
  warmTaskManagerFlag: () => {},
  setTaskManagerEnabledForTest: () => {},
}));

vi.mock('./store', () => ({
  registerTask: async (_spec: unknown, opts: { taskId?: string }) => ({
    taskId: opts?.taskId ?? 'task-test',
    state: 'pending',
  }),
  markSpawned: async () => {},
  closeTask: async () => {},
}));

import { managedSpawn } from './managed-spawn';
import {
  SYSTEMD_ENV_RUNNER_PATH,
  buildExactEnvPayloadWithTransport,
  buildTaskScopeArgv,
} from '../systemd-scope';
import { CGROUP_ROOT, type CgroupFs } from './cgroup-read';
import type { TaskSpec } from './types';

const MGR = '/user.slice/user-1000.slice/user@1000.service';

/** The exact env shape that broke: an a11y-only bus in the session-bus slot. */
const A11Y_BUS = 'unix:path=/run/user/1000/at-spi/bus_110';
const DESKTOP_ENV = {
  DISPLAY: ':110',
  DBUS_SESSION_BUS_ADDRESS: A11Y_BUS,
  AT_SPI_BUS_ADDRESS: A11Y_BUS,
  PATH: '/usr/bin:/bin',
} as const;

const APP_SPEC: TaskSpec = {
  class: 'desktop',
  title: 'zenity :110',
  argv: [],
  launchedBy: 'system:desktop-provisioner',
};

const FS: CgroupFs = {
  readFile: (p: string) => (p === `/proc/${process.pid}/cgroup` ? `0::${MGR}/papercup-dev-api.service\n` : null),
  readDir: () => [],
  isDir: () => false,
};

interface Launch {
  command: string;
  args: string[];
  options: SpawnOptions;
}

/** Spawn one app and report exactly what the injected spawn saw. */
async function launch(opts: { confined: boolean; env?: NodeJS.ProcessEnv; stdio?: SpawnOptions['stdio'] }) {
  const seen: Launch[] = [];
  const emitter = new EventEmitter();
  Object.assign(emitter, { pid: 4242, kill: () => true });
  const spawnFn = ((command: string, args: string[], options: SpawnOptions) => {
    seen.push({ command, args, options });
    return emitter as unknown as ChildProcess;
  }) as unknown as typeof nodeSpawn;

  await managedSpawn('zenity', ['--info'], APP_SPEC, {
    scopeAvailable: opts.confined,
    spawnFn,
    fs: FS,
    spawnOptions: {
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.stdio ? { stdio: opts.stdio } : {}),
    },
  });
  expect(seen).toHaveLength(1);
  return seen[0]!;
}

/**
 * THE CONTROL — kept deliberately wrong, forever. This is what the code did before
 * WI-40906: hand the caller's env straight to the systemd-run client. Every assertion
 * about the client's environment is run against this too, so a guard that stopped
 * discriminating would be caught here instead of passing quietly.
 */
function legacyCoupledLaunch(env: NodeJS.ProcessEnv): Launch {
  const argv = buildTaskScopeArgv(['zenity', '--info'], { unit: 'pc-x.scope', slice: 'pc.slice' });
  return { command: argv[0]!, args: argv.slice(1), options: { env } };
}

describe('confined payload env is not the client env (WI-40906)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('does not hand the caller env to the systemd-run client', async () => {
    const l = await launch({ confined: true, env: { ...DESKTOP_ENV } });

    expect(l.command).toBe('systemd-run');
    // The whole defect in one assertion: the client must inherit ours, not the
    // caller's, or it cannot reach the user manager to create the scope at all.
    expect(l.options.env).toBeUndefined();

    // ...and the control proves this assertion still discriminates.
    expect(legacyCoupledLaunch({ ...DESKTOP_ENV }).options.env).toBeDefined();
  });

  it('gives the payload the caller env exactly, without exposing values in client argv', async () => {
    const l = await launch({ confined: true, env: { ...DESKTOP_ENV } });
    const argv = [l.command, ...l.args];

    const runnerIdx = argv.indexOf(SYSTEMD_ENV_RUNNER_PATH);
    expect(runnerIdx).toBeGreaterThan(0);
    expect(argv[runnerIdx - 1]).toBe(process.execPath);
    expect(argv[runnerIdx + 1]).toBe('--env-fd-path');
    expect(argv[runnerIdx + 2]).toBe('/proc/self/fd/3');
    expect(l.options.stdio).toHaveLength(4);
    expect(typeof l.options.stdio?.[3]).toBe('number');
    expect(argv.slice(runnerIdx + 3)).toEqual(['--', 'zenity', '--info']);
    expect(argv).not.toContain(`AT_SPI_BUS_ADDRESS=${A11Y_BUS}`);
    expect(argv).not.toContain(`DBUS_SESSION_BUS_ADDRESS=${A11Y_BUS}`);
    expect(argv).not.toContain('DISPLAY=:110');
    expect(argv).not.toContain('PATH=/usr/bin:/bin');
    // The scope flags must still precede it, or nothing is confined.
    expect(argv.slice(0, 4)).toEqual(['systemd-run', '--user', '--scope', '--quiet']);
  });

  it('leaves an unconfined spawn exactly as it was', async () => {
    const l = await launch({ confined: false, env: { ...DESKTOP_ENV } });

    // No client to protect: node applies `env` itself, and wrapping here would
    // change the process the caller asked for.
    expect(l.command).toBe('zenity');
    expect(l.args).toEqual(['--info']);
    expect(l.options.env).toEqual(DESKTOP_ENV);
  });

  it.each(['pipe', 'ignore', 'inherit'] as const)(
    'normalizes string stdio %s before appending the inherited environment fd',
    async (stdio) => {
      const l = await launch({ confined: true, env: { ...DESKTOP_ENV }, stdio });
      expect(l.options.stdio).toHaveLength(4);
      expect(l.options.stdio?.slice(0, 3)).toEqual([stdio, stdio, stdio]);
      expect(typeof l.options.stdio?.[3]).toBe('number');
    },
  );

  it('places the inherited environment fd after an existing slot-3 IPC channel', async () => {
    const l = await launch({
      confined: true,
      env: { ...DESKTOP_ENV },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const argv = [l.command, ...l.args];
    const runnerIdx = argv.indexOf(SYSTEMD_ENV_RUNNER_PATH);

    expect(argv[runnerIdx + 2]).toBe('/proc/self/fd/4');
    expect(l.options.stdio?.[3]).toBe('ipc');
    expect(typeof l.options.stdio?.[4]).toBe('number');
  });

  it('normalizes default stdio to its equivalent pipe slots before appending the fd', async () => {
    const l = await launch({ confined: true, env: { ...DESKTOP_ENV } });
    expect(l.options.stdio).toHaveLength(4);
    expect(l.options.stdio?.slice(0, 3)).toEqual(['pipe', 'pipe', 'pipe']);
    expect(typeof l.options.stdio?.[3]).toBe('number');
  });

  it('does not wrap a confined spawn that passed no env', async () => {
    const l = await launch({ confined: true });
    expect([l.command, ...l.args]).not.toContain('-i');
    expect([l.command, ...l.args].slice(-2)).toEqual(['zenity', '--info']);
  });

  it('uses one caller-minted task identity for the ledger result and scope', async () => {
    const taskId = 'releaseoperation01';
    const emitter = Object.assign(new EventEmitter(), { pid: 4242, kill: () => true });
    const seen: Launch[] = [];
    const spawnFn = ((command: string, args: string[], options: SpawnOptions) => {
      seen.push({ command, args, options });
      return emitter as unknown as ChildProcess;
    }) as unknown as typeof nodeSpawn;

    const result = await managedSpawn('zenity', ['--info'], APP_SPEC, {
      taskId,
      scopeAvailable: true,
      spawnFn,
      fs: FS,
    });

    expect(result.taskId).toBe(taskId);
    expect(result.row.taskId).toBe(taskId);
    expect([seen[0]!.command, ...seen[0]!.args]).toContain(`--unit=pc-${taskId}.scope`);
  });

  it('rejects an invalid caller task identity before registration or spawn', async () => {
    await expect(
      managedSpawn('zenity', ['--info'], APP_SPEC, {
        taskId: 'NOT/A/TASK',
        scopeAvailable: false,
      }),
    ).rejects.toThrow(/invalid caller taskId/);
  });
});

describe('buildExactEnvPayloadWithTransport', () => {
  it('replaces the environment rather than merging into it', () => {
    const built = buildExactEnvPayloadWithTransport(['cmd'], { A: '1' });
    try {
      expect(built.argv).toEqual([
        process.execPath,
        SYSTEMD_ENV_RUNNER_PATH,
        '--env-fd-path',
        expect.stringMatching(new RegExp(`^/proc/${process.pid}/fd/\\d+$`)),
        '--',
        'cmd',
      ]);
      expect(readFileSync(built.transport.sourcePath, 'utf8')).toBe('A=1\0');
      expect(built.argv).not.toContain('A=1');
    } finally {
      built.transport.release();
    }
  });

  it('drops undefined values, as node spawn does', () => {
    const built = buildExactEnvPayloadWithTransport(['cmd'], { A: '1', B: undefined });
    try {
      expect(readFileSync(built.transport.sourcePath, 'utf8')).toBe('A=1\0');
    } finally {
      built.transport.release();
    }
  });

  it('drops names that cannot be expressed as an operand instead of shifting the rest', () => {
    // A name carrying `=` would make every later operand land in the wrong slot —
    // including the command itself. A subset of the requested env is recoverable;
    // a silently different one is not.
    const built = buildExactEnvPayloadWithTransport(['cmd'], { 'BAD=NAME': 'x', GOOD: 'y' });
    try {
      expect(readFileSync(built.transport.sourcePath, 'utf8')).toBe('GOOD=y\0');
    } finally {
      built.transport.release();
    }
  });

  it('keeps values containing = and spaces intact', () => {
    // Real bus addresses carry `=` in the VALUE; only the first `=` separates.
    const built = buildExactEnvPayloadWithTransport(['cmd'], { DBUS_SESSION_BUS_ADDRESS: `${A11Y_BUS} with spaces` });
    try {
      expect(readFileSync(built.transport.sourcePath, 'utf8')).toBe(`DBUS_SESSION_BUS_ADDRESS=${A11Y_BUS} with spaces\0`);
      expect(built.argv).not.toContain(`DBUS_SESSION_BUS_ADDRESS=${A11Y_BUS} with spaces`);
    } finally {
      built.transport.release();
    }
  });

  it('emits operands in a stable order', () => {
    const a = buildExactEnvPayloadWithTransport(['cmd'], { B: '2', A: '1' });
    const b = buildExactEnvPayloadWithTransport(['cmd'], { A: '1', B: '2' });
    try {
      expect(readFileSync(a.transport.sourcePath, 'utf8')).toBe(readFileSync(b.transport.sourcePath, 'utf8'));
    } finally {
      a.transport.release();
      b.transport.release();
    }
  });

  it('preserves the payload argv verbatim after the operands', () => {
    const built = buildExactEnvPayloadWithTransport(['vglrun', '-d', 'egl0', 'zenity', '--text=a b'], { A: '1' });
    try {
      expect(built.argv.slice(4)).toEqual(['--', 'vglrun', '-d', 'egl0', 'zenity', '--text=a b']);
    } finally {
      built.transport.release();
    }
  });
});

// Referenced so the unused-import lint cannot hide a fixture drifting out of use.
void CGROUP_ROOT;
