/**
 * consult-backed-parking-2026-10-12 P-005 — set_blocker routes a NEW product-decision
 * blocker through the park door (R-3, R-13). The door itself is unit-tested in
 * consult/park-door.test.ts; this file pins the wiring: refusals write nothing, an
 * accepted park stores consult:<id> as the blocker ref, and a re-assertion skips the door.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getWorkItem = vi.fn();
const mergeWorkItemPayload = vi.fn();
const setWorkItemClaimHold = vi.fn();
const setWorkItemStateWithAliasInfo = vi.fn();
const getModes = vi.fn();
const planItemNeedsHumanContradiction = vi.fn();
const openDecisionReviewPark = vi.fn();
// Partial mock: set_blocker's transitive imports (the hold path, P-010) read real work-items
// exports such as ISSUE_FAMILY_KINDS, so only the row accessors are replaced.
vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../work-items')>()),
  getWorkItem: (...args: unknown[]) => getWorkItem(...args),
  mergeWorkItemPayload: (...args: unknown[]) => mergeWorkItemPayload(...args),
  setWorkItemClaimHold: (...args: unknown[]) => setWorkItemClaimHold(...args),
  setWorkItemStateWithAliasInfo: (...args: unknown[]) => setWorkItemStateWithAliasInfo(...args),
}));
vi.mock('./work-item-ref-blocker-edges', () => ({ linkWorkItemRefDependencies: vi.fn() }));
vi.mock('../../modes/store', () => ({ getModes: (...args: unknown[]) => getModes(...args) }));
vi.mock('../../scheduler/plan-item-lane-guard', () => ({
  planItemNeedsHumanContradiction: (...args: unknown[]) => planItemNeedsHumanContradiction(...args),
}));
vi.mock('../../consult/park-door', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../consult/park-door')>();
  return {
    ...real,
    openDecisionReviewPark: (...args: unknown[]) => openDecisionReviewPark(...args),
    makeProdParkDoorDeps: () => ({}),
  };
});

import tool from './set_blocker';

const ctxBase = { uiClientId: 'su-a', isSuperuser: true, workspaceId: 'default' };
const ctx = ctxBase as never;
const parse = (value: unknown) => (tool.args as { parse: (v: unknown) => unknown }).parse(value);
async function one(value: unknown, context: unknown = ctx) {
  const result = (await tool.handler(parse(value) as never, context as never)) as { data: { results: unknown[] } };
  return result.data.results[0] as Record<string, any>;
}

const decideBy = new Date(Date.now() + 60 * 60_000).toISOString();
const parkArgs = {
  id: 'WI-1',
  kind: 'human',
  capability: 'product-decision',
  ref: 'decision:layout',
  summary: 'Ship the compact layout as the default?',
  nextVerb: 'consult:reply on the decision-review consult',
  defaultIfUnanswered: 'ship compact as default',
  decideBy,
};
const opened = {
  consultId: 'conv-1',
  blockerRef: 'consult:conv-1',
  verdictEvent: 'consult:park-verdict:conv-1',
  deadlineAt: decideBy,
  defaultAction: 'ship compact as default',
  ownerAuthorityTopic: null,
  wakeRegistered: true,
  ownerNotified: true,
  evidence: 'park opened decision-review consult conv-1; caller ref: decision:layout',
};

beforeEach(() => {
  vi.clearAllMocks();
  const item = { id: 'WI-1', family: 'issue', kind: 'bug', state: 'open', harness: 'papercup', payload: {} };
  getWorkItem.mockResolvedValue(item);
  mergeWorkItemPayload.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
    ...item,
    payload: { ...item.payload, ...patch },
  }));
  setWorkItemStateWithAliasInfo.mockResolvedValue({
    workItem: { ...item, state: 'needs-human' },
    aliased: false,
    requestedState: 'needs-human',
    appliedState: 'needs-human',
  });
  setWorkItemClaimHold.mockResolvedValue({ applicable: true, held: false });
  getModes.mockResolvedValue([]);
  planItemNeedsHumanContradiction.mockResolvedValue(null);
  openDecisionReviewPark.mockResolvedValue({ ok: true, park: opened });
});

describe('work_items:set_blocker — product-decision park door wiring', () => {
  it('opens a park for a new product-decision blocker and stores consult:<id> as its ref', async () => {
    const out = await one(parkArgs);
    expect(out.ok).toBe(true);
    expect(openDecisionReviewPark).toHaveBeenCalledTimes(1);
    expect(openDecisionReviewPark.mock.calls[0]![0]).toMatchObject({
      workItemId: 'WI-1',
      setterId: 'su-a',
      question: 'Ship the compact layout as the default?',
      defaultIfUnanswered: 'ship compact as default',
      decideBy,
      callerRef: 'decision:layout',
    });
    const written = JSON.stringify(mergeWorkItemPayload.mock.calls);
    expect(written).toContain('consult:conv-1');
    expect(out.park).toMatchObject({ consultId: 'conv-1', blockerRef: 'consult:conv-1' });
  });

  it('replays the same transport key to one consult identity and one active blocker', async () => {
    const key = 'mcp-retry-1';
    const consults = new Map<string, typeof opened>();
    let consultCreations = 0;
    openDecisionReviewPark.mockImplementation(async (request: { requestKey?: string }) => {
      const requestKey = request.requestKey ?? '';
      let park = consults.get(requestKey);
      if (!park) {
        consultCreations += 1;
        park = { ...opened, consultId: `conv-${consultCreations}`, blockerRef: `consult:conv-${consultCreations}` };
        consults.set(requestKey, park);
      }
      return { ok: true, park };
    });

    const first = await one(parkArgs, { ...ctxBase, idempotencyKey: key });
    const firstBlockers = first.activeBlockers as Array<Record<string, unknown>>;
    expect(firstBlockers).toHaveLength(1);

    const item = { id: 'WI-1', family: 'issue', kind: 'bug', state: 'needs-human', harness: 'papercup' };
    getWorkItem.mockReset().mockResolvedValue({
      ...item,
      payload: { externalBlockers: firstBlockers },
    });
    const replay = await one(parkArgs, { ...ctxBase, idempotencyKey: key });

    expect(openDecisionReviewPark).toHaveBeenCalledTimes(2);
    const firstRequestKey = openDecisionReviewPark.mock.calls[0]![0].requestKey;
    const replayRequestKey = openDecisionReviewPark.mock.calls[1]![0].requestKey;
    expect(firstRequestKey).toBe(replayRequestKey);
    expect(firstRequestKey).toContain(key);
    expect(consultCreations).toBe(1);
    expect(replay.activeBlockers).toHaveLength(1);
    expect(replay.activeBlockers[0]).toMatchObject({ ref: firstBlockers[0]!.ref, status: 'active' });
  });

  it('returns the door refusal and writes nothing', async () => {
    openDecisionReviewPark.mockResolvedValue({ ok: false, code: 'park_deadline_required', error: 'needs decideBy. Blocker was not written.' });
    const out = await one({ ...parkArgs, decideBy: undefined });
    expect(out).toMatchObject({ ok: false, id: 'WI-1', code: 'park_deadline_required' });
    expect(mergeWorkItemPayload).not.toHaveBeenCalled();
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('returns park_consult_failed and writes nothing when the consult cannot open', async () => {
    openDecisionReviewPark.mockResolvedValue({ ok: false, code: 'park_consult_failed', error: 'consult down. Blocker was not written.' });
    const out = await one(parkArgs);
    expect(out).toMatchObject({ ok: false, code: 'park_consult_failed' });
    expect(mergeWorkItemPayload).not.toHaveBeenCalled();
  });

  it('refuses defaultAction on a park before opening anything', async () => {
    const out = await one({ ...parkArgs, defaultAction: 'stay_parked' });
    expect(out).toMatchObject({ ok: false, code: 'park_default_action_unsupported' });
    expect(openDecisionReviewPark).not.toHaveBeenCalled();
    expect(mergeWorkItemPayload).not.toHaveBeenCalled();
  });

  it('does not open a second park when the ref is already an active product-decision blocker', async () => {
    const active = {
      kind: 'human',
      capability: 'product-decision',
      ref: 'consult:conv-1',
      summary: 'Ship the compact layout as the default?',
      nextVerb: 'consult:reply on the decision-review consult',
      defaultIfUnanswered: 'ship compact as default',
      decideBy,
      status: 'active',
      createdAt: '2026-10-13T00:00:00.000Z',
      createdBy: 'su-a',
      updatedAt: '2026-10-13T00:00:00.000Z',
    };
    getWorkItem.mockResolvedValue({
      id: 'WI-1', family: 'issue', kind: 'bug', state: 'needs-human', harness: 'papercup',
      payload: { externalBlockers: [active] },
    });
    await one({ ...parkArgs, ref: 'consult:conv-1' });
    expect(openDecisionReviewPark).not.toHaveBeenCalled();
  });

  it('does not route other human capabilities through the park door', async () => {
    await one({
      ...parkArgs,
      capability: 'credential',
      ref: 'credential:prod-db',
      nextVerb: 'setup:save_key',
      decideBy: undefined,
    });
    expect(openDecisionReviewPark).not.toHaveBeenCalled();
  });
});
