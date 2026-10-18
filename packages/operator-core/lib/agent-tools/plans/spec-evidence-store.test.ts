import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import * as coldEnvironment from '../../storage/cold-tier-evidence';
import * as verificationHarness from '@papercusp/verification-harness';

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  scorecardRows: [] as Array<Record<string, unknown>>,
  queries: [] as Array<{ sql: string; values: unknown[] }>,
  workspaceScopes: [] as string[],
  planScopeOptions: [] as Array<{ harnessSlug?: string; workspaceId?: string }>,
  measurementRoot: '',
  fixtureMeasurementRoot: '',
  caseRows: null as Array<Record<string, unknown>> | null,
}));

vi.mock('../../acceptance-author-identity', () => ({
  resolvePlanImplementerIdentities: vi.fn(async () => ['su-implementer']),
  areAcceptanceLineageRelated: vi.fn(async (a: string, b: string) => a === b),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    withWorkspace: async <T>(workspaceId: string, fn: (tx: unknown) => Promise<T>) => {
      h.workspaceScopes.push(workspaceId);
      const tx = ((strings: TemplateStringsArray | string[], ...values: unknown[]) => {
        const sql = Array.from(strings).join(' ');
        h.queries.push({ sql, values });
        if (sql.includes('to_regclass')) return Promise.resolve([{ present: h.caseRows !== null }]);
        if (sql.includes('FROM harness_shared.test_case_runs')) return Promise.resolve(h.caseRows ?? []);
        return Promise.resolve(sql.includes('provisional') ? h.scorecardRows : h.rows);
      }) as unknown;
      return fn(tx);
    },
  };
});

vi.mock('./source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./source')>();
  return {
    ...actual,
    resolvePlanScope: async (options: { harnessSlug?: string; workspaceId?: string } = {}) => {
      h.planScopeOptions.push(options);
      return { workspaceId: options.workspaceId ?? 'workspace-test', harnessSlug: 'papercusp' };
    },
  };
});

// Retraction pushes scorecard invalidations after commit in production. Keep this
// unit suite on its in-memory seam; the sync server's own integration tests cover
// the transport and must not be opened by this store test.
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));

// A replay that MEASURES resolves a real harness checkout. Point that resolution at this
// suite's temp fixture root so the measuring path can be observed end to end; without this
// the measurement can only ever fail with repo_measurement_harness_root_unavailable, which
// would make the guards below pass for the wrong reason.
vi.mock('../../harness-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../harness-registry')>();
  return {
    ...actual,
    loadHarnessRegistry: async () => ({}) as never,
    resolveHarnessContentPath: (_registry: unknown, slug: string) =>
      slug === 'papercusp' && h.fixtureMeasurementRoot ? h.fixtureMeasurementRoot : h.measurementRoot,
  };
});

import {
  canonicalOperationalAdapterLayer,
  classifySpecEvidenceCurrentness,
  evidenceMeasurementSchema,
  listSpecEvidence,
  type ListSpecEvidenceDiagnostics,
  measureAndPinEvidenceForScope,
  measureAndPinRepoFilesEvidenceAtRoot,
  measureAndPinRepoFilesEvidenceAtCommitForScope,
  measureRepoFilesEvidenceDetailedAtRoot,
  measureRepoFilesEvidenceDetailedAtCommit,
  measureCompletedTestRuntime,
  agentToolRuntimeSourceWithoutStaticGuidance,
  measureRepoFilesEvidenceAtRoot,
  measureWorkItemsEvidenceForScope,
  hasMatchingDeclaredCaseTitle,
  retractSpecEvidence,
} from './spec-evidence-store';
import { configureRuntimeVintageStore, resetRuntimeVintageStore, InMemoryRuntimeVintageStore,
  reportRuntimeVintage, listRuntimeVintage, measureRuntimeVintageEnvironment } from '../../runtime-vintage';

describe('Vitest it.each case-title identity', () => {
  it.each(['ts', 'python'])('matches the rendered quoted %s label with its declared title', (label) => {
    const suite = 'P-005 maintained grammar indexing through the native surface';
    const declared = `${suite} > ${label} emits language-aware syntax and keeps relationships inferred`;
    const rendered = `${suite} > '${label}' emits language-aware syntax and keeps relationships inferred`;

    expect(hasMatchingDeclaredCaseTitle(declared, [rendered])).toBe(true);
  });

  it('preserves quotes embedded inside a case description', () => {
    expect(hasMatchingDeclaredCaseTitle("suite > reads 'ts' as the source label", ['suite > reads ts as the source label'])).toBe(false);
  });
});

let measurementRoot = '';
const nativeToolSource = `import { defineTool } from '@papercusp/agent-mcp';
export default defineTool({ name: 'reports:publish', description: 'Original ' + 'description',
  guidance: { when: 'publish', chaining: 'publish then read', seeAlso: ['reports:get'] },
  capability: 'reports:write', agentRoles: ['su'], requirePrincipal: false,
  args: z.object({ title: z.string() }), result: z.object({ ok: z.boolean() }),
  async handler(args, ctx) { return { data: { ok: true } }; },
});`;

describe('completed native static tool guidance classification', () => {
  const source = nativeToolSource;
  it('removes only static metadata while retaining every executable byte', () => {
    const before = agentToolRuntimeSourceWithoutStaticGuidance(source);
    expect(before).not.toBeNull();
    expect(before).toContain("capability: 'reports:write'");
    expect(agentToolRuntimeSourceWithoutStaticGuidance(source.replace('Original ', 'New ').replace('publish then read', 'publish then verify read'))).toBe(before);
    for (const [old, replacement] of [["'reports:write'", "'reports:admin'"], ["['su']", "['worker']"],
      ['requirePrincipal: false', 'requirePrincipal: true'], ['z.string()', 'z.number()'],
      ['z.boolean()', 'z.literal(true)'], ['ok: true', 'ok: false'],
      ["'reports:publish'", "'reports:retire'"], ["'@papercusp/agent-mcp'", "'other'"],
      ['return { data', 'ctx.log(args); return { data']]) {
      expect(agentToolRuntimeSourceWithoutStaticGuidance(source.replace(old, replacement))).not.toBe(before);
    }
  });
  it('fails closed for metadata with side effects, spreads, duplicates or parse errors', () => {
    for (const changed of [source.replace("'Original ' + 'description'", 'computeDescription()'),
      source.replace("'publish then read'", '`${performAction()}`'),
      source.replace("seeAlso: ['reports:get']", "seeAlso: [getTool()]"),
      source.replace("when: 'publish'", "get when() { return 'publish'; }"),
      source.replace("when: 'publish'", "...otherGuidance, when: 'publish'"),
      source.replace("when: 'publish'", "when: 'publish', when: 'again'"),
      source.replace("name: 'reports:publish'", "...otherTool, name: 'reports:publish'"),
      source.replace("name: 'reports:publish'", "name: 'reports:publish', description: 'duplicate'"),
      source.replace('description:', "['description']:"), source.replace('defineTool({', 'defineTool(({' )]) {
      expect(agentToolRuntimeSourceWithoutStaticGuidance(changed)).toBeNull();
    }
  });
});

