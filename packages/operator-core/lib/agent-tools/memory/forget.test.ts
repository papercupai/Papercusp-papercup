/**
 * forget.test.ts — the memory:forget HANDLER, bulk keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). Backend mocked. Pins the inline
 * { id } single form, the ids:[…] many form (per-item results keyed by id), a
 * per-item delete failure failing only itself, and the top-level availability
 * gate. A wedged backend → top-level { ok:false, reason:'memory_timeout' } is
 * covered in b1-timeout.test.ts.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/memory/forget.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  purgeJournalForMemory: vi.fn(async () => 0),
  clearL1: vi.fn(),
}));

vi.mock('../../memory/backend', () => ({
  getMemoryBackend: vi.fn(),
}));
vi.mock('../../memory/surfaced-outcomes', async (original) => ({
  ...(await original<typeof import('../../memory/surfaced-outcomes')>()),
  captureSurfacedOutcome: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../../memory/write-journal', () => ({
  purgeJournalForMemory: h.purgeJournalForMemory,
}));
vi.mock('../../cache/instance', () => ({
  getOperatorCache: () => ({ clearL1: h.clearL1 }),
}));
vi.mock('../../memory/feedback', () => ({
  AGENT_TOOL_ACTOR_ID: 'agent-test',
  recordFeedback: vi.fn(async () => undefined),
}));
vi.mock('../../memory/invalidate-user-memory-views', () => ({
  invalidateUserMemoryViews: vi.fn(async () => undefined),
}));

import forget from './forget';
import { captureSurfacedOutcome } from '../../memory/surfaced-outcomes';
import { getMemoryBackend } from '../../memory/backend';

type FakeBackend = {
  name: string;
  available: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  forget: ReturnType<typeof vi.fn>;
};

const fakeBackend = (): FakeBackend => ({
  name: 'fake',
  available: vi.fn(async () => ({ ok: true })),
  get: vi.fn(async (id: string) => ({ id, text: `fact ${id}`, scope: 'scope-a' })),
  forget: vi.fn(async () => undefined),
});

const useBackend = (b: FakeBackend): void => {
  vi.mocked(getMemoryBackend).mockReturnValue(b as unknown as ReturnType<typeof getMemoryBackend>);
};

type Out = { data: any };
const body = async (args: unknown): Promise<{ ok: boolean; reason?: string; results: { ok: boolean; id: string; error?: string; reason?: string; reconciledAfterTimeout?: boolean }[]; counts: { ok: number; failed: number } }> =>
  (((await forget.handler(args as never, {} as never)) as Out).data);

const withShortMemoryToolTimeout = async <T>(run: () => Promise<T>): Promise<T> => {
  const previous = process.env.PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS;
  process.env.PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS = '30';
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS;
    else process.env.PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS = previous;
  }
};

describe('memory:forget handler (bulk keyed-array)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.purgeJournalForMemory.mockResolvedValue(0);
  });

  it('records contradiction only after a successful forget in the caller session', async () => {
    const b = fakeBackend();
    b.forget.mockImplementation(async (id: string) => {
      if (id === 'failed') throw new Error('delete failed');
    });
    useBackend(b);
    const ctx = { uiClientId: 'forgetter' } as Parameters<typeof forget.handler>[1];
    await forget.handler({ ids: ['deleted', 'failed'] }, ctx);
    expect(captureSurfacedOutcome).toHaveBeenCalledExactlyOnceWith(ctx, ['deleted'], 'contradicted');
    expect(b.forget.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(captureSurfacedOutcome).mock.invocationCallOrder[0]);
  });

  it('inline { id } deletes one and returns a single result', async () => {
    const b = fakeBackend();
    useBackend(b);
    const r = await body({ id: 'm1' });
    expect(r).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(r.results[0]).toMatchObject({ ok: true, id: 'm1' });
    expect(b.forget).toHaveBeenCalledWith('m1');
    expect(h.purgeJournalForMemory).toHaveBeenCalledWith({
      id: 'm1',
      mode: 'hard',
      snapshot: { scope: 'scope-a', text: 'fact m1' },
    });
    expect(h.purgeJournalForMemory.mock.invocationCallOrder[0]).toBeLessThan(
      b.forget.mock.invocationCallOrder[0],
    );
    expect(h.clearL1).toHaveBeenCalledTimes(1);
  });

  it('ids:[…] deletes many; per-item results keyed by id', async () => {
    const b = fakeBackend();
    useBackend(b);
    const r = await body({ ids: ['m1', 'm2', 'm3'] });
    expect(r.counts).toEqual({ ok: 3, failed: 0 });
    expect(r.results.map((x) => x.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('a backend delete failure fails only that item; top-level ok stays true', async () => {
    const b = fakeBackend();
    b.forget.mockImplementation(async (id: string) => {
      if (id === 'bad') throw new Error('delete blew up');
    });
    useBackend(b);
    const r = await body({ ids: ['m1', 'bad', 'm2'] });
    expect(r).toMatchObject({ ok: false, counts: { ok: 2, failed: 1 } });
    expect(r.results[1]).toMatchObject({ ok: false, id: 'bad', error: 'delete blew up' });
  });

  it('confirms a hard delete that committed before its backend promise timed out', async () => {
    const b = fakeBackend();
    b.get
      .mockResolvedValueOnce({ id: 'm1', text: 'fact m1', scope: 'scope-a' })
      .mockResolvedValueOnce(null);
    // Simulate the database commit succeeding while the driver's response hangs.
    b.forget.mockImplementation(() => new Promise<void>(() => {}));
    useBackend(b);

    const r = await withShortMemoryToolTimeout(() => body({ id: 'm1' }));

    expect(r).toMatchObject({
      ok: true,
      results: [{ ok: true, id: 'm1', reconciledAfterTimeout: true }],
      counts: { ok: 1, failed: 0 },
    });
    expect(b.get).toHaveBeenCalledTimes(2);
  });

  it('reports timeout_unknown when the row remains after the hard-delete timeout', async () => {
    const b = fakeBackend();
    b.get
      .mockResolvedValueOnce({ id: 'm1', text: 'fact m1', scope: 'scope-a' })
      .mockResolvedValueOnce({ id: 'm1', text: 'fact m1', scope: 'scope-a' });
    b.forget.mockImplementation(() => new Promise<void>(() => {}));
    useBackend(b);

    const r = await withShortMemoryToolTimeout(() => body({ id: 'm1' }));

    expect(r).toMatchObject({
      ok: false,
      results: [{ ok: false, id: 'm1', reason: 'timeout_unknown' }],
      counts: { ok: 0, failed: 1 },
    });
    expect(b.get).toHaveBeenCalledTimes(2);
  });

  it('reports timeout_unknown when the reconciliation read also times out', async () => {
    const b = fakeBackend();
    b.get
      .mockResolvedValueOnce({ id: 'm1', text: 'fact m1', scope: 'scope-a' })
      .mockImplementationOnce(() => new Promise<null>(() => {}));
    b.forget.mockImplementation(() => new Promise<void>(() => {}));
    useBackend(b);

    const r = await withShortMemoryToolTimeout(() => body({ id: 'm1' }));

    expect(r).toMatchObject({
      ok: false,
      results: [{ ok: false, id: 'm1', reason: 'timeout_unknown' }],
      counts: { ok: 0, failed: 1 },
    });
    expect(b.get).toHaveBeenCalledTimes(2);
  });

  it('a journal purge failure preserves the canonical row for a safe retry', async () => {
    const b = fakeBackend();
    h.purgeJournalForMemory.mockRejectedValueOnce(new Error('journal unavailable'));
    useBackend(b);

    const r = await body({ id: 'm1' });

    expect(r.results[0]).toMatchObject({ ok: false, id: 'm1', error: 'journal unavailable' });
    expect(b.forget).not.toHaveBeenCalled();
    expect(h.clearL1).not.toHaveBeenCalled();
  });

  it('availability gate short-circuits the whole batch (no per-id delete)', async () => {
    const b = fakeBackend();
    b.available.mockResolvedValue({ ok: false, reason: 'memory_backend_disabled' });
    useBackend(b);
    const r = await body({ ids: ['m1', 'm2'] });
    expect(r).toMatchObject({ ok: false, reason: 'memory_backend_disabled' });
    expect(b.forget).not.toHaveBeenCalled();
  });

  it('requires valid memory UUIDs at its public argument boundary', () => {
    const schema = (forget as unknown as { args: { safeParse: (value: unknown) => { success: boolean } } }).args;
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(schema.safeParse({ id: uuid }).success).toBe(true);
    expect(schema.safeParse({ ids: [uuid] }).success).toBe(true);
    expect(schema.safeParse({ id: '556477b3' }).success).toBe(false);
    expect(schema.safeParse({ ids: ['556477b3'] }).success).toBe(false);
  });
});
