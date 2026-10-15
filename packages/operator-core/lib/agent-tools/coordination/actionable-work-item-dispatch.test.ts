import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '../../work-items';
import { isAdmitted } from '../../work-items-admission';
import { metadataWorkflowTargets } from '../plans/coordination-metadata-fixtures';
import {
  assignActionableWorkItems,
  assignAndWakeActionableWorkItems,
  authorizeWorkItemDispatch,
  type ActionableWorkItemDispatchDeps,
  resolveStableAgentTarget,
  type StableAgentTargetDeps,
  type StableAgentTargetState,
} from './actionable-work-item-dispatch';

const authorityIO = vi.hoisted(() => ({ read: vi.fn(), gate: vi.fn(), fleet: vi.fn() }));
vi.mock('../../work-scope-policy', () => ({
  readWorkScopePolicy: authorityIO.read,
  gateWorkScope: authorityIO.gate,
}));
vi.mock('../../scheduler/fleet-scope-admission', () => ({ admitWorkItemForFleetTarget: authorityIO.fleet }));

function workItem(id: string, state = 'open', assignee: string | null = null): WorkItem {
  return {
    id,
    kind: 'feature',
    family: 'feature',
    harness: 'email',
    title: id,
    summary: id,
    state,
    assignee,
    payload: {},
  } as WorkItem;
}

function issueWorkItem(id: string, state = 'open', assignee: string | null = null): WorkItem {
  return {
    ...workItem(id, state, assignee),
    kind: 'task',
    family: 'issue',
  } as WorkItem;
}

function target(ownerId = 'agent-email-stable', patch: Partial<StableAgentTargetState> = {}): StableAgentTargetState {
  return {
    requested: ownerId,
    ownerId,
    present: true,
    sessionState: 'parked',
    wakeable: true,
    ...patch,
  };
}

function deps(patch: Partial<ActionableWorkItemDispatchDeps> = {}): ActionableWorkItemDispatchDeps {
  return {
    observe: vi.fn(async (id) => ({
      item: workItem(id),
      available: true,
      claimedBy: null,
    })),
    claim: vi.fn(async (id, assignee) => workItem(id, 'open', assignee)),
    authorize: vi.fn(async () => ({ allowed: true as const })),
    explainClaimFloors: vi.fn(async () => []),
    blockers: vi.fn(async () => []),
    planBlock: vi.fn(async () => null),
    planClaim: vi.fn(async () => null),
    resolveTarget: vi.fn(async ({ targetAgent }) => target(targetAgent)),
    wake: vi.fn(async (owners: readonly string[]) => ({
      targets: [...owners],
      keys: owners.map((owner) => `coord:inbox-wake:${owner}`),
      queued: 1,
      woken: 1,
      pickupConfirmed: false as const, pickup: [],
      staged: 0,
      stagedTargets: [],
      fanoutCapped: [],
      timedOutTargets: [],
    })),
    ...patch,
  };
}

