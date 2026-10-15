/**
 * corestore-cache.test.ts — substrate-internals coverage (A5) for the
 * per-harness Corestore factory cache (corestore.ts), which had NO direct test.
 *
 * Contracts:
 *   - getHarnessStore caches by (workspaceRoot, harnessSlug): the same key returns
 *     the SAME store instance; a different key returns a DIFFERENT one.
 *   - Concurrent first-opens for one key collapse to a SINGLE store (the cache
 *     stores the in-flight Promise, so two parallel callers share one open).
 *   - closeHarnessStore evicts the cache entry: a subsequent getHarnessStore for
 *     that key opens a FRESH store (not the closed one).
 *   - closeHarnessStore on an uncached key is a no-op (no throw).
 */

import { afterEach, afterAll, describe, expect, it, vi } from 'vitest';
import Corestore from 'corestore';
import { channel } from 'node:diagnostics_channel';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getHarnessStore,
  CORESTORE_OPEN_CHANNEL,
  type CorestoreOpenObservation,
  closeHarnessStore,
  harnessStoreLockPath,
  _resetCacheForTests,
  _resolveCorestoreCacheBlocksForTests,
  _DEFAULT_CORESTORE_CACHE_BLOCKS_FOR_TESTS,
  _lockHolderIsProvablyStaleForTests,
} from '../corestore';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {}
  }
  _resetCacheForTests();
});

function tmpRoot(prefix = 'mb-cstore-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
  return dir;
}

