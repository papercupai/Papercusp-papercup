/**
 * triage-core tests — the persistence edge of Queen-turn triage
 * (learning-system-audit-improvements-2026-06-09 P-010/P-011).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  applyTriageDecision,
  evidenceStalenessCheck,
  reopenRejectedTriageForCompensation,
  selectUntriaged,
  type TriageCoreDeps,
} from './triage-core';
import type { EngineerIssue } from '../../issues-engineer';
import type { ScoredItem } from './digest';

function issueOf(p: Partial<EngineerIssue> & { id: string }): EngineerIssue {
  return {
    id: p.id,
    title: p.title ?? 'memory:search errors out on long queries',
    scope: p.scope ?? 'operator',
    state: p.state ?? 'open',
    severity: p.severity ?? 'major',
    kind: p.kind ?? 'bug',
    payload: p.payload,
    body: p.body,
    createdBy: p.createdBy ?? null,
    createdAt: p.createdAt ?? '2026-10-10T00:00:00.000Z',
    terminalCompletionRef: p.terminalCompletionRef ?? null,
  } as EngineerIssue;
}

describe('reopenRejectedTriageForCompensation', () => {
  it('reopens the exact bulk reject and restores absent prior payload fields', async () => {
    const rejected = issueOf({
      id: 'undo-reject',
      state: 'closed',
      payload: {
        ideaLifecycle: { state: 'triaged', triageDecision: 'reject' },
        decidedReason: 'bulk rationale',
        needsHuman: true,
      },
    });
    const deps = depsOf(rejected);
    const result = await reopenRejectedTriageForCompensation(
      {
        id: rejected.id,
        expectedReason: 'bulk rationale',
        priorIdeaLifecycle: null,
        priorDecidedReason: null,
      },
      deps,
    );
    expect(result).toBe('reopened');
    expect(deps.states).toEqual(['open']);
    expect(deps.mergeIssuePayload).toHaveBeenCalledWith(rejected.id, {}, { unset: ['ideaLifecycle', 'decidedReason'] });
  });

  it('refuses to overwrite a different terminal decision', async () => {
    const rejected = issueOf({
      id: 'changed-reject',
      state: 'closed',
      payload: {
        ideaLifecycle: { state: 'triaged', triageDecision: 'reject' },
        decidedReason: 'newer reason',
      },
    });
    const deps = depsOf(rejected);
    expect(
      await reopenRejectedTriageForCompensation(
        {
          id: rejected.id,
          expectedReason: 'bulk rationale',
          priorIdeaLifecycle: null,
          priorDecidedReason: null,
        },
        deps,
      ),
    ).toBe('source_changed');
    expect(deps.states).toEqual([]);
    expect(deps.merged).toEqual([]);
  });
});

/**
 * The deployment-staleness screen (P-003) is a real git+registry read in production, so
 * the default fixture stands in for "this filing carries no structured toolFailure" —
 * the branch every pre-existing test is in. A test exercising the divert passes its own.
 */
function noStaleness(): TriageCoreDeps['deploymentStalenessScreen'] {
  return vi.fn(async () => ({ screened: false, divert: false, skipReason: 'no-structured-tool-failure' }) as const);
}

/**
 * A FEATURE-family row as the citation guard sees it (WI-2147241). Feature rows live in
 * the canonical `work_items` base table, never in the issue-family view, so they are
 * reachable only through the mixed-family `getCitedWorkItem` door — which is exactly the
 * axis the guard used to get wrong.
 */
type CitedRow = { id: string; state: string; terminalCompletionRef: string | null; payload?: unknown };