describe('assignActionableWorkItems', () => {
  it('does not wake an accepted bug whose reproduction became stale after assignment', async () => {
    const held = { ...issueWorkItem('WI-STALE-BUG', 'open', 'su-fixer'), kind: 'bug' as const };
    const d = deps({ observe: vi.fn(async () => ({
      item: held, available: false, claimedBy: 'su-fixer', gated: true,
      reproductionRefused: { status: 'refuted', detail: 'reproduce again before fixing', checkedAt: '2026-10-09T00:00:00Z' },
    })) });
    const result = await assignAndWakeActionableWorkItems({ workItemIds: [held.id], targetAgent: 'su-fixer' }, d);
    expect(result.assignment.retained).toEqual([]);
    expect(result.assignment.skipped[0]).toMatchObject({ code: 'admission_gated', reason: 'reproduce again before fixing' });
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.wake).not.toHaveBeenCalled();
  });

  it('carries the authenticated dispatch actor into the atomic claim (EI-25163151398656476)', async () => {
    const d = deps({ observe: vi.fn(async (id) => ({ item: issueWorkItem(id), available: true, claimedBy: null })) });
    const result = await assignActionableWorkItems(
      { workItemIds: ['EI-dispatched'], targetAgent: 'su-member', actor: 'su-leader', harness: 'email' },
      d,
    );
    expect(result.assigned).toEqual(['EI-dispatched']);
    expect(d.claim).toHaveBeenCalledWith('EI-dispatched', 'su-member', {
      harness: 'email', assignedBy: 'su-leader',
    });
  });

  it('atomically transfers a caller-held item to the dispatched target', async () => {
    const claim = vi.fn(async (id: string, assignee: string) => workItem(id, 'wip', assignee));
    const d = deps({
      observe: vi.fn(async (id) => ({
        item: issueWorkItem(id, 'wip', 'su-holder'),
        available: false,
        claimedBy: 'su-holder',
      })),
      claim,
    });

    const result = await assignActionableWorkItems(
      { workItemIds: ['EI-TRANSFER'], targetAgent: 'su-target', actor: 'su-holder', harness: 'email' },
      d,
    );

    expect(result.assigned).toEqual(['EI-TRANSFER']);
    expect(result.skipped).toEqual([]);
    expect(result.executionWorkItemIds).toEqual(['EI-TRANSFER']);
    expect(claim).toHaveBeenCalledWith('EI-TRANSFER', 'su-target', {
      harness: 'email',
      assignedBy: 'su-holder',
      fromHolder: 'su-holder',
    });
  });

  it('claims only the current dependency frontier and preserves blocked descendants', async () => {
    const claim = vi.fn(async (id: string, assignee: string) => workItem(id, 'open', assignee));
    const d = deps({
      claim,
      blockers: vi.fn(async (id) => (id === 'WI-BLOCKED' ? [{ ref: 'WI-ROOT', kind: 'feature' }] : [])),
    });

    const result = await assignActionableWorkItems(
      {
        workItemIds: ['WI-READY', 'WI-BLOCKED'],
        targetAgent: 'agent-email-stable',
        harness: 'email',
      },
      d,
    );

    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith('WI-READY', 'agent-email-stable', { harness: 'email' });
    expect(result.assigned).toEqual(['WI-READY']);
    expect(result.executionWorkItemIds).toEqual(['WI-READY']);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        workItemId: 'WI-BLOCKED',
        code: 'dependency_blocked',
        blockers: ['WI-ROOT'],
      }),
    ]);
  });

  it('never force-claims an item held by another agent', async () => {
    const claim = vi.fn();
    const d = deps({
      claim,
      observe: vi.fn(async (id) => ({
        item: workItem(id, 'open', 'agent-other'),
        available: false,
        claimedBy: 'agent-other',
      })),
    });

    const result = await assignActionableWorkItems({
      workItemIds: ['WI-HELD'],
      targetAgent: 'agent-email-stable',
      actor: 'agent-sender',
    }, d);

    expect(claim).not.toHaveBeenCalled();
    expect(result.executionWorkItemIds).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.skipped[0]).toMatchObject({
      workItemId: 'WI-HELD',
      code: 'held_by_other',
      holder: 'agent-other',
    });
  });

  it('EI-22122824405906276: an admission-pending gate renders the explanation + remedy, not the generic frontier text', async () => {
    const claim = vi.fn();
    const d = deps({
      claim,
      observe: vi.fn(async (id) => ({
        item: workItem(id),
        available: false,
        claimedBy: null,
        gated: true,
        admissionPending: {
          reason: 'duplicate screening is pending — CLEARS ON ITS OWN in 30 minutes',
          remedy: 'An item created FOR a named agent should not be born pending; use assign_to.',
        },
      })),
    });

    const result = await assignActionableWorkItems({ workItemIds: ['WI-PENDING'], targetAgent: 'agent-email-stable' }, d);

    expect(claim).not.toHaveBeenCalled();
    expect(result.skipped[0]).toMatchObject({ workItemId: 'WI-PENDING', code: 'admission_gated' });
    // The reason must carry BOTH halves — a caller reading only `reason` (coord:dispatch's
    // JSON refusal) has no other field to fall back to for the remedy.
    expect(result.skipped[0]?.reason).toContain('CLEARS ON ITS OWN');
    expect(result.skipped[0]?.reason).toContain('assign_to');
    // Never the old unactionable text once a remedy is available.
    expect(result.skipped[0]?.reason).not.toContain('outside the canonical admission frontier');
  });

  it('a gated item with no admissionPending detail keeps the generic frontier text (other gates: trust/federation)', async () => {
    const claim = vi.fn();
    const d = deps({
      claim,
      observe: vi.fn(async (id) => ({
        item: workItem(id),
        available: false,
        claimedBy: null,
        gated: true,
        // No `admissionPending` — e.g. the feature-family trust gate or a remote,
        // not-locally-claimable issue. Neither is a temporal admission-pending wait.
      })),
    });

    const result = await assignActionableWorkItems({ workItemIds: ['WI-UNTRUSTED'], targetAgent: 'agent-email-stable' }, d);

    expect(claim).not.toHaveBeenCalled();
    expect(result.skipped[0]).toMatchObject({
      workItemId: 'WI-UNTRUSTED',
      code: 'admission_gated',
      reason: 'work-item is outside the canonical admission frontier',
    });
  });

  it('EI-22008434629323224: an issue-family task gate carries the canonical claim floor and remedy', async () => {
    const claimFloor = {
      id: 'WI-FRESH-TASK',
      admissible: false,
      refusedBy: 'admission-pending',
      detail: 'duplicate screening is pending',
      retry: {
        clearsOnItsOwn: true as const,
        expectedWithinSec: 1800,
        guaranteedWithinSec: 3600,
        basis: 'promoter cadence',
      },
      remedy: 're-file with assign_to to bypass screening',
    };
    const explainClaimFloors = vi.fn(async () => [claimFloor]);
    const d = deps({
      explainClaimFloors,
      observe: vi.fn(async (id) => ({
        item: issueWorkItem(id),
        available: false,
        claimedBy: null,
        gated: true,
        // Keep the observation-side detail too: dispatch must prefer the
        // canonical claim oracle, rather than only the generic observe hint.
        admissionPending: {
          reason: 'duplicate screening is pending',
          remedy: 're-file with assign_to to bypass screening',
        },
      })),
    });

    const result = await assignActionableWorkItems(
      { workItemIds: ['WI-FRESH-TASK'], targetAgent: 'agent-email-stable', harness: 'email' },
      d,
    );

    expect(explainClaimFloors).toHaveBeenCalledWith('email', ['WI-FRESH-TASK'], {
      assignee: 'agent-email-stable',
    });
    expect(result.skipped[0]).toMatchObject({
      workItemId: 'WI-FRESH-TASK',
      code: 'admission_gated',
      claimFloor,
    });
    expect(result.skipped[0]?.reason).toContain('claim floor admission-pending');
    expect(result.skipped[0]?.reason).toContain('re-file with assign_to');
    expect(result.skipped[0]?.reason).not.toContain('outside the canonical admission frontier');
  });

  it('EI-22637730449925244: a durable park exposes provenance and the release unpark verb', async () => {
    const d = deps({
      observe: vi.fn(async (id) => ({
        item: { ...issueWorkItem(id), payload: {
          _claimHold: true,
          claim_hold_by: 'su-leader',
          claim_hold_reason: 'awaiting owner decision',
          claim_hold_at: '2026-09-08T10:00:00.000Z',
          claim_hold_release: {
            condition: 'owner decision is recorded',
            trigger: 'owner:decision-recorded',
            reachability: 'reachable',
          },
        } },
        available: false,
        claimedBy: null,
        gated: true,
        claimHoldParked: true,
      })),
    });

    const result = await assignActionableWorkItems({
      workItemIds: ['WI-PARKED'],
      targetAgent: 'agent-email-stable',
    }, d);

    expect(result.skipped[0]).toMatchObject({
      workItemId: 'WI-PARKED',
      code: 'claim_hold',
      claimHold: {
        heldOpen: null,
        parked: {
          by: 'su-leader',
          reason: 'awaiting owner decision',
          at: '2026-09-08T10:00:00.000Z',
        },
        releaseContract: {
          condition: 'owner decision is recorded',
          trigger: 'owner:decision-recorded',
          reachability: 'reachable',
        },
        attributed: true,
        policyGate: false,
        unblock: {
          tool: 'work_items:release',
          args: { id: 'WI-PARKED', claimHold: false },
        },
      },
    });
    expect(result.skipped[0]?.reason).toContain('work_items:release');
    expect(result.skipped[0]?.reason).toContain('claimHold:false');
    expect(result.skipped[0]?.reason).toContain('su-leader');
  });

  it('EI-22637730449925244: a hold-open lease points to hold_open clear and policy override rules', async () => {
    const d = deps({
      observe: vi.fn(async (id) => ({
        item: { ...issueWorkItem(id), payload: {
          _claimHold: true,
          held_open_by: 'su-leader',
          held_open_reason: 'D-003 policy-tier gate — owner sign-off required',
        } },
        available: false,
        claimedBy: 'su-leader',
        gated: true,
        claimHoldParked: true,
      })),
    });

    const result = await assignActionableWorkItems({
      workItemIds: ['WI-LEASE'],
      targetAgent: 'agent-email-stable',
    }, d);

    expect(result.skipped[0]).toMatchObject({
      code: 'claim_hold',
      claimHold: {
        heldOpen: { by: 'su-leader', reason: expect.stringContaining('D-003') },
        parked: null,
        attributed: true,
        policyGate: true,
        unblock: {
          tool: 'work_items:hold_open',
          args: { id: 'WI-LEASE', clear: true },
        },
      },
    });
    expect(result.skipped[0]?.reason).toContain('ownerOverride:true');
  });
});

