import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION, parseTestRunExecutionDetails } from '@papercusp/test-config/execution-details';
import { judgePortalPlaywrightRows, mergeCriterionTestRuns, partitionCriterionTestFiles, playwrightRecordedCases,
  resolveCriterionTestRoute, runPortalPlaywrightChecks } from './rubrics-playwright-checks';
import { evaluateCriterionTestChecks, runCriterionCheckFiles, validateCriterionCheckPaths } from './rubrics-criterion-checks';
import type { HarnessTestRunEvidence } from './testing-run-store';
import type { RouterOutcome } from './agent-tools/testing/run';

const workspace = mkdtempSync(join(tmpdir(), 'rubric-playwright-'));
const root = join(workspace, 'portal');
const ambient = join(workspace, 'papercusp');
const file = 'e2e/portal-billing.spec.ts';
const absolute = join(root, file);
const pw = ['@playwright', 'test'].join('/');
const reporter = '@papercusp/operator-core/lib/testing-playwright-reporter';
const config = `import { defineConfig } from '${pw}';
function portalBrowserReporters() { return [["${reporter}"]]; }
export default defineConfig({ testDir: './e2e', testMatch: /portal-billing\\.spec\\.ts$/,
  reporter: portalBrowserReporters(), workers: 1 });`;
mkdirSync(join(root, 'e2e'), { recursive: true });
mkdirSync(join(root, '.git'));
mkdirSync(ambient);
writeFileSync(join(ambient, 'package.json'), JSON.stringify({ workspaces: [] }));
mkdirSync(join(ambient, '.git'));
const packageJson = { name: '@papercusp-portal/app', workspaces: ['packages/*'],
  scripts: { 'test:e2e:browser': 'playwright test --config=playwright.config.ts' } };
writeFileSync(join(root, 'package.json'), JSON.stringify(packageJson));
writeFileSync(join(root, 'playwright.config.ts'), config);
writeFileSync(absolute, `import { test } from '${pw}'; test('billing', () => {});`);
writeFileSync(join(ambient, 'unit.test.ts'), 'export {};');
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

const scope = { workspaceId: 'ws-test', harnessSlug: 'portal', runId: 'request-group' };
function row(overrides: Partial<HarnessTestRunEvidence> = {}, details: Record<string, unknown> = {}): HarnessTestRunEvidence {
  return { id: 41, framework: 'playwright', file_path: file, status: 'pass', finished_at: '2026-10-20T21:00:00Z',
    workspace_id: scope.workspaceId, harness_slug: scope.harnessSlug, run_group_id: scope.runId,
    commit_sha: 'a'.repeat(40), worktree_dirty: false, execution_details: {
      schemaVersion: TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION, root, filePath: file,
      runGroupId: scope.runId, workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug,
      testNamePattern: null, mutationPhase: null, testLayer: 'e2e', passed: 1, failed: 0, skipped: 0,
      collectionFailed: false, commitSha: 'a'.repeat(40), worktreeDirty: false, passedCaseTitles: ['billing > denies a foreign workspace'], ...details,
    }, ...overrides };
}
const judge = (rows: HarnessTestRunEvidence[] | null) => judgePortalPlaywrightRows({ ...scope, route: { root, files: [file] }, rows });

describe('maintained Portal Playwright executor ownership', () => {
  it('admits the exact config-selected Portal spec at validation, including sibling spelling', () => {
    expect(resolveCriterionTestRoute(absolute)).toEqual({ kind: 'portal-playwright', root, file });
    expect(validateCriterionCheckPaths([{ key: 'browser', check: { kind: 'tests', files: ['e2e/portal-billing.spec.ts'] } }], { root }).ok).toBe(true);
    expect(validateCriterionCheckPaths([{ key: 'browser', check: { kind: 'tests', files: ['portal/e2e/portal-billing.spec.ts'] } }], { root: ambient }).ok).toBe(true);
  });
  it('keeps native and config-unmatched specs refused before running', () => {
    const native = join(root, 'e2e/native.spec.ts');
    writeFileSync(native, `import { test } from '${pw}';`);
    expect(resolveCriterionTestRoute(native).kind).toBe('unsupported');
    expect(() => partitionCriterionTestFiles([absolute, native], root)).toThrow('supported maintained Portal');
  });
  it.each([
    config.replace("testDir: './e2e'", "testDir: './native'"),
    config.replace('workers: 1', "projects: [], workers: 1"),
    config.replace('workers: 1', "...extra, workers: 1"),
    config.replace('portalBrowserReporters(), workers', "[], workers"),
  ])('refuses unsupported or ambiguous config ownership', candidate => {
    writeFileSync(join(root, 'playwright.config.ts'), candidate);
    try { expect(resolveCriterionTestRoute(absolute).kind).toBe('unsupported'); }
    finally { writeFileSync(join(root, 'playwright.config.ts'), config); }
  });
  it('partitions mixed files by executor with the Portal checkout as its root', () => {
    expect(partitionCriterionTestFiles(['unit.test.ts', absolute], ambient)).toEqual([
      { kind: 'vitest', root: ambient, files: ['unit.test.ts'] },
      { kind: 'portal-playwright', root, files: [absolute] },
    ]);
  });
});

