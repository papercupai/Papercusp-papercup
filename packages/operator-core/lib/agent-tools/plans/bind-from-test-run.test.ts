/** P-044 (RSR-P-044-A): deriving a proof binding from a recorded test run — pure derivation + scope rules. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repoFilesEvidenceMeasurementSchema } from './spec-evidence-store';
import {
  asCommittedTestPath,
  cargoCanonicalTestPathRefusal,
  cargoTestRef,
  deriveBindingFromTestRun,
  deriveSubjectSourcePaths,
  expandTestRunBinding,
  FROM_TEST_RUN_MAX_SOURCE_PATHS,
  isTestInfrastructurePath,
  measuredFileModifiedAfterRun,
  measurementLowerBound,
  repoRelativeTestPath,
  recordedTestPath,
  registeredSiblingCheckout,
  testRunBindingSchema,
  withRepoIdentityMemo,
  type TestRunBindingDeps,
  type TestRunEvidenceRow,
} from './bind-from-test-run';

let root = '';
const SCOPE = { workspaceId: 'ws-1', harnessSlug: 'web' };
const TEST = 'pkg/lib/thing.test.ts';

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'bind-from-test-run-'));
  await mkdir(path.join(root, 'pkg/lib/__fixtures__'), { recursive: true });
  await mkdir(path.join(root, 'pkg/lib/wide'), { recursive: true });
  await writeFile(path.join(root, 'pkg/lib/thing.ts'), 'export const thing = 1;\n');
  await writeFile(path.join(root, 'pkg/lib/other.ts'), 'export const other = 1;\n');
  await writeFile(path.join(root, 'pkg/lib/lazy.ts'), 'export const lazy = 1;\n');
  await writeFile(path.join(root, 'pkg/lib/types.ts'), 'export type T = number;\n');
  await writeFile(path.join(root, 'pkg/lib/__fixtures__/seed.ts'), 'export const seed = 1;\n');
  await writeFile(path.join(root, 'pkg/lib/sibling.test.ts'), 'export const x = 1;\n');
  await writeFile(
    path.join(root, TEST),
    [
      "import { describe } from 'vitest';",
      "import type { T } from './types';",
      "import { thing } from './thing';",
      "import { other } from './other.js';",
      "import { seed } from './__fixtures__/seed';",
      "import './sibling.test';",
      "// import { ghost } from './ghost';",
      "const { lazy } = await import('./lazy');",
      '',
    ].join('\n'),
  );
  const wide = Array.from({ length: FROM_TEST_RUN_MAX_SOURCE_PATHS + 1 }, (_, i) => `m${i}`);
  await Promise.all(wide.map((m) => writeFile(path.join(root, `pkg/lib/wide/${m}.ts`), 'export const v = 1;\n')));
  await writeFile(
    path.join(root, 'pkg/lib/wide.test.ts'),
    wide.map((m) => `import './wide/${m}';`).join('\n') + '\n',
  );
  await writeFile(path.join(root, 'pkg/lib/bare.test.ts'), "import { describe } from 'vitest';\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// WI-6554700010014813: the NEXT millisecond, not "now". runStartedAt carries millisecond
// precision while file mtimes carry sub-millisecond fractions, so a stamp taken in the same
// millisecond as a fixture write reads as BEFORE that write, and the binder correctly refuses
// it (test_run_source_modified_after_run). Measured: 146 of 500 replays of the nested-workspace
// case refused on /dev/shm. floor(now) + 1ms is strictly after every write that already returned,
// because a kernel file timestamp never runs ahead of the realtime clock.
const runStartedAt = () => new Date(Date.now() + 1).toISOString();

function withDefaultRunStart(details: unknown): unknown {
  if (typeof details === 'string') {
    try {
      const parsed: unknown = JSON.parse(details);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && !Object.prototype.hasOwnProperty.call(parsed, 'runStartedAt')) {
        return JSON.stringify({ ...parsed, runStartedAt: runStartedAt() });
      }
    } catch { /* keep malformed fixture text unchanged */ }
    return details;
  }
  if (details && typeof details === 'object' && !Array.isArray(details)
    && !Object.prototype.hasOwnProperty.call(details, 'runStartedAt')) {
    return { ...details, runStartedAt: runStartedAt() };
  }
  return details;
}

function run(over: Partial<TestRunEvidenceRow> = {}): TestRunEvidenceRow {
  const hasExecutionDetails = Object.prototype.hasOwnProperty.call(over, 'execution_details');
  const { execution_details, ...rest } = over;
  return {
    id: 42,
    file_path: TEST,
    status: 'pass',
    source: 'local',
    harness_slug: 'web',
    workspace_id: 'ws-1',
    commit_sha: 'abcdef0123456789',
    worktree_dirty: false,
    finished_at: '2026-09-23T15:00:00Z',
    ...rest,
    execution_details: hasExecutionDetails
      ? withDefaultRunStart(execution_details)
      : { collectionFailed: false, runStartedAt: runStartedAt() },
  };
}

const input = (over: Record<string, unknown> = {}) =>
  testRunBindingSchema.parse({ workItemId: 'WI-1', specId: 'SPEC-1', fromTestRun: 42, ...over });

describe('subject files are the first ring of relative runtime imports', () => {
  it('keeps static, .js-spelled and literal dynamic imports; drops type-only, commented, fixture and test imports', () => {
    expect(deriveSubjectSourcePaths(root, TEST)).toEqual(['pkg/lib/lazy.ts', 'pkg/lib/other.ts', 'pkg/lib/thing.ts']);
  });

  it('classifies test infrastructure by file suffix and directory segment', () => {
    expect(isTestInfrastructurePath('a/b.test.ts')).toBe(true);
    expect(isTestInfrastructurePath('a/__fixtures__/x.ts')).toBe(true);
    expect(isTestInfrastructurePath('a/test/helpers.ts')).toBe(true);
    expect(isTestInfrastructurePath('a/testing/helpers.ts')).toBe(false);
    expect(isTestInfrastructurePath('a/b.ts')).toBe(false);
  });

  it('normalizes absolute run paths into the checkout and rejects paths outside it', () => {
    expect(repoRelativeTestPath(root, path.join(root, TEST))).toBe(TEST);
    expect(repoRelativeTestPath(root, `./${TEST}`)).toBe(TEST);
    expect(repoRelativeTestPath(root, '/elsewhere/x.test.ts')).toBeNull();
  });
});

