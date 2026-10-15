/**
 * EI-21150596392578187 — coord:thread must not load the whole messages
 * surface on the PG backend. The graph is walked by an indexed recursive
 * query; portable/in-memory backends keep the readLines fallback.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock, readLinesMock, fastPathState, coordSqlMock, boundedPgReadTxnMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  readLinesMock: vi.fn(async () => [] as unknown[]),
  fastPathState: { on: false },
  coordSqlMock: vi.fn(() => sqlMock),
  boundedPgReadTxnMock: vi.fn(async (
    fn: (tx: unknown) => Promise<unknown>,
    _opts?: Record<string, unknown>,
  ) => fn(sqlMock)),
}));

vi.mock('./log', () => ({
  coordLog: { readLines: readLinesMock },
  coordSql: coordSqlMock,
  coordWorkspaceId: () => 'ws-thread-test',
  coordHasPgFastPath: () => fastPathState.on,
}));

vi.mock('../../pg-read-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../pg-read-query')>()),
  boundedPgReadTxn: boundedPgReadTxnMock,
}));

import type { CoordEnvelope } from '@papercusp/coordination/core';
import { readThread, readThreadFromRef, THREAD_READ_ACQUIRE_TIMEOUT_MS, THREAD_READ_STATEMENT_TIMEOUT_MS } from './messages';

function env(p: Partial<CoordEnvelope> = {}): CoordEnvelope {
  return {
    ts: '2026-08-28T00:00:00.000Z',
    msg_id: 'm0',
    from: 'alice',
    to: ['bob'],
    kind: 'message',
    ...p,
  } as CoordEnvelope;
}

beforeEach(() => {
  vi.clearAllMocks();
  fastPathState.on = false;
  readLinesMock.mockResolvedValue([]);
});

describe('readThread — portable fallback', () => {
  it('retains transitive, bidirectional fold semantics', async () => {
    readLinesMock.mockResolvedValue([
      env({ msg_id: 'leaf', related_msg_id: 'middle', ts: '2026-08-28T00:00:03.000Z' }),
      env({ msg_id: 'unrelated', ts: '2026-08-28T00:00:04.000Z' }),
      env({ msg_id: 'root', ts: '2026-08-28T00:00:01.000Z' }),
      env({ msg_id: 'middle', related_msg_id: 'root', ts: '2026-08-28T00:00:02.000Z' }),
    ]);

    const thread = await readThread('leaf');

    expect(thread.map((entry) => entry.msg_id)).toEqual(['root', 'middle', 'leaf']);
    expect(readLinesMock).toHaveBeenCalledWith('messages');
    expect(sqlMock).not.toHaveBeenCalled();
  });
});

describe('readThread — PG graph pushdown', () => {
  beforeEach(() => {
    fastPathState.on = true;
  });

  it('walks the rooted graph without scanning readLines', async () => {
    sqlMock.mockResolvedValue([
      { body: env({ msg_id: 'leaf', related_msg_id: 'middle', ts: '2026-08-28T00:00:03.000Z' }), ts: '2026-08-28T00:00:03.000Z', msg_id: 'leaf', harness_slug: null },
      { body: env({ msg_id: 'root', ts: '2026-08-28T00:00:01.000Z' }), ts: '2026-08-28T00:00:01.000Z', msg_id: 'root', harness_slug: null },
      { body: env({ msg_id: 'middle', related_msg_id: 'root', ts: '2026-08-28T00:00:02.000Z' }), ts: '2026-08-28T00:00:02.000Z', msg_id: 'middle', harness_slug: null },
      { body: env({ msg_id: 'unrelated', ts: '2026-08-28T00:00:04.000Z' }), ts: '2026-08-28T00:00:04.000Z', msg_id: 'unrelated', harness_slug: null },
    ]);

    const thread = await readThread('leaf');

    expect(thread.map((entry) => entry.msg_id)).toEqual(['root', 'middle', 'leaf']);
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(readLinesMock).not.toHaveBeenCalled();
  });

  it('resolves the root and walks its graph inside one bounded read-only transaction', async () => {
    const root = env({ msg_id: 'root-msg' });
    const row = { body: root, ts: root.ts, msg_id: root.msg_id, harness_slug: null };
    sqlMock.mockResolvedValue([row]);

    const result = await readThreadFromRef(root.msg_id);

    expect(result.resolution).toMatchObject({ status: 'found', msgId: root.msg_id });
    expect(result.entries.map((entry) => entry.msg_id)).toEqual([root.msg_id]);
    expect(boundedPgReadTxnMock).toHaveBeenCalledTimes(1);
    expect(boundedPgReadTxnMock.mock.calls[0]?.[1]).toEqual({
      client: sqlMock,
      timeoutMs: THREAD_READ_STATEMENT_TIMEOUT_MS,
      acquireTimeoutMs: THREAD_READ_ACQUIRE_TIMEOUT_MS,
      acquirePool: 'org-admin',
    });
    expect(sqlMock).toHaveBeenCalledTimes(2);
    expect(coordSqlMock).toHaveBeenCalledTimes(1);
  });

  it('emits the workspace/surface recursive query and the partial-index predicate', async () => {
    const seen: { text: string; values: unknown[] }[] = [];
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      seen.push({ text: Array.from(strings).join('?'), values });
      return Promise.resolve([]);
    });

    await readThread('root-msg');

    expect(seen).toHaveLength(1);
    expect(seen[0].text).toContain('WITH RECURSIVE thread_ids');
    expect(seen[0].text).toContain("surface = 'messages'");
    expect(seen[0].text).toContain("body ? 'related_msg_id'");
    expect(seen[0].text).toContain("body->>'related_msg_id' =");
    expect(seen[0].values).toContain('root-msg');
    expect(seen[0].values).toContain('ws-thread-test');
  });

  it('backstops malformed body identity/order fields from row columns', async () => {
    sqlMock.mockResolvedValue([
      {
        body: { kind: 'message', from: 'alice', to: ['bob'] },
        ts: new Date('2026-08-28T00:00:01.000Z'),
        msg_id: 'root-msg',
        harness_slug: null,
      },
    ]);

    const [entry] = await readThread('root-msg');

    expect(entry?.msg_id).toBe('root-msg');
    expect(entry?.ts).toBe('2026-08-28T00:00:01.000Z');
  });

  it('uses the indexed row id when a legacy body carries a conflicting id', async () => {
    sqlMock.mockResolvedValue([
      {
        body: env({ msg_id: 'legacy-stale-body-id' }),
        ts: '2026-08-28T00:00:01.000Z',
        msg_id: 'row-canonical-id',
        harness_slug: null,
      },
    ]);

    const [entry] = await readThread('row-canonical-id');

    expect(entry?.msg_id).toBe('row-canonical-id');
  });

  it('a query error propagates and never loads the whole surface (host-memory-reduction-2026-09-27 D-011)', async () => {
    sqlMock.mockRejectedValue(new Error('connection terminated'));

    await expect(readThread('root-msg')).rejects.toThrow('connection terminated');
    expect(readLinesMock).not.toHaveBeenCalled();
  });
});
