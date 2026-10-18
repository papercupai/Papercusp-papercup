/**
 * live-lock-paths.test.ts — the lock-plane read that replaces the (empty) declared
 * `current_files` signal for automatic collision avoidance (EI-18776963284535761).
 *
 * The load-bearing contracts, each of which was a real failure mode in the bug this came
 * from: it must read across EVERY coordination domain (a domain-scoped read silently
 * misses a genuinely-held lock), it must be HOLDERS-only (a waiter is not editing yet, and
 * a false positive here defers real work), and it must FAIL SOFT (the caller degrades to
 * its previous behaviour rather than breaking when the lock plane is unavailable).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ensureBootstrap = vi.fn(async () => {});
const getTxPool = vi.fn(() => ({}) as never);
type PhaseEvent = { phase: string; state: 'start' | 'end'; durationMs?: number };
type ReadQueueOptions = { onPhase?: (event: PhaseEvent) => void };
const readQueue = vi.fn(async (_sql: unknown, _params: unknown, _options?: ReadQueueOptions) => ({
  active_locks: [] as Array<{ path: string; owner: string; intent: string; goal_ref?: string | null }>,
  waiting: [] as Array<{ path: string; owner: string }>,
}));

vi.mock('./su-lock-store', () => ({
  ensureBootstrap: (...a: unknown[]) => ensureBootstrap(...(a as [])),
  getTxPool: (...a: unknown[]) => getTxPool(...(a as [])),
  readQueue: (...a: unknown[]) => readQueue(...(a as [never, never, ReadQueueOptions?])),
}));

import { liveLockHoldings, liveLockHoldingsStrict, liveLockedPaths } from './live-lock-paths';

const holding = (path: string, owner: string, intent = `edit ${path}`) => ({ path, owner, intent });

beforeEach(() => {
  vi.clearAllMocks();
  readQueue.mockResolvedValue({ active_locks: [], waiting: [] });
});

describe('liveLockHoldings', () => {
  it('returns each live holder with its path and intent', async () => {
    readQueue.mockResolvedValue({
      active_locks: [holding('a.ts', 'su-1'), holding('b.ts', 'su-2')],
      waiting: [],
    });
    expect(await liveLockHoldings()).toEqual([
      { path: 'a.ts', owner: 'su-1', intent: 'edit a.ts' },
      { path: 'b.ts', owner: 'su-2', intent: 'edit b.ts' },
    ]);
  });

  it('preserves the live goal_ref so git-sync can keep an edit cohort atomic', async () => {
    readQueue.mockResolvedValue({
      active_locks: [
        { ...holding('source.ts', 'su-1'), goal_ref: ' WI-atomic ' },
        { ...holding('test.ts', 'su-1'), goal_ref: '   ' },
        { ...holding('legacy.ts', 'su-1'), goal_ref: null },
      ],
      waiting: [],
    });
    expect(await liveLockHoldingsStrict()).toEqual([
      { path: 'source.ts', owner: 'su-1', intent: 'edit source.ts', goalRef: 'WI-atomic' },
      { path: 'test.ts', owner: 'su-1', intent: 'edit test.ts' },
      { path: 'legacy.ts', owner: 'su-1', intent: 'edit legacy.ts' },
    ]);
  });

  // A domain-scoped read reports a genuinely-held lock as ABSENT when the holder's
  // checkout differs from the operator's — observed live, and precisely the
  // false-negative this read exists to remove.
  it('reads across EVERY coordination domain (null), with no path/owner filter', async () => {
    await liveLockHoldings();
    expect(readQueue).toHaveBeenCalledWith(expect.anything(), {
      coordinationDomain: null,
      includeWaiting: false,
    });
    const params = readQueue.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.paths).toBeUndefined();
    expect(params.owner).toBeUndefined();
    expect(params.includeWaiting).toBe(false);
  });

  // Unlike the `@file:` AUDIENCE (where an extra recipient is harmless), a false positive
  // here DEFERS real work — so an agent merely queued on a path must not count.
  it('ignores waiters — holders only', async () => {
    readQueue.mockResolvedValue({
      active_locks: [holding('held.ts', 'su-1')],
      waiting: [holding('queued.ts', 'su-2')],
    });
    expect(await liveLockedPaths()).toEqual(['held.ts']);
  });

  it('fails soft to [] when the lock plane throws', async () => {
    readQueue.mockRejectedValue(new Error('side-DB unreachable'));
    expect(await liveLockHoldings()).toEqual([]);
    expect(await liveLockedPaths()).toEqual([]);
  });

  it('fails soft to [] when bootstrap throws', async () => {
    ensureBootstrap.mockRejectedValueOnce(new Error('locks unconfigured'));
    expect(await liveLockHoldings()).toEqual([]);
  });

  it('strict variant propagates lock-plane failures for commit gates', async () => {
    readQueue.mockRejectedValueOnce(new Error('side-DB unreachable'));
    await expect(liveLockHoldingsStrict()).rejects.toThrow('side-DB unreachable');
  });

  it('strict variant propagates bootstrap failures for commit gates', async () => {
    ensureBootstrap.mockRejectedValueOnce(new Error('locks unconfigured'));
    await expect(liveLockHoldingsStrict()).rejects.toThrow('locks unconfigured');
  });
});

describe('liveLockedPaths', () => {
  it('reports bootstrap, pool lookup, pool acquisition, and queue-read phases', async () => {
    const phases: PhaseEvent[] = [];
    readQueue.mockImplementation(async (_sql, _params, options) => {
      options?.onPhase?.({ phase: 'pool-acquire-and-begin', state: 'start' });
      options?.onPhase?.({ phase: 'pool-acquire-and-begin', state: 'end', durationMs: 2 });
      options?.onPhase?.({ phase: 'readQueue', state: 'start' });
      options?.onPhase?.({ phase: 'readQueue', state: 'end', durationMs: 3 });
      options?.onPhase?.({ phase: 'transaction-settlement', state: 'start' });
      options?.onPhase?.({ phase: 'transaction-settlement', state: 'end', durationMs: 1 });
      return { active_locks: [holding('held.ts', 'su-1')], waiting: [] };
    });

    expect(await liveLockedPaths({ onPhase: (phase) => phases.push(phase) })).toEqual(['held.ts']);
    expect(phases.map(({ phase, state }) => `${phase}:${state}`)).toEqual([
      'ensureBootstrap:start',
      'ensureBootstrap:end',
      'pool-lookup:start',
      'pool-lookup:end',
      'pool-acquire-and-begin:start',
      'pool-acquire-and-begin:end',
      'readQueue:start',
      'readQueue:end',
      'transaction-settlement:start',
      'transaction-settlement:end',
    ]);
  });

  it('de-duplicates a path held under several rows and trims blanks', async () => {
    readQueue.mockResolvedValue({
      active_locks: [holding('a.ts', 'su-1'), holding('  a.ts  ', 'su-2'), holding('   ', 'su-3')],
      waiting: [],
    });
    expect(await liveLockedPaths()).toEqual(['a.ts']);
  });

  it('excludeOwner drops that agent’s own holdings but keeps its peers’', async () => {
    readQueue.mockResolvedValue({
      active_locks: [holding('mine.ts', 'su-me'), holding('theirs.ts', 'su-peer')],
      waiting: [],
    });
    expect(await liveLockedPaths({ excludeOwner: 'su-me' })).toEqual(['theirs.ts']);
    expect(await liveLockedPaths()).toEqual(['mine.ts', 'theirs.ts']);
  });

  it('returns [] when nothing is held', async () => {
    expect(await liveLockedPaths()).toEqual([]);
  });
});
