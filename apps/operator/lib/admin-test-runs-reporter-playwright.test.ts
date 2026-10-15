/**
 * Regression guard for WI-6751.
 *
 * The Playwright reporter must attribute a run to its close-time commit and
 * mark it dirty whenever the shared worktree changed while the run was live.
 * A cached resolveGitContext() commit is display metadata, not provenance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareVerifierSource } from '../../../scripts/source-preview.mjs';
import { makeSuperproject, write } from '../../../packages/operator-core/lib/source-preview.fixture';

const mocks = vi.hoisted(() => ({
  captureWorktreeSnapshot: vi.fn(),
  computeWorktreeDirty: vi.fn(),
  captureTestSourceSnapshot: vi.fn(),
  resolveReporterSourceRoot: vi.fn(),
  resolveAgentWorkspaceRoot: vi.fn<(ctx?: { projectDir?: string }) => string>(() => '/repo'),
  resolveGitContext: vi.fn(async () => ({ branch: 'staging', commit: 'stale-cached-sha' })),
  resolveTestRunSource: vi.fn(() => 'admin-ui'),
  // postgres.js tagged-template shape: (strings, ...values) => rows.
  sql: vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]): Promise<Array<{ id: number }>> => []),
}));

vi.mock('@papercusp/operator-core/lib/testing-worktree', () => ({
  captureWorktreeSnapshot: mocks.captureWorktreeSnapshot,
  computeWorktreeDirty: mocks.computeWorktreeDirty,
  captureTestSourceSnapshot: mocks.captureTestSourceSnapshot,
  resolveReporterSourceRoot: mocks.resolveReporterSourceRoot,
}));
vi.mock('@papercusp/operator-core/lib/agent-tools/capability/base-dir', () => ({
  resolveAgentWorkspaceRoot: mocks.resolveAgentWorkspaceRoot,
}));
vi.mock('@papercusp/operator-core/lib/testing-branch-resolve', () => ({
  resolveGitContext: mocks.resolveGitContext,
}));
vi.mock('@papercusp/operator-core/lib/testing-run-source', () => ({
  resolveTestRunSource: mocks.resolveTestRunSource,
}));
vi.mock('postgres', () => ({ default: () => mocks.sql }));

import AdminTestRunsPlaywrightReporter, {
  playwrightCaseTitle,
  playwrightExecutionDetails,
} from '../test/reporters/admin-test-runs-reporter-playwright';
import { parseTestRunExecutionDetails, recordedTestLayer } from '@papercusp/test-config/execution-details';

describe('AdminTestRunsPlaywrightReporter worktree provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAgentWorkspaceRoot.mockImplementation(() => '/repo');
    mocks.resolveReporterSourceRoot.mockImplementation((root?: string) => mocks.resolveAgentWorkspaceRoot(root ? { projectDir: root } : {}));
    mocks.captureTestSourceSnapshot.mockImplementation((root: string) => mocks.captureWorktreeSnapshot(root));
    delete process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER;
    delete process.env.PAPERCUSP_TEST_RUN_GROUP;
    delete process.env.PAPERCUSP_TEST_RUN_HARNESS;
    delete process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE;
    delete process.env.PAPERCUSP_WORKSPACE_ID;
  });

  it('writes confirmed Playwright mutation-probe row ids to the probe receipt file', async () => {
    const receiptDir = mkdtempSync(join(tmpdir(), 'playwright-test-run-receipt-'));
    const receiptFile = join(receiptDir, 'receipts.jsonl');
    try {
      vi.stubEnv('PAPERCUSP_TEST_RUN_RECEIPT_FILE', receiptFile);
      vi.stubEnv('PAPERCUSP_MUTATION_PROBE', '1');
      vi.stubEnv('PAPERCUSP_MUTATION_PHASE', 'mutant');
      mocks.captureWorktreeSnapshot.mockReturnValue({ commit: 'sha', porcelain: '' });
      mocks.computeWorktreeDirty.mockReturnValue(false);
      mocks.sql.mockResolvedValueOnce([{ id: 20923588 }]);

      const reporter = new AdminTestRunsPlaywrightReporter();
      await reporter.onBegin();
      reporter.onTestEnd(
        { location: { file: '/repo/e2e/width.spec.ts' } } as never,
        { startTime: new Date(0), duration: 5, status: 'failed', errors: [{ message: 'overflow expected false, received true' }] } as never,
      );
      await reporter.onEnd();
      await reporter.onExit();

      expect(process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE).toBe(receiptFile);
      expect(mocks.sql).toHaveBeenCalledTimes(1);
      expect(readFileSync(receiptFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual([
        { filePath: 'e2e/width.spec.ts', status: 'fail', outcome: 'inserted', id: '20923588' },
      ]);
      expect(mocks.sql.mock.calls[0]![0].join('')).toContain('RETURNING id');
    } finally {
      vi.unstubAllEnvs();
      rmSync(receiptDir, { recursive: true, force: true });
    }
  });

  it('persists synchronous Git failure diagnostics with the fail-closed dirty verdict', async () => {
    mocks.captureWorktreeSnapshot.mockReturnValueOnce({ commit: 'sha', porcelain: null,
      provenanceError: 'git status failed after 2001ms (budget=2000ms, code=ETIMEDOUT, signal=SIGTERM)' })
      .mockReturnValueOnce({ commit: 'sha', porcelain: '' });
    mocks.computeWorktreeDirty.mockReturnValue(true);
    const reporter = new AdminTestRunsPlaywrightReporter();
    reporter.onBegin();
    reporter.onTestEnd({ location: { file: '/repo/specs/example.spec.ts' } } as never,
      { startTime: new Date(), duration: 1, status: 'passed', errors: [] } as never);
    await reporter.onEnd();
    await reporter.onExit();
    const values = mocks.sql.mock.calls[0]!.slice(1);
    expect(values.at(-2)).toBe(true);
    expect(values).toContainEqual(expect.stringContaining('code=ETIMEDOUT'));
  });

  it('uses the post-run commit and persists a dirty verdict from the before/after snapshots', async () => {
    const before = { commit: 'before-sha', porcelain: '' };
    const after = { commit: 'after-sha', porcelain: ' M peer-edit.ts' };
    mocks.captureWorktreeSnapshot.mockReturnValueOnce(before).mockReturnValueOnce(after);
    mocks.computeWorktreeDirty.mockReturnValue(true);

    const reporter = new AdminTestRunsPlaywrightReporter();
    const startedAt = new Date('2026-08-21T00:00:00.000Z');
    await reporter.onBegin();
    reporter.onTestEnd(
      { location: { file: '/repo/specs/example.spec.ts' } } as never,
      { startTime: startedAt, duration: 17, status: 'passed', errors: [] } as never,
    );
    await reporter.onEnd();
    await reporter.onExit();

    expect(mocks.captureWorktreeSnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.computeWorktreeDirty).toHaveBeenCalledWith(before, after);
    expect(mocks.sql).toHaveBeenCalledTimes(1);

    const values = mocks.sql.mock.calls[0]!.slice(1);
    expect(values[0]).toBe('specs/example.spec.ts');
    // `playwright` is a SQL-template literal, so commit_sha is value slot 9.
    expect(values[9]).toBe('after-sha');
    expect(values).not.toContain('stale-cached-sha');
    // worktree_dirty precedes execution_details (EI-24434635346407728).
    expect(values.at(-2)).toBe(true);

    // The persisted execution_details must parse through the SAME reader the
    // acceptance-bar layer check uses, and must say e2e — otherwise no Playwright
    // run can ever satisfy a BAR clause whose requiredTestLayers includes e2e.
    // EI-24799048791133095: the jsonb param is the OBJECT, never pre-stringified
    // text (postgres-js would encode that twice into a jsonb STRING scalar).
    const stored = values.at(-1);
    expect(typeof stored).toBe('object');
    expect(parseTestRunExecutionDetails(stored)).toBeDefined();
    expect(recordedTestLayer(stored)).toBe('e2e');
    expect(stored).toMatchObject({
      filePath: 'specs/example.spec.ts',
      commitSha: 'after-sha',
      worktreeDirty: true,
      passed: 1,
      failed: 0,
      skipped: 0,
    });
  });

  it('records the actual isolated Playwright checkout despite an ambient agent tree', async () => {
    mocks.resolveAgentWorkspaceRoot.mockImplementation((ctx?: { projectDir?: string }) => ctx?.projectDir ? '/proof' : '/repo');
    const snapshot = { commit: 'proof-sha', porcelain: '' };
    mocks.captureWorktreeSnapshot.mockReturnValue(snapshot);
    mocks.computeWorktreeDirty.mockReturnValue(false);
    const reporter = new AdminTestRunsPlaywrightReporter();
    await reporter.onBegin({ rootDir: '/proof/apps/operator/e2e' });
    reporter.onTestEnd(
      { location: { file: '/proof/apps/operator/e2e/tutorial.spec.ts' } } as never,
      { startTime: new Date(0), duration: 17, status: 'passed', errors: [] } as never,
    );
    await reporter.onEnd();
    await reporter.onExit();
    expect(mocks.captureWorktreeSnapshot.mock.calls).toEqual([['/proof'], ['/proof']]);
    const values = mocks.sql.mock.calls[0]!.slice(1);
    expect(values[0]).toBe('apps/operator/e2e/tutorial.spec.ts');
    expect(values[9]).toBe('proof-sha');
    expect(values.at(-1)).toMatchObject({ root: '/proof', commitSha: 'proof-sha', worktreeDirty: false });
    expect(mocks.resolveGitContext).not.toHaveBeenCalled();
  });

  it.each([
    [{ commit: null, porcelain: '' }, { commit: 'sha', porcelain: '' }, 'HEAD unreadable'],
    [{ commit: 'sha', porcelain: '' }, { commit: 'sha', porcelain: null }, 'git status unreadable after'],
    [{ commit: 'before', porcelain: '' }, { commit: 'after', porcelain: '' }, 'HEAD moved before -> after'],
    [{ commit: 'sha', porcelain: ' M source.ts' }, { commit: 'sha', porcelain: '' }, 'before the run:  M source.ts'],
    [{ commit: 'sha', porcelain: '' }, { commit: 'sha', porcelain: '?? generated.json' }, 'after the run: ?? generated.json'],
  ])('retains the dirty snapshot cause in the existing output field (%s)', async (before, after, reason) => {
    mocks.captureWorktreeSnapshot.mockReturnValueOnce(before).mockReturnValueOnce(after);
    mocks.computeWorktreeDirty.mockReturnValue(true);
    const reporter = new AdminTestRunsPlaywrightReporter();
    await reporter.onBegin();
    reporter.onTestEnd({ location: { file: '/repo/e2e/example.spec.ts' } } as never,
      { startTime: new Date(0), duration: 1, status: 'failed', errors: [{ message: 'original assertion failure' }] } as never);
    await reporter.onEnd();
    await reporter.onExit();
    const values = mocks.sql.mock.calls[0]!.slice(1);
    expect(values[5]).toContain('original assertion failure');
    expect(values[5]).toContain(reason);
    expect(values[5]).toContain('[worktree provenance]');
    expect(values.at(-2)).toBe(true);
    const details = parseTestRunExecutionDetails(values.at(-1));
    expect(details).toMatchObject({ worktreeDirty: true });
    expect(details).not.toHaveProperty('worktreeDirtyReason');
  });

  it('does not add diagnostics to clean runs', async () => {
    mocks.captureWorktreeSnapshot.mockReturnValue({ commit: 'sha', porcelain: '' });
    mocks.computeWorktreeDirty.mockReturnValue(false);
    const reporter = new AdminTestRunsPlaywrightReporter();
    await reporter.onBegin();
    reporter.onTestEnd({ location: { file: '/repo/e2e/example.spec.ts' } } as never,
      { startTime: new Date(0), duration: 1, status: 'passed', errors: [] } as never);
    await reporter.onEnd();
    await reporter.onExit();
    expect(mocks.sql.mock.calls[0]!.slice(1)[5]).toBeNull();
  });

  // WI-10006806: a filed red names its failing tests, so the row must carry the case identities.
  it('keeps passing and failing case identities separate in execution_details', async () => {
    mocks.captureWorktreeSnapshot.mockReturnValue({ commit: 'sha', porcelain: '' });
    mocks.computeWorktreeDirty.mockReturnValue(false);
    const reporter = new AdminTestRunsPlaywrightReporter();
    await reporter.onBegin();
    const file = '/repo/e2e/example.spec.ts';
    const kase = (title: string, describe = 'panel') => ({
      location: { file },
      title,
      titlePath: () => ['', 'chromium', 'e2e/example.spec.ts', describe, title],
    });
    reporter.onTestEnd(kase('opens') as never, { startTime: new Date(0), duration: 1, status: 'passed', errors: [] } as never);
    reporter.onTestEnd(kase('closes') as never, { startTime: new Date(0), duration: 1, status: 'failed', errors: [{ message: 'boom' }] } as never);
    // A retry of the same case is ONE identity, not two.
    reporter.onTestEnd(kase('closes') as never, { startTime: new Date(0), duration: 1, status: 'timedOut', errors: [] } as never);
    await reporter.onEnd();
    await reporter.onExit();
    const stored = mocks.sql.mock.calls[0]!.slice(1).at(-1);
    const parsed = parseTestRunExecutionDetails(stored);
    expect(parsed).toBeDefined();
    expect(parsed).toMatchObject({ failed: 2, passed: 1, failedCaseTitles: ['panel > closes'], passedCaseTitles: ['panel > opens'] });
  });
  it('persists the normalized successful case once across retries for acceptance checks', async () => {
    mocks.captureWorktreeSnapshot.mockReturnValue({ commit: 'sha', porcelain: '' });
    mocks.computeWorktreeDirty.mockReturnValue(false);
    const reporter = new AdminTestRunsPlaywrightReporter();
    await reporter.onBegin();
    const kase = { location: { file: '/repo/e2e/example.spec.ts' }, title: 'opens audit', titlePath: () => ['', 'chromium', 'example.spec.ts', 'plans', 'opens audit'] };
    for (let n = 0; n < 2; n++) reporter.onTestEnd(kase as never, { startTime: new Date(0), duration: 1, status: 'passed', errors: [] } as never);
    await reporter.onEnd();await reporter.onExit();
    const stored = mocks.sql.mock.calls[0]!.slice(1).at(-1);
    expect(parseTestRunExecutionDetails(stored)).toMatchObject({ passed: 2, failed: 0, testLayer: 'e2e', passedCaseTitles: ['plans > opens audit'] });
  });
});

describe('WI-10007182 committed archive reporter provenance', () => {
  let temp: string;
  let root: string;
  let receiptPath: string;
  let commit: string;
  const input = 'apps/operator/src/index.ts';

  beforeEach(async () => {
    vi.clearAllMocks();
    temp = mkdtempSync(join(tmpdir(), 'playwright-archive-'));
    const fixture = makeSuperproject(join(temp, 'fixture'));
    root = join(temp, 'archive');
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest: root, inputs: [input] });
    commit = fixture.commit;
    receiptPath = join(temp, 'receipt.json');
    writeFileSync(receiptPath, JSON.stringify(receipt));
    vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', receiptPath);
    const actual = await vi.importActual<typeof import('../../../packages/operator-core/lib/testing-worktree')>('@papercusp/operator-core/lib/testing-worktree');
    const base = await vi.importActual<typeof import('../../../packages/operator-core/lib/agent-tools/capability/base-dir')>('@papercusp/operator-core/lib/agent-tools/capability/base-dir');
    mocks.resolveAgentWorkspaceRoot.mockImplementation(ctx => base.resolveAgentWorkspaceRoot(ctx ?? {}));
    mocks.captureWorktreeSnapshot.mockImplementation(actual.captureWorktreeSnapshot);
    mocks.computeWorktreeDirty.mockImplementation(actual.computeWorktreeDirty);
    mocks.resolveReporterSourceRoot.mockImplementation(actual.resolveReporterSourceRoot);
    mocks.captureTestSourceSnapshot.mockImplementation(actual.captureTestSourceSnapshot);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(temp, { recursive: true, force: true });
  });

  async function record(mutate?: () => void) {
    const reporter = new AdminTestRunsPlaywrightReporter();
    await reporter.onBegin({ rootDir: join(root, 'apps/operator/e2e') });
    mutate?.();
    reporter.onTestEnd({ location: { file: join(root, input) } } as never,
      { startTime: new Date(0), duration: 1, status: 'passed', errors: [] } as never);
    await reporter.onEnd();
    await reporter.onExit();
    return mocks.sql.mock.calls[0]!.slice(1);
  }

  it('records the archive repository root and verified commit without Git', async () => {
    const values = await record();
    expect(values[0]).toBe(input);
    expect(values[9]).toBe(commit);
    expect(values.at(-1)).toMatchObject({ root, filePath: input, commitSha: commit, worktreeDirty: false });
  });

  it('keeps materialized dependencies and named runtime output outside the source verdict', async () => {
    // Equivalent to Git-ignored runtime data; this verdict does not attest dependency bytes.
    write(root, 'apps/operator-vite/node_modules/example/index.js', 'frozen dependency');
    write(root, 'apps/operator/dist-verify/hono-host.mjs', 'built host');
    write(root, 'apps/operator/test-results/result.json', '{}');
    expect((await record()).at(-1)).toMatchObject({ root, commitSha: commit, worktreeDirty: false });
  });

  it.each(['source', 'extra', 'manifest', 'receipt', 'missing-receipt'])('fails closed when %s changes during execution', async (kind) => {
    const values = await record(() => {
      if (kind === 'source') writeFileSync(join(root, input), 'changed source');
      if (kind === 'extra') write(root, 'apps/operator/new-source.ts', 'extra source');
      if (kind === 'manifest') writeFileSync(join(root, '.verifier-source.json'), '{}');
      if (kind === 'receipt') {
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
        receipt.sourceCommit = 'a'.repeat(40);
        writeFileSync(receiptPath, JSON.stringify(receipt));
      }
      if (kind === 'missing-receipt') rmSync(receiptPath);
    });
    expect(values.at(-2)).toBe(true);
    expect(values[5]).toContain('[worktree provenance]');
  });

  it.each(['missing', 'inside'])('fails closed on an invalid %s receipt before execution', async kind => {
    if (kind === 'missing') vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', undefined);
    else {
      const inside = join(root, 'receipt.json');
      writeFileSync(inside, readFileSync(receiptPath));
      vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', inside);
    }
    const values = await record();
    expect(values.at(-2)).toBe(true);
    expect(values[9]).toBeNull();
    expect(values[5]).toContain(kind === 'missing'
      ? 'missing independent verifier source receipt' : 'receipt must be outside the archive');
  });

  it.each(['apps/operator', 'packages/operator-core'])('seals the archive before tests through the native %s Playwright loader', owner => {
    const repo = resolve(import.meta.dirname, '../../..');
    const child = spawnSync(process.execPath, ['-e', `
      const { dirname, join } = require('node:path');
      const playwrightRoot = dirname(require.resolve('playwright/package.json'));
      const transform = require(join(playwrightRoot, 'lib/transform/transform.js'));
      const { loadConfig } = require(join(playwrightRoot, 'lib/common/configLoader.js'));
      (async () => {
        // Initialize both native CJS and ESM transforms, as the runner does.
        await loadConfig({ configDir: process.argv[1] }, { tsconfig: join(process.argv[1], 'apps/operator/tsconfig.json') });
        const { default: Reporter } = await transform.requireOrImport(join(process.argv[1], process.argv[3], 'test/reporters/admin-test-runs-reporter-playwright.ts'));
        const reporter = new Reporter();
        const returned = reporter.onBegin({ rootDir: join(process.argv[2], 'apps/operator/e2e') });
        process.stdout.write(JSON.stringify({ before: reporter.worktreeBefore, async: !!returned?.then }));
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `, repo, root, owner], { cwd: repo, env: { ...process.env, VERIFY_TAURI_SOURCE_RECEIPT: receiptPath },
      encoding: 'utf8', timeout: 20_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ before: { commit, porcelain: '' }, async: false });
  });
});

describe('playwrightCaseTitle', () => {
  it('drops the root, project and file segments and joins the rest like Vitest fullName', () => {
    expect(playwrightCaseTitle({ title: 't', titlePath: () => ['', 'chromium', 'e2e/a.spec.ts', 'outer', 'inner', 't'] })).toBe(
      'outer > inner > t',
    );
  });
  it('falls back to the bare title when no titlePath is available, and rejects an empty identity', () => {
    expect(playwrightCaseTitle({ title: 'bare' })).toBe('bare');
    expect(playwrightCaseTitle({})).toBeNull();
  });
});

describe('playwrightExecutionDetails', () => {
  afterEach(() => vi.unstubAllEnvs());

  const failedBrowserRow = {
    filePath: 'apps/operator/e2e/width.spec.ts', status: 'fail' as const,
    durationMs: 5, startedAt: new Date(0), finishedAt: new Date(5),
    outputTail: null, worktreeDirty: false, passed: 0, failed: 1, skipped: 0,
    failedCaseTitles: ['mobile layout > rejects horizontal overflow'],
  };
  const browserRun = { root: '/repo', runGroupId: 'width-proof',
    workspaceId: 'w1', harnessSlug: 'papercusp', commitSha: 'abc' };

  it.each(['baseline', 'unmutated-copy', 'mutant'])('preserves the runtime %s mutation phase with the e2e case identity', (phase) => {
    vi.stubEnv('PAPERCUSP_MUTATION_PROBE', '1');
    vi.stubEnv('PAPERCUSP_MUTATION_PHASE', ` ${phase} `);
    const details = playwrightExecutionDetails(failedBrowserRow, browserRun);
    expect(parseTestRunExecutionDetails(details)).toMatchObject({
      testLayer: 'e2e', mutationPhase: phase, failed: 1, skipped: 0,
      failedCaseTitles: ['mobile layout > rejects horizontal overflow'],
    });
  });

  it('keeps an ordinary browser failure outside the mutation cohort even with a stale phase variable', () => {
    vi.stubEnv('PAPERCUSP_MUTATION_PROBE', '');
    vi.stubEnv('PAPERCUSP_MUTATION_PHASE', 'mutant');
    expect(playwrightExecutionDetails(failedBrowserRow, browserRun).mutationPhase).toBeNull();
  });

  it('stamps the e2e runtime layer with counts that the shared parser accepts', () => {
    const details = playwrightExecutionDetails(
      {
        filePath: 'apps/operator/e2e/x.spec.ts',
        status: 'fail',
        durationMs: 5,
        startedAt: new Date(0),
        finishedAt: new Date(5),
        outputTail: null,
        worktreeDirty: false,
        passed: 2,
        failed: 1,
        skipped: 3,
      },
      { root: '/repo', runGroupId: 'g1', workspaceId: 'w1', harnessSlug: 'papercusp', commitSha: 'abc' },
    );
    expect(details.testLayer).toBe('e2e');
    const parsed = parseTestRunExecutionDetails(details);
    expect(parsed).toBeDefined();
    expect(recordedTestLayer(details)).toBe('e2e');
    expect(parsed).toMatchObject({ passed: 2, failed: 1, skipped: 3, collectionFailed: false, commitSha: 'abc' });
  });
});
