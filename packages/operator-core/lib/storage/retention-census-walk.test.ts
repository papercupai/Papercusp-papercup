import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awaitRetentionCensusCompletion, inspectDetachedRetentionTrees, RETENTION_CENSUS_LIFETIME_MS, withRetentionMutex, type RetentionMutexContext } from './retention-census-walk';
import { withFsMutex } from '../../../../scripts/lib/fs-mutex.mjs';
import { readWalkState, walkAttemptFiles, type WalkLauncher } from './disk-census-detached-walk';

// Mutex admission is verified by its own suite; these tests control only the
// detached wait/measurement lifecycle, with no machine-speed admission race.
vi.mock('../../../../scripts/lib/fs-mutex.mjs', () => ({ withFsMutex: vi.fn(async (_name: string,
  action: (held: { hasWaiters: () => Promise<boolean> }) => Promise<unknown>) => action({ hasWaiters: async () => false })) }));

let dir: string, root: string, slot: string;
const options = { retainAfterMs: Infinity, includeRecent: true };
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'retention-adopt-unit-'));
  root = join(dir, 'root'); slot = join(dir, 'slot');
  await fs.mkdir(root); await fs.writeFile(join(root, 'entry'), 'data');
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

async function finish(overrides: Record<string, unknown> = {}, resultOverrides: Record<string, unknown> = {}, code = 0) {
  const state = (await readWalkState(slot))!;
  const stat = await fs.lstat(join(root, 'entry'));
  const result = { entries: [{ path: join(root, 'entry'), dev: stat.dev, ino: stat.ino,
    newestWriteMs: Math.max(stat.mtimeMs, stat.ctimeMs), bytes: stat.blocks * 512 }],
    retained: [], inspectedNodes: 1, retainedRecentTrees: 0, ...resultOverrides };
  const files = walkAttemptFiles(slot, state.attempt);
  await fs.writeFile(files.out, JSON.stringify({ version: 1, requestKey: state.requestKey,
    startedAt: state.launchedAt, finishedAt: Date.now(), result, ...overrides }));
  await fs.writeFile(files.err, ''); await fs.writeFile(files.exit, String(code));
}
const launch = (done = true) => vi.fn<WalkLauncher>(async () => {
  if (done) await finish();
  return { pid: 999_999_999, taskId: 'fixture', confined: true };
});
const walk = (launcher: WalkLauncher, waitMs = 1000) => ({ dir: slot, launch: launcher, waitMs,
  pollMs: 2, isAlive: () => !existsSync(walkAttemptFiles(slot, 1).exit) });

