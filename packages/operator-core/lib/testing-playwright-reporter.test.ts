import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const { sql } = vi.hoisted(() => ({ sql: vi.fn() }));
const source = vi.hoisted(() => ({ root: '/portal', after: vi.fn() }));
vi.mock('postgres', () => ({ default: () => sql }));
vi.mock('@papercusp/operator-core/lib/testing-worktree', () => ({
  resolveReporterSourceRoot: () => source.root,
  captureTestSourceSnapshot: () => ({ commit: 'a'.repeat(40), porcelain: '' }),
  captureTestSourceSnapshotAsync: () => source.after() ?? Promise.resolve({ commit: 'a'.repeat(40), porcelain: '' }),
  computeWorktreeDirty: () => false,
}));
vi.mock('@papercusp/operator-core/lib/agent-tools/capability/base-dir', () => ({
  resolveAgentWorkspaceRoot: () => '/operator',
}));
import Reporter, { prepareNativeRuntimeReader } from '@papercusp/operator-core/lib/testing-playwright-reporter';
import OperatorReporter from '../../../apps/operator/test/reporters/admin-test-runs-reporter-playwright';
import {
  MAX_RECORDED_PASSED_CASES,
  parseTestRunExecutionDetails,
} from '@papercusp/test-config/execution-details';

/** The reporter's real (unexported) synchronous reader type, derived from its own factory. */
type RuntimeReader = NonNullable<ReturnType<typeof prepareNativeRuntimeReader>>;
/** Deliberate contract violation (fault injection): `RuntimeReader` is SYNCHRONOUS, and a
 *  reader that hands back a Promise is exactly what the reporter must classify `invalid`.
 *  No real type admits that, so this helper casts through `unknown` ON PURPOSE — the
 *  call-site exception testing/typed-mock.ts sanctions, not a stale fixture. */
const violatesSyncReaderContract = (impl: () => Promise<unknown>) => impl as unknown as RuntimeReader;

afterEach(() => { vi.unstubAllEnvs(); source.root = '/portal'; source.after.mockReset(); });

