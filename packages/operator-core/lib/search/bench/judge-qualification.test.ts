import { describe, expect, it, vi } from 'vitest';
import type { LlmCallFn, LlmCallResult } from '@papercusp/testing-shell/llm';
import { JUDGE_AGREEMENT_MODEL, JUDGE_AGREEMENT_RUBRIC_VERSION } from './judge-agreement';
import { runJudgeQualification, validateQualificationPolicy, type QualificationPolicy } from './judge-qualification';

function policy(): QualificationPolicy {
  return { version: 1, inputContract: 'docs-search-final-row-json-v1',
    model: JUDGE_AGREEMENT_MODEL, rubricVersion: JUDGE_AGREEMENT_RUBRIC_VERSION,
    sourceInputSha256: 'a'.repeat(64), pricingEvidence: 'frozen price-table source',
    cases: ['positive', 'easy-negative', 'near-miss'].flatMap((group, i) => [0, 1].map(j => ({
      pairId: `${group}-${j}`, query: `${group} query ${j}`, docId: `doc-${i}-${j}`,
      docText: JSON.stringify({ slug: `doc-${i}-${j}`, excerpt: 'Only if qualified. '.repeat(100) }),
      class: group as QualificationPolicy['cases'][number]['class'], goldRelevant: group === 'positive',
      goldBasis: 'Constructed independent gold, never included in the prompt' }))),
    limits: { maxCalls: 12, maxCostUsd: 1.2, perCallReservationUsd: 0.1,
      maxPromptBytes: 20000, maxOutputTokens: 1024, maxDurationMs: 180000, maxCallMs: 30000 },
    acceptance: { minimumPerClass: 2, requiredAgreement: 1, maximumFlipRate: 0 } };
}
function response(score: number): LlmCallResult {
  const json = { scores: { relevance: score }, findings: [], notes: 'Bounded test verdict' };
  return { text: JSON.stringify(json), json, inputTokens: 1000, outputTokens: 50,
    costUsd: 0.004, stopReason: 'end_turn', raw: null };
}

describe('bounded final-row judge qualification', () => {
  it('requires all three classes and a fresh repeat per case before dispatch', () => {
    for (const mutate of [
      (p: QualificationPolicy) => { p.cases.pop(); },
      (p: QualificationPolicy) => { p.cases[1]!.pairId = p.cases[0]!.pairId; },
      (p: QualificationPolicy) => { p.rubricVersion = 'stale'; },
      (p: QualificationPolicy) => { p.cases[0]!.docText = '{"slug":"different"}'; },
    ]) { const p = policy(); mutate(p); expect(() => validateQualificationPolicy(p)).toThrow(); }
  });

  it('passes the complete row to the maintained judge and meters both passes without gold leakage', async () => {
    const p = policy(); const journal: unknown[] = [];
    const llm = vi.fn<LlmCallFn>(async opts => {
      expect(opts.requireOutputTokenLimit).toBe(true);
      expect(opts.maxTokens).toBe(1024);
      expect(opts.harnessSlug).toBe('papercusp');
      expect(opts.messages[0]!.content).toContain('Only if qualified. '.repeat(100));
      expect(JSON.stringify(opts)).not.toContain('Constructed independent gold');
      return response(opts.messages[0]!.content.includes('positive query') ? 5 : 1);
    });
    const r = await runJudgeQualification(p, { llm, onCall: row => { journal.push(row); } });
    expect(r).toMatchObject({ qualified: true, calls: 12, flipRate: 0,
      retrievalQualityAccepted: false, populationAdequate: false });
    expect(r.byClass.map(x => [x.cases, x.judgments, x.agreement])).toEqual([[2, 4, 1], [2, 4, 1], [2, 4, 1]]);
    expect(llm).toHaveBeenCalledTimes(12); expect(journal).toHaveLength(12);
    expect(llm.mock.calls[6]![0].temperature).toBe(0.4);
  });

  it('fails qualification on a near-miss false positive or binary repeat flip', async () => {
    let i = 0;
    const r = await runJudgeQualification(policy(), { llm: async opts => {
      i++; return response(i === 11 ? 5 : opts.messages[0]!.content.includes('positive query') ? 5 : 1);
    }, onCall: () => {} });
    expect(r.qualified).toBe(false); expect(r.flipRate).toBeGreaterThan(0);
    expect(r.byClass.find(x => x.class === 'near-miss')!.agreement).toBeLessThan(1);
  });

  it.each([{ costUsdMeasurementMissing: true }, { inputTokens: 0 },
    { outputTokens: 1025 }, { costUsd: 0.11 }, { stopReason: 'max_tokens' }])(
    'journals unqualified usage and stops before another paid call: %j', async change => {
      const journal: unknown[] = []; const llm = vi.fn<LlmCallFn>(async () => ({ ...response(5), ...change }));
      await expect(runJudgeQualification(policy(), { llm, onCall: x => { journal.push(x); } })).rejects.toThrow(/unqualified/);
      expect(llm).toHaveBeenCalledTimes(1); expect(journal).toHaveLength(1);
    });

  it('refuses dispatch before consuming an unavailable cost reservation or oversized prompt', async () => {
    const p = policy(); p.limits.maxPromptBytes = 10;
    const llm = vi.fn<LlmCallFn>();
    await expect(runJudgeQualification(p, { llm, onCall: () => {} })).rejects.toThrow(/dispatch refused/);
    expect(llm).not.toHaveBeenCalled();
    const costPolicy = policy(); costPolicy.limits.maxCostUsd = 0.1;
    const paid = vi.fn<LlmCallFn>(async () => response(5));
    await expect(runJudgeQualification(costPolicy, { llm: paid, onCall: () => {} })).rejects.toThrow(/dispatch refused/);
    expect(paid).toHaveBeenCalledTimes(1);
  });

  it('refuses a late settlement instead of using it as qualification', async () => {
    let time = 0;
    await expect(runJudgeQualification(policy(), { now: () => time, onCall: () => {},
      llm: async () => { time = 180001; return response(5); } })).rejects.toThrow(/deadline/);
  });

  it('journals provider errors without treating missing spend as zero', async () => {
    const journal: unknown[] = []; const llm = vi.fn<LlmCallFn>(async () => {
      throw Object.assign(new Error('provider failed'), { costUsdMeasurementMissing: true,
        promptSha256: 'measured-prompt-hash', transportDiagnostics: [{ stage: 'response-headers', outcome: 'aborted' }] });
    });
    await expect(runJudgeQualification(policy(), { llm, onCall: x => { journal.push(x); } })).rejects.toThrow('provider failed');
    expect(journal).toMatchObject([{ ordinal: 1, reservationUsd: 0.1, error: 'provider failed',
      errorEvidence: { costUsdMeasurementMissing: true, promptSha256: 'measured-prompt-hash',
        transportDiagnostics: [{ stage: 'response-headers', outcome: 'aborted' }] } }]);
    expect(llm).toHaveBeenCalledTimes(1);
  });
});