function depsOf(
  issue: EngineerIssue | null,
  registry: Record<string, EngineerIssue | null> = {},
  overrides: Partial<TriageCoreDeps> = {},
  featureRegistry: Record<string, CitedRow | null> = {},
): TriageCoreDeps & {
  merged: Record<string, unknown>[];
  states: string[];
  comments: string[];
  reviews: string[];
} {
  const merged: Record<string, unknown>[] = [];
  const states: string[] = [];
  const comments: string[] = [];
  const reviews: string[] = [];
  const byId: Record<string, EngineerIssue | null> = { ...registry, ...(issue ? { [issue.id]: issue } : {}) };
  return {
    merged,
    states,
    comments,
    reviews,
    getIssue: vi.fn(async (id: string) => (id in byId ? byId[id] : id === issue?.id ? issue : null)),
    // The MIXED-family door: the issue store first (so every pre-existing fixture keeps
    // resolving exactly as before), then the feature-family store the old guard could not see.
    //
    // Falls through on a FALSY issue result, not on key ABSENCE — that is what production
    // does (`work-items.ts`: `const issue = await getIssue(id); if (issue) return ...; return
    // getFeatureWorkItemOnly(id, harness)`). Keying the fall-through off `id in byId` instead
    // made an explicit `{ 'WI-x': null }` — the fixtures' own way of spelling "the issue-family
    // view genuinely does not hold feature rows" — short-circuit to null and never consult the
    // feature registry, i.e. the mock reproduced the exact blindness WI-2147241 is about.
    getCitedWorkItem: vi.fn(async (id: string): Promise<CitedRow | null> => {
      const fromIssues = id in byId ? byId[id] : id === issue?.id ? issue : null;
      if (fromIssues) return fromIssues;
      return id in featureRegistry ? featureRegistry[id] : null;
    }),
    setIssueState: vi.fn(async (_id, state) => {
      states.push(state);
      return issue;
    }),
    commentIssue: vi.fn(async (_id, body) => {
      comments.push(body);
      return null;
    }),
    mergeIssuePayload: vi.fn(async (_id, patch) => {
      merged.push(patch);
      return issue;
    }),
    enterAgentReview: vi.fn(async ({ id }) => {
      reviews.push(id);
      return { entered: true };
    }),
    deploymentStalenessScreen: noStaleness(),
    ...overrides,
  };
}