describe('deriveBindingFromTestRun', () => {
  describe.each(['integration', 'e2e'])('isolated %s receipt derivation', testLayer => {
  const isolatedReceipts = [
    { runId: '20261008T164557Z-3031268', resultSha256: 'a'.repeat(64),
      sourceSha256: 'b'.repeat(64), lifecycleSha256: 'c'.repeat(64) },
    { runId: '20261008T164439Z-3031268', resultSha256: 'd'.repeat(64),
      sourceSha256: 'e'.repeat(64), lifecycleSha256: 'f'.repeat(64) },
  ];
  const isolatedExecution = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1, root, filePath: TEST, runGroupId: null, workspaceId: 'ws-1',
    harnessSlug: 'web', testNamePattern: null, testLayer, passed: 2,
    failed: 0, skipped: 0, collectionFailed: false, mutationPhase: null,
    commitSha: 'abcdef0123456789', worktreeDirty: false,
    isolatedRuntimeReceipts: isolatedReceipts, ...over,
  });
  const completedIsolated = { kind: 'isolated-integration',
    runIds: isolatedReceipts.map(receipt => receipt.runId).sort() };

  it.each(['object', 'json'])('derives isolated integration selectors from original %s ledger receipts', (encoding) => {
    const execution = isolatedExecution();
    const out = deriveBindingFromTestRun(input({ completedRuntime: completedIsolated }),
      run({ execution_details: encoding === 'json' ? JSON.stringify(execution) : execution }), root, 'run');
    expect(out).toMatchObject({ ok: true, binding: { measurement: {
      runtimeUnits: isolatedReceipts.map(receipt => `isolated-integration:${receipt.runId}`),
      completedRuntime: completedIsolated,
    } } });
    expect(deriveBindingFromTestRun(input(), run({ execution_details: execution }), root, 'run'))
      .toMatchObject({ ok: true, binding: { measurement: {
        runtimeUnits: isolatedReceipts.map(receipt => `isolated-integration:${receipt.runId}`),
      } } });
  });

  it.each(['object', 'json'])('keeps an isolated %s counterexample on its source and test evidence plane', (encoding) => {
    const snapshot = { schemaVersion: 1, units: ['bg-host'], fingerprint: 'a'.repeat(64),
      observedAt: '2026-09-23T14:59:00Z' };
    const execution = isolatedExecution({ runtimeEnvironmentBefore: snapshot, runtimeEnvironmentAfter: snapshot });
    const out = deriveBindingFromTestRun(input({ evidenceKind: 'counterexample',
      details: { evidencePlane: 'tree' } }),
    run({ execution_details: encoding === 'json' ? JSON.stringify(execution) : execution }), root, 'run');
    expect(out).toMatchObject({ ok: true, binding: { evidenceKind: 'counterexample', testRunId: 42,
      measurement: { kind: 'repo-files', testPaths: [TEST], sourcePaths: expect.any(Array) },
      details: { evidencePlane: 'tree', adequacy: { outcome: 'passed', executed: true } },
    } });
    expect(out.ok && out.binding.measurement).not.toHaveProperty('runtimeUnits');
    expect(out.ok && out.binding.measurement).not.toHaveProperty('completedRuntime');
  });

  it.each(['object', 'json'])('retains the original isolated %s witness after guarded harness adoption', (encoding) => {
    const execution = isolatedExecution({ harnessSlug: null });
    const out = deriveBindingFromTestRun(input({ completedRuntime: completedIsolated }),
      run({ execution_details: encoding === 'json' ? JSON.stringify(execution) : execution }), root, 'run');
    expect(out).toMatchObject({ ok: true, binding: { measurement: {
      runtimeUnits: isolatedReceipts.map(receipt => `isolated-integration:${receipt.runId}`),
      completedRuntime: completedIsolated,
    } } });
    for (const source of ['ci', 'admin-ui']) {
      expect(deriveBindingFromTestRun(input({ completedRuntime: completedIsolated }),
        run({ source, execution_details: execution }), root, 'run'))
        .toMatchObject({ ok: false, error: 'test_run_runtime_witness_missing' });
    }
  });

  it('refuses an explicit isolated completed-runtime selector on counterexample evidence', () => {
    expect(deriveBindingFromTestRun(input({ evidenceKind: 'counterexample',
      completedRuntime: completedIsolated }), run({ execution_details: isolatedExecution() }), root, 'run'))
      .toMatchObject({ ok: false, error: 'test_run_runtime_witness_missing' });
  });

  it.each([
    ['unit layer', { testLayer: 'unit' }],
    ['browser layer', { testLayer: 'browser' }],
    ['missing receipts', { isolatedRuntimeReceipts: undefined }],
    ['duplicate receipts', { isolatedRuntimeReceipts: [isolatedReceipts[0], isolatedReceipts[0]] }],
    ['malformed receipt', { isolatedRuntimeReceipts: [{ ...isolatedReceipts[0], resultSha256: 'invalid' }] }],
    ['different workspace', { workspaceId: 'ws-other' }],
    ['different harness', { harnessSlug: 'other' }],
  ])('refuses completed isolated certification with %s', (_label, over) => {
    const row = run({ execution_details: isolatedExecution(over as Record<string, unknown>) });
    expect(deriveBindingFromTestRun(input({ completedRuntime: completedIsolated }), row, root, 'run'))
      .toMatchObject({ ok: false, error: 'test_run_runtime_witness_missing' });
    expect(deriveBindingFromTestRun(input(), row, root, 'run'))
      .not.toMatchObject({ binding: { measurement: { runtimeUnits: expect.anything() } } });
  });

  it('refuses requested lifetime mismatches and receipts offered as a different completed runtime kind', () => {
    const row = run({ execution_details: isolatedExecution() });
    for (const completedRuntime of [
      { kind: 'isolated-integration', runIds: [isolatedReceipts[0].runId] },
      { kind: 'isolated-integration', runIds: ['20261008T170000Z-3031268'] },
      { kind: 'llm-in-process' },
    ]) {
      expect(deriveBindingFromTestRun(input({ completedRuntime }), row, root, 'run'))
        .toMatchObject({ ok: false, error: 'test_run_runtime_witness_missing' });
    }
    const snapshot = { schemaVersion: 1, units: ['bg-host'], fingerprint: 'a'.repeat(64),
      observedAt: '2026-09-23T14:59:00Z' };
    expect(deriveBindingFromTestRun(input({ completedRuntime: completedIsolated }), run({
      execution_details: { ...isolatedExecution({ isolatedRuntimeReceipts: undefined }),
        runtimeEnvironmentBefore: snapshot, runtimeEnvironmentAfter: snapshot },
    }), root, 'run')).toMatchObject({ ok: false, error: 'test_run_runtime_witness_missing' });
  });

  });

  it('derives runtime selectors only from matching execution-time ledger witnesses', () => {
    const witness = { schemaVersion: 1, units: ['bg-host'], fingerprint: 'a'.repeat(64),
      observedAt: '2026-09-23T14:59:00Z' };
    const execution = { schemaVersion: 1, root, filePath: TEST, runGroupId: null, workspaceId: 'ws-1',
      harnessSlug: 'web', testNamePattern: null, passed: 1, failed: 0, skipped: 0, collectionFailed: false,
      mutationPhase: null, commitSha: 'abc', worktreeDirty: false, runtimeEnvironmentBefore: witness,
      runtimeEnvironmentAfter: { ...witness, observedAt: '2026-09-23T15:00:00Z' } };
    const derived = deriveBindingFromTestRun(input(), run({ execution_details: execution }), root, 'run');
    expect(derived).toMatchObject({ ok: true, binding: { measurement: { runtimeUnits: ['bg-host'] } } });
    const completedRuntime = { kind: 'verification-harness' as const,
      verifierRunId: '20261008T000000Z-100', journeyHarness: 'native-journey', journeyRunId: '20261008T000020Z-200' };
    const completedInput = input({ completedRuntime });
    expect(testRunBindingSchema.parse(completedInput)).toHaveProperty('completedRuntime', completedRuntime);
    expect(deriveBindingFromTestRun(completedInput, run({ execution_details: execution }), root, 'run'))
      .toMatchObject({ ok: true, binding: { measurement: { runtimeUnits: ['bg-host'], completedRuntime } } });
    expect(deriveBindingFromTestRun(completedInput, run(), root, 'run'))
      .toMatchObject({ ok: false, error: 'test_run_runtime_witness_missing' });
    const llmInput = input({ completedRuntime: { kind: 'llm-in-process' } });
    expect(testRunBindingSchema.parse(llmInput)).toHaveProperty('completedRuntime', { kind: 'llm-in-process' });
    expect(deriveBindingFromTestRun(llmInput, run({ execution_details: execution }), root, 'run'))
      .toMatchObject({ ok: true, binding: { measurement: { completedRuntime: { kind: 'llm-in-process' } } } });
    expect(deriveBindingFromTestRun(llmInput, run(), root, 'run'))
      .toMatchObject({ ok: false, error: 'test_run_runtime_witness_missing' });
    const drift = deriveBindingFromTestRun(input(), run({ execution_details: { ...execution,
      runtimeEnvironmentAfter: { ...execution.runtimeEnvironmentAfter, fingerprint: 'b'.repeat(64) } } }), root, 'run');
    expect(drift.ok && drift.binding.measurement).not.toHaveProperty('runtimeUnits');
    const attested = deriveBindingFromTestRun(input({ details: { runtimeEnvironmentBefore: witness,
      runtimeEnvironmentAfter: execution.runtimeEnvironmentAfter } }), run(), root, 'run');
    expect(attested.ok && attested.binding.measurement).not.toHaveProperty('runtimeUnits');
  });
  it('rejects integration testimony for an observed unit run, including JSON-string ledger details', () => {
    const row = run({ execution_details: JSON.stringify({ schemaVersion: 1, testLayer: 'unit' }) });
    expect(deriveBindingFromTestRun(input({ details: { adequacy: { testLayer: 'integration' } } }), row, root, 'run'))
      .toMatchObject({ ok: false, error: 'run_contradicts_declared_adequacy' });
    expect(deriveBindingFromTestRun(input(), row, root, 'run'))
      .toMatchObject({ ok: true, binding: { details: { adequacy: { testLayer: 'unit' } } } });
  });

  it('derives a test binding whose evidenceRef is the test path and whose adequacy facts come from the run', () => {
    const out = deriveBindingFromTestRun(input(), run(), root, 'run');
    expect(out).toMatchObject({
      ok: true,
      binding: {
        evidenceKind: 'test',
        evidenceRef: TEST,
        testRunId: 42,
        measurement: {
          schemaVersion: 1,
          kind: 'repo-files',
          sourcePaths: ['pkg/lib/lazy.ts', 'pkg/lib/other.ts', 'pkg/lib/thing.ts'],
          testPaths: [TEST],
        },
        details: {
          adequacy: { collected: true, skipped: false, executed: true, outcome: 'passed' },
          testRun: { id: 42, commitSha: 'abcdef0123456789', worktreeDirty: false, harnessAttribution: 'run' },
        },
      },
    });
  });

  it('derives a MUTATION binding from a mutation-probe mutant row: a failed mutant is caught, a passing one survived', () => {
    const mutant = (status: string) =>
      run({ status, source: 'mutation-probe', execution_details: JSON.stringify({
        mutationPhase: 'mutant', failed: status === 'fail' ? 1 : 0, collectionFailed: false,
        failedCaseTitles: status === 'fail' ? ['suite > fails'] : undefined,
      }) });
    const caught = deriveBindingFromTestRun(input(), mutant('fail'), root, 'run');
    expect(caught).toMatchObject({
      ok: true,
      binding: { evidenceKind: 'mutation', details: { adequacy: { executed: true, outcome: 'caught' } } },
    });
    expect(caught.ok && caught.binding.evidenceRef).toMatch(/^test-run 42 mutation-probe mutant fail pkg\/lib\/thing\.test\.ts @abcdef012345$/);
    expect(deriveBindingFromTestRun(input(), mutant('pass'), root, 'run')).toMatchObject({
      ok: true,
      binding: { details: { adequacy: { outcome: 'survived' } } },
    });
    // A failed probe can be a launcher/collection crash whose output_tail only
    // contains session hook or environment noise. Without measured assertion
    // identities it cannot establish that the mutant was caught.
    expect(deriveBindingFromTestRun(
      input(),
      run({ status: 'fail', source: 'mutation-probe', execution_details: { mutationPhase: 'mutant' } }),
      root,
      'run',
    )).toMatchObject({ ok: true, binding: { details: { adequacy: { outcome: 'unknown' } } } });
    // WI-10004591: a caller-declared mutation binding over a row that is NOT a raw mutant run
    // (a testing:record-run operational record of a whole probe invocation) carries the probe's
    // VERDICT — a passing record is a CAUGHT mutant, never `survived`.
    const verdict = (status: string) => run({ status, source: 'local', execution_details: { framework: 'shell' } });
    expect(deriveBindingFromTestRun(input({ evidenceKind: 'mutation' }), verdict('pass'), root, 'run')).toMatchObject({
      ok: true,
      binding: { evidenceKind: 'mutation', details: { adequacy: { executed: true, outcome: 'caught' } } },
    });
    const failedVerdict = deriveBindingFromTestRun(input({ evidenceKind: 'mutation' }), verdict('fail'), root, 'run');
    expect(failedVerdict.ok && failedVerdict.binding.details.adequacy).toMatchObject({ outcome: 'fail' });
    const plainCounterexample = deriveBindingFromTestRun(
      input({ evidenceKind: 'counterexample' }),
      verdict('pass'),
      root,
      'run',
    );
    expect(plainCounterexample).toMatchObject({
      ok: true,
      binding: { evidenceKind: 'counterexample', details: { adequacy: { outcome: 'passed' } } },
    });
    const mutantCounterexample = deriveBindingFromTestRun(
      input({ evidenceKind: 'counterexample' }),
      mutant('pass'),
      root,
      'run',
    );
    expect(mutantCounterexample).toMatchObject({
      ok: true,
      binding: { evidenceKind: 'counterexample', details: { adequacy: { outcome: 'survived' } } },
    });
    // The BASELINE half of a probe is ordinary passing test evidence.
    const baseline = run({ source: 'mutation-probe', execution_details: { mutationPhase: 'baseline' } });
    expect(deriveBindingFromTestRun(input(), baseline, root, 'run')).toMatchObject({
      ok: true,
      binding: { evidenceKind: 'test' },
    });
  });

  it('keeps the caller judgment (targeted, layer) and fills only the observable facts', () => {
    const out = deriveBindingFromTestRun(
      input({ details: { adequacy: { targeted: true, testLayer: 'unit', executed: true }, note: 'x' } }),
      run(),
      root,
      'run',
    );
    expect(out).toMatchObject({
      ok: true,
      binding: { details: { note: 'x', adequacy: { targeted: true, testLayer: 'unit', executed: true, outcome: 'passed' } } },
    });
  });

  it('refuses copied causal controls that name a different mutant than the bound run', () => {
    const row = run({ status: 'fail', source: 'mutation-probe', execution_details: { mutationPhase: 'mutant' } });
    const out = deriveBindingFromTestRun(input({ details: { causalControls: {
      baselineTestRunId: 10, copyBaselineTestRunId: 11, mutantTestRunId: 12,
    } } }), row, root, 'run');
    expect(out).toMatchObject({ ok: false, error: 'mutation_causal_controls_invalid', testRunId: 42 });
    expect(!out.ok && out.message).toContain('mutantTestRunId');
  });

  it('refuses adequacy the run contradicts, naming both values', () => {
    const out = deriveBindingFromTestRun(input({ details: { adequacy: { outcome: 'passed' } } }), run({ status: 'fail' }), root, 'run');
    expect(out).toMatchObject({ ok: false, error: 'run_contradicts_declared_adequacy' });
    expect(!out.ok && out.message).toContain('outcome="failed"');
  });

  it('round-trips a prior canonical pass adequacy outcome against its governed test run', () => {
    const out = deriveBindingFromTestRun(
      input({ details: { adequacy: { outcome: 'pass', pathReachable: true } } }),
      run({ status: 'pass' }),
      root,
      'run',
    );
    expect(out).toMatchObject({
      ok: true,
      binding: { details: { adequacy: { outcome: 'passed', pathReachable: true } } },
    });

    // A caught mutant is not an alias for a passing ordinary test. Keep the polarity check
    // when the same binder handles a mutant run as counterexample evidence.
    const mutant = run({ source: 'mutation-probe', execution_details: { mutationPhase: 'mutant' } });
    expect(deriveBindingFromTestRun(
      input({ evidenceKind: 'counterexample', details: { adequacy: { outcome: 'caught' } } }),
      mutant,
      root,
      'run',
    )).toMatchObject({ ok: false, error: 'run_contradicts_declared_adequacy' });
  });

  it('reports a collection failure as not collected and a skip as skipped', () => {
    expect(
      deriveBindingFromTestRun(input(), run({ status: 'fail', execution_details: { collectionFailed: true } }), root, 'run'),
    ).toMatchObject({ ok: true, binding: { details: { adequacy: { collected: false, executed: true } } } });
    expect(deriveBindingFromTestRun(input(), run({ status: 'skip' }), root, 'run')).toMatchObject({
      ok: true,
      binding: { details: { adequacy: { skipped: true, executed: false, outcome: 'skipped' } } },
    });
  });

  it('refuses an unfinished run, an out-of-checkout file, and an underivable subject set', () => {
    expect(deriveBindingFromTestRun(input(), run({ status: 'running' }), root, 'run')).toMatchObject({
      ok: false,
      error: 'test_run_unfinished',
    });
    expect(deriveBindingFromTestRun(input(), run({ file_path: '/elsewhere/x.test.ts' }), root, 'run')).toMatchObject({
      ok: false,
      error: 'test_run_file_outside_root',
    });
    expect(deriveBindingFromTestRun(input(), run({ file_path: 'pkg/lib/bare.test.ts' }), root, 'run')).toMatchObject({
      ok: false,
      error: 'source_paths_underivable',
    });
    const wide = deriveBindingFromTestRun(input(), run({ file_path: 'pkg/lib/wide.test.ts' }), root, 'run');
    expect(wide).toMatchObject({ ok: false, error: 'source_paths_underivable' });
    expect(!wide.ok && wide.message).toContain(`${FROM_TEST_RUN_MAX_SOURCE_PATHS}-path measurement cap`);
  });

  it('lets an explicit sourcePaths override the derivation (and covers the underivable cases)', () => {
    expect(
      deriveBindingFromTestRun(input({ sourcePaths: ['pkg/lib/wide/m1.ts'] }), run({ file_path: 'pkg/lib/wide.test.ts' }), root, 'run'),
    ).toMatchObject({ ok: true, binding: { measurement: { sourcePaths: ['pkg/lib/wide/m1.ts'] } } });
  });

  it('preserves calibration fixtures while deriving recorded test provenance', () => {
    const parsed = testRunBindingSchema.parse(input({
      fixturePaths: ['pkg/lib/__fixtures__/seed.ts'],
      fixtureGlobs: ['pkg/lib/__fixtures__/**/*.ts'],
      fixtureRootHarnessSlug: 'web',
      details: { adequacy: { fixtureCalibrated: true } },
    }));
    const derived = deriveBindingFromTestRun(parsed, run(), root, 'run');
    expect(derived.ok).toBe(true);
    if (!derived.ok) throw new Error(derived.message);
    expect(repoFilesEvidenceMeasurementSchema.parse(derived.binding.measurement)).toMatchObject({
      fixturePaths: ['pkg/lib/__fixtures__/seed.ts'],
      fixtureGlobs: ['pkg/lib/__fixtures__/**/*.ts'],
      fixtureRootHarnessSlug: 'web',
      testPaths: [TEST],
    });
    expect(derived.binding).toMatchObject({ testRunId: 42,
      details: { adequacy: { fixtureCalibrated: true }, testRun: { id: 42 } } });
    expect(() => testRunBindingSchema.parse(input({ fixturePaths: ['../outside.ts'] }))).toThrow();
  });
});

