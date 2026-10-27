/**
 * resolve.test.ts — the coord:resolve HANDLER, bulk keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). resolveEscalation mocked. Pins:
 *   • single { msg_id, choice } → one ok result self-describing its msg_id;
 *   • msg_ids:[…] + choice fans the same choice across many;
 *   • a not_found / already_resolved on ONE item fails only that item — top-level
 *     ok stays true (counts.failed is the truth).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/resolve.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me', workspaceId: 'ws1' })) }));
vi.mock('../escalations', () => ({ resolveEscalation: vi.fn() }));
vi.mock('../card-link', () => ({ unblockLinkedCard: vi.fn(), commitLinkedConverseCard: vi.fn(async () => {}) }));
vi.mock('../../../events/await/engine', () => ({ emitAwaitedEvent: vi.fn(async () => {}) }));

import { resolveEscalation } from '../escalations';
import { commitLinkedConverseCard } from '../card-link';
const resolveM = vi.mocked(resolveEscalation);
const tool = (await import('./resolve')).default;

type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(args as never, {} as never)) as Out).data);

beforeEach(() => {
  vi.clearAllMocks();
  // a resolved escalation projection (the success branch returns the object)
  resolveM.mockResolvedValue({ msg_id: 'E-1', choice: 'go' } as never);
});

describe('coord:resolve handler (bulk keyed-array)', () => {
  it('supplies the awaited card decision guard to the existing escalation writer', async () => {
    await body({ msg_id: 'E-1', choice: 'go' });
    const open = { msg_id: 'E-1', cardProtocolVersion: 1 };
    await resolveM.mock.calls[0][1]!.beforeResolve!(open as never);
    expect(commitLinkedConverseCard).toHaveBeenCalledWith(open, 'go', expect.any(Object));
  });
  it('single { msg_id, choice } → one ok result self-describing its msg_id', async () => {
    const b = await body({ msg_id: 'E-1', choice: 'go' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, msg_id: 'E-1' });
    expect(resolveM).toHaveBeenCalledWith(expect.objectContaining({ msg_id: 'E-1', choice: 'go', resolver: 'me' }), expect.any(Object));
  });

  it('msg_ids:[…] + choice fans the same choice across many', async () => {
    const b = await body({ msg_ids: ['E-1', 'E-2'], choice: 'go' });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(resolveM).toHaveBeenCalledWith(expect.objectContaining({ msg_id: 'E-2', choice: 'go' }), expect.any(Object));
  });

  it('one ok + one not_found: only the missing item fails, top-level ok stays true', async () => {
    resolveM.mockImplementation(async ({ msg_id }: { msg_id: string }) =>
      msg_id === 'E-404' ? ('not_found' as never) : ({ msg_id, choice: 'go' } as never),
    );
    const b = await body({ items: [{ msg_id: 'E-1', choice: 'go' }, { msg_id: 'E-404', choice: 'go' }] });
    expect(b).toMatchObject({ ok: false, counts: { ok: 1, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: true, msg_id: 'E-1' });
    expect(b.results[1]).toMatchObject({ ok: false, msg_id: 'E-404', error: 'not_found' });
  });

  it('already_resolved is per-item and never fails the rest', async () => {
    resolveM.mockResolvedValue('already_resolved' as never);
    const b = await body({ msg_id: 'E-1', choice: 'go' });
    expect(b.results[0]).toMatchObject({ ok: false, msg_id: 'E-1', error: 'already_resolved' });
  });

  // EI-843: the Mug wake brief renders open escalations as `escalation:<msg_id>`
  // digest ids (mug-brief-launch.ts gatherEscalations) — passing that digest
  // straight back used to 404 as not_found. Strip the prefix at the tool
  // boundary so both forms resolve identically, across all three call shapes.
  describe('EI-843: escalation: digest-id prefix from the wake brief', () => {
    it('single { msg_id: "escalation:E-1", choice } strips the prefix before resolving', async () => {
      const b = await body({ msg_id: 'escalation:E-1', choice: 'go' });
      expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
      expect(b.results[0]).toMatchObject({ ok: true, msg_id: 'E-1' });
      expect(resolveM).toHaveBeenCalledWith(expect.objectContaining({ msg_id: 'E-1', choice: 'go' }), expect.any(Object));
    });

    it('msg_ids:[…] strips the prefix on every id in the batch', async () => {
      const b = await body({ msg_ids: ['escalation:E-1', 'escalation:E-2'], choice: 'go' });
      expect(b.counts).toEqual({ ok: 2, failed: 0 });
      expect(resolveM).toHaveBeenCalledWith(expect.objectContaining({ msg_id: 'E-1', choice: 'go' }), expect.any(Object));
      expect(resolveM).toHaveBeenCalledWith(expect.objectContaining({ msg_id: 'E-2', choice: 'go' }), expect.any(Object));
    });

    it('items:[…] strips the prefix per heterogeneous item', async () => {
      const b = await body({ items: [{ msg_id: 'escalation:E-1', choice: 'go' }, { id: 'escalation:E-2', choice: 'no' }] });
      expect(b.counts).toEqual({ ok: 2, failed: 0 });
      expect(b.results[0]).toMatchObject({ ok: true, msg_id: 'E-1' });
      expect(b.results[1]).toMatchObject({ ok: true, msg_id: 'E-2' });
    });

    it('a bare msg_id that happens to have no prefix is unaffected', async () => {
      const b = await body({ msg_id: 'E-1', choice: 'go' });
      expect(resolveM).toHaveBeenCalledWith(expect.objectContaining({ msg_id: 'E-1' }), expect.any(Object));
    });
  });
});
