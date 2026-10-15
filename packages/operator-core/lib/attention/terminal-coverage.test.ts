/**
 * The P-003 terminal-coverage AUDIT, as an executable guard.
 *
 * The audit this plan item asked for is "does every AttentionKind expose a
 * terminal action". Written as a document that answer is stale the day a kind is
 * added; written as this test it cannot go stale, because it DERIVES the answer
 * from the two pieces of code that actually decide it:
 *
 *   1. the real adapters — which actions each kind offers, and
 *   2. the real dispatcher — whether any of those actions has a branch that
 *      resolves.
 *
 * `ATTENTION_TERMINAL_POLICY` states only the part code cannot: which CLASS of
 * disposition is correct for the kind. This test is the pin that keeps that
 * judgment honest against the implementation (derived-truth ladder rung 2 over a
 * rung 4 map).
 *
 * The failure it exists to prevent is not hypothetical. Before P-003, 9 of 15
 * kinds offered nothing terminal — including `work-item-needs-human` (46% of the
 * live bulk-run ledger) and `dark-flag-ratification` (14%) — which is why the
 * resolver could terminally dispose of ~17% of the queue no matter how confident
 * or how widely authorised it was.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  blockedSessionToAttention,
  blockedWorkItemToAttention,
  conversationToAttention,
  coordEscalationToAttention,
  coordMessageToAttention,
  darkFlagRatificationToAttention,
  decisionOwedToAttention,
  unhandledDirectiveToAttention,
  improvementToAttention,
  operatorReportToAttention,
  ownerWallToAttention,
  planItemToAttention,
  scoutGradeToAttention,
  smokeFailToAttention,
  standingApprovalToAttention,
  workItemNeedsHumanToAttention,
} from './adapters';
import {
  dispatchAttentionTerminalAction,
  type TerminalActionDependencies,
  type TerminalAttentionItem,
} from './terminal-action-dispatch';
import {
  ATTENTION_DELEGATIONS,
  ATTENTION_TERMINAL_POLICY,
  isAttentionDelegation,
  terminalPolicyFor,
} from './terminal-coverage';
import { ATTENTION_KIND_AUTHORITY, isTerminalActionId, type AttentionItem, type AttentionKind } from './types';

/** One representative item per kind, built by the REAL adapters — never a
 *  hand-written literal, which would let the fixture drift from what the reader
 *  actually emits and report coverage the owner does not have. */
const FIXTURES: Record<AttentionKind, AttentionItem> = {
  'plan-item': planItemToAttention({
    slug: 'p',
    id: 'P-001',
    harnessSlug: 'papercusp',
    text: 'decide',
    storedStatus: 'needs-human',
    effectiveStatus: 'needs-human',
    importance: 'normal',
  }),
  'coord-escalation': coordEscalationToAttention({
    msgId: 'm1',
    severity: 'blocker',
    summary: 'blocked',
  }),
  'coord-message': coordMessageToAttention({ msgId: 'm2', summary: 'fyi' }),
  'smoke-fail': smokeFailToAttention({ harnessSlug: 'papercusp' }),
  'operator-report': operatorReportToAttention({
    turnId: 't1',
    conversationId: 'c1',
    report: { title: 'r', plans: [] } as never,
  }),
  improvement: improvementToAttention({ issueId: 'EI-1', title: 'idea' }),
  'standing-approval': standingApprovalToAttention({
    capability: 'cap',
    targetHarness: 'papercusp',
    count: 3,
  }),
  conversation: conversationToAttention({ conversationId: 'cv1', title: 'q?' }),
  'scout-grade': scoutGradeToAttention({ count: 4 }),
  'work-item-needs-human': workItemNeedsHumanToAttention({
    workItemId: 'EI-2',
    itemKind: 'bug',
    title: 'needs you',
    harnessSlug: 'papercusp',
  }),
  'owner-wall': ownerWallToAttention({
    source: 'work-item',
    ownerId: null,
    claim: 'needs a credential',
    ref: 'EI-3',
    status: 'waiting',
    harnessSlug: 'papercusp',
  }),
  'dark-flag-ratification': darkFlagRatificationToAttention({ flagKey: 'SOME_FLAG' }),
  'blocked-session': blockedSessionToAttention({
    sessionId: 's1',
    client: 'claude',
    refId: 'r1',
    gateKind: 'ask',
  }),
  'work-item-blocked': blockedWorkItemToAttention({
    workItemId: 'EI-4',
    itemKind: 'bug',
    title: 'stuck',
    reason: 'waiting on dep',
  }),
  'decision-owed': decisionOwedToAttention({
    sessionId: 's2',
    refId: 'r2',
    client: 'claude',
    question: 'ship it?',
    ownerAgentId: null,
    harnessSlug: null,
    closedAt: new Date().toISOString(),
  }),
  'unhandled-directive': unhandledDirectiveToAttention({
    directiveId: 7,
    displayText: '"ship it"',
    recordedBy: 'su-ended',
    why: 'no-fleet',
    fleetSlug: null,
    createdAt: new Date().toISOString(),
  }),
};