describe('applyTriageDecision — the decision PERSISTS (the G1 fix)', () => {
  it('writes payload.ideaLifecycle with the decision + reason + ideaType', async () => {
    const deps = depsOf(issueOf({ id: 'i1', scope: 'operator' }));
    const res = await applyTriageDecision({ id: 'i1', decision: 'gate', reason: 'touches the release gate' }, deps);
    expect(res.ok).toBe(true);
    expect(deps.merged).toHaveLength(1);
    const lc = deps.merged[0].ideaLifecycle as Record<string, unknown>;
    expect(lc.state).toBe('triaged');
    expect(lc.triageDecision).toBe('gate');
    expect(lc.triageReason).toBe('touches the release gate');
    expect(lc.ideaType).toBe('code-bug'); // operator scope, kind=bug, no prompt/infra markers → code-bug (D-005)
    expect(res.closed).toBe(false);
  });

  // EI-18812833212023413 — the gate verdict must reach the field the CLAIM FLOOR reads.
  // Before this, 'gate' wrote only ideaLifecycle.triageDecision while issue-family
  // admission keys on payload.needsHuman, so a human-gated item stayed fully claimable
  // and scheduler:get_next served it (51 open items were unfenced when found, including
  // protected-path ones). Asserting the MIRROR, not just the record.
  it('gate enters agent review without recreating legacy payload.needsHuman', async () => {
    const deps = depsOf(issueOf({ id: 'i-gate', scope: 'operator' }));
    const res = await applyTriageDecision(
      { id: 'i-gate', decision: 'gate', reason: 'touches apps/operator/lib/release/** → human' },
      deps,
    );
    expect(res.ok).toBe(true);
    expect((deps.merged[0].ideaLifecycle as Record<string, unknown>).triageDecision).toBe('gate');
    expect(deps.merged[0].needsHuman).toBeUndefined();
    expect(deps.reviews).toEqual(['i-gate']);
  });

  it.each(['improvement-triage', 'Queen'])('keeps the report author as submitter when %s triages it', async (by) => {
    const deps = depsOf(issueOf({ id: 'author-gate', createdBy: 'su-reporter' }));
    await applyTriageDecision({ id: 'author-gate', decision: 'gate', reason: 'needs validation', by }, deps);

    expect(deps.enterAgentReview).toHaveBeenCalledWith({ id: 'author-gate', submittedBy: 'su-reporter' });
    expect(deps.comments[0]).toContain(`Triage (${by})`);
  });

  it('preserves an explicit person reporter instead of substituting the triage actor', async () => {
    const deps = depsOf(issueOf({ id: 'person-gate', createdBy: 'system:intake', payload: {
      reporter: { kind: 'end-user', id: 'install-reporter', basis: 'explicit', at: '2026-10-10T00:00:00.000Z' },
    } }));
    await applyTriageDecision({ id: 'person-gate', decision: 'gate', reason: 'needs validation' }, deps);

    expect(deps.enterAgentReview).toHaveBeenCalledWith({ id: 'person-gate', submittedBy: 'install-reporter' });
  });

  it('routes operator-scoped infrastructure gates to owner escalation instead of harness review', async () => {
    const idea = issueOf({
      id: 'i-owner-escalation',
      scope: 'operator',
      payload: { watchdogKey: 'service-down:operator-api' },
    });
    const deps = depsOf(idea);
    const res = await applyTriageDecision(
      { id: idea.id, decision: 'gate', reason: 'the operator API is unavailable' },
      deps,
    );

    expect(res).toMatchObject({ ok: true, decision: 'gate', target: 'owner-escalation' });
    expect(deps.reviews).toEqual([]);
    expect(deps.merged[0].implementationReadiness).toMatchObject({
      status: 'unknown',
      reason: 'awaiting-owner-escalation',
    });
  });

  it('a NON-gate decision does not set needsHuman (the mirror is gate-only)', async () => {
    const deps = depsOf(issueOf({ id: 'i-place', scope: 'operator' }));
    await applyTriageDecision({ id: 'i-place', decision: 'place', reason: 'auto-eligible bug' }, deps);
    expect(deps.merged[0].needsHuman).toBeUndefined();
  });

  it('reject CLOSES the issue and records decidedReason (queue-as-memory recall)', async () => {
    const deps = depsOf(issueOf({ id: 'i2' }));
    const res = await applyTriageDecision({ id: 'i2', decision: 'reject', reason: 'duplicate of EI-12' }, deps);
    expect(res.ok).toBe(true);
    expect(res.closed).toBe(true);
    expect(deps.states).toEqual(['closed']);
    expect(deps.merged[0].decidedReason).toBe('duplicate of EI-12');
  });

  it('re-triage is allowed (triaged → triaged: the Queen revises a scheduled-pass decision)', async () => {
    const deps = depsOf(
      issueOf({
        id: 'i3',
        payload: {
          ideaLifecycle: {
            state: 'triaged',
            stateUpdatedAt: '2026-06-01T00:00:00Z',
            triageDecision: 'gate',
          },
        },
      }),
    );
    const res = await applyTriageDecision(
      { id: 'i3', decision: 'gym', reason: 'verify by A/B first', by: 'Queen' },
      deps,
    );
    expect(res.ok).toBe(true);
    expect((deps.merged[0].ideaLifecycle as Record<string, unknown>).triageDecision).toBe('gym');
  });

  it('refuses to triage from a terminal lifecycle state (applied)', async () => {
    const deps = depsOf(
      issueOf({
        id: 'i4',
        payload: { ideaLifecycle: { state: 'applied', stateUpdatedAt: '2026-06-01T00:00:00Z' } },
      }),
    );
    const res = await applyTriageDecision({ id: 'i4', decision: 'place', reason: 'x' }, deps);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('applied');
    expect(deps.merged).toHaveLength(0);
  });

  it('refuses non-terminal non-open issues and unknown ids', async () => {
    const wipDeps = depsOf(issueOf({ id: 'i5', state: 'wip' }));
    expect((await applyTriageDecision({ id: 'i5', decision: 'place', reason: 'x' }, wipDeps)).ok).toBe(false);
    const missingDeps = depsOf(null);
    expect((await applyTriageDecision({ id: 'nope', decision: 'place', reason: 'x' }, missingDeps)).ok).toBe(false);
  });

  it.each(['done', 'dropped', 'resolved', 'closed'] as const)(
    'persists triage on a terminal backing work-item without changing its state (%s)',
    async (state) => {
      const deps = depsOf(
        issueOf({
          id: `terminal-${state}`,
          state,
          payload: { ideaLifecycle: { state: 'open', stateUpdatedAt: '2026-09-01T00:00:00Z' } },
        }),
      );
      const res = await applyTriageDecision(
        { id: `terminal-${state}`, decision: 'place', reason: 'late routed-idea triage' },
        deps,
      );

      expect(res.ok).toBe(true);
      expect(res.lifecycle?.state).toBe('triaged');
      expect((deps.merged[0].ideaLifecycle as Record<string, unknown>).triageDecision).toBe('place');
      expect(deps.states).toEqual([]);
      expect(res.closed).toBe(false);
    },
  );

  it('records a reject decision on a terminal backing item without re-closing it', async () => {
    const deps = depsOf(
      issueOf({
        id: 'terminal-reject',
        state: 'done',
        payload: { ideaLifecycle: { state: 'open', stateUpdatedAt: '2026-09-01T00:00:00Z' } },
      }),
    );
    const res = await applyTriageDecision(
      { id: 'terminal-reject', decision: 'reject', reason: 'already completed elsewhere', comment: false },
      deps,
    );

    expect(res.ok).toBe(true);
    expect(res.closed).toBe(false);
    expect(deps.states).toEqual([]);
    expect(deps.merged[0].decidedReason).toBe('already completed elsewhere');
  });

  it('still refuses a terminal item whose improvement lifecycle is already terminal', async () => {
    const deps = depsOf(
      issueOf({
        id: 'terminal-applied',
        state: 'done',
        payload: { ideaLifecycle: { state: 'applied', stateUpdatedAt: '2026-09-01T00:00:00Z' } },
      }),
    );
    const res = await applyTriageDecision({ id: 'terminal-applied', decision: 'place', reason: 'x' }, deps);

    expect(res.ok).toBe(false);
    expect(res.error).toContain('applied');
    expect(deps.merged).toHaveLength(0);
    expect(deps.states).toEqual([]);
  });

  it('legacy item without a lifecycle initializes at open and triages cleanly', async () => {
    const deps = depsOf(issueOf({ id: 'i6', payload: { paths: ['lib/x.ts'] } }));
    const res = await applyTriageDecision({ id: 'i6', decision: 'place', reason: 'product fix' }, deps);
    expect(res.ok).toBe(true);
    expect(res.lifecycle?.state).toBe('triaged');
  });

  it('comment is written by default and suppressed for the batch pass (comment:false)', async () => {
    const a = depsOf(issueOf({ id: 'i7' }));
    await applyTriageDecision({ id: 'i7', decision: 'gate', reason: 'r' }, a);
    expect(a.comments).toHaveLength(1);
    const b = depsOf(issueOf({ id: 'i8' }));
    await applyTriageDecision({ id: 'i8', decision: 'gate', reason: 'r', comment: false }, b);
    expect(b.comments).toHaveLength(0);
  });
});

