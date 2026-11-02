/**
 * release_granular.test.ts — the locks:release_granular HANDLER (releaseGranular mocked;
 * txn wrapper runs the callback). Pins that the handler releases the lock-set by lock_id
 * (owner-scoped via readIdentity) and returns the released row count. A regression that drops
 * owner scoping or reports a successful zero-row release is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/release_granular.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// WI-38252: file locks resolve their default domain via readFileLockIdentity.
vi.mock('./identity', () => {
  const identity = vi.fn(() => ({ ownerId: 'me', coordinationDomain: 'dom' }));
  return { readIdentity: identity, readFileLockIdentity: identity };
});
vi.mock('./in-workspace-txn', () => ({
  inWorkspaceTxn: vi.fn(async (_d: string, _o: string, fn: (tx: unknown) => unknown) => fn({})),
}));
vi.mock('./su-lock-store', () => ({ releaseGranular: vi.fn() }));

import { releaseGranular } from './su-lock-store';
const relM = vi.mocked(releaseGranular);
const tool = (await import('./release_granular')).default;

type Out = { data?: any; content?: Array<{ text: string }> };
const body = (o: Out) => (o.data ?? JSON.parse(o.content![0].text));

beforeEach(() => vi.clearAllMocks());

describe('locks:release_granular handler', () => {
  it('wraps a single lock_id release through the keyed bulk envelope (n=1)', async () => {
    relM.mockResolvedValue({ released: 3 } as never);
    const out = (await tool.handler({ lock_id: '44444444-4444-4444-4444-444444444444' } as never, {} as never)) as Out;
    expect(relM).toHaveBeenCalledWith({}, 'dom', 'me', '44444444-4444-4444-4444-444444444444');
    expect(body(out)).toMatchObject({
      ok: true,
      counts: { ok: 1, failed: 0 },
      results: [
        { ok: true, lock_id: '44444444-4444-4444-4444-444444444444', released: 3 },
      ],
    });
  });

  it('releases selected lock_ids as a keyed bulk envelope', async () => {
    relM.mockImplementation(
      async (_tx, _dom, _owner, lockId) => ({ released: lockId.startsWith('4444') ? 3 : 2 }) as never,
    );
    const out = (await tool.handler({
      lock_ids: [
        '44444444-4444-4444-4444-444444444444',
        '55555555-5555-5555-5555-555555555555',
      ],
    } as never, {} as never)) as Out;
    expect(body(out)).toMatchObject({
      ok: true,
      counts: { ok: 2, failed: 0 },
      results: [
        { ok: true, lock_id: '44444444-4444-4444-4444-444444444444', released: 3 },
        { ok: true, lock_id: '55555555-5555-5555-5555-555555555555', released: 2 },
      ],
    });
  });

  it('reports zero released rows as a per-lock failure in bulk releases', async () => {
    const wrongKindId = '44444444-4444-4444-4444-444444444444';
    const granularId = '55555555-5555-5555-5555-555555555555';
    relM.mockImplementation(async (_tx, _dom, _owner, lockId) => ({
      released: lockId === wrongKindId ? 0 : 2,
    }) as never);
    const out = (await tool.handler({ lock_ids: [wrongKindId, granularId] } as never, {} as never)) as Out;

    expect(body(out)).toMatchObject({
      ok: false,
      counts: { ok: 1, failed: 1 },
      results: [
        {
          ok: false,
          lock_id: wrongKindId,
          released: 0,
          code: 'not_found_or_wrong_lock_kind',
          error: 'No owned granular lock rows were released.',
          note: expect.stringContaining('locks:release'),
        },
        { ok: true, lock_id: granularId, released: 2 },
      ],
    });
  });
});
