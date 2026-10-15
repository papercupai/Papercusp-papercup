import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ tokenizer: vi.fn(), model: vi.fn(), loadModel: vi.fn(), loadTokenizer: vi.fn() }));
vi.mock('@huggingface/transformers', () => ({
  AutoTokenizer: { from_pretrained: mocks.loadTokenizer },
  PreTrainedModel: { from_pretrained: mocks.loadModel },
}));
import { buildPplxBenchmarkEmbedder, loadCandidateVectors, PPLX_OUTPUT, PPLX_REVISION, benchmarkMaskedMean, referenceAssetPath, qualifyIncumbentReferences, summarizeIncumbentReferences,
  validateNativeBoundaryRequest, nativeBoundaryPopulation, nativeInferenceTraceVerified, nativeRunTraceVerified, nativeRawClockTraceVerified,
  nativeRuntimeTraceVerified, nativeObservedLibraryClosureVerified, nativeGpuCapacityObserved,
  summarizeNativeBoundaries, qualifyMdenseOnBoundaries, MDENSEON_BOUNDARY_IDS,
  type NativeBoundaryRequest, type NativeBoundaryRow, type NativeBoundaryBatchRow, type CandidateVectors } from './candidate-embedders';
import { nativeBenchmarkOutputPaths } from './candidate-embedders';
import { moduleRepoRoot } from '../../module-repo-root';
import { incumbentReferenceFixture } from './fixtures/incumbent-reference';

describe('native benchmark source and private output qualification', () => {
  function withSourceTree(run: (root: string, tree: string, moduleUrl: string) => void) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-benchmark-root-'));
    const tree = path.join(root, 'cache', 'runtime', 'tree');
    try {
      fs.mkdirSync(path.join(root, '.git'));
      for (const file of ['package.json', 'packages/operator-core/package.json',
        'packages/operator-core/lib/memory/bench/candidate-embedders.ts',
        'libs/generic/memory/src/local-embedder-worker.script.mjs']) {
        const target = path.join(tree, file); fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.endsWith('.json') ? '{}' : '// frozen source fixture');
      }
      run(root, tree, pathToFileURL(path.join(tree, 'packages/operator-core/lib/memory/bench/candidate-embedders.ts')).href);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  it('qualifies a Git-free frozen source tree under an unrelated ancestor checkout', () => {
    withSourceTree((root, tree, moduleUrl) => {
      // Distinguishing control: the old checkout-only lookup inherits home.
      expect(moduleRepoRoot(moduleUrl)).toBe(root);
      const output = path.join(root, 'private', 'new-run', 'result.json');
      expect(nativeBenchmarkOutputPaths(output, moduleUrl)).toEqual({ repo: fs.realpathSync(tree), output });
      expect(fs.existsSync(path.dirname(output))).toBe(false); // preflight has no write side effects
    });
  });
  it('rejects source-tree outputs and symlink destinations while accepting sibling prefixes', () => {
    withSourceTree((root, tree, moduleUrl) => {
      for (const output of [tree, path.join(tree, 'docs/evidence/raw.json')]) {
        expect(() => nativeBenchmarkOutputPaths(output, moduleUrl)).toThrow('private outside source tree');
      }
      const alias = path.join(root, 'private-alias'); fs.symlinkSync(tree, alias, 'dir');
      expect(() => nativeBenchmarkOutputPaths(path.join(alias, 'missing', 'raw.json'), moduleUrl)).toThrow('private outside source tree');
      const output = path.join(`${tree}-private`, 'raw.json');
      expect(nativeBenchmarkOutputPaths(output, moduleUrl).output).toBe(output);
    });
  });
  it('fails preflight when the declared source layout is incomplete', () => {
    withSourceTree((root, tree, moduleUrl) => {
      fs.unlinkSync(path.join(tree, 'libs/generic/memory/src/local-embedder-worker.script.mjs'));
      expect(() => nativeBenchmarkOutputPaths(path.join(root, 'private/raw.json'), moduleUrl)).toThrow('source layout not found');
    });
  });
});

