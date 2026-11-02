/**
 * P-005 (review-routing-through-relevance-router-2026-09-26): the BAR-amendment
 * review policy never offers a reviewer from the implementer's spawn or rebind
 * lineage. The screen below models the lineage relation over a small graph; the
 * real relation (and its equality with the apply guard's pairwise check) is
 * pinned against Postgres in acceptance-author-identity.integration.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { selectionPolicy } from '@papercusp/ranked-selection';
import type { RouteResult } from './relevance-router';
import {
  ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR,
  buildAmendmentReviewBrief,
  filterAmendmentReviewRoute,
  launchFreshAmendmentReviewer,
  MAX_DEAD_REVIEWER_CHAIN,
  openAcceptanceBarAmendmentReview,
  resolveAmendmentReviewSources,
  routeAcceptanceBarAmendmentReview,
  selectFreshReviewerModelForAccountSteer,
  type AmendmentReviewSourceContext,
  type AmendmentReviewerScreen,
} from './acceptance-bar-amendment-review';
import { ACCEPTANCE_BAR_AMENDMENT_REVIEW_POLICY } from './selection-policies';
import { analyzeClaudeResumeTranscript } from '../claude-resume-tool-references.mjs';

// Directed lineage edges: rebind predecessor -> implementer -> spawned child;
// a common parent launched both the implementer and a sibling.
const EDGES: Array<[string, string]> = [
  ['su-rebind-predecessor', 'su-implementer'],
  ['su-implementer', 'su-spawned-child'],
  ['su-common-parent', 'su-implementer'],
  ['su-common-parent', 'su-sibling'],
];

function reach(from: string, forward: boolean): Set<string> {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const node = queue.shift()!;
    for (const [a, b] of EDGES) {
      const next = forward ? (a === node ? b : null) : b === node ? a : null;
      if (next && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/** Descendants + ancestors: the same relation areAcceptanceLineageRelated answers. */
function lineageScreen(implementer: string): AmendmentReviewerScreen & { calls: string[] } {
  const related = new Set([...reach(implementer, true), ...reach(implementer, false)]);
  const calls: string[] = [];
  const screen = (async (ownerId: string) => {
    calls.push(ownerId);
    return related.has(ownerId)
      ? { eligible: false, reason: 'related_to_plan_implementer' as const }
      : { eligible: true, reason: 'eligible' as const };
  }) as AmendmentReviewerScreen & { calls: string[] };
  screen.calls = calls;
  return screen;
}

const candidate = (ownerId: string) => ({ ownerId, score: 0.9 });

function route(qualified: string[], snapshot: string[]): RouteResult {
  return {
    verdict: 'routed',
    qualified: qualified.map(candidate),
    snapshot: { candidates: snapshot.map(candidate) },
  } as unknown as RouteResult;
}

const LINEAGE = ['su-spawned-child', 'su-rebind-predecessor', 'su-implementer'];

describe('filterAmendmentReviewRoute', () => {
  it('drops the implementer, its spawned child and its rebind predecessor from both the qualified menu and the snapshot', async () => {
    const screen = lineageScreen('su-implementer');
    const screenedOut: Array<{ ownerId: string; reason: string }> = [];
    const filtered = await filterAmendmentReviewRoute(
      route(
        ['su-spawned-child', 'su-outsider', 'su-rebind-predecessor', 'su-sibling'],
        ['su-spawned-child', 'su-outsider', 'su-rebind-predecessor', 'su-sibling', 'su-implementer'],
      ),
      screen,
      (entry) => screenedOut.push(entry),
    );
    expect(filtered.qualified.map((c) => c.ownerId)).toEqual(['su-outsider', 'su-sibling']);
    expect(filtered.snapshot.candidates.map((c) => c.ownerId)).toEqual(['su-outsider', 'su-sibling']);
    for (const member of LINEAGE) {
      expect(filtered.qualified.map((c) => c.ownerId)).not.toContain(member);
      expect(filtered.snapshot.candidates.map((c) => c.ownerId)).not.toContain(member);
    }
    expect(screenedOut.map((e) => e.ownerId).sort()).toEqual([...LINEAGE].sort());
    expect(screenedOut.every((e) => e.reason === 'related_to_plan_implementer')).toBe(true);
    // Each distinct owner is screened exactly once.
    expect([...screen.calls].sort()).toEqual(
      ['su-implementer', 'su-outsider', 'su-rebind-predecessor', 'su-sibling', 'su-spawned-child'].sort(),
    );
  });

  it('fails closed: a screen fault rejects instead of passing an unscreened candidate', async () => {
    const screen: AmendmentReviewerScreen = async (ownerId) => {
      if (ownerId === 'su-outsider') throw new Error('implementer history unreadable');
      return { eligible: true, reason: 'eligible' };
    };
    await expect(filterAmendmentReviewRoute(route(['su-sibling', 'su-outsider'], []), screen)).rejects.toThrow(
      'implementer history unreadable',
    );
  });
});

describe('routeAcceptanceBarAmendmentReview', () => {
  const identity = { ownerId: 'su-implementer', workspaceId: 'ws-1' } as never;

  it('routes under the amendment policy, fresh (no archive), with the screen applied before selection', async () => {
    const screen = lineageScreen('su-implementer');
    const resolveScreen = vi.fn(async () => ({ check: screen }));
    let selectedFrom: RouteResult | null = null;
    const feedback = vi.fn(async (_req: unknown, _identity: unknown, opts: { filterRoute: (r: RouteResult) => Promise<RouteResult> }) => {
      selectedFrom = await opts.filterRoute(route(['su-spawned-child', 'su-rebind-predecessor', 'su-outsider'], ['su-sibling']));
      return { verdict: 'routed', conversation_id: 'conv-1', responder: { ownerId: selectedFrom.qualified[0]!.ownerId } };
    });
    const result = await routeAcceptanceBarAmendmentReview(
      { rubricRef: 'plan:acceptance-x', brief: 'review this diff', identity, workspaceId: 'ws-1', harness: 'papercusp' },
      { resolveScreen, feedback: feedback as never },
    );
    expect(resolveScreen).toHaveBeenCalledWith({ rubricId: 'acceptance-x', applierId: 'su-implementer' });
    const request = feedback.mock.calls[0]![0] as Record<string, unknown>;
    expect(request).toMatchObject({
      workspaceId: 'ws-1',
      requesterId: 'su-implementer',
      question: 'review this diff',
      originTaskRef: 'acceptance-x',
      subjectRef: 'acceptance-x',
      excludeOwners: ['su-implementer'],
      archiveFloor: 2,
      policy: ACCEPTANCE_BAR_AMENDMENT_REVIEW_POLICY,
      harnessSlug: 'papercusp',
    });
    expect(selectedFrom!.qualified.map((c) => c.ownerId)).toEqual(['su-outsider']);
    expect(result).toEqual({
      state: 'routed',
      conversationId: 'conv-1',
      responderId: 'su-outsider',
      screenedOut: [
        { ownerId: 'su-spawned-child', reason: 'related_to_plan_implementer' },
        { ownerId: 'su-rebind-predecessor', reason: 'related_to_plan_implementer' },
      ],
    });
  });

  it('reports no eligible reviewer when the router selects nobody, and refuses on a router error', async () => {
    const resolveScreen = async () => ({ check: lineageScreen('su-implementer') });
    const none = vi.fn(async () => ({ verdict: 'no_available_responder', conversation_id: 'conv-2', reason: 'all screened out' }));
    await expect(
      routeAcceptanceBarAmendmentReview(
        { rubricRef: 'acceptance-x', brief: 'b', identity, workspaceId: 'ws-1' },
        { resolveScreen, feedback: none as never },
      ),
    ).resolves.toEqual({
      state: 'no-eligible-reviewer',
      conversationId: 'conv-2',
      reason: 'no_available_responder (all screened out)',
      screenedOut: [],
    });
    const failing = vi.fn(async () => ({ error: 'invalid_args' }));
    await expect(
      routeAcceptanceBarAmendmentReview(
        { rubricRef: 'acceptance-x', brief: 'b', identity, workspaceId: 'ws-1' },
        { resolveScreen, feedback: failing as never },
      ),
    ).rejects.toThrow('acceptance_bar_amendment_review_refused: invalid_args');
  });

  it('sends a validated reviewer model to the saved routed consult', async () => {
    const reviewerModel = { agent: 'codex', model: 'sol', effort: 'xhigh' } as const;
    const feedback = vi.fn(async () => ({ verdict: 'routed', conversation_id: 'conv-model', responder: { ownerId: 'su-outsider' } }));
    const assertAllowed = vi.fn(async () => {});
    await routeAcceptanceBarAmendmentReview(
      { rubricRef: 'acceptance-x', brief: 'review', identity, workspaceId: 'ws-1', reviewerModel },
      { resolveScreen: async () => ({ check: lineageScreen('su-implementer') }),
        feedback: feedback as never, assertAllowed },
    );
    expect(assertAllowed).toHaveBeenCalledWith('ws-1', reviewerModel);
    expect(feedback).toHaveBeenCalledWith(expect.objectContaining({ reviewerModel }), identity, expect.any(Object));
  });

  it('refuses before routing when the independence population cannot be resolved', async () => {
    const feedback = vi.fn();
    await expect(
      routeAcceptanceBarAmendmentReview(
        { rubricRef: 'acceptance-x', brief: 'b', identity, workspaceId: 'ws-1' },
        {
          resolveScreen: async () => {
            throw new Error('acceptance_bar_approver_check_subject_unreadable');
          },
          feedback: feedback as never,
        },
      ),
    ).rejects.toThrow('acceptance_bar_approver_check_subject_unreadable');
    expect(feedback).not.toHaveBeenCalled();
  });

  it('identifies a blocked independence screen without bypassing it', async () => {
    let rejectScreen!: (error: Error) => void;
    const screen = new Promise<{ check: AmendmentReviewerScreen }>((_resolve, reject) => { rejectScreen = reject; });
    const feedback = vi.fn();
    const onPhase = vi.fn();
    const pending = routeAcceptanceBarAmendmentReview(
      { rubricRef: 'acceptance-x', brief: 'b', identity, workspaceId: 'ws-1', onPhase },
      { resolveScreen: () => screen, feedback: feedback as never },
    );
    try {
      expect(onPhase).toHaveBeenLastCalledWith('review-screen');
      expect(feedback).not.toHaveBeenCalled();
    } finally {
      rejectScreen(new Error('screen-unavailable'));
      await expect(pending).rejects.toThrow('screen-unavailable');
    }
    expect(feedback).not.toHaveBeenCalled();
  });

  it('registers the amendment policy with one reviewer per attempt', () => {
    expect(selectionPolicy(ACCEPTANCE_BAR_AMENDMENT_REVIEW_POLICY)).toEqual({ min: 1, max: 1 });
  });
});

