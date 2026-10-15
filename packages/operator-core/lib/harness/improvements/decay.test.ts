/**
 * decay tests — the recurrence-decay verification sweep
 * (learning-system-audit-improvements-2026-06-09 P-013; self-learning P-030/D-003).
 */

import { describe, it, expect, vi } from 'vitest';
import { planDecaySweep, runDecaySweep, type DecaySweepDeps } from './decay';
import type { ImprovementCandidate } from './policy';
import type { IdeaLifecyclePayload } from './lifecycle';
import type { EngineerIssue, ListIssuesFilter } from '../../issues-engineer';

vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('../../system-health/compute', () => ({ refreshHealthPanel: vi.fn(async () => {}) }));

const NOW = Date.parse('2026-06-09T12:00:00Z');
const daysAgo = (d: number): string => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();

function cand(p: Partial<ImprovementCandidate> & { id: string }): ImprovementCandidate {
  return {
    kind: 'bug',
    scope: 'operator',
    title: 'memory search errors on long queries',
    state: 'open',
    createdAt: daysAgo(30),
    updatedAt: daysAgo(30),
    ...p,
  };
}

function issue(p: Partial<EngineerIssue> & { id: string; title: string }): EngineerIssue {
  return {
    kind: 'bug',
    scope: 'operator',
    body: '',
    severity: 'minor',
    source: 'su',
    state: 'open',
    assignee: null,
    assignedBy: null,
    assignedAt: null,
    payload: null,
    parent: null,
    foundDuring: null,
    linkedFeatureId: null,
    createdBy: 'su-test',
    signalOrigin: 'organic',
    assigneeRank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    lastProgressAt: null,
    origin: 'local',
    terminalOwner: null,
    terminalCompletionRef: null,
    completionAuthority: null,
    featureOrder: null,
    createdAt: daysAgo(30),
    updatedAt: daysAgo(30),
    closedAt: null,
    goalId: null,
    ...p,
  };
}

function issueFromCandidate(candidate: ImprovementCandidate): EngineerIssue {
  return issue({
    id: candidate.id,
    title: candidate.title,
    kind: candidate.kind === 'feature' ? 'change' : candidate.kind === 'chunk' ? 'task' : candidate.kind,
    scope: candidate.scope,
    state: candidate.state === 'resolved' ? 'done' : candidate.state === 'closed' ? 'closed' : 'open',
    createdAt: candidate.createdAt ?? daysAgo(30),
    updatedAt: candidate.updatedAt ?? daysAgo(30),
    payload: {
      ...(candidate.watchdogKey ? { watchdogKey: candidate.watchdogKey } : {}),
      ...(candidate.ideaLifecycle ? { ideaLifecycle: candidate.ideaLifecycle } : {}),
    },
  });
}

function projectCandidates(
  candidates: readonly ImprovementCandidate[],
  observe?: (filter: ListIssuesFilter, maxRows: number) => void,
): DecaySweepDeps['projectIssues'] {
  return async <T>(
    filter: ListIssuesFilter,
    projection: {
      maxRows: number;
      project: (issues: readonly EngineerIssue[]) => Promise<readonly T[]> | readonly T[];
    },
  ): Promise<T[]> => {
    observe?.(filter, projection.maxRows);
    return [...(await projection.project(candidates.map(issueFromCandidate)))];
  };
}

const applied = (over: Partial<IdeaLifecyclePayload> = {}): IdeaLifecyclePayload => ({
  state: 'applied',
  stateUpdatedAt: daysAgo(20),
  ideaType: 'product',
  ...over,
});

