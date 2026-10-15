import { describe, expect, it } from 'vitest';
import { candidateProfile, canonicalCandidateBackend, calibratedFloor, validateHeldout,
  selectCandidateSources, candidateSourcePartition, candidateMemoryEntry, accountIndependentSources, type HeldoutQuery, type Snapshot } from './candidate-hybrid-bench';
import { validateEmbedderProfile, validateMemoryStorageCompatibility, MEMORY_VECTOR_STORAGE_PROFILES,
  mdenseOnPrompt, embedRequestedExecution } from '@papercusp/memory';
import { ORT_SESSION_OPTIONS } from '../../../../../libs/generic/memory/src/local-embedder-worker';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { measurementManifestFixture, independentCohortFixture } from './fixtures/measurement-manifest';
import * as currentMeasurement from './measurement-manifest';
// Load the copy-out subject explicitly: Vite otherwise realpaths mirror test
// symlinks into the shared tree and silently exercises the original guard.
const { validateMeasurementManifest, validateIndependentCohort, validateMeasurementCoverage,
  assertMeasuredEmbedResponse, assertMeasuredExecution, assertMeasurementArm, assertCandidateArm,
  fingerprintFile, measurementPackageVersion, hashJson }: typeof currentMeasurement = process.env.PAPERCUSP_MUTATION_PROBE_SOURCE
    ? await import(pathToFileURL(process.env.PAPERCUSP_MUTATION_PROBE_SOURCE).href)
    : currentMeasurement;
import type { CellOutcome } from './measurement-manifest';

