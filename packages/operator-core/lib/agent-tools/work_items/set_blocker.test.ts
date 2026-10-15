import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const getWorkItem = vi.fn();
const mergeWorkItemPayload = vi.fn();
const setWorkItemClaimHold = vi.fn();
const setWorkItemStateWithAliasInfo = vi.fn();
const getModes = vi.fn();
const planItemNeedsHumanContradiction = vi.fn();
const ownerAskRun = vi.fn();
const makeCoordOpContext = vi.fn();
const parkConsult = vi.fn();
const parkWake = vi.fn();
const parkNotify = vi.fn();
vi.mock('../../consult/park-door', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../consult/park-door')>();
  return {
    ...actual,
    makeProdParkDoorDeps: () => ({
      now: () => Date.now(),
      openConsult: (...args: unknown[]) => parkConsult(...args),
      registerVerdictWake: (...args: unknown[]) => parkWake(...args),
      notifyOwner: (...args: unknown[]) => parkNotify(...args),
    }),
  };
});
vi.mock('../../work-items', () => ({
  getWorkItem: (...args: unknown[]) => getWorkItem(...args),
  mergeWorkItemPayload: (...args: unknown[]) => mergeWorkItemPayload(...args),
  setWorkItemClaimHold: (...args: unknown[]) => setWorkItemClaimHold(...args),
  setWorkItemStateWithAliasInfo: (...args: unknown[]) => setWorkItemStateWithAliasInfo(...args),
}));
const linkWorkItemRefDependencies = vi.fn();
vi.mock('./work-item-ref-blocker-edges', () => ({
  linkWorkItemRefDependencies: (...args: unknown[]) => linkWorkItemRefDependencies(...args),
}));
vi.mock('../../modes/store', () => ({
  getModes: (...args: unknown[]) => getModes(...args),
}));
vi.mock('../../scheduler/plan-item-lane-guard', () => ({
  planItemNeedsHumanContradiction: (...args: unknown[]) => planItemNeedsHumanContradiction(...args),
}));
vi.mock('../../coord-ops/ops/compose', () => ({
  askOp: { run: (...args: unknown[]) => ownerAskRun(...args) },
}));
vi.mock('../../coord-ops/prod-caps', () => ({
  buildCoordOpCtx: (...args: unknown[]) => makeCoordOpContext(...args),
}));

import tool, { ownerActionFlagsReleasedByClear } from './set_blocker';
import { activeExternalBlockers } from '../../external-blockers';
import { BUDGET, promptWeight } from '../tool-guidance-budget';

const ctx = { uiClientId: 'su-a', isSuperuser: true, workspaceId: 'default' } as never;
const parse = (value: unknown) => (tool.args as { parse: (v: unknown) => unknown }).parse(value);
async function one(value: unknown) {
  const result = (await tool.handler(parse(value) as never, ctx)) as { data: { results: unknown[] } };
  return result.data.results[0] as Record<string, any>;
}

beforeEach(() => {
  vi.clearAllMocks();
  setWorkItemStateWithAliasInfo.mockResolvedValue({
    workItem: { id: 'WI-1', state: 'open' },
    aliased: true,
    requestedState: 'blocked',
    appliedState: 'open',
  });
  setWorkItemClaimHold.mockResolvedValue({ applicable: true, held: false });
  getModes.mockResolvedValue([]);
  planItemNeedsHumanContradiction.mockResolvedValue(null);
  ownerAskRun.mockResolvedValue({ conversation_id: 'owner-ask-direct', answered: false, answer: null });
  makeCoordOpContext.mockReturnValue({ coordOpContext: true });
  parkConsult.mockResolvedValue({ consultId: 'conv-r13' });
  parkWake.mockResolvedValue(undefined);
  parkNotify.mockResolvedValue(undefined);
});

