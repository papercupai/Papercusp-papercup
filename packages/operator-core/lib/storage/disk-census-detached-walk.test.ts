/**
 * runDetachedDuWalk's adopt / relaunch / give-up / overdue logic, with the process
 * layer injected (WI-6554700010009855). The real-process behaviour — a walk that keeps
 * running after its caller stops, and is adopted by the next caller — is in
 * disk-census-detached-walk.integration.test.ts.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  censusWalkDir,
  DetachedWalkAbandoned,
  pruneCensusWalks,
  readWalkState,
  runDetachedDuWalk,
  TIMEOUT_EXIT_STATUS,
  walkAttemptFiles,
  type DetachedWalkState,
  type WalkLauncher,
} from './disk-census-detached-walk';

const GiB = 1024 ** 3;
const ROOT = '/srv/census-root';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'census-walk-unit-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function duOutput(rootBytes: number): string {
  return [`${3 * GiB}\t${ROOT}/big`, `${rootBytes}\t${ROOT}`].map((r) => `${r}\0`).join('');
}

/** Write a finished attempt: du output, stderr, and the exit status file. */
function finishAttempt(attempt: number, status: number, rootBytes = 5 * GiB, stderr = ''): void {
  const f = walkAttemptFiles(dir, attempt);
  writeFileSync(f.out, duOutput(rootBytes));
  writeFileSync(f.err, stderr);
  writeFileSync(f.exit, `${status}\n`);
}

function writeState(over: Partial<DetachedWalkState> = {}): void {
  const state: DetachedWalkState = {
    version: 1,
    root: ROOT,
    attempt: 1,
    pid: 999_999,
    identity: null,
    taskId: 'task1',
    confined: true,
    confinementSkippedReason: null,
    launchedAt: 1_000,
    deadlineAt: 1_000 + 90 * 60_000,
    adoptions: 0,
    ...over,
  };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
}

function fakeLauncher(onLaunch: (attempt: number) => void = () => {}) {
  const calls: Array<{ cmd: string; args: string[]; attempt: number }> = [];
  const launch: WalkLauncher = async (cmd, args, meta) => {
    calls.push({ cmd, args, attempt: meta.attempt });
    onLaunch(meta.attempt);
    return { pid: 4242, taskId: `t${meta.attempt}`, confined: true };
  };
  return { launch, calls };
}

