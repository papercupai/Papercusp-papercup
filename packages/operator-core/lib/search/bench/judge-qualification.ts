/** Bounded qualification of the maintained relevance judge on exact delivered rows.
 * This measures a judge contract, never retrieval quality or population coverage.
 */
import { createHash } from 'node:crypto';
import type { LlmCallFn, LlmCallResult } from '@papercusp/testing-shell/llm';
import {
  JUDGE_AGREEMENT_MODEL, JUDGE_AGREEMENT_RUBRIC_VERSION, judgeRelevance,
  RELEVANCE_PASS_BAR, SELF_CONSISTENCY_TEMPERATURE, type JudgeableDoc,
} from './judge-agreement';
import { DOCS_FINAL_INPUT_CONTRACT } from './adapter-baseline-capture';

export type QualificationClass = 'positive' | 'easy-negative' | 'near-miss';
export interface QualificationCase extends JudgeableDoc {
  class: QualificationClass;
  goldRelevant: boolean;
  goldBasis: string;
}
export interface QualificationPolicy {
  version: 1;
  inputContract: typeof DOCS_FINAL_INPUT_CONTRACT;
  model: string;
  rubricVersion: string;
  sourceInputSha256: string;
  cases: QualificationCase[];
  limits: {
    maxCalls: number; maxCostUsd: number; perCallReservationUsd: number;
    maxPromptBytes: number; maxOutputTokens: number; maxDurationMs: number; maxCallMs: number;
  };
  pricingEvidence: string;
  /** This small sanity screen requires every case and repeat to agree with its gold. */
  acceptance: { minimumPerClass: number; requiredAgreement: 1; maximumFlipRate: 0 };
}
export const qualificationHash = (x: unknown): string =>
  createHash('sha256').update(JSON.stringify(x)).digest('hex');

export function validateQualificationPolicy(p: QualificationPolicy): void {
  if (p.version !== 1 || p.inputContract !== DOCS_FINAL_INPUT_CONTRACT ||
      p.model !== JUDGE_AGREEMENT_MODEL || p.rubricVersion !== JUDGE_AGREEMENT_RUBRIC_VERSION ||
      !/^[a-f0-9]{64}$/.test(p.sourceInputSha256) || !p.pricingEvidence?.trim()) {
    throw new Error('Qualification contract or source pin differs from the current judge');
  }
  const l = p.limits;
  if (!l || Object.values(l).some(n => !Number.isFinite(n) || n <= 0) ||
      ![l.maxCalls, l.maxPromptBytes, l.maxOutputTokens, l.maxDurationMs, l.maxCallMs].every(Number.isSafeInteger) ||
      l.maxCalls !== p.cases.length * 2 || l.maxCallMs > l.maxDurationMs ||
      l.perCallReservationUsd > l.maxCostUsd ||
      p.acceptance.requiredAgreement !== 1 || p.acceptance.maximumFlipRate !== 0 ||
      !Number.isSafeInteger(p.acceptance.minimumPerClass) || p.acceptance.minimumPerClass < 2) {
    throw new Error('Invalid qualification bounds or acceptance policy');
  }
  const seen = new Set<string>();
  for (const c of p.cases) {
    if (!c.pairId?.trim() || seen.has(c.pairId) || !c.query?.trim() || !c.docId?.trim() ||
        !c.docText?.trim() || !c.goldBasis?.trim() ||
        !['positive', 'easy-negative', 'near-miss'].includes(c.class) ||
        c.goldRelevant !== (c.class === 'positive')) throw new Error('Invalid or duplicate gold case');
    const row = JSON.parse(c.docText) as { slug?: string };
    if (row.slug !== c.docId) throw new Error('Gold case is not an exact final-row document');
    seen.add(c.pairId);
  }
  for (const group of ['positive', 'easy-negative', 'near-miss']) {
    if (p.cases.filter(c => c.class === group).length < p.acceptance.minimumPerClass) {
      throw new Error(`Insufficient ${group} cases`);
    }
  }
}

export interface QualificationCall {
  ordinal: number; caseId: string; pass: number; promptSha256: string;
  startedAt: string; durationMs: number; reservationUsd: number;
  result?: LlmCallResult; error?: string;
  errorEvidence?: { costUsd?: number; costUsdMeasurementMissing?: boolean;
    promptSha256?: string; transportDiagnostics?: unknown };
}

/** Each transport settlement is journalled before parsing its grade. Unknown cost
 * aborts the run and retains its reservation; it cannot become an invented free call.
 */
