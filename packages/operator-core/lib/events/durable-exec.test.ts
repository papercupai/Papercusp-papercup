import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the dedup ledger (PG) and the in-process dispatcher so executeDurableReaction's
// control flow is testable without a database or the real dispatch stack.
vi.mock('./reaction-dedup', () => ({
  claimReaction: vi.fn(async () => true),
  releaseReaction: vi.fn(async () => {}),
  markReactionFailed: vi.fn(async () => {}),
  reactionOutcome: vi.fn(async () => 'completed'),
  completeReaction: vi.fn(async () => {}),
  markReactionUncertain: vi.fn(async () => {}),
}));
vi.mock('./dispatch-reaction', () => ({
  fireReactionInProcess: vi.fn(async () => ({ ok: true })),
  buildReactionCtx: vi.fn(),
}));

import { executeDurableReaction, type DurableReactionPayload } from './durable-exec';
import { claimReaction, releaseReaction } from './reaction-dedup';
import { fireReactionInProcess } from './dispatch-reaction';

const claim = vi.mocked(claimReaction);
const release = vi.mocked(releaseReaction);
const fire = vi.mocked(fireReactionInProcess);

function payload(over: Partial<DurableReactionPayload> = {}): DurableReactionPayload {
  return {
    fire: 'activity:report',
    args: { owner: 'agent-1' },
    parent: { workspaceId: 'w1', uiClientId: 'agent-1' },
    cause: { depth: 1, chain: ['r1'], ruleId: 'r1', rootRunId: 'root' },
    ruleId: 'r1',
    triggerTool: 'coord:handoff',
    dedupId: 'reaction:root:r1',
    ...over,
  };
}

beforeEach(() => {
  claim.mockReset().mockResolvedValue(true);
  release.mockReset().mockResolvedValue(undefined);
  fire.mockReset().mockResolvedValue({ ok: true });
});

describe('executeDurableReaction', () => {
  it('claims the dedup id then dispatches when fresh', async () => {
    await executeDurableReaction(payload());
    expect(claim).toHaveBeenCalledOnce();
    expect(claim.mock.calls[0][0]).toMatchObject({ dedupId: 'reaction:root:r1', workspaceId: 'w1', fire: 'activity:report', depth: 1 });
    expect(fire).toHaveBeenCalledOnce();
    expect(fire.mock.calls[0][0].fire).toBe('activity:report');
  });

  it('is a no-op when the dedup id was already claimed (double-fire → no-op, D-007)', async () => {
    claim.mockResolvedValue(false);
    await executeDurableReaction(payload());
    expect(fire).not.toHaveBeenCalled();
  });

  it('skips (no dispatch) when there is no workspace', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await executeDurableReaction(payload({ parent: { uiClientId: 'a' } }));
    expect(claim).not.toHaveBeenCalled();
    expect(fire).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no workspace'));
    warn.mockRestore();
  });

  it('preserves the uncertain claim when dispatch fails', async () => {
    fire.mockResolvedValue({ ok: false, error: 'unknown reaction tool' });
    await expect(executeDurableReaction(payload())).rejects.toThrow(/unknown reaction tool/);
    expect(release).not.toHaveBeenCalled();
  });

  it('rebuilds the reaction parent from the serializable payload', async () => {
    await executeDurableReaction(payload({ parent: { workspaceId: 'w1', harnessSlug: 'h9', role: 'worker', uiClientId: 'agent-2' } }));
    expect(fire).toHaveBeenCalledOnce();
    const passed = fire.mock.calls[0][0];
    expect(passed.parentCtx).toMatchObject({ workspaceId: 'w1', harnessSlug: 'h9', role: 'worker', uiClientId: 'agent-2' });
    expect(passed.cause).toEqual({ depth: 1, chain: ['r1'], ruleId: 'r1', rootRunId: 'root' });
  });
});