describe('incumbent reference qualification', () => {
  it('resolves published locators locally and refuses machine-specific or escaping paths', () => {
    expect(referenceAssetPath('cache:validation/model/config.json', '/repo', '/person')).toBe('/person/.cache/papercusp/model-validation/model/config.json');
    expect(referenceAssetPath('cache:transformers/model/onnx/model.onnx', '/repo', '/person')).toBe('/repo/node_modules/@huggingface/transformers/.cache/model/onnx/model.onnx');
    for (const bad of ['/machine/private/config.json', 'cache:validation/../config.json', 'cache:unknown/config.json', 'cache:validation//config.json']) {
      expect(() => referenceAssetPath(bad, '/repo', '/person')).toThrow('invalid portable');
    }
  });
  it('uses only attended tokens for the independent mean and rejects invalid model output', () => {
    expect(benchmarkMaskedMean([2, 4, 4, 8, 999, 999], [1, 1, 0], 2)).toEqual([3, 6]);
    expect(() => benchmarkMaskedMean([1, 2], [0], 2)).toThrow('invalid');
    expect(() => benchmarkMaskedMean([NaN, 2], [1], 2)).toThrow('nonfinite');
    expect(() => benchmarkMaskedMean([1, 2, 3], [1], 2)).toThrow('invalid');
  });
  it('refuses an untrusted protocol SHA before any tokenizer/model construction', async () => {
    await expect(qualifyIncumbentReferences('/absent/reference.json', 'invalid', '/private/result.json')).rejects.toThrow('SHA mismatch');
    expect(mocks.loadTokenizer).not.toHaveBeenCalled(); expect(mocks.loadModel).not.toHaveBeenCalled();
  });
  it('keeps three recipes, computes all token/vector/rank comparisons and reports a zero measured tokenizer effect', () => {
    const { native, python } = incumbentReferenceFixture();
    const summary = summarizeIncumbentReferences(native, python);
    expect(summary.arms.map((a) => [a.caseCount, a.tokenMatches, a.passed, a.rankings.exactRankAgreements])).toEqual([[16, 16, true, 8], [16, 16, true, 8], [16, 16, true, 8]]);
    expect(summary.correctedGemmaEffect).toMatchObject({ population: 16, changedTokenCases: [], rankingQueriesChanged: [], minimumCosine: 1 });
    expect(mocks.loadTokenizer).not.toHaveBeenCalled(); expect(mocks.loadModel).not.toHaveBeenCalled();
  });
  it('refuses the exact falsifier: corrected and shipped arms under one recipe identity', () => {
    const { native, python } = incumbentReferenceFixture();
    native.arms[1].profileId = native.arms[0].profileId;
    expect(() => summarizeIncumbentReferences(native, python)).toThrow('identity collision');
  });
  it('reports a tokenizer/vector/ranking loss using actual arrays without accepting producer PASS metadata', () => {
    const { native, python } = incumbentReferenceFixture();
    native.arms[0].cases[0].inputIds = [99]; native.arms[0].cases[0].attentionMask = [1];
    native.arms[0].cases[0].vector = [...native.arms[0].cases[2].vector];
    const summary = summarizeIncumbentReferences(native, python);
    expect(summary.arms[0]).toMatchObject({ tokenMatches: 15, passed: false, minimumCosine: 0 });
    expect(summary.arms[0].rankings.exactRankAgreements).toBe(7);
    expect(summary.correctedGemmaEffect.changedTokenCases).toEqual(['query-plain']);
    expect(summary.correctedGemmaEffect.rankingQueriesChanged).toEqual(['query-plain']);
  });
  it.each(['missing-case', 'wrong-prompt', 'wrong-model', 'nonfinite', 'no-worker', 'unversioned', 'unpinned'])('refuses %s evidence', (failure) => {
    const { native, python } = incumbentReferenceFixture();
    if (failure === 'missing-case') python.arms[0].cases.pop();
    if (failure === 'wrong-prompt') native.arms[0].cases[0].promptedText = native.arms[0].cases[1].promptedText;
    if (failure === 'wrong-model') native.arms[0].model = 'harrier';
    if (failure === 'nonfinite') native.arms[0].cases[0].vector[0] = NaN;
    if (failure === 'no-worker') delete native.arms[0].cases[0].shippedVector;
    if (failure === 'unversioned') delete python.versions.tokenizers;
    if (failure === 'unpinned') native.identities[0].files[0].sha256 = 'wrong';
    expect(() => summarizeIncumbentReferences(native, python)).toThrow();
  });
});

