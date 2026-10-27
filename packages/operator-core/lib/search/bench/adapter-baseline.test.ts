import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessAdapterBaselineArtifact, runAdapterBaselineCli } from './adapter-baseline-cli';
import {
  adapterFingerprint, adapterLabelInputFingerprint, adapterQuerySetFingerprint, adapterStudyFingerprint, evaluateAdapterBaseline,
  type AdapterInvocationReceipt, type FrozenAdapterStudy,
} from './adapter-baseline';

function fixture() {
  const judge = { model: 'fixture-judge', rubricVersion: 'fixture-rubric', inputContract: 'final-snippets-verbatim-v1' };
  const study: FrozenAdapterStudy = {
    judge,
    costContracts: Object.fromEntries(['cold', 'warm'].map(id => [id, { metric: 'provider-billed-retrieval',
      unit: 'USD/attempt' as const, boundary: 'retrieval provider calls only; local compute unmeasured', pricingFingerprint: 'fixture-price-v1' }])),
    declaration: { declaredAtMs: 10, pins: { sourceRevision: 'fixture-source', corpus: 'fixture-corpus', querySet: '', modelConfiguration: 'fixture-config' },
      cells: ['cold', 'warm'].map(temperature => ({ id: temperature, product: 'papercusp', adapter: 'docs:search',
        queryClass: 'one-term', temperature: temperature as 'cold' | 'warm', attemptIds: [temperature], minExecuted: 1, minJudged: 1,
        budgetSource: 'fixture-only-targets', maxP95LatencyMs: 100, maxPerAttemptCostUsd: 0.01,
        maxErrorRate: 0, maxDegradedRate: 0, quality: { minPrecisionAtK: 1, minRecallAtK: 1 } })) },
    queries: ['cold', 'warm'].map(id => ({ id, cellId: id, query: 'theory', queryField: 'query',
      args: { query: 'theory', harness: 'fixture', limit: 2, semantic: false }, k: 2, groundTruthIds: ['known-doc'] })),
  };
  study.declaration.pins.querySet = adapterQuerySetFingerprint(study.queries);
  const pins = structuredClone(study.declaration.pins);
  const hits = [{ docId: 'known-doc', docText: 'An exact delivered theory snippet, with its qualifier.', rank: 1 }];
  return { study, executionDeclaration: structuredClone(study.declaration), executionStudyFingerprint: adapterStudyFingerprint(study), startedAtMs: 20, pins,
    receipts: study.queries.map((query): AdapterInvocationReceipt => ({ id: query.id, cellId: query.cellId, adapter: 'docs:search', invocationRef: `invocation:${query.id}`,
      requestedK: query.k,
      requestFingerprint: adapterFingerprint(query as never), pins: structuredClone(pins), outcome: 'success' as const,
      executed: true, degraded: false, latencyMs: 10, hits: structuredClone(hits) })),
    labels: study.queries.map(query => ({ attemptId: query.id, invocationRef: `invocation:${query.id}`, docId: 'known-doc',
      inputFingerprint: adapterLabelInputFingerprint(query.query, hits[0]!), contract: structuredClone(judge),
      qualificationRef: 'pilot:verified-fixture', judgedAtMs: 30, relevance: 5, judgeCostUsd: 0.5, evidenceRef: `label:${query.id}` })),
    costs: study.queries.map(query => ({ attemptId: query.id, invocationRef: `invocation:${query.id}`, retrievalCostUsd: 0.001,
      contractFingerprint: adapterFingerprint(study.costContracts[query.cellId]!),
      meter: 'provider-usage' as const, evidenceRef: `usage:${query.id}` })),
    qualification: { contract: structuredClone(judge), evidenceRef: 'pilot:verified-fixture', policyRef: 'fixture:numeric-policy', completedAtMs: 5 },
  };
}