describe('expandTestRunBinding: mutation causal controls', () => {
  const controls = { baselineTestRunId: 10, copyBaselineTestRunId: 11, mutantTestRunId: 42 };
  async function expand(controlOverride: Partial<TestRunEvidenceRow> | null = {}) {
    const rows = new Map<number, TestRunEvidenceRow>([
      [42, run({ status: 'fail', source: 'mutation-probe', execution_details: { mutationPhase: 'mutant' } })],
      [10, run({ id: 10, source: 'mutation-probe', execution_details: { mutationPhase: 'baseline' } })],
    ]);
    if (controlOverride !== null) rows.set(11, run({ id: 11, ...controlOverride }));
    return expandTestRunBinding(input({ details: { causalControls: controls } }), SCOPE, {
      loadRun: async (_scope, id) => rows.get(id) ?? null,
      adoptRun: async () => true,
      resolveRoot: async () => root,
    });
  }

  it('accepts successful controls for the same committed, scoped mutation', async () => {
    expect(await expand()).toMatchObject({ ok: true,
      binding: { testRunId: 42, details: { causalControls: controls } } });
  });

  it.each([
    ['another commit', { commit_sha: '123456789abcdef0' }],
    ['unknown commit', { commit_sha: null }],
    ['another workspace', { workspace_id: 'other-workspace' }],
    ['another harness', { harness_slug: 'other-harness' }],
    ['a failed control', { status: 'fail' }],
    ['a missing control', null],
  ] as const)('refuses causal controls from %s', async (_label, override) => {
    expect(await expand(override)).toMatchObject({ ok: false, error: 'mutation_causal_controls_invalid', testRunId: 42 });
  });
});

