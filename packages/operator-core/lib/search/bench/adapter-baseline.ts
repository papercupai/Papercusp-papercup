/**
 * Join a prospective adapter study to retained invocation, label and cost receipts.
 * No retrieval, live sampling, judge calls or persistence occurs here. The runner
 * must capture the actual adapter's final snippets and independent runtime pins.
 * These guards establish receipt consistency, not authenticity of supplied proof.
 * Relevance arithmetic and per-cell budget decisions belong to the existing core.
 */
import { createHash } from 'node:crypto';
import {
  assertSearchEvaluation,
  evaluateRelevance,
  type SearchEvaluationAttempt,
  type SearchEvaluationDeclaration,
  type SearchEvaluationPins,
  type SearchEvaluationRun,
} from '@papercusp/search-core';
import { judgeScoreToGrade, scoreQuery, type LabelledHit, type RankedHit } from './labelled-relevance';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Object insertion order cannot change an invocation's identity. Arrays retain order. */
export function adapterFingerprint(value: Json): string {
  const canonical = (v: Json): string => {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v !== null && typeof v === 'object') return `{${Object.keys(v).sort()
      .map(key => `${JSON.stringify(key)}:${canonical(v[key]!)}`).join(',')}}`;
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('non-finite fingerprint input');
    return JSON.stringify(v);
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export interface FrozenAdapterQuery {
  id: string;
  cellId: string;
  query: string;
  /** The exact request, including scope/filter/mode/default decisions. */
  args: { [key: string]: Json };
  queryField: string;
  k: number;
  /** Independently frozen known-item labels; omitted means recall is unknown. */
  groundTruthIds?: string[];
}

export interface AdapterJudgeContract {
  model: string;
  rubricVersion: string;
  /** Fingerprint of the exact delivered-input framing, including clipping policy. */
  inputContract: string;
}

export interface FrozenAdapterStudy {
  declaration: SearchEvaluationDeclaration;
  queries: FrozenAdapterQuery[];
  judge: AdapterJudgeContract;
  /** A provider bill and an attributed total are different quantities. */
  costContracts: Record<string, {
    metric: string;
    unit: 'USD/attempt';
    boundary: string;
    pricingFingerprint: string;
  }>;
}

/** A separately verified pilot. Numeric policy/uncertainty/provider proof lives at evidenceRef. */
export interface AdapterJudgeQualification {
  contract: AdapterJudgeContract;
  evidenceRef: string;
  policyRef: string;
  completedAtMs: number;
}

export interface AdapterInvocationReceipt {
  id: string;
  cellId: string;
  adapter: string;
  invocationRef: string;
  requestFingerprint: string;
  requestedK: number;
  pins: SearchEvaluationPins;
  outcome: SearchEvaluationAttempt['outcome'];
  executed: boolean;
  degraded: boolean;
  latencyMs: number | null;
  /** EXACT final delivered snippets in delivered order, without a second excerpt/clip. */
  hits: RankedHit[];
}

export interface AdapterLabelReceipt {
  attemptId: string;
  invocationRef: string;
  docId: string;
  inputFingerprint: string;
  contract: AdapterJudgeContract;
  qualificationRef: string;
  judgedAtMs: number;
  relevance: number;
  judgeCostUsd: number;
  evidenceRef: string;
}

export interface AdapterRetrievalCost {
  attemptId: string;
  invocationRef: string;
  /** Evaluation-judge spend is deliberately not part of this type. */
  retrievalCostUsd: number;
  contractFingerprint: string;
  meter: 'provider-usage' | 'local-resource-meter';
  evidenceRef: string;
}

export function adapterQuerySetFingerprint(queries: FrozenAdapterQuery[]): string {
  return adapterFingerprint(queries as unknown as Json);
}

export function adapterStudyFingerprint(study: FrozenAdapterStudy): string {
  return adapterFingerprint(study as unknown as Json);
}

export function adapterLabelInputFingerprint(query: string, hit: Pick<RankedHit, 'docId' | 'docText'>): string {
  return adapterFingerprint({ query, docId: hit.docId, docText: hit.docText });
}

const same = (a: unknown, b: unknown): boolean =>
  adapterFingerprint(a as Json) === adapterFingerprint(b as Json);
const nonnegative = (n: number | null): n is number => n !== null && Number.isFinite(n) && n >= 0;

export function evaluateAdapterBaseline(input: {
  study: FrozenAdapterStudy;
  /** Captured by the runner, never reconstructed by copying the expected declaration. */
  executionDeclaration: SearchEvaluationDeclaration;
  /** Written by the runner before any retrieval or labels, from the frozen study. */
  executionStudyFingerprint: string;
  startedAtMs: number;
  pins: SearchEvaluationPins;
  receipts: AdapterInvocationReceipt[];
  labels: AdapterLabelReceipt[];
  costs: AdapterRetrievalCost[];
  qualification: AdapterJudgeQualification | null;
}) {
  const { study } = input;
  const failures: string[] = [];
  const unknowns: string[] = [];
  const fail = (id: string, text: string) => failures.push(`${id}: ${text}`);
  const expected = new Map(study.declaration.cells.flatMap(cell => cell.attemptIds.map(id => [id, cell] as const)));
  const queries = new Map<string, FrozenAdapterQuery>();
  if (input.executionStudyFingerprint !== adapterStudyFingerprint(study)) fail('manifest', 'frozen study changed');
  for (const cell of study.declaration.cells) {
    const contract = study.costContracts[cell.id];
    if (!contract || contract.unit !== 'USD/attempt' ||
        ![contract.metric, contract.boundary, contract.pricingFingerprint].every(v => typeof v === 'string' && v.trim())) {
      fail(cell.id, 'missing retrieval cost definition, boundary, unit or pricing pin');
    }
  }
  for (const id of Object.keys(study.costContracts)) if (!study.declaration.cells.some(cell => cell.id === id)) {
    fail(id, 'undeclared cost population');
  }
  if (!Object.values(study.judge).every(v => typeof v === 'string' && v.trim())) fail('judge', 'incomplete judge contract');
  if (adapterQuerySetFingerprint(study.queries) !== study.declaration.pins.querySet) fail('manifest', 'frozen query set changed');
  for (const query of study.queries) {
    if (queries.has(query.id) || expected.get(query.id)?.id !== query.cellId) fail(query.id, 'duplicate or wrong-cell frozen query');
    queries.set(query.id, query);
    if (!query.query.trim() || query.args[query.queryField] !== query.query || !Number.isInteger(query.k) || query.k < 1 ||
        (query.args.limit !== undefined && query.args.limit !== query.k)) {
      fail(query.id, 'invalid frozen adapter query');
    }
    if (query.groundTruthIds && (new Set(query.groundTruthIds).size !== query.groundTruthIds.length ||
        query.groundTruthIds.some(id => !id.trim()))) fail(query.id, 'invalid independent ground truth');
  }
  for (const id of expected.keys()) if (!queries.has(id)) fail(id, 'missing frozen query');
  const index = <T>(rows: T[], keyOf: (row: T) => string, kind: string) => {
    const result = new Map<string, T>();
    for (const row of rows) {
      const key = keyOf(row);
      if (result.has(key)) fail(key, `duplicate ${kind}`);
      else result.set(key, row);
    }
    return result;
  };
  const receipts = index(input.receipts, r => r.id, 'invocation receipt');
  const costs = index(input.costs, c => c.attemptId, 'retrieval cost receipt');
  const labelKey = (attemptId: string, docId: string) => JSON.stringify([attemptId, docId]);
  const labels = index(input.labels, l => labelKey(l.attemptId, l.docId), 'label receipt');
  for (const [kind, rows] of [['invocation', input.receipts.map(r => r.id)],
    ['label', input.labels.map(l => l.attemptId)], ['cost', input.costs.map(c => c.attemptId)]] as const) {
    for (const id of rows) if (!expected.has(id)) fail(id, `undeclared ${kind} receipt`);
  }
  const pilot = input.qualification;
  const pilotReady = pilot !== null && same(pilot.contract, study.judge) && !!pilot.evidenceRef.trim() &&
    !!pilot.policyRef.trim() && nonnegative(pilot.completedAtMs) && pilot.completedAtMs < input.startedAtMs;
  if (!pilotReady && study.declaration.cells.some(cell => cell.quality !== 'no-match')) {
    unknowns.push('judge: current matching pre-run pilot qualification is unavailable');
  }
  const attempts: SearchEvaluationAttempt[] = [];
  for (const [id, cell] of expected) {
    const query = queries.get(id), receipt = receipts.get(id);
    const attempt: SearchEvaluationAttempt = { id, cellId: cell.id, outcome: 'unknown', executed: false,
      degraded: false, latencyMs: null, costUsd: null, resultCount: null };
    attempts.push(attempt);
    if (!receipt || !query) continue;
    if (receipt.cellId !== cell.id || receipt.adapter !== cell.adapter || !receipt.invocationRef.trim() ||
        receipt.requestFingerprint !== adapterFingerprint(query as unknown as Json) || receipt.requestedK !== query.k ||
        !same(receipt.pins, input.pins)) {
      fail(id, 'adapter, request, invocation or actual runtime pins differ');
      continue;
    }
    Object.assign(attempt, { outcome: receipt.outcome, executed: receipt.executed, degraded: receipt.degraded,
      latencyMs: receipt.latencyMs, resultCount: receipt.hits.length });
    const cost = costs.get(id);
    if (cost) {
      if (cost.invocationRef !== receipt.invocationRef || !cost.evidenceRef.trim() ||
          !study.costContracts[cell.id] || cost.contractFingerprint !== adapterFingerprint(study.costContracts[cell.id]!) ||
          !['provider-usage', 'local-resource-meter'].includes(cost.meter) || !nonnegative(cost.retrievalCostUsd)) {
        fail(id, 'retrieval cost is not bound to this invocation and meter');
      } else attempt.costUsd = cost.retrievalCostUsd;
    }
    if (receipt.hits.length > query.k || new Set(receipt.hits.map(h => h.docId)).size !== receipt.hits.length ||
        receipt.hits.some((h, i) => !h.docId.trim() || h.rank !== i + 1 || typeof h.docText !== 'string')) {
      fail(id, 'invalid final delivered ranking');
      continue;
    }
    if (cell.quality === 'no-match') {
      // Emptiness can be checked without a paid judge, but cannot supply its own gold.
      if (query.groundTruthIds === undefined || query.groundTruthIds.length !== 0) {
        attempt.resultCount = null;
        unknowns.push(`${id}: no-match case lacks independent empty ground truth`);
      }
      continue;
    }
    const labelled: LabelledHit[] = [];
    for (const hit of receipt.hits) {
      const label = labels.get(labelKey(id, hit.docId));
      if (!label) { unknowns.push(`${id}: missing label for ${hit.docId}`); continue; }
      if (label.invocationRef !== receipt.invocationRef || !same(label.contract, study.judge) ||
          label.inputFingerprint !== adapterLabelInputFingerprint(query.query, hit) || !label.evidenceRef.trim() ||
          !nonnegative(label.judgeCostUsd) || !Number.isFinite(label.relevance) || label.relevance < 0 || label.relevance > 5 ||
          !nonnegative(label.judgedAtMs)) {
        fail(id, `label does not match final delivered input/contract for ${hit.docId}`);
        continue;
      }
      if (!pilotReady || label.qualificationRef !== pilot!.evidenceRef || label.judgedAtMs <= pilot!.completedAtMs) {
        unknowns.push(`${id}: label lacks matching prior pilot for ${hit.docId}`);
        continue;
      }
      labelled.push({ ...hit, relevance: label.relevance, grade: judgeScoreToGrade(label.relevance), judgeCostUsd: label.judgeCostUsd });
    }
    if (labelled.length !== receipt.hits.length || !pilotReady || receipt.outcome !== 'success' || receipt.degraded) continue;
    const scored = scoreQuery(labelled, query.k);
    // Keep the maintained returned-set metrics; recall alone requires independent gold.
    attempt.quality = query.groundTruthIds === undefined ? scored : evaluateRelevance({
      ranked: labelled, grade: hit => hit.grade, k: query.k,
      groundTruth: { ids: query.groundTruthIds, idOf: hit => hit.docId },
    });
  }
  for (const label of input.labels) {
    if (!receipts.get(label.attemptId)?.hits.some(hit => hit.docId === label.docId)) fail(label.attemptId, 'label outside delivered ranking');
  }
  const run: SearchEvaluationRun = { startedAtMs: input.startedAtMs, declaration: input.executionDeclaration,
    pins: input.pins, attempts };
  const assertion = assertSearchEvaluation(study.declaration, run);
  assertion.failures.push(...failures);
  assertion.unknowns.push(...unknowns);
  assertion.status = assertion.failures.length ? 'fail' : assertion.unknowns.length ? 'unknown' : 'pass';
  return { run, assertion,
    // Keep real partial/failed judge spend separate from the production cost budget.
    judgeSpendUsd: labels.size === input.labels.length && input.labels.every(l => nonnegative(l.judgeCostUsd))
      ? input.labels.reduce((sum, l) => sum + l.judgeCostUsd, 0) : null,
    retrievalCostMeasured: attempts.filter(a => a.costUsd !== null).length,
  };
}
