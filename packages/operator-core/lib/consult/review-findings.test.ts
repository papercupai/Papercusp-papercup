import { describe, expect, it } from 'vitest';
import { appendConsultReview, readConsultReview } from './review-findings';

const author = { postId: 7, authorId: 'reviewer', requesterId: 'builder', at: '2026-10-31T00:00:00Z' };
const answer = { subjectRef: 'plan:review@revision-a', coverage: 'complete' as const,
  findings: [{ key: 'F1', severity: 'major' as const, text: 'Retry loses the work item', evidenceRefs: ['source:retry.ts'] }] };

describe('durable consult finding provenance', () => {
  it('keeps original findings when dispositions change and never mutates the earlier receipt', () => {
    const original = appendConsultReview({ ...author, answer });
    const planned = appendConsultReview({ ...author, postId: 8, authorId: 'builder', current: original,
      dispositions: [{ findingId: 'post:7#F1', status: 'planned', reason: 'Fix during implementation', reference: 'plan:review#P-002' }] });
    const fixed = appendConsultReview({ ...author, postId: 9, authorId: 'builder', current: planned,
      dispositions: [{ findingId: 'post:7#F1', status: 'fixed', reason: 'Recovery test passes', reference: 'test-run:42' }] });
    expect(original.dispositions).toEqual([]);
    expect(fixed.findings).toEqual(original.findings);
    expect(fixed.findings[0]).toMatchObject({ reviewerId: 'reviewer', postId: 7, subjectRef: answer.subjectRef });
    expect(fixed.dispositions.map(d => d.status)).toEqual(['planned', 'fixed']);
  });
  it('keeps an incomplete zero-findings assessment distinct from a complete review', () => {
    const state = appendConsultReview({ ...author, answer: { ...answer, coverage: 'incomplete', findings: [] } });
    expect(readConsultReview(JSON.stringify({ review: state }))?.answers[0].coverage).toBe('incomplete');
    expect(state.findings).toEqual([]);
  });
  it('rejects invented finding references and reviewer-authored dispositions', () => {
    const current = appendConsultReview({ ...author, answer });
    const dispositions = [{ findingId: 'post:999#F1', status: 'rejected' as const, reason: 'No evidence', reference: 'source:retry.ts' }];
    expect(() => appendConsultReview({ ...author, authorId: 'builder', current, dispositions })).toThrow('Unknown review finding');
    expect(() => appendConsultReview({ ...author, current, dispositions })).toThrow('Only the requester');
  });
  it('refuses damaged persisted provenance instead of treating it as reviewed evidence', () => {
    expect(() => readConsultReview({ review: null })).toThrow('Invalid persisted');
    const review = appendConsultReview({ ...author, answer });
    expect(() => readConsultReview({ review: { ...review, findings: [{ ...review.findings[0], reviewerId: '' }] } }))
      .toThrow('Invalid persisted');
  });
});