describe('expandTestRunBinding: harness attribution', () => {
  function deps(row: TestRunEvidenceRow | null, adopt = true) {
    const calls = { adopt: 0 };
    const d: TestRunBindingDeps = {
      loadRun: async () => row,
      adoptRun: async () => {
        calls.adopt += 1;
        return adopt;
      },
      resolveRoot: async () => root,
    };
    return { d, calls };
  }

  it.each(['object', 'json'])('adopts a harness-NULL local %s run and retains its isolated runtime receipts', async (encoding) => {
    const receipts = [
      { runId: '20261008T164557Z-3031268', resultSha256: 'a'.repeat(64),
        sourceSha256: 'b'.repeat(64), lifecycleSha256: 'c'.repeat(64) },
      { runId: '20261008T164439Z-3031268', resultSha256: 'd'.repeat(64),
        sourceSha256: 'e'.repeat(64), lifecycleSha256: 'f'.repeat(64) },
    ];
    const completedRuntime = { kind: 'isolated-integration', runIds: receipts.map(receipt => receipt.runId).sort() };
    const execution = {
      schemaVersion: 1, root, filePath: TEST, runGroupId: null, workspaceId: 'ws-1', harnessSlug: null,
      testNamePattern: null, testLayer: 'integration', passed: 2, failed: 0, skipped: 0,
      collectionFailed: false, mutationPhase: null, commitSha: 'abcdef0123456789', worktreeDirty: false,
      isolatedRuntimeReceipts: receipts,
    };
    const { d, calls } = deps(run({
      harness_slug: null,
      workspace_id: null,
      execution_details: encoding === 'json' ? JSON.stringify(execution) : execution,
    }));

    const out = await expandTestRunBinding(input({ completedRuntime }), SCOPE, d);

    expect(out).toMatchObject({
      ok: true,
      attribution: 'adopted-caller-harness',
      binding: { measurement: {
        runtimeUnits: receipts.map(receipt => `isolated-integration:${receipt.runId}`),
        completedRuntime,
      } },
    });
    expect(calls.adopt).toBe(1);
    expect(execution.harnessSlug).toBeNull();
  });

  it('uses the recorded nested workspace before a same-named root file and derives its actual imports', async () => {
    const nested = path.join(root, 'libs/child');
    await mkdir(path.join(nested, 'pkg/lib'), { recursive: true });
    await writeFile(path.join(nested, TEST), "import './nested-subject';\n");
    await writeFile(path.join(nested, 'pkg/lib/nested-subject.ts'), 'export const nested = true;\n');
    const { d } = deps(run({ root: nested }));
    expect(await expandTestRunBinding(input(), SCOPE, d)).toMatchObject({
      ok: true,
      binding: {
        evidenceRef: `libs/child/${TEST}`,
        measurement: { testPaths: [`libs/child/${TEST}`], sourcePaths: ['libs/child/pkg/lib/nested-subject.ts'] },
        details: { testRun: { recordedRoot: nested, recordedFilePath: TEST } },
      },
    });
  });

  it('reports a local run source restriction instead of claiming its matching canonical path mismatches', async () => {
    const { d } = deps(run({ root, file_path: path.join(root, TEST) }));
    const out = await expandTestRunBinding(input({ canonicalTestPath: TEST }), SCOPE, d);
    expect(out).toMatchObject({ ok: false, error: 'test_run_canonical_path_source_unsupported' });
    if (!out.ok) {
      expect(out.message).toContain('only supported for mutation-probe copy-out runs');
      expect(out.message).toContain('source "local"');
      expect(out.message).toContain('Omit canonicalTestPath');
      expect(out.message).not.toContain('does not match');
    }
  });

  it('binds a copy-out mutation row through an explicit canonical test path after its mirror is removed', async () => {
    const mirror = path.join(tmpdir(), 'mutation-probe-removed', 'mirror');
    const canonical = `libs/generic/tooldef/${TEST}`;
    await mkdir(path.join(root, 'libs/generic/tooldef/pkg/lib'), { recursive: true });
    await writeFile(path.join(root, canonical), "import './subject';\n");
    await writeFile(path.join(root, 'libs/generic/tooldef/pkg/lib/subject.ts'), 'export const subject = true;\n');
    const { d } = deps(run({ root: mirror, source: 'mutation-probe', execution_details: { mutationPhase: 'mutant' } }));
    expect(await expandTestRunBinding(input({ canonicalTestPath: canonical }), SCOPE, d)).toMatchObject({
      ok: true,
      binding: {
        evidenceKind: 'mutation',
        evidenceRef: expect.stringContaining(canonical),
        testRunId: 42,
        measurement: {
          testPaths: [canonical],
          sourcePaths: ['libs/generic/tooldef/pkg/lib/subject.ts'],
        },
        details: { testRun: { recordedRoot: mirror, recordedFilePath: TEST, canonicalTestPathOverride: canonical } },
      },
    });
  });

  // WI-10006836: report-cargo-tests.mjs records `<crate-dir>::<test>`, which is not a file, so the
  // generic mapping handed realpath an impossible path and every cargo row refused with ENOENT.
  describe('cargo rows map through a canonicalTestPath that defines the test', () => {
    it('follows a target declaration to the qualified test module and rejects an unrelated same-named function', async () => {
      const target = 'native-target/src/main.rs';
      const module = 'native-target/src/native_console.rs';
      const other = 'native-target/src/other.rs';
      await mkdir(path.join(root, 'native-target/src'), { recursive: true });
      await writeFile(path.join(root, target), 'mod native_console; mod other;\n');
      const body = '#[cfg(test)] mod tests { #[test] fn prepares_both_entrypoints() {} }\n';
      await writeFile(path.join(root, module), body);
      await writeFile(path.join(root, other), body);
      const ref = cargoTestRef(`${target}::native_console::tests::prepares_both_entrypoints`)!;
      expect(cargoCanonicalTestPathRefusal(root, ref, module)).toBeNull();
      expect(cargoCanonicalTestPathRefusal(root, ref, other)).toContain('declared test module');
      expect(cargoCanonicalTestPathRefusal(root, { ...ref, testName: 'missing::tests::prepares_both_entrypoints' }, module))
        .toContain('declared test module');
    });
    const CRATE = 'app/src-tauri';
    const RS = `${CRATE}/src/main.rs`;
    const CARGO_TEST = `${CRATE}::tests::tracker_measures_the_stretch`;
    const cargoRun = (over: Partial<TestRunEvidenceRow> = {}) =>
      run({ framework: 'cargo', file_path: CARGO_TEST, commit_sha: null, ...over });
    const bindInput = (over: Record<string, unknown> = {}) =>
      input({ canonicalTestPath: RS, sourcePaths: [RS], ...over });

    beforeAll(async () => {
      await mkdir(path.join(root, `${CRATE}/src`), { recursive: true });
      await writeFile(
        path.join(root, RS),
        'fn main() {}\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn tracker_measures_the_stretch() {}\n}\n',
      );
      await writeFile(path.join(root, `${CRATE}/src/other.rs`), 'fn unrelated() {}\n');
    });

    it('parses per-test rows and rejects the binary aggregate row', () => {
      expect(cargoTestRef(CARGO_TEST)).toEqual({ crateDir: CRATE, testName: 'tests::tracker_measures_the_stretch' });
      expect(cargoTestRef(`${CRATE} (cargo aggregate)`)).toBeNull();
      expect(cargoTestRef(TEST)).toBeNull();
      expect(cargoTestRef(null)).toBeNull();
    });

    it('binds a local cargo test row as test evidence on the defining .rs file', async () => {
      const { d } = deps(cargoRun());
      expect(await expandTestRunBinding(bindInput(), SCOPE, d)).toMatchObject({
        ok: true,
        binding: {
          evidenceKind: 'test',
          evidenceRef: RS,
          measurement: { testPaths: [RS], sourcePaths: [RS] },
          details: { testRun: { recordedFilePath: CARGO_TEST, canonicalTestPathOverride: RS, source: 'local' } },
        },
      });
    });

    it('binds corrected exact target-source receipts and refuses a different file defining the same case', async () => {
      const recorded = `${RS}::tests::tracker_measures_the_stretch`;
      const { d } = deps(cargoRun({ file_path: recorded }));
      expect(await expandTestRunBinding(bindInput(), SCOPE, d)).toMatchObject({
        ok: true,
        binding: { evidenceKind: 'test', evidenceRef: RS, measurement: { testPaths: [RS] } },
      });
      const other = `${CRATE}/src/same-case.rs`;
      await writeFile(path.join(root, other), 'fn tracker_measures_the_stretch() {}\n');
      expect(await expandTestRunBinding(bindInput({ canonicalTestPath: other }), SCOPE, d)).toMatchObject({
        ok: false, error: 'test_run_canonical_path_mismatch',
      });
      expect(await expandTestRunBinding(bindInput(), SCOPE, deps(cargoRun({
        file_path: `${RS}::tests::absent_case`,
      })).d)).toMatchObject({ ok: false, error: 'test_run_canonical_path_mismatch' });
    });

    it('binds an in-tree cargo mutation-probe mutant row as mutation evidence', async () => {
      const { d } = deps(
        cargoRun({ status: 'fail', source: 'mutation-probe', execution_details: { mutationPhase: 'mutant' } }),
      );
      expect(await expandTestRunBinding(bindInput(), SCOPE, d)).toMatchObject({
        ok: true,
        binding: {
          evidenceKind: 'mutation',
          evidenceRef: expect.stringContaining(`mutation-probe mutant fail ${RS}`),
          measurement: { testPaths: [RS] },
        },
      });
    });

    it('names the missing canonicalTestPath instead of failing on a realpath of the test name', async () => {
      const out = await expandTestRunBinding(input({ sourcePaths: [RS] }), SCOPE, deps(cargoRun()).d);
      expect(out).toMatchObject({ ok: false, error: 'test_run_cargo_test_path_required' });
      if (!out.ok) {
        expect(out.message).toContain(`${CRATE}/`);
        expect(out.message).not.toContain('ENOENT');
      }
    });

    it('refuses the aggregate row', async () => {
      const { d } = deps(cargoRun({ file_path: `${CRATE} (cargo aggregate)` }));
      expect(await expandTestRunBinding(bindInput(), SCOPE, d)).toMatchObject({
        ok: false,
        error: 'test_run_cargo_not_a_test',
      });
    });

    it('refuses a canonical file that does not define the test, or lies outside the crate', async () => {
      const { d } = deps(cargoRun());
      for (const canonicalTestPath of [`${CRATE}/src/other.rs`, TEST, `${CRATE}/src/missing.rs`]) {
        expect(await expandTestRunBinding(bindInput({ canonicalTestPath }), SCOPE, d)).toMatchObject({
          ok: false,
          error: 'test_run_canonical_path_mismatch',
        });
      }
      // A `..` escape never reaches the mapper: the repo-relative path schema refuses it first.
      expect(() => bindInput({ canonicalTestPath: `${CRATE}/../${RS}` })).toThrow();
    });

    it('accepts the defining file directly and rejects a sibling by name', () => {
      const ref = { crateDir: CRATE, testName: 'tests::tracker_measures_the_stretch' };
      expect(cargoCanonicalTestPathRefusal(root, ref, RS)).toBeNull();
      expect(cargoCanonicalTestPathRefusal(root, ref, `${CRATE}/src/other.rs`)).toContain('does not define fn');
    });
  });

  // EI-24826121815486916: the store pins the checkout's bytes at bind time, so a run whose
  // measured files changed after it started would bind `current` for code it never executed.
  describe('measured files modified after the run started', () => {
    const GUARD_TEST = 'pkg/guard/guard.test.ts';
    const GUARD_SUBJECT = 'pkg/guard/subject.ts';
    const STARTED = '2026-09-23T15:00:00.000Z';
    const before = new Date('2026-09-23T14:00:00Z');
    const after = new Date('2026-09-23T16:00:00Z');

    beforeAll(async () => {
      await mkdir(path.join(root, 'pkg/guard'), { recursive: true });
      await writeFile(path.join(root, GUARD_SUBJECT), 'export const subject = 1;\n');
      await writeFile(path.join(root, GUARD_TEST), "import { subject } from './subject';\n");
    });

    async function stamp(subjectAt: Date, testAt = before) {
      await utimes(path.join(root, GUARD_SUBJECT), subjectAt, subjectAt);
      await utimes(path.join(root, GUARD_TEST), testAt, testAt);
    }

    const dirtyMutant = () =>
      run({
        file_path: GUARD_TEST,
        source: 'mutation-probe',
        worktree_dirty: true,
        started_at: STARTED,
        execution_details: { mutationPhase: 'mutant' },
      });

    it('refuses a dirty mutant run whose subject was edited after it started, naming the path and both times', async () => {
      await stamp(after);
      const out = await expandTestRunBinding(input(), SCOPE, deps(dirtyMutant()).d);
      expect(out).toMatchObject({ ok: false, error: 'test_run_source_modified_after_run', testRunId: 42 });
      if (!out.ok) {
        expect(out.message).toContain(GUARD_SUBJECT);
        expect(out.message).toContain(STARTED);
        expect(out.message).toContain(after.toISOString());
        expect(out.message).toContain('Re-run the test');
      }
    });

    it('binds the same run when every measured file predates its start (positive control)', async () => {
      await stamp(before);
      expect(await expandTestRunBinding(input(), SCOPE, deps(dirtyMutant()).d)).toMatchObject({
        ok: true,
        binding: { evidenceKind: 'mutation', measurement: { testPaths: [GUARD_TEST], sourcePaths: [GUARD_SUBJECT] } },
      });
    });

    it('also guards the test file itself, and clean runs in this checkout', async () => {
      await stamp(before, after);
      const clean = run({ file_path: GUARD_TEST, started_at: STARTED });
      expect(await expandTestRunBinding(input(), SCOPE, deps(clean).d)).toMatchObject({
        ok: false,
        error: 'test_run_source_modified_after_run',
        message: expect.stringContaining(GUARD_TEST),
      });
    });

    // EI-24827834166866368: started_at is finished_at - duration, so it postdates collection.
    // An edit after vitest read the subject but before the file's tests started sits between
    // the run-wide start and started_at, and only the run-wide start can see it.
    describe('an edit during collection (between the run start and started_at)', () => {
      const RUN_STARTED = '2026-09-23T14:30:00.000Z';
      const duringCollection = new Date('2026-09-23T14:45:00Z');

      it('is refused when the row records the run-wide start, judged against that start', async () => {
        await stamp(duringCollection);
        const row = run({
          file_path: GUARD_TEST,
          source: 'mutation-probe',
          worktree_dirty: true,
          started_at: STARTED,
          execution_details: { mutationPhase: 'mutant', runStartedAt: RUN_STARTED },
        });
        const out = await expandTestRunBinding(input(), SCOPE, deps(row).d);
        expect(out).toMatchObject({ ok: false, error: 'test_run_source_modified_after_run', testRunId: 42 });
        if (!out.ok) {
          expect(out.message).toContain(GUARD_SUBJECT);
          expect(out.message).toContain(RUN_STARTED);
          expect(out.message).toContain(duringCollection.toISOString());
        }
      });

      it.each([true, null])('refuses a dirty or unknown legacy row without a run-wide start (%s)', async worktreeDirty => {
        await stamp(duringCollection);
        const legacy = run({
          file_path: GUARD_TEST,
          source: 'mutation-probe',
          worktree_dirty: worktreeDirty,
          started_at: STARTED,
          execution_details: { mutationPhase: 'mutant', runStartedAt: undefined },
        });
        expect(await expandTestRunBinding(input(), SCOPE, deps(legacy).d)).toMatchObject({
          ok: false, error: 'test_run_measurement_start_missing', testRunId: 42,
        });
      });
    });

    it('measurementLowerBound takes the earlier readable instant and ignores unreadable ones', () => {
      expect(measurementLowerBound(STARTED, { runStartedAt: '2026-09-23T14:30:00.000Z' })?.toISOString()).toBe(
        '2026-09-23T14:30:00.000Z',
      );
      // A run start LATER than started_at is never allowed to narrow the window.
      expect(measurementLowerBound(STARTED, { runStartedAt: '2026-09-23T16:00:00.000Z' })?.toISOString()).toBe(STARTED);
      // The jsonb-string storage shape is read too.
      expect(
        measurementLowerBound(STARTED, JSON.stringify({ runStartedAt: '2026-09-23T14:30:00.000Z' }))?.toISOString(),
      ).toBe('2026-09-23T14:30:00.000Z');
      expect(measurementLowerBound(STARTED, { runStartedAt: 'garbage' })?.toISOString()).toBe(STARTED);
      expect(measurementLowerBound(new Date(STARTED), null)?.toISOString()).toBe(STARTED);
      expect(measurementLowerBound(null, { runStartedAt: '2026-09-23T14:30:00.000Z' })?.toISOString()).toBe(
        '2026-09-23T14:30:00.000Z',
      );
      expect(measurementLowerBound(undefined, { runStartedAt: 42 })).toBeNull();
      expect(measurementLowerBound('not-a-date', undefined)).toBeNull();
    });

    it('cannot judge without a start time, and leaves a missing file to the store', async () => {
      await stamp(after);
      expect(await measuredFileModifiedAfterRun(root, [GUARD_SUBJECT], undefined)).toBeNull();
      expect(await measuredFileModifiedAfterRun(root, ['pkg/guard/missing.ts'], STARTED)).toBeNull();
      expect(await measuredFileModifiedAfterRun(root, ['pkg/guard/missing.ts', GUARD_SUBJECT], STARTED)).toMatchObject({
        path: GUARD_SUBJECT,
        startedAt: STARTED,
      });
    });
  });

  describe('committed operational output is not an executed input', () => {
    const output = 'docs/evidence/generated-output.json';
    const subject = 'pkg/guard/subject.ts';
    const started = '2026-09-23T15:00:00.000Z';
    const finished = '2026-09-23T15:00:01.000Z';
    const commit = 'a'.repeat(40);
    const artifact = JSON.stringify({ schemaVersion: 1, kind: 'operational-test-evidence',
      name: 'guard output', framework: 'operational', command: ['node guard.js'],
      startedAt: started, finishedAt: finished, exitCode: 0, summary: 'One completed assertion.',
      assertions: [{ id: 'guard', passed: true, evidence: 'verified' }] });
    const digest = createHash('sha256').update(artifact).digest('hex');

    async function prepare() {
      await mkdir(path.join(root, 'docs/evidence'), { recursive: true });
      await writeFile(path.join(root, output), artifact);
      await utimes(path.join(root, output), new Date(finished), new Date(finished));
      await utimes(path.join(root, subject), new Date('2026-09-23T14:00:00Z'), new Date('2026-09-23T14:00:00Z'));
      const row = run({ root, file_path: output, framework: 'operational', commit_sha: commit,
        started_at: started, finished_at: finished, execution_details: {
          runGroupId: `operational:${digest.slice(0, 40)}`, runStartedAt: started,
          passed: 1, failed: 0, skipped: 0, collectionFailed: false,
        } });
      const d = deps(row).d;
      d.git = async (_root, args) => {
        if (args[0] === 'show' && args[1] === `${commit}:${output}`) return artifact;
        throw new Error('unavailable committed artifact');
      };
      return { row, d, binding: input({ sourcePaths: [subject] }) };
    }

    it('binds authenticated generated output written after execution, preserving source measurement', async () => {
      const { d, binding } = await prepare();
      expect(await expandTestRunBinding(binding, SCOPE, d)).toMatchObject({ ok: true,
        binding: { measurement: { testPaths: [output], sourcePaths: [subject] },
          details: { testRun: { operationalArtifact: { sha256: digest, commitSha: commit } } } } });
    });

    it('still refuses an executed source edited after the run', async () => {
      const { d, binding } = await prepare();
      await utimes(path.join(root, subject), new Date(finished), new Date(finished));
      expect(await expandTestRunBinding(binding, SCOPE, d)).toMatchObject({ ok: false,
        error: 'test_run_source_modified_after_run', message: expect.stringContaining(subject) });
    });

    it('keeps an output explicitly declared as an executed source behind the source guard', async () => {
      const { d } = await prepare();
      expect(await expandTestRunBinding(input({ sourcePaths: [subject, output] }), SCOPE, d))
        .toMatchObject({ ok: false, error: 'test_run_source_modified_after_run' });
    });

    it.each(['changed-output', 'changed-commit', 'missing-commit', 'changed-ledger'])
      ('refuses unauthenticated output: %s', async (fault) => {
        const { row, d, binding } = await prepare();
        if (fault === 'changed-output') await writeFile(path.join(root, output), `${artifact}\n`);
        if (fault === 'changed-commit') d.git = async () => `${artifact}\n`;
        if (fault === 'missing-commit') d.git = async () => { throw new Error('missing commit'); };
        if (fault === 'changed-ledger') row.execution_details = { ...row.execution_details as object, passed: 2 };
        expect(await expandTestRunBinding(binding, SCOPE, d)).toMatchObject({ ok: false });
      });

    it('does not exempt an ordinary receipt without the operational writer identity', async () => {
      const { row, d, binding } = await prepare();
      row.execution_details = { runStartedAt: started, passed: 1, failed: 0, skipped: 0 };
      expect(await expandTestRunBinding(binding, SCOPE, d))
        .toMatchObject({ ok: false, error: 'test_run_source_modified_after_run' });
    });
  });

  it('rejects a copy-out override that changes the recorded relative test or names a missing file', async () => {
    const { d } = deps(run({ root: '/tmp/mutation-probe-removed/mirror', source: 'mutation-probe' }));
    expect(await expandTestRunBinding(input({ canonicalTestPath: 'pkg/lib/other.test.ts' }), SCOPE, d))
      .toMatchObject({ ok: false, error: 'test_run_canonical_path_mismatch' });
    expect(await expandTestRunBinding(input({ canonicalTestPath: `missing/${TEST}` }), SCOPE, d))
      .toMatchObject({ ok: false, error: 'test_run_file_outside_root' });
    expect(await expandTestRunBinding(input({ canonicalTestPath: TEST }), SCOPE, deps(run({ root: '/tmp/other/mirror' })).d))
      .toMatchObject({ ok: false, error: 'test_run_canonical_path_source_unsupported' });
  });

  it.each(['ci', 'admin-ui'])('never adopts a %s row (harness-NULL by design)', async (source) => {
    const { d, calls } = deps(run({ harness_slug: null, workspace_id: null, source }));
    expect(await expandTestRunBinding(input(), SCOPE, d)).toMatchObject({ ok: false, error: 'test_run_not_adoptable' });
    expect(calls.adopt).toBe(0);
  });

  it('refuses when a racer adopted the run elsewhere', async () => {
    const { d } = deps(run({ harness_slug: null }), false);
    expect(await expandTestRunBinding(input(), SCOPE, d)).toMatchObject({ ok: false, error: 'test_run_not_adoptable' });
  });

  it('refuses a run attributed to another harness or workspace, and a missing run', async () => {
    expect(await expandTestRunBinding(input(), SCOPE, deps(run({ harness_slug: 'api' })).d)).toMatchObject({
      ok: false,
      error: 'test_run_out_of_scope',
    });
    expect(await expandTestRunBinding(input(), SCOPE, deps(run({ workspace_id: 'ws-2' })).d)).toMatchObject({
      ok: false,
      error: 'test_run_out_of_scope',
    });
    expect(await expandTestRunBinding(input(), SCOPE, deps(null).d)).toMatchObject({ ok: false, error: 'test_run_not_found' });
  });
});

