/**
 * Unit tests for work_items:park (modes-and-intake-ux-2026-07-05 P-004).
 * The store (setWorkItemCheckpointWithPrior/releaseWorkItem/getWorkItem/sendMessage) is
 * mocked — this exercises the tool's contract, in particular the EI-8824
 * workspaceId-wildcard-normalization fix shared with work_items:checkpoint.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const setWorkItemCheckpointWithPrior = vi.fn();
const getWorkItem = vi.fn();
const releaseWorkItem = vi.fn();
const sendMessage = vi.fn();

vi.mock('../../work-item-checkpoint', () => ({
  setWorkItemCheckpointWithPrior: (...a: unknown[]) => setWorkItemCheckpointWithPrior(...a),
}));
vi.mock('../../work-items', () => ({
  getWorkItem: (...a: unknown[]) => getWorkItem(...a),
  releaseWorkItem: (...a: unknown[]) => releaseWorkItem(...a),
}));
vi.mock('../coordination/messages', () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
}));
import park from './park';
import { withCarryNoteChecks } from '../../carry-note';

const parse = (x: unknown) => (park.args as { parse: (x: unknown) => unknown }).parse(x);
const call = async (x: unknown, ctx: unknown) => {
  const res = (await park.handler(parse(x) as never, ctx as never)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
};

type StoreOpts = {
  guard: (prior: string | null, priorLength: number) => string | null;
  transform: (prior: string | null, note: string | null | undefined) => string | null | undefined;
};

// EI-8824: force activeWorkspaceId()'s deterministic env-pin precedence (workspace-registry.ts
// precedence #2) instead of mocking the workspace-registry module — resolveConcreteWorkspaceId
// and activeWorkspaceId are same-module internal calls, so overriding the module's exports via
// vi.mock does NOT intercept the internal call resolveConcreteWorkspaceId makes to
// activeWorkspaceId(); only an out-of-module signal (the env var) actually steers it.
const PRIOR_WS_ENV = process.env.PAPERCUSP_WORKSPACE_ID;
afterAll(() => {
  if (PRIOR_WS_ENV === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
  else process.env.PAPERCUSP_WORKSPACE_ID = PRIOR_WS_ENV;
});

beforeEach(() => {
  process.env.PAPERCUSP_WORKSPACE_ID = 'resolved-concrete-ws';
  setWorkItemCheckpointWithPrior.mockReset();
  getWorkItem.mockReset();
  releaseWorkItem.mockReset();
  sendMessage.mockReset();
  getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
  setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: 'state', priorLength: 0 });
  releaseWorkItem.mockResolvedValue(true);
  sendMessage.mockResolvedValue(undefined);
});

describe('work_items:park', () => {
  it('WI-10004456: a short park note preserves multi-section history and carried checks', async () => {
    const prior = withCarryNoteChecks('Original investigation\n\n---\n\nAuto-checkpoint snapshot', [
      { claim: 'focused regression passes', verified: 'test output' },
    ]);
    const update = 'Paused; resume with the remaining validation';
    let persisted = prior;
    setWorkItemCheckpointWithPrior.mockImplementation(async (_ref: unknown, note: string, opts: StoreOpts) => {
      const blockedReason = opts.guard(persisted, persisted.length);
      const priorLength = persisted.length;
      if (!blockedReason) persisted = opts.transform(persisted, note) ?? persisted;
      return { stored: persisted, priorLength, blockedReason };
    });
    const out = await call(
      { id: 'WI-7', checkpoint: update, reason: 'pause' },
      { uiClientId: 'a1', sigVerifiedSpawn: true, workspaceId: 'default' },
    );
    expect(persisted).toContain('Original investigation\n\n---\n\nAuto-checkpoint snapshot\n\n---\n\n' + update);
    expect(persisted).toContain('focused regression passes');
    expect(persisted).toContain('test output');
    expect(out).toMatchObject({ ok: true, priorLength: prior.length, checkpointChars: persisted.length });
  });

  it('refuses an oversized append without releasing the claim', async () => {
    const prior = 'x'.repeat(32000);
    setWorkItemCheckpointWithPrior.mockImplementation(async (_ref: unknown, _note: string, opts: StoreOpts) => ({
      stored: prior,
      priorLength: prior.length,
      blockedReason: opts.guard(prior, prior.length),
    }));
    const out = await call(
      { id: 'WI-7', checkpoint: 'Paused; resume validation later', reason: 'pause' },
      { uiClientId: 'a1', sigVerifiedSpawn: true, workspaceId: 'default' },
    );
    expect(out).toMatchObject({ ok: false, priorLength: 32000, error: 'checkpoint_capacity_exceeded' });
    expect(releaseWorkItem).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('WI-6746: an unreadable item refuses rather than saving under a guessed harness', async () => {
    // park exists to SAVE state, so the worst outcome is a silent loss. With the read
    // swallowed, an unresolvable item fell back to the caller's harness HINT — a different
    // key namespace, which reads back null forever (the EI-8805 loss mode) while still
    // reporting ok. Refusing keeps the text in the caller's hands, where it can be retried.
    getWorkItem.mockRejectedValue(new Error('connection terminated unexpectedly'));
    const ctx = { uiClientId: 'a1', sigVerifiedSpawn: true, workspaceId: 'default', harnessSlug: 'papercup' };
    const out = await call({ id: 'WI-7', checkpoint: 'state I cannot afford to lose', reason: 'redirect' }, ctx);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('work_item_unreadable');
    expect(setWorkItemCheckpointWithPrior).not.toHaveBeenCalled();
    expect(releaseWorkItem).not.toHaveBeenCalled();
    // Must not be reported as a harness-resolution problem — passing { harness } cannot
    // fix an unhealthy database, and following that remedy is what wrote to the wrong key.
    expect(out.error).not.toMatch(/could not resolve a harness/);
  });

  it('persists the checkpoint under a concrete workspace for an ordinary scoped session', async () => {
    const ctx = { uiClientId: 'a1', sigVerifiedSpawn: true, workspaceId: 'default', harnessSlug: 'papercup' };
    const out = await call({ id: 'WI-7', checkpoint: 'did x; left y for continuity', reason: 'redirect' }, ctx);
    expect(setWorkItemCheckpointWithPrior).toHaveBeenCalledWith(
      { harness: 'papercup', workItemId: 'WI-7', workspaceId: 'default' },
      'did x; left y for continuity',
      expect.objectContaining({ transform: expect.any(Function), guard: expect.any(Function) }),
    );
    expect(out).toMatchObject({ ok: true, id: 'WI-7', released: true });
  });

  it('EI-8824: an unscoped superuser session (ctx.workspaceId "*") never persists the literal wildcard', async () => {
    // Same bug class as work_items:checkpoint — a truthy '*' must never win over the
    // concrete-workspace fallback, or the parked checkpoint silently orphans itself
    // from any concrete-workspace read (e.g. the next claim's re-injection).
    const ctx = { uiClientId: 'su-1', sigVerifiedSpawn: true, workspaceId: '*', harnessSlug: 'papercup' };
    await call({ id: 'WI-7', checkpoint: 'did x; left y for continuity', reason: 'redirect' }, ctx);
    expect(setWorkItemCheckpointWithPrior).toHaveBeenCalledWith(
      { harness: 'papercup', workItemId: 'WI-7', workspaceId: 'resolved-concrete-ws' },
      'did x; left y for continuity',
      expect.objectContaining({ transform: expect.any(Function), guard: expect.any(Function) }),
    );
  });

  it('releases the claim and sends a best-effort lifecycle note', async () => {
    const ctx = { uiClientId: 'a1', sigVerifiedSpawn: true, workspaceId: 'default', harnessSlug: 'papercup' };
    await call({ id: 'WI-7', checkpoint: 'did x; left y for continuity', reason: 'higher-priority item' }, ctx);
    expect(releaseWorkItem).toHaveBeenCalledWith('WI-7', {
      harness: 'papercup',
      releasingOwnerId: 'a1',
    });
    expect(sendMessage).toHaveBeenCalled();
  });

  it('a coord note failure never un-parks the item (fail-soft)', async () => {
    sendMessage.mockRejectedValue(new Error('coord down'));
    const ctx = { uiClientId: 'a1', sigVerifiedSpawn: true, workspaceId: 'default', harnessSlug: 'papercup' };
    const out = await call({ id: 'WI-7', checkpoint: 'did x; left y for continuity', reason: 'r' }, ctx);
    expect(out).toMatchObject({ ok: true, released: true, noted: false });
  });
});