describe('work_items:set_blocker', () => {
  it('stays within the shared prompt-weight budget', () => {
    expect(promptWeight(tool as Parameters<typeof promptWeight>[0])).toBeLessThanOrEqual(BUDGET);
  });

  it.each(['defaultIfUnanswered', 'decideBy'] as const)(
    'R-3 refuses a product-decision park missing %s before opening or persisting anything',
    async (missingField) => {
      getWorkItem.mockResolvedValue({ id: 'WI-1', family: 'issue', state: 'open', payload: {} });
      const request = {
        id: 'WI-1', kind: 'human', capability: 'product-decision', ref: 'decision:layout',
        summary: 'Ship the compact layout as the default?', nextVerb: 'consult:reply',
        defaultIfUnanswered: 'ship compact as default',
        decideBy: new Date(Date.now() + 60 * 60_000).toISOString(),
      };

      const out = await one({ ...request, [missingField]: undefined });

      expect(out.ok).toBe(false);
      if (missingField === 'decideBy') expect(out.code).toBe('park_deadline_required');
      else expect(out.error).toMatch(/defaultIfUnanswered/);
      expect(parkConsult).not.toHaveBeenCalled();
      expect(parkWake).not.toHaveBeenCalled();
      expect(parkNotify).not.toHaveBeenCalled();
      expect(ownerAskRun).not.toHaveBeenCalled();
      expect(mergeWorkItemPayload).not.toHaveBeenCalled();
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    },
  );

  it.each(['spend', 'destructive', 'publish', 'security'] as const)(
    'R-14 preserves the %s owner-authority topic at the set_blocker consult boundary',
    async (ownerAuthorityTopic) => {
      const item = { id: 'WI-1', family: 'issue', state: 'open', payload: {} };
      getWorkItem.mockResolvedValue(item);
      mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({ ...item, payload: patch }));

      const out = await one({
        id: item.id, kind: 'human', capability: 'product-decision', ref: 'decision:layout',
        summary: 'Ship the compact layout as the default?', nextVerb: 'consult:reply',
        defaultIfUnanswered: 'ship compact as default',
        decideBy: new Date(Date.now() + 60 * 60_000).toISOString(),
        ownerAuthorityTopic,
      });

      expect(out).toMatchObject({ ok: true, changed: true });
      expect(parkConsult).toHaveBeenCalledOnce();
      expect(parkConsult).toHaveBeenCalledWith(expect.objectContaining({
        cascade: expect.objectContaining({ ownerAuthorityTopic }),
      }));
      expect(out.activeBlockers).toEqual([expect.objectContaining({ ref: 'consult:conv-r13' })]);
      expect(ownerAskRun).not.toHaveBeenCalled();
    },
  );

  it('R-13 opens the decision-review consult and persists its ref before the set_blocker call returns', async () => {
    const item = { id: 'WI-1', family: 'issue', state: 'open', payload: {} };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({ ...item, payload: patch }));
    const deadline = new Date(Date.now() + 60 * 60_000).toISOString();

    const out = await one({
      id: item.id, kind: 'human', capability: 'product-decision', ref: 'decision:layout',
      summary: 'Ship the compact layout as the default?', nextVerb: 'consult:reply',
      defaultIfUnanswered: 'ship compact as default', decideBy: deadline,
    });

    expect(out).toMatchObject({ ok: true, changed: true });
    expect(parkConsult).toHaveBeenCalledOnce();
    expect(parkConsult).toHaveBeenCalledWith(expect.objectContaining({
      originTaskRef: item.id,
      cascade: expect.objectContaining({
        workItemId: item.id, setterId: 'su-a', defaultAction: 'ship compact as default',
        deadlineAt: deadline,
      }),
    }));
    expect(parkWake).toHaveBeenCalledWith(expect.objectContaining({
      subscriberId: 'su-a', eventKey: 'consult:park-verdict:conv-r13',
    }));
    expect(mergeWorkItemPayload).toHaveBeenCalledWith(item.id, expect.objectContaining({
      externalBlockers: [expect.objectContaining({
        ref: 'consult:conv-r13', capability: 'product-decision', status: 'active',
        decideBy: deadline, evidence: expect.stringContaining('conv-r13'),
      })],
    }), expect.anything());
    expect(out.activeBlockers).toEqual([expect.objectContaining({ ref: 'consult:conv-r13' })]);
    expect(parkNotify).toHaveBeenCalledOnce();
    expect(parkNotify).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: item.id,
      summary: expect.stringContaining('FYI (low importance)'),
      body: expect.stringContaining('conv-r13'),
    }));
    expect(ownerAskRun).not.toHaveBeenCalled();
  });

  it('R-13 leaves no blocker when the decision-review consult cannot be opened', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-1', family: 'issue', state: 'open', payload: {} });
    parkConsult.mockRejectedValueOnce(new Error('consult unavailable'));

    const out = await one({
      id: 'WI-1', kind: 'human', capability: 'product-decision', ref: 'decision:layout',
      summary: 'Ship the compact layout as the default?', nextVerb: 'consult:reply',
      defaultIfUnanswered: 'ship compact as default',
      decideBy: new Date(Date.now() + 60 * 60_000).toISOString(),
    });

    expect(out).toMatchObject({ ok: false, code: 'park_consult_failed' });
    expect(mergeWorkItemPayload).not.toHaveBeenCalled();
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    expect(parkWake).not.toHaveBeenCalled();
    expect(parkNotify).not.toHaveBeenCalled();
  });

  it('blocker history CAS refuses a stale clear before any lifecycle change', async () => {
    const raw = [{ kind: 'event', ref: 'event:first', status: 'active', legacy: { retained: true },
      summary: 'Wait for first event', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', createdBy: 'su-a' }];
    expect(activeExternalBlockers({ externalBlockers: raw })).toHaveLength(1);
    getWorkItem.mockResolvedValue({ id: 'WI-1', family: 'issue', state: 'blocked', payload: { externalBlockers: raw } });
    mergeWorkItemPayload.mockResolvedValue(null);
    const out = await one({ id: 'WI-1', kind: 'event', ref: 'event:first', clear: true });
    expect(out).toMatchObject({ ok: false, code: 'blocker_history_conflict' });
    expect(mergeWorkItemPayload).toHaveBeenCalledWith('WI-1', expect.any(Object), expect.objectContaining({ expectedExternalBlockers: raw, requireNonTerminal: false }));
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    expect(setWorkItemClaimHold).not.toHaveBeenCalled();
  });

  it('blocker history CAS migration retains the typed hold after a concurrent history conflict', async () => {
    const raw = [{ kind: 'event', ref: 'work-item:done:WI-99', status: 'active',
      summary: 'Wait for WI-99', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', createdBy: 'su-a' }];
    expect(activeExternalBlockers({ externalBlockers: raw })).toHaveLength(1);
    getWorkItem.mockResolvedValue({ id: 'WI-1', family: 'issue', state: 'blocked', payload: { externalBlockers: raw } });
    linkWorkItemRefDependencies.mockResolvedValue({ ok: true, edges: [{ blocker: 'WI-99' }] });
    mergeWorkItemPayload.mockResolvedValue(null);
    const out = await one({ id: 'WI-1', migrateWorkItemRefs: true });
    expect(out).toMatchObject({ ok: false, code: 'blocker_history_conflict' });
    expect(mergeWorkItemPayload).toHaveBeenCalledWith('WI-1', expect.any(Object), expect.objectContaining({ expectedExternalBlockers: raw }));
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    expect(setWorkItemClaimHold).not.toHaveBeenCalled();
  });

  it('persists an explicit re-check date and rejects invalid dates before any write', async () => {
    const item = { id: 'WI-recheck', family: 'issue', kind: 'bug', state: 'open', harness: 'papercusp', payload: {} };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({ ...item, payload: patch }));
    const input = { id: item.id, kind: 'event', ref: 'event:ready', nextVerb: 'events:await', recheckAt: '2026-10-08T00:00:00Z' };
    expect(() => parse({ ...input, recheckAt: 'tomorrow' })).toThrow();
    expect(mergeWorkItemPayload).not.toHaveBeenCalled();
    const out = await one(input);
    expect(out.activeBlockers[0]).toMatchObject({ ref: 'event:ready', nextVerb: 'events:await', recheckAt: '2026-10-08T00:00:00.000Z' });
  });

  it('opts out of the ambient workspace transaction', () => {
    expect((tool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('publishes conditional blocker requirements in the call constraint and field schema', () => {
    const json = z.toJSONSchema(tool.args as never) as {
      'x-papercusp-call-constraint'?: string;
      properties?: Record<string, { description?: string }>;
      required?: string[];
    };
    const constraint = json['x-papercusp-call-constraint'] ?? '';

    expect(constraint).toContain('strict human owner-capability blocker');
    expect(constraint).toContain('nonblank defaultIfUnanswered');
    expect(constraint).toContain('For items:[...], this applies to each entry');
    expect(constraint).toContain('active human blocker with the same ref');
    expect(constraint).toContain('Clear-only calls and non-human blockers do not require it');
    expect(constraint).toContain('non-final item blocked on main/:3070/green-checkpoint');
    expect(constraint).toContain("literal phrase 'deployed-only'");
    expect(constraint).toContain('what staging/current-build cannot exercise');
    expect(constraint).toContain('concrete reason introduced with because/due to/since');
    for (const field of ['summary', 'evidence']) {
      const description = json.properties?.[field]?.description ?? '';
      expect(description).toContain("'deployed-only'");
      expect(description).toContain('staging/current-build');
      expect(description).toContain('concrete reason');
    }
    // The omission exception depends on persisted state, so this remains optional
    // in the static args schema while discovery publishes the conditional contract.
    expect(json.required ?? []).not.toContain('defaultIfUnanswered');
    expect(
      tool.args.safeParse({
        id: 'WI-1',
        kind: 'human',
        capability: 'credential',
        ref: 'credential:prod-db',
        summary: 'Provide the credential.',
        nextVerb: 'setup:save_key',
      }).success,
    ).toBe(true);
  });

  it('accepts legacy capability-in-kind calls and persists the canonical human blocker', async () => {
    const item = {
      id: 'WI-credential-alias',
      family: 'issue',
      kind: 'bug',
      state: 'open',
      harness: 'papercusp',
      payload: {},
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));
    setWorkItemStateWithAliasInfo.mockResolvedValueOnce({
      workItem: { ...item, state: 'needs-human' },
      aliased: false,
      requestedState: 'needs-human',
      appliedState: 'needs-human',
    });

    const out = await one({
      id: item.id,
      kind: 'credential',
      ref: 'credential:prod-db',
      summary: 'Provide the production DB credential.',
      nextVerb: 'setup:save_key',
      defaultIfUnanswered: 'stays parked; the weekly needs-human digest re-surfaces it',
    });

    expect(out).toMatchObject({
      ok: true,
      workItem: { state: 'needs-human' },
      activeBlockers: [
        expect.objectContaining({
          kind: 'human',
          capability: 'credential',
          ref: 'credential:prod-db',
          status: 'active',
        }),
      ],
    });
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      item.id,
      'needs-human',
      expect.objectContaining({ by: 'su-a' }),
    );
  });

  it('rejects an ambiguous capability shorthand combined with a different capability', () => {
    expect(() =>
      parse({
        id: 'WI-1',
        kind: 'credential',
        capability: 'physical-device',
        ref: 'credential:prod-db',
      }),
    ).toThrow(/shorthand for capability 'credential'.*physical-device/);
  });

  it('requires an explicit trigger kind when live-dependency is the capability', () => {
    expect(() =>
      parse({
        id: 'WI-1',
        kind: 'live-dependency',
        ref: 'deploy:ready:staging',
      }),
    ).toThrow();
    expect(() =>
      parse({
        id: 'WI-1',
        kind: 'event',
        capability: 'live-dependency',
        ref: 'deploy:ready:staging',
      }),
    ).not.toThrow();
  });

  it('persists an event blocker, parks the item, and returns the push-based await key', async () => {
    const item = {
      id: 'WI-1',
      family: 'issue',
      kind: 'bug',
      state: 'open',
      harness: 'papercup',
      payload: { plan_item: { item_id: 'P-008' } },
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));

    const out = await one({
      id: 'WI-1',
      kind: 'event',
      capability: 'live-dependency',
      ref: 'deploy:ready:staging',
      summary: 'wait for deploy',
      nextVerb: 'events:await',
    });
    expect(out.ok).toBe(true);
    expect(out.await).toEqual({ event: 'deploy:ready:staging' });
    expect(out.activeBlockers).toHaveLength(1);
    expect(out.capabilityDisposition).toMatchObject({ capability: 'live-dependency', autoClearable: false });
    expect(mergeWorkItemPayload).toHaveBeenCalledWith(
      'WI-1',
      expect.objectContaining({ externalBlockers: expect.any(Array) }),
      { harness: undefined, expectedExternalBlockers: undefined, requireNonTerminal: true },
    );
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'WI-1',
      'blocked',
      expect.objectContaining({ by: 'su-a' }),
    );
  });

  it('rejects a main/green-checkpoint blocker for ordinary implementation work', async () => {
    const item = {
      id: 'WI-1',
      family: 'issue',
      kind: 'change',
      state: 'open',
      harness: 'papercup',
      title: 'Implement the fact-plane fairness policy',
      summary: 'Run focused tests on staging and continue implementation.',
      payload: {},
    };
    getWorkItem.mockResolvedValue(item);

    const out = await one({
      id: 'WI-1',
      kind: 'gate',
      capability: 'live-dependency',
      ref: 'gate.greenCheckpoint.ownership',
      summary: 'Wait for main to turn green before continuing implementation.',
      nextVerb: 'release:checkpoint-run',
    });

    expect(out).toMatchObject({ ok: false, id: 'WI-1', code: 'non_final_deployed_main_blocker' });
    expect(out.error).toMatch(/Continue implementation.*staging\/current-build/);
    expect(mergeWorkItemPayload).not.toHaveBeenCalled();
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('accepts a gate blocker when release appears only in a branch-configuration reference', async () => {
    const item = {
      id: 'WI-6554700010008778',
      family: 'issue',
      kind: 'bug',
      state: 'open',
      harness: 'papercup',
      title: '[degraded:release-state-read:papercusp-public-site] checkpoint routing',
      summary: 'The public-site checkpoint fallback is routing-misconfigured.',
      payload: {},
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));

    const out = await one({
      id: item.id,
      kind: 'gate',
      capability: 'live-dependency',
      ref: 'papercusp-public-site:integration-equals-release',
      summary: 'Two eligible checkpoint reads fell back while routing was misconfigured.',
      evidence: 'The branch configuration maps routing.misconfigured to integration-equals-release.',
      nextVerb:
        'Have the papercusp-public-site harness owner set a distinct integration branch and verify a fresh checkpoint-state read; then clear this blocker and re-read the degradation window.',
    });

    expect(out).toMatchObject({ ok: true, id: item.id });
    expect(out.activeBlockers).toEqual([
      expect.objectContaining({
        kind: 'gate',
        ref: 'papercusp-public-site:integration-equals-release',
      }),
    ]);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      item.id,
      'blocked',
      expect.objectContaining({ by: 'su-a' }),
    );
  });

  it('ignores release-plane tokens in provenance evidence for an unrelated blocker', async () => {
    const item = {
      id: 'EI-23537178579858762-regression',
      family: 'issue',
      kind: 'bug',
      state: 'open',
      harness: 'papercusp',
      title: 'Record a peer grading dependency.',
      summary: 'Wait for the peer grading pass to finish.',
      payload: {},
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));

    const out = await one({
      id: item.id,
      kind: 'gate',
      capability: 'live-dependency',
      ref: 'scorecards:peer-grading / WI-10001764',
      summary: 'The peer grading pass is still pending.',
      evidence: 'Verified on :3170; deployed :3070 misreports this field.',
      nextVerb: 'events:await',
    });

    expect(out).toMatchObject({ ok: true, id: item.id });
    expect(out.activeBlockers).toEqual([
      expect.objectContaining({
        ref: 'scorecards:peer-grading / WI-10001764',
        evidence: 'Verified on :3170; deployed :3070 misreports this field.',
      }),
    ]);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      item.id,
      'blocked',
      expect.objectContaining({ by: 'su-a' }),
    );
  });

  // EI-24018845641231261: the three calls su-a28f31f2 made at 04:18Z, replayed from
  // tool_invocations. All were refused non_final_deployed_main_blocker with every
  // narrow-exception predicate reported MISSING: the plan slug's `release` word made
  // the decision ref read as a release-plane gate, and the check never read the
  // summary/evidence the refusal told the caller to fill.
  it.each([
    {
      name: 'call 1 (no exception wording)',
      summary:
        'Execution (the VM store reset) is gated on the P-203 verdict (ETA 16:30-17:30Z): the fork is on the Mac VM operator, which hosts the P-203 fold under rig lock 8672858c. dev:own_log_fork_recover is built and verified.',
      evidence: 'D-047 ruling (leader su-07b72cf6, 04:04Z); checkpoint 04:18Z on this EI',
      nextVerb:
        'dev:own_log_fork_recover on the Mac VM operator (dry, then confirm+keyHex), then 15-min verification',
    },
    {
      name: 'call 3 (exception wording in summary + evidence)',
      summary:
        "deployed-only property: the live forked Corestore (own log f417b935) on the Mac VM operator's disk. staging and current-build cannot exercise it because the fork is physical on-disk state of that one deployed host. The reset waits for the P-203 verdict (ETA 16:30-17:30Z) because that VM operator hosts the P-203 fold under rig lock 8672858c (D-047). dev:own_log_fork_recover is built and verified.",
      evidence:
        'deployed-only: the forked store exists only on the Mac VM deployed-host; staging cannot reproduce it because the fork is on-disk state, not code. D-047 ruling from su-07b72cf6 at 04:04Z; VM substrate status at 03:59Z showed forked=true.',
      nextVerb:
        'After the P-203 verdict: dev:own_log_fork_recover on the Mac VM operator (dry, then confirm plus keyHex)',
    },
  ])('records a gate blocker on a release-named plan decision: $name', async ({ summary, evidence, nextVerb }) => {
    const item = {
      id: 'EI-21150671414510762',
      family: 'issue',
      kind: 'bug',
      state: 'open',
      harness: 'papercusp',
      title: '[own-log-fork-guard] own_log_forked: harness=hello-world-3-pot log=f417b935852a',
      summary: 'The rig VM operator own log forked; recover it with dev:own_log_fork_recover.',
      payload: {},
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));

    const out = await one({
      id: item.id,
      ref: 'p2p-public-release-endgame-2026-09-01#D-047',
      kind: 'gate',
      harness: 'papercusp',
      summary,
      evidence,
      nextVerb,
    });

    expect(out).toMatchObject({ ok: true, id: item.id });
    expect(out.activeBlockers).toEqual([
      expect.objectContaining({ ref: 'p2p-public-release-endgame-2026-09-01#D-047', kind: 'gate' }),
    ]);
  });

  it('accepts a genuine deployed-main blocker whose deployed-only exception is written in the summary', async () => {
    const item = {
      id: 'WI-8',
      family: 'issue',
      kind: 'change',
      state: 'open',
      harness: 'papercusp',
      title: 'Verify supervisor restart continuity',
      summary: 'Implementation is done and verified on staging.',
      payload: {},
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({ ...item, payload: { ...item.payload, ...patch } }));

    const out = await one({
      id: item.id,
      kind: 'gate',
      capability: 'live-dependency',
      ref: 'gate.greenCheckpoint.ownership',
      summary:
        'deployed-only property: supervisor restart continuity. staging cannot exercise it because only the deployed-host supervisor restarts the operator.',
      nextVerb: 'wait for main to turn green, then restart the deployed operator',
    });

    expect(out).toMatchObject({ ok: true, id: item.id });
  });

  it('refuses to park source proof when the item also promises final deployed parity', async () => {
    const item = {
      id: 'WI-mixed-parity',
      family: 'issue',
      kind: 'change',
      state: 'wip',
      harness: 'papercusp',
      title: 'Prove regression clauses and deployed runtime parity',
      summary: 'Run regression tests on staging before final deployed parity.',
      payload: {},
    };
    getWorkItem.mockResolvedValue(item);

    const out = await one({
      id: item.id,
      kind: 'gate',
      capability: 'live-dependency',
      ref: 'gate.greenCheckpoint.ownership',
      summary:
        'deployed-only property: final runtime identity. staging cannot exercise it because only the deployed host serves main.',
      nextVerb: 'wait for main deployment before final parity',
    });

    expect(out).toMatchObject({
      ok: false,
      id: item.id,
      code: 'non_final_deployed_main_blocker',
    });
    expect(out.error).toContain('Split the source work');
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('does not let item metadata launder a generic deployed-main blocker', async () => {
    const item = {
      id: 'EI-23090624251629318',
      family: 'issue',
      kind: 'bug',
      state: 'open',
      harness: 'papercusp',
      title: 'work_items:set_blocker rejects generic deployed-parity blocker without deployed-only contract wording',
      summary:
        'A valid gate blocker write was refused by the non-final deployed-main guard because the payload did not explicitly name a deployed-only property, state what staging/current-build cannot exercise, and give a concrete reason. The remediation is to narrow the blocker text.',
      payload: {},
    };
    getWorkItem.mockResolvedValue(item);

    const out = await one({
      id: item.id,
      kind: 'gate',
      capability: 'live-dependency',
      ref: 'gate.greenCheckpoint.ownership',
      summary: 'Wait for main to turn green before continuing implementation.',
      evidence: 'The ordinary implementation still needs the release plane before continuing.',
      nextVerb: 'release:checkpoint-run',
    });

    expect(out).toMatchObject({ ok: false, id: item.id, code: 'non_final_deployed_main_blocker' });
    expect(mergeWorkItemPayload).not.toHaveBeenCalled();
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('allows the actual green-checkpoint repair item to record its gate blocker', async () => {
    const item = {
      id: 'WI-212675',
      family: 'issue',
      kind: 'bug',
      state: 'open',
      harness: 'papercup',
      title: '[gate-red-streak] Re-green current green-checkpoint and restore tested/deployed parity',
      summary: 'Run the scheduled checkpoint and restore release parity.',
      payload: {},
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({ ...item, payload: patch }));

    const out = await one({
      id: 'WI-212675',
      kind: 'gate',
      capability: 'live-dependency',
      ref: 'gate.greenCheckpoint.ownership',
      summary: 'Wait for the scheduled checkpoint verdict.',
      nextVerb: 'release:trace',
    });

    expect(out.ok).toBe(true);
    expect(out.activeBlockers).toHaveLength(1);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'WI-212675',
      'blocked',
      expect.objectContaining({ by: 'su-a' }),
    );
  });

  it('a strict human capability records the ask before entering needs-human', async () => {
    const item = { id: 'WI-1', family: 'issue', kind: 'bug', state: 'open', harness: 'papercup', payload: {} };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({ ...item, payload: patch }));

    const out = await one({
      id: 'WI-1',
      kind: 'human',
      capability: 'credential',
      ref: 'credential:prod-db',
      summary: 'Provide the production DB credential.',
      nextVerb: 'setup:save_key',
      defaultIfUnanswered: 'stays parked; the weekly needs-human digest re-surfaces it',
      decideBy: '2026-10-15T00:00:00Z',
    });

    expect(out.ok).toBe(true);
    expect(out.activeBlockers).toEqual([
      expect.objectContaining({
        defaultIfUnanswered: 'stays parked; the weekly needs-human digest re-surfaces it',
        decideBy: '2026-10-15T00:00:00Z',
      }),
    ]);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'WI-1',
      'needs-human',
      expect.objectContaining({ by: 'su-a' }),
    );
  });

  it('parks a plan-linked item when the plan lane is already needs-human for an external service action', async () => {
    const item = {
      id: 'WI-plan-human',
      family: 'issue',
      kind: 'bug',
      state: 'open',
      harness: 'papercusp',
      payload: { plan_item: { plan_slug: 'owner-plan', item_id: 'P-001' } },
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));
    setWorkItemStateWithAliasInfo.mockResolvedValue({
      workItem: { ...item, state: 'needs-human' },
      aliased: false,
      requestedState: 'needs-human',
      appliedState: 'needs-human',
    });

    const out = await one({
      id: 'WI-plan-human',
      kind: 'human',
      capability: 'external-service-action',
      ref: 'cloudinary:r2-migration',
      summary: 'Have the external service operator enable the migration endpoint.',
      nextVerb: 'work_items:set_blocker { clear: true } after the endpoint is enabled',
      defaultIfUnanswered: 'stays parked until the endpoint is enabled',
    });

    expect(planItemNeedsHumanContradiction).toHaveBeenCalledWith(item);
    expect(out).toMatchObject({
      ok: true,
      id: 'WI-plan-human',
      workItem: { state: 'needs-human' },
      activeBlockers: [
        expect.objectContaining({
          kind: 'human',
          capability: 'external-service-action',
          ref: 'cloudinary:r2-migration',
          status: 'active',
        }),
      ],
    });
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'WI-plan-human',
      'needs-human',
      expect.objectContaining({ by: 'su-a' }),
    );
  });

  it('parks an already-blocked plan-linked item when the plan lane is already needs-human', async () => {
    const item = {
      id: 'WI-plan-human-blocked',
      family: 'issue',
      kind: 'bug',
      state: 'blocked',
      harness: 'papercusp',
      payload: { plan_item: { plan_slug: 'owner-plan', item_id: 'P-001' } },
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));
    setWorkItemStateWithAliasInfo.mockResolvedValue({
      workItem: { ...item, state: 'needs-human' },
      aliased: false,
      requestedState: 'needs-human',
      appliedState: 'needs-human',
    });

    const out = await one({
      id: 'WI-plan-human-blocked',
      kind: 'human',
      capability: 'external-service-action',
      ref: 'cloudinary:r2-migration',
      summary: 'Have the external service operator enable the migration endpoint.',
      nextVerb: 'work_items:set_blocker { clear: true } after the endpoint is enabled',
      defaultIfUnanswered: 'stays parked until the endpoint is enabled',
    });

    expect(planItemNeedsHumanContradiction).toHaveBeenCalledWith(item);
    expect(out).toMatchObject({
      ok: true,
      id: 'WI-plan-human-blocked',
      workItem: { state: 'needs-human' },
      activeBlockers: [
        expect.objectContaining({
          kind: 'human',
          capability: 'external-service-action',
          ref: 'cloudinary:r2-migration',
          status: 'active',
        }),
      ],
    });
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'WI-plan-human-blocked',
      'needs-human',
      expect.objectContaining({ by: 'su-a' }),
    );
  });

  it('refuses a strict human capability without a question and unblock action', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-1', family: 'issue', kind: 'bug', state: 'open', payload: {} });
    const out = await one({ id: 'WI-1', kind: 'human', capability: 'credential', ref: 'credential:prod-db' });
    expect(out).toMatchObject({ ok: false, id: 'WI-1' });
    expect(out.error).toMatch(/structured ask requires both.*summary.*nextVerb/);
    expect(mergeWorkItemPayload).not.toHaveBeenCalled();
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('requires a closed-list human capability instead of parking an untyped engineering defect', async () => {
    getWorkItem.mockResolvedValue({
      id: 'WI-1', family: 'issue', kind: 'bug', title: 'Parser panics on multibyte input',
      summary: 'The parser needs an implementation fix.', state: 'open', payload: {},
    });
    const out = await one({
      id: 'WI-1', kind: 'human', ref: 'parser:multibyte',
      summary: 'Fix the parser panic on multibyte input.', nextVerb: 'edit the parser implementation',
    });
    expect(out).toMatchObject({ ok: false, code: 'human_blocker_capability_required' });
    expect(out.error).toMatch(/explicit closed-list capability.*engineering defect.*remains agent work/s);
    expect(ownerAskRun).not.toHaveBeenCalled();
    expect(mergeWorkItemPayload).not.toHaveBeenCalled();
  });

  it('opens a real coord:ask-owner choice question and stores its conversation id on a direct capability blocker', async () => {
    const item = { id: 'WI-1', family: 'issue', kind: 'bug', state: 'open', payload: {} };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({ ...item, payload: patch }));

    const out = await one({
      id: 'WI-1', kind: 'human', capability: 'credential', ref: 'credential:staging-db',
      summary: 'Can the credential holder provide staging database access?',
      nextVerb: 'configure it through setup:save_key',
      defaultIfUnanswered: 'stays parked and is resurfaced in the weekly owner digest',
    });

    expect(ownerAskRun).toHaveBeenCalledOnce();
    expect(ownerAskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        question: expect.stringContaining('WI-1'),
        body: expect.stringMatching(/Choose one option by number[\s\S]*1\.[\s\S]*2\.[\s\S]*3\.[\s\S]*If you do not answer:/),
        timeout_s: 0,
      }),
      { coordOpContext: true },
    );
    expect(makeCoordOpContext).toHaveBeenCalledWith(expect.objectContaining({
      identity: expect.objectContaining({ ownerId: 'su-a' }),
      callerId: 'su-a',
    }));
    expect(mergeWorkItemPayload).toHaveBeenCalledWith('WI-1', expect.objectContaining({
      externalBlockers: [expect.objectContaining({
        kind: 'human', capability: 'credential', ref: 'credential:staging-db',
        ownerAskConversationId: 'owner-ask-direct',
      })],
    }), expect.anything());
    expect(out).toMatchObject({
      ok: true,
      ownerAsk: { conversationId: 'owner-ask-direct', options: expect.arrayContaining([
        expect.stringContaining('approved secret/configuration surface'),
      ]) },
      activeBlockers: [expect.objectContaining({ ownerAskConversationId: 'owner-ask-direct' })],
    });
  });

  it('does not open duplicate owner questions when the same direct capability blocker is reasserted', async () => {
    const existing = {
      kind: 'human', capability: 'physical-device', capabilitySource: 'explicit',
      ref: 'device:lab-phone', summary: 'Can someone complete the phone pairing step?',
      nextVerb: 'pair the lab phone', defaultIfUnanswered: 'stays parked',
      ownerAskConversationId: 'owner-ask-existing', status: 'active',
      createdAt: '2026-10-01T08:00:00.000Z', createdBy: 'su-a', updatedAt: '2026-10-01T08:00:00.000Z',
    };
    const item = { id: 'WI-1', family: 'issue', kind: 'bug', state: 'needs-human', payload: { externalBlockers: [existing] } };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({ ...item, payload: patch }));

    const out = await one({
      id: 'WI-1', kind: 'human', capability: 'physical-device', ref: 'device:lab-phone',
      summary: existing.summary, nextVerb: existing.nextVerb,
    });

    expect(ownerAskRun).not.toHaveBeenCalled();
    expect(out.ownerAsk).toMatchObject({ conversationId: 'owner-ask-existing' });
    expect(mergeWorkItemPayload).toHaveBeenCalledWith('WI-1', expect.objectContaining({
      externalBlockers: [expect.objectContaining({ ownerAskConversationId: 'owner-ask-existing' })],
    }), expect.anything());
  });

  it('refuses to persist a direct capability blocker if coord:ask-owner cannot open the question', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-1', family: 'issue', kind: 'bug', state: 'open', payload: {} });
    ownerAskRun.mockRejectedValueOnce(new Error('conversation service unavailable'));

    const out = await one({
      id: 'WI-1', kind: 'human', capability: 'external-service-action', ref: 'service:enable-endpoint',
      summary: 'Can the service operator enable this endpoint?',
      nextVerb: 'enable the endpoint in the service console',
      defaultIfUnanswered: 'stays parked',
    });

    expect(out).toMatchObject({ ok: false, code: 'owner_ask_failed' });
    expect(out.error).toMatch(/coord:ask-owner could not be opened.*Blocker was not written/s);
    expect(mergeWorkItemPayload).not.toHaveBeenCalled();
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  // Owner-attention ledger (EI-23783029010995961): an owner ask must state what happens if it is never answered.
  it('refuses a strict human ask that declares no defaultIfUnanswered, and writes nothing', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-1', family: 'issue', kind: 'bug', state: 'open', payload: {} });
    const out = await one({
      id: 'WI-1',
      kind: 'human',
      capability: 'product-decision',
      ref: 'decision:pricing',
      summary: 'Pick the pricing tier to ship.',
      nextVerb: 'work_items:set_blocker { clear: true } after the owner picks',
    });
    expect(out).toMatchObject({ ok: false, id: 'WI-1' });
    expect(out.error).toMatch(/defaultIfUnanswered.*what the system will do if the owner never answers/s);
    expect(mergeWorkItemPayload).not.toHaveBeenCalled();
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('refuses a blank defaultIfUnanswered — whitespace is not a stated outcome', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-1', family: 'issue', kind: 'bug', state: 'open', payload: {} });
    const out = await one({
      id: 'WI-1',
      kind: 'human',
      capability: 'credential',
      ref: 'credential:prod-db',
      summary: 'Provide the production DB credential.',
      nextVerb: 'setup:save_key',
      defaultIfUnanswered: '   ',
    });
    expect(out).toMatchObject({ ok: false, id: 'WI-1' });
    expect(mergeWorkItemPayload).not.toHaveBeenCalled();
  });

  it('lets a re-assert of an existing ask omit the default the record already carries', async () => {
    const existing = {
      kind: 'human',
      capability: 'credential',
      capabilitySource: 'explicit',
      ref: 'credential:prod-db',
      summary: 'Provide the production DB credential.',
      nextVerb: 'setup:save_key',
      defaultIfUnanswered: 'stays parked; the weekly needs-human digest re-surfaces it',
      status: 'active',
      createdAt: '2026-10-01T08:00:00.000Z',
      createdBy: 'su-a',
      updatedAt: '2026-10-01T08:00:00.000Z',
    };
    const item = {
      id: 'WI-1',
      family: 'issue',
      kind: 'bug',
      state: 'needs-human',
      harness: 'papercup',
      payload: { externalBlockers: [existing] },
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({ ...item, payload: patch }));
    setWorkItemStateWithAliasInfo.mockResolvedValue({
      workItem: { ...item, state: 'needs-human' },
      aliased: false,
      requestedState: 'needs-human',
      appliedState: 'needs-human',
    });

    const out = await one({
      id: 'WI-1',
      kind: 'human',
      capability: 'credential',
      ref: 'credential:prod-db',
      summary: 'Provide the production DB credential (tightened wording).',
      nextVerb: 'setup:save_key',
    });
    expect(out.ok).toBe(true);
    expect(out.activeBlockers).toEqual([
      expect.objectContaining({
        defaultIfUnanswered: 'stays parked; the weekly needs-human digest re-surfaces it',
      }),
    ]);
  });

  it('refuses an unparseable decideBy before writing the blocker', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-1', family: 'issue', kind: 'bug', state: 'open', payload: {} });
    const out = await one({
      id: 'WI-1',
      kind: 'human',
      capability: 'credential',
      ref: 'credential:prod-db',
      summary: 'Provide the production DB credential.',
      nextVerb: 'setup:save_key',
      defaultIfUnanswered: 'stays parked',
      decideBy: 'next tuesday-ish',
    });
    expect(out).toMatchObject({ ok: false, id: 'WI-1' });
    expect(out.error).toMatch(/decideBy.*not a parseable ISO timestamp/);
    expect(mergeWorkItemPayload).not.toHaveBeenCalled();
  });

  it('does not demand a default for non-human blockers', async () => {
    const item = { id: 'WI-1', family: 'issue', kind: 'bug', state: 'open', harness: 'papercup', payload: {} };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({ ...item, payload: patch }));
    const out = await one({ id: 'WI-1', kind: 'event', ref: 'release:green', summary: 'wait for green' });
    expect(out.ok).toBe(true);
    expect(out.activeBlockers).toEqual([expect.objectContaining({ kind: 'event', ref: 'release:green' })]);
  });

  it('accepts a clear-only request and infers the sole active blocker kind', async () => {
    const blocker = {
      kind: 'runtime',
      ref: 'dolphin:dbus',
      summary: 'runtime unavailable',
      status: 'active',
      createdAt: '2026-07-13T08:00:00.000Z',
      createdBy: 'su-a',
      updatedAt: '2026-07-13T08:00:00.000Z',
    };
    const item = {
      id: 'WI-1',
      family: 'issue',
      kind: 'bug',
      state: 'open',
      harness: 'papercup',
      payload: { externalBlockers: [blocker] },
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));

    const out = await one({
      id: 'WI-1',
      ref: 'dolphin:dbus',
      clear: true,
      evidence: 'DBus responsive',
    });

    expect(out.ok).toBe(true);
    expect(out.changed).toBe(true);
    expect(out.activeBlockers).toEqual([]);
    expect(out.blockerHistory[0]).toMatchObject({ status: 'cleared', evidence: 'DBus responsive' });
    expect(setWorkItemClaimHold).toHaveBeenCalledWith(
      'WI-1',
      false,
      expect.objectContaining({ reason: expect.stringContaining('runtime:dolphin:dbus cleared') }),
    );
  });

  it('accepts an id-only clear when the item has one active blocker', async () => {
    const blocker = {
      kind: 'runtime',
      ref: 'dolphin:dbus',
      summary: 'runtime unavailable',
      status: 'active',
      createdAt: '2026-07-13T08:00:00.000Z',
      createdBy: 'su-a',
      updatedAt: '2026-07-13T08:00:00.000Z',
    };
    const item = {
      id: 'WI-1',
      family: 'issue',
      kind: 'bug',
      state: 'open',
      harness: 'papercup',
      payload: { externalBlockers: [blocker] },
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));

    const out = await one({ id: 'WI-1', clear: true, evidence: 'DBus responsive' });

    expect(out).toMatchObject({ ok: true, changed: true, activeBlockers: [] });
    expect(out.blockerHistory[0]).toMatchObject({ ref: 'dolphin:dbus', status: 'cleared', evidence: 'DBus responsive' });
    expect(setWorkItemClaimHold).toHaveBeenCalledWith(
      'WI-1',
      false,
      expect.objectContaining({ reason: expect.stringContaining('runtime:dolphin:dbus cleared') }),
    );
  });

  it('requires kind for a set request but accepts kind-less clear-only bulk entries', () => {
    expect(() => parse({ id: 'WI-1', ref: 'dolphin:dbus' })).toThrow(/kind is required/);
    expect(() => parse({ items: [{ id: 'WI-1', ref: 'dolphin:dbus' }] })).toThrow(/kind is required/);
    expect(() => parse({ id: 'WI-1', clear: true })).not.toThrow();
    expect(() => parse({ items: [{ id: 'WI-1', clear: true }] })).not.toThrow();
    expect(() => parse({ id: 'WI-1', ref: 'dolphin:dbus', clear: true })).not.toThrow();
    expect(() => parse({ items: [{ id: 'WI-1', ref: 'dolphin:dbus', clear: true }] })).not.toThrow();
  });

  it('refuses an id-only clear when multiple active blockers match', async () => {
    const blocker = (kind: 'runtime' | 'event', ref: string) => ({
      kind,
      ref,
      summary: `${kind} blocker`,
      status: 'active',
      createdAt: '2026-07-13T08:00:00.000Z',
      createdBy: 'su-a',
      updatedAt: '2026-07-13T08:00:00.000Z',
    });
    getWorkItem.mockResolvedValue({
      id: 'WI-1',
      family: 'issue',
      kind: 'bug',
      state: 'blocked',
      payload: { externalBlockers: [blocker('runtime', 'dbus'), blocker('event', 'deploy:ready')] },
    });

    const out = await one({ id: 'WI-1', clear: true });

    expect(out).toMatchObject({ ok: false, id: 'WI-1' });
    expect(out.error).toMatch(/omitted ref.*matches 2 active blockers.*pass ref explicitly/);
    expect(mergeWorkItemPayload).not.toHaveBeenCalled();
    expect(setWorkItemClaimHold).not.toHaveBeenCalled();
  });

  it('refuses a clear-only request when the ref is active under multiple kinds', async () => {
    const blocker = (kind: 'runtime' | 'event') => ({
      kind,
      ref: 'shared-ref',
      summary: `${kind} blocker`,
      status: 'active',
      createdAt: '2026-07-13T08:00:00.000Z',
      createdBy: 'su-a',
      updatedAt: '2026-07-13T08:00:00.000Z',
    });
    getWorkItem.mockResolvedValue({
      id: 'WI-1',
      family: 'issue',
      kind: 'bug',
      state: 'open',
      payload: { externalBlockers: [blocker('runtime'), blocker('event')] },
    });

    const out = await one({ id: 'WI-1', ref: 'shared-ref', clear: true });

    expect(out).toMatchObject({ ok: false, id: 'WI-1' });
    expect(out.error).toMatch(/ambiguous.*runtime.*event.*pass kind explicitly/);
    expect(mergeWorkItemPayload).not.toHaveBeenCalled();
    expect(setWorkItemClaimHold).not.toHaveBeenCalled();
  });

  it('rejects a plan contradiction before writing any blocker payload', async () => {
    const item = {
      id: 'WI-1',
      family: 'issue',
      kind: 'bug',
      state: 'open',
      harness: 'papercup',
      payload: { plan_item: { plan_slug: 'agent-plan', item_id: 'P-001' } },
    };
    getWorkItem.mockResolvedValue(item);
    planItemNeedsHumanContradiction.mockResolvedValue({
      reason: 'linked plan item agent-plan#P-001 explicitly remains agent-actionable (needsHuman=false)',
      planSlug: 'agent-plan',
      itemIds: ['P-001'],
    });

    const out = await one({
      id: 'WI-1',
      kind: 'human',
      capability: 'credential',
      ref: 'credential:prod-db',
      summary: 'Provide the production DB credential.',
      nextVerb: 'setup:save_key',
      defaultIfUnanswered: 'stays parked; the weekly needs-human digest re-surfaces it',
    });

    expect(out).toMatchObject({ ok: false, id: 'WI-1' });
    expect(out.error).toMatch(/agent-actionable.*no blocker was written/);
    expect(mergeWorkItemPayload).not.toHaveBeenCalled();
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('clears the last blocker, retains history, and removes the issue claim hold', async () => {
    const blocker = {
      kind: 'runtime',
      ref: 'dolphin:dbus',
      summary: 'runtime unavailable',
      status: 'active',
      createdAt: '2026-07-13T08:00:00.000Z',
      createdBy: 'su-a',
      updatedAt: '2026-07-13T08:00:00.000Z',
    };
    const item = {
      id: 'WI-1',
      family: 'issue',
      kind: 'bug',
      state: 'open',
      harness: 'papercup',
      payload: { externalBlockers: [blocker] },
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));

    const out = await one({
      id: 'WI-1',
      kind: 'runtime',
      ref: 'dolphin:dbus',
      clear: true,
      evidence: 'DBus responsive',
    });
    expect(out.ok).toBe(true);
    expect(out.activeBlockers).toEqual([]);
    expect(out.blockerHistory[0]).toMatchObject({ status: 'cleared', evidence: 'DBus responsive' });
    expect(setWorkItemClaimHold).toHaveBeenCalledWith(
      'WI-1',
      false,
      expect.objectContaining({ reason: expect.stringContaining('runtime:dolphin:dbus cleared') }),
    );
  });

  it('WI-10005104: clearing the last strict human ask on an issue-family needs-human item reopens it', async () => {
    const blocker = {
      kind: 'human',
      capability: 'product-decision',
      ref: 'epoch-policy',
      summary: 'Choose the epoch policy.',
      nextVerb: 'work_items:set_blocker { clear: true }',
      status: 'active',
      createdAt: '2026-09-05T00:00:00.000Z',
      createdBy: 'su-a',
      updatedAt: '2026-09-05T00:00:00.000Z',
    };
    const item = {
      id: 'WI-1',
      family: 'issue',
      kind: 'bug',
      state: 'needs-human',
      harness: 'papercup',
      payload: { externalBlockers: [blocker] },
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));
    setWorkItemStateWithAliasInfo.mockResolvedValue({
      workItem: { ...item, state: 'open' },
      aliased: false,
      requestedState: 'open',
      appliedState: 'open',
    });

    const out = await one({ id: 'WI-1', kind: 'human', ref: 'epoch-policy', clear: true, evidence: 'decided' });

    expect(out.ok).toBe(true);
    expect(out.activeBlockers).toEqual([]);
    // setWorkItemClaimHold(false) never changes status, so without the backstop the item
    // stayed `needs-human` with zero blockers — unclaimable AND unexplained.
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith('WI-1', 'open', expect.objectContaining({ by: 'su-a' }));
    expect(out.workItem.state).toBe('open');
  });

  describe('WI-10008173: owner-action flags are released with the last human blocker', () => {
    const humanBlocker = (ref: string) => ({
      kind: 'human',
      capability: 'product-decision',
      ref,
      summary: `Decide ${ref}.`,
      nextVerb: 'work_items:set_blocker { clear: true }',
      status: 'active',
      createdAt: '2026-09-05T00:00:00.000Z',
      createdBy: 'su-a',
      updatedAt: '2026-09-05T00:00:00.000Z',
    });
    const issue = (payload: Record<string, unknown>) => ({
      id: 'WI-1',
      family: 'issue',
      kind: 'bug',
      state: 'needs-human',
      harness: 'papercup',
      payload,
    });
    const mergeOpts = () => mergeWorkItemPayload.mock.calls[0]?.[2] as { unset?: string[] } | undefined;

    it('unsets needsOwnerAction and needsHuman in the same CAS write when the last human blocker clears', async () => {
      const item = issue({ externalBlockers: [humanBlocker('epoch-policy')], needsOwnerAction: true, needsHuman: true });
      getWorkItem.mockResolvedValue(item);
      mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({ ...item, payload: { ...item.payload, ...patch } }));

      const out = await one({ id: 'WI-1', kind: 'human', ref: 'epoch-policy', clear: true, evidence: 'decided' });

      expect(out.ok).toBe(true);
      expect(mergeWorkItemPayload).toHaveBeenCalledTimes(1);
      expect(mergeOpts()?.unset).toEqual(['needsOwnerAction', 'needsHuman']);
    });

    it('keeps the owner flag while another human blocker is still active', async () => {
      const item = issue({ externalBlockers: [humanBlocker('epoch-policy'), humanBlocker('retention-policy')], needsOwnerAction: true });
      getWorkItem.mockResolvedValue(item);
      mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({ ...item, payload: { ...item.payload, ...patch } }));

      const out = await one({ id: 'WI-1', kind: 'human', ref: 'epoch-policy', clear: true, evidence: 'decided' });

      expect(out.ok).toBe(true);
      expect(out.activeBlockers).toHaveLength(1);
      expect(mergeOpts()?.unset).toBeUndefined();
    });

    it('does not drop an owner flag when the cleared blocker is not human-kind', async () => {
      const runtime = { ...humanBlocker('dolphin:dbus'), kind: 'runtime', capability: 'live-dependency' };
      const item = issue({ externalBlockers: [runtime], needsOwnerAction: true });
      getWorkItem.mockResolvedValue(item);
      mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({ ...item, payload: { ...item.payload, ...patch } }));

      const out = await one({ id: 'WI-1', kind: 'runtime', ref: 'dolphin:dbus', clear: true, evidence: 'DBus responsive' });

      expect(out.ok).toBe(true);
      expect(mergeOpts()?.unset).toBeUndefined();
    });

    it('ownerActionFlagsReleasedByClear releases only flags that are set, and only on a human clear', () => {
      expect(ownerActionFlagsReleasedByClear({ needsOwnerAction: true }, [], { kind: 'human', cleared: true })).toEqual(['needsOwnerAction']);
      expect(ownerActionFlagsReleasedByClear({}, [], { kind: 'human', cleared: true })).toEqual([]);
      expect(ownerActionFlagsReleasedByClear({ needsOwnerAction: true }, [], { kind: 'human', cleared: false })).toEqual([]);
      expect(ownerActionFlagsReleasedByClear({ needsOwnerAction: true }, [], { kind: 'event', cleared: true })).toEqual([]);
      expect(ownerActionFlagsReleasedByClear({ needsOwnerAction: true }, [{ kind: 'human' }], { kind: 'human', cleared: true })).toEqual([]);
      expect(ownerActionFlagsReleasedByClear(null, [], { kind: 'human', cleared: true })).toEqual([]);
    });
  });

  it('WI-10005104: a FEATURE-family needs-human item is NOT reopened by the issue backstop (plan lane owns it)', async () => {
    const blocker = {
      kind: 'human',
      capability: 'product-decision',
      ref: 'epoch-policy',
      summary: 'Choose the epoch policy.',
      nextVerb: 'work_items:set_blocker { clear: true }',
      status: 'active',
      createdAt: '2026-09-05T00:00:00.000Z',
      createdBy: 'su-a',
      updatedAt: '2026-09-05T00:00:00.000Z',
    };
    const item = {
      id: 'WI-1',
      family: 'feature',
      kind: 'feature',
      state: 'needs-human',
      harness: 'papercup',
      payload: { externalBlockers: [blocker] },
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));

    const out = await one({ id: 'WI-1', kind: 'human', ref: 'epoch-policy', clear: true, evidence: 'decided' });

    expect(out.ok).toBe(true);
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    expect(out.workItem.state).toBe('needs-human');
  });

  it('keeps an issue in needs-human when a partial clear leaves a strict owner-capability blocker', async () => {
    const decisionBlocker = {
      kind: 'human',
      capability: 'product-decision',
      ref: 'epoch-policy',
      summary: 'Choose the epoch policy.',
      status: 'active',
      createdAt: '2026-09-05T00:00:00.000Z',
      createdBy: 'su-a',
      updatedAt: '2026-09-05T00:00:00.000Z',
    };
    const deviceBlocker = {
      kind: 'human',
      capability: 'physical-device',
      ref: 'peer-vm',
      summary: 'Inspect the peer VM.',
      // D-029: the surviving ask stays needs-human only because it is answerable.
      nextVerb: 'Inspect the peer VM, then clear peer-vm.',
      defaultIfUnanswered: 'stays parked; the weekly owner digest re-surfaces it',
      status: 'active',
      createdAt: '2026-09-05T00:00:00.000Z',
      createdBy: 'su-a',
      updatedAt: '2026-09-05T00:00:00.000Z',
    };
    const item = {
      id: 'WI-1',
      family: 'issue',
      kind: 'bug',
      state: 'needs-human',
      harness: 'papercup',
      payload: { externalBlockers: [decisionBlocker, deviceBlocker] },
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));
    setWorkItemStateWithAliasInfo.mockResolvedValue({
      workItem: { ...item, state: 'needs-human' },
      aliased: false,
      requestedState: 'needs-human',
      appliedState: 'needs-human',
    });

    const out = await one({
      id: 'WI-1',
      kind: 'human',
      ref: 'epoch-policy',
      clear: true,
      evidence: 'The policy decision is now recorded.',
    });

    expect(out.ok).toBe(true);
    expect(out.activeBlockers).toEqual([
      expect.objectContaining({ status: 'active', capability: 'physical-device', ref: 'peer-vm' }),
    ]);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'WI-1',
      'needs-human',
      expect.objectContaining({ by: 'su-a' }),
    );
    expect(out.workItem.state).toBe('needs-human');
  });

  it('EI-13301: feature-family clear restores blocked→open and the response reflects POST-write state', async () => {
    const blocker = {
      kind: 'human',
      capability: 'physical-device',
      ref: 'rig-vm',
      summary: 'VM busy',
      status: 'active',
      createdAt: '2026-07-17T03:00:00.000Z',
      createdBy: 'su-a',
      updatedAt: '2026-07-17T03:00:00.000Z',
    };
    // The item is ALREADY parked 'blocked' (a prior set_blocker call did this) — the
    // clear call below must restore it, and the RETURNED workItem must show the
    // post-restore state, not this pre-write snapshot.
    const item = {
      id: 'WI-1',
      family: 'feature',
      kind: 'feature',
      state: 'blocked',
      harness: 'papercup',
      payload: { externalBlockers: [blocker] },
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));
    // work-item-status-full-unify P-007: features restore to the unified claimable
    // token 'open' directly (the legacy 'todo' spelling is retired — no writer
    // produces it and no row sits at it).
    setWorkItemStateWithAliasInfo.mockResolvedValue({
      workItem: { ...item, state: 'open' },
      aliased: false,
      requestedState: 'open',
      appliedState: 'open',
    });

    const out = await one({
      id: 'WI-1',
      kind: 'human',
      ref: 'rig-vm',
      clear: true,
      evidence: 'VM idle now',
    });
    expect(out.ok).toBe(true);
    expect(out.activeBlockers).toEqual([]);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith('WI-1', 'open', expect.objectContaining({ by: 'su-a' }));
    // Defect 2 regression: the returned workItem must be the POST-write ('open')
    // snapshot, not the stale pre-write ('blocked') one merge returned.
    expect(out.workItem.state).toBe('open');
  });

  it('reports persisted clear and the stranded state when lifecycle reopening fails', async () => {
    const blocker = {
      kind: 'event', ref: 'meeting:ready', summary: 'Meeting not ready', status: 'active',
      createdAt: '2026-09-25T15:00:00.000Z', createdBy: 'su-a',
      updatedAt: '2026-09-25T15:00:00.000Z',
    };
    const item = {
      id: 'WI-1', family: 'issue', kind: 'bug', state: 'blocked', harness: 'papercusp',
      payload: { externalBlockers: [blocker] },
    };
    const persisted = {
      ...item,
      payload: { externalBlockers: [{ ...blocker, status: 'cleared' }] },
    };
    getWorkItem.mockResolvedValueOnce(item).mockResolvedValueOnce(persisted);
    mergeWorkItemPayload.mockResolvedValue(persisted);
    setWorkItemClaimHold.mockRejectedValue(new Error('claim hold update failed'));

    const out = await one({ id: 'WI-1', kind: 'event', ref: 'meeting:ready', clear: true, evidence: 'ready' });

    expect(out).toMatchObject({
      ok: false,
      code: 'partial-clear',
      partialOutcome: {
        blockerHistoryPersisted: true,
        lifecycleApplied: false,
        currentState: 'blocked',
        activeBlockerCount: 0,
      },
      workItem: persisted,
      activeBlockers: [],
    });
    expect(out.error).toContain('claim hold update failed');
    expect(out.error).toContain('do not repeat the clear blindly');
    expect(out.partialOutcome.recoveryAction).toContain('work_items:set_state');
  });

  it('EI-13301 backstop: retries the restore when the primary attempt leaves state stuck at blocked', async () => {
    // Simulates the race/no-op EI-13301 reported: the primary open-restore call fires
    // (updated.state was 'blocked') but its OWN result still reports 'blocked' (a
    // no-op write, or a concurrent write raced it) — the backstop must detect the
    // still-blocked, zero-active-blocker combination and retry rather than returning
    // a stranded item.
    const blocker = {
      kind: 'human',
      capability: 'physical-device',
      ref: 'rig-vm',
      summary: 'VM busy',
      status: 'active',
      createdAt: '2026-07-17T03:00:00.000Z',
      createdBy: 'su-a',
      updatedAt: '2026-07-17T03:00:00.000Z',
    };
    const item = {
      id: 'WI-1',
      family: 'feature',
      kind: 'feature',
      state: 'blocked',
      harness: 'papercup',
      payload: { externalBlockers: [blocker] },
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));
    setWorkItemStateWithAliasInfo
      .mockResolvedValueOnce({
        // primary restore attempt: no-op, still 'blocked'
        workItem: { ...item, state: 'blocked' },
        aliased: false,
        requestedState: 'open',
        appliedState: 'blocked',
      })
      .mockResolvedValueOnce({
        // backstop retry: succeeds
        workItem: { ...item, state: 'open' },
        aliased: false,
        requestedState: 'open',
        appliedState: 'open',
      });

    const out = await one({
      id: 'WI-1',
      kind: 'human',
      ref: 'rig-vm',
      clear: true,
      evidence: 'VM idle now',
    });
    expect(out.ok).toBe(true);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledTimes(2);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenLastCalledWith(
      'WI-1',
      'open',
      expect.objectContaining({ by: 'su-a' }),
    );
    // The stranding this backstop exists to prevent: never return 'blocked' with zero
    // active blockers.
    expect(out.workItem.state).toBe('open');
  });

  it('AUTO authority history-clears approval without parking the item', async () => {
    const item = {
      id: 'WI-1',
      family: 'feature',
      kind: 'feature',
      state: 'todo',
      harness: 'papercup',
      payload: {},
    };
    getModes.mockResolvedValue([{ mode: 'auto' }]);
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));

    const out = await one({
      id: 'WI-1',
      kind: 'human',
      capability: 'approval-auto-clearable',
      ref: 'owner-approval',
    });
    expect(out.ok).toBe(true);
    expect(out.autoCleared).toBe(true);
    expect(out.activeBlockers).toEqual([]);
    expect(out.blockerHistory).toEqual([
      expect.objectContaining({ status: 'cleared', capability: 'approval-auto-clearable' }),
    ]);
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('AUTO authority cannot clear a missing physical device', async () => {
    const item = {
      id: 'WI-1',
      family: 'feature',
      kind: 'feature',
      state: 'todo',
      harness: 'papercup',
      payload: {},
    };
    getModes.mockResolvedValue([{ mode: 'auto' }]);
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));

    const out = await one({
      id: 'WI-1',
      kind: 'human',
      capability: 'physical-device',
      ref: 'live-microphone',
      summary: 'Connect a live microphone for the hardware-only verification.',
      nextVerb: 'work_items:set_blocker { clear: true } after the device is connected',
      defaultIfUnanswered: 'stays parked until the device is connected',
    });
    expect(out.ok).toBe(true);
    expect(out.autoCleared).toBe(false);
    expect(out.activeBlockers).toEqual([expect.objectContaining({ status: 'active', capability: 'physical-device' })]);
    expect(out.capabilityDisposition).toMatchObject({
      capability: 'physical-device',
      autoClearable: false,
      requiresOwnerCapability: true,
    });
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'WI-1',
      'needs-human',
      expect.objectContaining({ by: 'su-a' }),
    );
  });

  // WI-2141488 — a bare work-item id as a blocker ref is inert: no event key,
  // nothing to await, nothing to clear. 22 papercusp rows waited forever on one.
  describe('bare work-item id as a blocker ref', () => {
    const openItem = {
      id: 'WI-1',
      family: 'issue',
      kind: 'bug',
      state: 'open',
      harness: 'papercup',
      payload: {},
    };

    // WI-10005020 (P-002 / R-14): a ref naming only work-items is a dependency and
    // is recorded as the canonical blocks edge — never as an external row.
    const edgeFor = (blocker: string) => ({ blocker, blocked: { kind: 'issue', ref: 'WI-1' } });

    it('reasserts an existing self-id owner ask without turning it into a self-dependency', async () => {
      const blocker = {
        kind: 'human', capability: 'product-decision', ref: 'WI-1', status: 'active',
        summary: 'Choose the prompt strategy.', nextVerb: 'Record the owner decision.',
        defaultIfUnanswered: 'Keep this owner condition active.',
        createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'original-author',
        updatedAt: '2026-10-01T00:00:00.000Z',
      };
      const item = { ...openItem, state: 'needs-human', payload: { externalBlockers: [blocker] } };
      getWorkItem.mockResolvedValue(item);
      mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({ ...item, payload: { ...item.payload, ...patch } }));
      const out = await one({
        id: item.id, kind: 'human', capability: 'product-decision', ref: blocker.ref,
        summary: blocker.summary, nextVerb: blocker.nextVerb,
        recheckAt: '2026-10-12T00:00:00Z',
      });

      expect(out).toMatchObject({ ok: true, changed: true, autoCleared: false });
      expect(out.activeBlockers).toEqual([expect.objectContaining({
        kind: blocker.kind, capability: blocker.capability, ref: blocker.ref, status: 'active',
        summary: blocker.summary, nextVerb: blocker.nextVerb,
        defaultIfUnanswered: blocker.defaultIfUnanswered,
        createdAt: blocker.createdAt, createdBy: blocker.createdBy,
        recheckAt: '2026-10-12T00:00:00.000Z',
      })]);
      expect(Date.parse(out.activeBlockers[0].updatedAt)).toBeGreaterThan(Date.parse(blocker.updatedAt));
      expect(linkWorkItemRefDependencies).not.toHaveBeenCalled();
      expect(setWorkItemClaimHold).not.toHaveBeenCalled();
    });

    it('still validates the concrete question on an existing self-id owner ask', async () => {
      getWorkItem.mockResolvedValue({
        ...openItem,
        payload: { externalBlockers: [{
          kind: 'human', capability: 'product-decision', ref: 'WI-1', status: 'active',
          summary: 'Choose the prompt strategy.', nextVerb: 'Record the owner decision.',
          createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'original-author',
          updatedAt: '2026-10-01T00:00:00.000Z',
        }] },
      });
      const out = await one({ id: 'WI-1', kind: 'human', capability: 'product-decision', ref: 'WI-1' });

      expect(out).toMatchObject({ ok: false });
      expect(out.error).toContain('structured ask requires both');
      expect(linkWorkItemRefDependencies).not.toHaveBeenCalled();
      expect(mergeWorkItemPayload).not.toHaveBeenCalled();
    });

    it('does not turn a new self-ref or an existing technical self-ref into an owner ask', async () => {
      for (const payload of [{}, { externalBlockers: [{
        kind: 'human', capability: 'live-dependency', ref: 'WI-1', status: 'active',
        createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'original-author',
        updatedAt: '2026-10-01T00:00:00.000Z',
      }] }]) {
        vi.clearAllMocks();
        getWorkItem.mockResolvedValue({ ...openItem, payload });
        linkWorkItemRefDependencies.mockResolvedValue({
          ok: false, code: 'work_item_ref_dependency_refused', error: 'cannot depend on itself',
        });
        const out = await one({
          id: 'WI-1', kind: 'human', capability: 'product-decision', ref: 'WI-1',
          summary: 'Choose the prompt strategy.', nextVerb: 'Record the owner decision.',
          defaultIfUnanswered: 'Keep this owner condition active.',
        });

        expect(out).toMatchObject({ ok: false, code: 'work_item_ref_dependency_refused' });
        expect(linkWorkItemRefDependencies).toHaveBeenCalled();
        expect(mergeWorkItemPayload).not.toHaveBeenCalled();
      }
    });

    it('records a bare work-item id as a blocks edge, writing no external row', async () => {
      getWorkItem.mockResolvedValue(openItem);
      linkWorkItemRefDependencies.mockResolvedValue({ ok: true, edges: [edgeFor('WI-40086')] });

      const out = await one({ id: 'WI-1', kind: 'gate', ref: 'WI-40086' });

      expect(out).toMatchObject({
        ok: true,
        id: 'WI-1',
        convertedToEdge: { rel: 'blocks', blockers: ['WI-40086'] },
        activeBlockers: [],
      });
      expect(linkWorkItemRefDependencies).toHaveBeenCalledWith({
        dependentId: 'WI-1',
        harness: undefined,
        referents: ['WI-40086'],
        by: 'su-a',
      });
      expect(mergeWorkItemPayload).not.toHaveBeenCalled();
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    // The SET path for the event-key form: R-2's falsifier names both the bare id (above)
    // and a work-item:done:<id> event key. The external-key negative control is below.
    it('AUTO-BAR-R-2-P-002: an event blocker keyed work-item:done:<id> is stored as a blocks edge, writing no external row', async () => {
      getWorkItem.mockResolvedValue(openItem);
      linkWorkItemRefDependencies.mockResolvedValue({ ok: true, edges: [edgeFor('WI-40086')] });

      const out = await one({ id: 'WI-1', kind: 'event', ref: 'work-item:done:WI-40086' });

      expect(out).toMatchObject({
        ok: true,
        id: 'WI-1',
        convertedToEdge: { rel: 'blocks', blockers: ['WI-40086'] },
        activeBlockers: [],
      });
      expect(linkWorkItemRefDependencies).toHaveBeenCalledWith({
        dependentId: 'WI-1',
        harness: undefined,
        referents: ['WI-40086'],
        by: 'su-a',
      });
      expect(mergeWorkItemPayload).not.toHaveBeenCalled();
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    it('converts every kind and both ref forms, deduplicating referents', async () => {
      for (const kind of ['event', 'gate', 'runtime', 'human'] as const) {
        vi.clearAllMocks();
        getWorkItem.mockResolvedValue(openItem);
        linkWorkItemRefDependencies.mockResolvedValue({ ok: true, edges: [edgeFor('EI-21330406073681578')] });
        const out = await one({
          id: 'WI-1',
          kind,
          ref: 'EI-21330406073681578; work-item:done:EI-21330406073681578, work-item:done:WI-40509',
          ...(kind === 'human' ? { summary: 'q', nextVerb: 'v', defaultIfUnanswered: 'stays parked' } : {}),
        });
        expect(out.ok).toBe(true);
        expect(linkWorkItemRefDependencies).toHaveBeenCalledWith(
          expect.objectContaining({ referents: ['EI-21330406073681578', 'WI-40509'] }),
        );
        expect(mergeWorkItemPayload).not.toHaveBeenCalled();
      }
    });

    it('refuses without writing a row when the dependency cannot be recorded', async () => {
      getWorkItem.mockResolvedValue(openItem);
      const refusal = {
        observed: { dependent: 'WI-1', blockers: 'WI-404' },
        liftsWhen: 'the blocker resolves to an existing work-item',
        whoCanMakeItTrue: ['self'],
      };
      linkWorkItemRefDependencies.mockResolvedValue({
        ok: false,
        code: 'work_item_ref_dependency_refused',
        error: "blocker work_item 'WI-404' was not found",
        refusal,
      });

      const out = await one({ id: 'WI-1', kind: 'event', ref: 'work-item:done:WI-404' });

      expect(out).toMatchObject({ ok: false, code: 'work_item_ref_dependency_refused' });
      // WI-10005197: the single-ref path forwards the edge writer's RefusalContract untouched.
      expect(out.refusal).toEqual(refusal);
      expect(mergeWorkItemPayload).not.toHaveBeenCalled();
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    it('still refuses a bare id MIXED with an external condition, naming work_items:link', async () => {
      getWorkItem.mockResolvedValue(openItem);

      const out = await one({ id: 'WI-1', kind: 'gate', ref: 'WI-40086; deploy-freeze:papercusp' });

      expect(out).toMatchObject({ ok: false, id: 'WI-1', code: 'work_item_ref_as_external_blocker' });
      expect(out.error).toContain("work_items:link { id: 'WI-40086', rel:'blocks', target_id: 'WI-1' }");
      expect(linkWorkItemRefDependencies).not.toHaveBeenCalled();
      expect(mergeWorkItemPayload).not.toHaveBeenCalled();
    });

    // CALIBRATION — must hold before and after the guard exists. If these ever
    // fail, the guard has become over-broad and is refusing legitimate writes.
    it('still accepts a gate condition that merely QUALIFIES with an item id', async () => {
      getWorkItem.mockResolvedValue(openItem);
      mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
        ...openItem,
        payload: { ...openItem.payload, ...patch },
      }));

      const out = await one({ id: 'WI-1', kind: 'gate', ref: 'gate-red-streak:papercusp / WI-212675' });

      expect(out.ok).toBe(true);
      expect(out.activeBlockers).toEqual([
        expect.objectContaining({ status: 'active', ref: 'gate-red-streak:papercusp / WI-212675' }),
      ]);
    });

    // NEGATIVE CONTROL: a genuine external event key is not a work-item ref and
    // must keep its external row + await, untouched by the edge conversion.
    it('keeps a genuine external event key as an external row', async () => {
      getWorkItem.mockResolvedValue(openItem);
      mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
        ...openItem,
        payload: { ...openItem.payload, ...patch },
      }));

      const out = await one({ id: 'WI-1', kind: 'event', ref: 'release:deployed:papercusp' });

      expect(out.ok).toBe(true);
      expect(out.convertedToEdge).toBeUndefined();
      expect(linkWorkItemRefDependencies).not.toHaveBeenCalled();
      expect(out.await).toEqual({ event: 'release:deployed:papercusp' });
    });

    // The load-bearing one: rows already carrying a bad ref must stay clearable,
    // or this guard would strand the exact population it exists to prevent.
    it('still CLEARS an already-written bare work-item blocker', async () => {
      const blocked = {
        ...openItem,
        state: 'blocked',
        payload: {
          externalBlockers: [
            {
              kind: 'gate',
              ref: 'WI-40086',
              summary: 'waiting on WI-40086',
              status: 'active',
              capability: 'live-dependency',
              capabilitySource: 'explicit',
              createdAt: '2026-08-01T00:00:00.000Z',
              createdBy: 'su-old',
              updatedAt: '2026-08-01T00:00:00.000Z',
            },
          ],
        },
      };
      getWorkItem.mockResolvedValue(blocked);
      mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
        ...blocked,
        payload: { ...blocked.payload, ...patch },
      }));

      const out = await one({ id: 'WI-1', ref: 'WI-40086', clear: true, evidence: 'WI-40086 is done' });

      expect(out.ok).toBe(true);
      expect(out.activeBlockers).toEqual([]);
      expect(mergeWorkItemPayload).toHaveBeenCalled();
    });
  });

  // WI-10005020 (P-002 / R-15): pre-existing rows naming only work-items are migrated
  // to the canonical blocks edge; genuine external rows are the negative control.
  describe('migrateWorkItemRefs (R-15)', () => {
    const row = (kind: string, ref: string) => ({
      kind,
      ref,
      summary: `waiting on ${ref}`,
      status: 'active',
      capability: kind === 'human' ? 'product-decision' : 'live-dependency',
      capabilitySource: 'explicit',
      createdAt: '2026-08-01T00:00:00.000Z',
      createdBy: 'su-old',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    const blockedWith = (rows: unknown[], state = 'blocked') => ({
      id: 'WI-10002828',
      family: 'issue',
      kind: 'change',
      state,
      harness: 'papercusp',
      payload: { externalBlockers: rows },
    });
    const persistMerge = (item: { payload: Record<string, unknown> }) =>
      mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
        ...item,
        payload: { ...item.payload, ...patch },
      }));
    const activeRefs = (blockers: Array<{ ref: string; status: string }>) =>
      blockers.filter((b) => b.status === 'active').map((b) => b.ref);

    it('reports a committed migration as ok when the blocked->open restore is refused (plan gate)', async () => {
      // Live 2026-10-02: WI-10002828's plan item was still blocked, so the restore threw
      // after the row was cleared and the edge written; the call used to say ok:false.
      const item = blockedWith([row('event', 'work-item:done:WI-10004474')]);
      getWorkItem.mockResolvedValue(item);
      persistMerge(item);
      linkWorkItemRefDependencies.mockResolvedValue({
        ok: true,
        edges: [{ blocker: 'WI-10004474', blocked: { kind: 'issue', ref: 'WI-10002828' } }],
      });
      setWorkItemStateWithAliasInfo.mockRejectedValueOnce(
        new Error("work_item 'WI-10002828' is blocked, and its linked plan-item p#P-006 is STILL effectively 'blocked'"),
      );

      const out = await one({ id: 'WI-10002828', migrateWorkItemRefs: true });

      expect(out.ok).toBe(true);
      expect(out.changed).toBe(true);
      expect(out.migration.converted).toEqual([
        { kind: 'event', ref: 'work-item:done:WI-10004474', blockers: ['WI-10004474'] },
      ]);
      expect(out.workItem.state).toBe('blocked');
      expect(out.lifecycle).toMatchObject({ restored: false, state: 'blocked' });
      expect(out.lifecycle.error).toContain('STILL effectively');
      expect(activeRefs(out.blockerHistory)).toEqual([]);
    });

    it('replaces a work-item:done row with a blocks edge, clears the row and restores open', async () => {
      const item = blockedWith([row('event', 'work-item:done:WI-10004474')]);
      getWorkItem.mockResolvedValue(item);
      persistMerge(item);
      linkWorkItemRefDependencies.mockResolvedValue({
        ok: true,
        edges: [{ blocker: 'WI-10004474', blocked: { kind: 'issue', ref: 'WI-10002828' } }],
      });
      setWorkItemStateWithAliasInfo.mockResolvedValueOnce({ workItem: { ...item, state: 'open' } });

      const out = await one({ id: 'WI-10002828', migrateWorkItemRefs: true });

      expect(out.ok).toBe(true);
      expect(linkWorkItemRefDependencies).toHaveBeenCalledWith({
        dependentId: 'WI-10002828',
        harness: undefined,
        referents: ['WI-10004474'],
        by: 'su-a',
      });
      expect(out.migration.converted).toEqual([
        { kind: 'event', ref: 'work-item:done:WI-10004474', blockers: ['WI-10004474'] },
      ]);
      // Falsifier: no row naming another work item may stay active after the migration.
      expect(out.activeBlockers).toEqual([]);
      const [, patch] = mergeWorkItemPayload.mock.calls[0];
      expect(activeRefs(patch.externalBlockers)).toEqual([]);
      expect(patch.externalBlockers[0]).toMatchObject({ status: 'cleared', ref: 'work-item:done:WI-10004474' });
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith('WI-10002828', 'open', {
        harness: undefined,
        by: 'su-a',
      });
      expect(out.workItem.state).toBe('open');
    });

    it('leaves genuine external rows and self-only owner rows untouched (negative control)', async () => {
      const item = blockedWith([
        row('gate', 'WI-40086; WI-40509'),
        row('event', 'release:deployed:papercusp'),
        row('human', 'WI-10002828'),
      ]);
      getWorkItem.mockResolvedValue(item);
      persistMerge(item);
      linkWorkItemRefDependencies.mockResolvedValue({ ok: true, edges: [] });

      const out = await one({ id: 'WI-10002828', migrateWorkItemRefs: true });

      expect(out.ok).toBe(true);
      expect(linkWorkItemRefDependencies).toHaveBeenCalledTimes(1);
      expect(linkWorkItemRefDependencies).toHaveBeenCalledWith(
        expect.objectContaining({ referents: ['WI-40086', 'WI-40509'] }),
      );
      expect(out.migration.untouchedSelfOnly).toEqual([{ kind: 'human', ref: 'WI-10002828' }]);
      expect(activeRefs(out.activeBlockers)).toEqual(['release:deployed:papercusp', 'WI-10002828']);
      // Rows still active, so the item stays blocked: no lifecycle change.
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(setWorkItemClaimHold).not.toHaveBeenCalled();
    });

    it('drops the item\'s own id from a multi-ref row and links only the real dependencies', async () => {
      const item = blockedWith([row('gate', 'WI-10002828, WI-2140973')], 'needs-human');
      getWorkItem.mockResolvedValue(item);
      persistMerge(item);
      linkWorkItemRefDependencies.mockResolvedValue({ ok: true, edges: [] });

      const out = await one({ id: 'WI-10002828', migrateWorkItemRefs: true });

      expect(linkWorkItemRefDependencies).toHaveBeenCalledWith(expect.objectContaining({ referents: ['WI-2140973'] }));
      expect(out.activeBlockers).toEqual([]);
      // needs-human is not a blocked-park state; the migration leaves it for its owner.
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    it('clears rows on a terminal dependent without writing any edge', async () => {
      const item = blockedWith([row('gate', 'WI-40086')], 'done');
      getWorkItem.mockResolvedValue(item);
      persistMerge(item);

      const out = await one({ id: 'WI-10002828', migrateWorkItemRefs: true });

      expect(out.ok).toBe(true);
      expect(linkWorkItemRefDependencies).not.toHaveBeenCalled();
      expect(out.migration).toMatchObject({ dependentTerminal: true, converted: [{ ref: 'WI-40086', blockers: [] }] });
      expect(out.activeBlockers).toEqual([]);
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    it('keeps a row active and reports it when its edge is refused', async () => {
      const item = blockedWith([row('event', 'work-item:done:WI-404')]);
      getWorkItem.mockResolvedValue(item);
      linkWorkItemRefDependencies.mockResolvedValue({
        ok: false,
        code: 'work_item_ref_dependency_refused',
        error: "blocker work_item 'WI-404' was not found",
      });

      const out = await one({ id: 'WI-10002828', migrateWorkItemRefs: true });

      expect(out).toMatchObject({ ok: false, code: 'work_item_ref_dependency_refused', changed: false });
      // WI-10005197: the migration summary states the same contract, built from the dependent and
      // the refused refs (this module does not mock the pure builder, so it is the real one).
      expect(out.refusal).toMatchObject({ observed: { dependent: 'WI-10002828', blockers: 'work-item:done:WI-404' } });
      expect(typeof out.refusal.liftsWhen).toBe('string');
      expect(out.migration.refused).toEqual([
        { kind: 'event', ref: 'work-item:done:WI-404', error: "blocker work_item 'WI-404' was not found" },
      ]);
      expect(mergeWorkItemPayload).not.toHaveBeenCalled();
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    it('refuses migrateWorkItemRefs combined with a set or clear field', () => {
      expect(() => parse({ id: 'WI-1', migrateWorkItemRefs: true, ref: 'WI-2' })).toThrow(/cannot be combined/);
      expect(() => parse({ items: [{ id: 'WI-1', migrateWorkItemRefs: true, clear: true }] })).toThrow(
        /cannot be combined/,
      );
      expect(() => parse({ id: 'WI-1', migrateWorkItemRefs: true })).not.toThrow();
    });
  });
});