const ALL_KINDS = Object.keys(FIXTURES) as AttentionKind[];

/** The dep surface, every method a spy — so a probe reports not just THAT the
 *  dispatcher resolved but WHICH effect it reached, which is the whole basis of
 *  the source-mutating vs acknowledgement assertion below. */
function spyDeps() {
  const deps = {
    resolveEscalation: vi.fn(async () => {}),
    acknowledgeMessage: vi.fn(async () => {}),
    setPlanItemStatus: vi.fn(async () => {}),
    wakePlanLoop: vi.fn(async () => {}),
    dismissImprovement: vi.fn(async () => {}),
    decideStandingApproval: vi.fn(async () => {}),
    triageAttentionItem: vi.fn(async () => {}),
    clearWorkItemOwnerGate: vi.fn(async () => {}),
    retractStandingFact: vi.fn(async () => {}),
    closeWorkItem: vi.fn(async () => {}),
    resolveConversation: vi.fn(async () => {}),
    closeSessionGate: vi.fn(async () => {}),
  } satisfies TerminalActionDependencies;
  return deps;
}

/** Every dep EXCEPT the shared triage record — reaching one of these is what
 *  makes a disposition source-mutating rather than a suppression overlay. */
function sourceMutatingCalls(deps: ReturnType<typeof spyDeps>): number {
  return Object.entries(deps)
    .filter(([name]) => name !== 'triageAttentionItem' && name !== 'wakePlanLoop')
    .reduce((total, [, spy]) => total + spy.mock.calls.length, 0);
}

function asTerminalItem(item: AttentionItem): TerminalAttentionItem {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    harnessSlug: item.harnessSlug,
    planSlug: item.planSlug,
    ownerAgentId: item.ownerAgentId,
    ref: item.ref as TerminalAttentionItem['ref'],
  };
}

function terminalActionIds(item: AttentionItem): string[] {
  return (item.actions ?? []).map((a) => a.id).filter(isTerminalActionId);
}

