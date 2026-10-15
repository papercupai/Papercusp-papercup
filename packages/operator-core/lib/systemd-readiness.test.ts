import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { execFileMock, spawnMock } = vi.hoisted(() => ({ execFileMock: vi.fn(), spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: execFileMock, spawn: spawnMock }));

import { createSystemdNotifier, notifySystemdReady } from './systemd-readiness';

const originalNotifySocket = process.env.NOTIFY_SOCKET;
const originalTimeout = process.env.PAPERCUSP_SYSTEMD_NOTIFY_TIMEOUT_MS;

function restoreEnv(name: 'NOTIFY_SOCKET' | 'PAPERCUSP_SYSTEMD_NOTIFY_TIMEOUT_MS', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('notifySystemdReady', () => {
  let sender: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
  let requests: Array<{ id: number; state: string }>;

  beforeEach(() => {
    execFileMock.mockReset();
    spawnMock.mockReset();
    sender = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
    requests = [];
    sender.stdin.on('data', (chunk) => requests.push(JSON.parse(String(chunk))));
    spawnMock.mockReturnValue(sender);
    delete process.env.NOTIFY_SOCKET;
    delete process.env.PAPERCUSP_SYSTEMD_NOTIFY_TIMEOUT_MS;
  });

  afterEach(() => {
    restoreEnv('NOTIFY_SOCKET', originalNotifySocket);
    restoreEnv('PAPERCUSP_SYSTEMD_NOTIFY_TIMEOUT_MS', originalTimeout);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does nothing when systemd did not provide NOTIFY_SOCKET', () => {
    notifySystemdReady();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('sends READY=1 through the maintained persistent sender and keeps it alive for attribution', async () => {
    process.env.NOTIFY_SOCKET = '/run/user/1000/notify';

    notifySystemdReady();
    expect(requests).toEqual([{ id: 1, state: 'READY=1' }]);
    expect(execFileMock).not.toHaveBeenCalled();
    sender.stdout.write(JSON.stringify({ id: 1, result: 1 }) + '\n');
    await Promise.resolve();
    expect(sender.kill).not.toHaveBeenCalled();
  });

  it('reports a missing bridge acknowledgement at the one-second default deadline', async () => {
    vi.useFakeTimers();
    process.env.NOTIFY_SOCKET = '/run/user/1000/notify';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    notifySystemdReady();
    await vi.advanceTimersByTimeAsync(999);
    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(warn).toHaveBeenCalledWith('[systemd-readiness] READY=1 notification failed: systemd_notification_send_timeout');
    expect(sender.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('honors a configured bridge acknowledgement timeout but clamps it to ten seconds', async () => {
    vi.useFakeTimers();
    process.env.NOTIFY_SOCKET = '/run/user/1000/notify';
    process.env.PAPERCUSP_SYSTEMD_NOTIFY_TIMEOUT_MS = '20000';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    notifySystemdReady();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(warn).toHaveBeenCalledWith('[systemd-readiness] READY=1 notification failed: systemd_notification_send_timeout');
  });

  it('swallows notifier and logging failures', () => {
    process.env.NOTIFY_SOCKET = '/run/user/1000/notify';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('logger unavailable');
    });
    spawnMock.mockImplementation(() => {
      throw new Error('sender unavailable');
    });

    expect(() => notifySystemdReady()).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it('reports a native send failure and closes the failed sender without crashing the host', async () => {
    process.env.NOTIFY_SOCKET = '/run/user/1000/notify';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => notifySystemdReady()).not.toThrow();
    sender.stdout.write(JSON.stringify({ id: 1, result: -13 }) + '\n');
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith('[systemd-readiness] READY=1 notification failed: systemd_notification_send_failed:-13');
    expect(sender.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('persistent systemd notification transport', () => {
  beforeEach(() => spawnMock.mockReset());

  function senderFixture() {
    const sender = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
    const requests: Array<{ id: number; state: string }> = [];
    sender.stdin.on('data', (chunk) => requests.push(JSON.parse(String(chunk))));
    spawnMock.mockReturnValue(sender);
    const notifier = createSystemdNotifier({ PATH: '/usr/bin', NOTIFY_SOCKET: '/test/notify', SECRET: 'never-copy' }, 100);
    return { sender, requests, notifier: notifier! };
  }

  it('does not spawn a bridge outside a notify service', () => {
    expect(createSystemdNotifier({})).toBeNull();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('keeps one sender alive for readiness and subsequent heartbeats without copying secrets', async () => {
    const { sender, requests, notifier } = senderFixture();
    try {
      const ready = notifier.notify('READY=1');
      sender.stdout.write(JSON.stringify({ id: 1, result: 1 }) + '\n');
      await ready;
      const ping = notifier.notify('WATCHDOG=1');
      sender.stdout.write(JSON.stringify({ id: 2, result: 1 }) + '\n');
      await ping;
      expect(requests).toEqual([{ id: 1, state: 'READY=1' }, { id: 2, state: 'WATCHDOG=1' }]);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0][2].env).toEqual({ PATH: '/usr/bin', NOTIFY_SOCKET: '/test/notify' });
      expect(sender.kill).not.toHaveBeenCalled();
    } finally { notifier.close(); }
    expect(sender.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('rejects native send failure instead of claiming delivery', async () => {
    const { sender, notifier } = senderFixture();
    try {
      const result = expect(notifier.notify('WATCHDOG=1')).rejects.toThrow('systemd_notification_send_failed:-13');
      sender.stdout.write(JSON.stringify({ id: 1, result: -13 }) + '\n');
      await result;
    } finally { notifier.close(); }
  });

  it('rejects pending calls when the persistent sender exits', async () => {
    const { sender, notifier } = senderFixture();
    try {
      const result = expect(notifier.notify('WATCHDOG=1')).rejects.toThrow('systemd_notification_sender_exit:1');
      sender.emit('exit', 1, null);
      await result;
      await expect(notifier.notify('WATCHDOG=1')).rejects.toThrow('systemd_notification_sender_exit:1');
    } finally { notifier.close(); }
  });
});

it.skipIf(process.platform !== 'linux')('credits Hono readiness through systemd when the command-line notifier stalls', async () => {
  const { spawnSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const manager = spawnSync('systemctl', ['--user', 'show-environment'], { timeout: 5_000 });
  expect(manager.status, 'this regression requires the real user systemd manager').toBe(0);
  const root = mkdtempSync(join(tmpdir(), 'systemd-ready-'));
  const unit = `papercusp-test-readiness-${randomUUID()}.service`;
  const invoked = join(root, 'command-line-notifier-invoked');
  const listenerBound = join(root, 'listener-bound');
  const diagnostics = join(root, 'notification-error');
  // Test the real transport with the current source, without putting tsx's
  // unrelated module-loader startup inside this fixture's readiness deadline.
  const ts = await import('typescript');
  const helperPath = join(root, 'systemd-readiness.mjs');
  writeFileSync(helperPath, ts.transpileModule(readFileSync(resolve(__dirname, 'systemd-readiness.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
  const helper = pathToFileURL(helperPath).href;
  const runner = join(root, 'listener.mjs');
  const cli = join(root, 'systemd-notify');
  writeFileSync(cli, `#!/bin/sh\nprintf invoked > '${invoked}'\nsleep 20\n`, { mode: 0o755 });
  writeFileSync(runner, `
    import { createServer } from 'node:http';
    import { writeFileSync } from 'node:fs';
    import { notifySystemdReady } from ${JSON.stringify(helper)};
    console.warn = (...args) => writeFileSync(${JSON.stringify(diagnostics)}, args.join(' '));
    const server = createServer((_request, response) => response.end('healthy'));
    server.listen(0, '127.0.0.1', () => {
      writeFileSync(${JSON.stringify(listenerBound)}, String(Date.now()));
      notifySystemdReady();
    });
  `);
  const state = () => {
    const result = spawnSync('systemctl', ['--user', 'show', unit, '-p', 'ActiveState', '-p', 'SubState', '-p', 'Result'], { encoding: 'utf8', timeout: 5_000 });
    expect(result.status, result.stderr).toBe(0);
    return Object.fromEntries(result.stdout.trim().split('\n').map((line) => {
      const split = line.indexOf('=');
      return [line.slice(0, split), line.slice(split + 1)];
    }));
  };
  try {
    const start = spawnSync('systemd-run', [
      '--user', '--no-block', `--unit=${unit}`, '--property=Type=notify', '--property=NotifyAccess=all',
      '--property=TimeoutStartSec=5s', '--property=TimeoutStopSec=3s', '--property=KillMode=control-group',
      '--property=Restart=no', `--setenv=PATH=${root}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      process.execPath, runner,
    ], { encoding: 'utf8', timeout: 10_000 });
    expect(start.status, start.stderr).toBe(0);
    const deadline = Date.now() + 8_000;
    let observed = state();
    while (observed.ActiveState === 'activating' && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 100));
      observed = state();
    }
    const diagnostic = existsSync(diagnostics) ? readFileSync(diagnostics, 'utf8') : 'no notifier error';
    expect(existsSync(listenerBound), `listener precondition failed in ${unit}: ${diagnostic}`).toBe(true);
    expect(observed, `READY must be credited by the actual manager in ${unit}: ${diagnostic}`).toMatchObject({ ActiveState: 'active', SubState: 'running', Result: 'success' });
    expect(existsSync(invoked), 'readiness must use the maintained libsystemd sender').toBe(false);
  } finally {
    spawnSync('systemctl', ['--user', 'stop', unit], { timeout: 10_000 });
    spawnSync('systemctl', ['--user', 'reset-failed', unit], { timeout: 5_000 });
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