describe('openAcceptanceBarAmendmentReview (P-006)', () => {
  const approval = { schemaVersion: 1, kind: 'acceptance-bar-approval', rubricRef: 'acceptance-demo', bars: [{ barKey: 'R-1' }] };
  const reviewSources: AmendmentReviewSourceContext = {
    rubric: {
      ref: 'acceptance-demo',
      revision: 12,
      criteriaHash: 'criteria-hash-12',
      changedCriteria: [
        { barKey: 'R-1', criterion: { barKey: 'R-1', model: 'Current R-1 criterion.' } },
        { barKey: 'R-37', criterion: { barKey: 'R-37', model: 'Current R-37 criterion.' } },
      ],
    },
    subjectPlan: {
      slug: 'acceptance-demo',
      harnessSlug: 'papercusp',
      revision: 7,
      contentHash: 'plan-content-hash-7',
      requirements: '## Requirements\n### R-1 — Current first requirement\nCurrent R-1 details.\n\n### R-37 — Current second requirement\nCurrent R-37 details.',
    },
  };
  const baseInput = {
    rubricRef: 'acceptance-demo',
    previewPostRef: 'thread-post:42',
    preview: {
      approvalRequired: true,
      approval,
      changes: [{ barKey: 'R-1', kinds: ['bar-meaning'], fields: ['falsifier'] }],
    },
    reason: 'Tighten the falsifier.',
    patch: { criterion: { key: 'r-1', field: 'driftMarkers', mode: 'append', text: 'Also fails when X.' } },
    identity: { ownerId: 'su-implementer', workspaceId: 'ws' },
    workspaceId: 'ws',
    reviewSources,
  } as unknown as Parameters<typeof openAcceptanceBarAmendmentReview>[0];
  const noLaterPost = vi.fn(async () => false);

  it('resolves criteria and matching Requirements from the exact preview revisions', async () => {
    const sourceInput = {
      rubricRef: 'plan:acceptance-demo',
      preview: {
        ...baseInput.preview,
        approval: { ...approval, subjectPlan: 'acceptance-demo' },
        rubricRevision: 12,
        subjectPlanRevision: 7,
        changes: [
          { barKey: 'R-1', kinds: ['bar-meaning'], fields: ['model'] },
          { barKey: 'R-37', kinds: ['bar-meaning'], fields: ['falsifier'] },
        ],
      },
      workspaceId: 'ws',
      harness: 'papercusp',
    } as unknown as Parameters<typeof resolveAmendmentReviewSources>[0];
    const getRubric = vi.fn(async () => ({
      rubricId: 'acceptance-demo',
      revision: 12,
      criteriaHash: 'criteria-hash-12',
      subjectPlan: 'acceptance-demo',
      subjectHarnessSlug: 'papercusp',
      criteria: [
        { barKey: 'R-1', model: 'Current R-1 criterion.' },
        { barKey: 'R-31', model: 'Unrelated historical criterion.' },
        { barKey: 'R-37', model: 'Current R-37 criterion.' },
      ],
    }) as never);
    const getPlanRow = vi.fn(async () => ({
      planSlug: 'acceptance-demo',
      harnessSlug: 'papercusp',
      version: 7,
      contentHash: 'plan-content-hash-7',
      content: [
        '# Acceptance plan',
        '## Overview',
        'Overview text.',
        '## Requirements',
        'Shared requirement preamble.',
        '### R-1 — Current first requirement',
        'Current R-1 details.',
        '### R-31 — Unrelated historical requirement',
        'Do not include this inherited BAR.',
        '### R-37 — Current second requirement',
        'Current R-37 details.',
        '## Tasks',
        'Do not include tasks in the review source.',
      ].join('\r\n'),
    }) as never);

    const sources = await resolveAmendmentReviewSources(sourceInput, {
      getRubric: getRubric as never,
      getPlanRow: getPlanRow as never,
    });

    expect(getRubric).toHaveBeenCalledWith('plan:acceptance-demo');
    expect(getPlanRow).toHaveBeenCalledWith('acceptance-demo', { workspaceId: 'ws', harnessSlug: 'papercusp' });
    expect(sources.rubric).toMatchObject({
      ref: 'acceptance-demo',
      revision: 12,
      criteriaHash: 'criteria-hash-12',
    });
    expect(sources.rubric.changedCriteria.map(({ barKey }) => barKey)).toEqual(['R-1', 'R-37']);
    expect(sources.subjectPlan).toMatchObject({
      slug: 'acceptance-demo',
      harnessSlug: 'papercusp',
      revision: 7,
      contentHash: 'plan-content-hash-7',
    });
    expect(sources.subjectPlan.requirements).toContain('Shared requirement preamble.');
    expect(sources.subjectPlan.requirements).toContain('Current R-1 details.');
    expect(sources.subjectPlan.requirements).toContain('Current R-37 details.');
    expect(sources.subjectPlan.requirements).not.toContain('R-31');
    expect(sources.subjectPlan.requirements).not.toContain('## Tasks');
  });

  it('refuses a subject plan whose live revision no longer matches the preview', async () => {
    const sourceInput = {
      rubricRef: 'acceptance-demo',
      preview: {
        ...baseInput.preview,
        approval: { ...approval, subjectPlan: 'acceptance-demo' },
        rubricRevision: 12,
        subjectPlanRevision: 7,
      },
      workspaceId: 'ws',
      harness: 'papercusp',
    } as unknown as Parameters<typeof resolveAmendmentReviewSources>[0];
    const getRubric = vi.fn(async () => ({
      rubricId: 'acceptance-demo',
      revision: 12,
      subjectPlan: 'acceptance-demo',
      subjectHarnessSlug: 'papercusp',
      criteria: [],
    }) as never);
    const getPlanRow = vi.fn(async () => ({
      planSlug: 'acceptance-demo',
      harnessSlug: 'papercusp',
      version: 8,
      contentHash: 'newer-plan-content',
      content: '## Requirements\n### R-1 — Current',
    }) as never);

    await expect(resolveAmendmentReviewSources(sourceInput, {
      getRubric: getRubric as never,
      getPlanRow: getPlanRow as never,
    })).rejects.toThrow("amendment_review_sources_stale: subject plan 'acceptance-demo' is at revision 8, preview is pinned to 7");
  });

  it('routes nothing when the preview needs no approval', async () => {
    const verifyPreviewPost = vi.fn();
    const route = vi.fn();
    const result = await openAcceptanceBarAmendmentReview(
      { ...baseInput, preview: { ...baseInput.preview, approvalRequired: false } },
      { verifyPreviewPost, route },
    );
    expect(result.state).toBe('not-required');
    expect(verifyPreviewPost).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
  });

  it('refuses a preview post the apply resolver rejects, before spending a routed reviewer', async () => {
    const route = vi.fn();
    const verifyPreviewPost = vi.fn().mockRejectedValue(new Error('acceptance_bar_approval_stale_or_mismatched: R-1 hash mismatch'));
    await expect(openAcceptanceBarAmendmentReview(baseInput, { verifyPreviewPost, route })).rejects.toThrow(
      /acceptance_bar_amendment_review_preview_invalid: thread-post:42 .*stale_or_mismatched/,
    );
    expect(verifyPreviewPost).toHaveBeenCalledWith({ workspaceId: 'ws', previewPostRef: 'thread-post:42', approval });
    expect(route).not.toHaveBeenCalled();
  });

  it('refuses a preview reference that is not thread-post:<id>', async () => {
    await expect(
      openAcceptanceBarAmendmentReview({ ...baseInput, previewPostRef: 'WI-12' }, { verifyPreviewPost: vi.fn(), route: vi.fn() }),
    ).rejects.toThrow(/reviewPreviewPost must be thread-post:<id>/);
  });

  it('opens the routed review for the preview post and returns its reference', async () => {
    const route = vi.fn().mockResolvedValue({ state: 'routed', conversationId: 'conv-1', responderId: 'su-outsider', screenedOut: [] });
    const resolveSources = vi.fn().mockResolvedValue(reviewSources);
    const result = await openAcceptanceBarAmendmentReview(
      { ...baseInput, reviewSources: undefined },
      { verifyPreviewPost: vi.fn(), route, resolveSources },
    );

    expect(result).toMatchObject({ state: 'routed', conversationId: 'conv-1', previewPostRef: 'thread-post:42' });
    expect(result.next).toContain("consult:reply:conv-1");
    expect(resolveSources).toHaveBeenCalledWith({
      rubricRef: 'acceptance-demo',
      preview: baseInput.preview,
      workspaceId: 'ws',
    });
    const routed = route.mock.calls[0]![0];
    expect(routed).toMatchObject({ rubricRef: 'acceptance-demo', workspaceId: 'ws', identity: baseInput.identity });
    expect(routed.brief).toBe(buildAmendmentReviewBrief({ ...baseInput }));
    expect(routed.brief).toContain('Current rubric baseline: acceptance-demo@revision 12; criteria hash criteria-hash-12.');
    expect(routed.brief).toContain('Current R-37 details.');
  });

  it('identifies a pending fresh launch after preserving the screened routing result', async () => {
    let resolveLaunch!: (value: { state: 'not-launched'; reason: string }) => void;
    const launch = new Promise<{ state: 'not-launched'; reason: string }>((resolve) => { resolveLaunch = resolve; });
    const route = vi.fn().mockResolvedValue({ state: 'no-eligible-reviewer', conversationId: null,
      reason: 'all screened out', screenedOut: [] });
    const launchFresh = vi.fn(() => launch);
    const onPhase = vi.fn();
    const pending = openAcceptanceBarAmendmentReview({ ...baseInput, onPhase }, {
      verifyPreviewPost: vi.fn(), route, launchFresh, hasLaterPost: noLaterPost,
    });
    try {
      await vi.waitFor(() => expect(launchFresh).toHaveBeenCalledTimes(1));
      expect(onPhase).toHaveBeenLastCalledWith('review-launch');
      expect(route).toHaveBeenCalledTimes(1);
    } finally {
      resolveLaunch({ state: 'not-launched', reason: 'test launch settled' });
      await expect(pending).resolves.toMatchObject({ previewPostRef: baseInput.previewPostRef,
        freshReviewer: { state: 'not-launched', reason: 'test launch settled' } });
    }
  });

  it('carries no routed reference when no eligible reviewer exists', async () => {
    const route = vi.fn().mockResolvedValue({ state: 'no-eligible-reviewer', conversationId: null, reason: 'no_qualified_responder', screenedOut: [] });
    const launchFresh = vi.fn().mockResolvedValue({ state: 'not-launched', reason: 'launcher screened out' });
    const result = await openAcceptanceBarAmendmentReview(baseInput, { verifyPreviewPost: vi.fn(), route, launchFresh, hasLaterPost: noLaterPost });
    expect(result).toMatchObject({ state: 'no-eligible-reviewer', previewPostRef: 'thread-post:42' });
    expect(result.next).not.toContain('consult:reply');
    expect(result.next).toContain('launcher screened out');
  });

  it('does not treat an unrelated later thread reply as the retained preview reviewer response', async () => {
    const route = vi.fn().mockResolvedValue({
      state: 'no-eligible-reviewer',
      conversationId: null,
      reason: 'no_available_responder',
      screenedOut: [],
    });
    const launchFresh = vi.fn().mockResolvedValue({
      state: 'launched',
      launcherId: ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR,
      taskId: 'task-review',
      label: 'bar-amendment-review:existing',
      idempotencyKey: 'review-key',
      deduped: true,
      answerOn: { workItemId: 'WI-7', harness: 'papercusp' },
      ownerId: 'su-reviewer',
    });
    const hasLaterPost = vi.fn(async ({ authorId }: { authorId?: string }) => authorId === 'su-unrelated');
    const result = await openAcceptanceBarAmendmentReview(baseInput, {
      verifyPreviewPost: vi.fn(),
      route,
      launchFresh,
      hasLaterPost,
    });

    expect(hasLaterPost).toHaveBeenCalledWith({
      workspaceId: 'ws',
      previewPostRef: 'thread-post:42',
      authorId: 'su-reviewer',
      excludeAuthorId: 'su-implementer',
    });
    expect(launchFresh).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      state: 'no-eligible-reviewer',
      previewPostRef: 'thread-post:42',
      freshReviewer: { state: 'launched', deduped: true, ownerId: 'su-reviewer' },
    });
    expect(result.next).not.toContain('later reply');
  });

  it('requires new evidence after the retained reviewer replies to this preview', async () => {
    const route = vi.fn().mockResolvedValue({
      state: 'no-eligible-reviewer',
      conversationId: null,
      reason: 'no_available_responder',
      screenedOut: [],
    });
    const launchFresh = vi.fn().mockResolvedValue({
      state: 'launched',
      launcherId: ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR,
      taskId: 'task-review',
      label: 'bar-amendment-review:existing',
      idempotencyKey: 'review-key',
      deduped: true,
      answerOn: { workItemId: 'WI-7', harness: 'papercusp' },
      ownerId: 'su-reviewer',
    });
    const hasLaterPost = vi.fn().mockResolvedValue(true);

    const result = await openAcceptanceBarAmendmentReview(baseInput, {
      verifyPreviewPost: vi.fn(),
      route,
      launchFresh,
      hasLaterPost,
    });

    expect(hasLaterPost).toHaveBeenCalledWith({
      workspaceId: 'ws',
      previewPostRef: 'thread-post:42',
      authorId: 'su-reviewer',
      excludeAuthorId: 'su-implementer',
    });
    expect(launchFresh).toHaveBeenCalledTimes(1);
    if (result.state === 'not-required') throw new Error('Expected a reviewer attempt');
    expect(result.freshReviewer).toEqual({ state: 'not-launched', reason: expect.stringContaining('reviewEvidencePost') });
    expect(result.next).toContain('retained reviewer su-reviewer already replied');
    expect(result.next).toContain('reviewEvidencePost');
  });

  // WI-10003299: an empty menu used to end the review ("re-request later"), so a
  // plan whose whole live fleet built it could never get a BAR change approved.
  it('launches a fresh reviewer when the router staffs nobody, and says where it will answer', async () => {
    const route = vi.fn().mockResolvedValue({
      state: 'no-eligible-reviewer',
      conversationId: 'conv-9',
      reason: 'no_available_responder',
      screenedOut: [{ ownerId: 'su-peer', reason: 'related_to_plan_implementer' }],
    });
    const launchFresh = vi.fn().mockResolvedValue({
      state: 'launched',
      launcherId: ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR,
      taskId: 'task-1',
      label: 'bar-amendment-review:abc',
      idempotencyKey: 'acceptance-bar-amendment-review:abc',
      deduped: false,
      answerOn: { workItemId: 'WI-7', harness: 'papercusp' },
    });
    const launchCtx = { ownerId: 'su-implementer', workspaceId: 'ws' };
    const resolveSources = vi.fn().mockResolvedValue(reviewSources);
    const result = await openAcceptanceBarAmendmentReview(
      { ...baseInput, launchCtx, reviewSources: undefined },
      { verifyPreviewPost: vi.fn(), route, launchFresh, hasLaterPost: noLaterPost, resolveSources },
    );
    expect(launchFresh).toHaveBeenCalledTimes(1);
    expect(resolveSources).toHaveBeenCalledTimes(1);
    expect(launchFresh.mock.calls[0]![0]).toMatchObject({
      rubricRef: 'acceptance-demo',
      previewPostRef: 'thread-post:42',
      applierId: 'su-implementer',
      workspaceId: 'ws',
      patch: baseInput.patch,
      launchCtx,
      reviewSources,
    });
    expect(result).toMatchObject({
      state: 'no-eligible-reviewer',
      previewPostRef: 'thread-post:42',
      freshReviewer: { state: 'launched', taskId: 'task-1' },
      screenedOut: [{ ownerId: 'su-peer', reason: 'related_to_plan_implementer' }],
    });
    expect(result.next).toContain('work_items:comment on WI-7');
    expect(result.next).toContain("approvalRef:'thread-post:<that post id>'");
    expect(result.next).not.toMatch(/re-request later/i);
  });

  it('does not launch a fresh reviewer when the router staffed one', async () => {
    const route = vi.fn().mockResolvedValue({ state: 'routed', conversationId: 'conv-1', responderId: 'su-outsider', screenedOut: [] });
    const launchFresh = vi.fn();
    const result = await openAcceptanceBarAmendmentReview(baseInput, { verifyPreviewPost: vi.fn(), route, launchFresh });
    expect(result.state).toBe('routed');
    expect(launchFresh).not.toHaveBeenCalled();
    expect('freshReviewer' in result).toBe(false);
  });

  it('validates retained evidence before routing and passes the full evidence to the independent recruiter', async () => {
    const reviewEvidence = { postRef: 'thread-post:50', body: 'Exact API completed in 52.08s; criterion verdict remains fail.' };
    const resolveEvidence = vi.fn().mockResolvedValue(reviewEvidence);
    const route = vi.fn().mockResolvedValue({ state: 'no-eligible-reviewer', conversationId: null, reason: 'none', screenedOut: [] });
    const launchFresh = vi.fn().mockResolvedValue({ state: 'not-launched', reason: 'test' });
    await openAcceptanceBarAmendmentReview({ ...baseInput, reviewEvidencePost: reviewEvidence.postRef },
      { verifyPreviewPost: vi.fn(), resolveEvidence, route, launchFresh });
    expect(resolveEvidence).toHaveBeenCalledWith({ workspaceId: 'ws', previewPostRef: 'thread-post:42',
      evidencePostRef: 'thread-post:50', applierId: 'su-implementer' });
    expect(route.mock.calls[0]![0].brief).toContain(reviewEvidence.body);
    expect(launchFresh).toHaveBeenCalledWith(expect.objectContaining({ previewPostRef: 'thread-post:42', reviewEvidence }));
    resolveEvidence.mockRejectedValue(new Error('invalid_args: wrong evidence custody'));
    route.mockClear();
    launchFresh.mockClear();
    await expect(openAcceptanceBarAmendmentReview({ ...baseInput, reviewEvidencePost: reviewEvidence.postRef },
      { verifyPreviewPost: vi.fn(), resolveEvidence, route, launchFresh })).rejects.toThrow('wrong evidence custody');
    expect(route).not.toHaveBeenCalled();
    expect(launchFresh).not.toHaveBeenCalled();
  });

  it('reports a blocked retained reviewer with exact recovery guidance instead of waiting for approval', async () => {
    const route = vi.fn().mockResolvedValue({ state: 'no-eligible-reviewer', conversationId: null, reason: 'no_available_responder', screenedOut: [] });
    const launchFresh = vi.fn().mockResolvedValue({ state: 'blocked', reason: 'account-walled',
      evidence: 'Credit balance is too low', ownerId: 'judge-1', nativeRef: '/retained/review.jsonl',
      taskId: 'task-1', answerOn: { workItemId: 'WI-7', harness: 'papercusp' } });
    const result = await openAcceptanceBarAmendmentReview(baseInput, { verifyPreviewPost: vi.fn(), route, launchFresh, hasLaterPost: noLaterPost });
    if (result.state === 'not-required') throw new Error('Expected a reviewer attempt');
    expect(result.freshReviewer).toMatchObject({ state: 'blocked', ownerId: 'judge-1' });
    expect(result.next).toContain('Credit balance is too low');
    expect(result.next).toContain('Containment is unverified');
    expect(result.next).toContain('Do not resume or fork the reviewer yourself');
    expect(result.next).not.toContain('capability:launch-agent');
    expect(result.next).toContain('Do not wait for an approval');
    expect(result.next).not.toContain("approvalRef:'thread-post:<that post id>'");
    expect(launchFresh).toHaveBeenCalledTimes(1);
  });

  it('reports a failed fresh launch instead of throwing away the routing result', async () => {
    const route = vi.fn().mockResolvedValue({ state: 'no-eligible-reviewer', conversationId: 'conv-3', reason: 'x', screenedOut: [] });
    const launchFresh = vi.fn().mockRejectedValue(new Error('rubric unreadable'));
    const result = await openAcceptanceBarAmendmentReview(baseInput, { verifyPreviewPost: vi.fn(), route, launchFresh, hasLaterPost: noLaterPost });
    expect(result).toMatchObject({
      state: 'no-eligible-reviewer',
      conversationId: 'conv-3',
      freshReviewer: { state: 'not-launched', reason: 'fresh reviewer launch failed: rubric unreadable' },
    });
  });

  it('the routed brief uses typed consult verbs for the approval and settled outcome', () => {
    const brief = buildAmendmentReviewBrief(baseInput);
    expect(brief).toContain(JSON.stringify(approval));
    expect(brief).toContain(JSON.stringify(baseInput.patch));
    expect(brief).toContain('R-1 (bar-meaning: falsifier)');
    expect(brief).toContain('Tighten the falsifier.');
    expect(brief).toContain('Read the current criteria with rubrics:get and compare');
    expect(brief).toContain('plans:get-template-data { slug:\'<unprefixed rubric slug>\', harness:\'<current review harness>\' }');
    expect(brief).toContain('do not treat the rubric as absent');
    expect(brief).toContain('Do not call rubrics:amend or pass reviewPreviewPost');
    expect(brief).not.toContain('rubrics:amend { rubricRef');
    // The first non-empty reviewer line is the pointer; later verification prose is allowed.
    expect(brief).toContain("the first non-empty body line must be exactly approve thread-post:42. You may add verification notes on later lines");
    expect(brief).toContain('any later approval pointer must name the same preview.');
    expect(brief).toContain("Once the review is settled, call consult:close { conversation_id:'<this consult>', outcome:'answered', answer:'<concise review conclusion>', evidence:[...] }.");
    expect(brief).toContain('consult:reply records the signed post; consult:close records the accepted answer.');
    expect(brief).not.toContain('answer this consult');
    expect(brief).not.toContain('conversations:post');
    expect(/^approve thread-post:([1-9][0-9]*)$/.test('approve thread-post:42')).toBe(true);
    expect(brief).not.toContain('coord:send');
  });

  it('preserves the full requester reason in the review brief body', () => {
    const reason = `Disposition of earlier objections: ${'reason-detail '.repeat(120).trimEnd()}`;
    expect(reason.length).toBeGreaterThan(800);

    const brief = buildAmendmentReviewBrief({ ...baseInput, reason });
    const reasonLine = brief.split('\n').find((line) => line.startsWith('Reason given:'));

    expect(reasonLine).toHaveLength(`Reason given: ${reason}`.length);
    expect(reasonLine).toBe(`Reason given: ${reason}`);
  });

  it('renders normalized probe changes absent from a method-only requested patch', () => {
    const before = { key: 'r-5', barKey: 'R-5', title: 'Adoption', model: 'Source is contained.',
      check: { kind: 'probe' as const, probe: {
      kind: 'tool' as const, tool: 'status:read', args: { id: 'original' },
      schemaRevision: 'projected-tool-registry-v1:retired', expect: { path: '$.state', op: 'exists' as const },
    } } };
    const after = { ...before, check: { ...before.check, probe: {
      ...before.check.probe, schemaRevision: 'projected-tool-registry-v1:current',
    } } };
    const criterionChanges = [{ barKey: 'R-5', before, after }];
    const patch = { requirement: { key: 'R-3', method: 'Use the existing frontier check.' } };
    const brief = buildAmendmentReviewBrief({
      ...baseInput,
      patch,
      preview: { ...baseInput.preview, criterionChanges,
        changes: [{ barKey: 'R-5', kinds: ['bar-meaning'], fields: ['check'] }] },
    });

    expect(brief).toContain(JSON.stringify(patch));
    expect(brief).toContain(JSON.stringify(criterionChanges, null, 2));
    expect(brief).toContain('server-normalized');
    expect(brief).toContain('not a replacement patch');
  });

  it('treats an unapplied new BAR as expected during pre-apply review', () => {
    const newCriterion = { key: 'r-32', barKey: 'R-32', model: 'New requirement from the source Requirements.' };
    const existingCriteria = Array.from({ length: 26 }, (_, index) => ({
      key: `r-${index + 1}`,
      barKey: `R-${index + 1}`,
      model: `Existing requirement ${index + 1}.`,
    }));
    const preview: Parameters<typeof buildAmendmentReviewBrief>[0]['preview'] = {
      ...baseInput.preview,
      approval: {
        ...approval,
        schemaVersion: 1,
        kind: 'acceptance-bar-amendment-approval',
        subjectPlan: 'acceptance-demo',
        proposedPatchHash: 'c'.repeat(64),
        bars: [{ barKey: 'R-32', priorBarHash: null, nextBarHash: 'a'.repeat(64) }],
      },
      changes: [{ barKey: 'R-32', kinds: ['added'], fields: ['bar'] }],
    };
    const brief = buildAmendmentReviewBrief({
      ...baseInput,
      preview,
      reason: 'Add R-32 from the source Requirements.',
      reviewSources: {
        ...reviewSources,
        rubric: { ...reviewSources.rubric, changedCriteria: [] },
        subjectPlan: {
          ...reviewSources.subjectPlan,
          requirements: '## Requirements\n### R-32 — New source requirement\nThe source requirement for R-32.',
        },
      },
      patch: { criteria: [...existingCriteria, newCriterion] },
    });

    expect(brief).toContain('PRE-APPLY review');
    expect(brief).toContain('A new BAR is expected to be absent from the current criteria');
    expect(brief).toContain('priorBarHash:null');
    expect(brief).toContain('Do not require the new BAR, nextBarHash, or target rubric revision');
    expect(brief).toContain('Current subject-plan Requirements: acceptance-demo in harness papercusp@revision 7; content hash plan-content-hash-7.');
    expect(brief).toContain('The source requirement for R-32.');
    expect(brief).toContain(JSON.stringify(preview.approval));
    expect(brief).toContain(JSON.stringify(newCriterion));
  });

  it('front-loads spill recovery for a long review brief', () => {
    const changes = [
      { barKey: 'R-1', kinds: ['bar-meaning' as const], fields: ['model'] },
      { barKey: 'R-2', kinds: ['bar-meaning' as const], fields: ['model'] },
    ];
    const patch = {
      criteria: [
        { key: 'r-1', barKey: 'R-1', model: 'R-1 changed contract '.repeat(180) },
        { key: 'r-2', barKey: 'R-2', model: 'R-2 changed contract '.repeat(180) },
      ],
    };
    const brief = buildAmendmentReviewBrief({
      ...baseInput,
      preview: { ...baseInput.preview, changes },
      patch,
    });

    expect(brief.length).toBeGreaterThan(5000);
    expect(brief.indexOf('capability:read')).toBeLessThan(800);
    expect(brief.slice(0, 800)).toContain('eof:true');
    expect(brief.slice(0, 800)).toContain('byte_offset');
    expect(brief.slice(0, 800)).toContain('next_cursor:null');
    expect(brief.slice(0, 800)).not.toContain('through `eof:true`');
  });

  it('preserves changed criteria after a large unchanged prefix', () => {
    const unchanged = Array.from({ length: 12 }, (_, index) => ({ key: `R-${index + 2}`, model: 'unchanged '.repeat(35) }));
    const changed = { key: 'R-1', model: 'complete changed falsifier after the prefix' };
    const patch = { criteria: [...unchanged, changed], reason: 'keep this field' };
    expect(JSON.stringify(patch).length).toBeGreaterThan(2500);
    const brief = buildAmendmentReviewBrief({ ...baseInput, patch });
    const omittedKeys = unchanged.map((criterion) => criterion.key);
    expect(brief).toContain(JSON.stringify({ reason: 'keep this field', changedCriteria: [changed], omittedUnchangedBarKeys: omittedKeys }));
    expect(brief).toContain("the requester's replacement has 13 criteria");
    expect(brief).toContain(`the 12 unchanged criteria (${omittedKeys.join(', ')})`);
    expect(brief).toContain('UNCHANGED, not removed');
    expect(brief).toContain('a removed bar appears there with nextBarHash null');
    expect(brief).not.toContain(unchanged[0].model);
    expect(brief).not.toContain('chars clipped');
    expect(brief).toContain('must not be submitted to rubrics:amend');
  });

  it('emits a trimmed excerpt that cannot be replayed as a full criteria replacement (WI-10006741)', () => {
    // rubrics:amend reads `criteria` as a FULL replacement: an excerpt keyed `criteria` replays as
    // "every omitted bar removed". Three reviewers did exactly that on 2026-10-06.
    const unchanged = Array.from({ length: 12 }, (_, index) => ({ barKey: `R-${index + 2}`, model: 'unchanged '.repeat(35) }));
    const changed = { barKey: 'R-1', model: 'changed' };
    const brief = buildAmendmentReviewBrief({ ...baseInput, patch: { criteria: [...unchanged, changed] } });
    const patchBrief = brief.slice(brief.indexOf('Requested patch excerpt:'));
    const patchBlock = patchBrief.split('```json\n')[1]?.split('\n```')[0] ?? '';
    const excerpt = JSON.parse(patchBlock) as Record<string, unknown>;
    expect('criteria' in excerpt).toBe(false);
    expect(excerpt.changedCriteria).toEqual([changed]);
    expect(excerpt.omittedUnchangedBarKeys).toEqual(unchanged.map((criterion) => criterion.barKey));
  });

  it('shows a patch that fits whole, still keyed criteria', () => {
    const patch = { criteria: [{ barKey: 'R-1', model: 'small' }] };
    const brief = buildAmendmentReviewBrief({ ...baseInput, patch });
    expect(brief).toContain(JSON.stringify(patch));
    expect(brief).not.toContain('omittedUnchangedBarKeys');
  });

  it('keeps an unmappable replacement complete rather than hiding a changed criterion', () => {
    const patch = { criteria: ['x'.repeat(10_000)] };
    const brief = buildAmendmentReviewBrief({ ...baseInput, patch });
    expect(brief).toContain(JSON.stringify(patch));
    expect(brief).not.toContain('chars clipped');
  });
});