describe('recorded test paths across worktrees', () => {
  const canonical = '/repos/main';
  const checkpoint = '/repos/checkpoint';
  const nested = `${checkpoint}/libs/child`;
  const git = async (cwd: string, args: readonly string[]) => {
    const command = args.join(' ');
    if (command === 'rev-parse --path-format=absolute --git-common-dir') {
      return cwd === nested ? `${canonical}/.git/modules/child` : `${canonical}/.git`;
    }
    if (cwd === nested && command === 'rev-parse --show-superproject-working-tree') return checkpoint;
    if (cwd === checkpoint && command === 'rev-parse --show-toplevel') return checkpoint;
    throw new Error(`unexpected git probe: ${cwd} ${command}`);
  };

  it('preserves the nested prefix when a recorded worktree shares the harness superproject', async () => {
    expect(await recordedTestPath(canonical, { root: nested, file_path: TEST }, git)).toBe(`libs/child/${TEST}`);
    expect(await recordedTestPath(canonical, { root: nested, file_path: `${nested}/${TEST}` }, git)).toBe(`libs/child/${TEST}`);
  });

  it('rejects unrelated repositories, missing checkout identity and workspace escapes', async () => {
    const foreignGit = async (_cwd: string, args: readonly string[]) =>
      args.includes('--git-common-dir') ? `/unrelated/${_cwd === canonical ? 'a' : 'b'}/.git` : '';
    expect(await recordedTestPath(canonical, { root: nested, file_path: TEST }, foreignGit)).toBeNull();
    expect(await recordedTestPath(canonical, { root: nested, file_path: TEST }, async () => { throw new Error('missing'); })).toBeNull();
    expect(await recordedTestPath(canonical, { root: nested, file_path: `../${TEST}` }, git)).toBeNull();
    expect(await recordedTestPath(canonical, { root: nested, file_path: `${canonical}/${TEST}` }, git)).toBeNull();
  });

  it('WI-10005436: a binding loop forks each repository-identity read once, not once per row', async () => {
    const calls: string[] = [];
    const counting = async (cwd: string, args: readonly string[]) => {
      calls.push(`${cwd} ${args.join(' ')}`);
      return git(cwd, args);
    };
    for (let row = 0; row < 5; row += 1) {
      expect(await recordedTestPath(canonical, { root: nested, file_path: TEST }, counting)).toBe(`libs/child/${TEST}`);
    }
    // One pass is 5 distinct identity reads (canonical common dir, nested common dir, nested
    // superproject, checkpoint common dir, checkpoint top level); five rows must not cost five passes.
    expect(calls).toHaveLength(5);
    expect(new Set(calls).size).toBe(5);
  });

  it('WI-10005436: identity answers expire, failures are never reused, and other reads pass through', async () => {
    let t = 0;
    let fail = true;
    const calls: string[] = [];
    const base = async (cwd: string, args: readonly string[]) => {
      calls.push(args.join(' '));
      if (args[0] === 'cat-file') return '';
      if (fail) throw new Error('not a repository');
      return cwd;
    };
    const memo = withRepoIdentityMemo(base, { ttlMs: 1_000, now: () => t });
    const top = ['rev-parse', '--show-toplevel'];
    await expect(memo('/r', top)).rejects.toThrow('not a repository');
    fail = false;
    expect(await memo('/r', top)).toBe('/r'); // the failure was not cached
    expect(await memo('/r', top)).toBe('/r'); // the success was
    expect(calls.filter((c) => c === top.join(' '))).toHaveLength(2);
    t = 1_000;
    expect(await memo('/r', top)).toBe('/r'); // expired: asked again
    expect(calls.filter((c) => c === top.join(' '))).toHaveLength(3);
    await memo('/r', ['cat-file', '-e', `${'a'.repeat(40)}:x`]);
    await memo('/r', ['cat-file', '-e', `${'a'.repeat(40)}:x`]);
    expect(calls.filter((c) => c.startsWith('cat-file'))).toHaveLength(2); // content reads are not memoized here
    expect(await withRepoIdentityMemo(base, { ttlMs: 1_000, now: () => t })('/other', top)).toBe('/other'); // keyed by cwd
  });
});