describe('P-001 existing-review recovery baseline', () => {
  // Real assignment/wake composition, with only persistence, policy results and
  // delivery IO injected. These are stage counts, not live fleet/latency proof.
  it('keeps one identity through denied scope, pending screening, interrupted delivery and replay', async () => {
    const id = 'WI-REVIEW-FIXTURE';
    let row = issueWorkItem(id);
    let scopeAllowed = false;
    let admission: string = 'auto';
    const d = deps({
      observe: vi.fn(async () => ({
        item: row, claimedBy: row.assignee,
        available: !row.assignee && isAdmitted(admission),
        gated: !isAdmitted(admission),
      })),
      claim: vi.fn(async (_id, assignee) => {
        if (!scopeAllowed) return null;
        row = { ...row, assignee };
        return row;
      }),
      explainClaimFloors: vi.fn(async () => [{
        id, admissible: false, refusedBy: 'admission-pending',
        detail: 'duplicate screening is pending',
      }]),
    });
    const request = { workItemIds: [id], targetAgent: 'fixture-reviewer', harness: 'email' };
    const refused = await assignAndWakeActionableWorkItems(request, d);
    expect(refused.assignment.failed[0]?.code).toBe('claim_refused');
    expect(d.wake).not.toHaveBeenCalled();

    // An authorized scope repair does not itself clear duplicate screening.
    scopeAllowed = true;
    admission = 'pending';
    const pending = await assignAndWakeActionableWorkItems(request, d);
    expect(pending.assignment.skipped[0]).toMatchObject({
      code: 'admission_gated', claimFloor: { refusedBy: 'admission-pending' },
    });
    expect(d.claim).toHaveBeenCalledTimes(1);
    expect(d.wake).not.toHaveBeenCalled();

    // The existing promoter's persisted verdict is the ONLY changed input.
    admission = 'admitted';
    vi.mocked(d.wake).mockRejectedValueOnce(new Error('fixture delivery interruption'));
    await expect(assignAndWakeActionableWorkItems(request, d)).rejects.toThrow('fixture delivery interruption');
    expect(row.assignee).toBe('fixture-reviewer');

    // Process loss preserves the database row, not a local progress counter.
    row = JSON.parse(JSON.stringify(row)) as WorkItem;
    const recovered = await assignAndWakeActionableWorkItems(request, d);
    expect(recovered.assignment.retained).toEqual([id]);
    expect(recovered.assignment.assigned).toEqual([]);
    expect(recovered.wake).toMatchObject({ queued: 1, pickupConfirmed: false });
    expect(d.claim).toHaveBeenCalledTimes(2); // one refusal, one landed assignment
    expect(d.resolveTarget).toHaveBeenCalledTimes(metadataWorkflowTargets.reviewRecoveryRequests.before);
    expect(recovered.assignment.executionWorkItemIds).toEqual([id]);
  });

  it('refuses a revoked admission on an already-held replay without releasing ownership', async () => {
    const d = deps({
      observe: vi.fn(async (id) => ({
        item: issueWorkItem(id, 'wip', 'fixture-reviewer'),
        claimedBy: 'fixture-reviewer', available: false, gated: true,
      })),
    });
    const result = await assignAndWakeActionableWorkItems({
      workItemIds: ['WI-REVIEW-FIXTURE'], targetAgent: 'fixture-reviewer',
    }, d);
    expect(result.assignment.retained).toEqual([]);
    expect(result.assignment.skipped[0]).toMatchObject({ code: 'admission_gated' });
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.wake).toHaveBeenCalledTimes(metadataWorkflowTargets.revokedReviewWakes.maxAfter);
  });

  it.each([false, true])('checks current authority on every retry (held=%s)', async (held) => {
    const id = 'WI-REVIEW-FIXTURE';
    const d = deps({
      observe: vi.fn(async () => ({
        item: issueWorkItem(id, 'open', held ? 'fixture-reviewer' : null),
        available: !held, claimedBy: held ? 'fixture-reviewer' : null,
      })),
      authorize: vi.fn()
        .mockResolvedValueOnce({ allowed: false, reason: 'effective member override denies this exact id' })
        .mockRejectedValueOnce(new Error('authority unavailable'))
        .mockResolvedValueOnce({ allowed: true }),
    });
    const request = { workItemIds: [id], targetAgent: 'fixture-reviewer', workspaceId: 'workspace-fixture' };
    const denied = await assignAndWakeActionableWorkItems(request, d);
    expect(denied.assignment.skipped[0]).toMatchObject({ code: 'authority_denied' });
    const unknown = await assignAndWakeActionableWorkItems(request, d);
    expect(unknown.assignment.skipped[0]).toMatchObject({ code: 'read_failed', reason: 'authority read failed: authority unavailable' });
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.wake).not.toHaveBeenCalled();
    const recovered = await assignAndWakeActionableWorkItems(request, d);
    expect(recovered.assignment.executionWorkItemIds).toEqual([id]);
    expect(d.authorize).toHaveBeenLastCalledWith({
      workItemId: id, target: 'fixture-reviewer', harness: 'email', workspaceId: 'workspace-fixture',
    });
    expect(d.observe).toHaveBeenLastCalledWith(id, { revalidateHeld: true, assignee: 'fixture-reviewer' });
    expect(d.claim).toHaveBeenCalledTimes(held ? 0 : 1);
    expect(d.wake).toHaveBeenCalledTimes(1);
  });
});