describe('exact Playwright reporter evidence', () => {
  it('preserves numeric run IDs and uniquely recorded cases', () => {
    expect(judge([row()])).toMatchObject({ ok: true, passed: 1, failed: 0, testRunIds: [41],
      casesByFile: { [absolute]: [{ caseKey: 'billing > denies a foreign workspace', occurrence: 0, status: 'pass' }] },
      testRunIdsByFile: { [absolute]: [41] } });
  });
  it.each([null, [], [row(), row({ id: 42 })], [row(), row()]])('refuses missing or duplicate receipts', rows => {
    expect(judge(rows).error).toBe('no_report');
  });
  it.each([
    { framework: 'vitest' }, { finished_at: null }, { finished_at: 'invalid' }, { workspace_id: 'foreign' },
    { harness_slug: 'foreign' }, { run_group_id: 'stale' }, { file_path: 'e2e/unrequested.spec.ts' },
    { status: 'skip' }, { status: 'cancelled' }, { commit_sha: 'b'.repeat(40) }, { worktree_dirty: true },
    { execution_details: '{invalid-json' },
  ])('rejects a foreign, contradictory or malformed row: %j', overrides => {
    expect(judge([row(overrides)]).error).toBe('no_report');
  });
  it.each([
    { root: ambient }, { filePath: 'other.spec.ts' }, { runGroupId: 'stale' }, { workspaceId: 'foreign' },
    { harnessSlug: 'foreign' }, { testLayer: 'unit' }, { testNamePattern: 'narrowed' },
    { mutationPhase: 'mutant' }, { collectionFailed: true }, { passed: 0, passedCaseTitles: [] }, { failed: -1 },
  ])('rejects invalid or unexecuted details: %j', details => {
    expect(judge([row({}, details)]).error).toBe('no_report');
  });
  it.each([
    { passed: 2 }, { passedCaseTitlesTruncated: true },
    { failed: 1, failedCaseTitles: ['billing > denies a foreign workspace'] },
  ])('does not fabricate named-case occurrences from incomplete or retry-collapsed titles', change => {
    const details = parseTestRunExecutionDetails(row({}, change).execution_details);
    expect(details ? playwrightRecordedCases(details) : null).toBeNull();
  });
});

describe('governed Playwright invocation', () => {
  const success: RouterOutcome = { code: 0, signal: null, timedOut: false, aborted: false, output: '' };
  const options = { root, files: [absolute], ...scope, actorId: 'su-authenticated', timeoutMs: 45000 };
  const deps = (outcome = success) => ({ process: vi.fn().mockResolvedValue(outcome),
    readRows: vi.fn().mockResolvedValue([row()]), mutationFence: vi.fn().mockResolvedValue(null),
    restrictedFence: vi.fn().mockResolvedValue(null) });
  it('uses the maintained script with literal filters, reporter and concrete scope', async () => {
    const injected = deps();
    expect(await runPortalPlaywrightChecks(options, injected)).toMatchObject({ ok: true, testRunIds: [41] });
    const call = injected.process.mock.calls[0]!;
    expect(call.slice(0, 5)).toEqual(['npm', ['run', 'test:e2e:browser', '--'],
      ['--retries=0', '--workers=1', '--forbid-only', '(?:^|/)e2e/portal-billing\\.spec\\.ts$'], root, root]);
    expect(call[5]).toMatchObject({ CI: '1', PAPERCUSP_DISABLE_TEST_RUNS_REPORTER: '0',
      PAPERCUSP_TEST_RUN_GROUP: scope.runId, PAPERCUSP_TEST_RUN_HARNESS: scope.harnessSlug, PAPERCUSP_WORKSPACE_ID: scope.workspaceId });
    expect(call[6]).toBeGreaterThan(0);
    expect(call[6]).toBeLessThanOrEqual(45000);
    expect(injected.readRows).toHaveBeenCalledWith(expect.objectContaining({ runGroupId: scope.runId, workspaceId: scope.workspaceId }));
  });
  it.each([
    { code: 1 }, { code: null }, { signal: 'SIGTERM' as const }, { timedOut: true }, { aborted: true },
    { spawnError: 'spawn failed' }, { terminationUnconfirmed: true, taskId: 'still-settling' },
  ])('refuses process failure even with green rows: %j', async change => {
    const injected = deps({ ...success, ...change });
    const result = await runPortalPlaywrightChecks(options, injected);
    expect(result.error).toBeDefined();
    expect(injected.readRows).not.toHaveBeenCalled();
  });
  it('does not spawn without authenticated concrete scope or across a held fence', async () => {
    const injected = deps();
    expect((await runPortalPlaywrightChecks({ ...options, actorId: undefined }, injected)).error).toBe('route_error');
    injected.restrictedFence.mockResolvedValue({ error: 'restricted_write_held' });
    expect((await runPortalPlaywrightChecks(options, injected)).error).toBe('restricted_write_held');
    expect(injected.process).not.toHaveBeenCalled();
  });
  it.each([file, 'playwright.config.ts', 'package.json'])('refuses changed input bytes despite successful execution and green rows: %s', async input => {
    const path = join(root, input);
    const original = readFileSync(path);
    const injected = deps();
    injected.process.mockImplementation(async () => {
      writeFileSync(path, Buffer.concat([original, Buffer.from('\n ')]));
      return success;
    });
    try {
      expect(await runPortalPlaywrightChecks(options, injected)).toMatchObject({ error: 'route_error',
        hint: 'Playwright spec/config source changed during execution' });
      expect(injected.readRows).not.toHaveBeenCalled();
    } finally { writeFileSync(path, original); }
  });
  it('refuses source drift during fence admission before spawning', async () => {
    const original = readFileSync(absolute);
    const injected = deps();
    injected.mutationFence.mockImplementation(async () => {
      writeFileSync(absolute, Buffer.concat([original, Buffer.from('\n ')]));
      return null;
    });
    try {
      expect(await runPortalPlaywrightChecks(options, injected)).toMatchObject({ error: 'route_error',
        hint: 'Playwright spec/config source changed before execution' });
      expect(injected.process).not.toHaveBeenCalled();
    } finally { writeFileSync(absolute, original); }
  });
  it('refuses an input removed during execution', async () => {
    const path = join(root, 'playwright.config.ts');
    const original = readFileSync(path);
    const injected = deps();
    injected.process.mockImplementation(async () => { rmSync(path); return success; });
    try {
      expect(await runPortalPlaywrightChecks(options, injected)).toMatchObject({ error: 'route_error',
        hint: 'Playwright spec/config source changed during execution' });
      expect(injected.readRows).not.toHaveBeenCalled();
    } finally { writeFileSync(path, original); }
  });
  it('refuses source drift while resolving green reporter rows', async () => {
    const path = join(root, 'playwright.config.ts');
    const original = readFileSync(path);
    const injected = deps();
    injected.readRows.mockImplementation(async () => {
      writeFileSync(path, Buffer.concat([original, Buffer.from('\n ')]));
      return [row()];
    });
    try {
      expect(await runPortalPlaywrightChecks(options, injected)).toMatchObject({ error: 'route_error',
        hint: 'Playwright spec/config source changed while reading reporter evidence' });
    } finally { writeFileSync(path, original); }
  });
});

