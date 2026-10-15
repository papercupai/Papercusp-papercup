import { describe, it, expect, vi } from 'vitest';
import { resolveImprovement, routeExhaustedImprovementToLeaderTriage, type ResolveDeps } from './resolve-core';
import type { EngineerIssue, IssueState } from '../../issues-engineer';

function issue(p: Partial<EngineerIssue> & { id: string }): EngineerIssue {
  return {
    kind: 'bug',
    scope: 'operator',
    title: 'a bug',
    body: '',
    severity: 'major',
    source: 'su',
    state: 'open',
    assignee: 'improvement-runner',
    assignedBy: null,
    assignedAt: '2026-06-05T01:00:00Z',
    parent: null,
    payload: null,
    foundDuring: null,
    linkedFeatureId: null,
    createdBy: null,
    signalOrigin: 'organic',
    assigneeRank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    lastProgressAt: null,
    origin: 'local',
    terminalOwner: null,
    terminalCompletionRef: null,
    featureOrder: null,
    goalId: null,
    createdAt: '2026-06-04T00:00:00Z',
    updatedAt: '2026-06-04T00:00:00Z',
    closedAt: null,
    ...p,
  };
}

interface Recorded {
  comments: { id: string; body: string; by?: string }[];
  states: { id: string; state: IssueState }[];
  released: string[];
  payloads: { id: string; patch: Record<string, unknown> }[];
  /** Dispatch-ledger closes (consume-edges P-010 / B-04). */
  closes: { id: string; outcome: string; by?: string }[];
}

function deps(current: EngineerIssue | null): ResolveDeps & { rec: Recorded } {
  const rec: Recorded = { comments: [], states: [], released: [], payloads: [], closes: [] };
  return {
    rec,
    getIssue: async () => current,
    setIssueState: async (id, state) => {
      rec.states.push({ id, state });
      return current ? { ...current, state } : null;
    },
    commentIssue: async (id, body, by) => {
      rec.comments.push({ id, body, by });
      return null;
    },
    releaseIssue: async (id) => {
      rec.released.push(id);
      return current;
    },
    mergeIssuePayload: async (id, patch) => {
      rec.payloads.push({ id, patch });
      return current;
    },
    enterAgentReview: async ({ id, submittedBy }) => ({
      entered: true,
      state: { status: 'pending', submittedBy, ledgerIdeaId: id, round: 1 },
    }),
    closeDispatches: async (id, opts) => {
      rec.closes.push({ id, outcome: opts.outcome, by: opts.by });
      return 1;
    },
  };
}

describe('resolveImprovement — fixed (the verify-and-mark-done back-edge, close-loop D-001)', () => {
  it('REFUSES fixed without testsRun (verification evidence is mandatory)', async () => {
    const d = deps(issue({ id: 'EI-1' }));
    const r = await resolveImprovement({ id: 'EI-1', outcome: 'fixed', summary: 'changed the thing properly' }, d);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/testsRun/);
    expect(d.rec.states).toHaveLength(0);
  });

  it('fixed + evidence → comments the evidence and marks resolved (the bug LEAVES the queue)', async () => {
    const d = deps(issue({ id: 'EI-1' }));
    const r = await resolveImprovement(
      { id: 'EI-1', outcome: 'fixed', summary: 'guarded the null icon lookup', testsRun: 'npm run test:affected → 214 green', commit: 'abc1234' },
      d,
    );
    expect(r).toMatchObject({ ok: true, outcome: 'fixed', state: 'resolved' });
    expect(d.rec.states).toEqual([{ id: 'EI-1', state: 'resolved' }]);
    expect(d.rec.comments[0].body).toMatch(/214 green/);
    expect(d.rec.comments[0].body).toMatch(/abc1234/);
  });

  it('is idempotent — resolving an already-resolved item is a no-op success', async () => {
    const d = deps(issue({ id: 'EI-1', state: 'resolved' }));
    const r = await resolveImprovement({ id: 'EI-1', outcome: 'fixed', summary: 'already done earlier today' }, d);
    expect(r.ok).toBe(true);
    expect(d.rec.states).toHaveLength(0);
    expect(d.rec.comments).toHaveLength(0);
  });

  it('unknown id → error', async () => {
    const r = await resolveImprovement({ id: 'EI-404', outcome: 'fixed', summary: 'whatever happened' }, deps(null));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
  });

  it('setIssueState returning null (federated/remote-owned issue, EI-7833 view lockout) routes to peer reconciliation instead of a FALSE "fixed" success', async () => {
    // Root cause of the auto-implement dispatch storm: a federated (origin='remote')
    // issue's engineer_issues view UPDATE is silently no-op'd (setIssueState → null),
    // which the old code swallowed via `state: updated?.state ?? 'resolved'` and
    // reported ok:true/'fixed' anyway — the issue never actually left the open queue.
    const d = deps(issue({ id: 'EI-remote', origin: 'remote' }));
    d.setIssueState = async () => null;
    const r = await resolveImprovement(
      { id: 'EI-remote', outcome: 'fixed', summary: 'fixed it', testsRun: 'vitest green', by: 'worker-1' },
      d,
    );
    expect(r).toMatchObject({
      ok: true,
      outcome: 'could-not-fix',
      state: 'open',
      routedToPeerReconciliation: true,
    });
    expect(d.rec.payloads).toEqual([]);
    expect(d.rec.released).toEqual(['EI-remote']);
    expect(d.rec.closes).toEqual([{ id: 'EI-remote', outcome: 'could-not-fix', by: 'worker-1' }]);
    // the verification evidence comment still landed, plus the routing explanation
    expect(d.rec.comments[0].body).toMatch(/vitest green/);
    expect(d.rec.comments[1].body).toMatch(/federated/);
  });
});

