import { describe, expect, it } from 'vitest';
import type { CorpusEntry } from '../scout/critique-core';
import type { ScoutLlmCall } from '../scout/types';
import { DEFAULT_DREAM_REVIEW_CONFIG } from './dream-config';
import { buildDreamReviewPrompt, parseDreamReviewPayload, runDreamReview } from './dream-review';
import type { DreamInsight } from './dream-pass';
import type { DreamFragment } from './fragment-sampler';

function fragment(id: string, kind: DreamFragment['kind'], text = `evidence from ${id}`): DreamFragment {
  return {
    id,
    kind,
    ref: `${kind}:${id}`,
    text,
    createdAt: '2026-08-20T12:00:00.000Z',
    harness: 'papercusp',
  };
}

function fakeLlm(payload: { json?: unknown; text?: string; error?: Error }): {
  llmCall: ScoutLlmCall;
  calls: Array<Parameters<ScoutLlmCall>[0]>;
} {
  const calls: Array<Parameters<ScoutLlmCall>[0]> = [];
  const llmCall: ScoutLlmCall = async (input) => {
    calls.push(input);
    input.onAdmitted?.();
    input.onResponseStart?.();
    if (payload.error) throw payload.error;
    return {
      text: payload.text ?? '',
      json: payload.json,
      costUsd: 0.02,
      inputTokens: 250,
      outputTokens: 40,
    };
  };
  return { llmCall, calls };
}

const FRAGMENTS = [fragment('recent', 'observation'), fragment('remote', 'memory')] as const;
const REVIEW_MODEL = DEFAULT_DREAM_REVIEW_CONFIG.model;
const INSIGHT: DreamInsight = {
  text: 'Gate repeated retries using the remote memory watermark.',
  requiresA: 'A shows the repeated retry symptom.',
  requiresB: 'B identifies the watermark transition.',
  actionable: 'Reject a second retry after the watermark rises.',
};

const CORPUS: CorpusEntry[] = [
  { ref: 'wi:prior', kind: 'idea', text: 'An unrelated prior idea', state: 'open' },
  { ref: 'memory:old', kind: 'memory', text: 'A remote operational memory' },
  { ref: 'digest:queue', kind: 'digest-pattern', text: 'Queues repeatedly lose their watermark' },
];

function acceptedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verdict: 'accept',
    dependence: 2,
    actionability: 2,
    novelty: 1,
    note: 'Both fragments are required and the proposed guard is testable.',
    ...overrides,
  };
}

describe('buildDreamReviewPrompt', () => {
  it('orders the skeptical rubric and fences the claimed insight and source fragments', () => {
    const prompt = buildDreamReviewPrompt({
      insight: INSIGHT,
      fragments: FRAGMENTS,
      priorMatches: [{ ref: 'memory:old', kind: 'memory', text: 'prior text', similarity: 0.6 }],
    });

    expect(prompt.system.indexOf('1. dependence')).toBeLessThan(prompt.system.indexOf('2. actionability'));
    expect(prompt.system.indexOf('2. actionability')).toBeLessThan(prompt.system.indexOf('3. novelty'));
    expect(prompt.system).toContain('A score of 0 is fatal');
    expect(prompt.user).toContain(`<insight>${INSIGHT.text}</insight>`);
    expect(prompt.user).toContain('<fragment>\nevidence from recent\n</fragment>');
    expect(prompt.user).toContain('memory:old (memory, similarity 0.6): prior text');
  });
});

describe('parseDreamReviewPayload', () => {
  it('accepts the exact bounded score shape', () => {
    expect(parseDreamReviewPayload(acceptedPayload())).toMatchObject({ ok: true });
  });

  it.each([
    [acceptedPayload({ dependence: 1.5 }), 'dependence'],
    [acceptedPayload({ novelty: 3 }), 'novelty'],
    [acceptedPayload({ extra: true }), 'Unrecognized key'],
    [acceptedPayload({ note: 'x'.repeat(601) }), 'exceeds 600'],
  ])('rejects malformed review output without coercion: %o', (payload, message) => {
    const result = parseDreamReviewPayload(payload);
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toContain(message);
  });
});

