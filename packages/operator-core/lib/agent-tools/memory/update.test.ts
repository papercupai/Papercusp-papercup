/**
 * update.test.ts — the memory:update HANDLER, bulk keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). The backend is mocked; this pins
 * the inline { id, … } single form, the ids:[…] / items:[…] many forms, the
 * per-item UUID + at-least-one-field validation (a bad item fails only itself),
 * the not-found graceful envelope (EI-486), and the metadata-patch mapping
 * (EI-2032). A wedged backend → top-level { ok:false, reason } (covered in
 * b1-timeout.test.ts).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/memory/update.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../memory/backend', () => ({
  getMemoryBackend: vi.fn(),
}));
vi.mock('../../memory/surfaced-outcomes', async (original) => ({
  ...(await original<typeof import('../../memory/surfaced-outcomes')>()),
  captureSurfacedOutcome: vi.fn(async () => ({ ok: true })),
}));

import update from './update';
import { captureSurfacedOutcome } from '../../memory/surfaced-outcomes';
import { getMemoryBackend } from '../../memory/backend';

type FakeBackend = {
  name: string;
  available: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

const fakeBackend = (): FakeBackend => ({
  name: 'fake',
  available: vi.fn(async () => ({ ok: true })),
  update: vi.fn(async () => undefined),
});

const useBackend = (b: FakeBackend): void => {
  vi.mocked(getMemoryBackend).mockReturnValue(b as unknown as ReturnType<typeof getMemoryBackend>);
};

type Out = { data: any };
const body = async (args: unknown): Promise<Record<string, never> & { ok: boolean; reason?: string; results: { ok: boolean; id: string; error?: string; reason?: string }[]; counts: { ok: number; failed: number } }> =>
  (((await update.handler(args as never, {} as never)) as Out).data);

const VID = '550e8400-e29b-41d4-a716-446655440000';
const VID2 = '550e8400-e29b-41d4-a716-446655440001';

// EI-10371: every content edit re-stamps the credential flag both ways —
// clean text carries the explicit clear (editing a secret out must drop the chip).
const CLEAN_STAMP = { possible_secret: false, possible_secret_classes: [] };

describe('memory:update handler (bulk keyed-array)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records contradiction for successful updates in the caller session, excluding failed items', async () => {
    const b = fakeBackend();
    b.update.mockImplementation(async (id: string) => {
      if (id === VID2) throw new Error('write failed');
    });
    useBackend(b);
    const ctx = { uiClientId: 'corrector' } as Parameters<typeof update.handler>[1];
    await update.handler({ ids: [VID, VID2], content: 'correction' }, ctx);
    expect(captureSurfacedOutcome).toHaveBeenCalledExactlyOnceWith(ctx, [VID], 'contradicted');
  });

  it('inline { id, content } → one ok result; backend.update called with the text patch', async () => {
    const b = fakeBackend();
    useBackend(b);
    const r = await body({ id: VID, content: 'updated memory content' });
    expect(r).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(r.results[0]).toMatchObject({ ok: true, id: VID });
    expect(b.update).toHaveBeenCalledWith(VID, { text: 'updated memory content', metadata: CLEAN_STAMP });
  });

  it('ids:[…] applies the SAME metadata patch to many; per-item results keyed by id', async () => {
    const b = fakeBackend();
    useBackend(b);
    const r = await body({ ids: [VID, VID2], kind: 'reference' });
    expect(r.counts).toEqual({ ok: 2, failed: 0 });
    expect(r.results.map((x) => x.id)).toEqual([VID, VID2]);
    expect(b.update).toHaveBeenCalledWith(VID, { metadata: { kind: 'reference' } });
    expect(b.update).toHaveBeenCalledWith(VID2, { metadata: { kind: 'reference' } });
  });

  it('items:[…] heterogeneous: each its own patch', async () => {
    const b = fakeBackend();
    useBackend(b);
    await body({ items: [{ id: VID, content: 'fix' }, { id: VID2, scope: 'harness:papercup' }] });
    expect(b.update).toHaveBeenCalledWith(VID, { text: 'fix', metadata: CLEAN_STAMP });
    expect(b.update).toHaveBeenCalledWith(VID2, { metadata: { user_id: 'harness:papercup' } });
  });

  it('a not-found item fails only itself (EI-486) — top-level ok stays true', async () => {
    const b = fakeBackend();
    b.update.mockImplementation(async (id: string) => {
      if (id === VID2) throw new Error(`Memory with ID ${id} not found`);
    });
    useBackend(b);
    const r = await body({ ids: [VID, VID2], content: 'x' });
    expect(r).toMatchObject({ ok: false, counts: { ok: 1, failed: 1 } });
    expect(r.results[0]).toMatchObject({ ok: true, id: VID });
    expect(r.results[1]).toMatchObject({ ok: false, id: VID2 });
    expect(r.results[1].error).toContain('not found');
    expect(r.results[1].error).toContain(VID2);
  });

  it('a non-UUID id fails only that item (per-item validation, no backend call)', async () => {
    const b = fakeBackend();
    useBackend(b);
    const r = await body({ items: [{ id: VID, content: 'ok' }, { id: 'not-a-uuid', content: 'x' }] });
    expect(r.counts).toEqual({ ok: 1, failed: 1 });
    expect(r.results[1]).toMatchObject({ ok: false, id: 'not-a-uuid', error: 'Memory ID must be a valid UUID' });
    expect(b.update).toHaveBeenCalledTimes(1); // only the valid one
    expect(b.update).toHaveBeenCalledWith(VID, { text: 'ok', metadata: CLEAN_STAMP });
  });

  it('a metadata-only patch (kind + workspaceId) maps to backend.update metadata', async () => {
    const b = fakeBackend();
    useBackend(b);
    const r = await body({ id: VID, kind: 'reference', workspaceId: 'papercusp-workspace' });
    expect(r.results[0].ok).toBe(true);
    expect(b.update).toHaveBeenCalledWith(VID, {
      metadata: { kind: 'reference', workspace_id: 'papercusp-workspace' },
    });
  });

  it('content + metadata flow through together in one patch', async () => {
    const b = fakeBackend();
    useBackend(b);
    await body({ id: VID, content: 'fixed text', kind: 'project' });
    expect(b.update).toHaveBeenCalledWith(VID, { text: 'fixed text', metadata: { kind: 'project', ...CLEAN_STAMP } });
  });

  it('handles backend unavailability gracefully (top-level gate, no per-item run)', async () => {
    const b = fakeBackend();
    b.available.mockResolvedValue({ ok: false, reason: 'memory_backend_disabled' });
    useBackend(b);
    const r = await body({ id: VID, content: 'content' });
    expect(r).toMatchObject({ ok: false, reason: 'memory_backend_disabled' });
    expect(b.update).not.toHaveBeenCalled();
  });
});