describe('evidence-staleness guard (EI-18696839552593260) — place downgrades to gate', () => {
  it('downgrades place→gate when every cited item is terminal with a completion ref', async () => {
    const cited = issueOf({ id: 'EI-100', state: 'closed', terminalCompletionRef: 'dropped: premise false' });
    const idea = issueOf({ id: 'i9', body: 'Regression per EI-100 — see also EI-100 (dup mention).' });
    const deps = depsOf(idea, { 'EI-100': cited });
    const res = await applyTriageDecision({ id: 'i9', decision: 'place', reason: 'code-bug, tier=auto' }, deps);
    expect(res.ok).toBe(true);
    expect(res.decision).toBe('gate');
    expect(res.evidenceDowngrade?.requestedDecision).toBe('place');
    expect(res.evidenceDowngrade?.citedIds).toEqual(['EI-100']);
    expect(res.evidenceDowngrade?.staleIds).toEqual(['EI-100']);
    const lc = deps.merged[0].ideaLifecycle as Record<string, unknown>;
    expect(lc.triageDecision).toBe('gate');
    expect(lc.triageReason).toContain('EVIDENCE-STALENESS GUARD');
    expect(deps.merged[0].implementationReadiness).toMatchObject({
      schemaVersion: 'implementation-readiness-v1',
      status: 'not-ready',
      source: 'triage-freshness',
      reason: 'cited-evidence-already-completed',
      evidence: { citations: { citedIds: ['EI-100'], staleIds: ['EI-100'] } },
    });
  });

  it('leaves place alone when a cited item is still open', async () => {
    const cited = issueOf({ id: 'EI-101', state: 'open' });
    const idea = issueOf({ id: 'i10', body: 'Regression per EI-101.' });
    const deps = depsOf(idea, { 'EI-101': cited });
    const res = await applyTriageDecision({ id: 'i10', decision: 'place', reason: 'code-bug, tier=auto' }, deps);
    expect(res.ok).toBe(true);
    expect(res.decision).toBe('place');
    expect(res.evidenceDowngrade).toBeUndefined();
  });

  it('leaves place alone when a cited item is terminal but carries no completion ref', async () => {
    const cited = issueOf({ id: 'EI-102', state: 'closed', terminalCompletionRef: null });
    const idea = issueOf({ id: 'i11', body: 'Regression per EI-102.' });
    const deps = depsOf(idea, { 'EI-102': cited });
    const res = await applyTriageDecision({ id: 'i11', decision: 'place', reason: 'x' }, deps);
    expect(res.decision).toBe('place');
  });

  it('downgrades place→gate when a citation does not resolve to a real item', async () => {
    const idea = issueOf({ id: 'i12', body: 'Regression per EI-999999 (deleted/renumbered).' });
    const deps = depsOf(idea, { 'EI-999999': null });
    const res = await applyTriageDecision({ id: 'i12', decision: 'place', reason: 'x' }, deps);
    expect(res.decision).toBe('gate');
    expect(res.evidenceDowngrade?.unresolvedIds).toEqual(['EI-999999']);
    expect((deps.merged[0].ideaLifecycle as Record<string, unknown>).triageReason).toContain(
      'EVIDENCE-INTEGRITY GUARD',
    );
    expect(deps.merged[0].needsHuman).toBeUndefined();
    expect(deps.reviews).toEqual(['i12']);
    expect(deps.merged[0].implementationReadiness).toMatchObject({
      status: 'unknown',
      reason: 'citation-evidence-unresolved',
      evidence: { citations: { unresolvedIds: ['EI-999999'] } },
    });
  });

  /**
   * WI-2147241 — the citation guard resolved every id through the ISSUE-family door, so a
   * REAL feature-family `WI-`/`F-` citation came back null and was reported fabricated.
   * Both halves are required: without the negative control the fix is unfalsifiable in the
   * direction that matters, and without the positive control the "fix" could simply be the
   * guard going blind.
   */
  describe('mixed-family citation resolution (WI-2147241)', () => {
    it('does NOT downgrade a real FEATURE-family citation that the issue-family door cannot see', async () => {
      const idea = issueOf({
        id: 'i-mixed',
        scope: 'harness:papercusp',
        body: 'Grounded in the measurement published as WI-2145950.',
      });
      const deps = depsOf(
        idea,
        { 'WI-2145950': null }, // the issue-family view genuinely does not hold feature rows
        {},
        { 'WI-2145950': { id: 'WI-2145950', state: 'open', terminalCompletionRef: null } },
      );
      const res = await applyTriageDecision({ id: 'i-mixed', decision: 'place', reason: 'code-bug' }, deps);
      expect(res.ok).toBe(true);
      expect(res.decision).toBe('place');
      expect(res.evidenceDowngrade).toBeUndefined();
    });

    it('resolves the citation under the CITING item’s harness, not an ambient one', async () => {
      const idea = issueOf({ id: 'i-scoped', scope: 'harness:papercusp', body: 'Per WI-3.' });
      const deps = depsOf(idea, { 'WI-3': null }, {}, { 'WI-3': { id: 'WI-3', state: 'open', terminalCompletionRef: null } });
      await applyTriageDecision({ id: 'i-scoped', decision: 'place', reason: 'x' }, deps);
      expect(deps.getCitedWorkItem).toHaveBeenCalledWith('WI-3', 'papercusp');
    });

    it('STILL downgrades a citation absent from BOTH families (fabrication detection preserved)', async () => {
      const idea = issueOf({ id: 'i-fab', scope: 'harness:papercusp', body: 'Per WI-999999.' });
      const deps = depsOf(idea, { 'WI-999999': null }, {}, { 'WI-999999': null });
      const res = await applyTriageDecision({ id: 'i-fab', decision: 'place', reason: 'x' }, deps);
      expect(res.decision).toBe('gate');
      expect(res.evidenceDowngrade?.unresolvedIds).toEqual(['WI-999999']);
    });

    it('applies the staleness guard to feature-family terminal states too, not just issue ones', async () => {
      const idea = issueOf({ id: 'i-feat-stale', scope: 'harness:papercusp', body: 'Per WI-2145950.' });
      const deps = depsOf(
        idea,
        { 'WI-2145950': null },
        {},
        // 'passed' is a FEATURE-family terminal state — invisible to ISSUE_TERMINAL_STATUSES.
        { 'WI-2145950': { id: 'WI-2145950', state: 'passed', terminalCompletionRef: 'ref-1' } },
      );
      const res = await applyTriageDecision({ id: 'i-feat-stale', decision: 'place', reason: 'x' }, deps);
      expect(res.decision).toBe('gate');
      expect(res.evidenceDowngrade?.staleIds).toEqual(['WI-2145950']);
      expect((deps.merged[0].ideaLifecycle as Record<string, unknown>).triageReason).toContain(
        'EVIDENCE-STALENESS GUARD',
      );
    });
  });

  it('downgrades same-role Scout citations because ideas are not incident evidence', async () => {
    const cited = issueOf({ id: 'EI-105', payload: { sourceRole: 'Scout' } });
    const idea = issueOf({
      id: 'i-circular',
      body: 'Known false-fire incident: EI-105.',
      payload: { sourceRole: 'Scout' },
    });
    const deps = depsOf(idea, { 'EI-105': cited });
    const res = await applyTriageDecision({ id: 'i-circular', decision: 'place', reason: 'Scout proposal' }, deps);
    expect(res.decision).toBe('gate');
    expect(res.evidenceDowngrade?.circularIds).toEqual(['EI-105']);
    expect((deps.merged[0].ideaLifecycle as Record<string, unknown>).triageReason).toContain('circular evidence');
    expect(deps.merged[0].implementationReadiness).toMatchObject({
      status: 'unknown',
      reason: 'citation-evidence-unresolved',
      evidence: { citations: { circularIds: ['EI-105'] } },
    });
  });

  it('never downgrades a non-place decision', async () => {
    const cited = issueOf({ id: 'EI-103', state: 'resolved', terminalCompletionRef: 'fixed' });
    const idea = issueOf({ id: 'i13', body: 'Per EI-103.' });
    const deps = depsOf(idea, { 'EI-103': cited });
    const res = await applyTriageDecision({ id: 'i13', decision: 'gate', reason: 'x' }, deps);
    expect(res.decision).toBe('gate');
    expect(res.evidenceDowngrade).toBeUndefined();
  });

  it('an idea citing nothing is never flagged stale', async () => {
    const idea = issueOf({ id: 'i14', body: 'No citations here at all.' });
    const deps = depsOf(idea);
    const res = await applyTriageDecision({ id: 'i14', decision: 'place', reason: 'x' }, deps);
    expect(res.decision).toBe('place');
    expect(res.implementationReadiness).toMatchObject({
      status: 'unknown',
      reason: 'triage-alone-does-not-establish-readiness',
    });
  });

  it('a lookup failure never blocks the decision (best-effort)', async () => {
    const idea = issueOf({ id: 'i15', body: 'Per EI-104.' });
    const deps = depsOf(idea);
    // WI-2147241: the citation leg now resolves through the MIXED-family door, so that is
    // the seam a datastore failure has to enter through for this fail-open test to mean
    // anything. Throwing from `getIssue` here would only fail loading the idea itself.
    deps.getCitedWorkItem = vi.fn(async (id: string) => {
      if (id === 'EI-104') throw new Error('db unavailable');
      return id === 'i15' ? idea : null;
    });
    const res = await applyTriageDecision({ id: 'i15', decision: 'place', reason: 'x' }, deps);
    expect(res.ok).toBe(true);
    expect(res.decision).toBe('place');
  });

  describe('evidenceStalenessCheck (unit)', () => {
    it('is stale only when EVERY resolvable citation is terminal-with-ref', async () => {
      const a = issueOf({ id: 'EI-1', state: 'closed', terminalCompletionRef: 'x' });
      const b = issueOf({ id: 'EI-2', state: 'open' });
      const deps = depsOf(null, { 'EI-1': a, 'EI-2': b });
      const res = await evidenceStalenessCheck({ id: 'idea', title: '', body: 'cites EI-1 and EI-2' }, deps);
      expect(res.stale).toBe(false);
      expect(res.citedIds).toEqual(['EI-1', 'EI-2']);
      expect(res.staleIds).toEqual(['EI-1']);
    });

    it('excludes a self-citation from the cited-id set', async () => {
      const deps = depsOf(null);
      const res = await evidenceStalenessCheck({ id: 'EI-5', title: 'about EI-5 itself', body: '' }, deps);
      expect(res.citedIds).toEqual([]);
      expect(res.stale).toBe(false);
    });
  });
});