describe('completed isolated runtime certification', () => {
  let root = '', artifacts = '', commit = '';
  const verifierRunId = '20261008T000000Z-100';
  const journeyRunId = '20261008T000020Z-200';
  const at = (seconds: number) => new Date(Date.UTC(2026, 9, 8, 0, 0, seconds)).toISOString();
  const recipe = { schemaVersion: 1 as const, kind: 'repo-files' as const,
    sourcePaths: ['src/feature.ts'], testPaths: ['test/feature.e2e.test.ts'],
    runtimeUnits: ['owned-native'], completedRuntime: { kind: 'verification-harness' as const,
      verifierRunId, journeyHarness: 'native-journey', journeyRunId } };
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'completed-runtime-source-'));
    artifacts = await mkdtemp(join(tmpdir(), 'completed-runtime-artifacts-'));
    await mkdir(join(root, 'src')); await mkdir(join(root, 'test'));
    await writeFile(join(root, 'src/feature.ts'), nativeToolSource);
    await writeFile(join(root, 'test/feature.e2e.test.ts'), 'expect(value).toBe(1);\n');
    // A private fixture repository supplies genuine immutable Git objects.
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'add', 'src', 'test']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-qm', 'fixture']);
    commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true }); });
  afterEach(async () => {
    h.caseRows = null;
    h.measurementRoot = measurementRoot; vi.unstubAllEnvs(); resetRuntimeVintageStore();
    await rm(join(artifacts, 'operator-driver'), { recursive: true, force: true });
    await Promise.all(['verify-tauri-headless', 'native-journey', 'isolated-integration'].map(harness =>
      rm(join(artifacts, harness, 'retained'), { recursive: true, force: true })));
  });

  async function setup() {
    h.measurementRoot = root;
    vi.stubEnv('VH_EVIDENCE_ROOT_BASE', artifacts);
    configureRuntimeVintageStore(new InMemoryRuntimeVintageStore()); // The owned verifier has exited.
    await writeFile(join(root, 'src/feature.ts'), nativeToolSource);
    const measured = await measureRepoFilesEvidenceDetailedAtRoot(root, recipe);
    const verifier = { schemaVersion: 1, harness: 'verify-tauri-headless', runId: verifierRunId,
      verdict: 'pass', reuseFromRunId: null, phases: [
        { phase: 'prepare', status: 'passed', startedAt: at(0), endedAt: at(5) },
        { phase: 'boot', status: 'passed', startedAt: at(5), endedAt: at(10) },
        { phase: 'assert', status: 'passed', startedAt: at(10), endedAt: at(50) },
      ] };
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: commit,
      testedInputs: measured.files.filter(file => file.dimension === 'test'), files: measured.files };
    const journey = { schemaVersion: 1, harness: 'native-journey', runId: journeyRunId,
      verdict: 'pass', reuseFromRunId: null, startedAt: at(20), endedAt: at(30),
      phases: [{ phase: 'native', status: 'passed' }] };
    const manifest = { result: 'pass', sourceFingerprints: measured.files.filter(file => file.dimension === 'source') };
    const save = async () => {
      const dir = join(artifacts, 'verify-tauri-headless', verifierRunId);
      await mkdir(join(dir, 'phases/prepare'), { recursive: true });
      await writeFile(join(dir, 'result.json'), JSON.stringify(verifier));
      await writeFile(join(dir, 'phases/prepare/verifier-source-receipt.json'), JSON.stringify(receipt));
      const child = join(artifacts, 'native-journey', journeyRunId);
      await mkdir(join(child, 'phases/native'), { recursive: true });
      await writeFile(join(child, 'result.json'), JSON.stringify(journey));
      await writeFile(join(child, 'phases/native/manifest.json'), JSON.stringify(manifest));
    };
    await save();
    const witness = { schemaVersion: 1, units: recipe.runtimeUnits, fingerprint: 'a'.repeat(64), observedAt: at(11) };
    const execution = { schemaVersion: 1, root, filePath: recipe.testPaths[0], runGroupId: 'native-run',
      workspaceId: 'workspace-test', harnessSlug: 'papercusp', testNamePattern: null as string | null, testLayer: 'e2e',
      passed: 1, failed: 0, skipped: 0, collectionFailed: false, mutationPhase: null,
      commitSha: commit, worktreeDirty: false, runtimeEnvironmentBefore: witness,
      runtimeEnvironmentAfter: { ...witness, observedAt: at(40) } };
    const row = { id: 91, work_item_id: 'WI-runtime', plan_slug: 'plan-one', spec_id: 'SPEC-runtime',
      source_val_id: null, spec_revision: 1, current_revision: 1, spec_fingerprint: 'sha256:spec',
      evidence_kind: 'test', evidence_ref: recipe.testPaths[0], source_fingerprint: measured.sourceFingerprint,
      test_fingerprint: measured.testFingerprint, fixture_fingerprint: null, rubric_fingerprint: null,
      environment_fingerprint: witness.fingerprint, coverage_evidence_ref: null, coverage_evidence_present: false,
      test_run_id: 42, test_run_present: true, test_run_file_path: recipe.testPaths[0],
      test_run_commit_sha: commit, test_run_worktree_dirty: false, test_run_framework: 'vitest',
      test_run_status: 'pass', test_run_execution_details: execution, test_run_started_at: at(12),
      test_run_finished_at: at(35), details: { currentMeasurement: structuredClone(recipe), evidencePlane: 'live' },
      observed_at: at(40), created_at: at(40), created_by: 'su-test', binding_fingerprint: 'binding', spec_is_current: true };
    h.rows = [row];
    return { row, execution, verifier, receipt, journey, manifest, save };
  }
  const read = async () => (await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] }))[0];

  async function setupIntegration(testLayer: 'integration' | 'e2e' = 'integration') {
    const state = await setup();
    const runId = '20261008T000021Z-201';
    const basis: any = { ...recipe, runtimeUnits: [`isolated-integration:${runId}`],
      completedRuntime: { kind: 'isolated-integration', runIds: [runId] } };
    const measured = await measureRepoFilesEvidenceDetailedAtRoot(root, basis);
    const result: any = { schemaVersion: 1, harness: 'isolated-integration', runId,
      verdict: 'pass', reuseFromRunId: null, startedAt: at(13), endedAt: at(33), phases: [
        { phase: 'prepare', status: 'passed', startedAt: at(13), endedAt: at(14) },
        { phase: 'execute', status: 'passed', startedAt: at(14), endedAt: at(32) },
        { phase: 'teardown', status: 'passed', startedAt: at(32), endedAt: at(33) },
      ] };
    const source: any = { schemaVersion: 1, runId, sourceCommit: commit, repoRoot: root, filePath: state.execution.filePath,
      runGroupId: state.execution.runGroupId, workspaceId: 'workspace-test', harnessSlug: 'papercusp',
      files: measured.files.map(file => ({ ...file, gitSha256: file.sha256 })) };
    const pin = (pid: number, parentPid: number) => ({ pid, parentPid, identity: `linux:fixture-boot:${pid}` });
    const life: any = { schemaVersion: 1, runId, host: hostname(), cwd: root, observedAt: at(15),
      observer: pin(100, 1), supervisor: pin(200, 100), worker: pin(300, 200), database: pin(400, 200),
      argv: ['node', 'test-child.ts'], workspace: 'test-runtime-private',
      runtimeRoot: '/tmp/papercusp-test-runtime-private', dataDir: '/tmp/papercusp-test-pg-private', pgPort: 54422,
      ended: { childPid: 300, observedAt: at(31), exitCode: 23, signal: null, runtimeRemoved: true, pgDataRemoved: true } };
    const dir = join(artifacts, 'isolated-integration', runId);
    await mkdir(join(dir, 'phases/prepare'), { recursive: true });
    await mkdir(join(dir, 'phases/execute'), { recursive: true });
    const save = async (recordHashes = false) => {
      const values = [result, source, life];
      for (const [i, file] of ['result.json', 'phases/prepare/source.json', 'phases/execute/lifecycle.json'].entries())
        await writeFile(join(dir, file), JSON.stringify(values[i]));
      if (recordHashes) {
        const hashes = values.map(value => createHash('sha256').update(JSON.stringify(value)).digest('hex'));
        (state.execution as any).isolatedRuntimeReceipts = [{ runId, resultSha256: hashes[0], sourceSha256: hashes[1], lifecycleSha256: hashes[2] }];
      }
    };
    state.execution.testLayer = testLayer;
    delete (state.execution as any).runtimeEnvironmentBefore;
    delete (state.execution as any).runtimeEnvironmentAfter;
    state.row.details.currentMeasurement = basis;
    await save(true);
    state.row.environment_fingerprint = createHash('sha256').update(JSON.stringify((state.execution as any).isolatedRuntimeReceipts)).digest('hex');
    return { ...state, basis, measured, result, source, life, save, dir };
  }

  describe.each(['integration', 'e2e'] as const)('isolated %s runtime certification', testLayer => {
  const setupIsolated = () => setupIntegration(testLayer);

  it('certifies the original lifetime with the reporter hashes after both worker and private PG exit', async () => {
    await setupIsolated();
    expect((await read()).currentness.dimensions.environment).toBe('current');
  });
  it('certifies original isolated receipts when the first binding omitted the completion selector without changing its recipe', async () => {
    const state = await setupIsolated();
    delete state.basis.completedRuntime;
    const originalRecipe = structuredClone(state.basis);
    const evidence = await read();
    expect(evidence.currentness).toMatchObject({ overall: 'current', provenance: 'server-measured',
      dimensions: { source: 'current', test: 'current', environment: 'current', testRun: 'current' } });
    expect(state.row.details.currentMeasurement).toEqual(originalRecipe);
  });
  it.each(['tampered-receipt', 'missing-artifact', 'missing-receipts', 'wrong-unit', 'wrong-scope',
    'wrong-source', 'wrong-commit', 'missing-teardown', 'deployed', 'explicit-wrong-selector'])(
    'keeps inferred completion fail-closed for %s', async failure => {
      const state = await setupIsolated();
      delete state.basis.completedRuntime;
      if (failure === 'tampered-receipt') state.life.pgPort++;
      if (failure === 'wrong-source') state.source.files[0].gitSha256 = 'b'.repeat(64);
      if (failure === 'wrong-scope') state.source.workspaceId = 'foreign';
      if (failure === 'missing-teardown') state.life.ended.pgDataRemoved = false;
      await state.save(failure !== 'tampered-receipt');
      if (failure === 'missing-artifact') await rm(join(state.dir, 'phases/execute/lifecycle.json'));
      if (failure === 'missing-receipts') delete (state.execution as any).isolatedRuntimeReceipts;
      if (failure === 'wrong-unit') state.basis.runtimeUnits = ['bg-host'];
      if (failure === 'wrong-commit') state.row.test_run_commit_sha = 'b'.repeat(40);
      if (failure === 'deployed') state.row.details.evidencePlane = 'deployed';
      if (failure === 'explicit-wrong-selector') state.basis.completedRuntime = {
        kind: 'isolated-integration', runIds: ['20261008T000022Z-202'] };
      expect((await read()).currentness.dimensions.environment).toBe('unknown');
    });
  it.each(['tree', 'live', 'deployed', 'unknown', undefined])(
    'certifies the retained isolated lifetime only for tree or live evidence: %s', async evidencePlane => {
      const state = await setupIsolated();
      state.row.details.evidencePlane = evidencePlane as string;
      expect((await read()).currentness.dimensions.environment)
        .toBe(evidencePlane === 'tree' || evidencePlane === 'live' ? 'current' : 'unknown');
    });
  it.each(['filtered', 'missing-pattern', 'invalid-pattern', 'selected-skip', 'missing-ledger', 'missing-case', 'failed-case'])(
    'certifies only ledger-proven excluded cases: %s', async condition => {
      const state = await setupIsolated();
      state.execution.skipped = 1;
      state.execution.testNamePattern = 'selected alarm';
      const cases = [
        { case_key: 'suite > selected alarm', occurrence: 0, status: 'pass', duration_ms: 1,
          file_path: state.execution.filePath },
        { case_key: 'suite > unrelated alarm', occurrence: 0, status: 'skip', duration_ms: 0,
          file_path: state.execution.filePath },
      ];
      h.caseRows = cases;
      if (condition === 'missing-pattern') state.execution.testNamePattern = null;
      if (condition === 'invalid-pattern') state.execution.testNamePattern = '[';
      if (condition === 'selected-skip') cases[1].case_key = 'suite > selected alarm also';
      if (condition === 'missing-ledger') h.caseRows = null;
      if (condition === 'missing-case') cases.pop();
      if (condition === 'failed-case') cases[0].status = 'fail';
      expect((await read()).currentness.dimensions.environment)
        .toBe(condition === 'filtered' ? 'current' : 'unknown');
    });
  it.each(['local', 'mutation-probe', 'ci', 'admin-ui'])('preserves guarded adoption of a NULL-harness lifetime only for an adoptable %s ledger row', async sourceKind => {
    const state = await setupIsolated();
    state.execution.harnessSlug = null as any;
    state.source.harnessSlug = null;
    (state.row as any).test_run_source = sourceKind;
    await state.save(true);
    state.row.environment_fingerprint = createHash('sha256')
      .update(JSON.stringify((state.execution as any).isolatedRuntimeReceipts)).digest('hex');
    expect((await read()).currentness.dimensions.environment)
      .toBe(sourceKind === 'local' || sourceKind === 'mutation-probe' ? 'current' : 'unknown');
    state.row.test_run_present = false;
    expect((await read()).currentness.dimensions.environment).toBe('unknown');
  });
  // EI-25847620673275477: the judge's re-observation of this same run read environment=unknown,
  // which made the bar proof_uncertain and refused grading.
  it.each([['independent-verification', 'current'], ['manual', 'unknown']] as const)(
    'certifies a %s row carrying the same completed run only when it is test or independent-verification',
    async (kind, expected) => {
      const state = await setupIsolated();
      (state.row as any).evidence_kind = kind;
      expect((await read()).currentness.dimensions.environment).toBe(expected);
    });
  it('certifies runtime execution when the reporter-derived start follows harness preparation', async () => {
    const state = await setupIsolated();
    // The reporter subtracts rounded duration from its later completion clock.
    // The retained harness clock is authoritative for its own phase ordering.
    state.row.test_run_started_at = at(14);
    expect((await read()).currentness.dimensions.environment).toBe('current');
  });
  it('rejects runtime execution that starts before the parent test interval', async () => {
    const state = await setupIsolated();
    state.row.test_run_started_at = at(15);
    expect((await read()).currentness.dimensions.environment).toBe('unknown');
  });
  it('rejects an out-of-order preparation receipt even when execution is inside the parent interval', async () => {
    const state = await setupIsolated();
    state.row.test_run_started_at = at(14);
    state.result.phases[0].startedAt = at(12);
    await state.save(true);
    expect((await read()).currentness.dimensions.environment).toBe('unknown');
  });
  it('certifies a committed disposable checkout against the same current Git objects', async () => {
    const state = await setupIsolated();
    state.source.repoRoot = '/tmp/papercusp-lint-as-committed-original';
    state.life.cwd = state.source.repoRoot;
    await state.save(true);
    state.row.environment_fingerprint = createHash('sha256').update(JSON.stringify((state.execution as any).isolatedRuntimeReceipts)).digest('hex');
    expect((await read()).currentness.dimensions.environment).toBe('current');
  });
  it.each(['tampered-receipt', 'missing-artifact', 'reused-run', 'wrong-source', 'wrong-layer', 'dirty',
    'outside-test', 'wrong-parent', 'missing-kernel', 'missing-teardown', 'wrong-scope', 'unrecorded', 'wrong-unit',
    'missing-original-root', 'relative-original-root', 'wrong-worker-cwd'])(
    'rejects isolated proof for %s', async failure => {
      const state = await setupIsolated();
      if (failure === 'tampered-receipt') state.life.pgPort++;
      if (failure === 'reused-run') state.result.reuseFromRunId = 'earlier';
      if (failure === 'wrong-source') state.source.files[0].gitSha256 = 'b'.repeat(64);
      if (failure === 'outside-test') state.result.phases[2].endedAt = at(36);
      if (failure === 'wrong-parent') state.life.worker.parentPid = 1;
      if (failure === 'missing-kernel') state.life.worker.identity = '';
      if (failure === 'missing-teardown') state.life.ended.pgDataRemoved = false;
      if (failure === 'wrong-scope') state.source.workspaceId = 'foreign';
      if (failure === 'missing-original-root') delete state.source.repoRoot;
      if (failure === 'relative-original-root') state.source.repoRoot = 'relative-root';
      if (failure === 'wrong-worker-cwd') state.life.cwd = '/tmp/different-worker-root';
      await state.save(failure !== 'tampered-receipt');
      if (failure === 'missing-artifact') await rm(join(state.dir, 'phases/execute/lifecycle.json'));
      if (failure === 'wrong-layer') state.execution.testLayer = 'unit';
      if (failure === 'dirty') state.row.test_run_worktree_dirty = true;
      if (failure === 'unrecorded') delete (state.execution as any).isolatedRuntimeReceipts;
      if (failure === 'wrong-unit') state.basis.runtimeUnits = ['bg-host'];
      expect((await read()).currentness.dimensions.environment).toBe('unknown');
    });
  it('retains integration receipt bytes through pruning and detects a changed retained artifact', async () => {
    const state = await setupIsolated();
    await measureAndPinRepoFilesEvidenceAtRoot(root, state.basis);
    await rm(state.dir, { recursive: true });
    expect((await read()).currentness.dimensions.environment).toBe('current');
    const retained = join(artifacts, 'isolated-integration', 'retained', state.result.runId, 'phases/execute/lifecycle.json');
    await writeFile(retained, '{}');
    expect((await read()).currentness.dimensions.environment).toBe('unknown');
  });
  it('rejects current integration source drift against the executed Git objects', async () => {
    const state = await setupIsolated();
    const files = state.measured.files.map((file, i) => i === 0 ? { ...file, sha256: 'b'.repeat(64) } : file);
    expect(await measureCompletedTestRuntime(state.row as any, state.basis, files,
      { workspaceId: 'workspace-test', harnessSlug: 'papercusp' }, root)).toBeNull();
  });
  });

  it('certifies the original completed execution after teardown using retained artifacts and Git objects', async () => {
    await setup();
    const evidence = await read();
    expect(evidence.currentness).toMatchObject({ overall: 'current', provenance: 'server-measured',
      dimensions: { source: 'current', test: 'current', environment: 'current', testRun: 'current' } });
  });
  it.each(['native', 'integration'] as const)(
    'reads original retained %s proof after the default evidence root moves', async kind => {
      if (kind === 'native') await setup(); else await setupIntegration();
      const legacyHome = await mkdtemp(join(tmpdir(), 'completed-runtime-legacy-home-'));
      const canonical = await mkdtemp(join(tmpdir(), 'completed-runtime-new-default-'));
      const legacy = join(legacyHome, '.local/state/verification-harness');
      const roots = kind === 'native' ? ['verify-tauri-headless', 'native-journey'] : ['isolated-integration'];
      const relocated = vi.spyOn(verificationHarness, 'defaultEvidenceRoot')
        .mockImplementation(harness => join(canonical, harness));
      try {
        for (const harness of roots) {
          const runId = harness === 'verify-tauri-headless' ? verifierRunId
            : harness === 'native-journey' ? journeyRunId : '20261008T000021Z-201';
          await cp(join(artifacts, harness, runId), join(legacy, harness, 'retained', runId), { recursive: true });
        }
        vi.stubEnv('VH_EVIDENCE_ROOT_BASE', '');
        vi.stubEnv('XDG_STATE_HOME', '');
        vi.stubEnv('HOME', legacyHome);
        expect((await read()).currentness.dimensions.environment).toBe('current');

        // A real artifact at the current root remains authoritative: invalid
        // custody there must not be hidden by a valid historical copy.
        const harness = roots[0];
        const runId = kind === 'native' ? verifierRunId : '20261008T000021Z-201';
        const current = join(canonical, harness, runId);
        await mkdir(current, { recursive: true });
        await writeFile(join(current, 'result.json'), '{}');
        expect((await read()).currentness.dimensions.environment).not.toBe('current');
        await rm(join(canonical, harness), { recursive: true, force: true });

        // An explicit evidence location is a boundary, not a request to search
        // the caller's historical home directory.
        vi.stubEnv('VH_EVIDENCE_ROOT_BASE', canonical);
        expect((await read()).currentness.dimensions.environment).not.toBe('current');
      } finally {
        relocated.mockRestore();
        await rm(legacyHome, { recursive: true, force: true });
        await rm(canonical, { recursive: true, force: true });
      }
    },
  );
  it.each([['independent-verification', 'current'], ['manual', 'unknown']] as const)(
    'certifies a completed harness run on a %s row only for test or independent-verification (EI-25847620673275477)',
    async (kind, expected) => {
      const state = await setup();
      (state.row as any).evidence_kind = kind;
      expect((await read()).currentness.dimensions.environment).toBe(expected);
    });
  // EI-25420516419064831: the maintained browser driver wraps the whole
  // verifier, rather than writing a native journey manifest inside the test.
  async function setupOperatorE2e() {
    const state = await setup();
    const driverRoot = join(artifacts, 'operator-driver');
    vi.stubEnv('OPERATOR_E2E_HARNESS_EVIDENCE_ROOT', driverRoot);
    const basis = { ...recipe, completedRuntime: { ...recipe.completedRuntime,
      journeyHarness: 'operator-e2e-isolated' } };
    state.row.details.currentMeasurement = basis;
    state.row.test_run_framework = 'playwright';
    state.receipt.testedInputs = state.receipt.files;
    Object.assign(state.verifier, { startedAt: at(0), endedAt: at(50) });
    const journey = { ...state.journey, harness: 'operator-e2e-isolated',
      startedAt: at(-2), endedAt: at(52), phases: [
        { phase: 'preflight', status: 'passed', startedAt: at(-1), endedAt: at(-1) },
        { phase: 'isolated-suite', status: 'passed', startedAt: at(-1), endedAt: at(51) },
      ] };
    const dir = join(driverRoot, journeyRunId);
    const save = async () => {
      await state.save();
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'result.json'), JSON.stringify(journey));
    };
    await save();
    return { ...state, basis, journey, dir, save };
  }
  it('certifies the original operator-e2e-isolated driver at its maintained evidence root without a native manifest', async () => {
    await setupOperatorE2e();
    expect((await read()).currentness).toMatchObject({ overall: 'current',
      dimensions: { source: 'current', test: 'current', environment: 'current', testRun: 'current' } });
  });
  it.each(['missing-source', 'wrong-source', 'untested-input', 'unqualified-source', 'missing-witness', 'reused-driver',
    'wrong-driver', 'missing-suite', 'duplicate-suite', 'suite-before-verifier', 'suite-after-verifier',
    'reversed-suite', 'reversed-driver', 'driver-outside-root'])(
    'rejects operator-e2e-isolated custody or lifetime failure: %s', async failure => {
      const state = await setupOperatorE2e();
      if (failure === 'wrong-source') state.receipt.files[0].sha256 = 'b'.repeat(64);
      if (failure === 'untested-input') state.receipt.testedInputs = [];
      if (failure === 'unqualified-source') state.receipt.testedInputs = state.receipt.files.filter(file => file.dimension === 'test');
      if (failure === 'missing-witness') delete (state.execution as any).runtimeEnvironmentBefore;
      if (failure === 'reused-driver') state.journey.reuseFromRunId = 'earlier' as any;
      if (failure === 'wrong-driver') state.journey.harness = 'foreign';
      if (failure === 'missing-suite') state.journey.phases.pop();
      if (failure === 'duplicate-suite') state.journey.phases.push({ ...state.journey.phases[1] });
      if (failure === 'suite-before-verifier') state.journey.phases[1].startedAt = at(1);
      if (failure === 'suite-after-verifier') state.journey.phases[1].endedAt = at(49);
      if (failure === 'reversed-suite') state.journey.phases[1].startedAt = at(52);
      if (failure === 'reversed-driver') state.journey.startedAt = at(53);
      await state.save();
      if (failure === 'missing-source') await rm(join(artifacts, 'verify-tauri-headless', verifierRunId,
        'phases/prepare/verifier-source-receipt.json'));
      if (failure === 'driver-outside-root') {
        await rm(join(state.dir, 'result.json'));
        await symlink(join(artifacts, 'native-journey', journeyRunId, 'result.json'), join(state.dir, 'result.json'));
      }
      expect((await read()).currentness.dimensions.environment).toBe('unknown');
    });
  it('retains the original operator driver receipt through pruning and rejects changed retained custody', async () => {
    const state = await setupOperatorE2e();
    await measureAndPinRepoFilesEvidenceAtRoot(root, state.basis);
    await rm(state.dir, { recursive: true });
    expect((await read()).currentness.dimensions.environment).toBe('current');
    await writeFile(join(dirname(state.dir), 'retained', journeyRunId, 'result.json'), '{}');
    expect((await read()).currentness.dimensions.environment).toBe('unknown');
  });
  it('certifies a Playwright native execution only with its original paired witness and journey', async () => {
    const state = await setup();
    state.row.test_run_framework = 'playwright';
    expect((await read()).currentness.dimensions.environment).toBe('current');
    delete (state.execution as any).runtimeEnvironmentBefore;
    expect((await read()).currentness.dimensions.environment).toBe('unknown');
  });
  it('certifies the original native lifecycle when the reporter completion boundary rounds early', async () => {
    const state = await setup();
    state.row.test_run_framework = 'playwright';
    // The reporter derives a wall-clock interval from duration. The original
    // harness receipt can finish milliseconds later, still inside the paired
    // runtime observations taken before and after the actual test execution.
    state.row.test_run_started_at = new Date(Date.parse(at(20)) - 180).toISOString();
    state.row.test_run_finished_at = new Date(Date.parse(at(30)) - 3).toISOString();
    expect((await read()).currentness.dimensions.environment).toBe('current');
  });
  it.each(['before-witness', 'after-witness', 'reversed-lifecycle'])(
    'rejects a native lifecycle outside its original witness: %s', async failure => {
      const state = await setup();
      state.row.test_run_framework = 'playwright';
      if (failure === 'before-witness') state.journey.startedAt = at(10);
      if (failure === 'after-witness') state.journey.endedAt = at(41);
      if (failure === 'reversed-lifecycle') state.journey.startedAt = at(31);
      await state.save();
      expect((await read()).currentness.dimensions.environment).toBe('unknown');
    });
  it('rejects Playwright native proof without an authentic paired journey', async () => {
    const state = await setup();
    state.row.test_run_framework = 'playwright';
    state.journey.verdict = 'fail';
    await state.save();
    expect((await read()).currentness.dimensions.environment).toBe('unknown');
  });
  it('keeps exact certification receipts through actual harness retention pruning', async () => {
    const state = await setup();
    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(artifacts, 'mutex'));
    vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', join(artifacts, 'pins'));
    // A completed verifier must satisfy the retention policy's terminal-result
    // contract; without endedAt this fixture exercises the 24-hour grace instead.
    Object.assign(state.verifier, { startedAt: at(0), endedAt: at(50) });
    await state.save();
    await measureAndPinRepoFilesEvidenceAtRoot(root, recipe);
    const { pruneRuns } = await import('@papercusp/verification-harness');
    for (const [harness, runId] of [['verify-tauri-headless', verifierRunId], ['native-journey', journeyRunId]]) {
      const base = join(artifacts, harness);
      const newer = join(base, '20261008T000100Z-300');
      await mkdir(newer, { recursive: true });
      await writeFile(join(newer, 'result.json'), '{}');
      expect(await pruneRuns(base, 1)).toContain(runId);
    }
    expect((await read()).currentness.dimensions.environment).toBe('current');
    const retainedReceipt = join(artifacts, 'verify-tauri-headless', 'retained', verifierRunId,
      'phases/prepare/verifier-source-receipt.json');
    const receipt = JSON.parse(await readFile(retainedReceipt, 'utf8'));
    receipt.files[0].sha256 = 'b'.repeat(64);
    await writeFile(retainedReceipt, JSON.stringify(receipt));
    expect((await read()).currentness.dimensions.environment).toBe('unknown');
  });
  it('refuses to overwrite an immutable retained receipt during repeated pinning', async () => {
    const state = await setup();
    await measureAndPinRepoFilesEvidenceAtRoot(root, recipe);
    state.receipt.files[0].sha256 = 'b'.repeat(64);
    await state.save();
    await expect(measureAndPinRepoFilesEvidenceAtRoot(root, recipe)).rejects.toThrow('retained harness artifact changed');
  });
  it('independently qualifies only static guidance drift while retaining both raw source fingerprints', async () => {
    const state = await setup();
    const commitSource = async (source: string) => {
      await writeFile(join(root, 'src/feature.ts'), source);
      execFileSync('git', ['-C', root, 'add', 'src/feature.ts']);
      execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '--allow-empty', '-qm', 'guidance classification fixture']);
    };
    try {
      await commitSource(nativeToolSource.replace('Original ', 'Current ').replace('publish then read', 'publish then verify read'));
      expect((await read()).currentness.dimensions.source).toBe('stale');
      Object.assign(state.row.details.currentMeasurement.completedRuntime, { guidanceOnlySourcePaths: ['src/feature.ts'] });
      const evidence = await read();
      expect(evidence.currentness.overall).toBe('current');
      expect(evidence.fingerprints.sourceFingerprint).toBe(state.row.source_fingerprint);
      expect(evidence.currentness.sourceEquivalence).toMatchObject({ kind: 'static-agent-tool-guidance',
        paths: ['src/feature.ts'], storedFingerprint: state.row.source_fingerprint });
      expect(evidence.currentness.sourceEquivalence?.measuredFingerprint).not.toBe(state.row.source_fingerprint);
      // Replacing a retained ORIGINAL raw hash with today's hash is not allowed.
      state.manifest.sourceFingerprints[0].sha256 = '0'.repeat(64);
      await state.save();
      expect((await read()).currentness.overall).not.toBe('current');
      state.manifest.sourceFingerprints[0].sha256 = state.receipt.files.find(file => file.dimension === 'source')!.sha256;
      await state.save();
      await commitSource(nativeToolSource.replace('ok: true', 'ok: false'));
      const codeChanged = await read();
      expect(codeChanged.currentness.dimensions.source).toBe('stale');
      expect(codeChanged.currentness.dimensions.environment).toBe('unknown');
      expect(codeChanged.currentness.sourceEquivalence).toBeUndefined();
    } finally { await commitSource(nativeToolSource); }
  });

  it('rejects guidance classification outside explicit source paths or on completed LLM selectors', () => {
    expect(evidenceMeasurementSchema.safeParse({ ...recipe, completedRuntime: {
      ...recipe.completedRuntime, guidanceOnlySourcePaths: ['test/feature.e2e.test.ts'] } }).success).toBe(false);
    expect(evidenceMeasurementSchema.safeParse({ ...recipe, completedRuntime: {
      kind: 'llm-in-process', guidanceOnlySourcePaths: ['src/feature.ts'] } }).success).toBe(false);
  });

  async function setupLlm() {
    const state = await setup();
    const store = new InMemoryRuntimeVintageStore();
    configureRuntimeVintageStore(store);
    const pid = 2147483647; // Cannot identify a live Linux process.
    const unit = `llm-test-in-process-${pid}`;
    await store.report({ unit, pid, host: hostname(), treeSha: commit, buildTime: at(0),
      workspaceId: 'workspace-test', extra: { kernelProcessIdentity: 'linux:original-boot:100' } });
    const runtime = [...store.rows.values()][0];
    runtime.reportedAt = at(9);
    const fingerprint = createHash('sha256').update(JSON.stringify([
      [unit, runtime.host, commit, at(0), pid, runtime.extra.kernelProcessIdentity],
    ])).digest('hex');
    state.row.test_run_framework = 'llm-test';
    state.execution.testLayer = 'llm';
    state.execution.runtimeEnvironmentBefore = { schemaVersion: 1, units: [unit], fingerprint, observedAt: at(11) };
    state.execution.runtimeEnvironmentAfter = { ...state.execution.runtimeEnvironmentBefore, observedAt: at(40) };
    state.row.environment_fingerprint = fingerprint;
    Object.assign(state.row.details.currentMeasurement, {
      runtimeUnits: [unit], completedRuntime: { kind: 'llm-in-process' },
    });
    return { ...state, store, runtime };
  }
  it('certifies completed LLM source execution from its original kernel witness and Git objects', async () => {
    const state = await setupLlm();
    expect(measureRuntimeVintageEnvironment([...state.store.rows.values()],
      state.execution.runtimeEnvironmentBefore.units)).toBeNull();
    expect((await read()).currentness).toMatchObject({ overall: 'current', provenance: 'server-measured',
      dimensions: { environment: 'current', source: 'current', test: 'current', testRun: 'current' } });
  });
  it.each(['local', 'mutation-probe', 'ci', 'admin-ui'])(
    'certifies an adopted original NULL-harness LLM witness only for a scoped adoptable %s row', async sourceKind => {
      const state = await setupLlm();
      state.execution.harnessSlug = null as any;
      (state.row as any).test_run_source = sourceKind;
      const originalExecution = JSON.stringify(state.execution);
      expect((await read()).currentness.dimensions.environment)
        .toBe(sourceKind === 'local' || sourceKind === 'mutation-probe' ? 'current' : 'unknown');
      expect(JSON.stringify(state.execution)).toBe(originalExecution);
      state.row.test_run_present = false;
      expect((await read()).currentness.dimensions.environment).toBe('unknown');
    });
  it('refuses a captured foreign LLM harness even when the scoped ledger row is local', async () => {
    const state = await setupLlm();
    state.execution.harnessSlug = 'foreign';
    (state.row as any).test_run_source = 'local';
    expect((await read()).currentness.dimensions.environment).toBe('unknown');
  });
  it.each(['missing-row', 'changed-kernel', 'changed-commit', 'bundle-runtime', 'wrong-unit',
    'late-report', 'late-boot', 'remote-host', 'missing-witness', 'dirty-run', 'deployed-plane',
    'wrong-framework', 'wrong-layer', 'no-completion-selector'])(
    'refuses completed LLM certification for %s', async failure => {
      const state = await setupLlm();
      if (failure === 'missing-row') state.store.rows.clear();
      if (failure === 'changed-kernel') state.runtime.extra.kernelProcessIdentity = 'linux:replacement:200';
      if (failure === 'changed-commit') state.runtime.treeSha = 'b'.repeat(40);
      if (failure === 'bundle-runtime') state.runtime.bundleVersion = `node-entry-sha256:${'b'.repeat(64)}`;
      if (failure === 'wrong-unit') state.runtime.unit = 'dev-api';
      if (failure === 'late-report') state.runtime.reportedAt = at(12);
      if (failure === 'late-boot') state.runtime.buildTime = at(10);
      if (failure === 'remote-host') state.runtime.host = 'another-machine';
      if (failure === 'missing-witness') delete (state.execution as any).runtimeEnvironmentBefore;
      if (failure === 'dirty-run') state.row.test_run_worktree_dirty = true;
      if (failure === 'deployed-plane') state.row.details.evidencePlane = 'deployed';
      if (failure === 'wrong-framework') state.row.test_run_framework = 'vitest';
      if (failure === 'wrong-layer') state.execution.testLayer = 'unit';
      if (failure === 'no-completion-selector') delete (state.row.details.currentMeasurement as any).completedRuntime;
      expect((await read()).currentness.dimensions.environment).toBe('unknown');
    });
  it('refuses LLM source certification when current file bytes differ from the original Git object', async () => {
    const state = await setupLlm();
    const basis = state.row.details.currentMeasurement as any;
    const current = await measureRepoFilesEvidenceDetailedAtRoot(root, basis);
    current.files[0].sha256 = 'b'.repeat(64);
    expect(await measureCompletedTestRuntime(state.row as any, basis, current.files,
      { workspaceId: 'workspace-test', harnessSlug: 'papercusp' }, root)).toBeNull();
  });
  it.each(['failed-boot', 'reused-verifier', 'wrong-source', 'changed-receipt', 'wrong-journey-source', 'outside-witness',
    'missing-witness', 'dirty-run', 'deployed-plane', 'no-completion-selector'])(
    'refuses certification for %s', async failure => {
      const state = await setup();
      if (failure === 'failed-boot') state.verifier.phases[1].status = 'failed';
      if (failure === 'reused-verifier') (state.verifier as any).reuseFromRunId = 'another-run';
      if (failure === 'wrong-source') state.receipt.sourceCommit = 'b'.repeat(40);
      if (failure === 'changed-receipt') state.receipt.files[0].sha256 = 'b'.repeat(64);
      if (failure === 'wrong-journey-source') state.manifest.sourceFingerprints[0].sha256 = 'b'.repeat(64);
      if (failure === 'outside-witness') state.journey.endedAt = at(41);
      if (failure === 'missing-witness') delete (state.execution as any).runtimeEnvironmentBefore;
      if (failure === 'dirty-run') state.row.test_run_worktree_dirty = true;
      if (failure === 'deployed-plane') state.row.details.evidencePlane = 'deployed';
      if (failure === 'no-completion-selector') delete (state.row.details.currentMeasurement as any).completedRuntime;
      await state.save();
      expect((await read()).currentness.dimensions.environment).toBe('unknown');
    });
  it('detects current source drift even when the original receipt remains a pass', async () => {
    await setup();
    await writeFile(join(root, 'src/feature.ts'), 'export const value = 2;\n');
    execFileSync('git', ['-C', root, 'add', 'src/feature.ts']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-qm', 'changed fixture source']);
    const evidence = await read();
    expect(evidence.currentness.dimensions.source).toBe('stale');
    expect(evidence.currentness.dimensions.environment).toBe('unknown');
  });
});