describe('complete retention census adoption', () => {
  it('prepares a completed measurement without consuming it, then validates it on the normal path', async () => {
    const launcher = launch();
    const prepared = await inspectDetachedRetentionTrees(root, options, { ...walk(launcher), prepareOnly: true });
    expect(prepared.error).toContain('pending');
    expect(prepared.pendingWalk).toEqual(expect.objectContaining({ root, dir: slot, attempt: 1 }));
    expect(prepared.entries).toEqual([]);
    expect(existsSync(join(slot, 'consumed'))).toBe(false);
    const again = await inspectDetachedRetentionTrees(root, options, { ...walk(launcher), prepareOnly: true });
    expect(again.pendingWalk).toEqual(prepared.pendingWalk);
    expect(existsSync(join(slot, 'consumed'))).toBe(false);
    expect((await inspectDetachedRetentionTrees(root, options, walk(launcher))).entries.map(e => e.path))
      .toEqual([join(root, 'entry')]);
    expect(existsSync(join(slot, 'consumed'))).toBe(true);
    expect(launcher).toHaveBeenCalledOnce();
  });

  it('keeps freshness validation after preparation of a completed result', async () => {
    const launcher = launch();
    await inspectDetachedRetentionTrees(root, options, { ...walk(launcher), prepareOnly: true });
    const state = (await readWalkState(slot))!;
    await fs.writeFile(join(slot, 'state.json'), JSON.stringify({ ...state,
      launchedAt: Date.now() - RETENTION_CENSUS_LIFETIME_MS - 3 }));
    await finish({ startedAt: Date.now() - RETENTION_CENSUS_LIFETIME_MS - 2,
      finishedAt: Date.now() - RETENTION_CENSUS_LIFETIME_MS - 1 });
    const result = await inspectDetachedRetentionTrees(root, options, walk(launcher));
    expect(result.error).toBe('stale or changed retention census result');
    expect(result.entries).toEqual([]); expect(launcher).toHaveBeenCalledOnce();
  });

  it.each(['consumed', 'changed-request'])('does not retire a %s slot during preparation', async mode => {
    const launcher = launch();
    await inspectDetachedRetentionTrees(root, options, { ...walk(launcher), prepareOnly: true });
    if (mode === 'consumed') await fs.writeFile(join(slot, 'consumed'), 'consumed\n');
    const before = await fs.readFile(join(slot, 'state.json'), 'utf8');
    const output = await fs.readFile(walkAttemptFiles(slot, 1).out, 'utf8');
    const prepared = await inspectDetachedRetentionTrees(root, { ...options,
      ...(mode === 'changed-request' ? { excludedPaths: [join(root, 'entry')] } : {}),
    }, { ...walk(launcher), prepareOnly: true });
    expect(prepared.error).toContain(mode === 'consumed' ? 'consumed' : 'input changed');
    expect(prepared.entries).toEqual([]); expect(prepared.pendingWalk).toBeUndefined();
    expect(await fs.readFile(join(slot, 'state.json'), 'utf8')).toBe(before);
    expect(await fs.readFile(walkAttemptFiles(slot, 1).out, 'utf8')).toBe(output);
    expect(existsSync(join(slot, 'consumed'))).toBe(mode === 'consumed');
    expect(launcher).toHaveBeenCalledOnce();
  });

  it('uses one retention admission for an already-admitted complete census', async () => {
    vi.mocked(withFsMutex).mockClear();
    const launcher = launch();
    const result = await withRetentionMutex(retentionMutex =>
      inspectDetachedRetentionTrees(root, options, { ...walk(launcher), retentionMutex }));
    expect(result.error).toBeUndefined();
    expect(result.entries.map(entry => entry.path)).toEqual([join(root, 'entry')]);
    expect(withFsMutex).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withFsMutex).mock.calls[0]![0]).toBe('papercusp-disk-retention');
  });
  it('puts standalone census callers in the same retention domain', async () => {
    vi.mocked(withFsMutex).mockClear();
    expect((await inspectDetachedRetentionTrees(root, options, walk(launch()))).error).toBeUndefined();
    expect(withFsMutex).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withFsMutex).mock.calls[0]![0]).toBe('papercusp-disk-retention');
  });
  it('rejects an expired admission before launching or consuming a slot', async () => {
    let expired!: RetentionMutexContext;
    await withRetentionMutex(async held => { expired = held; });
    const launcher = launch();
    await expect(inspectDetachedRetentionTrees(root, options, { ...walk(launcher), retentionMutex: expired }))
      .rejects.toThrow('retention mutex context is not active');
    expect(launcher).not.toHaveBeenCalled();
    expect(existsSync(slot)).toBe(false);
  });
  it('rejects overlapping access to one slot even within the same admission', async () => {
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const launcher = launch();
    launcher.mockImplementation(async () => {
      entered(); await blocked; await finish();
      return { pid: 999_999_999, taskId: 'fixture', confined: true };
    });
    await withRetentionMutex(async retentionMutex => {
      const first = inspectDetachedRetentionTrees(root, options, { ...walk(launcher), retentionMutex });
      try {
        await ready;
        await expect(inspectDetachedRetentionTrees(root, options, { ...walk(launcher), retentionMutex }))
          .rejects.toThrow('retention census slot already in use');
      } finally { release(); await first; }
    });
    expect(launcher).toHaveBeenCalledOnce();
  });
  it('abandons only the wait, then adopts the same complete measurement exactly once', async () => {
    const launcher = launch(false);
    const first = await inspectDetachedRetentionTrees(root, options, walk(launcher, 15));
    expect(first.error).toContain('pending'); expect(first.entries).toEqual([]);
    await finish();
    const second = await inspectDetachedRetentionTrees(root, options, walk(launcher));
    expect(second.error).toBeUndefined(); expect(second.entries.map(e => e.path)).toEqual([join(root, 'entry')]);
    expect(launcher).toHaveBeenCalledOnce(); expect(await fs.readFile(join(slot, 'consumed'), 'utf8')).toBe('consumed\n');
    launcher.mockImplementation(async () => { await finish(); return { pid: 999_999_999, taskId: 'new', confined: true }; });
    expect((await inspectDetachedRetentionTrees(root, options, walk(launcher))).error).toBeUndefined();
    expect(launcher).toHaveBeenCalledTimes(2);
  });
  it('waits outside retention admission for the exact pending attempt, then adopts it with fresh admission', async () => {
    const launcher = launch(false);
    const pending = await inspectDetachedRetentionTrees(root, options, walk(launcher, 15));
    expect(pending.pendingWalk).toEqual(expect.objectContaining({ root, dir: slot, attempt: 1 }));
    const admissions = vi.mocked(withFsMutex).mock.calls.length;
    let clock = Date.now();
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const deadline = clock + RETENTION_CENSUS_LIFETIME_MS;
      expect(await awaitRetentionCensusCompletion(pending.pendingWalk!, deadline, {
        isAlive: () => true, sleep: async () => { clock += 16_000; await finish(); },
      })).toBe(true);
      expect(vi.mocked(withFsMutex).mock.calls).toHaveLength(admissions);
      expect(existsSync(join(slot, 'consumed'))).toBe(false);
      const adopted = await inspectDetachedRetentionTrees(root, options, walk(launcher));
      expect(adopted.error).toBeUndefined();
      expect(adopted.entries.map(entry => entry.path)).toEqual([join(root, 'entry')]);
      expect(launcher).toHaveBeenCalledOnce();
    } finally { now.mockRestore(); }
  });
  it.each(['consumed', 'replaced', 'deadline', 'gone'])('does not turn a %s pending attempt into continuation authority', async mode => {
    const launcher = launch(false);
    const pending = await inspectDetachedRetentionTrees(root, options, walk(launcher, 15));
    if (mode === 'consumed') await fs.writeFile(join(slot, 'consumed'), 'consumed\n');
    if (mode === 'replaced') {
      const state = (await readWalkState(slot))!;
      await fs.writeFile(join(slot, 'state.json'), JSON.stringify({ ...state, requestKey: 'replacement' }));
    }
    expect(await awaitRetentionCensusCompletion(pending.pendingWalk!, mode === 'deadline' ? Date.now() - 1 : Date.now() + 1000,
      { isAlive: () => false })).toBe(false);
    expect(launcher).toHaveBeenCalledOnce();
  });
  it('yields the held retention mutex to a queued writer by abandoning only the census wait (EI-26942454413534533)', async () => {
    const launcher = launch(false);
    let waiter = false;
    vi.mocked(withFsMutex).mockImplementationOnce((async (_name: string,
      action: (held: { hasWaiters: () => Promise<boolean> }) => Promise<unknown>) =>
      action({ hasWaiters: async () => waiter })) as unknown as typeof withFsMutex);
    const started = Date.now();
    // The caller's wait allowance is a full minute: before the fix the holder kept
    // the mutex for all of it while a queued writer spent its own budget waiting.
    const result = await withRetentionMutex(async retentionMutex => {
      setTimeout(() => { waiter = true; }, 20);
      return inspectDetachedRetentionTrees(root, options, { ...walk(launcher, 60_000), retentionMutex });
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.error).toBe('retention census pending; managed walk continues for adoption');
    expect(result.entries).toEqual([]);
    // Only the wait was abandoned: the measurement is unconsumed and adoptable.
    expect(existsSync(join(slot, 'consumed'))).toBe(false);
    await finish();
    const adopted = await inspectDetachedRetentionTrees(root, options, walk(launcher));
    expect(adopted.error).toBeUndefined();
    expect(adopted.entries.map(entry => entry.path)).toEqual([join(root, 'entry')]);
    expect(launcher).toHaveBeenCalledOnce();
  });
  it.each(['partial', 'exit', 'foreign-key', 'outside-root', 'malformed'] as const)('refuses terminal %s output before selection', async mode => {
    const launcher = launch(false);
    await inspectDetachedRetentionTrees(root, options, walk(launcher, 15));
    if (mode === 'partial') await finish({}, { error: 'retention native census timed out' });
    if (mode === 'exit') await finish({}, {}, 1);
    if (mode === 'foreign-key') await finish({ requestKey: 'different' });
    if (mode === 'outside-root') await finish({}, { entries: [{ path: '/outside/root', dev: 1, ino: 1, bytes: 1, newestWriteMs: 1 }] });
    if (mode === 'malformed') {
      await finish(); const state = (await readWalkState(slot))!;
      await fs.writeFile(walkAttemptFiles(slot, state.attempt).out, '{truncated');
    }
    const result = await inspectDetachedRetentionTrees(root, options, walk(launcher));
    expect(result.error).toBeDefined(); expect(result.entries).toEqual([]); expect(result.retained).toEqual([]);
    expect(launcher).toHaveBeenCalledOnce(); expect(await fs.readFile(join(slot, 'consumed'), 'utf8')).toBe('consumed\n');
  });
  it('reports a finished changed-options census before replacing its live slot', async () => {
    const launcher = launch(false);
    const changedOptions = { ...options, excludedPaths: [join(root, 'excluded')] };
    await inspectDetachedRetentionTrees(root, options, walk(launcher, 15));
    expect((await inspectDetachedRetentionTrees(root, changedOptions, walk(launcher))).error).toContain('still active');
    expect(launcher).toHaveBeenCalledOnce();
    await finish();
    const changed = await inspectDetachedRetentionTrees(root, changedOptions, walk(launcher));
    expect(changed.error).toBe('retention census input changed since previous measurement');
    expect(changed.entries).toEqual([]); expect(changed.retained).toEqual([]);
    expect(launcher).toHaveBeenCalledOnce();
    expect(await fs.readFile(join(slot, 'consumed'), 'utf8')).toBe('consumed\n');
    launcher.mockImplementation(async () => { await finish(); return { pid: 999_999_999, taskId: 'new', confined: true }; });
    await inspectDetachedRetentionTrees(root, changedOptions, walk(launcher));
    expect(launcher).toHaveBeenCalledTimes(2);
  });
  // EI-26925507003255681: repo scratch gains a direct child every few seconds while a
  // walk takes minutes. Keying adoption on the root's mtime/ctime retired every finished
  // census, so the root could never be adopted (a livelock, not budget starvation).
  it('adopts a finished census while the root keeps gaining direct children', async () => {
    const launcher = launch(false);
    expect((await inspectDetachedRetentionTrees(root, options, walk(launcher, 15))).error).toBeDefined();
    for (let i = 0; i < 3; i++) await fs.writeFile(join(root, `arrival-${i}`), 'new');
    await finish();
    await fs.writeFile(join(root, 'arrival-after-finish'), 'new');
    const adopted = await inspectDetachedRetentionTrees(root, options, walk(launcher));
    expect(adopted.error).toBeUndefined();
    expect(adopted.entries.map((entry) => entry.path)).toEqual([join(root, 'entry')]);
    expect(launcher).toHaveBeenCalledOnce();
    expect(await fs.readFile(join(slot, 'consumed'), 'utf8')).toBe('consumed\n');
  });
  it('rejects expired successful output without treating it as a cap total', async () => {
    const launcher = launch(false);
    await inspectDetachedRetentionTrees(root, options, walk(launcher, 15));
    const state = (await readWalkState(slot))!;
    state.launchedAt = Date.now() - RETENTION_CENSUS_LIFETIME_MS * 3;
    await fs.writeFile(join(slot, 'state.json'), JSON.stringify(state));
    await finish({ startedAt: state.launchedAt, finishedAt: Date.now() - RETENTION_CENSUS_LIFETIME_MS - 1000 });
    const result = await inspectDetachedRetentionTrees(root, options, walk(launcher));
    expect(result.error).toContain('stale'); expect(result.entries).toEqual([]);
  });
  it.each(['consumed', 'changed-input'] as const)('retires a dead %s attempt even when no exit receipt survived', async mode => {
    const launcher = launch(false);
    await inspectDetachedRetentionTrees(root, options, walk(launcher, 15));
    const next = mode === 'changed-input' ? { ...options, excludedPaths: [join(root, 'excluded')] } : options;
    if (mode === 'consumed') await fs.writeFile(join(slot, 'consumed'), 'consumed\n');
    launcher.mockImplementation(async () => { await finish(); return { pid: 999_999_999, taskId: 'replacement', confined: true }; });
    if (mode === 'changed-input') {
      const changed = await inspectDetachedRetentionTrees(root, next, { ...walk(launcher), isAlive: () => false });
      expect(changed.error).toBe('retention census input changed since previous measurement');
      expect(launcher).toHaveBeenCalledOnce();
      expect(await fs.readFile(join(slot, 'consumed'), 'utf8')).toBe('consumed\n');
    }
    const replacement = await inspectDetachedRetentionTrees(root, next, { ...walk(launcher), isAlive: () => false });
    expect(replacement.error).toBeUndefined();
    expect(launcher).toHaveBeenCalledTimes(2);
  });
  it('preserves a live worker when census options change', async () => {
    const launcher = launch(false);
    await inspectDetachedRetentionTrees(root, options, walk(launcher, 15));
    const result = await inspectDetachedRetentionTrees(root, { ...options, collectBuildDirs: true }, walk(launcher));
    expect(result.error).toContain('still active'); expect(result.entries).toEqual([]);
    expect(launcher).toHaveBeenCalledOnce();
  });
  it('keeps bounded worker stderr when a terminal command fails', async () => {
    const launcher = launch(false);
    await inspectDetachedRetentionTrees(root, options, walk(launcher, 15));
    await finish({}, {}, 1);
    const state = (await readWalkState(slot))!;
    await fs.writeFile(walkAttemptFiles(slot, state.attempt).err, 'discarded-prefix' + 'x'.repeat(6000) + '\nworker diagnostic');
    const result = await inspectDetachedRetentionTrees(root, options, walk(launcher));
    expect(result.error).toContain('worker diagnostic'); expect(result.error).not.toContain('discarded-prefix');
    expect(result.error!.length).toBeLessThan(4200); expect(result.entries).toEqual([]);
  });
  it('refuses a non-initial or uncompacted-pin request', async () => {
    await expect(inspectDetachedRetentionTrees(root, { ...options, paths: [join(root, 'entry')] }, walk(launch()))).rejects.toThrow('unsupported');
  });
});