describe('production dispatch authority wiring', () => {
  const request = { workItemId: 'WI-existing', target: 'stable-reviewer', harness: 'email', workspaceId: 'fixture-workspace' };
  beforeEach(() => {
    authorityIO.read.mockReset().mockResolvedValue({ mode: 'enforce', allowHarnesses: ['email'] });
    authorityIO.gate.mockReset().mockResolvedValue({ allowed: true });
    authorityIO.fleet.mockReset().mockResolvedValue({ allowed: true, scoped: false });
  });
  it('reads current workspace policy and passes the exact target and workspace to effective fleet admission', async () => {
    expect(await authorizeWorkItemDispatch(request)).toEqual({ allowed: true });
    expect(authorityIO.gate).toHaveBeenCalledWith('coord:dispatch', {
      harness: 'email', workItem: 'WI-existing', actor: 'stable-reviewer',
    }, { mode: 'enforce', allowHarnesses: ['email'] });
    expect(authorityIO.fleet).toHaveBeenCalledWith(request);
    expect(authorityIO.read).toHaveBeenCalledWith('fixture-workspace');
    authorityIO.fleet.mockResolvedValueOnce({ allowed: false, reason: 'member override revoked' });
    expect(await authorizeWorkItemDispatch(request)).toEqual({ allowed: false, reason: 'member override revoked' });
    expect(authorityIO.read).toHaveBeenCalledTimes(2);
  });
  it('stops before fleet admission on workspace denial or an unreadable policy', async () => {
    authorityIO.gate.mockResolvedValueOnce({ allowed: false, message: 'workspace revoked' });
    expect(await authorizeWorkItemDispatch(request)).toEqual({ allowed: false, reason: 'workspace revoked' });
    authorityIO.read.mockRejectedValueOnce(new Error('policy read unavailable'));
    await expect(authorizeWorkItemDispatch(request)).rejects.toThrow('policy read unavailable');
    expect(authorityIO.fleet).not.toHaveBeenCalled();
  });
});

