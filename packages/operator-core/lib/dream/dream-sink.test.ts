import { describe, expect, it, vi } from 'vitest';
import type { CaptureImprovementResult } from '../harness/improvements/capture-core';
import type { DreamInsight } from './dream-pass';
import type { DreamReviewResult } from './dream-review';
import { buildDreamInsightBody, dreamIdeaId, sinkDreamInsight, type DreamSinkDeps } from './dream-sink';
import type { DreamFragment } from './fragment-sampler';

const INSIGHT: DreamInsight = {
  text: 'Gate repeated retries using the remote memory watermark.',
  requiresA: 'A shows the repeated retry symptom.',
  requiresB: 'B identifies the watermark transition.',
  actionable: 'Reject a second retry after the watermark rises.',
};

const FRAGMENTS: readonly DreamFragment[] = [
  {
    id: 'recent',
    kind: 'observation',
    ref: 'wi:EI-retry-storm',
    text: 'Repeated retries saturated a queue.',
    createdAt: '2026-08-20T12:00:00.000Z',
    harness: 'papercusp',
  },
  {
    id: 'remote',
    kind: 'memory',
    ref: 'memory:watermark-guard',
    text: 'A watermark guarded an earlier transition.',
    createdAt: '2026-07-01T12:00:00.000Z',
    harness: 'papercusp',
  },
];

const ACCEPTED: Extract<DreamReviewResult, { verdict: 'accept' }> = {
  verdict: 'accept',
  stage: 'grader',
  scores: { dependence: 2, actionability: 2, novelty: 1 },
  note: 'Both fragments are required and the guard is falsifiable.',
  priorMatches: [],
  usage: { model: 'claude-opus-5', costUsd: 0.02, inputTokens: 250, outputTokens: 40 },
};

function captured(over: Partial<CaptureImprovementResult> = {}): CaptureImprovementResult {
  return {
    ok: true,
    created: true,
    possibleDuplicates: [],
    issue: { id: 'EI-900' } as NonNullable<CaptureImprovementResult['issue']>,
    ...over,
  };
}

function deps(result: CaptureImprovementResult = captured()) {
  const capture = vi.fn(async () => result);
  const recordRoutedIdea = vi.fn(async () => undefined);
  return {
    value: { capture, recordRoutedIdea, now: () => 1_787_274_000_000 } satisfies DreamSinkDeps,
    capture,
    recordRoutedIdea,
  };
}

function input(review: DreamReviewResult = ACCEPTED) {
  return {
    dreamRunId: 'DR-42',
    cycleId: 'dream-cycle-7',
    harnessSlug: 'papercusp',
    insight: INSIGHT,
    fragments: FRAGMENTS,
    review,
    workspaceId: 'papercusp-workspace',
    createdBy: 'system:dream-cycle',
  };
}