beforeAll(async () => {
  measurementRoot = await mkdtemp(join(tmpdir(), 'spec-evidence-measurement-'));
  h.measurementRoot = measurementRoot;
  await Promise.all([
    mkdir(join(measurementRoot, 'src'), { recursive: true }),
    mkdir(join(measurementRoot, 'test'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(measurementRoot, 'src', 'feature.ts'), 'export const value = 1;\n'),
    writeFile(join(measurementRoot, 'test', 'feature.test.ts'), 'expect(value).toBe(1);\n'),
  ]);
});

afterAll(async () => {
  await rm(measurementRoot, { recursive: true, force: true });
});

describe('repo-backed server measurement', () => {
  it('remeasures a final package on the deployed plane without caller testimony or a live PID', async () => {
    const receiptPath = 'docs/evidence/shipment.json';
    const artifacts = await mkdtemp(join(tmpdir(), 'spec-final-package-'));
    try {
      await mkdir(join(measurementRoot, 'docs/evidence'), { recursive: true });
      await writeFile(join(artifacts, 'app.deb'), 'original');
      await writeFile(join(measurementRoot, receiptPath), JSON.stringify({
        schemaVersion: 1, kind: 'operational-test-evidence', exitCode: 0,
        assertions: [{ passed: true }], artifactRoot: artifacts,
        runtimeArtifacts: [{ path: 'app.deb', bytes: 8,
          sha256: createHash('sha256').update('original').digest('hex') }],
      }));
      const recipe = { schemaVersion: 1 as const, kind: 'repo-files' as const,
        sourcePaths: [receiptPath], artifactReceiptPath: receiptPath };
      const measured = await measureAndPinRepoFilesEvidenceAtRoot(measurementRoot, recipe);
      h.rows = [{ id: 91, work_item_id: 'WI-package', plan_slug: 'plan-one', spec_id: 'SPEC-package',
        source_val_id: null, spec_revision: 1, current_revision: 1, spec_fingerprint: 'sha256:spec',
        evidence_kind: 'manual', evidence_ref: receiptPath, source_fingerprint: measured.sourceFingerprint,
        test_fingerprint: null, fixture_fingerprint: null, rubric_fingerprint: null,
        environment_fingerprint: measured.environmentFingerprint, coverage_evidence_ref: null,
        coverage_evidence_present: false, test_run_id: null, test_run_present: false,
        details: { currentMeasurement: recipe, evidencePlane: 'deployed', runtime: 'desktop-shell' },
        observed_at: '2026-10-10T00:00:00Z', created_at: '2026-10-10T00:00:00Z', created_by: 'su-test',
        binding_fingerprint: 'binding', spec_is_current: true }];
      const read = async () => (await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] }))[0];
      expect((await read()).currentness).toMatchObject({ overall: 'current', provenance: 'server-measured',
        dimensions: { environment: 'current' } });
      await writeFile(join(artifacts, 'app.deb'), 'replaced');
      expect((await read()).currentness.dimensions.environment).toBe('stale');
      await rm(join(artifacts, 'app.deb'));
      expect((await read()).currentness.overall).toBe('unknown');
    } finally { await rm(artifacts, { recursive: true, force: true }); }
  });
  it('independently remeasures runtime identity, ignores matching caller testimony and detects drift', async () => {
    configureRuntimeVintageStore(new InMemoryRuntimeVintageStore());
    try {
      await reportRuntimeVintage({ unit: 'test-live', pid: process.pid, treeSha: 'a'.repeat(40), workspaceId: 'workspace-test' });
      const fingerprint = measureRuntimeVintageEnvironment(await listRuntimeVintage('workspace-test'), ['test-live']);
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
      const recipe = { schemaVersion: 1 as const, kind: 'repo-files' as const,
        sourcePaths: ['src/feature.ts'], testPaths: ['test/feature.test.ts'], runtimeUnits: ['test-live'] };
      const measured = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
      h.rows = [{ id: 91, work_item_id: 'WI-runtime', plan_slug: 'plan-one', spec_id: 'SPEC-runtime',
        source_val_id: null, spec_revision: 1, current_revision: 1, spec_fingerprint: 'sha256:spec',
        evidence_kind: 'manual', evidence_ref: 'runtime:observed', source_fingerprint: measured.sourceFingerprint,
        test_fingerprint: measured.testFingerprint, fixture_fingerprint: null, rubric_fingerprint: null,
        environment_fingerprint: fingerprint, coverage_evidence_ref: null, coverage_evidence_present: false,
        test_run_id: null, test_run_present: false, details: { currentMeasurement: recipe, evidencePlane: 'live' },
        observed_at: '2026-10-07T00:00:00Z', created_at: '2026-10-07T00:00:00Z', created_by: 'su-test',
        binding_fingerprint: 'binding', spec_is_current: true }];
      const options = { harnessSlug: 'papercusp', planSlugs: ['plan-one'], current: [{ evidenceKind: 'manual' as const,
        evidenceRef: 'runtime:observed', sourceFingerprint: measured.sourceFingerprint,
        testFingerprint: measured.testFingerprint, environmentFingerprint: fingerprint }] };
      const [current] = await listSpecEvidence(options);
      expect(current.currentness).toMatchObject({ overall: 'current', provenance: 'server-measured',
        dimensions: { environment: 'current' } });
      await reportRuntimeVintage({ unit: 'test-live', pid: process.pid, treeSha: 'b'.repeat(40), workspaceId: 'workspace-test' });
      const [drift] = await listSpecEvidence(options);
      expect(drift.currentness.dimensions.environment).toBe('stale');
      h.rows[0].environment_fingerprint = null;
      const [historical] = await listSpecEvidence(options);
      expect(historical.currentness.dimensions.environment).toBe('unknown');
    } finally { resetRuntimeVintageStore(); }
  });
  it('hashes normalized source/test file sets deterministically and detects a source change', async () => {
    const recipe = {
      schemaVersion: 1 as const,
      kind: 'repo-files' as const,
      sourcePaths: ['src/feature.ts'],
      testPaths: ['test/feature.test.ts'],
    };
    const first = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    const replay = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    expect(replay).toEqual(first);
    expect(first.sourceFingerprint).toMatch(/^sha256-file-set-v1:[0-9a-f]{64}$/);
    expect(first.testFingerprint).toMatch(/^sha256-file-set-v1:[0-9a-f]{64}$/);

    await writeFile(join(measurementRoot, 'src', 'feature.ts'), 'export const value = 2;\n');
    const changed = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    expect(changed.sourceFingerprint).not.toBe(first.sourceFingerprint);
    expect(changed.testFingerprint).toBe(first.testFingerprint);
  });

  it('measures fixture calibration files as an independent fingerprint and pin dimension', async () => {
    const fixturePath = 'fixture/server-envelope.ts';
    await mkdir(join(measurementRoot, 'fixture'), { recursive: true });
    await writeFile(join(measurementRoot, fixturePath), 'export const voicePort: number | null = 8080;\n');
    const recipe = {
      schemaVersion: 1 as const,
      kind: 'repo-files' as const,
      sourcePaths: ['src/feature.ts'],
      testPaths: ['test/feature.test.ts'],
      fixturePaths: [fixturePath],
    };

    const first = await measureAndPinRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    expect(first.fixtureFingerprint).toMatch(/^sha256-file-set-v1:[0-9a-f]{64}$/);
    expect(first.pin.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: fixturePath, dimension: 'fixture' }),
    ]));

    await writeFile(join(measurementRoot, fixturePath), 'export const voicePort: number | null = null;\n');
    const changed = await measureRepoFilesEvidenceDetailedAtRoot(measurementRoot, recipe);
    expect(changed.fixtureFingerprint).not.toBe(first.fixtureFingerprint);
    expect(changed.sourceFingerprint).toBe(first.sourceFingerprint);
    expect(changed.testFingerprint).toBe(first.testFingerprint);
  });

  it('preserves the fixture root through scope-level measurement and pinning', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'spec-evidence-fixture-root-'));
    h.fixtureMeasurementRoot = fixtureRoot;
    const fixturePath = 'calibration/server-envelope.ts';
    try {
      await mkdir(join(fixtureRoot, 'calibration'), { recursive: true });
      await writeFile(join(fixtureRoot, fixturePath), 'export const serverPort = 8080;\n');
      const recipe = {
        schemaVersion: 1 as const,
        kind: 'repo-files' as const,
        rootHarnessSlug: 'papercup-rust-mobile',
        sourcePaths: ['src/feature.ts'],
        testPaths: ['test/feature.test.ts'],
        fixturePaths: [fixturePath],
        fixtureRootHarnessSlug: 'papercusp',
      };

      const first = await measureAndPinEvidenceForScope('workspace-test', 'papercusp', recipe);
      expect(first.fixtureFingerprint).toMatch(/^sha256-file-set-v1:[0-9a-f]{64}$/);
      expect(first.pin?.files).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: fixturePath,
          dimension: 'fixture',
          rootHarnessSlug: 'papercusp',
        }),
      ]));

      await writeFile(join(fixtureRoot, fixturePath), 'export const serverPort = 8081;\n');
      const changed = await measureAndPinEvidenceForScope('workspace-test', 'papercusp', recipe);
      expect(changed.fixtureFingerprint).not.toBe(first.fixtureFingerprint);
      expect(changed.sourceFingerprint).toBe(first.sourceFingerprint);
      expect(changed.testFingerprint).toBe(first.testFingerprint);
    } finally {
      h.fixtureMeasurementRoot = '';
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('binds and independently rechecks native host proof, rejecting unavailable or changed observations', async () => {
    const native = vi.spyOn(coldEnvironment, 'measureNativeColdEnvironment');
    const fingerprint = 'sha256-native-storage-environment-v1:' + 'a'.repeat(64);
    const recipe = { schemaVersion: 1 as const, kind: 'repo-files' as const,
      sourcePaths: ['src/feature.ts'], testPaths: ['test/feature.test.ts'],
      nativeInstrumentKey: coldEnvironment.COLD_MOVES_INSTRUMENT_KEY } satisfies Parameters<typeof measureAndPinEvidenceForScope>[2];
    try {
      native.mockResolvedValue(fingerprint);
      const bound = await measureAndPinEvidenceForScope('workspace-test', 'papercusp', recipe);
      expect(bound.environmentFingerprint).toBe(fingerprint);
      expect(native).toHaveBeenLastCalledWith('workspace-test', 'papercusp', recipe.nativeInstrumentKey, true);
      h.rows = [{ id: 9201, plan_slug: 'native-plan', spec_id: 'NATIVE-1', spec_revision: 1,
        spec_is_current: true, evidence_kind: 'operational', evidence_ref: 'native:cold-cutover',
        source_fingerprint: bound.sourceFingerprint, test_fingerprint: bound.testFingerprint,
        fixture_fingerprint: null, rubric_fingerprint: null, environment_fingerprint: fingerprint,
        coverage_evidence_ref: null, coverage_evidence_present: false, test_run_id: null, test_run_present: false,
        details: { currentMeasurement: recipe, evidencePlane: 'live' },
        observed_at: '2026-10-16T00:00:00Z', created_at: '2026-10-16T00:00:00Z', created_by: 'su-test',
        binding_fingerprint: 'native-binding' }];
      const read = async () => (await listSpecEvidence({ planSlugs: ['native-plan'], harnessSlug: 'papercusp', workspaceId: 'workspace-test' }))[0]!;
      expect((await read()).currentness.overall).toBe('current');
      expect(native).toHaveBeenLastCalledWith('workspace-test', 'papercusp', recipe.nativeInstrumentKey);
      native.mockResolvedValue('sha256-native-storage-environment-v1:' + 'b'.repeat(64));
      expect((await read()).currentness.dimensions.environment).toBe('stale');
      native.mockResolvedValue(null);
      expect((await read()).currentness.dimensions.environment).toBe('unknown');
      native.mockRejectedValue(new Error('native observation unavailable'));
      expect((await read()).currentness.overall).toBe('unknown');
      await expect(measureAndPinEvidenceForScope('workspace-test', 'papercusp', recipe)).rejects.toThrow('native observation unavailable');
    } finally { native.mockRestore(); }
  });

  it('allows only native storage selectors and refuses ambiguous environment selectors', () => {
    const base = { kind: 'repo-files', sourcePaths: ['src/feature.ts'], nativeInstrumentKey: coldEnvironment.COLD_MOVES_INSTRUMENT_KEY };
    expect(evidenceMeasurementSchema.safeParse(base).success).toBe(true);
    for (const extra of [{ runtimeUnits: ['operator'] }, { artifactReceiptPath: 'docs/evidence/package.json' },
      { nativeInstrumentKey: 'unregistered:fake' }]) {
      expect(evidenceMeasurementSchema.safeParse({ ...base, ...extra }).success).toBe(false);
    }
  });

  it('refuses to restamp a historical test commit with a native observation taken now', async () => {
    const native = vi.spyOn(coldEnvironment, 'measureNativeColdEnvironment');
    try {
      await expect(measureAndPinRepoFilesEvidenceAtCommitForScope('workspace-test', 'papercusp', {
        schemaVersion: 1, kind: 'repo-files', sourcePaths: ['src/feature.ts'],
        nativeInstrumentKey: coldEnvironment.COLD_MOVES_INSTRUMENT_KEY,
      }, { commitSha: 'a'.repeat(40), repoPrefix: null })).rejects.toThrow('cannot certify a historical test commit');
      expect(native).not.toHaveBeenCalled();
    } finally { native.mockRestore(); }
  });

  it('includes globbed source changes, additions, and removals in the source fingerprint', async () => {
    const plugins = join(measurementRoot, 'dynamic', 'plugins');
    await Promise.all([
      mkdir(join(plugins, 'linear-sync'), { recursive: true }),
      mkdir(join(measurementRoot, 'dynamic', 'migrations'), { recursive: true }),
    ]);
    const manifest = join(plugins, 'linear-sync', 'papercusp.json');
    const migration = join(measurementRoot, 'dynamic', 'migrations', '1400-recreate-plugin.sql');
    await Promise.all([
      writeFile(manifest, '{"enabled":false}\n'),
      writeFile(migration, 'CREATE TABLE one();\n'),
    ]);
    const recipe = {
      schemaVersion: 1 as const,
      kind: 'repo-files' as const,
      sourcePaths: ['src/feature.ts'],
      sourceGlobs: ['dynamic/plugins/*/papercusp.json', 'dynamic/migrations/14*.sql'],
      testPaths: ['test/feature.test.ts'],
    };

    const initialDetailed = await measureRepoFilesEvidenceDetailedAtRoot(measurementRoot, recipe);
    expect(initialDetailed.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'dynamic/plugins/linear-sync/papercusp.json', dimension: 'source' }),
    ]));
    const initial = {
      sourceFingerprint: initialDetailed.sourceFingerprint,
      testFingerprint: initialDetailed.testFingerprint,
    };
    await writeFile(manifest, '{"enabled":true}\n');
    const changed = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    expect(changed.sourceFingerprint).not.toBe(initial.sourceFingerprint);

    const addedManifest = join(plugins, 'calendar-sync', 'papercusp.json');
    await mkdir(join(plugins, 'calendar-sync'), { recursive: true });
    await writeFile(addedManifest, '{"enabled":false}\n');
    const added = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    expect(added.sourceFingerprint).not.toBe(changed.sourceFingerprint);

    await rm(addedManifest);
    const removed = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    expect(removed.sourceFingerprint).not.toBe(added.sourceFingerprint);
    expect(removed.testFingerprint).toBe(initial.testFingerprint);
  });

  it('measures a SQL fixture corpus independently and detects changed, added, and removed inputs', async () => {
    const dir = join(measurementRoot, 'sql-corpus');
    await mkdir(dir, { recursive: true });
    // More than the source glob bound: fixture corpora have their own admission bound.
    await Promise.all(Array.from({ length: 129 }, (_, i) => writeFile(join(dir, `${i}.sql`), 'SELECT 1;\n')));
    const recipe = {
      schemaVersion: 1 as const, kind: 'repo-files' as const,
      sourcePaths: ['src/feature.ts'], testPaths: ['test/feature.test.ts'],
      fixtureGlobs: ['sql-corpus/*.sql'],
    };
    const first = await measureAndPinRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    expect(first.pin.files.filter((file) => file.dimension === 'fixture')).toHaveLength(129);
    await writeFile(join(dir, '0.sql'), 'SELECT 2;\n');
    const changed = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    expect(changed.fixtureFingerprint).not.toBe(first.fixtureFingerprint);
    await writeFile(join(dir, 'added.sql'), 'SELECT 3;\n');
    const added = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    expect(added.fixtureFingerprint).not.toBe(changed.fixtureFingerprint);
    await rm(join(dir, 'added.sql'));
    const removed = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    expect(removed.fixtureFingerprint).toBe(changed.fixtureFingerprint);
    expect(removed.sourceFingerprint).toBe(first.sourceFingerprint);
    expect(removed.testFingerprint).toBe(first.testFingerprint);
  });

  it('resolves glob-only fixtures at their declared second root and retains traversal and byte guards', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fixture-corpus-root-'));
    try {
      await writeFile(join(root, 'input.sql'), 'SELECT 1;\n');
      const recipe = { schemaVersion: 1 as const, kind: 'repo-files' as const,
        sourcePaths: ['src/feature.ts'], fixtureGlobs: ['*.sql'], fixtureRootHarnessSlug: 'fixtures' };
      const measured = await measureRepoFilesEvidenceDetailedAtRoot(measurementRoot, recipe, { fixtureRoot: root });
      expect(measured.files).toContainEqual(expect.objectContaining({ path: 'input.sql', dimension: 'fixture', rootHarnessSlug: 'fixtures' }));
      await expect(measureRepoFilesEvidenceAtRoot(measurementRoot, { ...recipe, fixtureGlobs: ['../*.sql'] }, { fixtureRoot: root }))
        .rejects.toThrow(/normalized repo-relative POSIX/);
      await symlink(join(root, 'input.sql'), join(measurementRoot, 'escape.sql'));
      await expect(measureRepoFilesEvidenceAtRoot(measurementRoot, {
        ...recipe, fixtureRootHarnessSlug: undefined, fixturePaths: ['escape.sql'], fixtureGlobs: undefined,
      })).rejects.toThrow(/symlink_outside_root/);
      await writeFile(join(root, 'input.sql'), Buffer.alloc(8 * 1024 * 1024 + 1));
      await expect(measureRepoFilesEvidenceAtRoot(measurementRoot, recipe, { fixtureRoot: root })).rejects.toThrow(/repo_measurement_too_large/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('pins every byte and member of a fixture corpus above 8MiB with identical working-tree and committed fingerprints', async () => {
    const dir = join(measurementRoot, 'large-fixture');
    await mkdir(dir);
    const fixtures = ['a.sql', 'b.sql', 'c.sql'];
    await Promise.all(fixtures.map((path, i) => writeFile(join(dir, path), Buffer.alloc(3 * 1024 * 1024, i + 1))));
    const recipe = { schemaVersion: 1 as const, kind: 'repo-files' as const,
      sourcePaths: ['src/feature.ts'], testPaths: ['test/feature.test.ts'], fixtureGlobs: ['large-fixture/*.sql'] };
    const first = await measureAndPinRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    expect(first.pin.files.filter(file => file.dimension === 'fixture').map(file => file.path))
      .toEqual(fixtures.map(path => `large-fixture/${path}`));
    const committedRoot = await mkdtemp(join(tmpdir(), 'fixture-committed-twin-'));
    try {
      await cp(measurementRoot, committedRoot, { recursive: true });
      const git = (...args: string[]) => execFileSync('git', ['-C', committedRoot, '-c', 'user.name=test',
        '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
      git('init', '-q');
      git('add', '.');
      git('commit', '-q', '-m', 'full fixture corpus');
      const committed = await measureRepoFilesEvidenceDetailedAtCommit(committedRoot, recipe, git('rev-parse', 'HEAD'));
      expect(committed.fixtureFingerprint).toBe(first.fixtureFingerprint);
      expect(committed.files.filter(file => file.dimension === 'fixture')
        .map(({ path, sha256, dimension }) => ({ path, sha256, dimension })))
        .toEqual(first.pin.files.filter(file => file.dimension === 'fixture')
          .map(({ path, sha256, dimension }) => ({ path, sha256, dimension })));
      for (const file of committed.files.filter(file => file.dimension === 'fixture')) {
        expect(file.gitBlob).toBe(git('hash-object', file.path));
      }
    } finally { await rm(committedRoot, { recursive: true, force: true }); }
    // Fixture admission must not widen ordinary product-source admission.
    await expect(measureRepoFilesEvidenceAtRoot(measurementRoot, {
      ...recipe, sourcePaths: fixtures.map(path => `large-fixture/${path}`), fixtureGlobs: undefined,
    })).rejects.toThrow(/repo_measurement_too_large/);
    await writeFile(join(dir, 'c.sql'), 'changed tail');
    const changed = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    expect(changed.fixtureFingerprint).not.toBe(first.fixtureFingerprint);
    await writeFile(join(dir, 'added.sql'), 'new member');
    const added = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    expect(added.fixtureFingerprint).not.toBe(changed.fixtureFingerprint);
    await rm(join(dir, 'added.sql'));
    expect((await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe)).fixtureFingerprint).toBe(changed.fixtureFingerprint);
    expect(changed.sourceFingerprint).toBe(first.sourceFingerprint);
    expect(changed.testFingerprint).toBe(first.testFingerprint);
  });

  it('refuses a fixture corpus beyond its file count bound', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fixture-corpus-bound-'));
    try {
      await Promise.all(Array.from({ length: 4097 }, (_, i) => writeFile(join(root, `${i}.sql`), '')));
      await expect(measureRepoFilesEvidenceAtRoot(measurementRoot, {
        schemaVersion: 1, kind: 'repo-files', sourcePaths: ['src/feature.ts'],
        fixtureGlobs: ['*.sql'], fixtureRootHarnessSlug: 'fixtures',
      }, { fixtureRoot: root })).rejects.toThrow(/repo_measurement_too_many_glob_files:4097>4096/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('bounds the number of files expanded from source globs', async () => {
    const bounded = join(measurementRoot, 'bounded-glob');
    await mkdir(bounded, { recursive: true });
    await Promise.all(Array.from({ length: 129 }, (_, index) =>
      writeFile(join(bounded, `file-${index}.ts`), 'export {};\n')));

    await expect(measureRepoFilesEvidenceAtRoot(measurementRoot, {
      schemaVersion: 1,
      kind: 'repo-files',
      sourcePaths: ['src/feature.ts'],
      sourceGlobs: ['bounded-glob/*.ts'],
    })).rejects.toThrow(/repo_measurement_too_many_glob_files/);
  });

  it('rejects traversal and symlink escapes before reading bytes', async () => {
    await expect(
      measureRepoFilesEvidenceAtRoot(measurementRoot, {
        schemaVersion: 1,
        kind: 'repo-files',
        sourcePaths: ['../outside.ts'],
      }),
    ).rejects.toThrow(/normalized repo-relative POSIX/);
    await expect(
      measureRepoFilesEvidenceAtRoot(measurementRoot, {
        schemaVersion: 1,
        kind: 'repo-files',
        sourcePaths: ['src/feature.ts'],
        sourceGlobs: ['../outside/*.ts'],
      }),
    ).rejects.toThrow(/normalized repo-relative POSIX/);
  });
});

describe('classifySpecEvidenceCurrentness exact current comparisons', () => {
  // RECURRENCE GUARD (EI-23761345516273342). The replay path performs no server
  // measurement, so its whole `current` tuple is caller-supplied. If a replayed
  // tuple can ever again classify as `overall:'current'` with server-grade
  // provenance, any caller can mint a passing freshness verdict from fingerprints
  // it authored itself — which is the defect this guard exists to catch.
  //
  // Calibration: the sibling test above feeds the IDENTICAL row + tuple with
  // provenance 'server-measured' and correctly gets `overall:'current'`. That
  // pairing is what makes this assertion falsifiable rather than vacuous: only the
  // provenance differs, so a regression that stops distinguishing them fails here.
  it('never lets a replayed snapshot reach overall:current — it is not an independent measurement', () => {
    const currentness = classifySpecEvidenceCurrentness(
      {
        spec_is_current: true,
        source_fingerprint: 'git:one',
        test_fingerprint: 'sha256:test',
        fixture_fingerprint: null,
        rubric_fingerprint: null,
        environment_fingerprint: null,
        coverage_evidence_ref: null,
        coverage_evidence_present: false,
        test_run_id: null,
        test_run_present: false,
      },
      {
        // Every dimension matches the stored row, so nothing is stale. Under the
        // pre-fix behaviour this combination returned `current`/`server-measured`.
        evidenceKind: 'test',
        evidenceRef: 'vitest:one',
        sourceFingerprint: 'git:one',
        testFingerprint: 'sha256:test',
      },
      { provenance: 'replayed-snapshot' },
    );

    expect(currentness.overall).not.toBe('current');
    expect(currentness).toMatchObject({
      overall: 'unknown',
      provenance: 'replayed-snapshot',
      staleReasons: [],
    });
    expect(currentness.unknownReasons).toContain('current-fingerprints-replayed-not-independently-measured');
  });

  it('treats a complete byte-identical server-measured fingerprint set as current', () => {
    const currentness = classifySpecEvidenceCurrentness(
      {
        spec_is_current: true,
        source_fingerprint: 'git:one',
        test_fingerprint: 'sha256:test',
        fixture_fingerprint: null,
        rubric_fingerprint: null,
        environment_fingerprint: null,
        coverage_evidence_ref: null,
        coverage_evidence_present: false,
        test_run_id: null,
        test_run_present: false,
      },
      {
        evidenceKind: 'test',
        evidenceRef: 'vitest:one',
        sourceFingerprint: 'git:one',
        testFingerprint: 'sha256:test',
      },
      { provenance: 'server-measured' },
    );

    expect(currentness).toMatchObject({
      overall: 'current',
      dimensions: {
        spec: 'current',
        source: 'current',
        test: 'current',
        fixture: 'not-applicable',
      },
      staleReasons: [],
      unknownReasons: [],
      comparisonSupplied: true,
      provenance: 'server-measured',
    });
  });

  it.each([
    { label: 'dirty', worktreeDirty: true, expectedOverall: 'unknown' },
    { label: 'clean', worktreeDirty: false, expectedOverall: 'current' },
  ])(
    '$label test-run worktree yields $expectedOverall freshness',
    ({ worktreeDirty, expectedOverall }) => {
      const currentness = classifySpecEvidenceCurrentness(
        {
          spec_is_current: true,
          source_fingerprint: 'git:one',
          test_fingerprint: 'sha256:test',
          fixture_fingerprint: null,
          rubric_fingerprint: null,
          environment_fingerprint: null,
          coverage_evidence_ref: null,
          coverage_evidence_present: false,
          test_run_id: 43,
          test_run_present: true,
          test_run_worktree_dirty: worktreeDirty,
        },
        {
          evidenceKind: 'test',
          evidenceRef: 'vitest:one',
          sourceFingerprint: 'git:one',
          testFingerprint: 'sha256:test',
        },
        { provenance: 'server-measured' },
      );

      expect(currentness.overall).toBe(expectedOverall);
      expect(currentness.dimensions.testRun).toBe(expectedOverall);
      if (worktreeDirty) expect(currentness.unknownReasons).toContain('test-run-worktree-not-clean');
    },
  );

  it('labels an echoed caller fingerprint set attested-current and caps aggregate freshness at unknown', () => {
    const currentness = classifySpecEvidenceCurrentness(
      {
        spec_is_current: true,
        source_fingerprint: 'git:one',
        test_fingerprint: 'sha256:test',
        fixture_fingerprint: null,
        rubric_fingerprint: null,
        environment_fingerprint: null,
        coverage_evidence_ref: null,
        coverage_evidence_present: false,
        test_run_id: null,
        test_run_present: false,
      },
      {
        evidenceKind: 'test',
        evidenceRef: 'vitest:one',
        sourceFingerprint: 'git:one',
        testFingerprint: 'sha256:test',
      },
    );

    expect(currentness).toMatchObject({
      overall: 'unknown',
      provenance: 'attested-current',
      dimensions: { source: 'current', test: 'current' },
      unknownReasons: ['current-fingerprints-attested-not-independently-measured'],
      comparisonSupplied: true,
    });
  });

  it('keeps mixed server and caller comparisons explicit instead of laundering opaque dimensions', () => {
    const currentness = classifySpecEvidenceCurrentness(
      {
        spec_is_current: true,
        source_fingerprint: 'git:one',
        test_fingerprint: 'sha256:test',
        fixture_fingerprint: null,
        rubric_fingerprint: 'sha256:rubric',
        environment_fingerprint: 'node:24',
        coverage_evidence_ref: null,
        coverage_evidence_present: false,
        test_run_id: null,
        test_run_present: false,
      },
      {
        evidenceKind: 'test',
        evidenceRef: 'vitest:mixed',
        sourceFingerprint: 'git:one',
        testFingerprint: 'sha256:test',
        rubricFingerprint: 'sha256:rubric',
        environmentFingerprint: 'node:24',
      },
      { provenance: 'server-measured', attestedDimensions: ['rubric', 'environment'] },
    );

    expect(currentness).toMatchObject({
      overall: 'unknown',
      provenance: 'partially-server-measured',
      dimensions: { source: 'current', test: 'current', rubric: 'current', environment: 'current' },
      staleReasons: [],
      unknownReasons: [
        'current-fingerprints-partially-attested-not-independently-measured:environment,rubric',
      ],
      comparisonSupplied: true,
    });
  });

  it.each([
    { plane: 'live', expectedEnvironment: 'unknown', expectedOverall: 'unknown' },
    { plane: 'deployed', expectedEnvironment: 'unknown', expectedOverall: 'unknown' },
    { plane: 'local', expectedEnvironment: 'not-applicable', expectedOverall: 'current' },
    { plane: undefined, expectedEnvironment: 'not-applicable', expectedOverall: 'current' },
  ].flatMap((entry) => [false, true].map((nested) => ({ ...entry, nested }))))(
    'requires a recorded environment fingerprint for $plane evidence (nested=$nested) and preserves other planes',
    ({ plane, nested, expectedEnvironment, expectedOverall }) => {
      const currentness = classifySpecEvidenceCurrentness(
        {
          spec_is_current: true,
          source_fingerprint: 'git:one',
          test_fingerprint: 'sha256:test',
          fixture_fingerprint: null,
          rubric_fingerprint: null,
          environment_fingerprint: null,
          coverage_evidence_ref: null,
          coverage_evidence_present: false,
          test_run_id: null,
          test_run_present: false,
          evidence_kind: 'test',
          details: {
            ...(plane === undefined || nested ? {} : { evidencePlane: plane }),
            adequacy: { testLayer: 'e2e', ...(nested && plane !== undefined ? { evidencePlane: plane } : {}) },
          },
        },
        {
          evidenceKind: 'test',
          evidenceRef: 'packages/operator-core/lib/desktop/personal-desktop.live.e2e.test.ts',
          sourceFingerprint: 'git:one',
          testFingerprint: 'sha256:test',
          environmentFingerprint: 'runtime:0.0.21-pcd006b',
        },
        { provenance: 'server-measured' },
      );

      expect(currentness.dimensions.environment).toBe(expectedEnvironment);
      expect(currentness.overall).toBe(expectedOverall);
      if (expectedEnvironment === 'unknown') {
        expect(currentness.unknownReasons).toContain('environment-evidence-fingerprint-not-recorded');
      }
    },
  );

  it.each(['live', 'deployed'])('ledger-only live proof measures ledger state without inventing a runtime on %s', (plane) => {
    const measurement = { schemaVersion: 1, kind: 'work-items', workItemIds: ['EI-1234'] };
    const row = {
      spec_is_current: true,
      source_fingerprint: 'sha256-work-item-set-v1:open',
      test_fingerprint: null,
      fixture_fingerprint: null,
      rubric_fingerprint: null,
      environment_fingerprint: null,
      coverage_evidence_ref: null,
      coverage_evidence_present: false,
      test_run_id: null,
      test_run_present: false,
      evidence_kind: 'manual' as const,
      details: { evidencePlane: plane, currentMeasurement: measurement },
    };
    const current = {
      evidenceKind: 'manual' as const,
      evidenceRef: 'work-item:EI-1234',
      sourceFingerprint: 'sha256-work-item-set-v1:open',
    };
    expect(classifySpecEvidenceCurrentness(row, current, { provenance: 'server-measured' })).toMatchObject({
      overall: 'current', dimensions: { source: 'current', environment: 'not-applicable' }, unknownReasons: [],
    });
    expect(classifySpecEvidenceCurrentness(row, { ...current, sourceFingerprint: 'sha256-work-item-set-v1:done' },
      { provenance: 'server-measured' })).toMatchObject({
      overall: 'stale', dimensions: { source: 'stale', environment: 'not-applicable' }, staleReasons: ['source-stale'],
    });
    for (const currentMeasurement of [
      { ...measurement, runtimeUnits: ['operator'] },
      { ...measurement, workItemIds: [] },
      { ...measurement, unexpected: true },
      { schemaVersion: 1, kind: 'repo-files', sourcePaths: ['source.ts'] },
    ]) {
      expect(classifySpecEvidenceCurrentness({ ...row, details: { evidencePlane: plane, currentMeasurement } },
        current, { provenance: 'server-measured' })).toMatchObject({
        overall: 'unknown', dimensions: { environment: 'unknown' },
        unknownReasons: ['environment-evidence-fingerprint-not-recorded'],
      });
    }
  });

  it('compares recorded runtime fingerprints for live evidence', () => {
    const row = {
      spec_is_current: true,
      source_fingerprint: 'git:one',
      test_fingerprint: 'sha256:test',
      fixture_fingerprint: null,
      rubric_fingerprint: null,
      environment_fingerprint: 'runtime:0.0.21-pcd006b',
      coverage_evidence_ref: null,
      coverage_evidence_present: false,
      test_run_id: null,
      test_run_present: false,
      evidence_kind: 'test' as const,
      details: { evidencePlane: 'live' },
    };
    const current = {
      evidenceKind: 'test' as const,
      evidenceRef: 'packages/operator-core/lib/desktop/personal-desktop.live.e2e.test.ts',
      sourceFingerprint: 'git:one',
      testFingerprint: 'sha256:test',
      environmentFingerprint: 'runtime:0.0.21-pcd006b',
    };

    expect(classifySpecEvidenceCurrentness(row, current, { provenance: 'server-measured' })).toMatchObject({
      overall: 'current',
      dimensions: { environment: 'current' },
    });
    expect(classifySpecEvidenceCurrentness(
      row,
      { ...current, environmentFingerprint: 'runtime:0.0.22' },
      { provenance: 'server-measured' },
    )).toMatchObject({
      overall: 'stale',
      dimensions: { environment: 'stale' },
      staleReasons: ['environment-stale'],
    });
  });
});

describe('canonical operational recording adapter layer', () => {
  const run = { framework: 'operational', source: 'local', filePath: 'docs/evidence/check.json',
    runGroupId: `operational:${'a'.repeat(40)}`, commitSha: 'abc', worktreeDirty: false };

  it('recognizes committed operational recordings and append-only recoveries', () => {
    expect(canonicalOperationalAdapterLayer(run)).toBe('operational');
    expect(canonicalOperationalAdapterLayer({ ...run,
      runGroupId: `operational-recovery:20826187:${'a'.repeat(40)}` })).toBe('operational');
  });

  const native = { ...run, filePath: 'packages/operator-core/lib/check.test.ts',
    runGroupId: 'operational-native:fb504047-776b-4cc9-9207-a259d997d21a',
    commitSha: 'b'.repeat(40) };

  it('recognizes the trusted native operational adapter without claiming e2e', () => {
    expect(canonicalOperationalAdapterLayer(native)).toBe('operational');
    expect(canonicalOperationalAdapterLayer({ ...native, framework: 'playwright' })).toBeUndefined();
  });

  it.each([
    { source: 'mutation-probe' }, { worktreeDirty: true }, { worktreeDirty: null },
    { commitSha: 'abc' }, { commitSha: null },
    { runGroupId: 'operational-native:caller-label' },
    { runGroupId: 'operational-native:fb504047-776b-1cc9-9207-a259d997d21a' },
    { filePath: '/tmp/check.ts' }, { filePath: '../check.ts' },
    { filePath: 'packages/../check.ts' }, { filePath: 'packages\\check.ts' },
  ])('rejects untrusted native operational receipt provenance %j', patch => {
    expect(canonicalOperationalAdapterLayer({ ...native, ...patch })).toBeUndefined();
  });

  it.each([
    { framework: 'vitest' }, { framework: 'node' }, { source: 'mutation-probe' },
    { worktreeDirty: true }, { worktreeDirty: null }, { commitSha: null },
    { filePath: 'test/check.test.ts' }, { runGroupId: 'caller-claimed-operational' },
    { runGroupId: null },
  ])('refuses unverified or unrelated provenance %j', patch => {
    expect(canonicalOperationalAdapterLayer({ ...run, ...patch })).toBeUndefined();
  });
});

describe('listSpecEvidence timestamp normalization', () => {
  beforeEach(() => {
    h.rows = [];
    h.scorecardRows = [];
    h.queries = [];
    h.workspaceScopes = [];
    h.planScopeOptions = [];
  });

  it('exposes the stored independent citation and author instead of assertions in details', async () => {
    h.rows = [{
      id: 902, work_item_id: 'WI-review', plan_slug: 'plan-one', spec_id: 'SPEC-1',
      source_val_id: null, spec_revision: 1, current_revision: 1,
      spec_fingerprint: 'spec', spec_is_current: true, evidence_kind: 'independent-verification',
      evidence_ref: 'test/real-subject.test.ts', source_fingerprint: 'source',
      test_fingerprint: 'test', fixture_fingerprint: null, rubric_fingerprint: null,
      environment_fingerprint: null, coverage_evidence_ref: null, test_run_id: null,
      verifies_binding_id: '901', created_by: 'su-reviewer',
      details: { verifiesBindingId: 999, createdBy: 'su-impostor' },
      observed_at: '2026-10-13T00:00:00Z', created_at: '2026-10-13T00:00:00Z',
      binding_fingerprint: 'binding',
    }];
    const [row] = await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] });
    expect(row.verifiesBindingId).toBe(901);
    expect(row.createdBy).toBe('su-reviewer');
    expect(h.queries.find(query => query.sql.includes('SELECT b.id'))?.sql).toContain('b.verifies_binding_id');
  });

  it('certifies fixture absence at the shared reader for a measured outside-lineage re-observation', async () => {
    const recipe = { schemaVersion: 1 as const, kind: 'repo-files' as const,
      sourcePaths: ['src/feature.ts'], testPaths: ['test/feature.test.ts'] };
    const measured = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    const execution = { schemaVersion: 1, root: measurementRoot, filePath: 'test/feature.test.ts',
      runGroupId: null, workspaceId: 'workspace-test', harnessSlug: 'papercusp',
      testNamePattern: null, passed: 1, failed: 0, skipped: 0, collectionFailed: false,
      testLayer: 'unit', passedCaseTitles: ['real repository subject'] };
    const source = {
      id: 901, work_item_id: 'WI-proof', plan_slug: 'plan-one', spec_id: 'SPEC-1',
      source_val_id: null, spec_revision: 1, current_revision: 1, spec_is_current: true,
      spec_fingerprint: 'spec', evidence_kind: 'test', evidence_ref: 'test/feature.test.ts',
      source_fingerprint: measured.sourceFingerprint, test_fingerprint: measured.testFingerprint,
      fixture_fingerprint: null, rubric_fingerprint: null, environment_fingerprint: null,
      coverage_evidence_ref: null, test_run_id: 43, test_run_present: true,
      test_run_status: 'pass', test_run_file_path: 'test/feature.test.ts',
      test_run_commit_sha: null, test_run_worktree_dirty: false, test_run_execution_details: execution,
      details: { currentMeasurement: recipe, evidencePlane: 'tree',
        adequacy: { fixtureFree: true, testCases: ['real repository subject'] } },
      created_by: 'su-implementer', binding_fingerprint: 'source-binding',
      observed_at: '2026-10-13T00:00:00Z', created_at: '2026-10-13T00:00:00Z',
    };
    h.rows = [source, { ...source, id: 902, evidence_kind: 'independent-verification',
      verifies_binding_id: 901, created_by: 'su-reviewer', binding_fingerprint: 'review-binding' }];
    const rows = await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] });
    expect(rows[0].currentness).toMatchObject({ overall: 'current', provenance: 'server-measured' });
    expect(rows[0].fixtureAbsenceVerification).toEqual({ verifierBindingIds: [902] });
    expect(rows[1].fixtureAbsenceVerification).toBeUndefined();
    expect(rows[1]).not.toHaveProperty('fixtureAbsenceVerification');
  });

  it('pins historical evidence reads to the explicitly supplied workspace', async () => {
    await listSpecEvidence({
      harnessSlug: 'papercusp',
      workspaceId: 'workspace-historical',
      planSlugs: ['plan-one'],
    });

    expect(h.planScopeOptions).toEqual([
      { harnessSlug: 'papercusp', workspaceId: 'workspace-historical' },
    ]);
    expect(h.workspaceScopes).toEqual(['workspace-historical']);
  });

  it('projects every structured failed identity over a one-line human tail, fenced to a failed mutation run (EI-25248905256718690)', async () => {
    h.rows = [{
      id: 1, work_item_id: 'WI-1', plan_slug: 'plan-one', spec_id: 'SPEC-1',
      spec_revision: 1, current_revision: 1, spec_fingerprint: 'spec', spec_is_current: true,
      evidence_kind: 'mutation', evidence_ref: 'mutant', details: {},
      source_fingerprint: null, test_fingerprint: null, fixture_fingerprint: null,
      rubric_fingerprint: null, environment_fingerprint: null, coverage_evidence_ref: null,
      test_run_id: 43, test_run_present: true, test_run_file_path: 'test/a.test.ts',
      test_run_commit_sha: 'abc', test_run_worktree_dirty: false,
      mutation_failure_tail: 'suite > failed with a long DOM error: expected false to be true',
      mutation_execution_details: {
        schemaVersion: 1, root: '/repo', filePath: 'test/a.test.ts', runGroupId: null,
        workspaceId: 'ws', harnessSlug: 'papercusp', testNamePattern: null,
        passed: 1, failed: 2, skipped: 0, collectionFailed: false, mutationPhase: 'mutant',
        commitSha: 'abc', worktreeDirty: false,
        failedCaseTitles: ['suite > failed with a long DOM error', 'suite > second failed case'],
      },
      observed_at: '2026-10-06T16:35:00.000Z', created_at: '2026-10-06T16:36:00.000Z',
    }];
    const [row] = await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] });
    expect(row.testRunProvenance?.mutationFailureLines).toEqual([
      'suite > failed with a long DOM error: (recorded failed assertion)',
      'suite > second failed case: (recorded failed assertion)',
    ]);
    expect(row.testRunProvenance?.mutationFailedCaseTitles).toEqual([
      'suite > failed with a long DOM error',
      'suite > second failed case',
    ]);
    const query = h.queries.find(query => query.sql.includes('SELECT b.id'))?.sql ?? '';
    expect(query).toContain("WHEN b.evidence_kind IN ('mutation', 'counterexample')");
    expect(query).toContain("AND tr.execution_details->>'mutationPhase' = 'mutant'");
  });

  it('projects canonical mutant provenance and failed cases for counterexample bindings', async () => {
    const caseTitle = 'suite > rejects a malformed request';
    const mutantDetails = {
      schemaVersion: 1,
      root: '/repo',
      filePath: 'test/a.test.ts',
      runGroupId: null,
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      testNamePattern: null,
      passed: 0,
      failed: 1,
      skipped: 0,
      collectionFailed: false,
      mutationPhase: 'mutant',
      commitSha: 'abc',
      worktreeDirty: false,
      failedCaseTitles: [caseTitle],
    };
    h.rows = [{
      id: 2, work_item_id: 'WI-2', plan_slug: 'plan-one', spec_id: 'SPEC-2',
      spec_revision: 1, current_revision: 1, spec_fingerprint: 'spec', spec_is_current: true,
      evidence_kind: 'counterexample', evidence_ref: 'counterexample:malformed-request', details: {},
      source_fingerprint: null, test_fingerprint: null, fixture_fingerprint: null,
      rubric_fingerprint: null, environment_fingerprint: null, coverage_evidence_ref: null,
      test_run_id: 47, test_run_present: true, test_run_file_path: 'test/a.test.ts',
      test_run_source: 'mutation-probe', test_run_status: 'fail',
      test_run_commit_sha: 'abc', test_run_worktree_dirty: false,
      test_run_execution_details: mutantDetails,
      mutation_failure_tail: null, mutation_execution_details: mutantDetails,
      observed_at: '2026-10-06T16:35:00.000Z', created_at: '2026-10-06T16:36:00.000Z',
    }];

    const [row] = await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] });

    expect(row.testRunProvenance).toMatchObject({
      source: 'mutation-probe',
      mutationPhase: 'mutant',
      mutationFailedCaseTitles: [caseTitle],
      mutationFailureLines: ['suite > rejects a malformed request: (recorded failed assertion)'],
    });
  });

  it('reads mutation descriptors and calibration from the scoped ledger rather than binder prose', async () => {
    const mutation = {
      schemaVersion: 1, probeInvocationId: 'invocation-001', leg: 'mutant', mode: 'copy-out',
      subjectPath: 'src/guard.ts', mutateExpression: 's/reject/accept/', againstCommit: null,
      subjectBeforeSha256: 'a'.repeat(64), subjectAfterSha256: 'b'.repeat(64),
      mutantDiff: '-reject\n+accept', mutantDiffTruncated: false,
      testCommandSha256: 'c'.repeat(64), testFileSha256: 'd'.repeat(64),
    };
    const execution = {
      schemaVersion: 1, root: '/repo', filePath: 'test/a.test.ts', runGroupId: null,
      workspaceId: 'ws', harnessSlug: 'papercusp', testNamePattern: null,
      passed: 0, failed: 1, skipped: 0, collectionFailed: false, mutationPhase: 'mutant',
      commitSha: 'e'.repeat(40), worktreeDirty: false, failedCaseTitles: ['guard > rejects'], mutation,
    };
    h.rows = [{
      id: 2, work_item_id: 'WI-2', plan_slug: 'plan-one', spec_id: 'SPEC-2',
      spec_revision: 1, current_revision: 1, spec_fingerprint: 'spec', spec_is_current: true,
      evidence_kind: 'mutation', evidence_ref: 'mutant', details: { mutation: { probeInvocationId: 'forged' } },
      source_fingerprint: null, test_fingerprint: null, fixture_fingerprint: null,
      rubric_fingerprint: null, environment_fingerprint: null, coverage_evidence_ref: null,
      test_run_id: 47, test_run_present: true, test_run_file_path: execution.filePath,
      test_run_source: 'mutation-probe', test_run_status: 'fail',
      test_run_commit_sha: execution.commitSha, test_run_worktree_dirty: false,
      test_run_execution_details: execution, mutation_execution_details: execution, mutation_failure_tail: null,
      mutation_baseline_id: 46, mutation_baseline_status: 'pass',
      mutation_baseline_execution_details: { ...execution, passed: 2, failed: 0,
        skipped: 39, passedCaseTitles: ['guard > rejects'], passedCaseTitlesTruncated: true,
        mutationPhase: 'baseline', failedCaseTitles: [], mutation: { ...mutation, leg: 'baseline' } },
      observed_at: '2026-10-11T16:35:00.000Z', created_at: '2026-10-11T16:36:00.000Z',
    }];
    const read = async () => (await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] }))[0];
    expect((await read()).testRunProvenance).toMatchObject({ mutation, mutationBaseline: {
      testRunId: 46, status: 'pass', passed: 2, failed: 0, mutation: { ...mutation, leg: 'baseline' },
      skipped: 39, passedCaseTitles: ['guard > rejects'], passedCaseTitlesIncomplete: true,
    } });
    h.rows[0].mutation_baseline_execution_details = { malformed: true };
    expect((await read()).testRunProvenance?.mutationBaseline).toBeNull();
    const query = h.queries.find(query => query.sql.includes('SELECT b.id'))?.sql ?? '';
    for (const fence of ['baseline.workspace_id = tr.workspace_id',
      'baseline.harness_slug = tr.harness_slug', 'baseline.file_path = tr.file_path',
      "baseline.source = 'mutation-probe'", "baseline.status = 'pass'",
      "baseline.execution_details->'mutation'->>'probeInvocationId'",
      "baseline.execution_details->'mutation'->>'subjectBeforeSha256'"]) expect(query).toContain(fence);
  });

  it('projects canonical test-run status, counts, passed titles, and runtime layer to the evaluator', async () => {
    h.rows = [{
      id: 2, work_item_id: 'WI-2', plan_slug: 'plan-one', spec_id: 'SPEC-2',
      spec_revision: 1, current_revision: 1, spec_fingerprint: 'spec', spec_is_current: true,
      evidence_kind: 'test', evidence_ref: 'test-run:44', details: {
        adequacy: {
          testLayer: 'integration',
          testCases: ['suite > exactly passed case'],
          pathReachable: true,
        },
      },
      source_fingerprint: null, test_fingerprint: null, fixture_fingerprint: null,
      rubric_fingerprint: null, environment_fingerprint: null, coverage_evidence_ref: null,
      test_run_id: 44, test_run_present: true, test_run_file_path: 'test/a.test.ts',
      test_run_commit_sha: 'abc123', test_run_worktree_dirty: false, test_run_status: 'pass',
      test_run_execution_details: {
        schemaVersion: 1, root: '/repo', filePath: 'test/a.test.ts', runGroupId: null,
        workspaceId: 'workspace-test', harnessSlug: 'papercusp', testNamePattern: null,
        passed: 2, failed: 0, skipped: 0, collectionFailed: false, mutationPhase: null,
        commitSha: 'abc123', worktreeDirty: false, testLayer: 'integration',
        passedCaseTitles: ['suite > exactly passed case', 'suite > another passed case'],
      },
      mutation_failure_tail: null, mutation_execution_details: null,
      observed_at: '2026-10-06T16:35:00.000Z', created_at: '2026-10-06T16:36:00.000Z',
    }];

    const [row] = await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] });
    expect(row.testRunExecution).toMatchObject({
      status: 'pass',
      passed: 2,
      failed: 0,
      skipped: 0,
      collectionFailed: false,
      testLayer: 'integration',
      passedCaseTitles: ['suite > exactly passed case', 'suite > another passed case'],
    });
    const query = h.queries.find(entry => entry.sql.includes('SELECT b.id'))?.sql ?? '';
    expect(query).toContain('tr.status AS test_run_status');
    expect(query).toContain('tr.execution_details AS test_run_execution_details');
    expect(query).toContain('tr.framework AS test_run_framework');
    expect(query).toContain('tr.source AS test_run_source');

    // The operational adapter is measured from canonical recording provenance;
    // changing a binder's layer alone cannot create it or relabel it as e2e.
    const original = h.rows[0];
    const { testLayer: _layer, ...execution } = original.test_run_execution_details as Record<string, unknown>;
    h.rows = [{ ...original, test_run_framework: 'operational', test_run_source: 'local',
      test_run_file_path: 'docs/evidence/check.json',
      test_run_execution_details: { ...execution, filePath: 'docs/evidence/check.json',
        runGroupId: `operational-recovery:41:${'a'.repeat(40)}` },
      details: { adequacy: { testLayer: 'e2e' } },
    }];
    const [operational] = await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] });
    expect(operational.testRunExecution).toMatchObject({ testLayer: 'operational',
      passedCaseTitles: ['suite > exactly passed case', 'suite > another passed case'] });
    expect(h.rows[0].test_run_execution_details).not.toHaveProperty('testLayer');

    h.rows[0].test_run_framework = 'node';
    const [unverified] = await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] });
    expect(unverified.testRunExecution).not.toHaveProperty('testLayer');

    h.rows[0].test_run_framework = 'operational';
    h.rows[0].test_run_execution_details = { ...(h.rows[0].test_run_execution_details as object), testLayer: 'integration' };
    const [explicit] = await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] });
    expect(explicit.testRunExecution?.testLayer).toBe('integration');
  });

  it('retains the canonical LLM scenario and executed file without manufacturing passed titles', async () => {
    const filePath = 'packages/operator-core/lib/llm-testing/scenarios/su/S38-reports-capture.ts';
    h.rows = [{
      id: 3, work_item_id: 'WI-3', plan_slug: 'plan-one', spec_id: 'SPEC-3',
      spec_revision: 1, current_revision: 1, spec_fingerprint: 'spec', spec_is_current: true,
      evidence_kind: 'test', evidence_ref: 'test-run:45', details: {},
      source_fingerprint: null, test_fingerprint: null, fixture_fingerprint: null,
      rubric_fingerprint: null, environment_fingerprint: null, coverage_evidence_ref: null,
      test_run_id: 45, test_run_present: true, test_run_file_path: filePath,
      test_run_framework: 'llm-test', test_run_commit_sha: 'abc123', test_run_worktree_dirty: false,
      test_run_status: 'pass', test_run_execution_details: {
        schemaVersion: 1, root: '/repo', filePath, runGroupId: null,
        workspaceId: 'workspace-test', harnessSlug: 'papercusp', testNamePattern: null,
        scenarioId: 'su-S38-reports-capture', testLayer: 'llm',
        passed: 1, failed: 0, skipped: 0, collectionFailed: false, mutationPhase: null,
        commitSha: 'abc123', worktreeDirty: false,
      },
      mutation_failure_tail: null, mutation_execution_details: null,
      observed_at: '2026-10-08T11:00:00.000Z', created_at: '2026-10-08T11:01:00.000Z',
    }];
    const [row] = await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] });
    expect(row.testRunProvenance).toMatchObject({ framework: 'llm-test', filePath });
    expect(row.testRunExecution).toMatchObject({ scenarioId: 'su-S38-reports-capture', filePath, testLayer: 'llm' });
    expect(row.testRunExecution).not.toHaveProperty('passedCaseTitles');

    h.rows[0].test_run_execution_details = { ...(h.rows[0].test_run_execution_details as object), scenarioId: '' };
    const [invalid] = await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] });
    expect(invalid.testRunExecution).toBeNull();
  });

  it('accepts PostgreSQL timestamp strings instead of assuming Date instances', async () => {
    h.rows = [
      {
        id: 1,
        work_item_id: 'WI-1',
        plan_slug: 'plan-one',
        spec_id: 'SPEC-001-01',
        source_val_id: 'VAL-001-01',
        spec_revision: 1,
        current_revision: 1,
        spec_fingerprint: 'sha256:spec',
        evidence_kind: 'test',
        evidence_ref: 'vitest:one',
        source_fingerprint: 'git:one',
        test_fingerprint: 'sha256:test',
        fixture_fingerprint: null,
        rubric_fingerprint: null,
        environment_fingerprint: null,
        coverage_evidence_ref: null,
        coverage_evidence_present: false,
        test_run_id: null,
        test_run_present: false,
        details: {},
        observed_at: '2026-08-20 17:10:00-04',
        binding_fingerprint: 'sha256:binding',
        created_by: 'su-test',
        created_at: '2026-08-20T21:10:01.000Z',
        spec_is_current: true,
      },
    ];

    const [row] = await listSpecEvidence({
      harnessSlug: 'papercusp',
      planSlugs: ['plan-one'],
      current: [
        {
          evidenceKind: 'test',
          evidenceRef: 'vitest:one',
          sourceFingerprint: 'git:one',
          testFingerprint: 'sha256:test',
        },
      ],
    });

    expect(row).toMatchObject({
      observedAt: '2026-08-20T21:10:00.000Z',
      createdAt: '2026-08-20T21:10:01.000Z',
      currentness: {
        overall: 'unknown',
        provenance: 'attested-current',
        unknownReasons: ['current-fingerprints-attested-not-independently-measured'],
      },
    });
    expect(row).not.toHaveProperty('withdrawal');
    h.rows[0] = { ...h.rows[0], retracted_at: '2026-08-20 17:12:00-04',
      retracted_by: 'su-reviewer', retraction_reason: 'Withdrawn pending attempt without a result.' };
    const [withdrawn] = await listSpecEvidence({ harnessSlug: 'papercusp',
      planSlugs: ['plan-one'], includeRetracted: true });
    expect(withdrawn).toMatchObject({ withdrawal: {
      at: '2026-08-20T21:12:00.000Z', by: 'su-reviewer',
      reason: 'Withdrawn pending attempt without a result.',
    } });
  });

  it('keeps a kind=fixture binding without a stored fixture baseline unknown', async () => {
    const recipe = {
      schemaVersion: 1 as const,
      kind: 'repo-files' as const,
      sourcePaths: ['src/feature.ts'],
      testPaths: ['test/feature.test.ts'],
    };
    const measured = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    h.rows = [{
      id: 55,
      work_item_id: 'WI-fixture',
      plan_slug: 'plan-one',
      spec_id: 'SPEC-fixture',
      source_val_id: null,
      spec_revision: 1,
      current_revision: 1,
      spec_fingerprint: 'sha256:spec-fixture',
      evidence_kind: 'fixture',
      evidence_ref: 'fixture:legacy-wiremock',
      source_fingerprint: measured.sourceFingerprint,
      test_fingerprint: measured.testFingerprint,
      fixture_fingerprint: null,
      rubric_fingerprint: null,
      environment_fingerprint: null,
      coverage_evidence_ref: null,
      coverage_evidence_present: false,
      test_run_id: null,
      test_run_present: false,
      details: { currentMeasurement: recipe },
      observed_at: '2026-08-20T21:10:00.000Z',
      binding_fingerprint: 'sha256:fixture-binding',
      created_by: 'su-test',
      created_at: '2026-08-20T21:10:01.000Z',
      spec_is_current: true,
    }];

    const [row] = await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] });

    expect(row.currentness).toMatchObject({
      overall: 'unknown',
      dimensions: { source: 'current', test: 'current', fixture: 'unknown' },
      unknownReasons: ['fixture-current-fingerprint-not-supplied'],
    });
  });

  it('marks fixture calibration stale when a measured server fixture source changes', async () => {
    const fixturePath = 'fixture/runtime-envelope.ts';
    await mkdir(join(measurementRoot, 'fixture'), { recursive: true });
    await writeFile(join(measurementRoot, fixturePath), 'export const voicePort: number | null = 8080;\n');
    const recipe = {
      schemaVersion: 1 as const,
      kind: 'repo-files' as const,
      sourcePaths: ['src/feature.ts'],
      testPaths: ['test/feature.test.ts'],
      fixturePaths: [fixturePath],
    };
    const pinned = await measureAndPinRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    h.rows = [{
      id: 56,
      work_item_id: 'WI-fixture-current',
      plan_slug: 'plan-one',
      spec_id: 'SPEC-fixture-current',
      source_val_id: null,
      spec_revision: 1,
      current_revision: 1,
      spec_fingerprint: 'sha256:spec-fixture-current',
      evidence_kind: 'fixture',
      evidence_ref: 'fixture:wiremock',
      source_fingerprint: pinned.sourceFingerprint,
      test_fingerprint: pinned.testFingerprint,
      fixture_fingerprint: pinned.fixtureFingerprint,
      rubric_fingerprint: null,
      environment_fingerprint: null,
      coverage_evidence_ref: null,
      coverage_evidence_present: false,
      test_run_id: null,
      test_run_present: false,
      details: { currentMeasurement: recipe, measurementPin: pinned.pin },
      observed_at: '2026-08-20T21:10:00.000Z',
      binding_fingerprint: 'sha256:fixture-current-binding',
      created_by: 'su-test',
      created_at: '2026-08-20T21:10:01.000Z',
      spec_is_current: true,
    }];

    const [current] = await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] });
    expect(current.currentness).toMatchObject({
      overall: 'current',
      dimensions: { fixture: 'current' },
    });

    await writeFile(join(measurementRoot, fixturePath), 'export const voicePort: number | null = null;\n');
    const [stale] = await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] });
    expect(stale.currentness).toMatchObject({
      overall: 'stale',
      dimensions: { fixture: 'stale' },
      staleReasons: ['fixture-stale'],
    });
    expect(stale).toHaveProperty('serverMeasurement.movedPaths', expect.arrayContaining([
      expect.objectContaining({ path: fixturePath, dimension: 'fixture', change: 'changed' }),
    ]));
  });

  it('preserves the default harness identity when diffing fixture files against a pinned measurement', async () => {
    const fixturePath = 'fixture/root-identity.ts';
    await mkdir(join(measurementRoot, 'fixture'), { recursive: true });
    await writeFile(join(measurementRoot, fixturePath), 'export const fixtureVersion = 1;\n');
    const recipe = {
      schemaVersion: 1 as const,
      kind: 'repo-files' as const,
      sourcePaths: ['src/feature.ts'],
      testPaths: ['test/feature.test.ts'],
      fixturePaths: [fixturePath],
    };
    try {
      const pinned = await measureAndPinRepoFilesEvidenceAtRoot(measurementRoot, recipe, {
        fixtureRootHarnessSlug: 'papercusp',
      });
      expect(pinned.pin.files).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: fixturePath, dimension: 'fixture', rootHarnessSlug: 'papercusp' }),
      ]));
      await writeFile(join(measurementRoot, fixturePath), 'export const fixtureVersion = 2;\n');
      h.rows = [{
        id: 57,
        work_item_id: 'WI-fixture-root-identity',
        plan_slug: 'plan-one',
        spec_id: 'SPEC-fixture-root-identity',
        source_val_id: null,
        spec_revision: 1,
        current_revision: 1,
        spec_fingerprint: 'sha256:spec-fixture-root-identity',
        evidence_kind: 'test',
        evidence_ref: 'vitest:fixture-root-identity',
        source_fingerprint: pinned.sourceFingerprint,
        test_fingerprint: pinned.testFingerprint,
        fixture_fingerprint: pinned.fixtureFingerprint,
        rubric_fingerprint: null,
        environment_fingerprint: null,
        coverage_evidence_ref: null,
        coverage_evidence_present: false,
        test_run_id: null,
        test_run_present: false,
        details: { currentMeasurement: recipe, measurementPin: pinned.pin },
        observed_at: '2026-08-20T21:10:00.000Z',
        binding_fingerprint: 'sha256:fixture-root-identity-binding',
        created_by: 'su-test',
        created_at: '2026-08-20T21:10:01.000Z',
        spec_is_current: true,
      }];

      const [stale] = await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] });
      expect(stale.currentness).toMatchObject({
        overall: 'stale',
        dimensions: { fixture: 'stale' },
        staleReasons: ['fixture-stale'],
      });
      expect(stale).toHaveProperty('serverMeasurement.movedPaths', [
        { path: fixturePath, dimension: 'fixture', rootHarnessSlug: 'papercusp', change: 'changed' },
      ]);
    } finally {
      await rm(join(measurementRoot, fixturePath), { force: true });
    }
  });

  it('matches scoped currentness by clause identity when two specs share one artifact reference', async () => {
    const shared = {
      work_item_id: 'WI-shared-proof',
      plan_slug: 'plan-one',
      source_val_id: null,
      spec_revision: 1,
      evidence_kind: 'test' as const,
      evidence_ref: 'artifact:shared-index',
      test_fingerprint: null,
      fixture_fingerprint: null,
      rubric_fingerprint: null,
      environment_fingerprint: null,
      coverage_evidence_ref: null,
      coverage_evidence_present: false,
      test_run_id: null,
      test_run_present: false,
      details: {},
      observed_at: '2026-08-20T21:10:00.000Z',
      binding_fingerprint: 'sha256:binding',
      created_by: 'su-test',
      created_at: '2026-08-20T21:10:01.000Z',
      spec_is_current: true,
    };
    h.rows = [
      {
        ...shared,
        id: 10,
        spec_id: 'SPEC-A',
        spec_fingerprint: 'sha256:spec-a',
        source_fingerprint: 'git:source-a',
      },
      {
        ...shared,
        id: 11,
        spec_id: 'SPEC-B',
        spec_fingerprint: 'sha256:spec-b',
        source_fingerprint: 'git:source-b',
      },
    ];

    const rows = await listSpecEvidence({
      harnessSlug: 'papercusp',
      planSlugs: ['plan-one'],
      current: [
        {
          planSlug: 'plan-one',
          specId: 'SPEC-A',
          specRevision: 1,
          specFingerprint: 'sha256:spec-a',
          evidenceKind: 'test',
          evidenceRef: 'artifact:shared-index',
          sourceFingerprint: 'git:source-a',
        },
        {
          planSlug: 'plan-one',
          specId: 'SPEC-B',
          specRevision: 1,
          specFingerprint: 'sha256:spec-b',
          evidenceKind: 'test',
          evidenceRef: 'artifact:shared-index',
          sourceFingerprint: 'git:source-b',
        },
      ],
    });

    expect(rows).toHaveLength(2);
    // Equality with caller-supplied fingerprints is deliberately reported as
    // attested-current/unknown at the aggregate level. Assert the per-row
    // source dimension as well: that is the signal which proves the scoped
    // identity selected SPEC-A's tuple instead of SPEC-B's last-writer value.
    expect(rows.map((row) => ({
      specId: row.specId,
      overall: row.currentness.overall,
      source: row.currentness.dimensions.source,
      provenance: row.currentness.provenance,
      comparisonSupplied: row.currentness.comparisonSupplied,
    }))).toEqual([
      {
        specId: 'SPEC-A',
        overall: 'unknown',
        source: 'current',
        provenance: 'attested-current',
        comparisonSupplied: true,
      },
      {
        specId: 'SPEC-B',
        overall: 'unknown',
        source: 'current',
        provenance: 'attested-current',
        comparisonSupplied: true,
      },
    ]);
  });

  it('replays a pinned server-measured snapshot without reading the live repository', async () => {
    h.rows = [
      {
        id: 3,
        work_item_id: 'WI-3',
        plan_slug: 'plan-one',
        spec_id: 'SPEC-001-01',
        source_val_id: 'VAL-001-01',
        spec_revision: 1,
        current_revision: 2,
        spec_fingerprint: 'sha256:spec-v1',
        evidence_kind: 'test',
        evidence_ref: 'vitest:replay',
        source_fingerprint: 'git:graded',
        test_fingerprint: 'sha256:test-graded',
        fixture_fingerprint: null,
        rubric_fingerprint: null,
        environment_fingerprint: null,
        coverage_evidence_ref: null,
        coverage_evidence_present: false,
        test_run_id: null,
        test_run_present: false,
        details: {
          currentMeasurement: {
            schemaVersion: 1,
            kind: 'repo-files',
            sourcePaths: ['src/feature.ts'],
            testPaths: ['test/feature.test.ts'],
          },
        },
        observed_at: '2026-08-20 17:10:00-04',
        binding_fingerprint: 'sha256:binding',
        created_by: 'su-test',
        created_at: '2026-08-20T21:10:01.000Z',
        spec_is_current: true,
      },
    ];

    const [row] = await listSpecEvidence({
      harnessSlug: 'papercusp',
      planSlugs: ['plan-one'],
      specRevision: 1,
      specFingerprint: 'sha256:spec-v1',
      replaySnapshot: true,
      currentProvenance: 'server-measured',
      current: [
        {
          evidenceKind: 'test',
          evidenceRef: 'vitest:replay',
          sourceFingerprint: 'git:graded',
          testFingerprint: 'sha256:test-graded',
        },
      ],
    });

    expect(row).toMatchObject({
      specRevision: 1,
      currentRevision: 2,
      specFingerprint: 'sha256:spec-v1',
      currentness: {
        overall: 'current',
        provenance: 'server-measured',
        staleReasons: [],
        unknownReasons: [],
      },
    });
    expect(row).not.toHaveProperty('serverMeasurement');
  });

  // RECURRENCE GUARD (WI-10002320), MATCHED SET with the test above. `rerunRecipeFor`
  // ALWAYS emits `replaySnapshot: true`, so while that flag alone suppressed the
  // per-binding server measurement, scorecards:emit was structurally unable to certify
  // freshness='pass' on ANY card: the replay could not reproduce the very verdict it
  // replayed, and the classifier — seeing nothing but caller-authored fingerprints —
  // capped the criterion at 'unknown' precisely BECAUSE nothing was stale.
  //
  // Only `replaySnapshot` AND the explicit `currentProvenance: 'server-measured'` opt-out
  // may suppress measurement. The first guard below is the zero-delta control: the row and
  // the caller tuple are byte-identical to the opt-out test above, and ONLY the opt-out is
  // removed — so a regression that reinstates the unconditional suppression drops
  // `serverMeasurement` and fails here, with no second variable to blame it on.
  it('measures a pinned replay that does not opt out — replaySnapshot alone must not suppress measurement', async () => {
    h.rows = [
      {
        id: 3,
        work_item_id: 'WI-3',
        plan_slug: 'plan-one',
        spec_id: 'SPEC-001-01',
        source_val_id: 'VAL-001-01',
        spec_revision: 1,
        current_revision: 2,
        spec_fingerprint: 'sha256:spec-v1',
        evidence_kind: 'test',
        evidence_ref: 'vitest:replay',
        source_fingerprint: 'git:graded',
        test_fingerprint: 'sha256:test-graded',
        fixture_fingerprint: null,
        rubric_fingerprint: null,
        environment_fingerprint: null,
        coverage_evidence_ref: null,
        coverage_evidence_present: false,
        test_run_id: null,
        test_run_present: false,
        details: {
          currentMeasurement: {
            schemaVersion: 1,
            kind: 'repo-files',
            sourcePaths: ['src/feature.ts'],
            testPaths: ['test/feature.test.ts'],
          },
        },
        observed_at: '2026-08-20 17:10:00-04',
        binding_fingerprint: 'sha256:binding',
        created_by: 'su-test',
        created_at: '2026-08-20T21:10:01.000Z',
        spec_is_current: true,
      },
    ];

    const [row] = await listSpecEvidence({
      harnessSlug: 'papercusp',
      planSlugs: ['plan-one'],
      specRevision: 1,
      specFingerprint: 'sha256:spec-v1',
      replaySnapshot: true,
      // NO currentProvenance opt-out — that single omission is the whole delta.
      current: [
        {
          evidenceKind: 'test',
          evidenceRef: 'vitest:replay',
          sourceFingerprint: 'git:graded',
          testFingerprint: 'sha256:test-graded',
        },
      ],
    });

    expect(row).toHaveProperty('serverMeasurement.status', 'measured');
    // The stored fingerprints are placeholders, so a REAL measurement of the fixture root
    // cannot match them: 'stale' here is positive evidence that the server re-derived the
    // tuple rather than echoing the caller's.
    expect(row).toMatchObject({ currentness: { overall: 'stale' } });
  });

  // The positive half of the same defect: a replay must be able to reach 'current' with
  // server-grade provenance, or no card can ever certify freshness='pass'. Calibration: the
  // row's stored fingerprints are taken FROM a real measurement of the fixture root, so
  // 'current' here means the server re-derived them — not that a caller tuple was laundered
  // (the sibling guard at the top of this file pins that laundering shut independently).
  it('lets a measured replay reach current with server provenance — this is what makes freshness certifiable', async () => {
    const recipe = {
      schemaVersion: 1 as const,
      kind: 'repo-files' as const,
      sourcePaths: ['src/feature.ts'],
      testPaths: ['test/feature.test.ts'],
    };
    // Derived at run time on purpose: an earlier test in this file rewrites src/feature.ts,
    // so a hardcoded digest would bind this guard to test ordering.
    const measured = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);

    h.rows = [
      {
        id: 3,
        work_item_id: 'WI-3',
        plan_slug: 'plan-one',
        spec_id: 'SPEC-001-01',
        source_val_id: 'VAL-001-01',
        spec_revision: 1,
        current_revision: 2,
        spec_fingerprint: 'sha256:spec-v1',
        evidence_kind: 'test',
        evidence_ref: 'vitest:replay',
        source_fingerprint: measured.sourceFingerprint,
        test_fingerprint: measured.testFingerprint,
        fixture_fingerprint: null,
        rubric_fingerprint: null,
        environment_fingerprint: null,
        coverage_evidence_ref: null,
        coverage_evidence_present: false,
        test_run_id: null,
        test_run_present: false,
        details: { currentMeasurement: recipe },
        observed_at: '2026-08-20 17:10:00-04',
        binding_fingerprint: 'sha256:binding',
        created_by: 'su-test',
        created_at: '2026-08-20T21:10:01.000Z',
        spec_is_current: true,
      },
    ];

    const [row] = await listSpecEvidence({
      harnessSlug: 'papercusp',
      planSlugs: ['plan-one'],
      specRevision: 1,
      specFingerprint: 'sha256:spec-v1',
      replaySnapshot: true,
      current: [
        {
          evidenceKind: 'test',
          evidenceRef: 'vitest:replay',
          sourceFingerprint: measured.sourceFingerprint,
          testFingerprint: measured.testFingerprint,
        },
      ],
    });

    expect(row).toHaveProperty('serverMeasurement.status', 'measured');
    // source + test are never counted as attested, so a clean re-measurement yields
    // 'server-measured' rather than the capped 'partially-server-measured'.
    expect(row).not.toHaveProperty('serverMeasurement.attestedDimensions');
    expect(row).toMatchObject({
      currentness: {
        overall: 'current',
        provenance: 'server-measured',
        staleReasons: [],
        unknownReasons: [],
      },
    });
  });

  // R-2 / P-002 (acceptance-plan-verification-friction-reduction-2026-10-11, plan D-001):
  // the ship path hands the store NO caller `current`, so these read exactly that way.
  // Each test pins one drift marker of R-2: unchanged proof must rate current, moved
  // proof must not, and a failed re-measurement must say so instead of rating current.
  describe('R-2 server-measured currentness without caller fingerprints (P-002)', () => {
    const boundRow = (
      recipe: Record<string, unknown>,
      fingerprints: { source: string | null; test: string | null },
    ) => ({
      id: 4,
      work_item_id: 'WI-4',
      plan_slug: 'plan-one',
      spec_id: 'SPEC-001-01',
      source_val_id: 'VAL-001-01',
      spec_revision: 1,
      current_revision: 1,
      spec_fingerprint: 'sha256:spec-v1',
      evidence_kind: 'test',
      evidence_ref: 'vitest:p002',
      source_fingerprint: fingerprints.source,
      test_fingerprint: fingerprints.test,
      fixture_fingerprint: null,
      rubric_fingerprint: null,
      environment_fingerprint: null,
      coverage_evidence_ref: null,
      coverage_evidence_present: false,
      test_run_id: null,
      test_run_present: false,
      details: { currentMeasurement: recipe },
      observed_at: '2026-10-11 11:00:00-04',
      binding_fingerprint: 'sha256:binding-p002',
      created_by: 'su-test',
      created_at: '2026-10-11T15:00:01.000Z',
      spec_is_current: true,
    });
    const recipe = {
      schemaVersion: 1 as const,
      kind: 'repo-files' as const,
      sourcePaths: ['src/feature.ts'],
      testPaths: ['test/feature.test.ts'],
    };
    const readWithoutCallerCurrent = async (current?: boolean) => {
      const [row] = await listSpecEvidence({
        harnessSlug: 'papercusp',
        planSlugs: ['plan-one'],
        specRevision: 1,
        specFingerprint: 'sha256:spec-v1',
        ...(current === undefined ? {} : { current }),
      });
      return row;
    };

    it('rates an unchanged measured binding current with server provenance when no caller fingerprints are supplied', async () => {
      const measured = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
      h.rows = [boundRow(recipe, { source: measured.sourceFingerprint, test: measured.testFingerprint })];

      const row = await readWithoutCallerCurrent();

      expect(row).toHaveProperty('serverMeasurement.status', 'measured');
      expect(row).toMatchObject({
        currentness: { overall: 'current', provenance: 'server-measured', staleReasons: [], unknownReasons: [] },
      });
    });

    it('rates a measured binding stale when its source moved since binding and no caller fingerprints are supplied', async () => {
      const measured = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
      h.rows = [boundRow(recipe, { source: 'sha256:source-at-binding-time', test: measured.testFingerprint })];

      const row = await readWithoutCallerCurrent();

      expect(row).toHaveProperty('serverMeasurement.status', 'measured');
      expect(row?.currentness.overall).toBe('stale');
      expect(row?.currentness.staleReasons).toContain('source-stale');
    });

    it('names server-measurement-unavailable instead of rating current when the server cannot re-measure', async () => {
      const unmeasurable = { ...recipe, sourcePaths: ['src/p002-absent-source.ts'] };
      const measured = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
      h.rows = [boundRow(unmeasurable, { source: measured.sourceFingerprint, test: measured.testFingerprint })];

      const row = await readWithoutCallerCurrent();

      expect(row?.currentness.overall).not.toBe('current');
      expect(row?.currentness.unknownReasons).toEqual(
        expect.arrayContaining([expect.stringMatching(/^server-measurement-unavailable:.+/)]),
      );
    });

    it('records separate registry, filesystem, and commit maxima for root-resolution outliers', async () => {
      const measured = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
      h.rows = [boundRow(recipe, { source: measured.sourceFingerprint, test: measured.testFingerprint })];
      const diagnostics: ListSpecEvidenceDiagnostics = {
        phaseMs: {},
        bindings: {
          selectedRows: 0,
          rowsWithRecipe: 0,
          measured: 0,
          unavailable: 0,
          skipped: 0,
          totalMeasurementMs: 0,
          maxMeasurementMs: 0,
        },
      };

      await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'], diagnostics });

      expect(diagnostics.phaseMs).toEqual(expect.objectContaining({
        resolveMeasurementRootsAndCommits: expect.any(Number),
        measurementRootRegistryLookupMaxMs: expect.any(Number),
        measurementRootRealpathMaxMs: expect.any(Number),
        measurementCommitResolutionMaxMs: expect.any(Number),
      }));
    });

    it.each([true, false])('boolean current=%s preserves independent measurement for current, moved and unavailable sources', async (current) => {
      const measured = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
      for (const state of ['unchanged', 'moved', 'unavailable'] as const) {
        h.rows = [boundRow(
          state === 'unavailable' ? { ...recipe, sourcePaths: ['src/p009-absent-source.ts'] } : recipe,
          { source: state === 'moved' ? 'sha256:source-at-binding-time' : measured.sourceFingerprint, test: measured.testFingerprint },
        )];
        const omitted = await readWithoutCallerCurrent();
        const aliased = await readWithoutCallerCurrent(current);
        expect(aliased?.currentness).toEqual(omitted?.currentness);
        expect(aliased?.currentness.overall).toBe(state === 'unchanged' ? 'current' : state === 'moved' ? 'stale' : 'unknown');
        expect(aliased?.serverMeasurement?.status).toBe(state === 'unavailable' ? 'unavailable' : 'measured');
        if (state === 'unchanged') expect(aliased?.currentness.provenance).toBe('server-measured');
        if (state === 'moved') expect(aliased?.currentness.staleReasons).toContain('source-stale');
        if (state === 'unavailable') expect(aliased?.currentness.unknownReasons).toEqual(expect.arrayContaining([expect.stringMatching(/^server-measurement-unavailable:/)]));
      }
    });
  });

  it('pins a multi-clause replay by each row’s full clause identity', async () => {
    const current = [
      {
        planSlug: 'plan-one',
        specId: 'SPEC-001-01',
        specRevision: 1,
        specFingerprint: 'sha256:spec-v1',
        evidenceKind: 'test' as const,
        evidenceRef: 'vitest:one',
        sourceFingerprint: 'git:one',
        testFingerprint: 'sha256:test-one',
      },
      {
        planSlug: 'plan-two',
        specId: 'SPEC-002-01',
        specRevision: 4,
        specFingerprint: 'sha256:spec-v4',
        evidenceKind: 'test' as const,
        evidenceRef: 'vitest:two',
        sourceFingerprint: 'git:two',
        testFingerprint: 'sha256:test-two',
      },
    ];

    await listSpecEvidence({
      harnessSlug: 'papercusp',
      planSlugs: ['plan-one', 'plan-two'],
      specIds: ['SPEC-001-01', 'SPEC-002-01'],
      replaySnapshot: true,
      current,
    });

    const pinQuery = h.queries.find(({ sql }) => sql.includes('unnest('));
    expect(pinQuery?.sql).toContain('requested.plan_slug = b.plan_slug');
    expect(pinQuery?.sql).toContain('requested.spec_id = b.spec_id');
    expect(pinQuery?.sql).toContain('requested.spec_revision = b.spec_revision');
    expect(pinQuery?.sql).toContain('requested.spec_fingerprint = b.spec_fingerprint');
    expect(pinQuery?.values).toEqual([
      ['plan-one', 'plan-two'],
      ['SPEC-001-01', 'SPEC-002-01'],
      [1, 4],
      ['sha256:spec-v1', 'sha256:spec-v4'],
    ]);
  });

  it('restricts a pinned replay to the exact persisted binding ids', async () => {
    await listSpecEvidence({
      harnessSlug: 'papercusp',
      planSlugs: ['plan-one'],
      specIds: ['SPEC-001-01'],
      specRevision: 1,
      specFingerprint: 'sha256:spec-v1',
      replaySnapshot: true,
      evidenceRefs: ['vitest:shared-ref'],
      bindingIds: [18874, 18875, 18924],
    });

    const query = h.queries.find(({ sql }) => sql.includes('b.id = ANY('));
    expect(query?.sql).toContain('b.id = ANY(');
    expect(query?.values).toContainEqual([18874, 18875, 18924]);
  });

  it('keeps an explicitly empty binding-id replay empty', async () => {
    await listSpecEvidence({
      harnessSlug: 'papercusp',
      planSlugs: ['plan-one'],
      specIds: ['SPEC-001-01'],
      specRevision: 1,
      specFingerprint: 'sha256:spec-v1',
      replaySnapshot: true,
      bindingIds: [],
    });

    const query = h.queries.find(({ sql }) => sql.includes('b.id = ANY('));
    expect(query?.sql).toContain('b.id = ANY(');
    expect(query?.values).toContainEqual([]);
  });

  it('limits withdrawn-binding audits to their as-of time while the ordinary read still excludes withdrawals', async () => {
    const auditAsOf = new Date('2026-10-02T00:14:36.135Z');
    const selectors = {
      harnessSlug: 'papercusp',
      planSlugs: ['plan-one'],
      specIds: ['SPEC-001-01'],
      specRevision: 1,
      specFingerprint: 'sha256:spec-v1',
      replaySnapshot: true,
      evidenceRefs: ['vitest:shared-ref'],
    };

    await listSpecEvidence({
      ...selectors,
      includeRetracted: true,
      auditAsOf,
    });
    const auditQuery = h.queries.find(({ sql }) => sql.includes('b.created_at <='));
    expect(auditQuery?.sql).toContain('b.created_at <=');
    expect(auditQuery?.sql).toContain('b.retracted_at IS NULL OR b.retracted_at >');
    expect(auditQuery?.values).toContain(auditAsOf);
    expect(auditQuery?.values).toContain(true);

    await listSpecEvidence(selectors);
    const currentQuery = h.queries.filter(({ sql }) => sql.includes('FROM harness_shared.spec_evidence_bindings')).at(-1);
    expect(currentQuery?.sql).toContain('b.retracted_at IS NULL');
    expect(currentQuery?.values).toContain(false);
  });

  it('replays the exact withdrawn binding with its emission-time fingerprints after live source drift', async () => {
    const auditAsOf = new Date('2026-10-02T00:14:36.135Z');
    const sourcePath = 'src/historical-replay.ts';
    const recipe = {
      schemaVersion: 1 as const,
      kind: 'repo-files' as const,
      sourcePaths: [sourcePath],
      testPaths: ['test/feature.test.ts'],
    };
    const sourceFile = join(measurementRoot, sourcePath);
    await writeFile(sourceFile, 'export const value = 1;\n');
    try {
      const emission = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
      await writeFile(sourceFile, 'export const value = 2;\n');
      const live = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
      expect(live.sourceFingerprint).not.toBe(emission.sourceFingerprint);

      h.rows = [{
        id: 19999,
        work_item_id: 'WI-3',
        plan_slug: 'plan-one',
        spec_id: 'SPEC-001-01',
        source_val_id: 'VAL-001-01',
        spec_revision: 1,
        current_revision: 2,
        spec_fingerprint: 'sha256:spec-v1',
        evidence_kind: 'test',
        evidence_ref: 'vitest:historical-replay',
        source_fingerprint: emission.sourceFingerprint,
        test_fingerprint: emission.testFingerprint,
        fixture_fingerprint: null,
        rubric_fingerprint: null,
        environment_fingerprint: null,
        coverage_evidence_ref: null,
        coverage_evidence_present: false,
        test_run_id: null,
        test_run_present: false,
        details: { currentMeasurement: recipe },
        observed_at: '2026-10-01T23:00:00.000Z',
        binding_fingerprint: 'sha256:binding-19999',
        created_by: 'su-test',
        created_at: '2026-10-01T23:00:00.000Z',
        retracted_at: '2026-10-02T01:00:00.000Z',
        retracted_by: 'su-reviewer',
        retraction_reason: 'superseded by binding 21019',
        spec_is_current: true,
      }];

      const current = [{
        planSlug: 'plan-one',
        specId: 'SPEC-001-01',
        specRevision: 1,
        specFingerprint: 'sha256:spec-v1',
        evidenceKind: 'test' as const,
        evidenceRef: 'vitest:historical-replay',
        sourceFingerprint: emission.sourceFingerprint,
        testFingerprint: emission.testFingerprint,
      }];
      const [row] = await listSpecEvidence({
        harnessSlug: 'papercusp',
        planSlugs: ['plan-one'],
        specIds: ['SPEC-001-01'],
        specRevision: 1,
        specFingerprint: 'sha256:spec-v1',
        replaySnapshot: true,
        evidenceRefs: ['vitest:historical-replay'],
        bindingIds: [19999],
        currentProvenance: 'historical-snapshot',
        current,
        includeRetracted: true,
        auditAsOf,
      });

      expect(row).toMatchObject({
        id: 19999,
        withdrawal: { reason: 'superseded by binding 21019' },
        fingerprints: { sourceFingerprint: emission.sourceFingerprint },
        currentness: {
          overall: 'current',
          provenance: 'historical-snapshot',
          dimensions: { source: 'current', test: 'current' },
        },
      });
      expect(row).not.toHaveProperty('serverMeasurement');
      const bindingQuery = h.queries.find(({ sql }) => sql.includes('b.id = ANY('));
      const auditQuery = h.queries.find(({ sql }) => sql.includes('b.created_at <='));
      expect(bindingQuery?.values).toContainEqual([19999]);
      expect(auditQuery?.values).toContain(auditAsOf);
    } finally {
      await rm(sourceFile, { force: true });
    }
  });

  it('refuses an audit-as-of cutoff without explicit withdrawn-row visibility', async () => {
    await expect(
      listSpecEvidence({
        harnessSlug: 'papercusp',
        planSlugs: ['plan-one'],
        includeRetracted: false,
        auditAsOf: new Date('2026-10-02T00:14:36.135Z'),
      }),
    ).rejects.toThrow('auditAsOf requires includeRetracted:true');
  });

  it('surfaces provisional scorecard proof bases on the returned binding row', async () => {
    h.rows = [
      {
        id: 2,
        work_item_id: 'WI-2',
        plan_slug: 'plan-one',
        spec_id: 'SPEC-001-01',
        source_val_id: 'VAL-001-01',
        spec_revision: 1,
        current_revision: 1,
        spec_fingerprint: 'sha256:spec',
        evidence_kind: 'manual',
        evidence_ref: 'scorecard:EI-123#matched-window',
        source_fingerprint: 'git:one',
        test_fingerprint: null,
        fixture_fingerprint: null,
        rubric_fingerprint: null,
        environment_fingerprint: null,
        coverage_evidence_ref: null,
        coverage_evidence_present: false,
        test_run_id: null,
        test_run_present: false,
        details: { adequacy: { collected: true } },
        observed_at: '2026-08-20 17:10:00-04',
        binding_fingerprint: 'sha256:binding',
        created_by: 'su-test',
        created_at: '2026-08-20T21:10:01.000Z',
        spec_is_current: true,
      },
    ];
    h.scorecardRows = [
      {
        feature_id: 'EI-123',
        provisional: {
          stampedAt: '2026-08-20T17:09:00.000Z',
          violatableKeys: ['criterion-a'],
        },
      },
    ];

    const [row] = await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] });

    expect(row).toMatchObject({
      provisionalProofBase: true,
      provisionalScorecard: {
        issueId: 'EI-123',
        stampedAt: '2026-08-20T17:09:00.000Z',
        violatableKeys: ['criterion-a'],
      },
      details: {
        provisionalProofBase: true,
        provisionalScorecard: { issueId: 'EI-123' },
      },
    });
  });
});