describe('assignAndWakeActionableWorkItems', () => {
  it('preserves authenticated instructions in the wake rather than dropping them after assignment', async () => {
    const d = deps();
    await assignAndWakeActionableWorkItems({
      workItemIds: ['WI-original'], targetAgent: 'reviewer',
      summary: 'Review original item', instructions: 'Independent review only; no source changes.',
    }, d);
    expect(d.wake).toHaveBeenCalledWith(['reviewer'], expect.objectContaining({
      summary: 'Review original item',
      payload: { kind: 'actionable-work-item-dispatch', workItemIds: ['WI-original'], instructions: 'Independent review only; no source changes.' },
    }));
  });
  it('rechecks the original durable caller after target resolution and readiness, before claiming', async () => {
    let authorized = true;
    const d = deps({
      observe: vi.fn(async (id) => {
        authorized = false;
        return { item: workItem(id), available: true, claimedBy: null };
      }),
    });
    const beforeMutate = vi.fn(async () => { if (!authorized) throw new Error('original caller revoked'); });
    await expect(assignAndWakeActionableWorkItems({
      workItemIds: ['WI-original'], targetAgent: 'reviewer', beforeMutate,
    }, d)).rejects.toThrow('original caller revoked');
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.wake).not.toHaveBeenCalled();
  });

  it('retains committed assignment but stops before wake if original authorization changes during claim', async () => {
    let authorized = true;
    const d = deps({
      claim: vi.fn(async (id, assignee) => {
        authorized = false;
        return workItem(id, 'open', assignee);
      }),
    });
    const beforeMutate = vi.fn(async () => { if (!authorized) throw new Error('original caller revoked'); });
    await expect(assignAndWakeActionableWorkItems({
      workItemIds: ['WI-original'], targetAgent: 'reviewer', beforeMutate,
    }, d)).rejects.toThrow('original caller revoked');
    expect(d.claim).toHaveBeenCalledTimes(1);
    expect(d.wake).not.toHaveBeenCalled();
    expect(beforeMutate).toHaveBeenCalledTimes(2);
  });

  it('rechecks authorization for retained work before spending another wake', async () => {
    const d = deps({
      observe: vi.fn(async (id) => ({ item: workItem(id, 'wip', 'reviewer'), available: false, claimedBy: 'reviewer' })),
    });
    await expect(assignAndWakeActionableWorkItems({
      workItemIds: ['WI-original'], targetAgent: 'reviewer',
      beforeMutate: async () => { throw new Error('retained request revoked'); },
    }, d)).rejects.toThrow('retained request revoked');
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.wake).not.toHaveBeenCalled();
  });

  it('persists the stable name while waking the live session that adopted it', async () => {
    const claim = vi.fn(async (id: string, assignee: string) => workItem(id, 'open', assignee));
    const wake = vi.fn(async (owners: readonly string[]) => ({
      targets: [...owners],
      keys: owners.map((owner) => `coord:inbox-wake:${owner}`),
      queued: 1,
      woken: 1,
      pickupConfirmed: false as const, pickup: [],
      staged: 0,
      stagedTargets: [],
      fanoutCapped: [],
      timedOutTargets: [],
    }));
    const d = deps({
      claim,
      wake,
      resolveTarget: vi.fn(async () => target('su-email-live', { requested: 'email-agent' })),
    });

    const result = await assignAndWakeActionableWorkItems(
      { workItemIds: ['WI-READY'], targetAgent: 'email-agent', harness: 'email' },
      d,
    );

    expect(claim).toHaveBeenCalledWith('WI-READY', 'email-agent', { harness: 'email' });
    expect(wake).toHaveBeenCalledWith(
      ['su-email-live'],
      expect.objectContaining({ payload: { kind: 'actionable-work-item-dispatch', workItemIds: ['WI-READY'] } }),
    );
    expect(result.assignment.targetAgent).toBe('email-agent');
    expect(result.target.ownerId).toBe('su-email-live');
  });

  it('does not wake when every requested descendant is still plan-blocked', async () => {
    const wake = vi.fn();
    const d = deps({
      wake,
      observe: vi.fn(async (id) => ({
        item: workItem(id),
        available: false,
        claimedBy: null,
        planItemBlocked: {
          reason: 'plan-item run#P-002 is effectively blocked (blocked-by: P-001)',
          planSlug: 'run',
          itemId: 'P-002',
          effectiveStatus: 'blocked',
        },
      })),
    });

    const result = await assignAndWakeActionableWorkItems(
      { workItemIds: ['WI-BLOCKED'], targetAgent: 'agent-email-stable' },
      d,
    );

    expect(result.ok).toBe(true);
    expect(result.assignment.skipped[0]?.code).toBe('plan_lane_blocked');
    expect(result.wake).toBeNull();
    expect(wake).not.toHaveBeenCalled();
    expect(result.warning).toMatch(/remain unassigned.*not woken/i);
  });

  it('replays an already-held runnable item without re-claiming, then wakes once', async () => {
    const claim = vi.fn();
    const wake = vi.fn(async (owners: readonly string[]) => ({
      targets: [...owners],
      keys: owners.map((owner) => `coord:inbox-wake:${owner}`),
      queued: 1,
      woken: 1,
      pickupConfirmed: false as const, pickup: [],
      staged: 0,
      stagedTargets: [],
      fanoutCapped: [],
      timedOutTargets: [],
    }));
    const d = deps({
      claim,
      wake,
      observe: vi.fn(async (id) => ({
        item: workItem(id, 'wip', 'agent-email-stable'),
        available: false,
        claimedBy: 'agent-email-stable',
      })),
    });

    const result = await assignAndWakeActionableWorkItems(
      { workItemIds: ['WI-RUNNING'], targetAgent: 'agent-email-stable' },
      d,
    );

    expect(claim).not.toHaveBeenCalled();
    expect(result.assignment.retained).toEqual(['WI-RUNNING']);
    expect(result.assignment.executionWorkItemIds).toEqual(['WI-RUNNING']);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.failure).toBeUndefined();
  });

  it('suppresses a duplicate successor wake when a concurrent path already retained the item', async () => {
    const wake = vi.fn();
    const d = deps({
      wake,
      observe: vi.fn(async (id) => ({
        item: workItem(id, 'open', 'agent-email-stable'),
        available: false,
        claimedBy: 'agent-email-stable',
      })),
    });

    const result = await assignAndWakeActionableWorkItems(
      { workItemIds: ['WI-SUCCESSOR'], targetAgent: 'agent-email-stable', wakeRetained: false },
      d,
    );

    expect(result.assignment.retained).toEqual(['WI-SUCCESSOR']);
    expect(result.wake).toBeNull();
    expect(wake).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.warning).toMatch(/duplicate wake suppressed/i);
  });

  it('keeps a landed assignment recoverable and fails loudly when the stable target is dead', async () => {
    const d = deps({
      resolveTarget: vi.fn(async ({ targetAgent }) => target(targetAgent, { sessionState: 'ended', wakeable: false })),
      wake: vi.fn(async (owners: readonly string[]) => ({
        targets: [...owners],
        keys: owners.map((owner) => `coord:inbox-wake:${owner}`),
        queued: 0,
        woken: 0,
        pickupConfirmed: false as const, pickup: [],
        staged: 0,
        stagedTargets: [],
        fanoutCapped: [],
        timedOutTargets: [],
      })),
    });

    const result = await assignAndWakeActionableWorkItems(
      { workItemIds: ['WI-READY'], targetAgent: 'agent-email-stable' },
      d,
    );

    expect(result.assignment.assigned).toEqual(['WI-READY']);
    expect(result.ok).toBe(false);
    expect(result.failure).toMatchObject({
      code: 'target_dead',
      target: 'agent-email-stable',
      recoverable: true,
      queuePreserved: true,
    });
    expect(result.warning).toMatch(/must be relaunched/i);
  });

  it('trusts an authoritative queued wake when the best-effort presence read missed the target', async () => {
    const d = deps({
      resolveTarget: vi.fn(async ({ targetAgent }) =>
        target(targetAgent, { present: false, sessionState: null, wakeable: null }),
      ),
    });

    const result = await assignAndWakeActionableWorkItems(
      { workItemIds: ['WI-READY'], targetAgent: 'agent-email-stable' },
      d,
    );

    expect(result.assignment.assigned).toEqual(['WI-READY']);
    expect(result.wake?.queued).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.failure).toBeUndefined();
  });

  // WI-6554700010010397: a stable name whose every adopter ended used to fail as a
  // generic target_absent naming one dead session id, which hid the repair.
  describe('when the wake reaches nobody', () => {
    const unreached = () =>
      vi.fn(async (owners: readonly string[]) => ({
        targets: [...owners],
        keys: owners.map((owner) => `coord:inbox-wake:${owner}`),
        queued: 0,
        woken: 0,
        pickupConfirmed: false as const,
        pickup: [],
        staged: 0,
        stagedTargets: [],
        fanoutCapped: [],
        timedOutTargets: [],
      }));

    it('names the stable agent name and its ended adopters as target_adopter_gone', async () => {
      const d = deps({
        resolveTarget: vi.fn(async () => ({
          requested: 'bug-triage',
          ownerId: 'su-newest-dead',
          present: false,
          sessionState: null,
          wakeable: false,
          adoptedBy: ['su-newest-dead', 'su-a', 'su-b', 'su-c', 'su-d'],
        })),
        wake: unreached(),
      });

      const result = await assignAndWakeActionableWorkItems(
        { workItemIds: ['WI-READY'], targetAgent: 'bug-triage' },
        d,
      );

      expect(result.ok).toBe(false);
      expect(result.assignment.assigned).toEqual(['WI-READY']);
      expect(result.failure).toMatchObject({
        code: 'target_adopter_gone',
        target: 'bug-triage',
        recoverable: true,
        queuePreserved: true,
      });
      expect(result.failure?.message).toContain('agent name "bug-triage"');
      expect(result.failure?.message).toContain('su-newest-dead, su-a, su-b, +2 more');
      expect(result.failure?.message).toContain('plan_items:adopt_name { name: "bug-triage" }');
    });

    it('keeps target_absent for a raw owner id that was never adopted as a name', async () => {
      const d = deps({
        resolveTarget: vi.fn(async ({ targetAgent }) =>
          target(targetAgent, { present: false, sessionState: null, wakeable: false }),
        ),
        wake: unreached(),
      });

      const result = await assignAndWakeActionableWorkItems({ workItemIds: ['WI-READY'], targetAgent: 'su-raw' }, d);

      expect(result.failure).toMatchObject({ code: 'target_absent', target: 'su-raw' });
    });
  });
});

