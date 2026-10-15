import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fixture = vi.hoisted(() => ({ script: '', output: '', onOutput: () => {}, child: null as ChildProcess | null }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { createTextCollector } = await import('../../child-output');
  return {
    ...actual,
    // Exercise the real local runner and OS pipes without contacting a remote.
    spawn: (_command: string, _args: string[], options: SpawnOptions) => {
      // The fetch guard resolves its write filesystem before running the timed
      // fixture. That read is independent of the fake transfer's output stream.
      if (_args.includes('--git-path')) {
        return actual.spawn(process.execPath, ['-e', "process.stdout.write(require('node:os').tmpdir())"], options);
      }
      const child = actual.spawn(process.execPath, ['-e', fixture.script], options);
      fixture.child = child;
      const output = createTextCollector(child.stderr);
      child.stderr?.on('data', () => { fixture.output = output.peek(); fixture.onOutput(); });
      return child;
    },
  };
});
vi.mock('../../fleet/git-via-sidecar', () => ({ gitSidecarEnabled: () => false }));

import {
  createGitProgressWatchdog,
  runGitBounded,
  type GitProgressTimerHandle,
  type GitProgressTimerScheduler,
} from './run-git-sync';

beforeEach(() => { fixture.onOutput = () => {}; fixture.child = null; fixture.output = ''; });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