describe('runDetachedDuWalk', () => {
  it('launches one walk, waits for its exit status, and reads its output files', async () => {
    const { launch, calls } = fakeLauncher();
    let polls = 0;
    const run = await runDetachedDuWalk(ROOT, {
      dir,
      launch,
      isAlive: () => true,
      sleep: async () => {
        polls += 1;
        if (polls === 2) finishAttempt(1, 0, 7 * GiB);
      },
      now: () => 5_000,
    });
    expect(calls).toHaveLength(1);
    // The walk script gets the attempt's own files, then the bounded du command.
    const f = walkAttemptFiles(dir, 1);
    expect(calls[0]!.args.slice(3, 6)).toEqual([f.out, f.err, f.exit]);
    expect(calls[0]!.args.join(' ')).toContain(`--max-depth=6 ${ROOT}`);
    expect(run.summary.rootBytes).toBe(7 * GiB);
    expect(run.timedOut).toBe(false);
    expect(run.error).toBeUndefined();
    expect(run.walkNote).toBeUndefined();
    const state = await readWalkState(dir);
    expect(state).toMatchObject({ attempt: 1, pid: 4242, taskId: 't1', adoptions: 0 });
  });

  it('adopts a live walk it did not launch instead of starting a second one', async () => {
    writeState();
    const { launch, calls } = fakeLauncher();
    const run = await runDetachedDuWalk(ROOT, {
      dir,
      launch,
      isAlive: () => true,
      sleep: async () => finishAttempt(1, 0, 9 * GiB),
      now: () => 5_000,
    });
    expect(calls).toHaveLength(0);
    expect(run.summary.rootBytes).toBe(9 * GiB);
    expect(run.walkNote).toContain('survived 1 operator restart(s)');
    expect((await readWalkState(dir))?.adoptions).toBe(1);
  });

  it('reads a walk that finished while no caller was waiting, without launching or waiting', async () => {
    writeState({ adoptions: 2 });
    finishAttempt(1, 0);
    const { launch, calls } = fakeLauncher();
    const sleep = vi.fn(async () => {});
    const run = await runDetachedDuWalk(ROOT, { dir, launch, isAlive: () => false, sleep });
    expect(calls).toHaveLength(0);
    expect(sleep).not.toHaveBeenCalled();
    expect(run.summary.rootBytes).toBe(5 * GiB);
    expect(run.walkNote).toContain('survived 2 operator restart(s)');
  });

  it('relaunches a walk that vanished without a status into fresh attempt files', async () => {
    writeState({ attempt: 1 });
    // A half-written output from the dead attempt must never be read as the result.
    writeFileSync(walkAttemptFiles(dir, 1).out, `${1 * GiB}\t${ROOT}\0`);
    const { launch, calls } = fakeLauncher();
    const alive = (s: DetachedWalkState) => s.attempt === 2;
    const run = await runDetachedDuWalk(ROOT, {
      dir,
      launch,
      isAlive: alive,
      sleep: async () => finishAttempt(2, 0, 8 * GiB),
      now: () => 5_000,
    });
    expect(calls.map((c) => c.attempt)).toEqual([2]);
    expect(calls[0]!.args).toContain(walkAttemptFiles(dir, 2).exit);
    expect(run.summary.rootBytes).toBe(8 * GiB);
    expect(run.walkNote).toContain('relaunched 1 time(s)');
  });

  it('gives up, with an error, once every attempt ended without a status', async () => {
    writeState({ attempt: 3 });
    const { launch, calls } = fakeLauncher();
    const run = await runDetachedDuWalk(ROOT, { dir, launch, isAlive: () => false, sleep: async () => {} });
    expect(calls).toHaveLength(0);
    expect(run.error).toMatch(/all 3 attempt\(s\)/);
  });

  it('ends a walk still running past its deadline plus grace and reports lower bounds', async () => {
    writeState({ deadlineAt: 10_000 });
    const kill = vi.fn();
    const { launch } = fakeLauncher();
    const run = await runDetachedDuWalk(ROOT, {
      dir,
      launch,
      kill,
      isAlive: () => true,
      sleep: async () => {},
      graceMs: 1_000,
      now: () => 11_001,
    });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(run.timedOut).toBe(true);
  });

  it('reads timeout(1)’s status as a timeout and an unrunnable command as an error', async () => {
    writeState();
    finishAttempt(1, TIMEOUT_EXIT_STATUS);
    const timedOut = await runDetachedDuWalk(ROOT, { dir, launch: fakeLauncher().launch, isAlive: () => false });
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.exitCode).toBe(TIMEOUT_EXIT_STATUS);

    writeFileSync(walkAttemptFiles(dir, 1).exit, '127\n');
    const failed = await runDetachedDuWalk(ROOT, { dir, launch: fakeLauncher().launch, isAlive: () => false });
    expect(failed.error).toMatch(/could not run \(exit 127\)/);
  });

  it('counts permission-denied lines from the walk’s stderr file', async () => {
    writeState();
    finishAttempt(1, 1, 5 * GiB, "du: cannot read directory '/srv/census-root/locked': Permission denied\n");
    const run = await runDetachedDuWalk(ROOT, { dir, launch: fakeLauncher().launch, isAlive: () => false });
    expect(run.deniedCount).toBe(1);
    expect(run.deniedSample).toEqual(['/srv/census-root/locked']);
  });

  it('stops waiting on abort without touching the walk', async () => {
    writeState();
    const ctl = new AbortController();
    const kill = vi.fn();
    await expect(
      runDetachedDuWalk(ROOT, {
        dir,
        launch: fakeLauncher().launch,
        kill,
        isAlive: () => true,
        sleep: async () => ctl.abort(),
        now: () => 5_000,
        signal: ctl.signal,
      }),
    ).rejects.toBeInstanceOf(DetachedWalkAbandoned);
    expect(kill).not.toHaveBeenCalled();
  });

  it('says when the walk ran unconfined, because then a restart kills it', async () => {
    writeState({ confined: false, confinementSkippedReason: 'no systemd user bus' });
    finishAttempt(1, 0);
    const run = await runDetachedDuWalk(ROOT, { dir, launch: fakeLauncher().launch, isAlive: () => false });
    expect(run.walkNote).toContain('unconfined (no systemd user bus)');
  });
});

describe('census walk directories', () => {
  it('keys each walk by run and device with filesystem-safe names', () => {
    expect(censusWalkDir('sched-.diskConsumerCensus-2026-10-13T04:35:00.000Z', '/', '/w')).toBe(
      '/w/sched-.diskConsumerCensus-2026-10-13T04_35_00.000Z/root',
    );
    expect(censusWalkDir('k', '/mnt/data', '/w')).toBe('/w/k/mnt_data');
  });

  it('prunes the finished run and stale runs, and keeps a fresh run that is still walking', async () => {
    const root = join(dir, 'walks');
    for (const name of ['done-run', 'live-run', 'old-run']) mkdirSync(join(root, name, 'root'), { recursive: true });
    const now = Date.now();
    const old = new Date(now - 3 * 24 * 60 * 60 * 1000);
    utimesSync(join(root, 'old-run'), old, old);
    const removed = await pruneCensusWalks({ root, runKey: 'done-run', now });
    expect(removed).toBe(2);
    expect(existsSync(join(root, 'live-run'))).toBe(true);
    expect(existsSync(join(root, 'done-run'))).toBe(false);
    expect(existsSync(join(root, 'old-run'))).toBe(false);
  });

  it('returns 0 when the walk root does not exist yet', async () => {
    expect(await pruneCensusWalks({ root: join(dir, 'absent') })).toBe(0);
    expect(readFileSync.length).toBeGreaterThan(0);
  });
});