describe('resolveStableAgentTarget', () => {
  function targetDeps(rows: Array<Record<string, unknown>>): StableAgentTargetDeps {
    return {
      // `as const` keeps `scope` at its literal type: ResolvedPresenceScope.scope is the union
      // 'hive'|'workspace'|'all', and an inferred `string` is not assignable to it.
      resolveScope: vi.fn(async () => ({ scope: 'workspace' as const, wsId: 'ws', potId: null })),
      listSessions: vi.fn(async () => [
        {
          workspaceId: 'ws',
          sessionOwnerId: 'su-newest-dead',
          agentName: 'email-agent',
          ownerUser: 'alice',
          adoptedAt: '2026-08-25T20:00:00Z',
        },
        {
          workspaceId: 'ws',
          sessionOwnerId: 'su-live',
          agentName: 'email-agent',
          ownerUser: 'alice',
          adoptedAt: '2026-08-25T19:00:00Z',
        },
      ]),
      snapshot: vi.fn(async () => ({
        as_of: '2026-08-25T20:00:00Z',
        scope: 'workspace',
        summary: {
          active: rows.length,
          stale: 0,
          federated: 0,
          wakeable: 1,
          onDesktop: 0,
          viewerAttached: 0,
          byState: { live: 1, parked: 0, ended: 0, recorded: 0 },
          byContextPressure: { high: 0, critical: 0 },
        },
        active: rows,
        etag: 'etag',
      })),
    };
  }

  it('resolves a stable name to a live adopting session', async () => {
    const result = await resolveStableAgentTarget(
      { targetAgent: 'email-agent', workspaceId: 'ws', harness: 'email' },
      targetDeps([{ ownerId: 'su-live', sessionState: 'parked', wakeable: true }]),
    );

    expect(result).toEqual({
      requested: 'email-agent',
      ownerId: 'su-live',
      present: true,
      sessionState: 'parked',
      wakeable: true,
    });
  });

  it('keeps the newest durable adoption as the recovery target when no adopting session is live', async () => {
    const result = await resolveStableAgentTarget(
      { targetAgent: 'email-agent', workspaceId: 'ws', harness: 'email' },
      targetDeps([]),
    );

    expect(result).toMatchObject({
      requested: 'email-agent',
      ownerId: 'su-newest-dead',
      present: false,
      wakeable: false,
      adoptedBy: ['su-newest-dead', 'su-live'],
    });
  });

  it('falls back to the requested raw owner id without selecting an unrelated roster row', async () => {
    const d = targetDeps([
      { ownerId: 'su-unrelated', sessionState: 'live', wakeable: true },
      { ownerId: 'su-direct', sessionState: 'parked', wakeable: true },
    ]);
    d.listSessions = vi.fn(async () => []);

    const result = await resolveStableAgentTarget({ targetAgent: 'su-direct', workspaceId: 'ws', harness: 'email' }, d);

    expect(result.ownerId).toBe('su-direct');
    expect(d.snapshot).toHaveBeenCalledWith(expect.objectContaining({ wsId: 'ws' }), { owner: 'su-direct' });
  });

  it('carries the presence userId for raw-owner cross-user checks', async () => {
    const d = targetDeps([{ ownerId: 'su-direct', userId: 'alice', sessionState: 'live', wakeable: true }]);
    d.listSessions = vi.fn(async () => []);

    const result = await resolveStableAgentTarget({ targetAgent: 'su-direct', workspaceId: 'ws', harness: 'email' }, d);

    expect(result).toMatchObject({
      requested: 'su-direct',
      ownerId: 'su-direct',
      present: true,
      sessionState: 'live',
      wakeable: true,
      userId: 'alice',
    });
  });
});