describe('WI-10004898: a clean run in a deleted disposable clone binds by commit content', () => {
  // Real git, because the whole claim is about repository identity: the clone the run
  // executed in is gone by bind time, so only the harness repo's own objects can vouch.
  let harness = '';
  let superCommit = '';
  let subCommit = '';
  const SUB = 'libs/generic/search';
  const g = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  const goneClone = (sha: string) => `/tmp/papercusp-lint-as-committed-${sha.slice(0, 10)}-gone${process.pid}`;
  const cleanRow = (over: Partial<TestRunEvidenceRow> = {}) =>
    run({ file_path: 'pkg/lib/x.test.ts', commit_sha: superCommit, worktree_dirty: false, root: goneClone(superCommit), ...over });
  const localGitRunner: NonNullable<TestRunBindingDeps['git']> = async (cwd, args) =>
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    });
  const binder = (row: TestRunEvidenceRow): TestRunBindingDeps => ({
    loadRun: async () => row,
    adoptRun: async () => true,
    resolveRoot: async () => harness,
    git: localGitRunner,
  });

  beforeAll(async () => {
    harness = await mkdtemp(path.join(tmpdir(), 'bind-as-committed-'));
    const sub = path.join(harness, SUB);
    await mkdir(path.join(sub, 'src'), { recursive: true });
    await writeFile(path.join(sub, 'src/s.ts'), 'export const s = 1;\n');
    await writeFile(path.join(sub, 'src/s.test.ts'), "import { s } from './s';\nvoid s;\n");
    await writeFile(path.join(sub, 'src/main.rs'), 'mod native_console;\n');
    await writeFile(path.join(sub, 'src/native_console.rs'),
      '#[cfg(test)] mod tests { #[test] fn prepares_both_entrypoints() {} }\n');
    g(sub, 'init', '-q');
    g(sub, 'add', '-A');
    g(sub, 'commit', '-qm', 'sub');
    subCommit = g(sub, 'rev-parse', 'HEAD');
    await mkdir(path.join(harness, 'pkg/lib'), { recursive: true });
    await writeFile(path.join(harness, 'pkg/lib/x.ts'), 'export const x = 1;\n');
    await writeFile(path.join(harness, 'pkg/lib/x.test.ts'), "import { x } from './x';\nvoid x;\n");
    g(harness, 'init', '-q');
    // `add` of an embedded repository records a 160000 gitlink pinned at subCommit.
    g(harness, 'add', 'pkg', SUB);
    g(harness, 'commit', '-qm', 'super');
    superCommit = g(harness, 'rev-parse', 'HEAD');
  });

  afterAll(async () => {
    await rm(harness, { recursive: true, force: true });
  });

  it('maps live and removed clones nested under the canonical root by repository content', async () => {
    const clone = path.join(
      harness,
      '.papercusp',
      'tmp',
      'papercusp-lint-as-committed-' + superCommit.slice(0, 10) + '-nested-' + process.pid,
    );
    await mkdir(path.dirname(clone), { recursive: true });
    execFileSync('git', ['clone', '--local', '--shared', '--no-checkout', '--quiet', harness, clone], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const expected = {
      ok: true,
      binding: {
        evidenceRef: 'pkg/lib/x.test.ts',
        details: {
          testRun: {
            recordedRoot: clone,
            asCommitted: { commitSha: superCommit, repoPrefix: '', measuredAtCommit: true },
          },
        },
      },
    };
    try {
      g(clone, 'checkout', '--detach', '--quiet', superCommit);
      const live = await expandTestRunBinding(
        input({ sourcePaths: ['pkg/lib/x.ts'] }),
        SCOPE,
        binder(cleanRow({ root: clone })),
      );
      expect(live).toMatchObject(expected);
    } finally {
      await rm(clone, { recursive: true, force: true });
    }

    const disposed = await expandTestRunBinding(
      input({ sourcePaths: ['pkg/lib/x.ts'] }),
      SCOPE,
      binder(cleanRow({ root: clone })),
    );
    expect(disposed).toMatchObject(expected);
  });

  it('maps a superproject clone run, and a submodule clone run under its submodule prefix', async () => {
    expect(await asCommittedTestPath(harness, cleanRow(), localGitRunner)).toEqual({
      testPath: 'pkg/lib/x.test.ts', repoPrefix: '', commitSha: superCommit,
    });
    const subRow = cleanRow({ root: `${goneClone(subCommit)}/${SUB}`, file_path: 'src/s.test.ts', commit_sha: subCommit });
    expect(await asCommittedTestPath(harness, subRow, localGitRunner)).toEqual({
      testPath: `${SUB}/src/s.test.ts`, repoPrefix: SUB, commitSha: subCommit,
    });
  });

  it.each([false, true, null])('preserves the distinct worktree commit only when its run was clean (%s)', async (dirty) => {
    const sibling = `${harness}-sibling-${String(dirty)}`;
    const source = path.join(harness, 'pkg/lib/x.ts');
    const test = path.join(harness, 'pkg/lib/x.test.ts');
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    g(harness, 'worktree', 'add', '--detach', sibling, superCommit);
    try {
      // The run exercised the sibling's old committed bytes. Later edits exist
      // only in the canonical checkout, despite the shared Git common directory.
      await writeFile(source, 'export const x = 2;\n');
      await writeFile(test, "import { x } from './x';\nvoid (x + 1);\n");
      const result = await expandTestRunBinding(
        input({ sourcePaths: ['pkg/lib/x.ts'] }), SCOPE,
        binder(cleanRow({ root: sibling, worktree_dirty: dirty,
          started_at: startedAt, execution_details: { runStartedAt: startedAt } })),
      );
      if (dirty === false) {
        expect(result).toMatchObject({ ok: true, binding: { details: { testRun: {
          recordedRoot: sibling,
          asCommitted: { commitSha: superCommit, repoPrefix: '', measuredAtCommit: true },
        } } } });
      } else {
        expect(result).toMatchObject({ ok: false, error: 'test_run_source_modified_after_run' });
      }
    } finally {
      await writeFile(source, 'export const x = 1;\n');
      await writeFile(test, "import { x } from './x';\nvoid x;\n");
      g(harness, 'worktree', 'remove', '--force', sibling);
    }
  });

  it('WI-10006842: maps a SUPERPROJECT clone run of a file inside a pinned submodule by descending the gitlink', async () => {
    // The node:test ledger runs papercusp-desktop/test/*.test.js from the superproject clone
    // root, so the row carries the SUPERPROJECT commit and a path below a 160000 entry.
    const viaGitlink = cleanRow({ file_path: `${SUB}/src/s.test.ts` });
    expect(await asCommittedTestPath(harness, viaGitlink, localGitRunner)).toEqual({
      testPath: `${SUB}/src/s.test.ts`, repoPrefix: '', commitSha: superCommit,
    });
    // Descending the gitlink is not a free pass: a path absent at the PINNED submodule commit
    // still maps to nothing.
    expect(await asCommittedTestPath(harness, cleanRow({ file_path: `${SUB}/src/missing.test.ts` }), localGitRunner)).toBeNull();
    const bound = await expandTestRunBinding(input({ sourcePaths: [`${SUB}/src/s.ts`] }), SCOPE, binder(viaGitlink));
    expect(bound).toMatchObject({ ok: true });
  });

  it('maps a Cargo submodule cwd stamped with the superproject commit through its pinned gitlink', async () => {
    const recordedRoot = `${goneClone(superCommit)}/${SUB}`;
    const target = 'src/main.rs';
    expect(await asCommittedTestPath(harness, cleanRow({ root: recordedRoot, file_path: target }), localGitRunner))
      .toEqual({ testPath: `${SUB}/${target}`, repoPrefix: '', commitSha: superCommit });
    expect(await asCommittedTestPath(harness, cleanRow({ root: recordedRoot, file_path: 'src/missing.rs' }), localGitRunner))
      .toBeNull();
    const row = cleanRow({
      root: recordedRoot,
      framework: 'cargo',
      file_path: `${target}::native_console::tests::prepares_both_entrypoints`,
    });
    const bound = await expandTestRunBinding(input({
      canonicalTestPath: `${SUB}/src/native_console.rs`,
      sourcePaths: [`${SUB}/src/native_console.rs`],
    }), SCOPE, binder(row));
    expect(bound).toMatchObject({
      ok: true,
      binding: { evidenceRef: `${SUB}/src/native_console.rs`,
        details: { testRun: { asCommitted: { commitSha: superCommit, repoPrefix: '', measuredAtCommit: true } } } },
    });
  });

  it('never maps a dirty, commit-less, foreign-commit, absent-file or plain-directory run', async () => {
    expect(await asCommittedTestPath(harness, cleanRow({ worktree_dirty: true }), localGitRunner)).toBeNull();
    expect(await asCommittedTestPath(harness, cleanRow({ worktree_dirty: null }), localGitRunner)).toBeNull();
    expect(await asCommittedTestPath(harness, cleanRow({ commit_sha: null }), localGitRunner)).toBeNull();
    expect(await asCommittedTestPath(harness, cleanRow({ commit_sha: 'f'.repeat(40) }), localGitRunner)).toBeNull();
    expect(await asCommittedTestPath(harness, cleanRow({ file_path: 'pkg/lib/missing.test.ts' }), localGitRunner)).toBeNull();
    expect(await asCommittedTestPath(harness, cleanRow({ file_path: '../escape.test.ts' }), localGitRunner)).toBeNull();
    // `pkg` is a plain directory of the superproject, not a repository root: re-anchoring
    // `lib/x.test.ts` under it would invent a path the run never named.
    expect(await asCommittedTestPath(harness, cleanRow({ root: `${goneClone(superCommit)}/pkg`, file_path: 'lib/x.test.ts' }), localGitRunner)).toBeNull();
  });

  it('binds through expandTestRunBinding, records the mapping, and checks presence across a pinned gitlink', async () => {
    const row = cleanRow();
    const bound = await expandTestRunBinding(input({ sourcePaths: ['pkg/lib/x.ts', `${SUB}/src/s.ts`] }), SCOPE, binder(row));
    expect(bound).toMatchObject({ ok: true });
    if (!bound.ok) return;
    expect(bound.binding.evidenceRef).toBe('pkg/lib/x.test.ts');
    expect(bound.binding.details.testRun).toMatchObject({
      recordedRoot: row.root,
      asCommitted: { commitSha: superCommit, repoPrefix: '', measuredAtCommit: true },
    });
    expect(bound.binding.details.testRun).not.toHaveProperty('asCommitted.contentVerified');
    const subRow = cleanRow({ root: `${goneClone(subCommit)}/${SUB}`, file_path: 'src/s.test.ts', commit_sha: subCommit });
    expect(await expandTestRunBinding(input(), SCOPE, binder(subRow))).toMatchObject({
      ok: true,
      binding: { evidenceRef: `${SUB}/src/s.test.ts`, measurement: { sourcePaths: [`${SUB}/src/s.ts`] } },
    });
  });

  it('EI-25200724315817931: binds when a measured file here moved past the commit the clone ran (measured at the commit, D-001 b)', async () => {
    // The pre-fix contract refused here (`… differs from its content at …`), so a peer's
    // uncommitted edit to any measured file blocked every bind until git-sync committed it.
    const file = path.join(harness, 'pkg/lib/x.ts');
    await writeFile(file, 'export const x = 2;\n');
    try {
      const bound = await expandTestRunBinding(input(), SCOPE, binder(cleanRow()));
      expect(bound).toMatchObject({
        ok: true,
        binding: { details: { testRun: { asCommitted: { commitSha: superCommit, measuredAtCommit: true } } } },
      });
    } finally {
      await writeFile(file, 'export const x = 1;\n');
    }
  });

  it('still refuses a measured path outside the run repository, or absent at the run commit', async () => {
    const outside = await expandTestRunBinding(
      input({ sourcePaths: ['pkg/lib/x.ts'] }),
      SCOPE,
      binder(cleanRow({ root: `${goneClone(subCommit)}/${SUB}`, file_path: 'src/s.test.ts', commit_sha: subCommit })),
    );
    expect(outside).toMatchObject({ ok: false, error: 'test_run_as_committed_content_mismatch' });
    expect(outside.ok ? '' : outside.message).toContain(`lies outside the run's repository ${SUB}`);
    // A file that exists only in this checkout (added after the run's commit) names code the
    // run never had, so it can never be measured at that commit.
    const added = path.join(harness, 'pkg/lib/added-later.ts');
    await writeFile(added, 'export const later = 1;\n');
    try {
      const absent = await expandTestRunBinding(input({ sourcePaths: ['pkg/lib/added-later.ts'] }), SCOPE, binder(cleanRow()));
      expect(absent).toMatchObject({ ok: false, error: 'test_run_as_committed_content_mismatch' });
      expect(absent.ok ? '' : absent.message).toContain(`pkg/lib/added-later.ts is absent at ${superCommit.slice(0, 12)}`);
    } finally {
      await rm(added, { force: true });
    }
  });

  it.each(['timeout', 'launch failure', 'repository error'])('keeps a %s while checking committed source distinct from an absent file', async (failure) => {
    const deps = binder(cleanRow());
    deps.git = async (cwd, args) => {
      const sourceRead = args[0] === 'rev-parse'
        ? args.includes(`${superCommit}:pkg/lib/x.ts`)
        : args[0] === 'ls-tree' && ['pkg/lib/x.ts', 'pkg/lib', 'pkg'].includes(args.at(-1) ?? '');
      if (sourceRead) throw new Error(`git ${failure}: source probe unavailable`);
      return localGitRunner(cwd, args);
    };
    const refused = await expandTestRunBinding(input(), SCOPE, deps);
    expect(refused).toMatchObject({ ok: false, error: 'test_run_as_committed_probe_failed' });
    expect(refused.ok ? '' : refused.message).toContain(`git ${failure}: source probe unavailable`);
    expect(refused.ok ? '' : refused.message).not.toContain('is absent');
  });

  it('still refuses an unmappable clean run, naming the commit it checked', async () => {
    const refused = await expandTestRunBinding(input(), SCOPE, binder(cleanRow({ commit_sha: 'e'.repeat(40) })));
    expect(refused).toMatchObject({ ok: false, error: 'test_run_file_outside_root' });
    expect(refused.ok ? '' : refused.message).toContain(`Its clean commit ${'e'.repeat(12)} does not contain that file`);
  });

  describe('a CLEAN copy-out mutation row bound by canonicalTestPath is verified against its commit', () => {
    const mirrorRow = (over: Partial<TestRunEvidenceRow> = {}) =>
      cleanRow({
        root: path.join(tmpdir(), `mutation-probe-gone${process.pid}`, 'mirror', 'pkg'),
        file_path: 'lib/x.test.ts',
        source: 'mutation-probe',
        execution_details: { mutationPhase: 'mutant' },
        ...over,
      });
    const canonical = input({ canonicalTestPath: 'pkg/lib/x.test.ts', sourcePaths: ['pkg/lib/x.ts'] });

    it('binds measured at its commit when this checkout still holds the commit content', async () => {
      const bound = await expandTestRunBinding(canonical, SCOPE, binder(mirrorRow()));
      expect(bound).toMatchObject({ ok: true, binding: { evidenceKind: 'mutation', evidenceRef: expect.stringContaining('pkg/lib/x.test.ts') } });
      if (!bound.ok) return;
      expect(bound.binding.details.testRun).toMatchObject({
        canonicalTestPathOverride: 'pkg/lib/x.test.ts',
        asCommitted: { commitSha: superCommit, repoPrefix: '', measuredAtCommit: true },
      });
    });

    it('EI-25203325947467696: binds measured at its commit when a peer edited the subject here since the mutant ran', async () => {
      // WI-10004898 refused this case so the stored fingerprint could not describe the peer's
      // bytes. D-001 (b) removes that risk at the source — the fingerprint is read from git
      // objects at the run commit — so the refusal only blocked binds behind git-sync.
      const file = path.join(harness, 'pkg/lib/x.ts');
      await writeFile(file, 'export const x = 2;\n');
      try {
        const bound = await expandTestRunBinding(canonical, SCOPE, binder(mirrorRow()));
        expect(bound).toMatchObject({
          ok: true,
          binding: { evidenceKind: 'mutation', details: { testRun: { asCommitted: { commitSha: superCommit, measuredAtCommit: true } } } },
        });
        // A dirty or commit-less row proves no commit, so it keeps the checkout pin (and stays dirty evidence).
        expect(await expandTestRunBinding(canonical, SCOPE, binder(mirrorRow({ worktree_dirty: true })))).toMatchObject({ ok: true });
        expect(await expandTestRunBinding(canonical, SCOPE, binder(mirrorRow({ commit_sha: null })))).toMatchObject({ ok: true });
      } finally {
        await writeFile(file, 'export const x = 1;\n');
      }
    });

    describe('WI-10004978: a copy-out probe of a SUBMODULE file carries the submodule commit', () => {
      const subMirrorRow = (over: Partial<TestRunEvidenceRow> = {}) =>
        mirrorRow({
          root: path.join(tmpdir(), `mutation-probe-gone${process.pid}`, 'mirror', SUB),
          file_path: 'src/s.test.ts',
          commit_sha: subCommit,
          ...over,
        });
      const subCanonical = () =>
        input({ canonicalTestPath: `${SUB}/src/s.test.ts`, sourcePaths: [`${SUB}/src/s.ts`] });

      it('resolves the commit in the submodule checkout, not the superproject', async () => {
        const bound = await expandTestRunBinding(subCanonical(), SCOPE, binder(subMirrorRow()));
        expect(bound).toMatchObject({ ok: true, binding: { evidenceKind: 'mutation' } });
        if (!bound.ok) return;
        expect(bound.binding.details.testRun).toMatchObject({
          canonicalTestPathOverride: `${SUB}/src/s.test.ts`,
          asCommitted: { commitSha: subCommit, repoPrefix: SUB, measuredAtCommit: true },
        });
      });

      it('binds measured at the submodule commit when the submodule subject drifted since the mutant ran', async () => {
        const file = path.join(harness, SUB, 'src/s.ts');
        await writeFile(file, 'export const s = 2;\n');
        try {
          const bound = await expandTestRunBinding(subCanonical(), SCOPE, binder(subMirrorRow()));
          expect(bound).toMatchObject({
            ok: true,
            binding: { details: { testRun: { asCommitted: { commitSha: subCommit, repoPrefix: SUB, measuredAtCommit: true } } } },
          });
        } finally {
          await writeFile(file, 'export const s = 1;\n');
        }
      });

      it('a superproject commit still resolves through the gitlink it pins', async () => {
        const bound = await expandTestRunBinding(subCanonical(), SCOPE, binder(subMirrorRow({ commit_sha: superCommit })));
        expect(bound).toMatchObject({ ok: true });
        if (!bound.ok) return;
        expect(bound.binding.details.testRun).toMatchObject({
          asCommitted: { commitSha: superCommit, repoPrefix: '', measuredAtCommit: true },
        });
      });
    });
  });
});