afterEach(() => vi.resetAllMocks());

describe('native mDenseOn boundary evidence', () => {
  function fixture() {
    const request: NativeBoundaryRequest = { formatVersion: 1, model: 'lightonai/mDenseOn', revision: 'a5fdb000f7a21da96c3bddde3a782ef777316df3',
      export: '/private/export', snapshot: '/private/snapshot', execution: { dtype: 'fp32', intraOpThreads: 4, interOpThreads: 1, maxLength: 8192 },
      thresholds: { minimumCosine: 0.99999, maximumAbsoluteError: 3e-5, ranking: 'exact' },
      assets: [{ path: '/private/export/onnx/model.onnx', bytes: 1, sha256: 'a'.repeat(64) }],
      cases: MDENSEON_BOUNDARY_IDS.map((id, i) => ({ id, kind: i % 2 ? 'document' : 'query', text: id,
        untruncatedTokens: i === 6 ? 8192 : i === 7 ? 8256 : 6 + i })),
      batches: [{ id: 'padded', caseIds: ['short-query', 'unicode', 'code', 'whitespace', 'empty'] },
        { id: 'mixed-length', caseIds: ['short-query', 'full-8192'] }] };
    const rows: NativeBoundaryRow[] = request.cases.map((c, i) => {
      const vector = Array.from({ length: 768 }, (_, d) => Number(d === Math.min(i, 6)));
      const tokens = Array(Math.min(8192, c.untruncatedTokens)).fill(i);
      return { id: c.id, inputIds: tokens, referenceInputIds: [...tokens], vector, referenceVector: [...vector],
        execution: { device: 'cpu', verified: true }, worker: { alive: true, disabled: false } };
    });
    return { request, rows };
  }
  it('keeps the 8192/over-limit population and stable near-tie ranking gates', () => {
    const { request, rows } = fixture();
    const result = summarizeNativeBoundaries(request, rows, 'cpu');
    expect(result.singlePopulationCompatible).toBe(true);
    expect(result.comparisons.slice(-2).map((c) => c.tokenLength)).toEqual([8192, 8192]);
    expect(result.actualRankings[6].slice(0, 2)).toEqual([6, 7]);
    // Near ties can reorder while all vectors meet the fixed cosine/error gates.
    rows[6].vector = [...rows[6].vector]; rows[6].vector[0] = 0.00001;
    rows[7].vector = [...rows[7].vector]; rows[7].vector[0] = -0.00001;
    const changed = summarizeNativeBoundaries(request, rows, 'cpu');
    expect(changed.passedFixedVectorGates).toBe(true);
    expect(changed.rankingsEqual).toBe(false);
    expect(changed.singlePopulationCompatible).toBe(false);
  });
  it('records actual token and numerical losses without trusting PASS metadata', () => {
    const { request, rows } = fixture();
    rows[0].inputIds[0]++;
    rows[1].vector = [...rows[2].vector];
    const result = summarizeNativeBoundaries(request, rows, 'cpu');
    expect(result).toMatchObject({ tokenIdsEqual: false, passedFixedVectorGates: false, singlePopulationCompatible: false });
    expect(result.comparisons[0].tokenIdsEqual).toBe(false);
    expect(result.comparisons[1].maximumAbsoluteError).toBe(1);
  });
  it('keeps single-cell diagnostics distinct from complete compatibility and uses the selected reference index', () => {
    const { request, rows } = fixture();
    const selection = nativeBoundaryPopulation(request, 'single-over-limit');
    expect(selection.cases.map((c) => c.id)).toEqual(['over-limit']);
    expect(selection.notChecked).toHaveLength(9);
    expect(selection.notChecked).toContain('single-full-8192');
    const result = summarizeNativeBoundaries(request, [rows[7]], 'cpu', 'single-over-limit');
    expect(result).toMatchObject({ diagnosticOnly: true, diagnosticCompatible: true, singlePopulationCompatible: false, rankingsEqual: null });
    expect(result.comparisons[0].tokenLength).toBe(8192);
    expect(() => summarizeNativeBoundaries(request, [rows[7]], 'cpu')).toThrow('incomplete');
    expect(() => summarizeNativeBoundaries(request, [rows[0]], 'cpu', 'single-over-limit')).toThrow('incomplete');
    expect(() => nativeBoundaryPopulation(request, 'unknown')).toThrow('one declared');
    rows[7].vector = [...rows[1].vector];
    expect(summarizeNativeBoundaries(request, [rows[7]], 'cpu', 'single-over-limit').diagnosticCompatible).toBe(false);
  });
  it.each(['padded', 'mixed-length'])('selects %s with only its declared single-input prerequisites', (id) => {
    const { request, rows } = fixture();
    const selection = nativeBoundaryPopulation(request, id), batch = request.batches.find((b) => b.id === id)!;
    expect(selection.cases.map((c) => c.id)).toEqual(request.cases.filter((c) => batch.caseIds.includes(c.id)).map((c) => c.id));
    expect(selection.batches).toEqual([batch]);
    expect(selection.notChecked).toEqual([...request.cases.map((c) => `single-${c.id}`), 'padded', 'mixed-length']
      .filter((cell) => cell !== id && !batch.caseIds.some((caseId) => cell === `single-${caseId}`)));
    const selectedRows = rows.filter((r) => batch.caseIds.includes(r.id));
    const evidence: NativeBoundaryBatchRow = { id, submittedCaseIds: batch.caseIds, actualInferenceBatchSize: 1,
      vectors: batch.caseIds.map((caseId) => rows.find((r) => r.id === caseId)!.vector),
      execution: { device: 'cpu', verified: true }, worker: { alive: true, disabled: false } };
    const summary = summarizeNativeBoundaries(request, selectedRows, 'cpu', id, [evidence]);
    expect(summary).toMatchObject({ diagnosticOnly: true, diagnosticCompatible: true, batchPopulationCompatible: true,
      singlePopulationCompatible: false, rankingsEqual: null, notCheckedCells: selection.notChecked });
    expect(() => summarizeNativeBoundaries(request, selectedRows, 'cpu', id)).toThrow('incomplete request-group');
    evidence.vectors = evidence.vectors.map((v, i) => i ? v : rows[1].vector);
    expect(summarizeNativeBoundaries(request, selectedRows, 'cpu', id, [evidence])).toMatchObject({
      diagnosticCompatible: false, batchPopulationCompatible: false });
  });
  it.each(['order', 'tensor-batch', 'fallback', 'unverified', 'disabled', 'missing-vector', 'nonfinite'])('refuses %s request-group evidence', (failure) => {
    const { request, rows } = fixture(), batch = request.batches[0];
    const selectedRows = rows.filter((r) => batch.caseIds.includes(r.id));
    const evidence: NativeBoundaryBatchRow = { id: batch.id, submittedCaseIds: [...batch.caseIds], actualInferenceBatchSize: 1,
      vectors: batch.caseIds.map((id) => [...rows.find((r) => r.id === id)!.vector]),
      execution: { device: 'cpu', verified: true }, worker: { alive: true, disabled: false } };
    if (failure === 'order') evidence.submittedCaseIds.reverse();
    if (failure === 'tensor-batch') evidence.actualInferenceBatchSize = 5;
    if (failure === 'fallback') evidence.execution.device = 'cuda';
    if (failure === 'unverified') evidence.execution.verified = false;
    if (failure === 'disabled') evidence.worker.disabled = true;
    if (failure === 'missing-vector') evidence.vectors.pop();
    if (failure === 'nonfinite') evidence.vectors[0][0] = NaN;
    expect(() => summarizeNativeBoundaries(request, selectedRows, 'cpu', batch.id, [evidence])).toThrow();
  });
  it('keeps unmeasured request groups in coverage when only the full single population is supplied', () => {
    const { request, rows } = fixture();
    expect(summarizeNativeBoundaries(request, rows, 'cpu')).toMatchObject({
      singlePopulationCompatible: true, batchPopulationCompatible: false, notCheckedCells: ['padded', 'mixed-length'] });
  });
  it('distinguishes actual worker input evidence from independent tokenizer predictions', () => {
    const { request, rows } = fixture();
    expect(summarizeNativeBoundaries(request, rows, 'cpu')).toMatchObject({ workerInputTraceVerified: false });
    const row = rows[0];
    row.inputTraces = [{ model: request.export, device: 'cpu', observedAt: '2026-10-02T00:00:00Z',
      inputShape: [1, row.inputIds.length], inputIds: [...row.inputIds], attentionMask: row.inputIds.map(() => 1) }];
    expect(summarizeNativeBoundaries(request, [row], 'cpu', 'single-short-query')).toMatchObject({
      workerInputTraceVerified: true, diagnosticCompatible: true });
    row.inputTraces[0].inputIds[0]++;
    expect(summarizeNativeBoundaries(request, [row], 'cpu', 'single-short-query')).toMatchObject({
      passedFixedVectorGates: true, tokenIdsEqual: true, workerInputTraceVerified: false, diagnosticCompatible: false });
  });
  it.each(['valid', 'legacy', 'other-request', 'other-thread', 'other-device', 'missing-end', 'failed', 'clock', 'reverse'])
    ('keeps %s graph intervals distinct from process-only kernel evidence', (failure) => {
      const { request, rows } = fixture(), row = rows[0];
      const identity = { requestId: 0, attempt: 1, processId: 123, workerThreadId: 1, nativeThreadId: 456 };
      const input = { model: request.export, device: 'cpu' as const, observedAt: '2026-10-02T00:00:00Z',
        inputShape: [1, row.inputIds.length], inputIds: row.inputIds, attentionMask: row.inputIds.map(() => 1), request: identity };
      const start = { ...identity, model: request.export, device: 'cpu' as const, observedAt: input.observedAt,
        clock: 'node-hrtime' as const, monotonicNs: '100', phase: 'start' as const };
      const end = { ...start, monotonicNs: '200', phase: 'end' as const, outcome: 'success' as const };
      const events: any[] = [start, end];
      if (failure === 'legacy') delete (input as any).request;
      if (failure === 'other-request') end.requestId++;
      if (failure === 'other-thread') end.nativeThreadId++;
      if (failure === 'other-device') (end as any).device = 'cuda';
      if (failure === 'missing-end') events.pop();
      if (failure === 'failed') (end as any).outcome = 'error';
      if (failure === 'clock') end.monotonicNs = 'unknown';
      if (failure === 'reverse') end.monotonicNs = '99';
      expect(nativeInferenceTraceVerified([input], events, request.export, row.referenceInputIds, 'cpu')).toBe(failure === 'valid');
      row.inputTraces = [input]; row.inferenceTraces = events;
      expect(summarizeNativeBoundaries(request, [row], 'cpu', 'single-short-query')).toMatchObject({
        workerInferenceTraceVerified: failure === 'valid', diagnosticCompatible: failure === 'valid',
      });
    });
  it.each(['valid', 'missing', 'request', 'tag', 'index', 'outside', 'overlap', 'failed'])
    ('checks %s synchronous native calls against the retained request graph', (failure) => {
      const { request, rows } = fixture(), row = rows[0];
      const identity = { requestId: 0, attempt: 1, processId: 123, workerThreadId: 1, nativeThreadId: 456 };
      const input = { model: request.export, device: 'cpu' as const, observedAt: '2026-10-02T00:00:00Z',
        inputShape: [1, row.inputIds.length], inputIds: row.inputIds, attentionMask: row.inputIds.map(() => 1), request: identity };
      const base = { ...identity, model: request.export, device: 'cpu' as const, observedAt: input.observedAt, clock: 'node-hrtime' as const };
      const graph = [{ ...base, monotonicNs: '100', phase: 'start' as const },
        { ...base, monotonicNs: '500', phase: 'end' as const, outcome: 'success' as const }];
      const native: any[] = [
        { ...base, runIndex: 1, runTag: 'pc-embed:123:1:0:1:1', monotonicNs: '200', phase: 'start' },
        { ...base, runIndex: 1, runTag: 'pc-embed:123:1:0:1:1', monotonicNs: '300', phase: 'end', outcome: 'success' },
        { ...base, runIndex: 2, runTag: 'pc-embed:123:1:0:1:2', monotonicNs: '350', phase: 'start' },
        { ...base, runIndex: 2, runTag: 'pc-embed:123:1:0:1:2', monotonicNs: '450', phase: 'end', outcome: 'success' },
      ];
      if (failure === 'missing') native.pop();
      if (failure === 'request') native[1].requestId++;
      if (failure === 'tag') native[1].runTag = 'another-request';
      if (failure === 'index') native[2].runIndex++;
      if (failure === 'outside') native[0].monotonicNs = '99';
      if (failure === 'overlap') native[2].monotonicNs = '299';
      if (failure === 'failed') native[1].outcome = 'error';
      expect(nativeRunTraceVerified([input], graph, native, request.export, row.referenceInputIds, 'cpu')).toBe(failure === 'valid');
      row.inputTraces = [input]; row.inferenceTraces = graph; row.nativeInferenceTraces = native;
      expect(summarizeNativeBoundaries(request, [row], 'cpu', 'single-short-query')).toMatchObject({
        nativeRunTraceVerified: failure === 'valid', diagnosticCompatible: failure === 'valid',
      });
    });
  it.each(['valid', 'missing', 'wrong-clock', 'invalid', 'outside', 'reverse', 'changed-executable', 'probe-error', 'phase', 'version'])
    ('checks %s RAW clock anchors without assuming a Node-to-profiler offset', (failure) => {
      const executable = { path: '/usr/bin/python3', bytes: 123, sha256: 'a'.repeat(64) };
      const events: any[] = [
        { phase: 'start', monotonicNs: '100', rawClock: { clock: 'linux-clock-monotonic-raw', rawNs: '40',
          nodeBeforeNs: '10', monotonicBeforeNs: '50', monotonicAfterNs: '60', nodeAfterNs: '90', executable, pythonVersion: '3.12' } },
        { phase: 'end', monotonicNs: '200', rawClock: { clock: 'linux-clock-monotonic-raw', rawNs: '240',
          nodeBeforeNs: '210', monotonicBeforeNs: '250', monotonicAfterNs: '260', nodeAfterNs: '290', executable, pythonVersion: '3.12' } },
      ];
      if (failure === 'missing') delete events[0].rawClock;
      if (failure === 'wrong-clock') events[0].rawClock.clock = 'UTC';
      if (failure === 'invalid') events[0].rawClock.rawNs = 'unknown';
      if (failure === 'outside') events[1].rawClock.nodeBeforeNs = '199';
      if (failure === 'reverse') events[1].rawClock.rawNs = '39';
      if (failure === 'changed-executable') events[1].rawClock.executable = { ...executable, sha256: 'b'.repeat(64) };
      if (failure === 'probe-error') events[1].clockProbeError = 'clock sampler failed';
      if (failure === 'phase') events[1].phase = 'start';
      if (failure === 'version') events[0].rawClock.pythonVersion = 123;
      expect(nativeRawClockTraceVerified(events)).toBe(failure === 'valid');
    });
  it.each(['valid','missing','hash','duplicate','before-after','outside','late-library','changed-library','unknown-capacity','wrong-gpu','probe-error'])
    ('scopes native library/capacity observations and rejects %s evidence', (failure) => {
      const library = { path: '/runtime/onnxruntime.so', bytes: 123, sha256: 'a'.repeat(64), mappedDevice: '08:01', mappedInode: '123' };
      const memory = (beforeNs: string, afterNs: string) => ({ status: 'measured', scope: 'all-nvidia-smi-devices', beforeNs, afterNs,
        executable: { path: '/usr/bin/nvidia-smi', bytes: 42, sha256: 'b'.repeat(64) }, cudaVisibleDevices: null,
        devices: [{ uuid: 'GPU-test', pciBusId: '00000000:01:00.0', totalMiB: 100, usedMiB: 20, freeMiB: 70 }] });
      const events: any[] = [
        { phase: 'start', monotonicNs: '100', device: 'cuda', runtime: { platform: 'linux', clock: 'node-hrtime',
          beforeNs: '10', afterNs: '90', libraries: [library], gpuMemory: memory('30','40') } },
        { phase: 'end', monotonicNs: '200', device: 'cuda', runtime: { platform: 'linux', clock: 'node-hrtime',
          beforeNs: '210', afterNs: '290', libraries: [{ ...library }], gpuMemory: memory('230','240') } },
      ];
      if (failure === 'missing') delete events[0].runtime;
      if (failure === 'hash') events[1].runtime.libraries[0].sha256 = 'not-a-hash';
      if (failure === 'duplicate') events[1].runtime.libraries.push({ ...library });
      if (failure === 'before-after') events[0].runtime.beforeNs = '99';
      if (failure === 'outside') events[1].runtime.beforeNs = '199';
      if (failure === 'late-library') events[1].runtime.libraries.push({ ...library, path: '/runtime/cudnn.so', mappedInode: '456' });
      if (failure === 'changed-library') events[1].runtime.libraries[0].sha256 = 'c'.repeat(64);
      if (failure === 'unknown-capacity') events[0].runtime.gpuMemory = { status: 'unknown', beforeNs: '30', afterNs: '40', error: 'query failed' };
      if (failure === 'wrong-gpu') events[0].runtime.gpuMemory.devices[0].freeMiB = 101;
      if (failure === 'probe-error') events[1].runtimeProbeError = 'mapping failed';
      const valid = ['valid','late-library','changed-library','unknown-capacity'].includes(failure);
      expect(nativeRuntimeTraceVerified(events)).toBe(valid);
      expect(nativeObservedLibraryClosureVerified(events)).toBe(['valid','unknown-capacity'].includes(failure));
      expect(nativeGpuCapacityObserved(events)).toBe(['valid','late-library','changed-library'].includes(failure));
    });
  it('qualifies CPU maps without claiming GPU capacity or depending on JSON key order', () => {
    const library = { path: '/runtime/ort.node', bytes: 123, sha256: 'a'.repeat(64), mappedDevice: '08:01', mappedInode: '123' };
    const events: any[] = [
      { phase: 'start', monotonicNs: '100', device: 'cpu', runtime: { platform: 'linux', clock: 'node-hrtime',
        beforeNs: '10', afterNs: '90', libraries: [library], gpuMemory: { status: 'not-applicable' } } },
      { phase: 'end', monotonicNs: '200', device: 'cpu', runtime: { platform: 'linux', clock: 'node-hrtime',
        beforeNs: '210', afterNs: '290', libraries: [Object.fromEntries(Object.entries(library).reverse())], gpuMemory: { status: 'not-applicable' } } },
    ];
    expect(nativeRuntimeTraceVerified(events)).toBe(true);
    expect(nativeObservedLibraryClosureVerified(events)).toBe(true);
    expect(nativeGpuCapacityObserved(events)).toBe(false);
  });
  it.each(['partial', 'fallback', 'unverified', 'disabled', 'nonfinite', 'truncation'])('refuses %s evidence', (failure) => {
    const { request, rows } = fixture();
    if (failure === 'partial') rows.pop();
    if (failure === 'fallback') rows[0].execution.device = 'cuda';
    if (failure === 'unverified') rows[0].execution.verified = false;
    if (failure === 'disabled') rows[0].worker.disabled = true;
    if (failure === 'nonfinite') rows[0].vector[0] = NaN;
    if (failure === 'truncation') rows[7].inputIds.push(2);
    expect(() => summarizeNativeBoundaries(request, rows, 'cpu')).toThrow();
  });
  it.each(['maxLength', 'relaxedCosine', 'relaxedError', 'batch', 'fullLength'])('rejects %s contract drift', (failure) => {
    const { request } = fixture();
    if (failure === 'maxLength') request.execution.maxLength = 512;
    if (failure === 'relaxedCosine') request.thresholds.minimumCosine = 0.99;
    if (failure === 'relaxedError') request.thresholds.maximumAbsoluteError = 0.001;
    if (failure === 'batch') request.batches.pop();
    if (failure === 'fullLength') request.cases[6].untruncatedTokens = 512;
    expect(() => validateNativeBoundaryRequest(request)).toThrow();
  });
  it('rejects an unpinned request before opening references or model weights', async () => {
    await expect(qualifyMdenseOnBoundaries('/absent.json', 'invalid', '/absent', 'invalid', '/private/out.json')).rejects.toThrow('SHA mismatch');
    expect(mocks.loadModel).not.toHaveBeenCalled(); expect(mocks.loadTokenizer).not.toHaveBeenCalled();
  });
});

