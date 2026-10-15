import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateReviewGradingArtifact, type ReviewGradingAuditArtifact } from './review-grading-audit-artifact';

const audit = (): ReviewGradingAuditArtifact => JSON.parse(readFileSync(new URL(
  '../../../docs/evidence/review-grading-80-record-judgments-2026-10-09.json', import.meta.url), 'utf8'));

describe('recorded audit evidence cannot conceal missing trace or measurement edges', () => {
  it('checks the preserved population and every recorded criterion', () => {
    expect(validateReviewGradingArtifact(audit())).toEqual({ records: 80, criteria: 662, metrics: 6 });
  });
  it('rejects substituted sample identity and silently omitted criteria', () => {
    const a = audit(); a.traceability.records[0].id = 'EI-substituted';
    expect(() => validateReviewGradingArtifact(a)).toThrow('trace_identity');
    const b = audit(); b.traceability.records[0].ratings.pop();
    expect(() => validateReviewGradingArtifact(b)).toThrow('criterion_population');
  });
  it('does not backfill an absent historical revision or hide that gap', () => {
    const a = audit(); const trace = a.traceability.records.find(r => r.rubricRevision === null)!;
    trace.rubricRevision = 999;
    expect(() => validateReviewGradingArtifact(a)).toThrow('trace_identity');
    const b = audit(); b.traceability.records.find(r => r.rubricRevision === null)!.missingEdges = [];
    expect(() => validateReviewGradingArtifact(b)).toThrow();
  });
  it('does not turn a work-item mention into an explicit remediation link', () => {
    const a = audit(); const trace = a.traceability.records.find(r => r.ratings.some(v => !v[4] && !v[5]))!;
    trace.ratings.find(v => !v[4] && !v[5])![6] = ['WI-claimed-from-subject'];
    expect(() => validateReviewGradingArtifact(a)).toThrow('remediation_link_invented');
  });
  it('does not promote a completion claim or historical blob into verified impact', () => {
    const a = audit(); a.traceability.records[0].implementationImpact = 'VERIFIED';
    expect(() => validateReviewGradingArtifact(a)).toThrow('unverified_impact');
  });
  it('requires every metric and its owned live-source guard', () => {
    const a = audit(); a.measurementSpecification.metrics.pop();
    expect(() => validateReviewGradingArtifact(a)).toThrow('metric_population');
    const b = audit(); b.measurementSpecification.recurrenceGuards[0].owner = '';
    expect(() => validateReviewGradingArtifact(b)).toThrow('metric_or_guard');
  });
  it('keeps unavailable grading cost attribution and unstarted activation explicit', () => {
    const a = audit(); a.measurementSpecification.metrics.find(m => m.key === 'tool-calls')!.status = '0';
    expect(() => validateReviewGradingArtifact(a)).toThrow('unattributed_cost');
    const b = audit(); b.measurementSpecification.startWatermark.value = '2026-10-09T00:00:00Z';
    expect(() => validateReviewGradingArtifact(b)).toThrow('activation_receipt');
  });
});