describe('launchFreshAmendmentReviewer (WI-10003299)', () => {
  const approval = { schemaVersion: 1, kind: 'acceptance-bar-approval', rubricRef: 'acceptance-demo', bars: [{ barKey: 'R-1' }] };
  const input = {
    rubricRef: 'plan:acceptance-demo',
    previewPostRef: 'thread-post:42',
    preview: { approval, changes: [{ barKey: 'R-1', kinds: ['bar-meaning'], fields: ['model'] }] },
    patch: { criterion: { key: 'r-1', field: 'model', mode: 'replace', text: 'new model' } },
    applierId: 'su-implementer',
    workspaceId: 'ws',
    // The requester's own tool context: the launch must NOT be attributed to it.
    launchCtx: { ownerId: 'su-implementer', ownerLabel: 'su · impl', isSuperuser: true, workspaceId: 'ws', harnessSlug: '*' },
  } as unknown as Parameters<typeof launchFreshAmendmentReviewer>[0];
  const answerOn = { workItemId: 'WI-7', harness: 'papercusp' };
  const launched = { data: { deduped: false, launch: { tasks: [{ taskId: 'task-1' }] } } };

  function deps<T extends Record<string, unknown>>(overrides: T = {} as T) {
    return {
      resolveAnswerTarget: vi.fn().mockResolvedValue(answerOn),
      // The implementer's lineage never includes the dedicated launcher.
      resolveScreen: vi.fn(async () => ({ check: lineageScreen('su-implementer') })),
      launch: vi.fn().mockResolvedValue(launched),
      assertAllowed: vi.fn(async () => {}),
      resolveSteeredModel: vi.fn(async () => undefined),
      // A deduped reviewer is live unless a test says it ended.
      readTaskState: vi.fn(async () => 'running' as const),
      resolveSessionStates: vi.fn(async (subjects: readonly { ownerId: string }[]) =>
        new Map(subjects.map(({ ownerId }) => [ownerId, { sessionState: 'live' as const, selfWake: 'loop' as const }] as const))),
      hasReviewerAnswer: vi.fn(async () => false),
      stopFailedLaunch: vi.fn(async () => 'stop unverified'),
      ...overrides,
    };
  }

  describe('a deduped reviewer that ended without answering (WI-6554700010010527)', () => {
    const dedupedTo = (taskId: string) => ({ data: { deduped: true, launch: { tasks: [{ taskId, ownerId: `judge-${taskId}` }] } } });
    const fresh = (taskId: string) => ({ data: { deduped: false, launch: { tasks: [{ taskId }] } } });

    it('reuses a live deduped reviewer and launches nothing new', async () => {
      const d = deps({ launch: vi.fn().mockResolvedValue(dedupedTo('task-1')) });
      expect(await launchFreshAmendmentReviewer(input, d as never)).toMatchObject({ state: 'launched', taskId: 'task-1', deduped: true });
      expect(d.launch).toHaveBeenCalledTimes(1);
      expect(d.hasReviewerAnswer).not.toHaveBeenCalled();
    });

    it('replaces a deduped reviewer parked without a self-wake source after stopping the old task', async () => {
      const launch = vi.fn().mockResolvedValueOnce(dedupedTo('task-1')).mockResolvedValueOnce(fresh('task-2'));
      let reads = 0;
      const resolveSessionStates = vi.fn(async () => new Map([
        ['judge-task-1', { sessionState: 'parked' as const, selfWake: 'none' as const }],
      ]));
      const readTaskState = vi.fn(async () => reads++ === 0 ? 'running' as const : 'ended_unobserved' as const);
      const stopFailedLaunch = vi.fn(async () => 'stopped task task-1');
      const d = deps({ launch, resolveSessionStates, readTaskState, stopFailedLaunch });
      const result = await launchFreshAmendmentReviewer(input, d as never);

      expect(resolveSessionStates).toHaveBeenCalledWith([{ ownerId: 'judge-task-1' }], { hydratePerId: true, selfWake: true });
      expect(d.hasReviewerAnswer).toHaveBeenCalledWith({ workspaceId: 'ws', previewPostRef: 'thread-post:42', authorId: 'judge-task-1' });
      expect(stopFailedLaunch).toHaveBeenCalledWith('task-1', { answeringOwnerId: 'judge-task-1' });
      expect(launch).toHaveBeenCalledTimes(2);
      const firstKey = (launch.mock.calls[0]![0] as { idempotencyKey: string }).idempotencyKey;
      expect((launch.mock.calls[1]![0] as { idempotencyKey: string }).idempotencyKey).toBe(`${firstKey}:after:task-1`);
      expect(result).toMatchObject({ state: 'launched', taskId: 'task-2', deduped: false, relaunchedAfter: ['task-1'] });
    });

    it('does not replace a stranded reviewer when stopping it is unverified', async () => {
      const launch = vi.fn().mockResolvedValue(dedupedTo('task-1'));
      const resolveSessionStates = vi.fn(async () => new Map([
        ['judge-task-1', { sessionState: 'parked' as const, selfWake: 'none' as const }],
      ]));
      const readTaskState = vi.fn(async () => 'running' as const);
      const stopFailedLaunch = vi.fn(async () => 'stop refused');
      const d = deps({ launch, resolveSessionStates, readTaskState, stopFailedLaunch });
      await expect(launchFreshAmendmentReviewer(input, d as never)).resolves.toEqual({
        state: 'not-launched',
        reason: expect.stringContaining('parked without a self-wake source'),
      });
      expect(stopFailedLaunch).toHaveBeenCalledWith('task-1', { answeringOwnerId: 'judge-task-1' });
      expect(launch).toHaveBeenCalledTimes(1);
    });

    it('relaunches under a key derived from the dead task, so the dry run gets a live reviewer', async () => {
      const launch = vi.fn().mockResolvedValueOnce(dedupedTo('task-1')).mockResolvedValueOnce(fresh('task-2'));
      const d = deps({ launch, readTaskState: vi.fn(async () => 'ended_unobserved' as const) });
      const result = await launchFreshAmendmentReviewer(input, d as never);
      expect(launch).toHaveBeenCalledTimes(2);
      const firstKey = (launch.mock.calls[0]![0] as { idempotencyKey: string }).idempotencyKey;
      expect((launch.mock.calls[1]![0] as { idempotencyKey: string }).idempotencyKey).toBe(`${firstKey}:after:task-1`);
      expect(d.hasReviewerAnswer).toHaveBeenCalledWith({ workspaceId: 'ws', previewPostRef: 'thread-post:42', authorId: 'judge-task-1' });
      expect(result).toMatchObject({ state: 'launched', taskId: 'task-2', deduped: false, relaunchedAfter: ['task-1'],
        idempotencyKey: `${firstKey}:after:task-1` });
    });

    it('keeps the ended reviewer when it already answered on the thread', async () => {
      const d = deps({ launch: vi.fn().mockResolvedValue(dedupedTo('task-1')),
        readTaskState: vi.fn(async () => 'exited' as const), hasReviewerAnswer: vi.fn(async () => true) });
      expect(await launchFreshAmendmentReviewer(input, d as never)).toMatchObject({ state: 'launched', taskId: 'task-1', deduped: true });
      expect(d.launch).toHaveBeenCalledTimes(1);
    });

    it('re-reviews later evidence on the same preview once, retaining independence and deduping retries', async () => {
      const reviewEvidence = { postRef: 'thread-post:50', body: 'New measured verification, retaining the prior objection.' };
      const launches = new Map<string, string>();
      const launch = vi.fn(async (args: { idempotencyKey: string }) => {
        if (!args.idempotencyKey.includes(':evidence:')) return dedupedTo('task-1');
        if (launches.has(args.idempotencyKey)) return dedupedTo('task-2');
        launches.set(args.idempotencyKey, 'task-2');
        return fresh('task-2');
      });
      let answered = false;
      const d = deps({ launch, readTaskState: vi.fn(async (taskId: string) => taskId === 'task-1' || answered ? 'exited' as const : 'running' as const),
        hasReviewerAnswer: vi.fn(async ({ afterPostRef, authorId }: { afterPostRef?: string; authorId?: string }) =>
          !afterPostRef || (authorId === 'judge-task-2' && answered)) });
      expect(await launchFreshAmendmentReviewer(input, d as never)).toMatchObject({ taskId: 'task-1', deduped: true });
      const request = { ...input, reviewEvidence };
      expect(await launchFreshAmendmentReviewer(request, d as never)).toMatchObject({ taskId: 'task-2', deduped: false });
      expect(await launchFreshAmendmentReviewer(request, d as never)).toMatchObject({ taskId: 'task-2', deduped: true });
      answered = true;
      expect(await launchFreshAmendmentReviewer(request, d as never)).toMatchObject({ taskId: 'task-2', deduped: true });
      expect(launches.size).toBe(1);
      expect(d.hasReviewerAnswer).toHaveBeenCalledWith({ workspaceId: 'ws', previewPostRef: 'thread-post:42',
        authorId: 'judge-task-1', afterPostRef: 'thread-post:50' });
      for (const [args, ctx] of launch.mock.calls as unknown as Array<[Record<string, unknown>, Record<string, unknown>]>) {
        expect(ctx.ownerId).toBe(ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR);
        expect(args).toMatchObject({ independent: true, headless: true });
      }
    });

    it('does not replace a live or identity-unreadable reviewer when evidence is supplied', async () => {
      const request = { ...input, reviewEvidence: { postRef: 'thread-post:50', body: 'New evidence' } };
      for (const [result, state] of [[dedupedTo('task-1'), 'running'],
        [{ data: { deduped: true, launch: { tasks: [{ taskId: 'task-1' }] } } }, 'exited']] as const) {
        const d = deps({ launch: vi.fn().mockResolvedValue(result),
          readTaskState: vi.fn(async () => state) });
        await launchFreshAmendmentReviewer(request, d as never);
        expect(d.launch).toHaveBeenCalledTimes(1);
      }
    });

    it('stops walking a chain of dead reviewers and reports reviewer-ended', async () => {
      let n = 0;
      const d = deps({ launch: vi.fn(async () => dedupedTo(`task-${++n}`)), readTaskState: vi.fn(async () => 'stranded' as const) });
      const result = await launchFreshAmendmentReviewer(input, d as never);
      expect(d.launch).toHaveBeenCalledTimes(MAX_DEAD_REVIEWER_CHAIN);
      expect(result).toMatchObject({ state: 'blocked', reason: 'reviewer-ended', taskId: `task-${MAX_DEAD_REVIEWER_CHAIN}`,
        relaunchedAfter: Array.from({ length: MAX_DEAD_REVIEWER_CHAIN }, (_, i) => `task-${i + 1}`) });
    });

    it('treats an unknown ledger state as live rather than relaunching', async () => {
      const d = deps({ launch: vi.fn().mockResolvedValue(dedupedTo('task-1')), readTaskState: vi.fn(async () => null) });
      expect(await launchFreshAmendmentReviewer(input, d as never)).toMatchObject({ state: 'launched', taskId: 'task-1' });
      expect(d.launch).toHaveBeenCalledTimes(1);
    });
  });

  it('launches ONE headless, independent judge on the recruiting runtime under the system principal', async () => {
    const d = deps();
    const result = await launchFreshAmendmentReviewer(input, d as never);
    expect(d.resolveScreen).toHaveBeenCalledWith({ rubricId: 'acceptance-demo', applierId: 'su-implementer' });
    expect(d.launch).toHaveBeenCalledTimes(1);
    const [args, ctx] = d.launch.mock.calls[0]!;
    expect(args).toMatchObject({
      harness: 'papercusp',
      headless: true,
      mcpTarget: 'spawn-host',
      independent: true,
      account: 'auto',
      count: 1,
      members: [{ role: 'judge' }],
    });
    // The lineage fence: the launch edge must point at the dedicated principal.
    expect(ctx).toMatchObject({
      ownerId: ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR,
      principal: { kind: 'system', slug: ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR, workspaceId: 'ws' },
      isSuperuser: false,
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
    });
    expect(ctx.ownerId).not.toBe('su-implementer');
    expect(args.brief).toBe(buildAmendmentReviewBrief(input, answerOn));
    expect(result).toEqual({
      state: 'launched',
      launcherId: ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR,
      taskId: 'task-1',
      label: expect.stringMatching(/^bar-amendment-review:[0-9a-f]{12}$/),
      idempotencyKey: expect.stringMatching(/^acceptance-bar-amendment-review:[0-9a-f]{32}$/),
      deduped: false,
      answerOn,
    });
  });

  it('is idempotent per preview: the same preview reuses the key, a new preview post gets a new one', async () => {
    const d = deps();
    await launchFreshAmendmentReviewer(input, d as never);
    await launchFreshAmendmentReviewer(input, d as never);
    await launchFreshAmendmentReviewer({ ...input, previewPostRef: 'thread-post:43' }, d as never);
    const keys = d.launch.mock.calls.map((call) => (call[0] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('uses the requested backend and effort and keys dedupe by the model choice', async () => {
    const d = deps();
    const reviewerModel = { agent: 'codex', model: 'sol', effort: 'xhigh' } as const;
    const constrained = { ...input, reviewerModel };
    await launchFreshAmendmentReviewer(constrained, d as never);
    await launchFreshAmendmentReviewer(constrained, d as never);
    await launchFreshAmendmentReviewer(input, d as never);
    expect(d.launch.mock.calls[0]![0]).toMatchObject({
      members: [{ role: 'judge', agent: 'codex', model: 'sol', effort: 'xhigh' }],
    });
    const keys = d.launch.mock.calls.map((call) => (call[0] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(d.assertAllowed).toHaveBeenCalledWith('ws', reviewerModel);
  });

  it('launches a Codex judge selected from the account steer without an explicit reviewerModel', async () => {
    const d = deps({ resolveSteeredModel: vi.fn(async () => ({ agent: 'codex', model: 'sol' })) });
    const steered = await launchFreshAmendmentReviewer(input, d as never);
    expect(d.resolveSteeredModel).toHaveBeenCalledWith('ws');
    expect(d.launch.mock.calls[0]![0]).toMatchObject({
      account: 'auto',
      members: [{ role: 'judge', agent: 'codex', model: 'sol' }],
    });
    const baseline = await launchFreshAmendmentReviewer(input, deps() as never);
    expect(steered.state).toBe('launched');
    expect(baseline.state).toBe('launched');
    if (steered.state === 'launched' && baseline.state === 'launched') {
      expect(steered.idempotencyKey).not.toBe(baseline.idempotencyKey);
    }
  });

  it('refuses to launch when the launcher itself fails the check-approver screen', async () => {
    const screen: AmendmentReviewerScreen = async (ownerId) =>
      ownerId === ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR
        ? { eligible: false, reason: 'related_to_plan_implementer' }
        : { eligible: true, reason: 'eligible' };
    const d = deps({ resolveScreen: vi.fn(async () => ({ check: screen })) });
    const result = await launchFreshAmendmentReviewer(input, d as never);
    expect(result).toEqual({
      state: 'not-launched',
      reason: expect.stringContaining('related_to_plan_implementer'),
    });
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('refuses to launch when the preview post is not on a work-item thread', async () => {
    const d = deps({ resolveAnswerTarget: vi.fn().mockResolvedValue(null) });
    const result = await launchFreshAmendmentReviewer(input, d as never);
    expect(result).toMatchObject({ state: 'not-launched', reason: expect.stringContaining('work-item thread') });
    expect(d.resolveScreen).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('omits the harness-scoped judge role when the work-item has no harness', async () => {
    const d = deps({ resolveAnswerTarget: vi.fn().mockResolvedValue({ workItemId: 'WI-7', harness: null }) });
    await launchFreshAmendmentReviewer(input, d as never);
    const [args] = d.launch.mock.calls[0]!;
    expect(args).not.toHaveProperty('members');
    expect(args).not.toHaveProperty('harness');
  });

  it('reports a refused launch', async () => {
    const d = deps({ launch: vi.fn().mockResolvedValue({ isError: true, content: [{ text: 'quota walled' }] }) });
    await expect(launchFreshAmendmentReviewer(input, d as never)).resolves.toEqual({
      state: 'not-launched',
      reason: 'launch refused: quota walled',
    });
  });

  function transcriptReply(text: string, synthetic = false) {
    return analyzeClaudeResumeTranscript([
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Review the amendment' } }),
      JSON.stringify({ type: 'assistant', ...(synthetic ? { isApiErrorMessage: true } : {}),
        message: { role: 'assistant', content: text } }),
    ].join('\n'));
  }

  function retainedLaunch(deduped = false) {
    return { data: { deduped, launch: { tasks: [{ taskId: 'task-1', ownerId: 'judge-1',
      kickoffProof: { nativeRef: '/retained/review.jsonl' } }] } } };
  }

  it.each([false, true])('reports a provider credit wall on a retained review (deduped=%s)', async (deduped) => {
    const d = deps({ launch: vi.fn().mockResolvedValue(retainedLaunch(deduped)),
      analyzeTranscript: vi.fn(() => transcriptReply('Credit balance is too low', true)) });
    expect(await launchFreshAmendmentReviewer(input, d as never)).toMatchObject({
      state: 'blocked', reason: 'account-walled', evidence: 'Credit balance is too low',
      taskId: 'task-1', ownerId: 'judge-1', nativeRef: '/retained/review.jsonl', deduped,
    });
    expect(d.launch).toHaveBeenCalledTimes(1);
  });

  it('waits for the new reply, rather than treating copied history as a successful review', async () => {
    let clock = 0;
    const copied = analyzeClaudeResumeTranscript([
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Old answer' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'New review' } }),
    ].join('\n'));
    const d = deps({ launch: vi.fn().mockResolvedValue(retainedLaunch()),
      analyzeTranscript: vi.fn().mockReturnValueOnce(copied).mockReturnValue(transcriptReply('Credit balance is too low', true)),
      nowMs: () => clock, sleepMs: vi.fn(async (ms: number) => { clock += ms; }) });
    expect(await launchFreshAmendmentReviewer(input, d as never)).toMatchObject({ state: 'blocked', reason: 'account-walled' });
    expect(d.sleepMs).toHaveBeenCalledTimes(1);
  });

  it('does not reject a real reviewer quoting a provider error', async () => {
    const d = deps({ launch: vi.fn().mockResolvedValue(retainedLaunch()),
      analyzeTranscript: vi.fn(() => transcriptReply('The earlier turn said Credit balance is too low; I am reviewing now.')) });
    expect(await launchFreshAmendmentReviewer(input, d as never)).toMatchObject({ state: 'launched', firstReply: 'observed' });
    expect(d.stopFailedLaunch).not.toHaveBeenCalled();
  });

  it('contains a rejected reviewer by exact task, then re-recruits through the same system principal', async () => {
    let stopped = false;
    const launch = vi.fn().mockResolvedValueOnce(retainedLaunch()).mockResolvedValueOnce(retainedLaunch(true))
      .mockResolvedValueOnce({ data: { deduped: false, launch: { tasks: [{ taskId: 'task-2' }] } } });
    const d = deps({ launch,
      analyzeTranscript: vi.fn(() => transcriptReply('Credit balance is too low', true)),
      stopFailedLaunch: vi.fn(async () => { stopped = true; return 'stopped task task-1'; }),
      readTaskState: vi.fn(async () => stopped ? 'exited' as const : 'running' as const) });
    expect(await launchFreshAmendmentReviewer(input, d as never)).toMatchObject({ state: 'blocked',
      recovery: { state: 'stopped', evidence: 'stopped task task-1' } });
    expect(d.stopFailedLaunch).toHaveBeenCalledWith('task-1', { answeringOwnerId: 'judge-1' });
    const result = await launchFreshAmendmentReviewer(input, d as never);
    expect(result).toMatchObject({ state: 'launched', taskId: 'task-2', relaunchedAfter: ['task-1'] });
    const firstKey = launch.mock.calls[0]![0].idempotencyKey;
    expect(launch.mock.calls[2]![0].idempotencyKey).toBe(`${firstKey}:after:task-1`);
    expect(launch.mock.calls.every(([, ctx]) => ctx.ownerId === ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR)).toBe(true);
  });

  it('keeps containment unverified when the stop returns without terminal task proof', async () => {
    const d = deps({ launch: vi.fn().mockResolvedValue(retainedLaunch()),
      analyzeTranscript: vi.fn(() => transcriptReply('Credit balance is too low', true)),
      stopFailedLaunch: vi.fn(async () => 'stop refused') });
    expect(await launchFreshAmendmentReviewer(input, d as never)).toMatchObject({ state: 'blocked',
      recovery: { state: 'unverified', evidence: 'stop refused' } });
    expect(d.launch).toHaveBeenCalledTimes(1);
  });

  it('preserves an independent answer that arrived before rejected-task containment', async () => {
    const d = deps({ launch: vi.fn().mockResolvedValue(retainedLaunch()),
      analyzeTranscript: vi.fn(() => transcriptReply('Credit balance is too low', true)),
      hasReviewerAnswer: vi.fn(async () => true) });
    expect(await launchFreshAmendmentReviewer(input, d as never)).toMatchObject({ state: 'launched', firstReply: 'observed' });
    expect(d.stopFailedLaunch).not.toHaveBeenCalled();
  });

  it('reports a synthetic gateway rate-limit reply as a blocked review', async () => {
    const text = 'API Error: Request rejected (429) · inference-gateway: all accounts throttled; retry after 60s';
    const analysis = analyzeClaudeResumeTranscript([
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Review the amendment' } }),
      JSON.stringify({ type: 'assistant', isApiErrorMessage: true, error: 'rate_limit',
        message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] } }),
    ].join('\n'));
    const d = deps({ launch: vi.fn().mockResolvedValue(retainedLaunch()),
      analyzeTranscript: vi.fn(() => analysis) });
    expect(await launchFreshAmendmentReviewer(input, d as never)).toMatchObject({
      state: 'blocked', reason: 'account-walled', evidence: text,
      taskId: 'task-1', ownerId: 'judge-1',
    });
  });

  it.each(['Prompt is too long', "API Error: 400 Tool reference 'mcp__papercusp_su__old' not found in available tools"])(
    'reports the existing transcript rejection class: %s', async (text) => {
      const d = deps({ launch: vi.fn().mockResolvedValue(retainedLaunch()),
        analyzeTranscript: vi.fn(() => transcriptReply(text, true)) });
      expect(await launchFreshAmendmentReviewer(input, d as never)).toMatchObject({ state: 'blocked', reason: 'first-turn-rejected', evidence: text });
    });

  describe('a reviewer whose turn ended on a transient provider error (WI-6554700010018125)', () => {
    const midResponse = 'API Error: Server error mid-response. The response above may be incomplete.';
    // The measured record shape from the stranded 2026-10-20 reviewer.
    const errored = () => analyzeClaudeResumeTranscript([
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Review the amendment' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Reading the preview.' } }),
      JSON.stringify({ type: 'assistant', isApiErrorMessage: true, error: 'server_error',
        message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: midResponse }] } }),
    ].join('\n'));

    it('reports it as blocked at launch instead of a first reply', async () => {
      const d = deps({ launch: vi.fn().mockResolvedValue(retainedLaunch()), analyzeTranscript: vi.fn(errored) });
      expect(await launchFreshAmendmentReviewer(input, d as never)).toMatchObject({
        state: 'blocked', reason: 'provider-error', evidence: midResponse, taskId: 'task-1', ownerId: 'judge-1',
      });
      expect(d.stopFailedLaunch).toHaveBeenCalledWith('task-1', { answeringOwnerId: 'judge-1' });
    });

    it('replaces a retained reviewer parked after the error even though it still has a wake source', async () => {
      const launch = vi.fn().mockResolvedValueOnce(retainedLaunch(true))
        .mockResolvedValueOnce({ data: { deduped: false, launch: { tasks: [{ taskId: 'task-2' }] } } });
      let reads = 0;
      const readTaskState = vi.fn(async () => reads++ === 0 ? 'running' as const : 'ended_unobserved' as const);
      const stopFailedLaunch = vi.fn(async () => 'stopped task task-1');
      const d = deps({ launch, readTaskState, stopFailedLaunch, analyzeTranscript: vi.fn(errored) });
      const result = await launchFreshAmendmentReviewer(input, d as never);

      expect(d.hasReviewerAnswer).toHaveBeenCalledWith({ workspaceId: 'ws', previewPostRef: 'thread-post:42', authorId: 'judge-1' });
      expect(stopFailedLaunch).toHaveBeenCalledWith('task-1', { answeringOwnerId: 'judge-1' });
      expect(launch).toHaveBeenCalledTimes(2);
      const firstKey = (launch.mock.calls[0]![0] as { idempotencyKey: string }).idempotencyKey;
      expect((launch.mock.calls[1]![0] as { idempotencyKey: string }).idempotencyKey).toBe(`${firstKey}:after:task-1`);
      expect(result).toMatchObject({ state: 'launched', taskId: 'task-2', relaunchedAfter: ['task-1'] });
    });

    it('keeps a retained reviewer that answered after the error', async () => {
      const d = deps({ launch: vi.fn().mockResolvedValue(retainedLaunch(true)), analyzeTranscript: vi.fn(errored),
        hasReviewerAnswer: vi.fn(async () => true) });
      expect(await launchFreshAmendmentReviewer(input, d as never)).toMatchObject({ state: 'launched', taskId: 'task-1', firstReply: 'observed' });
      expect(d.launch).toHaveBeenCalledTimes(1);
      expect(d.stopFailedLaunch).not.toHaveBeenCalled();
    });
  });

  it('keeps an unreadable transcript as uncertainty', async () => {
    const d = deps({ launch: vi.fn().mockResolvedValue(retainedLaunch()), analyzeTranscript: vi.fn(() => null) });
    expect(await launchFreshAmendmentReviewer(input, d as never)).toMatchObject({ state: 'launched', firstReply: 'unreadable' });
  });

  it('bounds a pending first reply even if the clock stalls', async () => {
    const pending = analyzeClaudeResumeTranscript(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Review' } }));
    const d = deps({ launch: vi.fn().mockResolvedValue(retainedLaunch()), analyzeTranscript: vi.fn(() => pending),
      nowMs: () => 0, sleepMs: vi.fn(async () => {}) });
    expect(await launchFreshAmendmentReviewer(input, d as never)).toMatchObject({ state: 'launched', firstReply: 'pending' });
    expect(d.sleepMs).toHaveBeenCalledTimes(40);
  });

  it('the fresh brief asks for one work_items:comment on the preview work-item, not a consult answer', () => {
    const brief = buildAmendmentReviewBrief(input, answerOn);
    expect(brief.split('\n')).toContain(
      "To approve, use work_items:comment { id:'WI-7', harness:'papercusp' }, body: approve thread-post:42 on the first non-empty line. Add verification notes on later lines if useful; any later approval pointer must name the same preview.",
    );
    expect(brief).not.toContain('answer this consult');
    // A judge cannot call rubrics:amend, so the fresh brief must not require it.
    expect(brief).not.toContain('rubrics:amend');
    expect(brief).toContain(JSON.stringify(approval));
    expect(brief).toContain(ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR);
    expect(brief).toContain("call `session:end { reason: 'BAR amendment review complete' }`");
    expect(brief).toContain('do not just finish the turn');
  });

  it('asks a headless one-shot consult reviewer to close its session after the verdict', () => {
    const brief = buildAmendmentReviewBrief(input);
    expect(brief).toContain('consult:close');
    expect(brief).toContain('consult:decline');
    expect(brief).toContain('If you are the headless one-shot reviewer launched for this consult');
    expect(brief).toContain(
      "after the review settles (consult:reply then consult:close, or consult:decline), call session:end { reason: 'BAR amendment review complete' } to close this session; do not just finish the turn.",
    );
  });
});

describe('selectFreshReviewerModelForAccountSteer', () => {
  const ranks = [
    { rank: 1, agent: 'claude', model: 'fable' },
    { rank: 2, agent: 'codex', model: 'sol' },
  ] as const;
  const accounts = [
    { id: 'claude-1', provider: 'claude', available: true },
    { id: 'codex-1', provider: 'codex', available: true },
  ];

  it('chooses the first expert model whose provider has an allowed account', () => {
    expect(selectFreshReviewerModelForAccountSteer({
      forcedAccounts: ['codex-1'], excludeAccounts: [], accounts, ranks,
    })).toEqual({ agent: 'codex', model: 'sol' });
    expect(selectFreshReviewerModelForAccountSteer({
      forcedAccounts: [], excludeAccounts: ['claude-1'], accounts, ranks,
    })).toEqual({ agent: 'codex', model: 'sol' });
  });

  it('uses the first available allowed rank without account restrictions', () => {
    expect(selectFreshReviewerModelForAccountSteer({
      forcedAccounts: [], excludeAccounts: [], accounts, ranks,
    })).toEqual({ agent: 'claude', model: 'fable' });
    expect(selectFreshReviewerModelForAccountSteer({
      forcedAccounts: [], excludeAccounts: [],
      accounts: accounts.map((account) => ({ ...account, available: account.provider === 'codex' })),
      ranks,
    })).toEqual({ agent: 'codex', model: 'sol' });
  });

  it('never widens the model policy or falls back to a default login when no allowed rank is available', () => {
    expect(() => selectFreshReviewerModelForAccountSteer({
      forcedAccounts: [], excludeAccounts: [],
      accounts: accounts.map((account) => ({ ...account, available: false })), ranks,
    })).toThrow('no expert model has an available account permitted by the workspace account steer');
    expect(() => selectFreshReviewerModelForAccountSteer({
      forcedAccounts: [], excludeAccounts: [],
      accounts: [{ id: 'codex-1', provider: 'codex', available: true }],
      ranks: [{ rank: 1, agent: 'claude', model: 'fable' }],
    })).toThrow('no expert model has an available account permitted by the workspace account steer');
  });

  it('refuses an unavailable forced pool even if another provider is available', () => {
    expect(() => selectFreshReviewerModelForAccountSteer({
      forcedAccounts: ['codex-1'], excludeAccounts: [],
      accounts: accounts.map((account) => ({ ...account, available: account.id !== 'codex-1' })),
      ranks,
    })).toThrow('no expert model has an available account permitted by the workspace account steer');
  });
});