describe('resolveImprovement — non-terminal states actually resolve (EI-6953/6954/6938 regression)', () => {
  // engineer_issues is a VIEW over work_items (status AS state); issue-family items
  // are minted with the work-item state `todo` (non-terminal, normalized to `open`
  // by other readers — but resolve-core reads raw). The old `!== 'open'` idempotency
  // guard treated todo/wip/in_progress/blocked as already-terminal and NO-OP'd, so
  // ~450–650 items stayed stuck and re-dispatched forever. The guard must test
  // TERMINAL membership (resolved|closed) so every non-terminal state resolves.
  const NON_TERMINAL_STATES: string[] = ['todo', 'wip', 'in_progress', 'blocked', 'needs-human', 'open'];
  for (const state of NON_TERMINAL_STATES) {
    it(`fixed + evidence on a '${state}' (non-terminal) item ACTUALLY marks it resolved (not a silent no-op)`, async () => {
      const d = deps(issue({ id: 'EI-drift', state: state as IssueState }));
      const r = await resolveImprovement(
        { id: 'EI-drift', outcome: 'fixed', summary: 'real fix landed', testsRun: 'vitest green' },
        d,
      );
      expect(r).toMatchObject({ ok: true, outcome: 'fixed', state: 'resolved' });
      expect(d.rec.states).toEqual([{ id: 'EI-drift', state: 'resolved' }]);
      expect(d.rec.comments[0].body).toMatch(/vitest green/);
    });
  }

  it("a 'closed' (terminal) item stays an idempotent no-op, like 'resolved'", async () => {
    const d = deps(issue({ id: 'EI-closed', state: 'closed' }));
    const r = await resolveImprovement({ id: 'EI-closed', outcome: 'fixed', summary: 'x', testsRun: 't' }, d);
    expect(r).toMatchObject({ ok: true, state: 'closed' });
    expect(d.rec.states).toHaveLength(0);
    expect(d.rec.comments).toHaveLength(0);
  });
});

