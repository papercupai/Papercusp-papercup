/**
 * The census du walk survives the caller that started it (WI-6554700010009855): real du,
 * real processes, real files. A caller that stops waiting stands in for a bg-host restart
 * mid-walk; the next caller must ADOPT the still-running walk rather than start a second
 * one, and a walk killed mid-run must be relaunched rather than read as a result.
 */
import { execFileSync, spawn } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDuTree } from './disk-consumer-census';
import {
  DetachedWalkAbandoned,
  readWalkState,
  runDetachedDuWalk,
  runDetachedDuUsage,
  TIMEOUT_EXIT_STATUS,
  walkAttemptFiles,
  walkProcessAlive,
  type WalkLauncher,
} from './disk-census-detached-walk';

const linux = process.platform === 'linux';
let base: string;
let tree: string;
const floorBytes = 1;
const maxDepth = 2;

/** stdio ignored, so the walk holds no pipe to this process and keeps running after we stop waiting. */
function countingLauncher(): { launch: WalkLauncher; launches: number[] } {
  const launches: number[] = [];
  const launch: WalkLauncher = async (cmd, args, meta) => {
    launches.push(meta.attempt);
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    if (child.pid == null) throw new Error('no pid');
    return { pid: child.pid, taskId: null, confined: true };
  };
  return { launch, launches };
}

/** du that waits `seconds` before walking, so a test can act mid-walk. */
const slowDu = (seconds: number) => (duArgs: string[]): [string, string[]] => [
  'sh',
  ['-c', `sleep ${seconds}; exec du "$@"`, 'slow-du', ...duArgs],
];

