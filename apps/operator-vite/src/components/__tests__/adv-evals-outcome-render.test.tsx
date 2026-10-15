import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BenchmarkEvidenceNote, PreservedOutcomeStats } from '../adv/AdvEvalsTab';

const renderOutcome = (overrides: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(
  PreservedOutcomeStats,
  { summary: { arm: 'papercusp', resolvedCount: 1, taskCount: 5, gradedCount: 1,
    resolvedPct: 0.2, conditionalResolvedPct: 1, missingGradeCount: 0, ...overrides } },
));

describe('rendered preserved outcome scores', () => {
  it('shows the assigned primary denominator separately from conditional graded quality', () => {
    const html = renderOutcome();
    expect(html).toContain('20%');
    expect(html).toContain('1/5 assigned tasks resolved');
    expect(html).toContain('100%');
    expect(html).toContain('1/1 graded submissions · conditional quality');
    expect(html).toContain('including non-attempts and generation failures');
  });

  it('shows missing grader measurement as inconclusive while retaining measured conditional quality', () => {
    const html = renderOutcome({ resolvedPct: null, missingGradeCount: 2 });
    expect(html).toContain('2 submissions await official grades; primary score is inconclusive');
    expect(html).toContain('—');
    expect(html).toContain('1/5 assigned tasks resolved');
    expect(html).toContain('100%');
    expect(html).not.toContain('20%');
  });

  it('retains measured zero and an absent conditional measurement for an unattempted run', () => {
    const html = renderOutcome({ resolvedCount: 0, gradedCount: 0, resolvedPct: 0, conditionalResolvedPct: null });
    expect(html).toContain('0%');
    expect(html).toContain('0/5 assigned tasks resolved');
    expect(html).toContain('0/0 graded submissions · conditional quality');
    expect(html).toContain('—');
    expect(html).not.toContain('inconclusive');
  });
});

describe('rendered benchmark evidence classes', () => {
  const measured = {
    resolved: true,
    armMeta: { currentExecution: { kind: 'current-su', identityStatus: 'measured',
      measured: { sourceRevision: 'source', runtimeRevision: 'runtime', clientVersion: 'client', promptHash: 'prompt', toolsHash: 'tools' },
      protocolIdentity: { status: 'matched' }, preregistration: { gitCommitSha: 'committed', receiptRef: 'receipt' } } },
  };
  const renderEvidence = (over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(
    BenchmarkEvidenceNote, { tasks: [measured], expectedAssignments: 1,
      hasFrozenProtocol: true, protocolCommitted: true, ...over },
  ));

  it('labels measured current outcomes only with complete assignment and observed protocol identity', () => {
    const verified = renderEvidence();
    expect(verified).toContain('Current measured evidence');
    expect(verified).toContain('assigned outcomes are measured');
    for (const over of [
      { protocolCommitted: false }, { expectedAssignments: 2 }, { missingGradeCount: 1 },
      { tasks: [{ ...measured, resolved: null }] }, { tasks: [{ resolved: true }] },
      { tasks: [{ ...measured, armMeta: { currentExecution: {
        ...measured.armMeta.currentExecution, protocolIdentity: { status: 'mismatch' },
      } } }] },
    ]) {
      const html = renderEvidence(over);
      expect(html).toContain('Incomplete current evidence');
      expect(html).not.toContain('<strong>Current measured evidence</strong>');
    }
  });

  it('keeps synthetic and archived provenance visible even with successful graded rows', () => {
    const fixture = renderEvidence({ tasks: [{ ...measured, armMeta: { ...measured.armMeta, synthetic: true } }] });
    expect(fixture).toContain('Synthetic fixture evidence');
    expect(fixture).toContain('do not measure current product performance');
    const archive = renderEvidence({ source: 'import', missingGradeCount: 1 });
    expect(archive).toContain('Historical archive evidence');
    expect(archive).toContain('1 submissions await official grades');
    for (const html of [fixture, archive, renderEvidence({ hasFrozenProtocol: false })]) {
      expect(html).not.toContain('<strong>Current measured evidence</strong>');
      expect(html).not.toContain('assigned outcomes are measured');
    }
  });
});