describe('resolveImprovement — could-not-fix (retry path)', () => {
  it('releases the claim and stays open (a later run retries)', async () => {
    const d = deps(issue({ id: 'EI-2', payload: { implementAttempts: 1 } }));
    const r = await resolveImprovement({ id: 'EI-2', outcome: 'could-not-fix', summary: 'repro is flaky, ran out of leads' }, d);
    expect(r).toMatchObject({ ok: true, outcome: 'could-not-fix', state: 'open' });
    expect(r.routedToOwnerAction).toBeUndefined();
    expect(r.routedToLeaderTriage).toBeUndefined();
    expect(d.rec.released).toEqual(['EI-2']);
    expect(d.rec.states).toHaveLength(0);
    expect(d.rec.payloads).toHaveLength(0); // attempts not exhausted → no needsHuman / no block
  });

  it('exhausted attempts → routes to LEADER TRIAGE (status=blocked), NOT the owner inbox (P-004/WI-5679)', async () => {
    const d = deps(issue({ id: 'EI-2', payload: { implementAttempts: 3 } }));
    const r = await resolveImprovement({ id: 'EI-2', outcome: 'could-not-fix', summary: 'third strike, still failing' }, d);
    expect(r).toMatchObject({ ok: true, outcome: 'could-not-fix', state: 'blocked', routedToLeaderTriage: true });
    expect(r.routedToOwnerAction).toBeUndefined();
    // status → blocked (out of the ISSUE_FAMILY_CLAIMABLE_STATES=['open'] auto loop), NOT needsHuman
    expect(d.rec.states).toEqual([{ id: 'EI-2', state: 'blocked' }]);
    expect(d.rec.payloads.some((p) => 'needsHuman' in p.patch)).toBe(false);
    expect(d.rec.payloads[0].patch).toMatchObject({ blockedReason: expect.stringMatching(/retries-exhausted/) });
    expect(d.rec.released).toEqual(['EI-2']);
    expect(d.rec.comments[0].body).toMatch(/Retries exhausted/);
  });

  it('honors a custom maxAttempts (→ leader triage)', async () => {
    const d = deps(issue({ id: 'EI-2', payload: { implementAttempts: 1 } }));
    const r = await resolveImprovement(
      { id: 'EI-2', outcome: 'could-not-fix', summary: 'one strike policy here', maxAttempts: 1 },
      d,
    );
    expect(r.routedToLeaderTriage).toBe(true);
    expect(d.rec.states).toEqual([{ id: 'EI-2', state: 'blocked' }]);
  });
});

