/**
 * proc-open-file-scan.test.ts — WI-10006519.
 *
 * git-sync's /proc holder scan used to be serial; inside the busy bg-host one
 * scan took ~10 minutes while an orphaned index.lock froze every commit. These
 * cases pin the bounded parallel replacement's VERDICTS, including the
 * fail-closed `null` past its deadline. A fake /proc tree makes them
 * deterministic; one real-/proc case proves the default instrument still sees
 * a descriptor this process holds open.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProcForOpenFile } from './proc-open-file-scan';
import { procLockHolder } from './run-git-sync';

let root: string | null = null;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

/** Build `<root>/<pid>/fd/<n> -> target` for each pid's list of targets. */
async function fakeProc(tree: Record<string, string[] | 'unreadable'>, extras: string[] = []): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'fake-proc-'));
  for (const [pid, targets] of Object.entries(tree)) {
    if (targets === 'unreadable') {
      await mkdir(join(root, pid)); // no fd/ dir: readdir fails like an exited or foreign pid
      continue;
    }
    await mkdir(join(root, pid, 'fd'), { recursive: true });
    for (const [i, target] of targets.entries()) await symlink(target, join(root, pid, 'fd', String(i)));
  }
  for (const name of extras) await writeFile(join(root, name), '');
  return root;
}

const LOCK = '/repo/.git/index.lock';

describe('scanProcForOpenFile (WI-10006519)', () => {
  it('finds a holder among many pids, whatever worker reaches it', async () => {
    const tree: Record<string, string[]> = {};
    for (let pid = 100; pid < 400; pid++) tree[String(pid)] = ['/dev/null', `/tmp/f${pid}`, 'socket:[1]'];
    tree['377'] = ['/dev/null', LOCK];
    const procRoot = await fakeProc(tree);
    for (const concurrency of [1, 4, 64, 1000]) {
      const r = await scanProcForOpenFile((t) => t === LOCK, { procRoot, concurrency });
      expect(r.held, `concurrency ${concurrency}`).toBe(true);
      expect(r.timedOut).toBe(false);
    }
  });

  it('a COMPLETE scan with no match is a proven false, counting every pid', async () => {
    const procRoot = await fakeProc({ '1': ['/dev/null'], '2': ['/x/other.lock'], '3': 'unreadable' }, ['self', 'meminfo']);
    const r = await scanProcForOpenFile((t) => t === LOCK, { procRoot, concurrency: 2 });
    expect(r).toMatchObject({ held: false, timedOut: false, pidsTotal: 3, pidsScanned: 3 });
  });

  it('past the deadline the answer is null (cannot tell), NEVER a false that would license an unlink', async () => {
    const procRoot = await fakeProc({ '1': ['/dev/null'], '2': ['/dev/null'], '3': [LOCK] });
    let t = 0;
    // Every now() read advances 10s, so the 5s deadline passes before any pid is scanned.
    const r = await scanProcForOpenFile((x) => x === LOCK, { procRoot, deadlineMs: 5_000, now: () => (t += 10_000) });
    expect(r.held).toBeNull();
    expect(r.timedOut).toBe(true);
  });

  it('no usable /proc (missing root, or no pid entries) answers null so the caller falls back to lsof', async () => {
    expect((await scanProcForOpenFile(() => true, { procRoot: '/definitely/not/a/proc/root' })).held).toBeNull();
    const procRoot = await fakeProc({}, ['self']);
    expect((await scanProcForOpenFile(() => true, { procRoot })).held).toBeNull();
  });

  it('procLockHolder matches the exact lock path only', async () => {
    const procRoot = await fakeProc({ '10': [`${LOCK}.bak`, '/repo/.git/index'], '11': [LOCK] });
    expect(await procLockHolder(LOCK, { procRoot })).toBe(true);
    expect(await procLockHolder('/repo/.git/config.lock', { procRoot })).toBe(false);
  });
});

describe.skipIf(!existsSync('/proc/self/fd'))('scanProcForOpenFile against the real /proc (WI-10006519)', () => {
  it('sees a lock this process holds open, and no holder once it is closed', async () => {
    root = await mkdtemp(join(tmpdir(), 'real-proc-'));
    const lock = join(root, 'index.lock');
    await writeFile(lock, '');
    const fh = await open(lock, 'r');
    try {
      expect(await procLockHolder(lock)).toBe(true);
    } finally {
      await fh.close();
    }
    expect(await procLockHolder(lock)).toBe(false);
  }, 120_000);
});