describe('EI-226378 legacy fleet-scope recovery propagation', () => {
  it('carries the server-minted capability from authorization into the claim writer', async () => {
    const legacyFleetScopeDowngradeAdmission = {
      itemId: 'EI-recovery',
      target: 'stable-reviewer',
      workspaceId: 'fixture-workspace',
      leaderOwnerId: 'su-leader',
      requestedAssignee: 'stable-reviewer',
      reportedBy: 'su-leader',
      fleet: 'recovery-fleet',
      code: 'fleet_scope_violation',
      at: new Date().toISOString(),
    };
    const claim = vi.fn(async (id: string, assignee: string) => workItem(id, 'open', assignee));
    const d = deps({
      claim,
      authorize: vi.fn(async () => ({ allowed: true as const, legacyFleetScopeDowngradeAdmission })),
    });

    await assignActionableWorkItems({
      workItemIds: ['EI-recovery'],
      targetAgent: 'stable-reviewer',
      harness: 'email',
      workspaceId: 'fixture-workspace',
    }, d);

    expect(claim).toHaveBeenCalledWith('EI-recovery', 'stable-reviewer', {
      harness: 'email',
      legacyFleetScopeDowngradeAdmission,
    });
  });
});

// WI-10005197: the fail-closed dispatch skips that no caller can lift by retrying carry a
// RefusalContract, so the recipient learns what was observed, what lifts the refusal and who
// can lift it. The additive `refusal` field must never replace the existing code/reason.
describe('dispatch skip refusal contracts (WI-10005197)', () => {
  it('dependency_blocked names the unresolved blockers and when the refusal lifts', async () => {
    const d = deps({ blockers: vi.fn(async () => [{ ref: 'WI-ROOT-A', kind: 'feature' }, { ref: 'WI-ROOT-B', kind: 'feature' }]) });

    const result = await assignActionableWorkItems(
      { workItemIds: ['WI-BLOCKED'], targetAgent: 'agent-email-stable', harness: 'email' },
      d,
    );

    expect(d.claim).not.toHaveBeenCalled();
    const skipped = result.skipped[0];
    expect(skipped).toMatchObject({ workItemId: 'WI-BLOCKED', code: 'dependency_blocked', blockers: ['WI-ROOT-A', 'WI-ROOT-B'] });
    expect(skipped?.refusal?.observed).toEqual({ workItemId: 'WI-BLOCKED', unresolvedBlockers: 'WI-ROOT-A,WI-ROOT-B' });
    expect(skipped?.refusal?.liftsWhen).toMatch(/terminal state|blocked-by link is removed/);
    expect(skipped?.refusal?.whoCanMakeItTrue).toEqual(['another-agent', 'owner']);
  });

  it('plan_lane_blocked names the plan item and its effective status', async () => {
    const d = deps({
      observe: vi.fn(async (id) => ({
        item: workItem(id),
        available: false,
        claimedBy: null,
        planItemBlocked: {
          reason: 'plan-item run#P-002 is effectively blocked (blocked-by: P-001)',
          planSlug: 'run',
          itemId: 'P-002',
          effectiveStatus: 'blocked',
        },
      })),
    });

    const result = await assignActionableWorkItems({ workItemIds: ['WI-PLAN'], targetAgent: 'agent-email-stable' }, d);

    expect(d.claim).not.toHaveBeenCalled();
    const skipped = result.skipped[0];
    expect(skipped).toMatchObject({
      workItemId: 'WI-PLAN',
      code: 'plan_lane_blocked',
      reason: 'plan-item run#P-002 is effectively blocked (blocked-by: P-001)',
    });
    expect(skipped?.refusal?.observed).toEqual({
      workItemId: 'WI-PLAN',
      planSlug: 'run',
      planItemId: 'P-002',
      effectiveStatus: 'blocked',
    });
    expect(skipped?.refusal?.liftsWhen).toMatch(/no longer blocked/);
    expect(skipped?.refusal?.whoCanMakeItTrue).toEqual(['another-agent', 'owner']);
  });

  it('authority_denied names the target and actor, and the claim spec that would admit the item', async () => {
    const d = deps({
      authorize: vi.fn(async () => ({ allowed: false as const, reason: 'effective member override denies this exact id' })),
    });

    const result = await assignActionableWorkItems(
      { workItemIds: ['WI-DENIED'], targetAgent: 'agent-email-stable', actor: 'su-leader', harness: 'email' },
      d,
    );

    expect(d.claim).not.toHaveBeenCalled();
    const skipped = result.skipped[0];
    expect(skipped).toMatchObject({
      workItemId: 'WI-DENIED',
      code: 'authority_denied',
      reason: 'effective member override denies this exact id',
    });
    expect(skipped?.refusal?.observed).toEqual({
      workItemId: 'WI-DENIED',
      targetAgent: 'agent-email-stable',
      actor: 'su-leader',
    });
    expect(skipped?.refusal?.liftsWhen).toMatch(/scheduler:set_claim_spec/);
    expect(skipped?.refusal?.whoCanMakeItTrue).toEqual(['another-agent', 'owner']);
  });
});