const entries = [{ key: 'a', text: 'frozen a', kind: 'fact' }, { key: 'b', text: 'frozen b', kind: 'fact' }];
const queries: HeldoutQuery[] = [
  { id: 'c', class: 'lexical-gap', query: 'question a', expected: ['a'], partition: 'calibration', group: 'a' },
  { id: 't', class: 'exact-identifier', query: 'question b', expected: ['b'], partition: 'test', group: 'b' },
];
describe('independent accessible-source accounting', () => {
  const fixture = () => {
    const seed = 'source-accounting', snapshotAt = '2026-10-02T00:00:00Z';
    const memory = Array.from({ length: 12 }, (_, i) => candidateMemoryEntry({ id: String(i), text: `frozen ${i}`,
      source_session: i === 11 ? null : `origin-${Math.floor(i / 2)}` }));
    const prose = memory.map((e, i) => ({ key: `doc-${i}`, text: `prose ${i}`, kind: 'doc', metadata: { cluster: `page-${Math.floor(i / 2)}` } }));
    const population: Snapshot['suites'] = { memory: { entries: memory }, prose: { entries: prose } };
    const suites = selectCandidateSources(population, { seed, memoryLimit: 8, proseBudget: 8, maxClusterRows: 2, requireMemorySource: true });
    const snapshot = { formatVersion: 1 as const, snapshotAt, seed, suites };
    const selectedKeys = { memory: suites.memory.entries.map((e) => e.key), prose: suites.prose.entries.map((e) => e.key) };
    const authored = Object.fromEntries((['memory', 'prose'] as const).map((corpus) => {
      const group = String(suites[corpus].entries[0].metadata!.cluster);
      const positive = suites[corpus].entries.find((e) => e.metadata!.cluster === group)!.key;
      return [corpus, ['exact-identifier', 'lexical-gap', 'session-start-intent', 'hard-negative'].map((cls) => ({
        id: `${corpus}-${cls}`, class: cls, query: `frozen ${cls}`, group, partition: candidateSourcePartition(group, seed),
        expected: cls === 'hard-negative' ? [] : [positive] }))];
    })) as Record<'memory' | 'prose', HeldoutQuery[]>;
    return { census: { snapshotAt, seed, population, selectedKeys }, snapshot, authored,
      accepted: { memory: structuredClone(authored.memory), prose: [] as HeldoutQuery[] } };
  };
  it('distinguishes census, snapshot, authored and accepted populations without counting unknown memory provenance', () => {
    const f = fixture(), report = accountIndependentSources(f.census, f.snapshot, f.authored, f.accepted);
    expect(report.memory).toMatchObject({ populationRows: 12, eligibleRows: 11, provenanceExcludedRows: 1, snapshotRows: 8,
      allEligibleRowsInSnapshot: false, allEligibleSourcesAuthored: false });
    expect(report.prose.dispositions.filter((r) => r.status === 'authored-without-accepted-labels')).toHaveLength(1);
    expect(report.memory.dispositions.filter((r) => r.status === 'accepted')).toHaveLength(1);
    for (const corpus of ['memory', 'prose'] as const) {
      for (const p of Object.values(report[corpus].partitions)) {
        expect(p.accessibleSources).toBe(p.outsideSnapshot + p.unattemptedInSnapshot + p.authoredWithoutAcceptedLabels + p.acceptedSources);
        expect(p.authoredSources).toBe(p.authoredWithoutAcceptedLabels + p.acceptedSources);
      }
    }
    const reordered = structuredClone(f); reordered.census.population.memory.entries.reverse(); reordered.authored.memory.reverse();
    expect(accountIndependentSources(reordered.census, reordered.snapshot, reordered.authored, reordered.accepted)).toEqual(report);
  });
  it('cannot call a fully authored sample an exhausted accessible population', () => {
    const f = fixture();
    f.census.population = structuredClone(f.snapshot.suites);
    const all = Object.fromEntries((['memory', 'prose'] as const).map((corpus) => [corpus,
      [...new Set(f.snapshot.suites[corpus].entries.map((e) => String(e.metadata!.cluster)))].flatMap((group) => f.authored[corpus].map((q) => ({
        ...q, id: `${group}-${q.id}`, group, partition: candidateSourcePartition(group, f.snapshot.seed),
        expected: q.class === 'hard-negative' ? [] : [f.snapshot.suites[corpus].entries.find((e) => e.metadata!.cluster === group)!.key] })))
    ])) as typeof f.authored;
    const full = accountIndependentSources(f.census, f.snapshot, all, all);
    expect(full.memory.allEligibleRowsInSnapshot).toBe(true); expect(full.memory.allEligibleSourcesAuthored).toBe(true);
    f.census.population.memory.entries = [...f.census.population.memory.entries, candidateMemoryEntry({ id: 'outside', text: 'outside', source_session: 'outside-source' })];
    expect(accountIndependentSources(f.census, f.snapshot, all, all).memory.allEligibleSourcesAuthored).toBe(false);
  });
  it.each(['seed', 'selected', 'text', 'source', 'partition', 'bundle', 'duplicate', 'foreign', 'label'] as const)('refuses a %s census/cohort mismatch', (fault) => {
    const f = structuredClone(fixture());
    if (fault === 'seed') f.census.seed = 'foreign';
    if (fault === 'selected') f.census.selectedKeys.memory.pop();
    if (fault === 'text') f.snapshot.suites.memory.entries[0].text = 'changed';
    if (fault === 'source') f.census.population.memory.entries[0].metadata!.sourceSession = 'foreign';
    if (fault === 'partition') f.authored.memory[0].partition = f.authored.memory[0].partition === 'test' ? 'calibration' : 'test';
    if (fault === 'bundle') f.authored.memory.pop();
    if (fault === 'duplicate') f.authored.memory.push(f.authored.memory[0]);
    if (fault === 'foreign') f.authored.memory[0].group = 'foreign';
    if (fault === 'label') f.accepted.memory[0].query = 'different accepted query';
    expect(() => accountIndependentSources(f.census, f.snapshot, f.authored, f.accepted)).toThrow('source census');
  });
});
describe('candidate hybrid fairness guards', () => {
  it('keeps distinct facts from one recorded session together and excludes unknown provenance for blind labels', () => {
    const facts = Array.from({ length: 64 }, (_, i) => candidateMemoryEntry({ id: String(i), text: `fact ${i}`,
      source_session: i < 32 ? 'same-session' : i < 63 ? `session-${i}` : null }));
    const selected = selectCandidateSources({ memory: { entries: facts }, prose: { entries: [] } },
      { seed: 'independent-source', memoryLimit: 64, requireMemorySource: true });
    expect(selected.memory.entries).toHaveLength(63);
    const siblings = selected.memory.entries.filter((e) => e.metadata!.sourceSession === 'same-session');
    expect(siblings).toHaveLength(32);
    expect(new Set(siblings.map((e) => e.metadata!.partition)).size).toBe(1);
    expect(selected.memory.entries.every((e) => e.metadata!.sourceAttribution === 'session')).toBe(true);
    expect(candidateMemoryEntry({ id: 'legacy', text: 'legacy fact' }).metadata).toMatchObject({ sourceAttribution: 'unknown' });
  });
  it('freezes larger samples with real-source partitions that survive reordering and expansion', () => {
    const rows = Array.from({ length: 96 }, (_, i) => ({ key: `key-${i}`, text: `source ${i}`, kind: 'doc',
      metadata: { cluster: `page-${Math.floor(i / 4)}` } }));
    const population = { memory: { entries: rows }, prose: { entries: rows } };
    const options = { seed: 'frozen-population', memoryLimit: 64, proseBudget: 64, maxClusterRows: 4 };
    const selected = selectCandidateSources(population, options);
    expect(selected.memory.entries).toHaveLength(64);
    expect(selected.prose.entries.length).toBeGreaterThanOrEqual(60);
    expect(selected).toEqual(selectCandidateSources({ memory: { entries: [...rows].reverse() }, prose: { entries: [...rows].reverse() } }, options));
    const expanded = selectCandidateSources(population, { ...options, memoryLimit: 96, proseBudget: 96 });
    const expandedPartitions = new Map(expanded.prose.entries.map((e) => [e.key, e.metadata!.partition]));
    for (const entry of selected.prose.entries) {
      expect(entry.metadata!.partition).toBe(expandedPartitions.get(entry.key));
      expect(entry.metadata!.partition).toBe(candidateSourcePartition(String(entry.metadata!.cluster), options.seed));
      expect(entry.metadata!.textSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
  it('refuses malformed budgets or unidentifiable source targets before snapshot acquisition', () => {
    const population = { memory: { entries: [{ ...entries[0], metadata: { cluster: 'a' } }] }, prose: { entries: [] } };
    for (const memoryLimit of [0, -1, NaN, 1.5, Infinity]) expect(() => selectCandidateSources(population, { memoryLimit })).toThrow('budgets');
    expect(() => selectCandidateSources({ ...population, memory: { entries } })).toThrow('cluster');
    expect(() => selectCandidateSources({ ...population, memory: { entries: [...population.memory.entries, ...population.memory.entries] } })).toThrow('duplicate');
  });
  it('routes precomputed and lexical retrieval to the actual store seam without requiring an extraction client', async () => {
    const backend = canonicalCandidateBackend({
      search: async (_vector, _k, filters) => [{ id: 'actual-id', payload: { data: 'actual text', user_id: filters!.user_id,
        metadata: { corpus_key: 'a' } }, score: 0.8 }],
      lexicalSearch: async () => [{ id: 'lex-id', payload: { data: 'lex text', user_id: 'bench' }, score: 0.2 }],
    });
    expect(await backend.search('q', { scope: 'bench', vector: [1] })).toMatchObject([{ id: 'actual-id', text: 'actual text', metadata: { corpus_key: 'a' } }]);
    expect(await backend.searchLexical!('q', { scope: 'bench' })).toMatchObject([{ id: 'lex-id' }]);
    expect(await backend.search('q', { scope: 'bench', vector: [1], minScore: 0.9, fusionMode: 'floored-union' })).toEqual([]);
    expect(await backend.available()).toEqual({ ok: true });
    await expect(backend.search('q', { scope: 'bench' })).rejects.toThrow('requires vector');
    await expect(backend.search('q', { scope: 'production', vector: [1] })).rejects.toThrow('isolated');
  });
  it('refuses source-target leakage, missing answers and contradictory negative labels', () => {
    expect(() => validateHeldout(entries, queries)).not.toThrow();
    expect(() => validateHeldout(entries, [queries[0], { ...queries[1], group: 'a' }])).toThrow('leaks');
    expect(() => validateHeldout(entries, [queries[0], { ...queries[1], expected: ['missing'] }])).toThrow('absent');
    expect(() => validateHeldout(entries, [queries[0], { ...queries[1], class: 'hard-negative' }])).toThrow('negative');
  });
  it('calibrates on its training partition without looking at heldout scores', () => {
    const calibration = [
      { partition: 'calibration', expected: ['a'], topScore: 0.6 },
      { partition: 'calibration', expected: [], topScore: 0.3 },
    ];
    expect(calibratedFloor(calibration)).toBe(0.31);
    expect(calibratedFloor([...calibration, { partition: 'test', expected: ['b'], topScore: 0.01 }])).toBe(0.31);
  });
  it('keeps mDenseOn identity distinct from equal-width production Gemma storage', () => {
    const profile = candidateProfile('mdenseon');
    expect(validateEmbedderProfile('candidate', profile)).toEqual([]);
    expect(profile.pooling).toBe('cls');
    expect(validateMemoryStorageCompatibility(profile, MEMORY_VECTOR_STORAGE_PROFILES.gemma)).not.toEqual([]);
    expect(validateMemoryStorageCompatibility(profile, { ...MEMORY_VECTOR_STORAGE_PROFILES.gemma,
      acceptedProfileIds: [profile.profileId] })).toEqual([]);
  });
});

describe('frozen seven-bar measurement contracts (P-001)', () => {
  it('measures installed worker/tokenizer versions before accepting a runtime identity', async () => {
    const arm = measurementManifestFixture('/private').arms[0];
    arm.prompts = { query: mdenseOnPrompt('query', ''), document: mdenseOnPrompt('document', '') };
    arm.tokenizer = { backend: 'rust', version: measurementPackageVersion('tokenizers') };
    arm.execution = { ...arm.execution, device: embedRequestedExecution().device, transport: 'worker',
      intraOpThreads: ORT_SESSION_OPTIONS.intraOpNumThreads, interOpThreads: ORT_SESSION_OPTIONS.interOpNumThreads };
    arm.runtime = { name: 'transformers-js-worker', version: measurementPackageVersion('@huggingface/transformers'), wire: 'worker-in-process',
      source: await fingerprintFile(fileURLToPath(new URL('../../../../../libs/generic/memory/src/local-embedder-worker.script.mjs', import.meta.url))) };
    await expect(assertCandidateArm(arm, 'mdenseon', 'worker')).resolves.toBeUndefined();
    await expect(assertCandidateArm({ ...arm, runtime: { ...arm.runtime, version: 'wrong' } }, 'mdenseon', 'worker')).rejects.toThrow('runtime identity');
    await expect(assertCandidateArm({ ...arm, runtime: { ...arm.runtime, source: { ...arm.runtime.source, sha256: '0'.repeat(64) } } }, 'mdenseon', 'worker')).rejects.toThrow('runtime identity');
  });
  it('accepts a complete declared harness while refusing threshold relaxation and absent cells', () => {
    const manifest = measurementManifestFixture('/private');
    expect(validateMeasurementManifest(manifest).cells).toHaveLength(7);
    expect(() => validateMeasurementManifest({ ...manifest, contracts: { ...manifest.contracts, cosineMin: 0.99 } })).toThrow();
    expect(() => validateMeasurementManifest({ ...manifest, contracts: { ...manifest.contracts, freshProcessBlocks: 3 } })).toThrow();
    expect(() => validateMeasurementManifest({ ...manifest, cells: [...manifest.cells.slice(1), { ...manifest.cells[1], id: 'extra', output: 'extra' }] })).toThrow('missing promised bar');
    expect(() => validateMeasurementManifest({ ...manifest, cells: manifest.cells.map((c) => ({ ...c, output: 'same' })) })).toThrow('duplicate output');
    expect(() => validateMeasurementManifest({ ...manifest, arms: manifest.arms.map((a) => ({ ...a,
      artifacts: { ...a.artifacts, weightLayout: 'external', weights: [] } })) })).toThrow('weight identity');
  });
  it('rejects source leakage even when the query author forges different group strings', () => {
    const { entries, queries, proof } = independentCohortFixture();
    const check = (qs = queries, receipt: unknown = proof) => validateIndependentCohort(entries, qs, receipt,
      proof.snapshotSha256, proof.labelsSha256, '2026-01-02T00:00:00.000Z');
    expect(() => check()).not.toThrow();
    expect(() => check(queries.map((q) => q.partition === 'test' && q.expected.length ? { ...q, group: 'forged-test', expected: ['a'] } : q))).toThrow('actual source target leaks');
    expect(() => check(queries, { ...proof, authority: 'agent-authored' })).toThrow();
    expect(() => check(queries, { ...proof, candidateRankingsExposed: true })).toThrow();
    expect(() => check(queries, { ...proof, queryIds: [...proof.queryIds].reverse() })).toThrow('order');
    expect(() => check(queries.slice(1), { ...proof, queryIds: proof.queryIds.slice(1) })).toThrow('unbalanced');
    expect(() => check(queries, { ...proof, frozenAt: '2026-01-03T00:00:00.000Z' })).toThrow('time');
  });
  it.each(['same-transport', 'same-file', 'normalized-file-alias'])('refuses reused judge evidence: %s', (kind) => {
    const { entries, queries, proof } = independentCohortFixture();
    if (kind === 'same-transport') proof.judges[1].transport = ` ${proof.judges[0].transport} `;
    else proof.judges[1].raw.path = kind === 'same-file' ? proof.judges[0].raw.path : '/private/x/../judge-1.json';
    expect(() => validateIndependentCohort(entries, queries, proof, proof.snapshotSha256,
      proof.labelsSha256, '2026-01-02T00:00:00.000Z')).toThrow(/duplicate.*judge/);
  });
  it('binds arm recipes independent of object key order and refuses equal-width space substitution', () => {
    const arm = measurementManifestFixture('/private').arms[0];
    const actual = { profile: arm.profile, prompts: arm.prompts, execution: arm.execution, tokenizer: arm.tokenizer };
    expect(() => assertMeasurementArm(arm, actual)).not.toThrow();
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }));
    expect(() => assertMeasurementArm(arm, { ...actual, profile: candidateProfile('gemma') })).toThrow('profile identity');
    expect(() => assertMeasurementArm(arm, { ...actual, tokenizer: { ...arm.tokenizer, version: 'different' } })).toThrow('tokenizer identity');
    expect(() => assertMeasurementArm(arm, { ...actual, execution: { ...arm.execution, device: 'cuda' } })).toThrow('execution identity');
  });
  it('refuses wrong HTTP revisions, cache/coalescing, malformed vectors and unverified GPU/worker fallback', () => {
    const arm = measurementManifestFixture('/private').arms[0];
    const unit = [1, ...new Array(767).fill(0)];
    const response = { vectors: [unit], dims: 768, modelRev: arm.modelRev, runtime: arm.runtime.wire, cache: { hits: 0, coalesced: 0, inferred: 1 } };
    expect(() => assertMeasuredEmbedResponse(arm, response, 1)).not.toThrow();
    expect(() => assertMeasuredEmbedResponse(arm, { ...response, modelRev: 'wrong' }, 1)).toThrow('identity');
    expect(() => assertMeasuredEmbedResponse(arm, { ...response, runtime: 'wrong' }, 1)).toThrow('identity');
    expect(() => assertMeasuredEmbedResponse(arm, { ...response, cache: { hits: 1, coalesced: 0, inferred: 0 } }, 1)).toThrow('accounting');
    expect(() => assertMeasuredEmbedResponse(arm, { ...response, vectors: [[NaN, ...unit.slice(1)]] }, 1)).toThrow('unit vector');
    const threads = { intraOpNumThreads: 4, interOpNumThreads: 1 }, worker = { alive: true, disabled: false };
    expect(() => assertMeasuredExecution(arm, { device: 'cpu', dtype: null, verified: true }, threads, worker)).not.toThrow();
    expect(() => assertMeasuredExecution({ ...arm, execution: { ...arm.execution, device: 'cuda' } }, { device: 'cpu', dtype: null, verified: true }, threads, worker)).toThrow('fallback');
    expect(() => assertMeasuredExecution(arm, { device: 'cpu', dtype: null, verified: false }, threads, worker)).toThrow('unverified');
    expect(() => assertMeasuredExecution(arm, { device: 'cpu', dtype: null, verified: true }, threads, { ...worker, disabled: true })).toThrow('fallback');
  });
  it('requires every promised cell exactly once, and an owned diagnosis/guard for exercised incompatibilities', () => {
    const manifest = measurementManifestFixture('/private'), hash = 'a'.repeat(64);
    const outcomes: CellOutcome[] = manifest.cells.map((c) => ({ cellId: c.id, manifestSha256: hash, status: 'measured',
      artifacts: [{ path: `/private/${c.id}.json`, sha256: hash, bytes: 1 }] }));
    expect(() => validateMeasurementCoverage(manifest, hash, outcomes)).not.toThrow();
    expect(() => validateMeasurementCoverage(manifest, hash, outcomes.slice(1))).toThrow('unfinished');
    expect(() => validateMeasurementCoverage(manifest, hash, [...outcomes, outcomes[0]])).toThrow('duplicate');
    expect(() => validateMeasurementCoverage(manifest, hash, [{ ...outcomes[0], status: 'incompatible' }, ...outcomes.slice(1)])).toThrow('owned root');
    expect(() => validateMeasurementCoverage(manifest, hash, [{ ...outcomes[0], status: 'incompatible', defect: {
      owner: 'fixture-owner', item: 'EI-1234', rootCause: 'exercised fixture incompatibility', guard: 'conventional regression fixture' } }, ...outcomes.slice(1)])).not.toThrow();
  });
});