describe('P-003 terminal-action coverage audit', () => {
  it('declares a policy for exactly the live AttentionKind set', () => {
    expect(Object.keys(ATTENTION_TERMINAL_POLICY).sort()).toEqual(Object.keys(ATTENTION_KIND_AUTHORITY).sort());
    // The fixtures are the audit's instrument; a kind with no fixture is a kind
    // this test silently stops covering.
    expect(ALL_KINDS.sort()).toEqual(Object.keys(ATTENTION_KIND_AUTHORITY).sort());
  });

  it('every kind offers at least one TERMINAL action — the 17%-ceiling regression guard', () => {
    const uncovered = ALL_KINDS.filter((kind) => terminalActionIds(FIXTURES[kind]).length === 0);
    expect(
      uncovered,
      `these kinds offer only navigate actions, so neither the owner's click nor the ` +
        `resolver can ever end them: ${uncovered.join(', ')}`,
    ).toEqual([]);
  });

  it.each(ALL_KINDS)('%s: every offered terminal action actually dispatches', async (kind) => {
    const item = FIXTURES[kind];
    const ids = terminalActionIds(item);
    expect(ids.length, `${kind} offers no terminal action`).toBeGreaterThan(0);

    for (const actionId of ids) {
      const deps = spyDeps();
      const result = await dispatchAttentionTerminalAction({
        item: asTerminalItem(item),
        actionId,
        deps,
        rationale: 'audit probe',
      });
      expect(
        result.resolved,
        `${kind} offers "${actionId}" but the dispatcher has no branch for it — the ` +
          `option would commit in the UI and resolve nothing`,
      ).toBe(true);
    }
  });

  it.each(ALL_KINDS)('%s: dispatch matches its declared disposition class', async (kind) => {
    const policy = terminalPolicyFor(kind);
    expect(policy).not.toBeNull();
    const item = FIXTURES[kind];

    let sawSourceMutation = false;
    let sawAcknowledgement = false;
    for (const actionId of terminalActionIds(item)) {
      const deps = spyDeps();
      await dispatchAttentionTerminalAction({
        item: asTerminalItem(item),
        actionId,
        deps,
        rationale: 'audit probe',
      });
      if (sourceMutatingCalls(deps) > 0) sawSourceMutation = true;
      if (deps.triageAttentionItem.mock.calls.length > 0) sawAcknowledgement = true;
    }

    if (policy!.class === 'source-mutating') {
      expect(
        sawSourceMutation,
        `${kind} is declared source-mutating (${policy!.why}) but no terminal action ` +
          `writes its source — a card that only takes a triage record here would vanish ` +
          `from the inbox while the underlying state still demands a human`,
      ).toBe(true);
    } else if (policy!.class === 'acknowledgement') {
      expect(
        sawAcknowledgement,
        `${kind} is declared acknowledgement (${policy!.why}) but its terminal action ` +
          `records no durable triage — nothing would suppress it on the next read`,
      ).toBe(true);
      expect(
        sawSourceMutation,
        `${kind} is declared acknowledgement but a terminal action mutates a source; ` +
          `re-classify it rather than leaving the map lying`,
      ).toBe(false);
    }
  });
});

describe('P-005 delegation-axis audit', () => {
  it('derives the public authority map from the one terminal-policy registry', () => {
    expect(ATTENTION_KIND_AUTHORITY).toEqual(
      Object.fromEntries(Object.entries(ATTENTION_TERMINAL_POLICY).map(([kind, policy]) => [kind, policy.authority])),
    );
    expect(new Set(Object.values(ATTENTION_KIND_AUTHORITY))).toEqual(new Set(ATTENTION_DELEGATIONS));
  });

  it('CONTROL: rejects a deliberately invalid fourth authority rung', () => {
    expect(isAttentionDelegation('delegable')).toBe(true);
    expect(isAttentionDelegation('owner-by-right')).toBe(true);
    expect(isAttentionDelegation('never-auto')).toBe(true);
    expect(isAttentionDelegation('auto-if-confident')).toBe(false);
  });
});