describe('resolveImprovement — needs-human (P-004/WI-5679: leader-triage by default, owner only when typed)', () => {
  it('UNTYPED needs-human → LEADER TRIAGE (status=blocked), NOT the owner inbox', async () => {
    const d = deps(issue({ id: 'EI-3' }));
    const r = await resolveImprovement(
      { id: 'EI-3', outcome: 'needs-human', summary: 'the correct fix is a schema migration' },
      d,
    );
    expect(r).toMatchObject({ ok: true, outcome: 'needs-human', state: 'blocked', routedToLeaderTriage: true });
    expect(r.routedToOwnerAction).toBeUndefined();
    expect(d.rec.states).toEqual([{ id: 'EI-3', state: 'blocked' }]);
    expect(d.rec.payloads.some((p) => 'needsHuman' in p.patch)).toBe(false);
    expect(d.rec.payloads[0].patch).toMatchObject({ blockedReason: expect.stringMatching(/needs-human-untyped/) });
    expect(d.rec.released).toEqual(['EI-3']);
    expect(d.rec.comments[0].body).toMatch(/LEADER TRIAGE/);
  });

  it('D-029: an OWNER-gated needs-human without defaultIfUnanswered is refused before ANY write', async () => {
    const d = deps(issue({ id: 'EI-3' }));
    const r = await resolveImprovement(
      { id: 'EI-3', outcome: 'needs-human', summary: 'needs a prod DB credential only the owner holds', blockerCapability: 'credential' },
      d,
    );
    expect(r).toMatchObject({ ok: false, id: 'EI-3' });
    expect(r.error).toMatch(/requires defaultIfUnanswered/);
    expect(d.rec.payloads).toEqual([]);
    expect(d.rec.comments).toEqual([]);
  });

  it('blocker history CAS retains the claim and dispatch when the owner-ask history conflicts', async () => {
    const d = deps(issue({ id: 'EI-3' }));
    const merge = vi.fn(async () => null);
    d.mergeIssuePayload = merge;
    const r = await resolveImprovement({
      id: 'EI-3', outcome: 'needs-human', summary: 'Provide the credential', blockerCapability: 'credential',
      defaultIfUnanswered: 'stays parked; recheck later',
    }, d);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Blocker history changed');
    expect(d.rec.states).toEqual([]);
    expect(d.rec.released).toEqual([]);
    expect(d.rec.closes).toEqual([]);
    expect(merge).toHaveBeenCalledWith('EI-3', expect.any(Object), expect.objectContaining({ requireNonTerminal: true, expectedExternalBlockers: undefined }));
  });

  it('a genuine OWNER-gated blockerCapability (credential) → the OWNER ACTION path (payload.needsOwnerAction) AND state moves to needs-human (EI-18210987268765837)', async () => {
    const d = deps(issue({ id: 'EI-3' }));
    const r = await resolveImprovement(
      {
        id: 'EI-3',
        outcome: 'needs-human',
        summary: 'needs a prod DB credential only the owner holds',
        blockerCapability: 'credential',
        defaultIfUnanswered: 'stays parked; the weekly owner digest re-surfaces it',
      },
      d,
    );
    expect(r).toMatchObject({ ok: true, outcome: 'needs-human', state: 'needs-human', routedToOwnerAction: true });
    expect(r.routedToLeaderTriage).toBeUndefined();
    expect(d.rec.payloads).toEqual([
      {
        id: 'EI-3',
        patch: {
          needsOwnerAction: true,
          humanCapability: 'credential',
          externalBlockers: [
            expect.objectContaining({
              kind: 'human',
              capability: 'credential',
              ref: 'owner-capability:EI-3:credential',
              summary: 'needs a prod DB credential only the owner holds',
              nextVerb: expect.stringContaining('Provide credential'),
              status: 'active',
            }),
          ],
        },
      },
    ]);
    expect(d.rec.payloads[0]).toBeDefined();
    expect(d.rec.payloads[0]!.id).toBe('EI-3');
    // EI-18210987268765837 regression: a comment-only handoff (payload flag with NO state
    // transition) left the item in 'open' — every claim path gates on state='open', so it
    // stayed claimable and resurfaced days later as if freshly auto-eligible (root-caused on
    // EI-12198). The state write is what actually excludes it, not the payload flag alone.
    expect(d.rec.states).toEqual([{ id: 'EI-3', state: 'needs-human' }]);
    expect(d.rec.released).toEqual(['EI-3']);
    expect(d.rec.comments[0].body).toMatch(/credential/);
  });

  it('a remote-owned needs-human outcome routes to peer reconciliation before owner-capability classification', async () => {
    const d = deps(issue({ id: 'EI-remote', origin: 'remote' }));
    d.setIssueState = async () => null;
    const r = await resolveImprovement(
      { id: 'EI-remote', outcome: 'needs-human', summary: 'needs a credential, and this issue is federated', blockerCapability: 'credential' },
      d,
    );
    expect(r).toMatchObject({
      ok: true,
      outcome: 'could-not-fix',
      state: 'open',
      routedToPeerReconciliation: true,
    });
    expect(d.rec.payloads).toEqual([]);
    expect(d.rec.released).toEqual(['EI-remote']);
    expect(d.rec.closes).toEqual([{ id: 'EI-remote', outcome: 'could-not-fix', by: 'improvement-runner' }]);
  });

  it('product-decision enters peer agent review instead of the owner-action path', async () => {
    const d = deps(issue({ id: 'EI-3' }));
    const r = await resolveImprovement(
      { id: 'EI-3', outcome: 'needs-human', summary: 'needs a product direction call', blockerCapability: 'product-decision' },
      d,
    );
    expect(r.routedToAgentReview).toBe(true);
    expect(r.routedToOwnerAction).toBeUndefined();
    expect(d.rec.payloads).toEqual([]);
    expect(d.rec.comments[0].body).toMatch(/AGENT REVIEW/);
  });

  it('an AUTO-CLEARABLE capability is NOT genuine owner work → LEADER TRIAGE', async () => {
    const d = deps(issue({ id: 'EI-3' }));
    const r = await resolveImprovement(
      { id: 'EI-3', outcome: 'needs-human', summary: 'a standing approval AUTO already satisfies', blockerCapability: 'approval-auto-clearable' },
      d,
    );
    expect(r.routedToLeaderTriage).toBe(true);
    expect(r.routedToOwnerAction).toBeUndefined();
    expect(d.rec.states).toEqual([{ id: 'EI-3', state: 'blocked' }]);
    expect(d.rec.payloads.some((p) => 'needsHuman' in p.patch)).toBe(false);
  });

  it('a live-dependency capability is leader-clearable → LEADER TRIAGE', async () => {
    const d = deps(issue({ id: 'EI-3' }));
    const r = await resolveImprovement(
      { id: 'EI-3', outcome: 'needs-human', summary: 'awaiting a stalled dependency', blockerCapability: 'live-dependency' },
      d,
    );
    expect(r.routedToLeaderTriage).toBe(true);
    expect(d.rec.states).toEqual([{ id: 'EI-3', state: 'blocked' }]);
  });
});

