import { describe, expect, it } from 'vitest';
import { REVIEW_AUDIT_STRATA, reviewAuditQuotas, reviewAuditStratum, type ReviewAuditPopulation } from './review-grading-live-replay';

const population = (values: Partial<ReviewAuditPopulation>): ReviewAuditPopulation =>
  Object.fromEntries(REVIEW_AUDIT_STRATA.map(s=>[s,values[s] ?? 0])) as ReviewAuditPopulation;

describe('review audit provenance', () => {
  it('does not turn coordination or spec assessments into ordinary code review', () => {
    for (const rubricRef of ['pot-coordination-health','spec-quality']) {
      expect(reviewAuditStratum({ rubricRef, rubricKind:'standard', acceptance:null })).toBe('other-rubric-assessments');
    }
  });
  it('recognizes a suffix-named acceptance rubric from canonical kind', () => {
    const row={rubricRef:'shared-agent-obligations-and-briefs-2026-09-05-acceptance',rubricKind:'acceptance'};
    expect(reviewAuditStratum({...row,acceptance:null})).toBe('independent-acceptance');
    expect(reviewAuditStratum({...row,acceptance:{verdict:'accept'}})).toBe('author-acceptance');
  });
  it('keeps missing metadata and malformed author verdicts unresolved', () => {
    expect(reviewAuditStratum({rubricRef:'acceptance-unresolved',rubricKind:null,acceptance:null})).toBe('unresolved-rubric');
    for(const acceptance of [false,'accept',[]]) {
      expect(reviewAuditStratum({rubricRef:'x',rubricKind:'acceptance',acceptance})).toBe('unresolved-rubric');
    }
  });
  it('keeps known vetting and grading-integrity families explicit', () => {
    expect(reviewAuditStratum({rubricRef:'meta-acceptance-rubric',rubricKind:'standard',acceptance:null})).toBe('rubric-vetting');
    expect(reviewAuditStratum({rubricRef:'grading-integrity-spec-test-adequacy',rubricKind:'standard',acceptance:null})).toBe('grading-integrity');
  });
});

describe('bounded stratified draw', () => {
  it('covers a rare PR review without substituting the large residual population', () => {
    const p=population({'ordinary-code-review':1,'other-rubric-assessments':10_000,'author-acceptance':2});
    const q=reviewAuditQuotas(p,80);
    expect(q['ordinary-code-review']).toBe(1);
    expect(q['author-acceptance']).toBeGreaterThan(0);
    expect(Object.values(q).reduce((a,b)=>a+b,0)).toBe(80);
    for(const s of REVIEW_AUDIT_STRATA) expect(q[s]).toBeLessThanOrEqual(p[s]);
  });
  it('retains empty review populations instead of inventing a sample', () => {
    const q=reviewAuditQuotas(population({'other-rubric-assessments':4}),80);
    expect(q['ordinary-code-review']).toBe(0);
    expect(Object.values(q).reduce((a,b)=>a+b,0)).toBe(4);
    expect(reviewAuditQuotas(population({}),80)).toEqual(population({}));
  });
  it('is deterministic under exact fractional ties and exhausts small populations', () => {
    const p=population({'author-acceptance':4,'independent-acceptance':4,'ordinary-code-review':4});
    expect(reviewAuditQuotas(p,5)).toEqual(population({
      'author-acceptance':2,'independent-acceptance':2,'ordinary-code-review':1,
    }));
    expect(Object.values(reviewAuditQuotas(p,5)).reduce((a,b)=>a+b,0)).toBe(5);
    expect(reviewAuditQuotas(p,80)).toEqual(p);
  });
  it('refuses a draw too small for its populated strata and invalid denominators', () => {
    expect(()=>reviewAuditQuotas(population({'author-acceptance':1,'ordinary-code-review':1}),1)).toThrow('sample_cannot_cover');
    expect(()=>reviewAuditQuotas(population({'author-acceptance':-1}),80)).toThrow('population_invalid');
    expect(()=>reviewAuditQuotas(population({}),81)).toThrow('sample_size_invalid');
  });
});
