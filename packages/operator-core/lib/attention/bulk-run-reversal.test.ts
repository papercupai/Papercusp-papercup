import { describe, expect, it, vi } from 'vitest';
import type { TransactionSql } from 'postgres';
import type { BulkRunItemRow } from './bulk-run-store';
import {
  compensateAttentionBulkRunItem,
  restoreWorkItemOwnerGateForCompensation,
  type AttentionBulkReversalDependencies,
} from './bulk-run-reversal';
import type { WorkItem } from '../work-items';

function item(kind: string, ref: Record<string, unknown>): BulkRunItemRow {
  return {
    runId: 'run-1',
    itemId: `${kind}:1`,
    position: 0,
    kind,
    title: kind,
    ref: { kind, ...ref },
    ownerAgentId: 'source-agent',
    outcome: 'auto_resolved',
    actionId: kind === 'coord-message' ? 'ack' : 'resolve',
    rationale: 'high confidence',
    draftAnswer: null,
    confidence: 'high',
    consulted: false,
    consultReply: null,
    error: null,
    decidedAt: '2026-09-01T00:00:00.000Z',
    revertHandle: { kind: 'attention-bulk-item' },
    reversalWindowUntil: '2026-09-02T00:00:00.000Z',
    revertedAt: null,
    revertNote: null,
  };
}

function harness() {
  const reopenEscalation = vi.fn(async () => ({}) as never);
  const appendUnack = vi.fn(async () => ({}) as never);
  const clearTriage = vi.fn(async () => {});
  const reopenSessionGate = vi.fn(async () => 'reopened' as const);
  const reopenConversation = vi.fn(async () => 'reopened' as const);
  const restorePlanItemStatus = vi.fn(async () => 'restored' as const);
  const reopenImprovement = vi.fn(async () => 'reopened' as const);
  const restoreWorkItemOwnerGate = vi.fn(async () => 'restored' as const);
  const deps: AttentionBulkReversalDependencies = {
    reopenEscalation,
    appendUnack,
    clearTriage,
    reopenSessionGate,
    reopenConversation,
    restorePlanItemStatus,
    reopenImprovement,
    restoreWorkItemOwnerGate,
    compensateIntake: vi.fn(async () => ({ outcome: 'reversed' as const, note: 'reversed intake decision' })),
  };
  const sql = (async () => [{ triaged_by: 'resolver-1' }]) as unknown as TransactionSql;
  return {
    deps,
    sql,
    reopenEscalation,
    appendUnack,
    clearTriage,
    reopenSessionGate,
    reopenConversation,
    restorePlanItemStatus,
    reopenImprovement,
    restoreWorkItemOwnerGate,
  };
}