describe('routeExhaustedImprovementToLeaderTriage — exhausted with no resolve recorded (consume-edges P-012)', () => {
  it('SILENT WORKER DEATH: open + exhausted → comment + status=blocked (leader triage), release the stale claim', async () => {
    // The worker(s) died without ever calling improvements:resolve — the item carries only the
    // dispatch bookkeeping (attempts + a stale claim). P-004/WI-5679: operational, so → leader triage.
    const d = deps(issue({ id: 'EI-9', payload: { implementAttempts: 3 } }));
    const r = await routeExhaustedImprovementToLeaderTriage({ id: 'EI-9' }, d);
    expect(r).toMatchObject({ ok: true, flipped: true });
    expect(d.rec.states).toEqual([{ id: 'EI-9', state: 'blocked' }]);
    expect(d.rec.payloads.some((p) => 'needsHuman' in p.patch)).toBe(false);
    expect(d.rec.payloads[0].patch).toMatchObject({ blockedReason: expect.stringMatching(/silent-worker-death/) });
    expect(d.rec.released).toEqual(['EI-9']);
    expect(d.rec.comments[0].body).toMatch(/NO resolve ever recorded/);
    expect(d.rec.comments[0].body).toMatch(/3\/3/);
  });

  it('idempotent: an item already routed to leader triage (state !== open) is a no-op', async () => {
    const d = deps(issue({ id: 'EI-9', state: 'blocked', payload: { implementAttempts: 3 } }));
    const r = await routeExhaustedImprovementToLeaderTriage({ id: 'EI-9' }, d);
    expect(r).toMatchObject({ ok: true, flipped: false, reason: 'not open' });
    expect(d.rec.comments).toHaveLength(0);
    expect(d.rec.states).toHaveLength(0);
  });

  it.each([
    ['legacy compatibility', { needsHuman: true }],
    ['strict owner action', { needsOwnerAction: true }],
  ])('idempotent: an item already on the %s path is a no-op', async (_label, routeFlag) => {
    const d = deps(issue({ id: 'EI-9', payload: { implementAttempts: 3, ...routeFlag } }));
    const r = await routeExhaustedImprovementToLeaderTriage({ id: 'EI-9' }, d);
    expect(r).toMatchObject({ ok: true, flipped: false, reason: expect.stringMatching(/already/) });
    expect(d.rec.comments).toHaveLength(0);
    expect(d.rec.payloads).toHaveLength(0);
    expect(d.rec.released).toHaveLength(0);
  });

  it('a resolved item is a no-op (the worker DID resolve — nothing was silent)', async () => {
    const d = deps(issue({ id: 'EI-9', state: 'resolved', payload: { implementAttempts: 3 } }));
    const r = await routeExhaustedImprovementToLeaderTriage({ id: 'EI-9' }, d);
    expect(r).toMatchObject({ ok: true, flipped: false, reason: 'not open' });
    expect(d.rec.comments).toHaveLength(0);
  });

  it('a missing item reports not-found without throwing', async () => {
    const d = deps(null);
    const r = await routeExhaustedImprovementToLeaderTriage({ id: 'EI-404' }, d);
    expect(r).toMatchObject({ ok: false, flipped: false });
    expect(r.reason).toMatch(/not found/);
  });

  it('uses the provided attempts/maxAttempts in the explanatory comment', async () => {
    const d = deps(issue({ id: 'EI-9', payload: { implementAttempts: 5 } }));
    const r = await routeExhaustedImprovementToLeaderTriage({ id: 'EI-9', attempts: 5, maxAttempts: 5, by: 'test-routine' }, d);
    expect(r.flipped).toBe(true);
    expect(d.rec.comments[0].body).toMatch(/5\/5/);
    expect(d.rec.comments[0].by).toBe('test-routine');
  });
});