async function waitUntil(pred: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met in time');
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'census-walk-int-'));
  tree = join(base, 'tree');
  for (const [rel, kb] of [
    ['a/one.bin', 64],
    ['a/b/two.bin', 128],
    ['c/three.bin', 32],
  ] as const) {
    const path = join(tree, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, Buffer.alloc(kb * 1024, 7));
  }
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!linux)('detached census walk (real du, real processes)', () => {
  it.each([0, 7, TIMEOUT_EXIT_STATUS])('propagates walk exit %i to the managed scope as well as its durable receipt', async (exitCode) => {
    let scopeExit!: Promise<number | null>;
    const launch: WalkLauncher = async (cmd, args) => {
      const child = spawn(cmd, args, { stdio: 'ignore' });
      scopeExit = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      if (child.pid == null) throw new Error('no pid');
      return { pid: child.pid, taskId: null, confined: true };
    };
    const dir = join(base, `scope-exit-${exitCode}`);
    const run = await runDetachedDuWalk(tree, {
      dir, launch, pollMs: 25,
      command: () => ['sh', ['-c', 'printf "1\\t%s\\0" "$1"; exit "$2"', 'walk-exit', tree, String(exitCode)]],
    });
    expect(run.exitCode).toBe(exitCode);
    expect(readFileSync(walkAttemptFiles(dir, 1).exit, 'utf8').trim()).toBe(String(exitCode));
    expect(await scopeExit).toBe(exitCode);
  });

  it('fails the managed scope when a successful walk cannot persist its exit receipt', async () => {
    let scopeExit!: Promise<number | null>;
    const launch: WalkLauncher = async (cmd, args, meta) => {
      mkdirSync(walkAttemptFiles(meta.dir, meta.attempt).exit + '.part');
      const child = spawn(cmd, args, { stdio: 'ignore' });
      scopeExit = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      if (child.pid == null) throw new Error('no pid');
      return { pid: child.pid, taskId: null, confined: true };
    };
    const run = await runDetachedDuWalk(tree, {
      dir: join(base, 'scope-receipt-failure'), launch, pollMs: 25, maxAttempts: 1,
      command: () => ['sh', ['-c', 'exit 0']],
    });
    expect(run.exitCode).toBeNull();
    expect(run.error).toContain('without an exit status');
    expect(await scopeExit).toBe(125);
  });

  it('preserves ordered cross-root hardlink allocation and stores only root totals', async () => {
    const roots = [join(base, 'usage pinned'), join(base, 'usage\nevictable')];
    roots.forEach(root => mkdirSync(root));
    writeFileSync(join(roots[0]!, 'shared'), Buffer.alloc(128 * 1024, 7));
    linkSync(join(roots[0]!, 'shared'), join(roots[1]!, 'shared'));
    for (let i = 0; i < 300; i++) writeFileSync(join(roots[1]!, `f${i}`), 'x');
    const reference = execFileSync('du', ['--summarize', '--one-file-system', '--block-size=1', '--null', '--', ...roots], { encoding: 'utf8' });
    const expected = new Map(reference.split('\0').filter(Boolean).map(row => {
      const tab = row.indexOf('\t'); return [row.slice(tab + 1), Number(row.slice(0, tab))] as const;
    }));
    const dir = join(base, 'usage-totals'), { launch, launches } = countingLauncher();
    const run = await runDetachedDuUsage(roots, { dir, launch, pollMs: 25 });
    expect(run.complete).toBe(true);
    expect(run.bytes).toEqual(expected);
    expect(launches).toEqual([1]);
    expect(run.finishedAt).toBeGreaterThanOrEqual(run.startedAt);
    const output = readFileSync(walkAttemptFiles(dir, 1).out, 'utf8');
    expect(output.split('\0').filter(Boolean)).toHaveLength(2);
    expect(output).not.toContain('/f299');
    const progress = JSON.parse(readFileSync(join(dir, 'usage-progress.json'), 'utf8'));
    expect(progress.metadataRecords).toBeGreaterThan(300);
    expect(progress.completedRoots).toBe(2);
    expect(progress.error).toBeNull();
    // Reversing roots changes who owns the shared allocation and cannot adopt
    // this result, nor start a parallel process in its directory.
    await expect(runDetachedDuUsage([...roots].reverse(), { dir, launch })).rejects.toThrow('request changed');
    expect(launches).toEqual([1]);
  });

  it('resumes a usage scan after its caller budget expires, without replaying the population', async () => {
    const dir = join(base, 'usage-adopt'), first = countingLauncher();
    const ctl = new AbortController();
    await expect(runDetachedDuUsage([tree], {
      dir, launch: async (...args) => {
        const result = await first.launch(...args); ctl.abort(); return result;
      }, command: slowDu(1), pollMs: 25, signal: ctl.signal,
    })).rejects.toBeInstanceOf(DetachedWalkAbandoned);
    const state = (await readWalkState(dir))!;
    expect(walkProcessAlive(state)).toBe(true);
    const second = countingLauncher();
    const addedRoot = join(base, 'usage-added'); mkdirSync(addedRoot);
    await expect(runDetachedDuUsage([tree, addedRoot], { dir, launch: second.launch })).rejects.toThrow('request changed');
    expect(second.launches).toEqual([]);
    const run = await runDetachedDuUsage([tree], { dir, launch: second.launch, pollMs: 25 });
    expect(run.complete).toBe(true);
    expect(run.bytes?.get(tree)).toBeGreaterThan(0);
    expect(first.launches).toEqual([1]);
    expect(second.launches).toEqual([]);
    expect((await readWalkState(dir))?.adoptions).toBe(1);
  });

  it('keeps cap bytes unknown after failed, partial, duplicate or malformed output', async () => {
    const cases = [
      ['partial', 'printf "1\\t%s/child\\0" "$1"'],
      ['duplicate', 'printf "1\\t%s\\0" "$1" "$1"'],
      ['malformed', 'printf "bad\\t%s\\0" "$1"'],
      ['exit-failure', 'printf "1\\t%s\\0" "$1"; exit 1'],
    ] as const;
    for (const [name, script] of cases) {
      const { launch } = countingLauncher();
      const run = await runDetachedDuUsage([tree], {
        dir: join(base, `usage-${name}`), launch, pollMs: 25,
        command: () => ['sh', ['-c', script, 'bad-du', tree]],
      });
      expect(run.complete, name).toBe(false);
      expect(run.bytes, name).toBeNull();
      expect(run.error, name).toBeTruthy();
    }
  });

  it('refuses a replaced root identity instead of reusing its finished totals', async () => {
    const root = join(base, 'usage-replace'); mkdirSync(root);
    writeFileSync(join(root, 'file'), 'before');
    const dir = join(base, 'usage-replace-state'), { launch, launches } = countingLauncher();
    expect((await runDetachedDuUsage([root], { dir, launch, pollMs: 25 })).complete).toBe(true);
    renameSync(root, root + '-old'); mkdirSync(root);
    await expect(runDetachedDuUsage([root], { dir, launch })).rejects.toThrow('request changed');
    expect(launches).toEqual([1]);
  });

  it('measures exactly what the in-process walk measures', async () => {
    const reference = await runDuTree(tree, { floorBytes, maxDepth });
    const { launch, launches } = countingLauncher();
    const run = await runDetachedDuWalk(tree, { dir: join(base, 'w-plain'), floorBytes, maxDepth, launch, pollMs: 50 });
    expect(launches).toEqual([1]);
    expect(run.exitCode).toBe(0);
    expect(run.timedOut).toBe(false);
    expect(run.summary.rootBytes).toBe(reference.summary.rootBytes);
    expect(run.summary.consumers).toEqual(reference.summary.consumers);
  });

  it('keeps walking after its caller stops waiting, and the next caller adopts it instead of starting over', async () => {
    const dir = join(base, 'w-adopt');
    const reference = await runDuTree(tree, { floorBytes, maxDepth });
    const first = countingLauncher();
    await expect(
      runDetachedDuWalk(tree, {
        dir,
        floorBytes,
        maxDepth,
        launch: first.launch,
        command: slowDu(2),
        pollMs: 50,
        signal: AbortSignal.timeout(400),
      }),
    ).rejects.toBeInstanceOf(DetachedWalkAbandoned);
    const state = await readWalkState(dir);
    expect(state?.pid).toBeTypeOf('number');
    // The caller is gone; the walk is not.
    expect(walkProcessAlive(state!)).toBe(true);

    const second = countingLauncher();
    const run = await runDetachedDuWalk(tree, { dir, floorBytes, maxDepth, launch: second.launch, command: slowDu(2), pollMs: 50 });
    expect(first.launches).toEqual([1]);
    expect(second.launches).toEqual([]);
    expect(run.summary.rootBytes).toBe(reference.summary.rootBytes);
    expect(run.summary.consumers).toEqual(reference.summary.consumers);
    expect(run.walkNote).toContain('survived 1 operator restart(s)');
    expect((await readWalkState(dir))?.adoptions).toBe(1);
  });

  it('relaunches a walk killed mid-run instead of reading its partial output', async () => {
    const dir = join(base, 'w-killed');
    const reference = await runDuTree(tree, { floorBytes, maxDepth });
    const first = countingLauncher();
    await expect(
      runDetachedDuWalk(tree, {
        dir,
        floorBytes,
        maxDepth,
        launch: first.launch,
        command: slowDu(30),
        // The orphaned sleep under timeout(1) ends within 3 s of the kill below.
        timeoutMs: 3_000,
        pollMs: 50,
        signal: AbortSignal.timeout(300),
      }),
    ).rejects.toBeInstanceOf(DetachedWalkAbandoned);
    const state = (await readWalkState(dir))!;
    process.kill(state.pid!, 'SIGKILL');
    await waitUntil(() => !walkProcessAlive(state));

    const second = countingLauncher();
    const run = await runDetachedDuWalk(tree, { dir, floorBytes, maxDepth, launch: second.launch, pollMs: 50 });
    expect(second.launches).toEqual([2]);
    expect(run.exitCode).toBe(0);
    expect(run.summary.rootBytes).toBe(reference.summary.rootBytes);
    expect(run.walkNote).toContain('relaunched 1 time(s)');
  });

  it('is bounded by timeout(1) inside the walk, not by the caller', async () => {
    const { launch } = countingLauncher();
    const run = await runDetachedDuWalk(tree, {
      dir: join(base, 'w-timeout'),
      floorBytes,
      maxDepth,
      launch,
      command: slowDu(10),
      timeoutMs: 1_000,
      pollMs: 50,
    });
    expect(run.exitCode).toBe(TIMEOUT_EXIT_STATUS);
    expect(run.timedOut).toBe(true);
    expect(run.summary.rootBytes).toBeNull();
  });
});