export async function runJudgeQualification(p: QualificationPolicy, deps: {
  llm: LlmCallFn;
  onCall: (record: QualificationCall) => void | Promise<void>;
  now?: () => number;
}) {
  validateQualificationPolicy(p);
  const now = deps.now ?? Date.now;
  const start = now();
  let calls = 0;
  let costUsd = 0;
  const rows: Array<{ caseId: string; class: QualificationClass; pass: number;
    relevance: number; relevant: boolean; agrees: boolean }> = [];
  for (const pass of [0, 1]) for (const c of p.cases) {
    const meter: LlmCallFn = async opts => {
      const remaining = p.limits.maxDurationMs - (now() - start);
      const prompt = JSON.stringify({ system: opts.system ?? '', messages: opts.messages });
      if (calls >= p.limits.maxCalls || remaining <= 0 ||
          costUsd + p.limits.perCallReservationUsd > p.limits.maxCostUsd + 1e-12 ||
          Buffer.byteLength(prompt) > p.limits.maxPromptBytes || opts.model !== p.model) {
        throw new Error('Qualification dispatch refused by frozen call/time/cost/input/model budget');
      }
      const at = now();
      const record: QualificationCall = { ordinal: ++calls, caseId: c.pairId, pass,
        promptSha256: createHash('sha256').update(prompt).digest('hex'),
        startedAt: new Date(at).toISOString(), durationMs: 0,
        reservationUsd: p.limits.perCallReservationUsd };
      let result: LlmCallResult;
      try {
        const timeout = AbortSignal.timeout(Math.max(1, Math.min(remaining, p.limits.maxCallMs)));
        result = await deps.llm({ ...opts, maxTokens: p.limits.maxOutputTokens,
          requireOutputTokenLimit: true, harnessSlug: 'papercusp',
          signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout });
      } catch (e) {
        const error = e as { costUsd?: number; costUsdMeasurementMissing?: boolean;
          promptSha256?: string; transportDiagnostics?: unknown } | null;
        await deps.onCall({ ...record, durationMs: now() - at,
          error: e instanceof Error ? e.message : String(e),
          errorEvidence: error && typeof error === 'object' ? {
            ...(typeof error.costUsd === 'number' ? { costUsd: error.costUsd } : {}),
            ...(typeof error.costUsdMeasurementMissing === 'boolean'
              ? { costUsdMeasurementMissing: error.costUsdMeasurementMissing } : {}),
            ...(typeof error.promptSha256 === 'string' ? { promptSha256: error.promptSha256 } : {}),
            ...(error.transportDiagnostics === undefined ? {} : { transportDiagnostics: error.transportDiagnostics }),
          } : {} });
        throw e;
      }
      await deps.onCall({ ...record, durationMs: now() - at, result });
      if (result.costUsdMeasurementMissing || !Number.isFinite(result.costUsd) || result.costUsd < 0 ||
          !Number.isSafeInteger(result.inputTokens) || result.inputTokens <= 0 ||
          !Number.isSafeInteger(result.outputTokens) || result.outputTokens <= 0 ||
          result.outputTokens > p.limits.maxOutputTokens ||
          result.costUsd > p.limits.perCallReservationUsd + 1e-12 ||
          now() - start > p.limits.maxDurationMs ||
          ['max_tokens', 'length'].includes(result.stopReason ?? '')) {
        throw new Error('Qualification transport usage, cost, completion or deadline is unqualified; reservation retained');
      }
      costUsd += result.costUsd;
      return result;
    };
    // Gold and stratum never reach the prompt; docText is passed without a slice.
    const v = await judgeRelevance({ pairId: c.pairId, query: c.query, docId: c.docId,
      docText: c.docText }, meter, p.model, pass ? SELF_CONSISTENCY_TEMPERATURE : undefined);
    if (!Number.isFinite(v.relevance) || v.relevance < 0 || v.relevance > 5) throw new Error('Invalid judge score');
    rows.push({ caseId: c.pairId, class: c.class, pass, relevance: v.relevance,
      relevant: v.relevance >= RELEVANCE_PASS_BAR, agrees: v.judgedRelevant === c.goldRelevant });
  }
  const byClass = (['positive', 'easy-negative', 'near-miss'] as const).map(group => {
    const groupRows = rows.filter(r => r.class === group);
    return { class: group, cases: groupRows.length / 2, judgments: groupRows.length,
      agreement: groupRows.filter(r => r.agrees).length / groupRows.length };
  });
  const flips = p.cases.filter(c => rows.find(r => r.caseId === c.pairId && r.pass === 0)!.relevant !==
    rows.find(r => r.caseId === c.pairId && r.pass === 1)!.relevant).length;
  return { version: 1, policySha256: qualificationHash(p), model: p.model,
    rubricVersion: p.rubricVersion, inputContract: p.inputContract,
    calls, costUsd, durationMs: now() - start, rows, byClass,
    flipRate: flips / p.cases.length,
    qualified: rows.every(r => r.agrees) && flips === 0,
    retrievalQualityAccepted: false, populationAdequate: false,
    caveats: ['Constructed qualification queries on retained rows, not independent production opportunities.',
      'Passing this small screen qualifies only this frozen judge/input contract; it does not establish general judge accuracy.'] };
}