describe('resolveImprovement — dispatch-ledger close (consume-edges P-010 / B-04)', () => {
  it('every successful outcome drives the open ledger rows terminal with that outcome', async () => {
    for (const outcome of ['could-not-fix', 'needs-human'] as const) {
      const d = deps(issue({ id: 'EI-7' }));
      await resolveImprovement({ id: 'EI-7', outcome, summary: 's', by: 'worker-1' }, d);
      expect(d.rec.closes).toEqual([{ id: 'EI-7', outcome, by: 'worker-1' }]);
    }
    const d = deps(issue({ id: 'EI-7' }));
    await resolveImprovement({ id: 'EI-7', outcome: 'fixed', summary: 's', testsRun: 'vitest green', by: 'worker-1' }, d);
    expect(d.rec.closes).toEqual([{ id: 'EI-7', outcome: 'fixed', by: 'worker-1' }]);
  });

  it('the idempotent re-resolve of an already-resolved item STILL closes ledger rows (no strays for the orphan collector)', async () => {
    const d = deps(issue({ id: 'EI-7', state: 'resolved' }));
    const r = await resolveImprovement({ id: 'EI-7', outcome: 'fixed', summary: 's', testsRun: 't' }, d);
    expect(r.ok).toBe(true);
    expect(d.rec.closes).toEqual([{ id: 'EI-7', outcome: 'fixed', by: 'improvement-runner' }]);
    expect(d.rec.states).toHaveLength(0); // still a no-op on the issue itself
  });

  it('a REFUSED resolve (fixed without testsRun) closes nothing — the dispatch is still live', async () => {
    const d = deps(issue({ id: 'EI-7' }));
    await resolveImprovement({ id: 'EI-7', outcome: 'fixed', summary: 's' }, d);
    expect(d.rec.closes).toHaveLength(0);
  });

  it('a ledger-close failure never fails the resolve (best-effort back edge)', async () => {
    const d = deps(issue({ id: 'EI-7' }));
    d.closeDispatches = async () => {
      throw new Error('PG hiccup');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await resolveImprovement({ id: 'EI-7', outcome: 'fixed', summary: 's', testsRun: 't' }, d);
    expect(r).toMatchObject({ ok: true, outcome: 'fixed', state: 'resolved' });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/dispatch-ledger close failed/), 'PG hiccup');
    warn.mockRestore();
  });
});

describe('own-node rows stranded at origin=remote (WI-10006515)', () => {
  // origin records how a row ARRIVED, not who wrote it (WI-10003565). The heal dep owns the
  // identity check; these cases pin that every route consults it before choosing peer
  // reconciliation, and that a true peer row (heal answers false) keeps the peer route.
  function stranded(id: string, ownNode: boolean) {
    let row = issue({ id, origin: 'remote' });
    const d = deps(row);
    const healed: string[] = [];
    d.getIssue = async () => row;
    d.setIssueState = async (sid, state) => {
      d.rec.states.push({ id: sid, state });
      return row.origin === 'remote' ? null : { ...row, state };
    };
    d.healOwnNodeOrigin = async (hid) => {
      healed.push(hid);
      if (ownNode) row = { ...row, origin: 'local' };
      return ownNode;
    };
    return { d, healed };
  }

  it('needs-human on an own-node row heals and takes the normal leader-triage route', async () => {
    const { d, healed } = stranded('EI-own', true);
    const r = await resolveImprovement({ id: 'EI-own', outcome: 'needs-human', summary: 'needs a schema migration' }, d);
    expect(healed).toEqual(['EI-own']);
    expect(r).toMatchObject({ ok: true, outcome: 'needs-human', state: 'blocked', routedToLeaderTriage: true });
    expect(r.routedToPeerReconciliation).toBeUndefined();
  });

  it('needs-human on a true peer row keeps the peer-reconciliation route', async () => {
    const { d, healed } = stranded('EI-peer', false);
    const r = await resolveImprovement({ id: 'EI-peer', outcome: 'needs-human', summary: 'needs a schema migration' }, d);
    expect(healed).toEqual(['EI-peer']);
    expect(r).toMatchObject({ ok: true, outcome: 'could-not-fix', routedToPeerReconciliation: true });
    expect(d.rec.states).toEqual([]);
  });

  it('fixed on an own-node row heals first, so the resolve write lands instead of a false peer route', async () => {
    const { d } = stranded('EI-own', true);
    const r = await resolveImprovement({ id: 'EI-own', outcome: 'fixed', summary: 'fixed it', testsRun: 'vitest green' }, d);
    expect(r).toMatchObject({ ok: true, outcome: 'fixed', state: 'resolved' });
  });

  it('the exhausted-attempts flip heals an own-node row so the leader-triage block sticks', async () => {
    const { d } = stranded('EI-own', true);
    const r = await routeExhaustedImprovementToLeaderTriage({ id: 'EI-own', attempts: 3 }, d);
    expect(r).toMatchObject({ ok: true, flipped: true });
  });

  it('a local row never consults the heal', async () => {
    const d = deps(issue({ id: 'EI-local' }));
    const heal = vi.fn(async () => true);
    d.healOwnNodeOrigin = heal;
    await resolveImprovement({ id: 'EI-local', outcome: 'could-not-fix', summary: 'retry later' }, d);
    expect(heal).not.toHaveBeenCalled();
  });
});