describe('frozen adapter baseline receipt bridge', () => {
  it('reuses conditional relevance/independent recall and evaluates cold/warm cells separately', () => {
    const result = evaluateAdapterBaseline(fixture());
    expect(result.assertion).toMatchObject({ status: 'pass', failures: [], unknowns: [],
      cells: [{ id: 'cold', attempted: 1, executed: 1, judged: 1 }, { id: 'warm', attempted: 1, executed: 1, judged: 1 }] });
    expect(result.run.attempts[0]!.quality).toMatchObject({ precisionAtK: 1, recallAtK: 1, grades: [3], k: 2 });
    expect(result.judgeSpendUsd).toBe(1);
    expect(result.run.attempts.map(a => a.costUsd)).toEqual([0.001, 0.001]);
  });

  it('hashes nested request values independent of object key insertion order', () => {
    expect(adapterFingerprint({ b: [1, { z: true, a: null }], a: 'x' }))
      .toBe(adapterFingerprint({ a: 'x', b: [1, { a: null, z: true }] }));
    expect(() => adapterFingerprint({ invalid: Number.NaN })).toThrow(/non-finite/);
  });

  it.each(['adapter', 'scope', 'snippet', 'model', 'runtime', 'budget'] as const)('rejects %s drift instead of relabelling it as the frozen experiment', change => {
    const input = fixture();
    if (change === 'adapter') input.receipts[0]!.adapter = 'offline-all-source';
    if (change === 'scope') input.study.queries[0]!.args.harness = 'other';
    if (change === 'snippet') input.receipts[0]!.hits[0]!.docText += ' changed after labelling';
    if (change === 'model') input.labels[0]!.contract.model = 'other';
    if (change === 'runtime') input.receipts[0]!.pins.sourceRevision = 'other';
    if (change === 'budget') input.executionDeclaration.cells[0]!.maxP95LatencyMs = 1000;
    expect(evaluateAdapterBaseline(input).assertion.status).toBe('fail');
  });

  it('does not infer retrieval cost from paid judge labels, or zero from missing usage', () => {
    const input = fixture();
    input.costs = [];
    const result = evaluateAdapterBaseline(input);
    expect(result.judgeSpendUsd).toBe(1);
    expect(result.retrievalCostMeasured).toBe(0);
    expect(result.run.attempts.map(a => a.costUsd)).toEqual([null, null]);
    expect(result.assertion.status).toBe('unknown');
  });

  it('accepts measured zero retrieval spend with a bound meter, and rejects another invocation cost', () => {
    const input = fixture();
    input.costs[0]!.retrievalCostUsd = 0;
    expect(evaluateAdapterBaseline(input).assertion.status).toBe('pass');
    input.costs[0]!.invocationRef = 'unrelated-invocation';
    expect(evaluateAdapterBaseline(input).assertion.status).toBe('fail');
  });

  it('keeps a missing/underfilled cell unknown beside a perfect measured cell', () => {
    const input = fixture();
    input.receipts.pop(); input.labels.pop(); input.costs.pop();
    const result = evaluateAdapterBaseline(input);
    expect(result.assertion.status).toBe('unknown');
    expect(result.assertion.cells[1]).toMatchObject({ id: 'warm', attempted: 1, executed: 0, judged: 0 });
    expect(result.run.attempts[1]).toMatchObject({ outcome: 'unknown', latencyMs: null, costUsd: null });
  });

  it('retains partial judge spend and independent recall unknowns instead of making missing labels zero', () => {
    const input = fixture();
    input.labels.pop();
    delete input.study.queries[0]!.groundTruthIds;
    input.study.declaration.cells[0]!.quality = { minPrecisionAtK: 1 };
    input.study.declaration.pins.querySet = adapterQuerySetFingerprint(input.study.queries);
    input.pins = structuredClone(input.study.declaration.pins);
    input.executionDeclaration = structuredClone(input.study.declaration);
    input.executionStudyFingerprint = adapterStudyFingerprint(input.study);
    for (const r of input.receipts) {
      r.pins = structuredClone(input.pins);
      r.requestFingerprint = adapterFingerprint(input.study.queries.find(q => q.id === r.id) as never);
    }
    const result = evaluateAdapterBaseline(input);
    expect(result.judgeSpendUsd).toBe(0.5);
    expect(result.run.attempts[0]!.quality!.recallAtK).toBeNull();
    expect(result.run.attempts[1]!.quality).toBeUndefined();
    expect(result.assertion.status).toBe('unknown');
  });

  it.each(['late', 'different', 'missing-reference'] as const)('keeps quality unknown for a %s pilot qualification', kind => {
    const input = fixture();
    if (kind === 'late') input.qualification.completedAtMs = 40;
    if (kind === 'different') input.qualification.contract.inputContract = 'other';
    if (kind === 'missing-reference') input.qualification.policyRef = '';
    expect(evaluateAdapterBaseline(input).assertion.status).toBe('unknown');
  });

  it('requires the pilot before the original label spend, including cached labels', () => {
    const input = fixture();
    input.labels[0]!.judgedAtMs = 1;
    expect(evaluateAdapterBaseline(input).assertion.status).toBe('unknown');
  });

  it('rejects duplicate/orphan receipts rather than improving coverage by repeated observations', () => {
    const input = fixture();
    input.receipts.push(structuredClone(input.receipts[0]!));
    input.labels.push({ ...input.labels[0]!, attemptId: 'foreign' });
    const result = evaluateAdapterBaseline(input);
    expect(result.assertion.status).toBe('fail');
    expect(result.assertion.failures.join('\n')).toMatch(/duplicate invocation/);
    expect(result.assertion.failures.join('\n')).toMatch(/undeclared label/);
  });

  it('preserves observed timeout and degraded attempts beside high precision', () => {
    const input = fixture();
    input.receipts[1]!.outcome = 'timeout';
    input.receipts[1]!.degraded = true;
    const result = evaluateAdapterBaseline(input);
    expect(result.assertion.status).toBe('fail');
    expect(result.assertion.failures.join('\n')).toMatch(/uncensored timeout/);
    expect(result.assertion.cells[1]!.attempted).toBe(1);
  });

  it('rejects observed cutoff drift and incomplete judge contracts', () => {
    const input = fixture();
    input.receipts[0]!.requestedK = 10;
    expect(evaluateAdapterBaseline(input).assertion.status).toBe('fail');
    const incomplete = fixture();
    incomplete.study.judge.model = '';
    expect(evaluateAdapterBaseline(incomplete).assertion.failures.join('\n')).toMatch(/incomplete judge contract/);
  });

  it('does not double-count duplicated paid-label receipts as known spend', () => {
    const input = fixture();
    input.labels.push(structuredClone(input.labels[0]!));
    const result = evaluateAdapterBaseline(input);
    expect(result.assertion.status).toBe('fail');
    expect(result.judgeSpendUsd).toBeNull();
  });

  it('checks independently labelled correct abstention without requiring a paid judge', () => {
    const input = fixture();
    for (const cell of input.study.declaration.cells) cell.quality = 'no-match';
    for (const query of input.study.queries) query.groundTruthIds = [];
    input.study.declaration.pins.querySet = adapterQuerySetFingerprint(input.study.queries);
    input.pins = structuredClone(input.study.declaration.pins);
    input.executionDeclaration = structuredClone(input.study.declaration);
    input.executionStudyFingerprint = adapterStudyFingerprint(input.study);
    for (const receipt of input.receipts) {
      receipt.hits = [];
      receipt.pins = structuredClone(input.pins);
      receipt.requestFingerprint = adapterFingerprint(input.study.queries.find(q => q.id === receipt.id) as never);
    }
    input.labels = [];
    expect(evaluateAdapterBaseline({ ...input, qualification: null }).assertion.status).toBe('pass');
    input.study.queries[0]!.groundTruthIds = ['needed-item'];
    input.study.declaration.pins.querySet = adapterQuerySetFingerprint(input.study.queries);
    input.pins = structuredClone(input.study.declaration.pins);
    input.executionDeclaration = structuredClone(input.study.declaration);
    input.executionStudyFingerprint = adapterStudyFingerprint(input.study);
    for (const receipt of input.receipts) {
      receipt.pins = structuredClone(input.pins);
      receipt.requestFingerprint = adapterFingerprint(input.study.queries.find(q => q.id === receipt.id) as never);
    }
    expect(evaluateAdapterBaseline({ ...input, qualification: null }).assertion.status).toBe('unknown');
  });

  it('freezes the cost quantity and pricing independently of the observed dollar amount', () => {
    const changedStudy = fixture();
    changedStudy.study.costContracts.cold!.metric = 'total-retrieval-cost';
    expect(evaluateAdapterBaseline(changedStudy).assertion.failures.join('\n')).toMatch(/frozen study changed/);
    const changedMeter = fixture();
    changedMeter.costs[0]!.contractFingerprint = 'another-cost-definition';
    expect(evaluateAdapterBaseline(changedMeter).assertion.status).toBe('fail');
  });
});