// WI-10006610: a ledger row recorded in a registered SIBLING checkout (a hive app such as email,
// reached through a symlink) maps and measures at that checkout and names it in
// measurement.rootHarnessSlug, the way testing:run evidence already does — instead of being
// refused test_run_file_outside_root.
describe('expandTestRunBinding: registered sibling checkout (WI-10006610)', () => {
  const SIB_TEST = 'tests/seam.integration.test.ts';
  const SIB_SUBJECT = 'packages/core/src/service.ts';
  let sib = '';
  let linkDir = '';
  let link = '';

  beforeAll(async () => {
    sib = await realpath(await mkdtemp(path.join(tmpdir(), 'bind-sibling-')));
    await mkdir(path.join(sib, 'tests'), { recursive: true });
    await mkdir(path.join(sib, 'packages/core/src'), { recursive: true });
    await writeFile(path.join(sib, SIB_TEST), "import '../packages/core/src/service';\n");
    await writeFile(path.join(sib, SIB_SUBJECT), 'export const service = 1;\n');
    execFileSync('git', ['init', '-q', sib]);
    linkDir = await mkdtemp(path.join(tmpdir(), 'bind-sibling-link-'));
    link = path.join(linkDir, 'email');
    await symlink(sib, link);
  });

  afterAll(async () => {
    await rm(sib, { recursive: true, force: true });
    await rm(linkDir, { recursive: true, force: true });
  });

  function registry(extra: Record<string, unknown>[] = []) {
    const calls = { load: 0 };
    const load = async () => {
      calls.load += 1;
      return {
        projects: [
          { slug: 'web', path: root },
          { slug: 'email', path: link },
          ...extra,
        ],
      } as never;
    };
    return { load, calls };
  }

  const siblingRow = (over: Partial<TestRunEvidenceRow> = {}) =>
    run({
      root: sib,
      file_path: SIB_TEST,
      source: 'mutation-probe',
      execution_details: { collectionFailed: false, mutationPhase: 'mutant' },
      ...over,
    });

  function deps(row: TestRunEvidenceRow, load: ReturnType<typeof registry>['load']): TestRunBindingDeps {
    return {
      loadRun: async () => row,
      adoptRun: async () => true,
      resolveRoot: async () => root,
      resolveSiblingRoot: (scope, harnessRoot, recordedRoot) =>
        registeredSiblingCheckout(scope, harnessRoot, recordedRoot, load),
    };
  }

  it('resolves a root inside a registered sibling to the registry path, deepest checkout first', async () => {
    const { load } = registry([
      // An ancestor hive that also contains the sibling must lose to the deeper checkout.
      { slug: 'hive-home', harness_kind: 'hive', self_repo: true, path: path.dirname(sib) },
    ]);
    expect(await registeredSiblingCheckout(SCOPE, root, path.join(sib, 'packages/core'), load)).toEqual({
      root: link,
      harnessSlug: 'email',
    });
  });

  it('prefers a non-hive project over a repo-less hive sharing the same checkout', async () => {
    const { load } = registry([{ slug: 'email-hive', harness_kind: 'hive', self_repo: true, path: sib }]);
    expect(await registeredSiblingCheckout(SCOPE, root, sib, load)).toMatchObject({ harnessSlug: 'email' });
  });

  it('never consults the registry for a root inside the plan harness checkout, and is null outside every checkout', async () => {
    const { load, calls } = registry();
    expect(await registeredSiblingCheckout(SCOPE, root, path.join(root, 'libs/child'), load)).toBeNull();
    expect(await registeredSiblingCheckout(SCOPE, root, null, load)).toBeNull();
    expect(calls.load).toBe(0);
    const outside = await mkdtemp(path.join(tmpdir(), 'bind-unregistered-'));
    try {
      expect(await registeredSiblingCheckout(SCOPE, root, outside, load)).toBeNull();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
    const failing = async () => {
      throw new Error('registry down');
    };
    expect(await registeredSiblingCheckout(SCOPE, root, sib, failing)).toBeNull();
  });

  it('binds a mutation-probe row recorded in the sibling with paths relative to it and rootHarnessSlug set', async () => {
    const { load } = registry();
    const out = await expandTestRunBinding(input(), SCOPE, deps(siblingRow(), load));
    expect(out).toMatchObject({
      ok: true,
      binding: {
        evidenceKind: 'mutation',
        evidenceRef: expect.stringContaining(SIB_TEST),
        measurement: { rootHarnessSlug: 'email', testPaths: [SIB_TEST], sourcePaths: [SIB_SUBJECT] },
        details: { testRun: { recordedRoot: sib, recordedFilePath: SIB_TEST, rootHarnessSlug: 'email' } },
      },
    });
  });

  it('accepts a sibling row attributed to the exact registered sibling harness', async () => {
    const { load } = registry();
    const out = await expandTestRunBinding(input(), SCOPE, deps(siblingRow({ harness_slug: 'email' }), load));
    expect(out).toMatchObject({
      ok: true,
      attribution: 'run',
      binding: {
        evidenceKind: 'mutation',
        measurement: { rootHarnessSlug: 'email', testPaths: [SIB_TEST], sourcePaths: [SIB_SUBJECT] },
        details: { testRun: { recordedRoot: sib, rootHarnessSlug: 'email' } },
      },
    });
  });

  it('refuses a sibling root when its recorded harness slug names a different harness', async () => {
    const { load } = registry();
    const out = await expandTestRunBinding(input(), SCOPE, deps(siblingRow({ harness_slug: 'other-harness' }), load));
    expect(out).toMatchObject({ ok: false, error: 'test_run_out_of_scope' });
    if (!out.ok) expect(out.message).toContain("PAPERCUSP_TEST_RUN_HARNESS='web'");
  });

  it('accepts causal controls attributed to the same registered sibling harness', async () => {
    const { load } = registry();
    const controls = { baselineTestRunId: 10, copyBaselineTestRunId: 11, mutantTestRunId: 42 };
    const rows = new Map<number, TestRunEvidenceRow>([
      [42, siblingRow({ id: 42, harness_slug: 'email', status: 'fail', execution_details: { mutationPhase: 'mutant' } })],
      [10, siblingRow({ id: 10, harness_slug: 'email', execution_details: { mutationPhase: 'baseline' } })],
      [11, siblingRow({ id: 11, harness_slug: 'email', execution_details: { mutationPhase: 'copy-baseline' } })],
    ]);
    const out = await expandTestRunBinding(input({ details: { causalControls: controls } }), SCOPE, {
      loadRun: async (_scope, id) => rows.get(Number(id)) ?? null,
      adoptRun: async () => true,
      resolveRoot: async () => root,
      resolveSiblingRoot: (scope, harnessRoot, recordedRoot) =>
        registeredSiblingCheckout(scope, harnessRoot, recordedRoot, load),
    });
    expect(out).toMatchObject({
      ok: true,
      binding: {
        evidenceKind: 'mutation',
        measurement: { rootHarnessSlug: 'email' },
        details: { causalControls: controls },
      },
    });
  });

  it('keeps an in-harness run on the plan harness root, with no rootHarnessSlug', async () => {
    const { load } = registry();
    const out = await expandTestRunBinding(input(), SCOPE, deps(run(), load));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.binding.measurement).not.toHaveProperty('rootHarnessSlug');
      expect(out.binding.measurement.testPaths).toEqual([TEST]);
    }
  });

  it('still refuses the same sibling row when no sibling resolver is wired (the pre-fix behaviour)', async () => {
    const { resolveSiblingRoot: _omit, ...withoutSibling } = deps(siblingRow(), registry().load);
    expect(await expandTestRunBinding(input(), SCOPE, withoutSibling)).toMatchObject({
      ok: false,
      error: 'test_run_file_outside_root',
    });
  });
});

