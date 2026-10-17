/**
 * REGRESSION GUARD — `getWorkItemThreadWindow` must dispatch issue-family reads to
 * issues-engineer's store, not to work-items.ts's own (P-006 /
 * `gate-ownership-condition-singleton-2026-08-03`).
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────
 * The two modules hold what look like interchangeable coord stores. They are not:
 * issues-engineer's resolves the workspace DYNAMICALLY, while work-items.ts's is
 * pinned to `DEFAULT_COORD_WORKSPACE` ('default'). Live thread rows split along
 * exactly that line — measured 2026-08-03: 5,208 `issue` threads in
 * `papercusp-workspace` vs 457 `feature` threads in `default`. So each store is
 * correct for ONE family and silently wrong for the other.
 *
 * What makes it worth a dedicated guard is the FAILURE SHAPE. Reading an issue
 * thread through the wrong store does not throw and does not return an error — it
 * matches zero rows, and because an absent thread legitimately means "nobody has
 * commented", the caller receives a confident, well-formed `total: 0`. The first
 * version of this code did exactly that: WI-6857, which has TEN posts, read back
 * as 0/0 and every unit test still passed. Only an unmocked live run caught it.
 *
 * A type checker cannot see this (both stores share a type), and a fixture cannot
 * see it (a fixture supplies its own rows). Only the dispatch itself can be
 * pinned, so that is what this asserts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getWorkItemDetail, getWorkItemThreadWindow } from './work-items';
import { getIssueThreadWindow, type EngineerIssue } from './issues-engineer';

const boundedReadMocks = vi.hoisted(() => ({
  read: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run({ marker: 'bounded-read-transaction' })),
  getThreadByParent: vi.fn(),
  listRecentPosts: vi.fn(),
  listTags: vi.fn(),
  observedSql: [] as unknown[],
}));

vi.mock('./pg-read-query', () => ({ boundedPgReadTxn: boundedReadMocks.read }));
vi.mock('@papercusp/coordination/capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/coordination/capabilities')>();
  return {
    ...actual,
    PgThreadStore: class {
      constructor(private readonly opts: { getSql: () => unknown }) {}
      getThreadByParent(...args: unknown[]) {
        boundedReadMocks.observedSql.push(this.opts.getSql());
        return boundedReadMocks.getThreadByParent(...args);
      }
      listRecentPosts(...args: unknown[]) {
        boundedReadMocks.observedSql.push(this.opts.getSql());
        return boundedReadMocks.listRecentPosts(...args);
      }
    },
    PgTaggableStore: class {
      constructor(private readonly opts: { getSql: () => unknown }) {}
      listTags(...args: unknown[]) {
        boundedReadMocks.observedSql.push(this.opts.getSql());
        return boundedReadMocks.listTags(...args);
      }
    },
  };
});

const issueWindow = vi.fn(async () => ({
  posts: [{ id: 1, thread_id: 't', author_id: 'su-a', body: 'hi', created_ts: '2026-08-03T00:00:00.000Z' }],
  total: 10,
  topics: ['gate'],
  createdAt: '2026-08-02T04:23:32.237Z',
}));

const item = (family: string) =>
  vi.fn(async () => ({ id: 'WI-6857', family, harness: 'papercusp', createdAt: '2026-08-02T04:23:32.237Z' }));

describe('getWorkItemThreadWindow family dispatch', () => {
  beforeEach(() => {
    issueWindow.mockClear();
    boundedReadMocks.read.mockClear();
    boundedReadMocks.getThreadByParent.mockReset().mockResolvedValue({ thread_id: 'thread-feature' });
    boundedReadMocks.listRecentPosts.mockReset().mockResolvedValue({
      posts: [{ id: 2, thread_id: 'thread-feature', author_id: 'su-a', body: 'comment', created_ts: '2026-08-03T00:00:00.000Z' }],
      total: 4,
    });
    boundedReadMocks.listTags.mockReset().mockResolvedValue(['topic']);
    boundedReadMocks.observedSql.length = 0;
  });

  it('bounds the complete feature-family window read in one database transaction', async () => {
    const win = await getWorkItemThreadWindow('WI-6857', 3, undefined, {
      getWorkItem: item('feature') as never,
    });

    expect(boundedReadMocks.read).toHaveBeenCalledTimes(1);
    expect(boundedReadMocks.getThreadByParent).toHaveBeenCalledWith({ kind: 'feature', ref: 'papercusp#WI-6857' });
    expect(boundedReadMocks.listRecentPosts).toHaveBeenCalledWith('thread-feature', 3);
    expect(boundedReadMocks.listTags).toHaveBeenCalledWith({ kind: 'feature', ref: 'papercusp#WI-6857' });
    expect(boundedReadMocks.observedSql).toEqual([
      { marker: 'bounded-read-transaction' },
      { marker: 'bounded-read-transaction' },
      { marker: 'bounded-read-transaction' },
    ]);
    expect(win).toMatchObject({ total: 4, topics: ['topic'], createdAt: '2026-08-02T04:23:32.237Z' });
  });

  it('bounds the issue row, tags, and comment window in one database transaction', async () => {
    const issueClient = vi.fn();
    const win = await getIssueThreadWindow('EI-6857', 3, {
      getIssue: async (id, tx) => {
        expect(id).toBe('EI-6857');
        issueClient(tx);
        return { id, createdAt: '2026-08-02T04:23:32.237Z' } as EngineerIssue;
      },
    });

    expect(boundedReadMocks.read).toHaveBeenCalledTimes(1);
    expect(issueClient).toHaveBeenCalledWith({ marker: 'bounded-read-transaction' });
    expect(boundedReadMocks.getThreadByParent).toHaveBeenCalledWith({ kind: 'issue', ref: 'EI-6857' });
    expect(boundedReadMocks.listRecentPosts).toHaveBeenCalledWith('thread-feature', 3);
    expect(boundedReadMocks.listTags).toHaveBeenCalledWith({ kind: 'issue', ref: 'EI-6857' });
    expect(boundedReadMocks.observedSql).toHaveLength(3);
    expect(win).toMatchObject({ total: 4, topics: ['topic'], createdAt: '2026-08-02T04:23:32.237Z' });
  });

  it('routes an ISSUE-family item to the issues-engineer window reader', async () => {
    const win = await getWorkItemThreadWindow('WI-6857', 3, undefined, {
      getWorkItem: item('issue') as never,
      getIssueThreadWindow: issueWindow as never,
    });

    // The dispatch happened...
    expect(issueWindow).toHaveBeenCalledWith('WI-6857', 3);
    // ...and the caller got the REAL counts rather than the silent `total: 0` the
    // wrong store produces for exactly this input.
    expect(win?.total).toBe(10);
    expect(win?.posts).toHaveLength(1);
    expect(win?.total).not.toBe(0);
  });

  it('does NOT route a feature-family item to the issue reader', async () => {
    // The mirror case: feature threads really do live in the `default` coord
    // workspace (457 of them, measured), so this module's own store is correct
    // for them. Dispatching BOTH families to issues-engineer would swap which
    // family is silently wrong rather than fix anything.
    await getWorkItemThreadWindow('WI-1', 3, undefined, {
      getWorkItem: item('feature') as never,
      getIssueThreadWindow: issueWindow as never,
    }).catch(() => undefined);
    expect(issueWindow).not.toHaveBeenCalled();
  });

  it('returns null for an item that does not exist, without consulting a thread store', async () => {
    const win = await getWorkItemThreadWindow('WI-99999999', 3, undefined, {
      getWorkItem: (async () => null) as never,
      getIssueThreadWindow: issueWindow as never,
    });
    expect(win).toBeNull();
    expect(issueWindow).not.toHaveBeenCalled();
  });

  it('uses the bounded thread seam for detail reads instead of loading the full thread', async () => {
    const readItem = vi.fn(async () => ({
      id: 'WI-detail',
      family: 'feature',
      kind: 'feature',
      harness: 'papercup',
      title: 'detail target',
      state: 'open',
      createdAt: '2026-08-02T04:23:32.237Z',
    }));
    const boundedDetailThread = vi.fn(async () => ({
      posts: [{ id: 1, thread_id: 'thread-detail', author_id: 'su-a', body: 'latest', created_ts: '2026-08-03T00:00:00.000Z' }],
      total: 137,
      topics: ['gate'],
      createdAt: '2026-08-02T04:23:32.237Z',
    }));
    const listOut = vi.fn(async () => []);

    const detail = await getWorkItemDetail(
      'WI-detail',
      'papercup',
      { threadLimit: 10 },
      { getWorkItem: readItem as never, getWorkItemThreadWindow: boundedDetailThread as never, listOut },
    );

    expect(boundedDetailThread).toHaveBeenCalledWith('WI-detail', 10, 'papercup', { getWorkItem: expect.any(Function) });
    expect(listOut).toHaveBeenCalledWith({ kind: 'feature', ref: 'papercup#WI-detail' });
    expect(detail).toMatchObject({ posts: [{ body: 'latest' }], postsTotal: 137, topics: ['gate'], links: [] });
  });
});
