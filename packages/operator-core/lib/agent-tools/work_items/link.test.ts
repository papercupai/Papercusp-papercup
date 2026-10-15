/**
 * link.test.ts — work_items:link HANDLER (engine fns mocked), bulk keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). Pins: inline single edge → one result;
 * items:[…] fan-out → per-edge results keyed by id+rel; a missing target → that edge's
 * { ok:false } without failing the batch; remove:true routes to unlinkWorkItem.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/link.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));
vi.mock('../../work-items', () => ({
  linkWorkItem: vi.fn(),
  unlinkWorkItem: vi.fn(),
  resolveWorkItemRef: vi.fn(),
}));
vi.mock('../../dbos/feature-blockers-edges', () => ({ guardFeatureBlockEdgeAcyclic: vi.fn() }));

import { linkWorkItem, unlinkWorkItem, resolveWorkItemRef } from '../../work-items';
import { guardFeatureBlockEdgeAcyclic } from '../../dbos/feature-blockers-edges';
import { EVENT_SUBSCRIPTION_KIND } from '../coordination/event-subscriptions';
const linkM = vi.mocked(linkWorkItem);
const unlinkM = vi.mocked(unlinkWorkItem);
const resolveM = vi.mocked(resolveWorkItemRef);
const guardM = vi.mocked(guardFeatureBlockEdgeAcyclic);
const tool = (await import('./link')).default;

type Out = { data: any };
const body = async (args: unknown) => ((await tool.handler(args as never, {} as never)) as Out).data;

beforeEach(() => {
  vi.clearAllMocks();
  resolveM.mockResolvedValue({ kind: 'work_item', ref: 'WI-T' } as never);
  linkM.mockResolvedValue({} as never);
  unlinkM.mockResolvedValue({} as never);
  guardM.mockResolvedValue(null); // default: no cycle
});

describe('work_items:link args schema (EI-7049)', () => {
  it('teaches the default-on complete-candidate admission contract', () => {
    expect(tool.description).toMatch(/default-on.*complete typed candidate graph/i);
    expect(tool.guidance?.when).toMatch(/refuses cycles, bad endpoints, and newly stranded work/i);
    expect(tool.guidance?.chaining).toContain('work_items:link { id, rel:"blocks", target_id }');
  });

  it('rejects a call missing id/rel/items with a message naming the EXACT field (no truncated ellipsis)', () => {
    const r = tool.args.safeParse({});
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues[0]?.message ?? '';
      // The bug: "target…" elided the actual field name. `items:[…]` is a fine,
      // non-eliding ellipsis (it denotes "array contents"), so only ban the
      // specific truncated-field form, not every ellipsis in the message.
      expect(msg).not.toContain('target…');
      expect(msg).toContain('target_id');
      expect(msg).toContain('target_kind');
      expect(msg).toContain('target_ref');
    }
  });

  it('accepts a well-formed single-shorthand call (id + rel present, target checked later by the handler)', () => {
    expect(tool.args.safeParse({ id: 'WI-1', rel: 'blocks', target_id: 'WI-T' }).success).toBe(true);
  });

  it('accepts the legacy source_id spelling emitted by the former set_blocker hint', () => {
    expect(tool.args.safeParse({ source_id: 'WI-10002525', rel: 'blocks', target_id: 'WI-2144525' }).success).toBe(true);
    expect(
      tool.args.safeParse({ id: 'WI-1', source_id: 'WI-2', rel: 'blocks', target_id: 'WI-T' }).success,
    ).toBe(false);
  });

  it("accepts the feedback-lineage rel='revises'", () => {
    expect(tool.args.safeParse({ id: 'EI-2', rel: 'revises', target_id: 'EI-1' }).success).toBe(true);
  });

  it('documents and rejects satisfaction for non-work-item ObjectRef targets', () => {
    expect(tool.description).toMatch(/plan_item\/event\/topic targets cannot carry satisfaction/i);

    const single = tool.args.safeParse({
      id: 'WI-1',
      rel: 'blocks',
      target_kind: 'plan_item',
      target_ref: 'plan#P-1',
      satisfaction: 'success',
    });
    expect(single.success).toBe(false);
    if (!single.success) {
      expect(single.error.issues.some((issue) => /work-item target.*target_id/i.test(issue.message))).toBe(true);
    }

    const bulk = tool.args.safeParse({
      items: [
        {
          id: 'WI-1',
          rel: 'blocks',
          target_kind: 'event',
          target_ref: 'work-item:done:WI-2',
          satisfaction: 'settled',
        },
      ],
    });
    expect(bulk.success).toBe(false);
  });

  it('allows satisfaction for an explicitly typed issue/feature target', () => {
    expect(
      tool.args.safeParse({
        id: 'WI-1',
        rel: 'blocks',
        target_kind: 'issue',
        target_ref: 'EI-2',
        satisfaction: 'success',
      }).success,
    ).toBe(true);
  });
});

describe('work_items:link handler (bulk keyed-array)', () => {
  it('inline single edge links once and returns one result', async () => {
    const b = await body({ id: 'WI-1', rel: 'blocks', target_id: 'WI-T' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', rel: 'blocks' });
    expect(linkM).toHaveBeenCalledWith('WI-1', { kind: 'work_item', ref: 'WI-T' }, 'blocks', {
      harness: undefined,
      by: 'me',
    });
  });

  it('derives dependency authorship from the session identity, not actor-shaped input', async () => {
    const b = await body({
      id: 'WI-dependent',
      rel: 'blocks',
      target_id: 'WI-blocker',
      by: 'su-spoofed',
      createdBy: 'su-spoofed',
    });

    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(linkM).toHaveBeenCalledWith('WI-dependent', { kind: 'work_item', ref: 'WI-T' }, 'blocks', {
      harness: undefined,
      by: 'me',
    });
  });

  it('normalizes the legacy source_id alias to the canonical source field', async () => {
    const b = await body({ source_id: 'WI-10002525', rel: 'blocks', target_id: 'WI-2144525' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(linkM).toHaveBeenCalledWith('WI-10002525', { kind: 'work_item', ref: 'WI-T' }, 'blocks', {
      harness: undefined,
      by: 'me',
    });
  });

  it('threads an explicit success requirement only for work-item blocks edges', async () => {
    resolveM.mockResolvedValue({ kind: 'issue', ref: 'WI-T' } as never);
    const accepted = await body({ id: 'WI-1', rel: 'blocks', target_id: 'WI-T', satisfaction: 'success' });
    expect(accepted.counts).toEqual({ ok: 1, failed: 0 });
    expect(linkM).toHaveBeenCalledWith('WI-1', { kind: 'issue', ref: 'WI-T' }, 'blocks', {
      harness: undefined,
      by: 'me',
      satisfaction: 'success',
    });

    const rejected = await body({ id: 'WI-1', rel: 'relates', target_id: 'WI-T', satisfaction: 'success' });
    expect(rejected.counts).toEqual({ ok: 0, failed: 1 });
    expect(String(rejected.results[0].error)).toMatch(/only for rel=blocks/);
  });

  it('persists a revision edge with source=new revision and target=original', async () => {
    await body({ id: 'EI-2', rel: 'revises', target_id: 'EI-1' });
    expect(linkM).toHaveBeenCalledWith('EI-2', { kind: 'work_item', ref: 'WI-T' }, 'revises', {
      harness: undefined,
      by: 'me',
    });
  });

  it('fans out many edges (items:[…]); a missing target fails only that edge', async () => {
    resolveM.mockImplementation(async (tid: string) =>
      tid === 'WI-MISS' ? null : ({ kind: 'work_item', ref: tid } as never),
    );
    const b = await body({
      items: [
        { id: 'WI-1', rel: 'blocks', target_id: 'WI-2' },
        { id: 'WI-1', rel: 'relates', target_id: 'WI-MISS' },
      ],
    });
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'WI-1', rel: 'relates' });
    expect(String(b.results[1].error)).toMatch(/WI-MISS.*not found/i);
  });

  it('remove:true routes to unlinkWorkItem', async () => {
    await body({ id: 'WI-1', rel: 'blocks', target_kind: 'plan_item', target_ref: 'p#P-1', remove: true });
    expect(unlinkM).toHaveBeenCalledWith('WI-1', { kind: 'plan_item', ref: 'p#P-1' }, 'blocks', { harness: undefined });
    expect(linkM).not.toHaveBeenCalled();
  });

  it('missing target spec fails that edge with a clear error', async () => {
    const b = await body({ id: 'WI-1', rel: 'fixes' });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-1', rel: 'fixes' });
    expect(String(b.results[0].error)).toMatch(/target_id.*target_kind/i);
  });

  it('REJECTS a cycle-closing feature→feature blocks edge (F4) without writing it', async () => {
    // The source resolves to a qualified feature ref; the acyclicity guard reports a cycle.
    resolveM.mockResolvedValue({ kind: 'feature', ref: 'h#F-1' } as never);
    guardM.mockResolvedValue("'blocks' edge h#F-1 → h#F-2 would create a feature-dependency cycle");
    const b = await body({ id: 'F-1', rel: 'blocks', target_kind: 'feature', target_ref: 'h#F-2', harness: 'h' });
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'F-1', rel: 'blocks' });
    expect(String(b.results[0].error)).toMatch(/dependency cycle/);
    expect(linkM).not.toHaveBeenCalled(); // the cycle-closing edge was never written
  });

  it('does NOT run the acyclicity guard for non-blocks edges or removals', async () => {
    await body({ id: 'WI-1', rel: 'relates', target_id: 'WI-T' });
    await body({ id: 'WI-1', rel: 'blocks', target_id: 'WI-T', remove: true });
    expect(guardM).not.toHaveBeenCalled();
  });

  // WI-10004344: a gate item hand-linked with target_kind:'condition' was invisible to the
  // condition store (it reads only EVENT_SUBSCRIPTION_KIND edges), so gate ownership read
  // 'unowned' while a live fixer held the item, and a second owner was filed.
  it('stores a target_kind:"condition" edge under the kind the condition store reads, and says so', async () => {
    const b = await body({
      id: 'WI-1',
      rel: 'about',
      target_kind: 'condition',
      target_ref: 'gate-red-streak:papercusp',
    });
    expect(linkM).toHaveBeenCalledWith(
      'WI-1',
      { kind: EVENT_SUBSCRIPTION_KIND, ref: 'gate-red-streak:papercusp' },
      'about',
      { harness: undefined, by: 'me' },
    );
    expect(b.results[0]).toMatchObject({
      ok: true,
      targetKindNormalized: { from: 'condition', to: EVENT_SUBSCRIPTION_KIND },
    });
  });

  it('canonicalises condition aliases on remove too, so the canonical edge can be detached', async () => {
    await body({
      id: 'WI-1',
      rel: 'about',
      target_kind: 'conditionKey',
      target_ref: 'green-stall:papercusp',
      remove: true,
    });
    expect(unlinkM).toHaveBeenCalledWith(
      'WI-1',
      { kind: EVENT_SUBSCRIPTION_KIND, ref: 'green-stall:papercusp' },
      'about',
      { harness: undefined },
    );
  });

  it('passes every other explicit target_kind through unchanged, with no normalisation note', async () => {
    const b = await body({ id: 'WI-1', rel: 'about', target_kind: 'plan_item', target_ref: 'p#P-1' });
    expect(linkM).toHaveBeenCalledWith('WI-1', { kind: 'plan_item', ref: 'p#P-1' }, 'about', {
      harness: undefined,
      by: 'me',
    });
    expect(b.results[0]).not.toHaveProperty('targetKindNormalized');
  });
});