describe('local Git cancellation lifetime', () => {
  it.skipIf(process.platform === 'win32')('preserves a silent external termination signal in the Git result', async () => {
    fixture.script = "process.kill(process.pid, 'SIGTERM');";
    const result = await runGitBounded(['diff'], tmpdir(), 5000);
    expect(result).toMatchObject({ code: -1, stdout: '' });
    expect(result.stderr).toContain('git terminated by signal SIGTERM');
  });

  it('does not spawn when cancellation precedes the command', async () => {
    fixture.script = "process.stderr.write('should not run');";
    const controller = new AbortController();
    controller.abort();
    const result = await runGitBounded(['commit'], tmpdir(), 5000, { signal: controller.signal });
    expect(result.code).toBe(-1);
    expect(fixture.child).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('waits for an ignored-stdio helper and cancels the whole command group', async () => {
    const helper = "process.on('SIGTERM', () => {}); process.send(process.pid); setInterval(() => {}, 1000);";
    fixture.script = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], {stdio:['ignore','ignore','ignore','ipc']}); child.on('message', pid => { process.stderr.write(String(pid)); child.disconnect(); }); setInterval(() => {}, 1000);`;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    fixture.onOutput = ready;
    const controller = new AbortController();
    const result = runGitBounded(['commit'], tmpdir(), 30_000, { signal: controller.signal });
    let helperPid = 0;
    try {
      await started;
      const parent = fixture.child!;
      helperPid = Number(fixture.output);
      expect(helperPid).toBeGreaterThan(0);
      expect(alive(helperPid)).toBe(true);
      controller.abort();
      const returned = await result;
      expect(returned.code).toBe(-1);
      expect(alive(parent.pid!)).toBe(false);
      expect(alive(helperPid)).toBe(false);
    } finally {
      controller.abort();
      if (helperPid && alive(helperPid)) process.kill(helperPid, 'SIGKILL');
      await result;
      if (helperPid) await vi.waitFor(() => expect(alive(helperPid)).toBe(false));
    }
  }, 30_000);

  it.skipIf(process.platform === 'win32')('keeps successful parent completion pending until its helper exits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'local-git-helper-'));
    const release = join(dir, 'release');
    const helper = `process.send(process.pid); setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(release)})) process.exit(0); }, 5);`;
    fixture.script = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], {stdio:['ignore','ignore','ignore','ipc']}); child.on('message', pid => { process.stderr.write(String(pid)); child.disconnect(); process.exit(0); });`;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    fixture.onOutput = ready;
    let settled = false;
    const result = runGitBounded(['commit'], tmpdir(), 5000).then((value) => { settled = true; return value; });
    let helperPid = 0;
    try {
      await started;
      helperPid = Number(fixture.output);
      await vi.waitFor(() => expect(alive(fixture.child!.pid!)).toBe(false));
      expect(alive(helperPid)).toBe(true);
      expect(settled).toBe(false);
      await writeFile(release, 'done');
      expect((await result).code).toBe(0);
      expect(alive(helperPid)).toBe(false);
    } finally {
      await writeFile(release, 'done');
      if (helperPid && alive(helperPid)) process.kill(helperPid, 'SIGKILL');
      await result;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

class ManualTimerScheduler implements GitProgressTimerScheduler {
  private sequence = 0;
  private readonly tasks: Array<{
    id: number;
    at: number;
    kind: 'timeout' | 'immediate';
    callback: () => void;
    cancelled: boolean;
    fired: boolean;
  }> = [];
  now = 0;

  setTimeout(callback: () => void, delayMs: number): GitProgressTimerHandle {
    return this.schedule('timeout', callback, this.now + delayMs);
  }

  setImmediate(callback: () => void): GitProgressTimerHandle {
    return this.schedule('immediate', callback, this.now);
  }

  advanceBy(delayMs: number): void {
    const target = this.now + delayMs;
    while (true) {
      const next = this.tasks
        .filter((task) => !task.cancelled && !task.fired && task.kind === 'timeout' && task.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      next.fired = true;
      this.now = next.at;
      next.callback();
    }
    this.now = target;
  }

  runImmediates(): void {
    while (true) {
      const next = this.tasks
        .filter((task) => !task.cancelled && !task.fired && task.kind === 'immediate')
        .sort((a, b) => a.id - b.id)[0];
      if (!next) return;
      next.fired = true;
      next.callback();
    }
  }

  private schedule(
    kind: 'timeout' | 'immediate',
    callback: () => void,
    at: number,
  ): GitProgressTimerHandle {
    const task = { id: this.sequence++, at, kind, callback, cancelled: false, fired: false };
    this.tasks.push(task);
    return {
      cancel: () => { task.cancelled = true; },
      unref: () => {},
    };
  }
}

describe('local Git output-idle guard', () => {
  it('lets progress already queued in the poll phase cancel the pending idle verdict', () => {
    const clock = new ManualTimerScheduler();
    const expirations: string[] = [];
    const watchdog = createGitProgressWatchdog(1_000, 20_000, (reason) => expirations.push(reason), clock);

    watchdog.start();
    clock.advanceBy(1_000); // Idle timeout fires and queues its setImmediate verdict.
    watchdog.onOutput(); // The poll phase delivers bytes that were already queued.
    clock.runImmediates();
    expect(expirations).toEqual([]);

    clock.advanceBy(1_000);
    clock.runImmediates();
    expect(expirations).toEqual(['made no output progress for 1000ms']);
  });

  it('expires after a finite progress burst stays silent for the idle interval', () => {
    const clock = new ManualTimerScheduler();
    const expirations: string[] = [];
    const watchdog = createGitProgressWatchdog(1_000, 20_000, (reason) => expirations.push(reason), clock);

    watchdog.start();
    for (let index = 0; index < 3; index += 1) {
      clock.advanceBy(40);
      watchdog.onOutput();
    }
    clock.advanceBy(999);
    expect(expirations).toEqual([]);
    clock.advanceBy(1);
    clock.runImmediates();
    expect(expirations).toEqual(['made no output progress for 1000ms']);
  });

  it('keeps the hard deadline absolute while progress continuously resets idle time', () => {
    const clock = new ManualTimerScheduler();
    const expirations: string[] = [];
    const watchdog = createGitProgressWatchdog(2_000, 3_000, (reason) => expirations.push(reason), clock);

    watchdog.start();
    clock.advanceBy(1_000);
    watchdog.onOutput();
    clock.advanceBy(1_000);
    watchdog.onOutput();
    clock.advanceBy(999);
    expect(expirations).toEqual([]);
    clock.advanceBy(1);
    expect(expirations).toEqual(['exceeded the 3000ms hard ceiling despite output progress']);
  });
});
