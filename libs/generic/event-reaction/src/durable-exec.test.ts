import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeDurableReaction, type DurableReactionPayload } from './durable-exec';
import type { ReactionStore } from './dedup';

interface TestParent {
  workspaceId?: string;
  uiClientId?: string;
  role?: string;
}

function payload(over: Partial<DurableReactionPayload<TestParent>> = {}): DurableReactionPayload<TestParent> {
  return {
    fire: 'sink:tool',
    args: { owner: 'agent-1' },
    parent: { workspaceId: 'w1', uiClientId: 'agent-1' },
    cause: { depth: 1, chain: ['r1'], ruleId: 'r1', rootRunId: 'root' },
    ruleId: 'r1',
    triggerTool: 'thing:done',
    dedupId: 'reaction:root:r1',
    ...over,
  };
}

function deps() {
  const store = {
    claim: vi.fn<ReactionStore['claim']>(async () => true),
    release: vi.fn<ReactionStore['release']>(async () => {}),
    markFailed: vi.fn<ReactionStore['markFailed']>(async () => {}),
    outcome: vi.fn(async (): Promise<'completed' | 'uncertain'> => 'completed'),
    complete: vi.fn(async () => {}),
    uncertain: vi.fn(async () => {}),
  };
  const fire = vi.fn<(p: DurableReactionPayload<TestParent>) => Promise<{ ok: boolean; error?: string; withheld?: boolean }>>(
    async () => ({ ok: true }),
  );
  const log = vi.fn<(m: string) => void>();
  return { store, fire, log };
}