describe('selectUntriaged — the scheduled pass picker (P-011)', () => {
  const scored = (p: Partial<ScoredItem> & { id: string }): ScoredItem =>
    ({
      kind: 'bug',
      title: 't',
      scope: 'operator',
      tier: 'human',
      score: 10,
      ageDays: 1,
      tierReason: '',
      ...p,
    }) as ScoredItem;

  it('picks no-lifecycle (legacy), open, and recurred items; skips triaged/applied', () => {
    const picked = selectUntriaged(
      [
        scored({ id: 'legacy' }),
        scored({ id: 'open', ideaLifecycleState: 'open' }),
        scored({ id: 'recurred', ideaLifecycleState: 'recurred' }),
        scored({ id: 'triaged', ideaLifecycleState: 'triaged' }),
        scored({ id: 'applied', ideaLifecycleState: 'applied' }),
      ],
      10,
    );
    expect(picked.map((i) => i.id).sort()).toEqual(['legacy', 'open', 'recurred']);
  });

  it('caps at max, highest score first; max=0 picks nothing', () => {
    const items = [scored({ id: 'a', score: 5 }), scored({ id: 'b', score: 50 }), scored({ id: 'c', score: 20 })];
    expect(selectUntriaged(items, 2).map((i) => i.id)).toEqual(['b', 'c']);
    expect(selectUntriaged(items, 0)).toEqual([]);
  });
});