describe('getHarnessStore — per-(workspaceRoot, harnessSlug) cache (A5)', () => {
  it('distinguishes a pending native ready from a completed open', async () => {
    const root = tmpRoot();
    const opts = { workspaceRoot: root, harnessSlug: 'delayed-ready' };
    const events: CorestoreOpenObservation[] = [];
    let entered!: () => void;
    const nativeEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const pause = new Promise<void>((resolve) => { release = resolve; });
    const diagnostic = channel(CORESTORE_OPEN_CHANNEL);
    const listener = (message: unknown) => {
      const event = message as CorestoreOpenObservation;
      if (event.workspaceRoot === root) events.push(event);
    };
    diagnostic.subscribe(listener);
    const originalReady = Corestore.prototype.ready;
    const ready = vi.spyOn(Corestore.prototype, 'ready').mockImplementation(async function (this: Corestore) {
      entered();
      await pause;
      return originalReady.call(this);
    });
    const opening = getHarnessStore(opts);
    // Register cleanup before awaiting native work, as in the A003 fixture.
    cleanups.push(async () => {
      release();
      await opening;
      await closeHarnessStore(opts);
      ready.mockRestore();
      diagnostic.unsubscribe(listener);
    });
    await nativeEntered;
    expect(events.at(-1)).toMatchObject({ stage: 'native-ready', outcome: 'started' });
    expect(events.some((event) => event.outcome === 'succeeded')).toBe(false);
    release();
    await opening;
    expect(events.at(-1)).toMatchObject({ stage: 'ready', outcome: 'succeeded' });
  });

  it('reports real open stages in order and the actual failed lock stage', async () => {
    const root = tmpRoot();
    const events: CorestoreOpenObservation[] = [];
    const diagnostic = channel(CORESTORE_OPEN_CHANNEL);
    const listener = (message: unknown) => {
      const event = message as CorestoreOpenObservation;
      if (event.workspaceRoot === root) events.push(event);
    };
    diagnostic.subscribe(listener);
    cleanups.push(() => { diagnostic.unsubscribe(listener); });
    const opts = { workspaceRoot: root, harnessSlug: 'observed' };
    await getHarnessStore(opts);
    cleanups.push(() => closeHarnessStore(opts));
    expect(events.map(({ stage, outcome }) => [stage, outcome])).toEqual([
      ['directory', 'started'], ['lock', 'started'], ['device-heal', 'started'],
      ['native-ready', 'started'], ['ready', 'succeeded'],
    ]);
    expect(events.every((event, index) => event.elapsedMs >= 0 &&
      (index === 0 || event.atMs >= events[index - 1].atMs))).toBe(true);
    await getHarnessStore(opts);
    expect(events).toHaveLength(5); // Cached callers do not invent another open.

    const locked = { workspaceRoot: root, harnessSlug: 'blocked' };
    await mkdir(join(root, '.papercusp', 'blocked', 'hyperbee'), { recursive: true });
    await writeFile(harnessStoreLockPath(locked), JSON.stringify({ pid: process.pid, token: 'live' }));
    await expect(getHarnessStore(locked)).rejects.toThrow('already open by process');
    expect(events.slice(5).map(({ stage, outcome }) => [stage, outcome])).toEqual([
      ['directory', 'started'], ['lock', 'started'], ['lock', 'failed'],
    ]);
  });

  it('returns the SAME instance for the same key, a DIFFERENT instance for a different key', async () => {
    const root = tmpRoot();
    const a1 = await getHarnessStore({ workspaceRoot: root, harnessSlug: 'A' });
    const a2 = await getHarnessStore({ workspaceRoot: root, harnessSlug: 'A' });
    const b = await getHarnessStore({ workspaceRoot: root, harnessSlug: 'B' });

    expect(a1).toBeInstanceOf(Corestore);
    expect(a2).toBe(a1); // cached
    expect(b).not.toBe(a1); // different slug → different store

    // A different workspaceRoot is also a different key.
    const root2 = tmpRoot();
    const a3 = await getHarnessStore({ workspaceRoot: root2, harnessSlug: 'A' });
    expect(a3).not.toBe(a1);

    await closeHarnessStore({ workspaceRoot: root, harnessSlug: 'A' });
    await closeHarnessStore({ workspaceRoot: root, harnessSlug: 'B' });
    await closeHarnessStore({ workspaceRoot: root2, harnessSlug: 'A' });
  });

  it('two PARALLEL first-opens for one key collapse to a single store (one open)', async () => {
    const root = tmpRoot();
    // Fire both before awaiting either — the cache must store the in-flight
    // Promise so the second caller joins the first open rather than racing a
    // second `new Corestore` over the same path.
    const [s1, s2] = await Promise.all([
      getHarnessStore({ workspaceRoot: root, harnessSlug: 'P' }),
      getHarnessStore({ workspaceRoot: root, harnessSlug: 'P' }),
    ]);
    expect(s1).toBe(s2);
    await closeHarnessStore({ workspaceRoot: root, harnessSlug: 'P' });
  });

  it('after closeHarnessStore, getHarnessStore opens a FRESH store for that key', async () => {
    const root = tmpRoot();
    const first = await getHarnessStore({ workspaceRoot: root, harnessSlug: 'C' });
    await closeHarnessStore({ workspaceRoot: root, harnessSlug: 'C' });

    const second = await getHarnessStore({ workspaceRoot: root, harnessSlug: 'C' });
    expect(second).not.toBe(first); // cache evicted → reopened fresh
    expect(second).toBeInstanceOf(Corestore);
    await closeHarnessStore({ workspaceRoot: root, harnessSlug: 'C' });
  });

  it('closeHarnessStore on an uncached key is a no-op (no throw)', async () => {
    const root = tmpRoot();
    await expect(
      closeHarnessStore({ workspaceRoot: root, harnessSlug: 'never-opened' }),
    ).resolves.toBeUndefined();
  });

  it('refuses a live duplicate before Corestore can contend on its keypair', async () => {
    const root = tmpRoot();
    const opts = { workspaceRoot: root, harnessSlug: 'locked' };
    const lockPath = harnessStoreLockPath(opts);
    await mkdir(join(root, '.papercusp', 'locked', 'hyperbee'), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, token: 'test-live-owner' }),
      'utf8',
    );

    await expect(getHarnessStore(opts)).rejects.toThrow(
      /Corestore is already open by process/,
    );

    await unlink(lockPath);
  });

  it('reclaims a lock whose recorded process is gone and releases it on close', async () => {
    const root = tmpRoot();
    const opts = { workspaceRoot: root, harnessSlug: 'stale' };
    const lockPath = harnessStoreLockPath(opts);
    await mkdir(join(root, '.papercusp', 'stale', 'hyperbee'), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 2_147_483_647, token: 'test-stale-owner' }),
      'utf8',
    );

    await getHarnessStore(opts);
    const activeLock = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
    expect(activeLock.pid).toBe(process.pid);

    await closeHarnessStore(opts);
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reclaims a lock when the PID is alive but belongs to a different process incarnation', async () => {
    const root = tmpRoot();
    const opts = { workspaceRoot: root, harnessSlug: 'pid-reused' };
    const lockPath = harnessStoreLockPath(opts);
    await mkdir(join(root, '.papercusp', 'pid-reused', 'hyperbee'), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        token: 'test-reused-pid',
        processIdentity: 'not-this-process-incarnation',
      }),
      'utf8',
    );

    await getHarnessStore(opts);
    const activeLock = JSON.parse(await readFile(lockPath, 'utf8')) as {
      pid: number;
      token: string;
      processIdentity: string | null;
    };
    expect(activeLock.pid).toBe(process.pid);
    expect(activeLock.token).not.toBe('test-reused-pid');
    expect(activeLock.processIdentity).not.toBe('not-this-process-incarnation');

    await closeHarnessStore(opts);
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when a live legacy lock has no process incarnation', () => {
    expect(
      _lockHolderIsProvablyStaleForTests(
        { pid: 42 },
        { isAlive: () => true, readIdentity: () => 'linux:boot:current' },
      ),
    ).toBe(false);
  });

  it('reclaims a legacy macOS lock when its ISO start time differs from the live PID', () => {
    expect(
      _lockHolderIsProvablyStaleForTests(
        { pid: 42, startedAt: '2026-08-30T06:30:06.031Z' },
        { isAlive: () => true, readIdentity: () => 'darwin:Sun Aug 30 21:47:19 2026' },
      ),
    ).toBe(true);
  });

  it('keeps a legacy macOS lock when its start time matches the live PID', () => {
    const liveIdentity = 'darwin:Sun Aug 30 21:47:19 2026';
    const matchingStart = new Date(Date.parse(liveIdentity.slice('darwin:'.length))).toISOString();
    expect(
      _lockHolderIsProvablyStaleForTests(
        { pid: 42, startedAt: matchingStart },
        { isAlive: () => true, readIdentity: () => liveIdentity },
      ),
    ).toBe(false);
  });

  it('fails closed when the current process incarnation cannot be read', () => {
    expect(
      _lockHolderIsProvablyStaleForTests(
        { pid: 42, processIdentity: 'linux:boot:original' },
        { isAlive: () => true, readIdentity: () => null },
      ),
    ).toBe(false);
  });
});