describe('P-003 owner-gate terminals write the SOURCE', () => {
  it('work-item-needs-human resolve clears the owner gate, not just the card', async () => {
    const deps = spyDeps();
    await dispatchAttentionTerminalAction({
      item: asTerminalItem(FIXTURES['work-item-needs-human']),
      actionId: 'resolve',
      deps,
      rationale: 'handled',
    });
    expect(deps.clearWorkItemOwnerGate).toHaveBeenCalledWith({
      workItemId: 'EI-2',
      harnessSlug: 'papercusp',
      statusGated: false,
    });
    expect(deps.triageAttentionItem).not.toHaveBeenCalled();
  });

  it('carries the STATUS leg when the row itself is status-gated', async () => {
    const statusGated = workItemNeedsHumanToAttention({
      workItemId: 'F-9',
      itemKind: 'feature',
      title: 'ratify',
      harnessSlug: 'papercusp',
      status: 'needs-human',
    });
    const deps = spyDeps();
    await dispatchAttentionTerminalAction({
      item: asTerminalItem(statusGated),
      actionId: 'resolve',
      deps,
    });
    expect(deps.clearWorkItemOwnerGate).toHaveBeenCalledWith(
      expect.objectContaining({ workItemId: 'F-9', statusGated: true }),
    );
  });

  it('drop closes the work-item WITH the caller rationale as evidence', async () => {
    const deps = spyDeps();
    await dispatchAttentionTerminalAction({
      item: asTerminalItem(FIXTURES['work-item-needs-human']),
      actionId: 'drop',
      deps,
      rationale: 'superseded by EI-9',
    });
    expect(deps.closeWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({ workItemId: 'EI-2', rationale: 'superseded by EI-9' }),
    );
  });

  it('a terminal close never ships a blank rationale — the state write requires evidence', async () => {
    const deps = spyDeps();
    await dispatchAttentionTerminalAction({
      item: asTerminalItem(FIXTURES['work-item-blocked']),
      actionId: 'drop',
      deps,
      rationale: '   ',
    });
    const [call] = deps.closeWorkItem.mock.calls as unknown as [[{ rationale: string }]];
    expect(call[0].rationale.trim().length).toBeGreaterThan(0);
  });

  it('a work-item-backed owner wall clears the same gate; a carry-note wall acknowledges', async () => {
    const backed = spyDeps();
    await dispatchAttentionTerminalAction({
      item: asTerminalItem(FIXTURES['owner-wall']),
      actionId: 'resolve',
      deps: backed,
      rationale: 'unblocked',
    });
    expect(backed.clearWorkItemOwnerGate).toHaveBeenCalledWith(expect.objectContaining({ workItemId: 'EI-3' }));

    const note = ownerWallToAttention({
      source: 'loop-carry-note',
      ownerId: null,
      claim: 'needs the owner to buy a domain',
      status: 'waiting',
    });
    const carry = spyDeps();
    const result = await dispatchAttentionTerminalAction({
      item: asTerminalItem(note),
      actionId: 'dismiss',
      deps: carry,
      rationale: 'handled out of band',
    });
    expect(result.resolved).toBe(true);
    expect(carry.clearWorkItemOwnerGate).not.toHaveBeenCalled();
    expect(carry.triageAttentionItem).toHaveBeenCalled();
  });

  it('a standing-fact owner wall retracts the exact fact instead of hiding the card', async () => {
    const fact = ownerWallToAttention({
      source: 'standing-fact',
      ownerId: null,
      claim: 'credential is still required',
      ref: 'wall:voice-credential',
      factScope: 'harness',
      factScopeRef: 'papercusp',
      factKey: 'wall:voice-credential',
      status: 'unknown',
    });
    const deps = spyDeps();
    const result = await dispatchAttentionTerminalAction({
      item: asTerminalItem(fact),
      actionId: 'resolve',
      deps,
      rationale: 'credential installed',
    });
    expect(result.resolved).toBe(true);
    expect(deps.retractStandingFact).toHaveBeenCalledWith({
      scope: 'harness',
      scopeRef: 'papercusp',
      key: 'wall:voice-credential',
      reason: 'credential installed',
    });
    expect(deps.triageAttentionItem).not.toHaveBeenCalled();
  });
});

describe('P-010 reversible improvement dismiss', () => {
  it('threads the bulk rationale into the source decision for compare-and-set undo', async () => {
    const deps = spyDeps();
    await dispatchAttentionTerminalAction({
      item: asTerminalItem(FIXTURES.improvement),
      actionId: 'dismiss',
      deps,
      rationale: 'duplicate of EI-12',
    });
    expect(deps.dismissImprovement).toHaveBeenCalledWith({
      issueId: 'EI-1',
      rationale: 'duplicate of EI-12',
    });
  });
});

