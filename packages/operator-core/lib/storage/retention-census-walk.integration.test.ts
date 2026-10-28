import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectRetentionTrees } from './disk-consumer-census';
import { awaitRetentionCensusCompletion, inspectDetachedRetentionTrees, withRetentionMutex } from './retention-census-walk';
import type { WalkLauncher } from './disk-census-detached-walk';

const dirs: string[] = [], children: ChildProcess[] = [];
let originalLockRoot: string | undefined;
beforeEach(async () => {
  originalLockRoot = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  const locks = await fs.mkdtemp(join(tmpdir(), 'retention-integration-locks-')); dirs.push(locks);
  process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = locks;
});
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) { child.kill('SIGCONT'); child.kill('SIGTERM'); }
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
  if (originalLockRoot === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = originalLockRoot;
});

describe('retention metadata worker real process', () => {
  it('keeps standalone callers behind the outer retention owner and reuses its admission', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'retention-shared-admission-')); dirs.push(dir);
    const previous = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = join(dir, 'locks');
    const root = join(dir, 'root'), slot = join(dir, 'slot');
    await fs.mkdir(root); await fs.writeFile(join(root, 'entry'), 'data');
    let launches = 0;
    const launch: WalkLauncher = async (cmd, args) => {
      launches++;
      const child = spawn(cmd, args, { stdio: 'ignore' }); children.push(child);
      if (!child.pid) throw new Error('native test launch failed');
      return { pid: child.pid, taskId: 'real-admitted-worker', confined: true };
    };
    const options = { retainAfterMs: Infinity, includeRecent: true };
    try {
      await withRetentionMutex(async retentionMutex => {
        await expect(inspectDetachedRetentionTrees(root, options, { dir: slot, waitMs: 100, launch }))
          .rejects.toThrow('waiting for fs-mutex');
        expect(launches).toBe(0);
        await expect(fs.access(slot)).rejects.toMatchObject({ code: 'ENOENT' });
        const result = await inspectDetachedRetentionTrees(root, options,
          { dir: slot, waitMs: 25_000, pollMs: 5, launch, retentionMutex });
        expect(result.error).toBeUndefined();
        expect(result.entries.map(entry => entry.path)).toEqual([join(root, 'entry')]);
        expect(launches).toBe(1);
      });
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
      else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = previous;
    }
  }, 30_000);
  it('survives an abandoned caller and adopts the full hardlink/protection census without relaunch', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'retention-adopt-native-')); dirs.push(dir);
    const root = join(dir, 'root'); await fs.mkdir(root);
    await fs.mkdir(join(root, 'first')); await fs.writeFile(join(root, 'first', 'data'), 'data');
    await fs.link(join(root, 'first', 'data'), join(root, 'linked'));
    await fs.symlink('/outside', join(root, 'boundary'));
    const options = { retainAfterMs: Infinity, includeRecent: true, collectBuildDirs: true, progressTimeoutMs: 5000 };
    const expected = await inspectRetentionTrees(root, options);
    let launches = 0;
    const launch: WalkLauncher = async (cmd, args) => {
      launches++;
      const child = spawn(cmd, args, { stdio: 'ignore' }); children.push(child);
      if (!child.pid) throw new Error('native test launch failed');
      // Hold this owned process until the caller has abandoned its wait. This
      // proves adoption independently of TypeScript startup or machine speed.
      child.kill('SIGSTOP');
      return { pid: child.pid, taskId: 'real-test-worker', confined: true };
    };
    const slot = join(dir, 'slot');
    const pending = await inspectDetachedRetentionTrees(root, options, { dir: slot, waitMs: 1000, pollMs: 5, launch });
    expect(pending.error).toContain('pending'); expect(pending.entries).toEqual([]);
    expect(pending.pendingWalk).toEqual(expect.objectContaining({ root, dir: slot }));
    children[children.length - 1]!.kill('SIGCONT');
    expect(await awaitRetentionCensusCompletion(pending.pendingWalk!, Date.now() + 25_000)).toBe(true);
    const adopted = await inspectDetachedRetentionTrees(root, options, { dir: slot, waitMs: 25_000, pollMs: 5, launch });
    expect(adopted.error).toBeUndefined(); expect(launches).toBe(1);
    expect(adopted.entries).toEqual(expected.entries); expect(adopted.retained).toEqual(expected.retained);
    expect(adopted.inspectedNodes).toBe(expected.inspectedNodes);
    expect(await fs.readFile(join(slot, 'consumed'), 'utf8')).toBe('consumed\n');
  }, 30_000);
});