describe('runDreamReview', () => {
  it('mechanically rejects an above-threshold duplicate before spending on the grader', async () => {
    const exact = { ...CORPUS[0], text: INSIGHT.text };
    const { llmCall, calls } = fakeLlm({ json: acceptedPayload() });

    await expect(
      runDreamReview({
        insight: INSIGHT,
        fragments: FRAGMENTS,
        corpus: [exact],
        dreamerModel: 'claude-haiku-4-5',
        llmCall,
      }),
    ).resolves.toMatchObject({ verdict: 'reject', stage: 'dedupe', reason: 'duplicate', usage: null });
    expect(calls).toHaveLength(0);
  });

  it('uses injected semantic similarity to dedupe memory and digest-pattern corpus entries', async () => {
    const { llmCall, calls } = fakeLlm({ json: acceptedPayload() });

    const result = await runDreamReview({
      insight: INSIGHT,
      fragments: FRAGMENTS,
      corpus: CORPUS,
      dreamerModel: 'claude-haiku-4-5',
      llmCall,
      novelty: {
        semanticSimByRef: new Map([
          ['wi:prior', 0.1],
          ['memory:old', 0.91],
          ['digest:queue', 0.2],
        ]),
      },
    });

    expect(result).toMatchObject({
      verdict: 'reject',
      stage: 'dedupe',
      reason: 'duplicate',
      priorMatches: [{ ref: 'memory:old', similarity: 0.91, semantic: true }],
    });
    expect(calls).toHaveLength(0);
  });

  it('makes one bounded independent grader call and accepts only a strong consistent verdict', async () => {
    const { llmCall, calls } = fakeLlm({ json: acceptedPayload() });

    await expect(
      runDreamReview({
        insight: INSIGHT,
        fragments: FRAGMENTS,
        corpus: CORPUS,
        dreamerModel: 'claude-haiku-4-5',
        llmCall,
      }),
    ).resolves.toMatchObject({
      verdict: 'accept',
      stage: 'grader',
      scores: { dependence: 2, actionability: 2, novelty: 1 },
      usage: { model: REVIEW_MODEL, costUsd: 0.02 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: REVIEW_MODEL,
      responseFormat: 'json',
      maxTokens: 1_024,
    });
    expect(calls[0]?.system).toContain('independent DREAM REVIEWER');
  });

  it('allows a same-model reviewer as a separately prompted review phase', async () => {
    const { llmCall, calls } = fakeLlm({ json: acceptedPayload() });

    const result = await runDreamReview({
      insight: INSIGHT,
      fragments: FRAGMENTS,
      corpus: CORPUS,
      dreamerModel: REVIEW_MODEL,
      llmCall,
    });

    expect(result).toMatchObject({ verdict: 'accept', usage: { model: REVIEW_MODEL } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe(REVIEW_MODEL);
    expect(calls[0]?.system).toContain('independent DREAM REVIEWER');
  });

  it('rejects missing dreamer-model provenance before the call', async () => {
    const { llmCall, calls } = fakeLlm({ json: acceptedPayload() });

    await expect(
      runDreamReview({
        insight: INSIGHT,
        fragments: FRAGMENTS,
        corpus: CORPUS,
        dreamerModel: '   ',
        llmCall,
      }),
    ).resolves.toMatchObject({
      verdict: 'reject',
      reason: 'reviewer-not-independent',
      note: 'Dreamer model provenance is missing',
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [acceptedPayload({ dependence: 0, actionability: 2, novelty: 2 }), 'dependence-zero'],
    [acceptedPayload({ actionability: 0 }), 'actionability-zero'],
    [acceptedPayload({ novelty: 0 }), 'novelty-zero'],
    [acceptedPayload({ dependence: 1, actionability: 1, novelty: 1 }), 'below-score-threshold'],
    [acceptedPayload({ verdict: 'reject' }), 'grader-rejected'],
  ])('fails closed for %s as %s', async (payload, reason) => {
    const { llmCall } = fakeLlm({ json: payload });
    await expect(
      runDreamReview({
        insight: INSIGHT,
        fragments: FRAGMENTS,
        corpus: CORPUS,
        dreamerModel: 'claude-haiku-4-5',
        llmCall,
      }),
    ).resolves.toMatchObject({ verdict: 'reject', stage: 'grader', reason });
  });

  it('rejects malformed strict JSON without retrying', async () => {
    const { llmCall, calls } = fakeLlm({ text: '```json\n{"verdict":"accept"}\n```' });

    await expect(
      runDreamReview({
        insight: INSIGHT,
        fragments: FRAGMENTS,
        corpus: CORPUS,
        dreamerModel: 'claude-haiku-4-5',
        llmCall,
      }),
    ).resolves.toMatchObject({ verdict: 'reject', reason: 'malformed' });
    expect(calls).toHaveLength(1);
  });

  it('turns a grader transport failure into an explicit rejection', async () => {
    const { llmCall } = fakeLlm({ error: new Error('review transport failed') });

    await expect(
      runDreamReview({
        insight: INSIGHT,
        fragments: FRAGMENTS,
        corpus: CORPUS,
        dreamerModel: 'claude-haiku-4-5',
        llmCall,
      }),
    ).resolves.toMatchObject({
      verdict: 'reject',
      reason: 'grader-error',
      note: 'review transport failed',
      usage: { model: REVIEW_MODEL, costUsd: 0 },
    });
  });
});