// observation-candidate-acceptance-promotion-2026-09-30 P-006 (D-014): applying a
// recorded intake decision goes through the injected server executor only.
describe('P-006 apply-intake', () => {
  const decision = {
    disposition: 'promote' as const,
    reason: 'reproduced',
    decidedBy: 'su-reviewer',
    owner: 'engineering' as const,
    targetRef: null,
    missingInformation: null,
    decidedAt: '2026-10-01T10:00:00.000Z',
    workKind: 'fix' as const,
    acceptance: null,
    sourceRevision: 'rev-1',
    reproduction: null,
  };

  it('executes the recorded decision against the improvement source and resolves on effect', async () => {
    const deps = spyDeps();
    const executeIntakeDecision = vi.fn(async () => ({ terminal: true }));
    const recheckIntakeApply = vi.fn(async () => ({ allowed: true }));
    const result = await dispatchAttentionTerminalAction({
      item: asTerminalItem(FIXTURES.improvement),
      actionId: 'apply-intake',
      deps: { ...deps, executeIntakeDecision, recheckIntakeApply },
      intake: { decision, runId: 'run-9' },
    });
    expect(result).toEqual({ resolved: true });
    expect(recheckIntakeApply).toHaveBeenCalledWith({ runId: 'run-9', itemId: FIXTURES.improvement.id });
    expect(recheckIntakeApply.mock.invocationCallOrder[0]).toBeLessThan(
      executeIntakeDecision.mock.invocationCallOrder[0],
    );
    expect(executeIntakeDecision).toHaveBeenCalledWith({
      sourceId: 'EI-1',
      harnessSlug: FIXTURES.improvement.harnessSlug ?? null,
      decision,
      runId: 'run-9',
      itemId: FIXTURES.improvement.id,
    });
    expect(sourceMutatingCalls(deps)).toBe(0);
    expect(deps.triageAttentionItem).not.toHaveBeenCalled();
  });

  it('never resolves without a recorded decision or a server executor, and a refusal propagates', async () => {
    const deps = spyDeps();
    const item = asTerminalItem(FIXTURES.improvement);
    expect(await dispatchAttentionTerminalAction({ item, actionId: 'apply-intake', deps })).toEqual({
      resolved: false,
    });
    expect(
      await dispatchAttentionTerminalAction({ item, actionId: 'apply-intake', deps, intake: { decision, runId: 'r' } }),
    ).toEqual({ resolved: false });
    const allow = vi.fn(async () => ({ allowed: true }));
    const refusing = vi.fn(async () => {
      throw new Error('intake promote refused (source-revision-changed): edited');
    });
    await expect(
      dispatchAttentionTerminalAction({
        item,
        actionId: 'apply-intake',
        deps: { ...deps, executeIntakeDecision: refusing, recheckIntakeApply: allow },
        intake: { decision, runId: 'r' },
      }),
    ).rejects.toThrow('source-revision-changed');
    expect(sourceMutatingCalls(deps)).toBe(0);
  });

  // P-009 (R-31, D-019): the kill switch and the run's stop state are rechecked at
  // application time, immediately before the executor.
  it('fails closed without an application-time recheck, and a refused recheck writes nothing', async () => {
    const deps = spyDeps();
    const item = asTerminalItem(FIXTURES.improvement);
    const executeIntakeDecision = vi.fn(async () => ({ terminal: true }));

    // An executor without the recheck cannot apply intake.
    expect(
      await dispatchAttentionTerminalAction({
        item,
        actionId: 'apply-intake',
        deps: { ...deps, executeIntakeDecision },
        intake: { decision, runId: 'run-9' },
      }),
    ).toEqual({ resolved: false });
    expect(executeIntakeDecision).not.toHaveBeenCalled();

    // Kill switch flipped (or run stopped) after the tool-entry check: refused, nothing executed.
    const killed = vi.fn(async () => ({ allowed: false, reason: 'inbox-bulk-resolve is off (kill switch)' }));
    await expect(
      dispatchAttentionTerminalAction({
        item,
        actionId: 'apply-intake',
        deps: { ...deps, executeIntakeDecision, recheckIntakeApply: killed },
        intake: { decision, runId: 'run-9' },
      }),
    ).rejects.toThrow('intake apply refused at application time: inbox-bulk-resolve is off (kill switch)');
    expect(killed).toHaveBeenCalledWith({ runId: 'run-9', itemId: FIXTURES.improvement.id });
    expect(executeIntakeDecision).not.toHaveBeenCalled();

    const stopped = vi.fn(async () => ({ allowed: false }));
    await expect(
      dispatchAttentionTerminalAction({
        item,
        actionId: 'apply-intake',
        deps: { ...deps, executeIntakeDecision, recheckIntakeApply: stopped },
        intake: { decision, runId: 'run-9' },
      }),
    ).rejects.toThrow('intake apply refused at application time: recheck refused');
    expect(executeIntakeDecision).not.toHaveBeenCalled();
    expect(sourceMutatingCalls(deps)).toBe(0);
  });
});

describe('P-003 conversation close', () => {
  it('a bare close does NOT capture its close note as an answer', async () => {
    const deps = spyDeps();
    await dispatchAttentionTerminalAction({
      item: asTerminalItem(FIXTURES.conversation),
      actionId: 'dismiss',
      deps,
      rationale: 'no longer relevant',
    });
    expect(deps.resolveConversation).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'cv1', capture: 'none' }),
    );
  });

  it("a drafted answer IS captured — the resolver's text finally reaches the source", async () => {
    const deps = spyDeps();
    await dispatchAttentionTerminalAction({
      item: asTerminalItem(FIXTURES.conversation),
      actionId: 'dismiss',
      deps,
      answerText: 'Use the staging port.',
    });
    expect(deps.resolveConversation).toHaveBeenCalledWith({
      conversationId: 'cv1',
      acceptedAnswer: 'Use the staging port.',
      capture: 'mem0',
    });
  });
});

