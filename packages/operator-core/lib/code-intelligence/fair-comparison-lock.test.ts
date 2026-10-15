import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireArmRunLock, armRunLockPath, procStartTicks, type ArmRunLockDeps } from './fair-comparison-lock';

const at = new Date('2026-10-06T12:00:00Z');
/** A process table: pid -> start ticks. */
const deps = (pid: number, table: Record<number, string>): ArmRunLockDeps => ({ pid, startTicksOf: (p) => table[p] ?? null, now: () => at });

describe('acquireArmRunLock', () => {
  let out: string;
  beforeEach(async () => {
    out = await mkdtemp(join(tmpdir(), 'fair-lock-'));
  });
  afterEach(async () => {
    await rm(out, { recursive: true, force: true });
  });

  it('refuses a second run of the same arm while the first holder is alive', async () => {
    const table = { 100: '5000', 200: '9000' };
    const first = await acquireArmRunLock(out, 'codegraphcontext', deps(100, table));
    await expect(acquireArmRunLock(out, 'codegraphcontext', deps(200, table))).rejects.toThrow(/already running .*pid 100/);
    await first.release();
  });

  it('lets different arms run at once', async () => {
    const table = { 100: '5000', 200: '9000' };
    const a = await acquireArmRunLock(out, 'codegraph', deps(100, table));
    const b = await acquireArmRunLock(out, 'codegraphcontext', deps(200, table));
    await a.release();
    await b.release();
  });

  it('replaces a lock whose holder is gone', async () => {
    await acquireArmRunLock(out, 'rg', deps(100, { 100: '5000' }));
    // pid 100 has exited: it is no longer in the table.
    const next = await acquireArmRunLock(out, 'rg', deps(200, { 200: '9000' }));
    expect(JSON.parse(await readFile(armRunLockPath(out, 'rg'), 'utf8')).pid).toBe(200);
    await next.release();
  });

  it('treats a reused pid (same pid, different start time) as stale', async () => {
    await acquireArmRunLock(out, 'rg', deps(100, { 100: '5000' }));
    // pid 100 now belongs to a different process that started later.
    const next = await acquireArmRunLock(out, 'rg', deps(300, { 100: '7777', 300: '8000' }));
    expect(JSON.parse(await readFile(armRunLockPath(out, 'rg'), 'utf8')).pid).toBe(300);
    await next.release();
  });

  it('release removes the lock so the arm can run again', async () => {
    const table = { 100: '5000', 200: '9000' };
    const first = await acquireArmRunLock(out, 'rg', deps(100, table));
    await first.release();
    const second = await acquireArmRunLock(out, 'rg', deps(200, table));
    await second.release();
  });

  it('release never removes a lock another run took over', async () => {
    const stale = await acquireArmRunLock(out, 'rg', deps(100, { 100: '5000' }));
    const taker = await acquireArmRunLock(out, 'rg', deps(200, { 200: '9000' }));
    await stale.release();
    expect(JSON.parse(await readFile(armRunLockPath(out, 'rg'), 'utf8')).pid).toBe(200);
    await taker.release();
  });

  it('replaces an unreadable lock file', async () => {
    await writeFile(armRunLockPath(out, 'rg'), 'not json');
    const lock = await acquireArmRunLock(out, 'rg', deps(100, { 100: '5000' }));
    await lock.release();
  });
});

describe('procStartTicks', () => {
  it('reads this process start time and returns null for a pid that does not exist', () => {
    expect(procStartTicks(process.pid)).toMatch(/^\d+$/);
    expect(procStartTicks(2 ** 22 + 12345)).toBeNull();
  });
});