// WI-6554700010009273: migrations 1474/1477 refuse a row ENTERING `blocked` unless it already
// names its blocker, and the leader-triage park names it with a fresh payload.blockedReason. So the
// reason must be written BEFORE the status flip (status-first was refused outright), and it must be
// withdrawn when the flip does not stick so it cannot vouch for a later, unrelated `blocked` write.
describe('resolveImprovement — leader-triage park writes its reason before the status flip', () => {
  function orderedDeps(current: EngineerIssue | null) {
    const d = deps(current);
    const log: string[] = [];
    const merge = d.mergeIssuePayload;
    const flip = d.setIssueState;
    d.mergeIssuePayload = async (id, patch, opts) => {
      log.push(opts?.unset ? `unset:${opts.unset.join(',')}` : `merge:${Object.keys(patch).join(',')}`);
      return merge(id, patch, opts);
    };
    d.setIssueState = async (...args) => {
      log.push(`state:${args[1]}`);
      return flip(...args);
    };
    return { d, log };
  }

  it('stamps blockedReason + a current blockedAt, then flips to blocked', async () => {
    const { d, log } = orderedDeps(issue({ id: 'EI-5' }));
    const before = Date.now();
    const r = await resolveImprovement({ id: 'EI-5', outcome: 'needs-human', summary: 'needs a schema migration' }, d);
    expect(r).toMatchObject({ ok: true, state: 'blocked', routedToLeaderTriage: true });
    expect(log.indexOf('merge:blockedReason,blockedAt')).toBeGreaterThanOrEqual(0);
    expect(log.indexOf('merge:blockedReason,blockedAt')).toBeLessThan(log.indexOf('state:blocked'));
    const stamp = d.rec.payloads.find((p) => 'blockedReason' in p.patch)!.patch;
    expect(Date.parse(String(stamp.blockedAt))).toBeGreaterThanOrEqual(before - 1000);
    expect(log).not.toContain('unset:blockedReason,blockedAt');
    expect(d.rec.released).toEqual(['EI-5']);
  });

  it('withdraws the reason when the flip no-ops (remote-owned / missing row) and still releases the claim', async () => {
    const { d, log } = orderedDeps(issue({ id: 'EI-6' }));
    d.setIssueState = async () => {
      log.push('state:blocked');
      return null;
    };
    await resolveImprovement({ id: 'EI-6', outcome: 'needs-human', summary: 'needs a schema migration' }, d);
    expect(log.indexOf('unset:blockedReason,blockedAt')).toBeGreaterThan(log.indexOf('state:blocked'));
    expect(d.rec.released).toEqual(['EI-6']);
  });

  it('withdraws the reason and releases the claim when the database refuses the flip', async () => {
    const { d, log } = orderedDeps(issue({ id: 'EI-7' }));
    d.setIssueState = async () => {
      log.push('state:blocked');
      throw Object.assign(new Error('work-item EI-7 cannot enter status blocked without naming its blocker'), { code: '23514' });
    };
    await expect(
      resolveImprovement({ id: 'EI-7', outcome: 'needs-human', summary: 'needs a schema migration' }, d),
    ).rejects.toThrow(/cannot enter status blocked/);
    expect(log.indexOf('unset:blockedReason,blockedAt')).toBeGreaterThan(log.indexOf('state:blocked'));
    expect(d.rec.released).toEqual(['EI-7']);
  });
});