// WI-6554700010014813: every positive case above writes its files and then takes the default
// run start. If that start could land in the same millisecond as a write, those cases would
// fail intermittently (measured 29% on the nested-workspace case). Replay the fixture's own
// sequence (mkdir, two writes, stamp) enough times that a same-millisecond stamp is caught.
describe('fixture default run start', () => {
  it('is strictly after every fixture file written before it', async () => {
    const base = path.join(root, 'run-start-order');
    for (let i = 0; i < 200; i += 1) {
      const dir = path.join(base, String(i));
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'a.test.ts'), "import './b';\n");
      await writeFile(path.join(dir, 'b.ts'), 'export const b = 1;\n');
      const startedAt = runStartedAt();
      expect(await measuredFileModifiedAfterRun(dir, ['a.test.ts', 'b.ts'], startedAt)).toBeNull();
    }
  });
});

describe('testRunBindingSchema', () => {
  it('is strict: a hand-built field alongside fromTestRun is rejected rather than silently dropped', () => {
    expect(testRunBindingSchema.safeParse({ workItemId: 'WI-1', specId: 'S', fromTestRun: 1, evidenceRef: 'x' }).success).toBe(false);
    expect(testRunBindingSchema.safeParse({ workItemId: 'WI-1', fromTestRun: 1 }).success).toBe(false);
  });

  it('requires fixture provenance before the first immutable calibration bind', () => {
    const unclassified = testRunBindingSchema.safeParse({
      workItemId: 'WI-1',
      specId: 'SPEC-1',
      fromTestRun: 42,
    });
    expect(unclassified.success).toBe(true);
    if (unclassified.success) expect(unclassified.data.details).toBeUndefined();

    const missing = testRunBindingSchema.safeParse({
      workItemId: 'WI-1',
      specId: 'SPEC-1',
      fromTestRun: 42,
      details: { adequacy: { fixtureCalibrated: true } },
    });
    expect(missing.success).toBe(false);
    if (!missing.success) {
      expect(missing.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ['fixturePaths'],
          message: expect.stringContaining('requires fixturePaths or fixtureGlobs on the first bind'),
        }),
      ]));
    }

    for (const recipe of [
      { fixturePaths: ['pkg/lib/thing.test.ts'] },
      { fixtureGlobs: ['pkg/lib/__fixtures__/**/*.ts'] },
    ]) {
      expect(testRunBindingSchema.safeParse({
        workItemId: 'WI-1',
        specId: 'SPEC-1',
        fromTestRun: 42,
        ...recipe,
        details: { adequacy: { fixtureCalibrated: true } },
      }).success).toBe(true);
    }
  });
});