describe('mixed criterion attribution', () => {
  it('runs one batch per executor and retains only the selected file IDs/cases per criterion', async () => {
    const vitestFile = join(ambient, 'unit.test.ts');
    const browserRun = judge([row()]);
    const unitRun = { ok: true, runId: scope.runId, root: ambient, files: 1, passed: 2, failed: 0, skipped: 0,
      byFile: { [vitestFile]: { passed: 2, failed: 0, skipped: 0, collectionFailed: false } },
      failures: [], failuresTruncated: false, durationMs: 1, testRunIds: [7] };
    const runFiles = vi.fn().mockResolvedValue(unitRun);
    const runPlaywright = vi.fn().mockResolvedValue(browserRun);
    const combined = await runCriterionCheckFiles({ root: ambient, files: [vitestFile, absolute], runId: scope.runId }, { runFiles, runPlaywright });
    expect(runFiles).toHaveBeenCalledOnce();
    expect(runPlaywright).toHaveBeenCalledWith(expect.objectContaining({ root, files: [absolute] }));
    expect(combined).toMatchObject({ passed: 3, testRunIds: [7, 41] });
    const caseLoader = vi.fn();
    const result = await evaluateCriterionTestChecks({ root: ambient,
      criteria: [{ key: 'unit', check: { kind: 'tests', files: ['unit.test.ts'] } },
        { key: 'browser', check: { kind: 'tests', files: ['portal/e2e/portal-billing.spec.ts'], testName: 'denies a foreign workspace' } }],
      ratings: { unit: { rating: 'pass' }, browser: { rating: 'pass' } }, runner: async () => combined, caseLoader });
    expect(result).toMatchObject({ ok: true, checkRuns: {
      unit: { passed: 2, testRunIds: [7] }, browser: { passed: 1, matchedCases: 1, testRunIds: [41] },
    } });
    expect(caseLoader).not.toHaveBeenCalled();
  });
  it('refuses a selected browser case when titles are incomplete', async () => {
    const combined = mergeCriterionTestRuns([judge([row({}, { passed: 2, passedCaseTitlesTruncated: true })])], root, scope.runId);
    const result = await evaluateCriterionTestChecks({ root,
      criteria: [{ key: 'browser', check: { kind: 'tests', files: [file], testName: 'denies a foreign workspace' } }],
      ratings: { browser: { rating: 'pass' } }, runner: async () => combined });
    expect(result).toMatchObject({ ok: false, error: 'check_test_case_unresolved' });
  });
});