describe('Perplexity publisher ONNX contract', () => {
  it('selects pooled int8 output, sends raw texts, pins weights, and reuses the loaded graph', async () => {
    mocks.tokenizer.mockReturnValue({ input_ids: 'tokens', attention_mask: 'mask' });
    mocks.loadTokenizer.mockResolvedValue(mocks.tokenizer);
    mocks.loadModel.mockResolvedValue(mocks.model);
    mocks.model.mockResolvedValue({ last_hidden_state: { data: new Float32Array(4096) }, [PPLX_OUTPUT]: { data: new Int8Array(1024).fill(7) } });
    const embed = buildPplxBenchmarkEmbedder();
    expect(await embed('stored document')).toEqual(new Array(1024).fill(7));
    await embed('search question');
    expect(mocks.tokenizer.mock.calls.map((x) => x[0])).toEqual(['stored document', 'search question']);
    expect(mocks.loadModel).toHaveBeenCalledOnce();
    expect(mocks.loadModel.mock.calls[0][1]).toMatchObject({ revision: PPLX_REVISION, device: 'cpu', dtype: 'fp32' });
  });

  it.each(['missing', 'token-level', 'zero'])('refuses a %s retrieval output rather than scoring a false loss', async (kind) => {
    mocks.tokenizer.mockReturnValue({});
    mocks.loadTokenizer.mockResolvedValue(mocks.tokenizer);
    mocks.loadModel.mockResolvedValue(mocks.model);
    mocks.model.mockResolvedValue(kind === 'missing' ? { last_hidden_state: { data: new Float32Array(1024) } } : {
      [PPLX_OUTPUT]: { data: new Int8Array(kind === 'token-level' ? 2048 : 1024) },
    });
    await expect(buildPplxBenchmarkEmbedder()('text')).rejects.toThrow(/missing|finite, nonzero/);
  });
});