describe('retained adapter assessment entrypoint', () => {
  const directories: string[] = [];
  afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
  const paths = () => {
    const root = mkdtempSync(join(tmpdir(), 'adapter-baseline-test-'));
    directories.push(root);
    return { input: join(root, 'receipts.json'), output: join(root, 'assessment.json') };
  };

  it('pins the exact input bytes and refuses to overwrite an earlier edition or its input', () => {
    const p = paths();
    const bytes = `${JSON.stringify(fixture())}\n`;
    writeFileSync(p.input, bytes);
    expect(assessAdapterBaselineArtifact(p.input, p.output).exitCode).toBe(0);
    const saved = JSON.parse(readFileSync(p.output, 'utf8'));
    expect(saved).toMatchObject({ inputSha256: createHash('sha256').update(bytes).digest('hex'), planAcceptance: false,
      shipment: 'unverified', assertion: { status: 'pass' } });
    expect(() => assessAdapterBaselineArtifact(p.input, p.output)).toThrow(/EEXIST/);
    expect(() => assessAdapterBaselineArtifact(p.input, p.input)).toThrow(/overwrite/);
    expect(readFileSync(p.input, 'utf8')).toBe(bytes);
  });

  it('returns a distinct unknown exit while preserving the entire attempt population', () => {
    const p = paths(), input = fixture();
    input.costs = [];
    writeFileSync(p.input, JSON.stringify(input));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runAdapterBaselineCli(['--input', p.input, '--out', p.output])).toBe(2);
    const saved = JSON.parse(readFileSync(p.output, 'utf8'));
    expect(saved.run.attempts).toHaveLength(2);
    expect(saved.assertion.status).toBe('unknown');
    expect(saved.retrievalCostMeasured).toBe(0);
  });

  it('returns a failure exit for a real budget breach and rejects malformed CLI arguments', () => {
    const p = paths(), input = fixture();
    input.receipts[0]!.latencyMs = 200;
    writeFileSync(p.input, JSON.stringify(input));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runAdapterBaselineCli(['--input', p.input, '--out', p.output])).toBe(1);
    expect(() => runAdapterBaselineCli(['--input', p.input, '--typo', p.output])).toThrow(/usage/);
  });
});