// RECURRENCE GUARD (WI-10002087). `source` currentness used to have exactly ONE basis — a repo
// file-set hash — so a binding whose SUBJECT was not a file set could never reach
// `source:'current'` and every non-code plan outcome was unshippable. The fix adds a ledger-state
// basis. These tests pin the property that makes it a real measurement rather than a bypass: the
// digest must MOVE when the underlying disposition moves. If it ever stops moving, a reopened row
// would keep reading "current" and the ledger basis would become the rubber stamp that
// `source:'not-applicable'` (the rejected alternative) would have been.
describe('ledger-state server measurement', () => {
  const recipe = {
    schemaVersion: 1 as const,
    kind: 'work-items' as const,
    workItemIds: ['EI-2', 'EI-1'],
  };

  beforeEach(() => {
    h.rows = [];
    h.scorecardRows = [];
  });

  it('hashes the named rows deterministically, independent of argument order and duplicates', async () => {
    h.rows = [
      { feature_id: 'EI-1', status: 'done' },
      { feature_id: 'EI-2', status: 'dropped' },
    ];

    const first = await measureWorkItemsEvidenceForScope('workspace-test', 'papercusp', recipe);
    const replay = await measureWorkItemsEvidenceForScope('workspace-test', 'papercusp', recipe);
    expect(replay).toEqual(first);

    // Same population, spelled differently: the digest is over a sorted, de-duplicated id set.
    const reordered = await measureWorkItemsEvidenceForScope('workspace-test', 'papercusp', {
      ...recipe,
      workItemIds: ['EI-1', 'EI-2', 'EI-1'],
    });
    expect(reordered.sourceFingerprint).toBe(first.sourceFingerprint);

    expect(first.sourceFingerprint).toMatch(/^sha256-work-item-set-v1:[0-9a-f]{64}$/);
    // Ledger state has no test-file half; a null here is what keeps `test` at not-applicable
    // instead of inventing an unknown dimension the subject cannot ever satisfy.
    expect(first.testFingerprint).toBeNull();
  });

  it('measures declared runtime units and keeps missing environment witnesses unknown', async () => {
    configureRuntimeVintageStore(new InMemoryRuntimeVintageStore());
    await reportRuntimeVintage({ workspaceId: 'workspace-test', unit: 'ledger-runtime',
      treeSha: 'a'.repeat(40), pid: process.pid });

    const measured = await measureWorkItemsEvidenceForScope('workspace-test', 'papercusp', {
      ...recipe,
      runtimeUnits: ['ledger-runtime'],
    });
    expect(measured.environmentFingerprint).toMatch(/^[a-f0-9]{64}$/);

    const missing = await measureWorkItemsEvidenceForScope('workspace-test', 'papercusp', {
      ...recipe,
      runtimeUnits: ['missing-runtime'],
    });
    expect(missing.environmentFingerprint).toBeNull();

    const withoutRuntime = await measureWorkItemsEvidenceForScope('workspace-test', 'papercusp', recipe);
    expect(withoutRuntime).not.toHaveProperty('environmentFingerprint');
  });

  it('moves the digest when a disposition changes — this is what makes a reopened row go stale', async () => {
    h.rows = [
      { feature_id: 'EI-1', status: 'done' },
      { feature_id: 'EI-2', status: 'dropped' },
    ];
    const before = await measureWorkItemsEvidenceForScope('workspace-test', 'papercusp', recipe);

    // EI-1 is reopened: the census claim "every row reached a recorded disposition" is no longer true.
    h.rows = [
      { feature_id: 'EI-1', status: 'open' },
      { feature_id: 'EI-2', status: 'dropped' },
    ];
    const after = await measureWorkItemsEvidenceForScope('workspace-test', 'papercusp', recipe);

    expect(after.sourceFingerprint).not.toBe(before.sourceFingerprint);
  });

  it('hashes an absent row as an explicit null so a deleted or misspelled id cannot pass as present', async () => {
    h.rows = [
      { feature_id: 'EI-1', status: 'done' },
      { feature_id: 'EI-2', status: 'done' },
    ];
    const bothPresent = await measureWorkItemsEvidenceForScope('workspace-test', 'papercusp', recipe);

    h.rows = [{ feature_id: 'EI-1', status: 'done' }];
    const oneMissing = await measureWorkItemsEvidenceForScope('workspace-test', 'papercusp', recipe);

    expect(oneMissing.sourceFingerprint).not.toBe(bothPresent.sourceFingerprint);
  });

  it('routes both measurement kinds through one discriminated union', () => {
    expect(
      evidenceMeasurementSchema.safeParse({ schemaVersion: 1, kind: 'work-items', workItemIds: ['WI-1234'] }).success,
    ).toBe(true);
    expect(evidenceMeasurementSchema.safeParse({ schemaVersion: 1, kind: 'work-items',
      workItemIds: ['WI-1234'], runtimeUnits: ['bg-host'] }).success).toBe(true);
    expect(evidenceMeasurementSchema.safeParse({ schemaVersion: 1, kind: 'work-items',
      workItemIds: ['WI-1234'], runtimeUnits: ['bg-host', 'bg-host'] }).success).toBe(false);

    // CALIBRATION / positive control: the pre-existing repo-files basis must still parse, or the
    // assertions above could pass simply because the union stopped accepting anything real.
    expect(
      evidenceMeasurementSchema.safeParse({ schemaVersion: 1, kind: 'repo-files', sourcePaths: ['src/a.ts'] }).success,
    ).toBe(true);

    expect(evidenceMeasurementSchema.safeParse({ schemaVersion: 1, kind: 'work-items', workItemIds: [] }).success).toBe(
      false,
    );
    expect(
      evidenceMeasurementSchema.safeParse({ schemaVersion: 1, kind: 'work-items', workItemIds: ['not a ref'] }).success,
    ).toBe(false);
  });
});

