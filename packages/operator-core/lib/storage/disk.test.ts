import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  dirSizeBytes,
  dirSizeBytesAsync,
  gatherProtectedSessionIdentity,
  listDiskRootChildren,
  listDiskRootChildrenAsync,
  type DiskWalkBudget,
} from './disk';
import { planSessionDirGc, type SessionDirCandidate } from '../session-dir-gc';

// Hermetic: never read this host's live PTY sockets from a unit test.
vi.mock('../events/await/psu-pty-discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../events/await/psu-pty-discovery')>()),
  listLiveHostsAsync: async () => [],
}));

describe('Storage prune gatherProtectedSessionIdentity — OWNERSHIP (WI-6554700010010238)', () => {
  // Answers each query by its relation + filter, so the assertion is about WHICH
  // rows feed the ownership allow-list, not about query order.
  const fakeSql = async (strings: TemplateStringsArray): Promise<Array<Record<string, unknown>>> => {
    const q = strings.join('?');
    if (q.includes('coord_presence')) return [{ owner_id: 'su-live' }];
    if (q.includes('event_awaits')) return [];
    if (q.includes('adv_sessions')) {
      return q.includes('ended_at IS NULL') ? [] : [{ id: 7, coord_owner_id: 'su-ended-mine' }];
    }
    if (q.includes('spawned_agents')) {
      return q.includes('finished_at IS NULL') ? [] : [{ spawn_id: 'bee-1', session_owner: 'su-bee-owner' }];
    }
    throw new Error(`unexpected query: ${q}`);
  };

  it('owns everything this database launched (any state) and nothing another install launched', async () => {
    const gather = await gatherProtectedSessionIdentity(fakeSql);
    expect(gather.ok).toBe(true);
    const owned = gather.identity.owned;
    expect(owned).toBeDefined();
    expect([...owned!.ownerIds].sort()).toEqual(['bee-1', 'su-bee-owner', 'su-ended-mine', 'su-live']);
    expect([...owned!.sessionKeys]).toEqual(['7']);
    // An ENDED session is owned but not protected: it stays collectable here.
    expect(gather.identity.ownerIds.has('su-ended-mine')).toBe(false);
  });

  it('protects a Codex home while an ended adv session still has an in-flight wake', async () => {
    const wakeSql = async (strings: TemplateStringsArray): Promise<Array<Record<string, unknown>>> => {
      const q = strings.join('?');
      if (q.includes('coord_presence')) return [];
      if (q.includes('spawned_agents')) return [];
      if (q.includes('event_wake_deliveries')) return [{ subscriber_id: 'su-awaiting' }];
      if (q.includes('event_awaits')) return [];
      if (q.includes('adv_sessions')) {
        if (q.includes('ended_at IS NULL')) return [];
        if (q.includes('coord_owner_id = ANY')) return [{ id: 42 }];
        return [{ id: 42, coord_owner_id: 'su-awaiting' }];
      }
      throw new Error(`unexpected query: ${q}`);
    };

    const gather = await gatherProtectedSessionIdentity(wakeSql);
    expect(gather.ok).toBe(true);
    expect(gather.identity.ownerIds.has('su-awaiting')).toBe(true);
    expect(gather.identity.sessionKeys.has('42')).toBe(true);

    const plan = planSessionDirGc({
      candidates: [
        { path: '/tmp/session-42', keyKind: 'session', key: '42', mtimeMs: 0 },
        { path: '/tmp/su-awaiting', keyKind: 'owner', key: 'su-awaiting', mtimeMs: 0 },
      ],
      protectedIdentity: gather.identity,
      nowMs: 10_000,
      retentionMs: 1,
    });
    expect(plan.remove).toEqual([]);
    expect(plan.keptProtected.map((candidate) => candidate.key).sort()).toEqual(['42', 'su-awaiting']);
  });

  it('a prune plan keeps a foreign dir and still collects its own ended dir', async () => {
    const gather = await gatherProtectedSessionIdentity(fakeSql);
    const now = 10_000_000_000;
    const mk = (keyKind: 'owner' | 'session', key: string): SessionDirCandidate => ({
      path: `/tmp/${key}`, keyKind, key, mtimeMs: 0,
    });
    const mine = mk('owner', 'su-ended-mine');
    const mineCodex = mk('session', '7');
    const foreign = mk('owner', 'su-foreign');
    const foreignCodex = mk('session', '99');
    const plan = planSessionDirGc({
      candidates: [mine, mineCodex, foreign, foreignCodex],
      protectedIdentity: gather.identity,
      nowMs: now,
      retentionMs: 1,
      unarchivedPaths: new Set(),
    });
    expect(plan.keptForeign).toEqual([foreign, foreignCodex]);
    expect(plan.remove).toEqual([mine, mineCodex]);
  });

  it('fails closed: a failed read returns ok:false so prune refuses to delete', async () => {
    const gather = await gatherProtectedSessionIdentity(async () => { throw new Error('pg down'); });
    expect(gather.ok).toBe(false);
  });
});