describe('compensateAttentionBulkRunItem', () => {
  it('reopens a coordination escalation and then clears its bulk triage record', async () => {
    const h = harness();
    const note = await compensateAttentionBulkRunItem(
      item('coord-escalation', { msgId: 'esc-1' }),
      'ws-1',
      h.sql,
      h.deps,
    );

    expect(h.reopenEscalation).toHaveBeenCalledWith({
      msg_id: 'esc-1',
      by: 'resolver-1',
      note: 'Undo bulk run run-1/coord-escalation:1',
    });
    expect(h.clearTriage).toHaveBeenCalledWith('coord-escalation:1', 'ws-1', h.sql);
    expect(note).toContain('reopen compensation');
  });

  it('appends a deterministic unack as the same principal that authored the ack', async () => {
    const h = harness();
    const note = await compensateAttentionBulkRunItem(item('coord-message', { msgId: 'msg-1' }), 'ws-1', h.sql, h.deps);

    expect(h.appendUnack).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'resolver-1', workspaceId: 'ws-1' }),
      'msg-1',
      'source-agent',
      undefined,
      'unack-run-1-coord-message:1',
    );
    expect(h.clearTriage).toHaveBeenCalledWith('coord-message:1', 'ws-1', h.sql);
    expect(note).toContain('unack compensation');
  });

  it('keeps acknowledgement-only items on the atomic triage-clear path', async () => {
    const h = harness();
    const note = await compensateAttentionBulkRunItem(
      item('operator-report', { turnId: 'turn-1' }),
      'ws-1',
      h.sql,
      h.deps,
    );

    expect(h.reopenEscalation).not.toHaveBeenCalled();
    expect(h.appendUnack).not.toHaveBeenCalled();
    expect(h.clearTriage).toHaveBeenCalledWith('operator-report:1', 'ws-1', h.sql);
    expect(note).toContain('cleared acknowledgement triage');
  });

  it('reopens the exact blocked-session gate inside the receipt transaction', async () => {
    const h = harness();
    const note = await compensateAttentionBulkRunItem(
      item('blocked-session', { sessionId: 'sess-1', client: 'codex', refId: 'ref-1' }),
      'ws-1',
      h.sql,
      h.deps,
    );

    expect(h.reopenSessionGate).toHaveBeenCalledWith(
      {
        workspaceId: 'ws-1',
        sessionId: 'sess-1',
        refId: 'ref-1',
        expectedClosedReason: 'hook_cleared',
      },
      h.sql,
    );
    expect(h.clearTriage).toHaveBeenCalledWith('blocked-session:1', 'ws-1', h.sql);
    expect(note).toContain('reopened blocked session gate');
  });

  it('reopens a conversation against the exact recorded bulk answer', async () => {
    const h = harness();
    const row = item('conversation', { conversationId: 'conv-1' });
    row.rationale = 'owner no longer needs to answer';
    const note = await compensateAttentionBulkRunItem(row, 'ws-1', h.sql, h.deps);

    expect(h.reopenConversation).toHaveBeenCalledWith(
      {
        workspaceId: 'ws-1',
        conversationId: 'conv-1',
        expectedAnswer: 'owner no longer needs to answer',
      },
      h.sql,
    );
    expect(h.clearTriage).toHaveBeenCalledWith('conversation:1', 'ws-1', h.sql);
    expect(note).toContain('reopened conversation');
  });

  it('uses the persisted draft answer as the conversation compare-and-set value', async () => {
    const h = harness();
    const row = item('conversation', { conversationId: 'conv-2' });
    row.rationale = 'fallback rationale';
    row.draftAnswer = 'the accepted answer';
    await compensateAttentionBulkRunItem(row, 'ws-1', h.sql, h.deps);

    expect(h.reopenConversation).toHaveBeenCalledWith(
      expect.objectContaining({ expectedAnswer: 'the accepted answer' }),
      h.sql,
    );
  });

  it('restores a plan item only from the terminal status written by its action', async () => {
    const h = harness();
    const row = item('plan-item', {
      slug: 'plan-1',
      itemId: 'P-003',
      harnessSlug: 'papercusp',
      priorStatus: 'needs-human',
    });
    row.actionId = 'drop';
    await compensateAttentionBulkRunItem(row, 'ws-1', h.sql, h.deps);

    expect(h.restorePlanItemStatus).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      slug: 'plan-1',
      itemId: 'P-003',
      expectedStatus: 'dropped',
      priorStatus: 'needs-human',
    });
  });

  it('reopens an improvement against its persisted rationale and prior payload snapshot', async () => {
    const h = harness();
    const row = item('improvement', {
      issueId: 'EI-42',
      priorIdeaLifecycle: { state: 'open' },
      priorDecidedReason: null,
    });
    row.actionId = 'dismiss';
    row.rationale = 'duplicate of EI-12';
    await compensateAttentionBulkRunItem(row, 'ws-1', h.sql, h.deps);

    expect(h.reopenImprovement).toHaveBeenCalledWith({
      id: 'EI-42',
      expectedReason: 'duplicate of EI-12',
      priorIdeaLifecycle: { state: 'open' },
      priorDecidedReason: null,
    });
  });

  // P-009 (D-019): an applied intake decision is inverted by intake-compensation,
  // never by the generic improvement reopen, and a failed inverse is not hidden.
  it('routes an apply-intake item to the intake inverse inside the receipt transaction', async () => {
    const h = harness();
    const decision = {
      disposition: 'promote',
      reason: 'reproduced',
      decidedBy: 'su-reviewer',
      owner: 'engineering',
      targetRef: null,
      missingInformation: null,
      decidedAt: '2026-09-01T00:00:00.000Z',
      workKind: 'fix',
      acceptance: null,
      sourceRevision: 'rev-1',
    } as NonNullable<BulkRunItemRow['intakeDecision']>;
    const row = { ...item('improvement', { issueId: 'EI-42', harnessSlug: 'papercusp' }), intakeDecision: decision };
    row.actionId = 'apply-intake';

    const note = await compensateAttentionBulkRunItem(row, 'ws-1', h.sql, h.deps);

    expect(h.deps.compensateIntake).toHaveBeenCalledWith(
      { sourceId: 'EI-42', harnessSlug: 'papercusp', runId: 'run-1', itemId: 'improvement:1', decision },
      expect.objectContaining({ lockIntake: expect.any(Function), writePayload: expect.any(Function) }),
    );
    expect(h.reopenImprovement).not.toHaveBeenCalled();
    expect(note).toContain('reversed intake decision');

    const failing = harness();
    failing.deps.compensateIntake = vi.fn(async () => {
      throw new Error('intake reversal refused (source-changed): superseded');
    });
    await expect(compensateAttentionBulkRunItem(row, 'ws-1', failing.sql, failing.deps)).rejects.toThrow(
      'source-changed',
    );
    expect(failing.reopenImprovement).not.toHaveBeenCalled();
  });

  it('restores the exact work-item lifecycle and owner-gate dialect', async () => {
    const h = harness();
    const row = item('work-item-needs-human', {
      workItemId: 'WI-9',
      harnessSlug: 'papercusp',
      ownerGate: 'payload',
      priorStatus: 'blocked',
      ownerGateKeys: ['needsHuman'],
    });
    await compensateAttentionBulkRunItem(row, 'ws-1', h.sql, h.deps);

    expect(h.restoreWorkItemOwnerGate).toHaveBeenCalledWith({
      workItemId: 'WI-9',
      harnessSlug: 'papercusp',
      ownerGate: 'payload',
      priorStatus: 'blocked',
      ownerGateKeys: ['needsHuman'],
    });
  });
});