// ── P-005 recurrence guard: bounded block-cache size ──────────────────────
//
// bg-host-freeze-eventloop-stall-2026-06-30 P-005: the default Corestore block
// cache (16 384 blocks) lets 25+ harnesses accumulate tens of GB of block data
// in-process. We cap it at 256 blocks (≈8–16 MB/store) with an env override.
// These tests ensure that default never drifts back above 1 024 blocks (an
// 8× safety margin above our cap, still far below the original 16 384).

describe('resolveCacheBlocks — bounded block-cache size (P-005)', () => {
  const ORIG = process.env.PAPERCUSP_CORESTORE_CACHE_BLOCKS;

  afterAll(() => {
    // restore env
    if (ORIG === undefined) {
      delete process.env.PAPERCUSP_CORESTORE_CACHE_BLOCKS;
    } else {
      process.env.PAPERCUSP_CORESTORE_CACHE_BLOCKS = ORIG;
    }
  });

  it('DEFAULT block cache is ≤ 1 024 (bounded, not the old 16 384)', () => {
    delete process.env.PAPERCUSP_CORESTORE_CACHE_BLOCKS;
    const blocks = _resolveCorestoreCacheBlocksForTests();
    expect(blocks).toBe(_DEFAULT_CORESTORE_CACHE_BLOCKS_FOR_TESTS);
    // Hard ceiling: if someone accidentally bumps the constant, this test fails.
    expect(blocks).toBeLessThanOrEqual(1_024);
    // Must be a positive integer (≤ 0 disables the cache = disk hammering).
    expect(blocks).toBeGreaterThan(0);
    expect(Number.isInteger(blocks)).toBe(true);
  });

  it('PAPERCUSP_CORESTORE_CACHE_BLOCKS env override is respected', () => {
    process.env.PAPERCUSP_CORESTORE_CACHE_BLOCKS = '512';
    expect(_resolveCorestoreCacheBlocksForTests()).toBe(512);
  });

  it('invalid env (0, negative, non-numeric) falls back to the default', () => {
    for (const bad of ['0', '-1', 'foo', '']) {
      process.env.PAPERCUSP_CORESTORE_CACHE_BLOCKS = bad;
      expect(_resolveCorestoreCacheBlocksForTests()).toBe(
        _DEFAULT_CORESTORE_CACHE_BLOCKS_FOR_TESTS,
      );
    }
  });
});
