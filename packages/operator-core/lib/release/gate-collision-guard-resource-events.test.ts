import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
  emit: vi.fn(async (_event: unknown) => ({ ok: true })),
  transaction: vi.fn(async (_domain: string, _owner: string, run: (tx: object) => unknown) => run({})),
}));

vi.mock('../agent-tools/locks/in-workspace-txn', () => ({ inWorkspaceTxn: runtime.transaction }));
vi.mock('../agent-tools/locks/su-lock-store', () => ({ tryReleaseResource: runtime.release }));
vi.mock('../agent-tools/locks/resource-acquire-wait', () => ({ acquireResourceExclusiveWithWait: runtime.acquire }));
vi.mock('../agent-tools/locks/coordination-domain', () => ({ resourceLockDomain: () => 'papercusp-workspace' }));
vi.mock('../events/await/engine', () => ({ emitAwaitedEvent: runtime.emit }));

import { acquireGitSyncRestartBarrier } from './gate-collision-guard';

describe('EI-25556999491855818: production restart barrier release event wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.acquire.mockReset().mockResolvedValue({ ok: true, status: 'held', lock_id: 'barrier' });
    runtime.release.mockReset().mockResolvedValue({
      released: 1,
      releasedExclusiveResources: ['git-sync'],
      exclusiveResources: [],
    });
  });

  it('emits from the deleted-row receipt even when a successor keeps the resource unavailable', async () => {
    let commit!: (receipt: {
      released: number;
      releasedExclusiveResources: string[];
      exclusiveResources: string[];
    }) => void;
    runtime.release.mockImplementationOnce(() => new Promise((resolve) => { commit = resolve; }));
    const barrier = await acquireGitSyncRestartBarrier('Agent');
    if (!barrier.acquired) throw new Error('expected barrier');
    const pending = barrier.release();
    expect(runtime.emit).not.toHaveBeenCalled();
    commit({ released: 1, releasedExclusiveResources: ['git-sync'], exclusiveResources: [] });
    await pending;
    await vi.waitFor(() => expect(runtime.emit).toHaveBeenCalledTimes(1));
    expect(runtime.emit).toHaveBeenCalledWith(expect.objectContaining({
      key: 'resource:released:git-sync',
      workspaceId: 'papercusp-workspace',
      source: 'resource-locks',
      payload: expect.objectContaining({ resource: 'git-sync', workspaceId: 'papercusp-workspace' }),
    }));
    expect(runtime.release).toHaveBeenCalledWith(expect.any(Object), {
      coordinationDomain: 'papercusp-workspace',
      owner: barrier.owner,
      lockId: 'barrier',
    });
    runtime.release.mockResolvedValueOnce({ released: 0, releasedExclusiveResources: [], exclusiveResources: [] });
    await barrier.release();
    expect(runtime.emit).toHaveBeenCalledTimes(1);
  });

  it.each([
    { released: 0, releasedExclusiveResources: [], exclusiveResources: [] },
    { released: 1, releasedExclusiveResources: ['another-resource'], exclusiveResources: [] },
  ])('does not publish without the production store confirming the captured resource (%j)', async (receipt) => {
    runtime.release.mockResolvedValueOnce(receipt);
    const barrier = await acquireGitSyncRestartBarrier('Agent');
    if (!barrier.acquired) throw new Error('expected barrier');
    await barrier.release();
    expect(runtime.emit).not.toHaveBeenCalled();
  });

  it('does not publish if the production transaction fails', async () => {
    runtime.release.mockRejectedValueOnce(new Error('transaction failed'));
    const barrier = await acquireGitSyncRestartBarrier('Agent');
    if (!barrier.acquired) throw new Error('expected barrier');
    await expect(barrier.release()).rejects.toThrow('transaction failed');
    expect(runtime.emit).not.toHaveBeenCalled();
  });

  it('publishes actual draining-row cleanup through default dependencies while keeping the restart refused', async () => {
    runtime.acquire.mockResolvedValueOnce({ ok: true, status: 'draining', lock_id: 'queued', holders: [] });
    const barrier = await acquireGitSyncRestartBarrier('Agent');
    expect(barrier).toMatchObject({ acquired: false, reason: 'draining' });
    await vi.waitFor(() => expect(runtime.emit).toHaveBeenCalledTimes(1));
    expect(runtime.emit.mock.calls[0][0]).toMatchObject({ key: 'resource:released:git-sync' });
    expect(runtime.release).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ lockId: 'queued' }));
  });
});