/**
 * P-003 (EI-22450280531836927): deployment state is resolved BEFORE the route.
 *
 * The failure being closed is a filing whose subject is already repaired in the tree and
 * merely undeployed being routed as an open code-bug, dispatching an agent to fix correct
 * code. The controls below are the falsifiability set: a stale verdict must divert, and a
 * current/unknown verdict must NOT (an unknown converted into a clean bill is the exact
 * false-reassurance the three-valued verdict exists to prevent).
 */
describe('applyTriageDecision — deployment-staleness screen (P-003)', () => {
  const staleScreen = () =>
    vi.fn(async () => ({
      screened: true,
      divert: true,
      state: 'stale',
      toolName: 'improvements:capture',
      relPath: 'packages/operator-core/lib/agent-tools/improvements/capture.ts',
      deployedSha: 'deadbee',
      treeRef: 'staging',
    }) as const);

  it('diverts a place to gate/land-the-deploy when the tool source is stale', async () => {
    const issue = issueOf({ id: 'stale-1', kind: 'bug' });
    const deps = depsOf(issue, {}, { deploymentStalenessScreen: staleScreen() });
    const res = await applyTriageDecision({ id: 'stale-1', decision: 'place', reason: 'code-bug, tier=auto' }, deps);

    expect(res.ok).toBe(true);
    // The whole point: it does NOT reach the auto-implement lane.
    expect(res.decision).toBe('gate');
    expect(res.deploymentStalenessDivert).toEqual({ requestedDecision: 'place', target: 'land-the-deploy' });
    expect(res.lifecycle?.triageReason).toContain('LAND THE DEPLOY');
    expect(res.lifecycle?.triageReason).toContain('capture.ts');
    expect(res.implementationReadiness).toMatchObject({
      status: 'not-ready',
      reason: 'repair-already-present-but-undeployed',
      evidence: { deployment: { state: 'stale', toolName: 'improvements:capture' } },
    });
    // Durable, so "how many filings did the screen keep out of the code-fix lane" is
    // answerable from the rows rather than from a tool result nobody kept.
    const screenPatch = deps.merged.find((p) => 'deploymentStalenessScreen' in p);
    expect(screenPatch?.deploymentStalenessScreen).toMatchObject({ state: 'stale', divertedFrom: 'place' });
  });

  it('diverts a gate too — the recorded repair is the deploy, not a code change', async () => {
    const issue = issueOf({ id: 'stale-2', kind: 'bug' });
    const deps = depsOf(issue, {}, { deploymentStalenessScreen: staleScreen() });
    const res = await applyTriageDecision({ id: 'stale-2', decision: 'gate', reason: 'code-bug, tier=human' }, deps);
    expect(res.decision).toBe('gate');
    expect(res.deploymentStalenessDivert?.requestedDecision).toBe('gate');
    expect(res.lifecycle?.triageReason).toContain('land-the-deploy');
  });

  it('a CURRENT verdict routes unchanged and records the screen it ran', async () => {
    const issue = issueOf({
      id: 'current-1',
      kind: 'bug',
      payload: {
        implementationReadiness: {
          schemaVersion: 'implementation-readiness-v1',
          status: 'ready',
          source: 'agent-review',
          reason: 'agent-review-approved',
          updatedAt: '2026-09-05T00:00:00.000Z',
        },
      },
    });
    const deps = depsOf(
      issue,
      {},
      {
        deploymentStalenessScreen: vi.fn(async () => ({
          screened: true,
          divert: false,
          state: 'current',
          toolName: 'improvements:capture',
          relPath: 'packages/operator-core/lib/agent-tools/improvements/capture.ts',
          deployedSha: 'deadbee',
          treeRef: 'staging',
        }) as const),
      },
    );
    const res = await applyTriageDecision({ id: 'current-1', decision: 'place', reason: 'code-bug' }, deps);
    expect(res.decision).toBe('place');
    expect(res.deploymentStalenessDivert).toBeUndefined();
    expect(res.deploymentStaleness).toMatchObject({ state: 'current' });
    expect(res.implementationReadiness).toMatchObject({
      status: 'ready',
      source: 'agent-review',
      reason: 'agent-review-approved',
    });
  });

  it('an UNKNOWN verdict never diverts and is recorded as unknown, not as current', async () => {
    const issue = issueOf({ id: 'unknown-1', kind: 'bug' });
    const deps = depsOf(
      issue,
      {},
      {
        deploymentStalenessScreen: vi.fn(async () => ({
          screened: true,
          divert: false,
          state: 'unknown',
          toolName: 'improvements:capture',
          unknownReason: 'git-unreadable',
        }) as const),
      },
    );
    const res = await applyTriageDecision({ id: 'unknown-1', decision: 'place', reason: 'code-bug' }, deps);
    expect(res.decision).toBe('place');
    expect(res.deploymentStaleness).toMatchObject({ state: 'unknown', unknownReason: 'git-unreadable' });
    // P-008 / D-038: no separate freshness hold — the row waits in the one review stage,
    // and the deployment evidence tells the reviewer what could not be answered.
    expect(res.implementationReadiness).toMatchObject({
      status: 'unknown',
      reason: 'awaiting-agent-review',
      evidence: { deployment: { state: 'unknown', unknownReason: 'git-unreadable' } },
    });
    // P-002 / EI-25176539351759672: that stamp keeps the row out of ordinary self-select
    // and nothing re-screens it, so the place must ALSO enter agent review — otherwise it
    // sits in a dead zone no lane selects (217 open bugs did on 2026-10-05).
    expect(deps.enterAgentReview).toHaveBeenCalledTimes(1);
    expect(deps.enterAgentReview).toHaveBeenCalledWith({ id: 'unknown-1', submittedBy: 'improvement-triage' });
  });

  it('a PLACE whose deployment screen answered CURRENT is not sent to review', async () => {
    const issue = issueOf({ id: 'current-1', kind: 'bug' });
    const deps = depsOf(
      issue,
      {},
      {
        deploymentStalenessScreen: vi.fn(async () => ({
          screened: true,
          divert: false,
          state: 'current',
          toolName: 'improvements:capture',
          relPath: 'packages/operator-core/lib/agent-tools/improvements/capture.ts',
          deployedSha: 'deadbee',
          treeRef: 'staging',
        }) as const),
      },
    );
    const res = await applyTriageDecision({ id: 'current-1', decision: 'place', reason: 'code-bug' }, deps);
    expect(res.decision).toBe('place');
    expect(res.implementationReadiness?.reason).not.toBe('awaiting-agent-review');
    expect(deps.enterAgentReview).not.toHaveBeenCalled();
  });

  it('a PLACE whose deployment screen was UNAVAILABLE waits in review too (P-008 / D-038)', async () => {
    const issue = issueOf({ id: 'unavailable-1', kind: 'bug' });
    const deps = depsOf(
      issue,
      {},
      {
        deploymentStalenessScreen: vi.fn(
          async () => ({ screened: false, divert: false, skipReason: 'screen-unavailable' }) as const,
        ),
      },
    );
    const res = await applyTriageDecision({ id: 'unavailable-1', decision: 'place', reason: 'code-bug' }, deps);
    expect(res.decision).toBe('place');
    expect(res.implementationReadiness).toMatchObject({ status: 'unknown', reason: 'awaiting-agent-review' });
    expect(deps.enterAgentReview).toHaveBeenCalledTimes(1);
    expect(deps.enterAgentReview).toHaveBeenCalledWith({ id: 'unavailable-1', submittedBy: 'improvement-triage' });
  });

  it('does not pay for the screen on reject or gym — neither routes anyone at a code fix', async () => {
    const rejectDeps = depsOf(issueOf({ id: 'rej-1' }), {}, { deploymentStalenessScreen: staleScreen() });
    await applyTriageDecision({ id: 'rej-1', decision: 'reject', reason: 'not a defect' }, rejectDeps);
    expect(rejectDeps.deploymentStalenessScreen).not.toHaveBeenCalled();

    const gymDeps = depsOf(issueOf({ id: 'gym-1' }), {}, { deploymentStalenessScreen: staleScreen() });
    await applyTriageDecision({ id: 'gym-1', decision: 'gym', reason: 'prompt A/B' }, gymDeps);
    expect(gymDeps.deploymentStalenessScreen).not.toHaveBeenCalled();
  });

  it('a filing with no structured toolFailure writes no screen record and routes as before', async () => {
    const deps = depsOf(issueOf({ id: 'plain-1' }));
    const res = await applyTriageDecision({ id: 'plain-1', decision: 'place', reason: 'code-bug' }, deps);
    expect(res.decision).toBe('place');
    // The skip is REPORTED (a 'screen-unavailable' fault must be visible, not silent)
    // but nothing durable is written for a filing the screen does not apply to.
    expect(res.deploymentStaleness).toEqual({
      screened: false,
      divert: false,
      skipReason: 'no-structured-tool-failure',
    });
    expect(deps.merged.some((p) => 'deploymentStalenessScreen' in p)).toBe(false);
  });
});