describe('planDecaySweep — pure grading of resolved+applied items', () => {
  it('verifies a product item quiet ≥14 days post-resolution', () => {
    const actions = planDecaySweep(
      [cand({ id: 'a', state: 'resolved', updatedAt: daysAgo(20), ideaLifecycle: applied() })],
      { nowMs: NOW },
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('verified');
    expect(actions[0].lifecycle.state).toBe('verified');
    expect(actions[0].lifecycle.decayResult).toBe('worked');
  });

  it('marks recurred when a same-signature capture POST-DATES the resolution (any class)', () => {
    const actions = planDecaySweep(
      [
        cand({
          id: 'fixed',
          state: 'resolved',
          updatedAt: daysAgo(10),
          ideaLifecycle: applied({ ideaType: 'process-prompt' }),
        }),
        // Same signature (token-set of the title), captured AFTER the fix.
        cand({ id: 'regression', title: 'errors on long queries — memory search', createdAt: daysAgo(2) }),
      ],
      { nowMs: NOW },
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe('fixed');
    expect(actions[0].kind).toBe('recurred');
    expect(actions[0].recurrences).toBe(1);
  });

  it('marks recurred when differently-worded captures share a stable watchdogKey', () => {
    const actions = planDecaySweep(
      [
        cand({
          id: 'fixed',
          title: 'the original free-prose wording',
          watchdogKey: 'repeated-tool-error:plans:set-status',
          state: 'resolved',
          updatedAt: daysAgo(10),
          ideaLifecycle: applied({ ideaType: 'process-prompt' }),
        }),
        cand({
          id: 'regression',
          title: 'a completely different wording after the fix',
          watchdogKey: 'repeated-tool-error:plans:set-status',
          createdAt: daysAgo(2),
        }),
      ],
      { nowMs: NOW },
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ id: 'fixed', kind: 'recurred', recurrences: 1 });
  });

  it('keeps distinct watchdog keys isolated even when their titles collide', () => {
    const actions = planDecaySweep(
      [
        cand({
          id: 'fixed',
          watchdogKey: 'repeated-tool-error:plans:set-status',
          state: 'resolved',
          updatedAt: daysAgo(20),
          ideaLifecycle: applied(),
        }),
        cand({
          id: 'other-signal',
          watchdogKey: 'repeated-tool-error:plans:set-plan-status',
          createdAt: daysAgo(2),
        }),
      ],
      { nowMs: NOW },
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ id: 'fixed', kind: 'verified' });
  });

  it('does not skip a keyed candidate whose title has no normalized signature', () => {
    const actions = planDecaySweep(
      [
        cand({
          id: 'fixed',
          title: 'is',
          watchdogKey: 'red-test:packages/example.test.ts',
          state: 'resolved',
          updatedAt: daysAgo(10),
          ideaLifecycle: applied({ ideaType: 'process-prompt' }),
        }),
        cand({
          id: 'regression',
          title: 'a',
          watchdogKey: 'red-test:packages/example.test.ts',
          createdAt: daysAgo(2),
        }),
      ],
      { nowMs: NOW },
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ id: 'fixed', kind: 'recurred', recurrences: 1 });
  });

  it('does not grade a keyless candidate whose title has no normalized signature', () => {
    const actions = planDecaySweep([
      cand({
        id: 'empty',
        title: 'is',
        state: 'resolved',
        updatedAt: daysAgo(20),
        ideaLifecycle: applied(),
      }),
    ], { nowMs: NOW });
    expect(actions).toHaveLength(0);
  });

  it('PRE-resolution duplicates do NOT count as regression', () => {
    const actions = planDecaySweep(
      [
        cand({ id: 'fixed', state: 'resolved', updatedAt: daysAgo(15), ideaLifecycle: applied() }),
        // Same signature but captured BEFORE the resolution — the old dup cluster.
        cand({ id: 'old-dup', title: 'memory search errors on long queries', createdAt: daysAgo(25), state: 'closed' }),
      ],
      { nowMs: NOW },
    );
    // Quiet since resolution + product → verified, NOT recurred. (old-dup itself
    // is closed with no lifecycle → it retro-initializes.)
    const byId = Object.fromEntries(actions.map((a) => [a.id, a.kind]));
    expect(byId['fixed']).toBe('verified');
    expect(byId['old-dup']).toBe('init-applied');
  });

  it('process-prompt class quiet ≥14 days stays silent (no decay-verify for the prompt class — D-003)', () => {
    const actions = planDecaySweep(
      [
        cand({
          id: 'p',
          state: 'resolved',
          updatedAt: daysAgo(20),
          ideaLifecycle: applied({ ideaType: 'process-prompt' }),
        }),
      ],
      { nowMs: NOW },
    );
    expect(actions).toHaveLength(0);
  });

  it('quiet but <14 days → no action yet', () => {
    const actions = planDecaySweep(
      [cand({ id: 'a', state: 'resolved', updatedAt: daysAgo(5), ideaLifecycle: applied({ stateUpdatedAt: daysAgo(5) }) })],
      { nowMs: NOW },
    );
    expect(actions).toHaveLength(0);
  });

  it('legacy resolved item without lifecycle retro-enters as applied, anchored at resolution time', () => {
    const actions = planDecaySweep([cand({ id: 'legacy', state: 'resolved', updatedAt: daysAgo(40) })], {
      nowMs: NOW,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('init-applied');
    expect(actions[0].lifecycle.state).toBe('applied');
    expect(actions[0].lifecycle.stateUpdatedAt).toBe(daysAgo(40));
  });

  it('open items and non-applied lifecycles are never graded; maxActions caps the sweep', () => {
    const items = [
      cand({ id: 'open1' }), // open — skipped
      cand({ id: 'v', state: 'resolved', updatedAt: daysAgo(20), ideaLifecycle: { state: 'verified', stateUpdatedAt: daysAgo(1) } }),
      ...Array.from({ length: 5 }, (_, i) =>
        cand({ id: `legacy${i}`, title: `distinct legacy friction number ${i}`, state: 'closed', updatedAt: daysAgo(30) }),
      ),
    ];
    expect(planDecaySweep(items, { nowMs: NOW }).every((a) => a.id.startsWith('legacy'))).toBe(true);
    expect(planDecaySweep(items, { nowMs: NOW, maxActions: 2 })).toHaveLength(2);
  });
});

describe('runDecaySweep — persistence glue', () => {
  it('plans a mature fix beyond the newest 500 against a later recurrence in the full population', async () => {
    let readFilter: ListIssuesFilter | undefined;
    let projectedMaxRows: number | undefined;
    const matureFix = cand({
      id: 'mature-fix',
      title: 'the original fix wording',
      watchdogKey: 'decay-starvation:row-501',
      state: 'resolved',
      createdAt: daysAgo(30),
      updatedAt: daysAgo(20),
      ideaLifecycle: applied({ ideaType: 'process-prompt' }),
    });
    const laterCapture = cand({
      id: 'later-capture',
      title: 'a different report after the fix',
      watchdogKey: 'decay-starvation:row-501',
      createdAt: daysAgo(2),
    });
    const recent = Array.from({ length: 499 }, (_, i) =>
      cand({
        id: `recent-${i}`,
        title: `unrelated recent capture ${i}`,
        createdAt: daysAgo(1),
        updatedAt: daysAgo(1),
      }),
    );
    // The SQL list is newest-first. The matching recurrence is inside the old
    // 500-row window, while the mature resolved candidate sits just beyond it.
    const corpus = [laterCapture, ...recent, matureFix];
    const merged: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const deps: DecaySweepDeps = {
      projectIssues: projectCandidates(corpus, (filter, maxRows) => {
        readFilter = filter;
        projectedMaxRows = maxRows;
      }),
      mergeIssuePayload: vi.fn(async (id, patch) => {
        merged.push({ id, patch });
        return null;
      }),
      commentIssue: vi.fn(async () => null),
    };

    const result = await runDecaySweep({ nowMs: NOW }, deps);

    expect(readFilter).toMatchObject({
      topic: 'papercusp-improvement',
      signalOrigins: ['organic'],
      includeBody: false,
    });
    expect(readFilter).not.toHaveProperty('limit');
    expect(projectedMaxRows).toBe(1);
    expect(result).toEqual({ scanned: 501, verified: 0, recurred: 1, initialized: 0 });
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: 'mature-fix',
      patch: { ideaLifecycle: { state: 'recurred' } },
    });
  });

  it('merges each action and comments verified/recurred but not init-applied', async () => {
    const merged: string[] = [];
    const comments: string[] = [];
    const deps: DecaySweepDeps = {
      projectIssues: projectCandidates([
          cand({ id: 'v', state: 'resolved', updatedAt: daysAgo(20), ideaLifecycle: applied() }),
          cand({ id: 'legacy', title: 'an entirely different friction', state: 'closed', updatedAt: daysAgo(30) }),
        ]),
      mergeIssuePayload: vi.fn(async (id) => {
        merged.push(id);
        return null;
      }),
      commentIssue: vi.fn(async (id, body) => {
        comments.push(`${id}:${body.slice(0, 1)}`);
        return null;
      }),
    };
    const res = await runDecaySweep({ nowMs: NOW }, deps);
    expect(res).toEqual({ scanned: 2, verified: 1, recurred: 0, initialized: 1 });
    expect(merged.sort()).toEqual(['legacy', 'v']);
    expect(comments).toEqual(['v:✓']); // init-applied is silent bookkeeping
  });
});