describe('restoreWorkItemOwnerGateForCompensation', () => {
  function restoreDeps(row: Partial<WorkItem>) {
    const getWorkItem = vi.fn(async () => row as WorkItem);
    const setWorkItemState = vi.fn(async (_id, state) => ({ ...row, state }) as WorkItem);
    const mergeWorkItemPayload = vi.fn(async () => row as WorkItem);
    return { getWorkItem, setWorkItemState, mergeWorkItemPayload };
  }

  it('restores the exact legacy payload gate without changing lifecycle state', async () => {
    const deps = restoreDeps({ id: 'EI-7', state: 'blocked', payload: {} });
    expect(
      await restoreWorkItemOwnerGateForCompensation(
        {
          workItemId: 'EI-7',
          harnessSlug: 'papercusp',
          ownerGate: 'payload',
          priorStatus: 'blocked',
          ownerGateKeys: ['needsHuman'],
        },
        deps,
      ),
    ).toBe('restored');
    expect(deps.setWorkItemState).not.toHaveBeenCalled();
    expect(deps.mergeWorkItemPayload).toHaveBeenCalledWith(
      'EI-7',
      { needsHuman: true },
      { harness: 'papercusp', unset: ['needsOwnerAction'] },
    );
  });

  it('restores a status gate and refuses a newer lifecycle', async () => {
    const deps = restoreDeps({ id: 'WI-8', state: 'open', payload: {} });
    expect(
      await restoreWorkItemOwnerGateForCompensation(
        {
          workItemId: 'WI-8',
          ownerGate: 'status',
          priorStatus: 'needs-human',
          ownerGateKeys: ['needsOwnerAction'],
        },
        deps,
      ),
    ).toBe('restored');
    expect(deps.setWorkItemState).toHaveBeenCalledWith(
      'WI-8',
      'needs-human',
      expect.objectContaining({ by: 'autonomy-revert', allowNonCanonical: true }),
    );

    const changed = restoreDeps({ id: 'WI-8', state: 'wip', payload: {} });
    expect(
      await restoreWorkItemOwnerGateForCompensation(
        {
          workItemId: 'WI-8',
          ownerGate: 'status',
          priorStatus: 'needs-human',
          ownerGateKeys: ['needsOwnerAction'],
        },
        changed,
      ),
    ).toBe('source_changed');
    expect(changed.setWorkItemState).not.toHaveBeenCalled();
  });
});