describe('executeDurableReaction', () => {
  let d: ReturnType<typeof deps>;
  beforeEach(() => {
    d = deps();
  });

  it('claims the dedup id then dispatches when fresh', async () => {
    await executeDurableReaction(payload(), d);
    expect(d.store.claim).toHaveBeenCalledOnce();
    expect(d.store.claim.mock.calls[0][0]).toMatchObject({
      dedupId: 'reaction:root:r1',
      workspaceId: 'w1',
      fire: 'sink:tool',
      depth: 1,
    });
    expect(d.fire).toHaveBeenCalledOnce();
    expect(d.fire.mock.calls[0][0].fire).toBe('sink:tool');
  });

  it('carries the contributor into the claim, so the ledger can attribute the fire', async () => {
    await executeDurableReaction(payload({ contributor: 'plugin:acme' }), d);
    expect(d.store.claim.mock.calls[0][0].contributor).toBe('plugin:acme');
  });

  it('releases only a positive pre-effect withholding receipt, without recording completion', async () => {
    d.fire.mockResolvedValue({ ok: true, withheld: true });
    await executeDurableReaction(payload(), d);
    expect(d.store.release).toHaveBeenCalledWith('reaction:root:r1');
    expect(d.store.complete).not.toHaveBeenCalled();
    expect(d.store.uncertain).not.toHaveBeenCalled();
    d.fire.mockResolvedValue({ ok: true });
    await executeDurableReaction(payload(), d);
    expect(d.store.complete).toHaveBeenCalledOnce();
  });

  it('retains uncertainty for a failed dispatch even if it also claims withholding', async () => {
    d.fire.mockResolvedValue({ ok: false, withheld: true, error: 'effect outcome unknown' });
    await expect(executeDurableReaction(payload(), d)).rejects.toThrow(/effect outcome unknown/);
    expect(d.store.release).not.toHaveBeenCalled();
    expect(d.store.complete).not.toHaveBeenCalled();
    expect(d.store.uncertain).toHaveBeenCalledOnce();
  });

  it('claims contributor NULL — never undefined — when the rule declares no source', async () => {
    await executeDurableReaction(payload(), d);
    // Explicit null, not a missing key: a store writing this straight into a
    // column needs a value, and `undefined` is not one.
    expect(d.store.claim.mock.calls[0][0].contributor).toBeNull();
  });

  it('is a no-op when the dedup id was already claimed (double-fire → no-op)', async () => {
    d.store.claim.mockResolvedValue(false);
    await executeDurableReaction(payload(), d);
    expect(d.fire).not.toHaveBeenCalled();
  });

  it('skips (no claim, no dispatch) when there is no workspace', async () => {
    await executeDurableReaction(payload({ parent: { uiClientId: 'a' } }), d);
    expect(d.store.claim).not.toHaveBeenCalled();
    expect(d.fire).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('no workspace'));
  });

  it('retains the claim for reconciliation when dispatch reports failure', async () => {
    d.fire.mockResolvedValue({ ok: false, error: 'unknown reaction tool' });
    await expect(executeDurableReaction(payload(), d)).rejects.toThrow(/unknown reaction tool/);
    expect(d.store.release).not.toHaveBeenCalled();
    expect(d.store.uncertain).toHaveBeenCalled();
  });

  it('does not silently succeed or dispatch after a crash following the claim', async () => {
    d.store.claim.mockResolvedValue(false);
    d.store.outcome.mockResolvedValue('uncertain');
    await expect(executeDurableReaction(payload(), d)).rejects.toThrow(/needs reconciliation/);
    expect(d.fire).not.toHaveBeenCalled();
    expect(d.store.uncertain).toHaveBeenCalled();
  });

  it('recovers only a positive receiver receipt without dispatching the effect again', async () => {
    d.store.claim.mockResolvedValue(false);
    d.store.outcome.mockResolvedValue('uncertain');
    const reconcile = vi.fn(async () => 'completed' as const);
    await executeDurableReaction(payload(), { ...d, reconcile });
    expect(reconcile).toHaveBeenCalledWith(payload());
    expect(d.store.complete).toHaveBeenCalledWith(payload().dedupId);
    expect(d.fire).not.toHaveBeenCalled();
    expect(d.store.uncertain).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'unreadable', 'ack-lost'] as const)('retains custody when receiver recovery is %s', async scenario => {
    d.store.claim.mockResolvedValue(false);
    d.store.outcome.mockResolvedValue('uncertain');
    const reconcile = vi.fn(async () => {
      if (scenario === 'unreadable') throw new Error('receipt unavailable');
      return scenario === 'ack-lost' ? 'completed' as const : 'uncertain' as const;
    });
    if (scenario === 'ack-lost') d.store.complete.mockRejectedValue(new Error('ack unavailable'));
    await expect(executeDurableReaction(payload(), { ...d, reconcile })).rejects.toThrow('needs reconciliation');
    expect(d.fire).not.toHaveBeenCalled();
    expect(d.store.release).not.toHaveBeenCalled();
    expect(d.store.uncertain).toHaveBeenCalledOnce();
  });

  it('records a thrown dispatch as uncertain and never releases its identity', async () => {
    d.fire.mockRejectedValue(new Error('connection lost after dispatch'));
    await expect(executeDurableReaction(payload(), d)).rejects.toThrow(/needs reconciliation/);
    expect(d.store.release).not.toHaveBeenCalled();
    expect(d.store.complete).not.toHaveBeenCalled();
    expect(d.store.uncertain).toHaveBeenCalled();
  });

  it('replays a completed receipt without dispatching after the DBOS checkpoint was lost', async () => {
    let claimed = false;
    let completed = false;
    d.store.claim.mockImplementation(async () => { const fresh = !claimed; claimed = true; return fresh; });
    d.store.complete.mockImplementation(async () => { completed = true; });
    d.store.outcome.mockImplementation(async () => completed ? 'completed' : 'uncertain');
    await executeDurableReaction(payload(), d);
    await executeDurableReaction(payload(), d);
    expect(d.fire).toHaveBeenCalledTimes(1);
  });

  it('passes the serializable parent + cause through to the fire port', async () => {
    await executeDurableReaction(payload({ parent: { workspaceId: 'w1', role: 'worker' } }), d);
    const passed = d.fire.mock.calls[0][0];
    expect(passed.parent).toMatchObject({ workspaceId: 'w1', role: 'worker' });
    expect(passed.cause).toEqual({ depth: 1, chain: ['r1'], ruleId: 'r1', rootRunId: 'root' });
  });
});