/**
 * FALSIFIABILITY CONTROLS — permanent, deliberately-wrong inputs run through the
 * SAME predicates the audit above uses.
 *
 * Without these, every assertion above passing is equally consistent with "the
 * coverage is real" and "the audit cannot detect a gap". These are the module-tier
 * control from the repo's mutation-probe guidance: never mutate the shared tree to
 * prove a guard bites — keep the wrong implementation here, permanently, beside
 * the right one.
 */
describe('P-003 audit controls — the guard detects the gaps it claims to', () => {
  const navigateOnly: TerminalAttentionItem = {
    id: 'control:navigate-only',
    kind: 'control',
    title: 'a kind that offers only sub-surfaces',
    ref: { kind: 'control-unknown-kind' },
  };

  it('CONTROL: a navigate-only action set reads as UNCOVERED', () => {
    // The exact predicate the coverage assertion uses, against an item whose
    // actions are all navigate ids. If this ever reports coverage, the audit
    // above is measuring nothing.
    const control: AttentionItem = {
      ...(FIXTURES['scout-grade'] as AttentionItem),
      actions: [
        { id: 'open', label: 'Open' },
        { id: 'discuss', label: 'Discuss' },
      ],
    };
    expect(terminalActionIds(control)).toEqual([]);
    // ...while the real fixture it was derived from IS covered — a calibration
    // case, so a predicate that returned [] for everything cannot pass this.
    expect(terminalActionIds(FIXTURES['scout-grade']).length).toBeGreaterThan(0);
  });

  it('CONTROL: an unknown ref kind does NOT resolve, whatever action it is given', async () => {
    for (const actionId of ['resolve', 'drop', 'dismiss', 'ack', 'mark-done']) {
      const deps = spyDeps();
      const result = await dispatchAttentionTerminalAction({ item: navigateOnly, actionId, deps });
      expect(result.resolved, `dispatcher claimed to resolve "${actionId}" on an unknown kind`).toBe(false);
      expect(sourceMutatingCalls(deps) + deps.triageAttentionItem.mock.calls.length).toBe(0);
    }
  });

  it('CONTROL: the class check distinguishes a source write from a triage record', async () => {
    // An acknowledgement-class kind reaches ONLY the triage record...
    const ack = spyDeps();
    await dispatchAttentionTerminalAction({
      item: asTerminalItem(FIXTURES['dark-flag-ratification']),
      actionId: 'dismiss',
      deps: ack,
    });
    expect(sourceMutatingCalls(ack)).toBe(0);
    expect(ack.triageAttentionItem).toHaveBeenCalled();

    // ...and a source-mutating one reaches ONLY its source effect. Both
    // directions asserted, so a `sourceMutatingCalls` that always returned 0 (or
    // always > 0) fails here rather than silently passing the class assertion.
    const src = spyDeps();
    await dispatchAttentionTerminalAction({
      item: asTerminalItem(FIXTURES['work-item-needs-human']),
      actionId: 'resolve',
      deps: src,
    });
    expect(sourceMutatingCalls(src)).toBeGreaterThan(0);
    expect(src.triageAttentionItem).not.toHaveBeenCalled();
  });
});

describe('P-003 does not widen navigation into resolution', () => {
  it.each(['discuss', 'chat', 'open', 'answer', 'view-log', 'message-owner'])(
    '%s stays non-terminal for every kind',
    async (actionId) => {
      for (const kind of ALL_KINDS) {
        const deps = spyDeps();
        const result = await dispatchAttentionTerminalAction({
          item: asTerminalItem(FIXTURES[kind]),
          actionId,
          deps,
        });
        expect(result.resolved, `${actionId} resolved a ${kind} item`).toBe(false);
        expect(sourceMutatingCalls(deps) + deps.triageAttentionItem.mock.calls.length).toBe(0);
      }
    },
  );
});