describe('portable Playwright ledger reporter', () => {
  it('waits for final source custody before inserting a passing result', async () => {
    vi.stubEnv('PAPERCUSP_DISABLE_TEST_RUNS_REPORTER', '');
    sql.mockReset().mockResolvedValue([{ id: '12346' }]);
    let resolveCapture!: (snapshot: { commit: string; porcelain: string }) => void;
    source.after.mockReturnValue(new Promise(resolve => { resolveCapture = resolve; }));
    const reporter = new Reporter();
    reporter.onBegin();
    reporter.onTestEnd({ title: 'selection persists', titlePath: () => ['selection persists'],
      location: { file: '/portal/e2e/selection.spec.ts' } } as never,
    { status: 'passed', startTime: new Date(), duration: 10 } as never);
    const finish = reporter.onEnd();
    await Promise.resolve();
    expect(source.after).toHaveBeenCalledOnce();
    expect(sql).not.toHaveBeenCalled();
    resolveCapture({ commit: 'a'.repeat(40), porcelain: '' });
    await finish;
    await reporter.onExit();
    expect(sql).toHaveBeenCalledOnce();
    expect(sql.mock.calls[0]!.at(-1)).toMatchObject({ passed: 1, failed: 0, worktreeDirty: false });
  });

  it.each(['baseline', 'copy-baseline', 'mutant'])(
    'persists the original mutation descriptor and test bytes for the %s leg', async leg => {
      const dir = mkdtempSync(join(tmpdir(), 'playwright-mutation-'));
      const file = join(dir, 'guard.spec.ts');
      const contents = 'test("preserves the conversation", () => {});';
      const descriptor = {
        schemaVersion: 1,
        probeInvocationId: 'playwright-qualified-probe',
        mode: 'copy-out',
        subjectPath: 'src/conversation.tsx',
        mutateExpression: 's/created.chatId/previous.chatId/',
        againstCommit: null,
        subjectBeforeSha256: 'a'.repeat(64),
        subjectAfterSha256: 'b'.repeat(64),
        mutantDiff: '-created.chatId\n+previous.chatId\n',
        mutantDiffTruncated: false,
        testCommandSha256: 'c'.repeat(64),
        testCommand: 'npx playwright test guard.spec.ts',
      };
      try {
        writeFileSync(file, contents);
        source.root = dir;
        vi.stubEnv('PAPERCUSP_DISABLE_TEST_RUNS_REPORTER', '');
        vi.stubEnv('PAPERCUSP_MUTATION_PROBE', '1');
        vi.stubEnv('PAPERCUSP_MUTATION_PHASE', leg);
        vi.stubEnv('PAPERCUSP_MUTATION_DESCRIPTOR', JSON.stringify(descriptor));
        sql.mockReset().mockResolvedValue([{ id: '6791' }]);
        const reporter = new Reporter();
        reporter.onBegin();
        // The invocation is captured before tests run, even if a test changes the environment.
        vi.stubEnv('PAPERCUSP_MUTATION_DESCRIPTOR', '{}');
        reporter.onTestEnd({ title: 'conversation guard', location: { file } } as never,
          { status: leg === 'mutant' ? 'failed' : 'passed', startTime: new Date(), duration: 1,
            errors: leg === 'mutant' ? [{ message: 'expected blank conversation' }] : [] } as never);
        await reporter.onEnd(); await reporter.onExit();
        const details = sql.mock.calls[0]!.at(-1);
        expect(parseTestRunExecutionDetails(details)?.mutation).toEqual({
          ...descriptor, leg,
          testFileSha256: createHash('sha256').update(contents).digest('hex'),
        });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

  it.each(['', '{', '{}'])(
    'keeps an absent or invalid mutation export %j from invalidating the ledger row', async descriptor => {
      vi.stubEnv('PAPERCUSP_DISABLE_TEST_RUNS_REPORTER', '');
      vi.stubEnv('PAPERCUSP_MUTATION_PROBE', '1');
      vi.stubEnv('PAPERCUSP_MUTATION_PHASE', 'mutant');
      vi.stubEnv('PAPERCUSP_MUTATION_DESCRIPTOR', descriptor);
      sql.mockReset().mockResolvedValue([{ id: '6792' }]);
      const reporter = new Reporter();
      reporter.onBegin();
      reporter.onTestEnd({ title: 'legacy guard', location: { file: '/portal/guard.spec.ts' } } as never,
        { status: 'failed', startTime: new Date(), duration: 1, errors: [] } as never);
      await reporter.onEnd(); await reporter.onExit();
      const details = parseTestRunExecutionDetails(sql.mock.calls[0]!.at(-1));
      expect(details).toMatchObject({ mutationPhase: 'mutant', failed: 1 });
      expect(details).not.toHaveProperty('mutation');
    });

  it.each(['', '1'])('prepares owned native custody with database isolation flag %j', async isolation => {
    const dir = mkdtempSync(join(tmpdir(), 'native-runtime-reader-'));
    const receipt = join(dir, 'receipt.json');
    try {
      writeFileSync(receipt, JSON.stringify({ schemaVersion: 'verifier-source-v1', sourceCommit: 'a'.repeat(40) }));
      vi.stubEnv('VERIFY_TAURI_PID', String(process.pid));
      vi.stubEnv('PAPERCUSP_VERIFY_TAURI_ISOLATED', isolation);
      vi.stubEnv('VERIFY_TAURI_SOURCE_REF', 'a'.repeat(40));
      vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', receipt);
      vi.stubEnv('OPERATOR_SOURCE_ROOT', dir);
      vi.stubEnv('PAPERCUSP_WORKSPACE_ID', 'owned-runtime');
      const reader = prepareNativeRuntimeReader(dir, 'a'.repeat(40));
      const original = reader!();
      expect(original).toMatchObject({ units: [`verify-tauri-headless:${process.pid}`],
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(reader!()?.fingerprint).toBe(original?.fingerprint);
      expect(() => prepareNativeRuntimeReader(dir, 'c'.repeat(40))).toThrow('source receipt mismatch');
      expect(() => prepareNativeRuntimeReader(tmpdir(), 'a'.repeat(40))).toThrow('source receipt mismatch');
      vi.stubEnv('VERIFY_TAURI_PID', '0');
      expect(() => prepareNativeRuntimeReader(dir, 'a'.repeat(40))).toThrow('source receipt mismatch');
      vi.stubEnv('VERIFY_TAURI_PID', String(process.pid));
      source.root = dir;
      const reporter = new Reporter();
      expect(reporter.onBegin()).toBeUndefined();
      const before = (reporter as any).runtimeBefore;
      expect(before).toMatchObject({ status: 'captured', witness: { units: original?.units } });
      const caseStarted = new Date();
      expect(Date.parse(before.witness.observedAt)).toBeLessThanOrEqual(caseStarted.getTime());
      sql.mockReset().mockResolvedValue([{ id: '6788' }]);
      reporter.onTestEnd({ title: 'native lifetime', location: { file: join(dir, 'native.spec.mts') } } as never,
        { status: 'passed', startTime: caseStarted, duration: 0, errors: [] } as never);
      expect(await reporter.onEnd()).toBeUndefined(); await reporter.onExit();
      const details = sql.mock.calls[0]!.at(-1) as any;
      expect(details.runtimeEnvironmentBeforeCaptureStatus).toBe('captured');
      expect(details.runtimeEnvironmentAfterCaptureStatus).toBe('captured');
      expect(details.runtimeEnvironmentBefore.fingerprint).toBe(details.runtimeEnvironmentAfter.fingerprint);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['stable', 'changed', 'unavailable', 'invalid', 'error', 'async-reader', 'async-rejection'])(
    'records original before/after runtime capture with explicit %s outcome', async outcome => {
      vi.stubEnv('PAPERCUSP_DISABLE_TEST_RUNS_REPORTER', '');
      const witness = { schemaVersion: 1 as const, units: ['owned-native'], fingerprint: 'a'.repeat(64),
        observedAt: '2000-01-01T00:00:00.000Z' };
      const read = vi.fn<RuntimeReader>(() => witness);
      if (outcome === 'changed') read.mockReturnValueOnce(witness).mockReturnValueOnce({ ...witness, fingerprint: 'b'.repeat(64) });
      if (outcome === 'unavailable') read.mockReturnValue(null);
      if (outcome === 'invalid') read.mockReturnValue({ ...witness, fingerprint: 'caller-claim' });
      if (outcome === 'error') read.mockImplementation(() => { throw new Error('observer failed'); });
      if (outcome === 'async-reader') read.mockImplementation(violatesSyncReaderContract(() => Promise.resolve(witness)));
      if (outcome === 'async-rejection') read.mockImplementation(
        violatesSyncReaderContract(() => Promise.reject(new Error('invalid reader'))));
      sql.mockReset().mockResolvedValue([{ id: '6789' }]);
      try {
        const reporter = new Reporter({ readRuntimeEnvironment: read });
        const begin = reporter.onBegin();
        expect(begin).toBeUndefined(); // The real multiplexer does not await this hook.
        expect(read).toHaveBeenCalledOnce();
        reporter.onTestEnd({ title: 'native proof', location: { file: '/portal/native.spec.ts' } } as never,
          { status: 'passed', startTime: new Date(), duration: 1, errors: [] } as never);
        const end = reporter.onEnd();
        await end; await reporter.onExit();
        const details = sql.mock.calls[0]!.at(-1) as any;
        expect(parseTestRunExecutionDetails(details)).toEqual(details);
        const status = outcome === 'stable' || outcome === 'changed' ? 'captured'
          : outcome.startsWith('async-') ? 'invalid' : outcome;
        expect(details.runtimeEnvironmentBeforeCaptureStatus).toBe(status);
        expect(details.runtimeEnvironmentAfterCaptureStatus).toBe(status);
        if (status === 'captured') {
          expect(details.runtimeEnvironmentBefore.observedAt).not.toBe(witness.observedAt);
          expect(details.runtimeEnvironmentAfter.fingerprint).toBe(outcome === 'changed' ? 'b'.repeat(64) : witness.fingerprint);
        } else {
          expect(details).not.toHaveProperty('runtimeEnvironmentBefore');
          expect(details).not.toHaveProperty('runtimeEnvironmentAfter');
        }
      } finally { vi.useRealTimers(); }
    });

  it('keeps operator profiles on the same maintained implementation', () => {
    expect(OperatorReporter).toBe(Reporter);
  });

  it('refuses native tests before execution when source custody cannot be prepared', () => {
    vi.stubEnv('VERIFY_TAURI_PID', String(process.pid));
    vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', '');
    vi.stubEnv('PAPERCUSP_VERIFY_TAURI_ISOLATED', '1');
    expect(() => new Reporter().onBegin()).toThrow('owned verifier source custody');
  });

  it.each(['changed', 'unavailable', 'error'])('fails native verification when the runtime becomes %s', async outcome => {
    vi.stubEnv('VERIFY_TAURI_PID', String(process.pid));
    const witness = { schemaVersion: 1 as const, units: ['owned-native'], fingerprint: 'a'.repeat(64),
      observedAt: new Date().toISOString() };
    const read = vi.fn<RuntimeReader>(() => witness).mockReturnValueOnce(witness);
    if (outcome === 'changed') read.mockReturnValue({ ...witness, fingerprint: 'b'.repeat(64) });
    if (outcome === 'unavailable') read.mockReturnValue(null);
    if (outcome === 'error') read.mockImplementation(() => { throw new Error('observer failed'); });
    sql.mockReset().mockResolvedValue([{ id: '6790' }]);
    const reporter = new Reporter({ readRuntimeEnvironment: read });
    reporter.onBegin();
    reporter.onTestEnd({ title: 'passing assertions', location: { file: '/portal/native.spec.ts' } } as never,
      { status: 'passed', startTime: new Date(), duration: 1, errors: [] } as never);
    expect(await reporter.onEnd()).toEqual({ status: 'failed' });
    await reporter.onExit();
    expect(sql.mock.calls[0]![2]).toBe('error');
    expect(sql.mock.calls[0]!.at(-1)).toMatchObject({ passed: 1, failed: 0 });
    expect(sql.mock.calls[0]![6]).toContain('[native runtime witness]');
  });

  it('makes the real Playwright runner fail after a native onBegin error despite passing assertions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-reporter-exit-'));
    try {
      const reporterPath = createRequire(import.meta.url).resolve('@papercusp/operator-core/lib/testing-playwright-reporter');
      const config = join(dir, 'playwright.config.cjs');
      writeFileSync(config, `module.exports = { testDir: ${JSON.stringify(dir)}, reporter: [[${JSON.stringify(reporterPath)}]], workers: 1 };`);
      const playwright = createRequire(import.meta.url).resolve('@playwright/test');
      const executed = join(dir, 'assertion-passed.txt');
      writeFileSync(join(dir, 'passed.spec.cjs'), `const { test, expect } = require(${JSON.stringify(playwright)}); test('passing assertion', () => { expect(true).toBe(true); require('node:fs').writeFileSync(${JSON.stringify(executed)}, 'passed'); });`);
      const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
      const result = await promisify(execFile)(process.execPath, [cli, 'test', '--config', config], {
        cwd: dir, timeout: 30_000,
        env: { ...process.env, VERIFY_TAURI_PID: String(process.pid), VERIFY_TAURI_SOURCE_RECEIPT: '',
          PAPERCUSP_DISABLE_TEST_RUNS_REPORTER: '1', NODE_OPTIONS: '' },
      }).then(() => null, error => error);
      expect(result?.code).toBe(1);
      expect(result?.killed).not.toBe(true);
      expect(result?.stderr).toContain('owned verifier source custody');
      expect(readFileSync(executed, 'utf8')).toBe('passed');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 40_000);

  it('records exact Portal case identities, runtime scope and returned ledger custody', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'portal-reporter-'));
    const receipts = join(dir, 'receipts.jsonl');
    try {
      vi.stubEnv('PAPERCUSP_DISABLE_TEST_RUNS_REPORTER', '');
      vi.stubEnv('PAPERCUSP_MUTATION_PROBE', '');
      vi.stubEnv('PAPERCUSP_TEST_RUN_HARNESS', 'portal');
      vi.stubEnv('PAPERCUSP_TEST_RUN_WORKSPACE', 'papercusp-workspace');
      vi.stubEnv('PAPERCUSP_TEST_RUN_GROUP', 'portal-e2e-proof');
      vi.stubEnv('PAPERCUSP_TEST_RUN_RECEIPT_FILE', receipts);
      sql.mockReset().mockResolvedValue([{ id: '12345' }]);
      const reporter = new Reporter();
      const beforeBegin = Date.now();
      reporter.onBegin({ rootDir: '/portal/e2e' });
      const afterBegin = Date.now();
      const cases = [
        ['new account', 'passed'] as const,
        ...Array.from({ length: MAX_RECORDED_PASSED_CASES }, (_, index) => ['passed case ' + index, 'passed'] as const),
        ['stale curriculum', 'failed'] as const,
      ];
      for (const [title, status] of cases) {
        reporter.onTestEnd({
          title, titlePath: () => ['', '', 'portal-product-tutorial.spec.ts', 'account-first', title],
          location: { file: '/portal/e2e/portal-product-tutorial.spec.ts' },
        } as never, {
          status, startTime: new Date(0), duration: 10,
          errors: status === 'failed' ? [{ message: 'curriculum mismatch' }] : [],
        } as never);
      }
      await reporter.onEnd();
      await reporter.onExit();
      expect(sql).toHaveBeenCalledOnce();
      const values = sql.mock.calls[0]!.slice(1);
      expect(values[0]).toBe('e2e/portal-product-tutorial.spec.ts');
      expect(values[1]).toBe('fail');
      const details = values.at(-1);
      expect(details).toMatchObject({
        root: '/portal', testLayer: 'e2e', harnessSlug: 'portal',
        workspaceId: 'papercusp-workspace', runGroupId: 'portal-e2e-proof',
        passed: MAX_RECORDED_PASSED_CASES + 1, failed: 1, skipped: 0, worktreeDirty: false,
        passedCaseTitlesTruncated: true,
        failedCaseTitles: ['account-first > stale curriculum'],
      });
      expect((details as { passedCaseTitles: string[] }).passedCaseTitles)
        .toHaveLength(MAX_RECORDED_PASSED_CASES);
      expect((details as { passedCaseTitles: string[] }).passedCaseTitles[0])
        .toBe('account-first > new account');
      expect(parseTestRunExecutionDetails(details)).toEqual(details);
      const runStartedAt = parseTestRunExecutionDetails(details)?.runStartedAt;
      expect(runStartedAt).toBeDefined();
      // Case timestamps deliberately use the epoch; source custody must name
      // this run's onBegin, rather than those timestamps or insertion time.
      expect(Date.parse(runStartedAt!)).toBeGreaterThanOrEqual(beforeBegin);
      expect(Date.parse(runStartedAt!)).toBeLessThanOrEqual(afterBegin);
      const receipt = JSON.parse(readFileSync(receipts, 'utf8').trim());
      expect(receipt).toEqual({
        filePath: 'e2e/portal-product-tutorial.spec.ts', status: 'fail', outcome: 'inserted', id: '12345',
        attempt: 0, receiptId: expect.any(String),
        row: {
          filePath: 'e2e/portal-product-tutorial.spec.ts', status: 'fail', durationMs: 10,
          startedAt: '1970-01-01T00:00:00.000Z', finishedAt: '1970-01-01T00:00:00.010Z',
          outputTail: 'curriculum mismatch', isScratchConfig: false, worktreeDirty: false,
          commitSha: 'a'.repeat(40), receiptId: receipt.receiptId, receiptAttempt: 0,
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