describe('external inference evidence', () => {
  it('binds results to fixture bytes/order, rejects partial or invalid vectors, and preserves inference timings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-vectors-test-'));
    try {
      const corpus = path.join(dir, 'corpus.json');
      const gold = path.join(dir, 'gold.json');
      const vectors = path.join(dir, 'vectors.json');
      fs.writeFileSync(corpus, '{"frozen":"corpus"}');
      fs.writeFileSync(gold, '{"frozen":"gold"}');
      const hash = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      const manifest: CandidateVectors = { name: 'candidate', model: 'test/model', revision: 'pinned', runtime: 'python', dimensions: 2, loadSeconds: 1, assetBytes: 100,
        suites: { memory: { corpusSha256: hash(corpus), goldSha256: hash(gold), keys: ['a'], queryIds: ['q'], docVectors: [[1, 0]], queryVectors: [[0, 1]], docSeconds: 3, querySeconds: 4, peakRssMB: 50 } } };
      const save = () => fs.writeFileSync(vectors, JSON.stringify(manifest));
      const read = () => loadCandidateVectors(vectors, 'memory', corpus, gold, ['a'], ['q']);
      save();
      expect(read().suite.docSeconds).toBe(3);
      expect(() => loadCandidateVectors(vectors, 'prose', corpus, gold, ['a'], ['q'])).toThrow('completed prose');
      const suite = manifest.suites.memory!;
      suite.keys = ['wrong']; save(); expect(read).toThrow('order mismatch');
      suite.keys = ['a']; suite.docVectors = []; save(); expect(read).toThrow('incomplete');
      suite.docVectors = [[1, 0, 0]]; save(); expect(read).toThrow('2-dimensional');
      suite.docVectors = [[0, 0]]; save(); expect(read).toThrow('nonzero');
      suite.docVectors = [[1, 0]]; suite.docSeconds = 0; save(); expect(read).toThrow('timing');
      suite.docSeconds = 3; suite.corpusSha256 = 'changed'; save(); expect(read).toThrow('fingerprint');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