describe('spec evidence retraction and grading-audit cancellation', () => {
  beforeEach(() => {
    h.rows = [{
      id: 30308,
      work_item_id: 'WI-101',
      plan_slug: 'reconnect-plan',
      spec_id: 'SPEC-003-01',
      spec_revision: 1,
      evidence_kind: 'coverage-census',
      evidence_ref: 'surface:POST /events',
      retracted_at: null,
      retracted_by: null,
      retraction_reason: null,
      feature_id: 'EI-TARGET',
    }];
    h.queries = [];
  });

  it('cancels pending grading audits in the retraction transaction before notifying readers', async () => {
    const result = await retractSpecEvidence({
      harnessSlug: 'papercusp',
      bindingId: 30308,
      reason: 'withdrawn fixture evidence',
      actorId: 'su-retractor',
    });

    expect(result).toMatchObject({ status: 'retracted', bindingId: 30308 });
    const bindingUpdateIndex = h.queries.findIndex(({ sql }) => sql.includes('UPDATE harness_shared.spec_evidence_bindings'));
    const auditCancellationIndex = h.queries.findIndex(({ sql }) => sql.includes('UPDATE harness_shared.work_items'));
    expect(bindingUpdateIndex).toBeGreaterThanOrEqual(0);
    expect(auditCancellationIndex).toBeGreaterThan(bindingUpdateIndex);
    const cancellation = h.queries[auditCancellationIndex]!;
    expect(cancellation.sql).toContain("gradingAudit'->>'state' = 'pending'");
    expect(cancellation.sql).toContain('jsonb_array_elements_text');
    expect(cancellation.sql).toContain("cited.binding_id =");
    expect(cancellation.values).toEqual(expect.arrayContaining(['workspace-test', '30308']));
  });
});