describe('dream accepted-insight sink', () => {
  it("captures on the existing improvement rail and enrolls origin='dream' with fragment refs", async () => {
    const d = deps();

    await expect(sinkDreamInsight(input(), d.value)).resolves.toEqual({
      sunk: true,
      ideaId: 'dream:DR-42',
      workItemId: 'EI-900',
      routedRef: 'wi:EI-900',
      sourceRefs: ['wi:EI-retry-storm', 'memory:watermark-guard'],
      created: true,
    });
    expect(d.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'feature',
        scope: 'harness:papercusp',
        sourceRole: 'system',
        filedByRole: 'dream',
        foundDuring: 'dream-cycle',
        semanticBlockBand: 'soft',
        watchdogKey: 'dream:DR-42',
        payloadExtra: {
          dream: expect.objectContaining({
            dreamRunId: 'DR-42',
            cycleId: 'dream-cycle-7',
            sourceRefs: ['wi:EI-retry-storm', 'memory:watermark-guard'],
          }),
          // The sink stamps the ideation-origin payload key at capture time, so the item
          // classifies as ideation from creation (scout/ideation-origin.ts). Literal on
          // purpose: the key is persisted and matched by SQL, so its wire value is the contract.
          ideaOrigin: 'dream',
        },
      }),
    );
    expect(d.recordRoutedIdea).toHaveBeenCalledWith({
      ideaId: 'dream:DR-42',
      origin: 'dream',
      lens: 'dream',
      rail: 'improvement',
      routedRef: 'wi:EI-900',
      harnessSlug: 'papercusp',
      cycleId: 'dream-cycle-7',
      title: INSIGHT.text,
      addressesPatternRefs: ['wi:EI-retry-storm', 'memory:watermark-guard'],
      routedAt: 1_787_274_000_000,
      workspaceId: 'papercusp-workspace',
      createdBy: 'system:dream-cycle',
    });
  });

  it('attributes a coalesced dream to the existing improvement without dropping its own idea row', async () => {
    // P-002 (silent-intake, D-001): the search-first decline is retired, so the
    // surviving created:false path is the burst COALESCE — same attribution shape.
    const d = deps(
      captured({
        created: false,
        reason: 'coalesced',
        issue: undefined,
        possibleDuplicates: [
          { id: 'EI-existing', title: 'Existing guard', state: 'open', severity: 'minor', similarity: 0.94 },
        ],
      }),
    );

    await expect(sinkDreamInsight(input(), d.value)).resolves.toMatchObject({
      sunk: true,
      created: false,
      captureReason: 'coalesced',
      ideaId: 'dream:DR-42',
      workItemId: 'EI-existing',
      routedRef: 'wi:EI-existing',
    });
    expect(d.recordRoutedIdea).toHaveBeenCalledWith(
      expect.objectContaining({ ideaId: 'dream:DR-42', routedRef: 'wi:EI-existing', origin: 'dream' }),
    );
  });

  it('is a side-effect-free no-op for a rejected review', async () => {
    const d = deps();
    const rejected: DreamReviewResult = {
      verdict: 'reject',
      stage: 'grader',
      reason: 'dependence-zero',
      scores: { dependence: 0, actionability: 2, novelty: 2 },
      note: 'The observation alone implies the retry guard.',
      priorMatches: [],
      usage: { model: 'claude-opus-5', costUsd: 0.01, inputTokens: 200, outputTokens: 30 },
    };

    await expect(sinkDreamInsight(input(rejected), d.value)).resolves.toEqual({
      sunk: false,
      reason: 'review-rejected',
    });
    expect(d.capture).not.toHaveBeenCalled();
    expect(d.recordRoutedIdea).not.toHaveBeenCalled();
  });

  it('fails closed when capture cannot name an artifact for the Blender outcome join', async () => {
    const d = deps(captured({ created: false, issue: undefined, possibleDuplicates: [] }));

    await expect(sinkDreamInsight(input(), d.value)).rejects.toThrow(
      'dream sink capture returned no routable artifact for dream:DR-42',
    );
    expect(d.recordRoutedIdea).not.toHaveBeenCalled();
  });

  it('requires distinct, target-harness provenance refs', async () => {
    const d = deps();
    const sameRef = [{ ...FRAGMENTS[0] }, { ...FRAGMENTS[1], ref: FRAGMENTS[0].ref }];
    await expect(sinkDreamInsight({ ...input(), fragments: sameRef }, d.value)).rejects.toThrow(
      'at least two distinct source refs',
    );
    await expect(
      sinkDreamInsight(
        { ...input(), fragments: FRAGMENTS.map((fragment) => ({ ...fragment, harness: 'other' })) },
        d.value,
      ),
    ).rejects.toThrow('target harness');
    expect(d.capture).not.toHaveBeenCalled();
  });

  it('renders the review and source provenance into the human artifact too', () => {
    expect(
      buildDreamInsightBody({
        dreamRunId: 'DR-42',
        cycleId: 'dream-cycle-7',
        insight: INSIGHT,
        sourceRefs: ['wi:EI-retry-storm', 'memory:watermark-guard'],
        review: ACCEPTED,
      }),
    ).toContain('Independent review: dependence 2/2, actionability 2/2, novelty 1/2');
    expect(dreamIdeaId('DR-42')).toBe('dream:DR-42');
  });
});