describe('bounded disk attribution', () => {
  it('times out an individual child without hiding a later sibling or exceeding the shared budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'disk-attribution-time-'));
    try {
      const slow = join(root, 'a-slow');
      mkdirSync(slow);
      for (let i = 0; i < 8; i++) writeFileSync(join(slow, String(i)), Buffer.alloc(100));
      const later = join(root, 'z-later.bin');
      writeFileSync(later, Buffer.alloc(1024));
      for (const scan of [listDiskRootChildren, listDiskRootChildrenAsync]) {
        let clock = 1000;
        const now = vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
        try {
          const result = await scan({ roots: [root], maxChildScanMs: 3, budget: { deadlineMs: 10_000 } });
          expect(result.truncated).toBe(true);
          expect(result.entries.find((entry) => entry.path === slow)).toMatchObject({ sizeTruncated: true });
          expect(result.entries.find((entry) => entry.path === later)).toMatchObject({ sizeBytes: 1024 });
          expect(clock).toBeLessThan(10_000);
        } finally { now.mockRestore(); }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reports a capped child as a lower bound without hiding a later large sibling', async () => {
    const root = mkdtempSync(join(tmpdir(), 'disk-attribution-cap-'));
    try {
      const largeTree = join(root, 'a-capped');
      mkdirSync(largeTree);
      for (let i = 0; i < 4; i++) writeFileSync(join(largeTree, String(i)), Buffer.alloc(100));
      const later = join(root, 'z-later.bin');
      writeFileSync(later, Buffer.alloc(1024));
      for (const scan of [listDiskRootChildren, listDiskRootChildrenAsync]) {
        const result = await scan({ roots: [root], maxEntriesPerChild: 2 });
        expect(result.truncated).toBe(true);
        expect(result.entries.find((entry) => entry.path === largeTree)).toMatchObject({ sizeTruncated: true });
        expect(result.entries.find((entry) => entry.path === later)).toMatchObject({ sizeBytes: 1024 });
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not let a broken child link hide a later sibling in the cooperative scan', async () => {
    const root = mkdtempSync(join(tmpdir(), 'disk-attribution-unreadable-'));
    try {
      symlinkSync(join(root, 'absent'), join(root, 'a-broken'));
      writeFileSync(join(root, 'z-later.bin'), Buffer.alloc(1024));
      const result = await listDiskRootChildrenAsync({ roots: [root] });
      expect(result.truncated).toBe(true);
      expect(result.entries.find((entry) => entry.path === join(root, 'z-later.bin'))).toMatchObject({ sizeBytes: 1024 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not follow sibling or nested symlinks, including cycles', async () => {
    const root = mkdtempSync(join(tmpdir(), 'disk-attribution-'));
    try {
      const store = join(root, 'store');
      mkdirSync(store);
      writeFileSync(join(store, 'payload'), Buffer.alloc(100));
      symlinkSync(store, join(root, 'alias'));
      symlinkSync(root, join(store, 'cycle'));
      const result = await listDiskRootChildrenAsync({ roots: [root], followSymlinks: false });
      expect(result.truncated).toBe(false);
      expect(result.entries.find((e) => e.path === store)?.sizeBytes).toBe(100);
      expect(result.entries.find((e) => e.path === join(root, 'alias'))?.sizeBytes).toBe(0);
      const budget: DiskWalkBudget = { deadlineMs: Date.now() + 1000 };
      await dirSizeBytesAsync(store, 1, budget, false);
      expect(budget.truncated).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

/**
 * Recurrence guard for EI-6045: the synchronous recursive disk-sizing walk must
 * be wall-clock bounded by a shared budget so `storage:usage` can never block the
 * event loop for minutes and trip the 300s MCP idle abort on a large install.
 */
describe('dirSizeBytes wall-clock budget (EI-6045)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'storage-disk-test-'));
    // A small nested tree with known byte totals.
    writeFileSync(join(root, 'a.bin'), Buffer.alloc(100));
    writeFileSync(join(root, 'b.bin'), Buffer.alloc(200));
    const sub = join(root, 'sub');
    mkdirSync(sub);
    writeFileSync(join(sub, 'c.bin'), Buffer.alloc(50));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('sizes the full tree when no budget is given (behavior preserved)', () => {
    expect(dirSizeBytes(root)).toBe(350);
  });

  it('sizes the full tree under a far-future deadline and leaves truncated unset', () => {
    const budget: DiskWalkBudget = { deadlineMs: Date.now() + 60_000 };
    expect(dirSizeBytes(root, 400_000, budget)).toBe(350);
    expect(budget.truncated).toBeUndefined();
  });

  it('stops early and marks truncated when the deadline has already elapsed', () => {
    const budget: DiskWalkBudget = { deadlineMs: Date.now() - 1 };
    // An already-elapsed deadline is checked before any syscall on the first
    // iteration, so the walk returns immediately with a partial (0) total.
    expect(dirSizeBytes(root, 400_000, budget)).toBe(0);
    expect(budget.truncated).toBe(true);
  });

  it('a SHARED exhausted budget short-circuits every subsequent dir (many-session-dirs case)', () => {
    const other = mkdtempSync(join(tmpdir(), 'storage-disk-test-2-'));
    writeFileSync(join(other, 'x.bin'), Buffer.alloc(999));
    try {
      const budget: DiskWalkBudget = { deadlineMs: Date.now() - 1 };
      // First dir trips the deadline...
      expect(dirSizeBytes(root, 400_000, budget)).toBe(0);
      expect(budget.truncated).toBe(true);
      // ...and the shared, already-exhausted budget makes later dirs return
      // near-instantly too (the aggregate walk stays bounded regardless of how
      // many session dirs exist).
      expect(dirSizeBytes(other, 400_000, budget)).toBe(0);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

/**
 * WI-5471: `dirSizeBytesAsync` is the event-loop-COOPERATIVE twin — it must be
 * byte-identical to the sync walk, keep the same budget semantics, AND actually
 * relinquish the loop mid-walk (the sync twin's ~90s bg-host freeze on the
 * `storage.usage` precompute was the acute soak-blocker this fixes).
 */
describe('dirSizeBytesAsync (WI-5471 event-loop-cooperative walk)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'storage-disk-async-test-'));
    writeFileSync(join(root, 'a.bin'), Buffer.alloc(100));
    writeFileSync(join(root, 'b.bin'), Buffer.alloc(200));
    const sub = join(root, 'sub');
    mkdirSync(sub);
    writeFileSync(join(sub, 'c.bin'), Buffer.alloc(50));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('sizes the full tree identically to the sync walk (behavior preserved)', async () => {
    expect(await dirSizeBytesAsync(root)).toBe(350);
    expect(await dirSizeBytesAsync(root)).toBe(dirSizeBytes(root));
  });

  it('honors the shared wall-clock budget (stops early + marks truncated)', async () => {
    const budget: DiskWalkBudget = { deadlineMs: Date.now() - 1 };
    expect(await dirSizeBytesAsync(root, 400_000, budget)).toBe(0);
    expect(budget.truncated).toBe(true);
  });

  it('yields the event loop DURING a large walk — a concurrent macrotask interleaves', async () => {
    // A tree wide enough that the walk crosses several cooperativeYield boundaries
    // (yields every 64 iterations at rest), so a competing setImmediate loop must
    // get to run before the walk finishes — proving the walk never blocks the loop.
    const big = mkdtempSync(join(tmpdir(), 'storage-disk-async-big-'));
    try {
      for (let i = 0; i < 300; i++) writeFileSync(join(big, `f${i}.bin`), Buffer.alloc(1));

      let ticks = 0;
      let done = false;
      const tick = (): void => {
        if (done) return;
        ticks++;
        setImmediate(tick);
      };
      setImmediate(tick);

      const total = await dirSizeBytesAsync(big);
      done = true;

      expect(total).toBe(300); // 300 × 1 byte
      expect(ticks).toBeGreaterThan(0); // the loop ticked mid-walk → not blocked
    } finally {
      rmSync(big, { recursive: true, force: true });
    }
  });
});

describe('listDiskRootChildren (bounded undeclared-growth sweep)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'storage-disk-root-scan-test-'));
    const registered = join(root, 'registered');
    mkdirSync(registered);
    writeFileSync(join(registered, 'owned.bin'), Buffer.alloc(100));
    const unknown = join(root, 'unknown');
    mkdirSync(unknown);
    writeFileSync(join(unknown, 'unowned.bin'), Buffer.alloc(200));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps registered trees in the snapshot but skips their recursive sizing', () => {
    const registered = join(root, 'registered');
    const result = listDiskRootChildren({
      roots: [root],
      registeredPaths: [registered],
      budget: { deadlineMs: Date.now() + 60_000 },
    });
    expect(result.truncated).toBe(false);
    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: registered, sizeBytes: 0 }),
        expect.objectContaining({ path: join(root, 'unknown'), sizeBytes: 200 }),
      ]),
    );
  });

  it('deduplicates overlapping exact root-child paths and marks a child-cap cut', () => {
    const result = listDiskRootChildren({
      roots: [root, root],
      maxChildren: 1,
      budget: { deadlineMs: Date.now() + 60_000 },
    });
    expect(result.entries).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('marks an already-expired budget incomplete instead of claiming a healthy empty scan', () => {
    const result = listDiskRootChildren({ roots: [root], budget: { deadlineMs: Date.now() - 1 } });
    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(true);
  });
});
