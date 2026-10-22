/**
 * admin-test-runs-reporter-playwright.ts — Playwright counterpart to
 * the Vitest reporter (P-010). Writes one row per spec FILE to
 * harness_shared.test_runs with framework='playwright'.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-011.
 *
 * D-007 fail-soft contract — identical to the Vitest reporter:
 *   - 1s connect timeout
 *   - swallow every PG / git / fs error
 *   - never throw out of any hook
 *   - never write to stderr/stdout in a way that taints test output
 *   - never affect the process exit code for ledger failures
 * Native verification additionally requires a stable execution-time runtime
 * witness. A failed witness changes the native verdict, independently of PG.
 *
 * WI-10007513: maintained implementation exposed through operator-core for all apps.
 * Operator and Portal Playwright configs add this reporter to
 * its `reporter` array. Opt-out via PAPERCUSP_DISABLE_TEST_RUNS_REPORTER=1.
 *
 * Playwright reporter API: implement onBegin/onTestEnd/onEnd. Each
 * spec file's per-test results aggregate into one row (status=fail
 * if any test failed, pass if all passed).
 */

import type { FullConfig, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { resolveGitContext } from '@papercusp/operator-core/lib/testing-branch-resolve';
import { resolveAgentWorkspaceRoot } from '@papercusp/operator-core/lib/agent-tools/capability/base-dir';
import {
  captureTestSourceSnapshot,
  captureTestSourceSnapshotAsync,
  resolveReporterSourceRoot,
  computeWorktreeDirty,
  type WorktreeGitSnapshot,
} from '@papercusp/operator-core/lib/testing-worktree';
import { resolveTestRunSource } from '@papercusp/operator-core/lib/testing-run-source';
import {
  describeWorktreeDirt,
  resolveMutationProbePhase,
  sha256OfTestFile,
  resolveTestRunHarnessSlug,
  resolveTestRunWorkspaceId,
  appendTestRunReceipts,
  reporterWriteBudget,
  testRunReceiptBaseFor,
  isDefinitePreSubmitFailure,
} from '@papercusp/test-config/admin-test-runs-reporter';
import {
  mutationDescriptorForRow,
  readMutationInvocationDescriptor,
  type MutationDescriptor,
  type MutationInvocationDescriptor,
} from '@papercusp/test-config/mutation-descriptor';
import { posix, relative } from 'node:path';
import { prepareNativeRuntimeReader } from './testing-native-runtime';
export { prepareNativeRuntimeReader } from './testing-native-runtime';
import {
  isRecordedCaseTitle,
  MAX_RECORDED_PASSED_CASES,
  TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
  parseRecordedRuntimeEnvironment,
  stableRecordedRuntimeEnvironment,
  type RecordedRuntimeEnvironment,
  type RuntimeEnvironmentCaptureStatus,
  type TestRunExecutionDetails,
} from '@papercusp/test-config/execution-details';

type RuntimeCapture = { status: RuntimeEnvironmentCaptureStatus; witness?: RecordedRuntimeEnvironment };
type RuntimeReader = () => RecordedRuntimeEnvironment | null;

function captureRuntimeEnvironment(read?: RuntimeReader, preparationFailed = false): RuntimeCapture {
  if (preparationFailed) return { status: 'error' };
  if (!read) return { status: 'not-configured' };
  try {
    const value = read();
    // A misconfigured async reader cannot be awaited by Playwright's onBegin.
    if (value && typeof (value as unknown as { then?: unknown }).then === 'function') {
      void Promise.resolve(value).catch(() => {});
      return { status: 'invalid' };
    }
    if (value === null) return { status: 'unavailable' };
    const witness = parseRecordedRuntimeEnvironment(value);
    return witness ? { status: 'captured', witness: { ...witness, units: [...witness.units],
      observedAt: new Date().toISOString() } } : { status: 'invalid' };
  } catch { return { status: 'error' }; }
}

interface TestRunRow {
  filePath: string;
  status: 'pass' | 'fail' | 'skip' | 'cancelled' | 'error';
  durationMs: number;
  startedAt: Date;
  finishedAt: Date;
  outputTail: string | null;
  worktreeDirty: boolean;
  worktreeDirtyReason?: string;
  mutation?: MutationDescriptor;
  passed: number;
  failed: number;
  skipped: number;
  /** Exact failing case identities (WI-10006806): what a filed red names as "the failing tests". */
  failedCaseTitles?: string[];
  passedCaseTitles?: string[];
  passedCaseTitlesTruncated?: true;
  runtimeEnvironmentBefore?: RuntimeCapture;
  runtimeEnvironmentAfter?: RuntimeCapture;
}

/**
 * WI-10006806: the identity of one Playwright case below its file — describe blocks then the test
 * title, joined with ' > ' like Vitest's `TestCase.fullName`. Playwright's `titlePath()` is
 * `['', <project>, <file>, ...describes, <title>]`; the root, project and file segments are
 * dropped so one case reads the same under every project. Returns null when the title is not a
 * valid recorded identity (the shared parser would reject the whole row otherwise).
 */
export function playwrightCaseTitle(test: Partial<Pick<TestCase, 'titlePath' | 'title'>>): string | null {
  let parts: string[] = [];
  try {
    if (typeof test.titlePath === 'function') parts = test.titlePath().slice(3).filter((part) => part.length > 0);
  } catch {
    parts = [];
  }
  if (parts.length === 0 && typeof test.title === 'string' && test.title.length > 0) parts = [test.title];
  const title = parts.map((part) => part.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).join(' > ');
  return isRecordedCaseTitle(title) ? title : null;
}

/**
 * EI-24434635346407728: stamp the RUNTIME layer. This reporter only ever runs inside a
 * Playwright process, so every row it writes is an e2e execution — the fact acceptance
 * BARs requiring `e2e` bind against. Before this the row carried no execution_details at
 * all, so no e2e run could ever satisfy an `e2e` layer requirement.
 */
export function playwrightExecutionDetails(
  row: TestRunRow,
  run: { root: string; runGroupId: string | null; workspaceId: string | null; harnessSlug: string | null; commitSha: string | null; runStartedAt?: string | null },
): TestRunExecutionDetails {
  return {
    schemaVersion: TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
    root: run.root,
    filePath: row.filePath,
    runGroupId: run.runGroupId,
    workspaceId: run.workspaceId,
    harnessSlug: run.harnessSlug,
    testNamePattern: null,
    testLayer: 'e2e',
    ...(run.runStartedAt ? { runStartedAt: run.runStartedAt } : {}),
    passed: row.passed,
    failed: row.failed,
    skipped: row.skipped,
    collectionFailed: false,
    mutationPhase: row.mutation?.leg ?? resolveMutationProbePhase(),
    ...(row.mutation ? { mutation: row.mutation } : {}),
    commitSha: run.commitSha,
    worktreeDirty: row.worktreeDirty,
    ...(row.worktreeDirty && row.worktreeDirtyReason ? { worktreeDirtyReason: row.worktreeDirtyReason } : {}),
    ...(row.runtimeEnvironmentBefore ? {
      runtimeEnvironmentBeforeCaptureStatus: row.runtimeEnvironmentBefore.status,
      ...(row.runtimeEnvironmentBefore.witness ? { runtimeEnvironmentBefore: row.runtimeEnvironmentBefore.witness } : {}),
    } : {}),
    ...(row.runtimeEnvironmentAfter ? {
      runtimeEnvironmentAfterCaptureStatus: row.runtimeEnvironmentAfter.status,
      ...(row.runtimeEnvironmentAfter.witness ? { runtimeEnvironmentAfter: row.runtimeEnvironmentAfter.witness } : {}),
    } : {}),
    ...(row.failedCaseTitles && row.failedCaseTitles.length > 0
      ? { failedCaseTitles: row.failedCaseTitles.slice(0, row.failed) }
      : {}),
    ...(row.passedCaseTitles && row.passedCaseTitles.length > 0
      ? { passedCaseTitles: row.passedCaseTitles.slice(0, Math.min(MAX_RECORDED_PASSED_CASES, row.passed)) }
      : {}),
    ...(row.passedCaseTitlesTruncated ? { passedCaseTitlesTruncated: true as const } : {}),
  };
}

function captureReporterSaturationSnapshot(): { loopLagP95Ms: number | null; rssMb: number | null } {
  // This reporter is a child process. Its event loop is mostly idle while
  // Playwright workers run, so it cannot measure the operator host loop used
  // by testing:runs' critical-band classifier. Persist no false-provenance
  // sample; the reader will expose saturationSuspect as unknown.
  let rssMb: number | null = null;
  try {
    rssMb = Math.round((process.memoryUsage().rss / 1_048_576) * 10) / 10;
  } catch {
    rssMb = null;
  }
  return { loopLagP95Ms: null, rssMb };
}

function toWorkspaceRel(absPath: string, root: string): string {
  const rel = relative(root, absPath);
  return rel.split(/[/\\]/).join(posix.sep);
}

async function tryGetPg(): Promise<{
  sql: (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<unknown[]>;
} | null> {
  try {
    const pg = (await import('postgres')).default;
    // The dedicated ledger variable wins (WI-10006736): the isolated rig exports
    // HARNESS_ADMIN_DATABASE_URL at its throwaway database, so the isolated e2e runner
    // points PAPERCUSP_TEST_RUNS_DB_URL at the shared ledger. Same order as the Vitest
    // reporter and resolveExecutedMapPgUrl.
    const url =
      process.env.PAPERCUSP_TEST_RUNS_DB_URL ??
      process.env.HARNESS_ADMIN_DATABASE_URL ??
      'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
    const sql = pg(url, {
      max: 1,
      connect_timeout: reporterWriteBudget(process.env).connectTimeoutSec,
      idle_timeout: 1,
      max_lifetime: 5,
      onnotice: () => {},
    });
    return { sql } as unknown as {
      sql: (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<unknown[]>;
    };
  } catch {
    return null;
  }
}

function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    promise.then(() => finish(true), () => finish(true));
  });
}

async function insertRow(row: TestRunRow, worktreeAfter: WorktreeGitSnapshot, root: string, runStartedAt: string | null): Promise<void> {
  let branch: string | null = null;
  try {
    // The ambient resolver describes the agent's tree. It cannot name the
    // branch of a separate proof checkout; its actual snapshot names the commit.
    if (root === resolveAgentWorkspaceRoot({})) branch = (await resolveGitContext()).branch;
  } catch { /* fail-soft */ }
  // Use the post-run snapshot for attribution. The cached resolver's commit
  // may describe a different tree if git-sync or a peer changed it while the
  // Playwright run was in flight.
  const commit = worktreeAfter.commit;
  // One receipt identity for this row: a late `inserted` supersedes its `timeout` under it.
  // Playwright configs are committed specs, never a scratch config (the Vitest-only flag).
  let receipt = testRunReceiptBaseFor({
    filePath: row.filePath, status: row.status, durationMs: row.durationMs,
    startedAt: row.startedAt, finishedAt: row.finishedAt, outputTail: row.outputTail,
    isScratchConfig: false, worktreeDirty: row.worktreeDirty, commitSha: commit,
  });
  // Late settlement must stay attached to this run's evidence sink.
  const receiptEnv = { PAPERCUSP_TEST_RUN_RECEIPT_FILE: process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE };

  const pg = await tryGetPg();
  if (!pg) {
    appendTestRunReceipts(receiptEnv, [{ ...receipt, outcome: 'failed', reason: 'pg_unavailable', replayable: false }]);
    return;
  }

  const source = resolveTestRunSource();
  const runGroupId = process.env.PAPERCUSP_TEST_RUN_GROUP ?? null;
  const { loopLagP95Ms, rssMb } = captureReporterSaturationSnapshot();
  // WI-6583: this reporter never wrote harness_slug/workspace_id at all. It now calls the
  // Vitest reporter's resolvers directly instead of an inline copy: the copy had already
  // drifted once (it lacked the PAPERCUSP_TEST_RUN_WORKSPACE override, so isolated e2e rows
  // were stamped with the rig's throwaway workspace — WI-10006804).
  const harnessSlug = resolveTestRunHarnessSlug();
  const workspaceId = resolveTestRunWorkspaceId();
  const budget = reporterWriteBudget(process.env);
  const startedAt = Date.now();
  const deadline = startedAt + budget.totalInsertMs;
  const executionDetails = playwrightExecutionDetails(row, {
    root, runGroupId, workspaceId, harnessSlug, commitSha: commit, runStartedAt,
  });
  const query = (async () => {
    for (;;) {
      try {
        const result = await pg.sql`
      INSERT INTO harness_shared.test_runs
        (file_path, framework, status, duration_ms, started_at, finished_at, output_tail, run_group_id, source, branch, commit_sha, harness_slug, workspace_id, loop_lag_p95_ms, rss_mb, worktree_dirty, execution_details)
      VALUES
        (${row.filePath}, 'playwright', ${row.status}, ${row.durationMs}, ${row.startedAt},
         ${row.finishedAt}, ${row.outputTail}, ${runGroupId}, ${source}, ${branch}, ${commit}, ${harnessSlug}, ${workspaceId}, ${loopLagP95Ms}, ${rssMb}, ${row.worktreeDirty},
         ${executionDetails as never}::jsonb)
      RETURNING id
        `;
        const first = Array.isArray(result) ? result[0] as { id?: unknown } | undefined : undefined;
        appendTestRunReceipts(receiptEnv, first?.id === undefined || first.id === null
          ? [{ ...receipt, outcome: 'failed', reason: 'insert_returned_no_id', replayable: false }]
          : [{ ...receipt, outcome: 'inserted', id: String(first.id) }]);
        return;
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        // Share Vitest's only safe replay condition: postgres-js proves this
        // statement was never submitted. An uncertain INSERT is never replayed.
        const preSubmit = isDefinitePreSubmitFailure(error);
        const replayable = preSubmit && receipt.attempt === 0 && Date.now() < deadline;
        appendTestRunReceipts(receiptEnv, [{
          ...receipt, outcome: 'failed', reason: reason.slice(0, 200) || 'unknown', replayable,
          ...(preSubmit ? { errorCode: 'CONNECT_TIMEOUT' } : {}),
        }]);
        if (!replayable) return;
        const attempt = receipt.attempt + 1;
        receipt = { ...receipt, attempt, row: { ...receipt.row, receiptAttempt: attempt } };
      }
    }
  })();

  if (!(await settleWithin(query, budget.insertTimeoutMs))) {
    appendTestRunReceipts(receiptEnv, [{
      ...receipt,
      outcome: 'timeout',
      reason: `pg_insert_timeout_${budget.insertTimeoutMs}ms`,
      replayable: false,
    }]);
    // The query may still commit after the first deadline. Keep the reporter
    // alive through its bounded flush window so its late RETURNING id can
    // supersede this timeout receipt in the mutation probe's collector.
    const remainingMs = Math.max(0, budget.flushBudgetMs - (Date.now() - startedAt));
    if (remainingMs > 0) await settleWithin(query, remainingMs);
  }
}

interface PerFile {
  startedAt: number;
  finishedAt: number;
  anyFail: boolean;
  anyPass: boolean;
  allSkipped: boolean;
  errors: string[];
  passed: number;
  failed: number;
  skipped: number;
  failedTitles: Set<string>;
  passedTitles: Set<string>;
  passedCaseTitlesTruncated: boolean;
}

export default class AdminTestRunsPlaywrightReporter implements Reporter {
  private byFile = new Map<string, PerFile>();
  private pending: Promise<void>[] = [];
  /** Captured before Playwright begins executing tests. */
  private worktreeBefore: WorktreeGitSnapshot | null = null;
  private runStartedAt: string | null = null;
  private runRoot = resolveAgentWorkspaceRoot({});
  private runtimeReader?: RuntimeReader;
  private runtimePreparationFailed = false;
  private runtimeBefore?: RuntimeCapture;
  private mutationInvocation: MutationInvocationDescriptor | null = null;

  constructor(options: { readRuntimeEnvironment?: RuntimeReader } = {}) {
    this.runtimeReader = options.readRuntimeEnvironment;
  }

  onBegin(config?: Pick<FullConfig, 'rootDir'>): void {
    // Bind mutable-checkout evidence to the source window before preparation,
    // rather than to a file's first completed test or the later ledger write.
    this.runStartedAt = new Date().toISOString();
    this.runRoot = resolveReporterSourceRoot(config?.rootDir);
    this.worktreeBefore = captureTestSourceSnapshot(this.runRoot);
    this.mutationInvocation = readMutationInvocationDescriptor();
    let preparationError: unknown;
    try {
      this.runtimeReader ??= prepareNativeRuntimeReader(this.runRoot, this.worktreeBefore?.commit ?? null);
    } catch (error) {
      this.runtimePreparationFailed = true;
      preparationError = error;
    }
    this.runtimeBefore = captureRuntimeEnvironment(this.runtimeReader, this.runtimePreparationFailed);
    if (process.env.VERIFY_TAURI_PID && this.runtimePreparationFailed)
      throw new Error(`Native runtime witness preparation failed: ${String(preparationError)}`);
    if (process.env.VERIFY_TAURI_PID && this.runtimeBefore.status !== 'captured')
      throw new Error(`Native runtime witness unavailable before tests: ${this.runtimeBefore.status}`);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    try {
      if (process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER === '1') return;
      const file = test.location?.file;
      if (!file) return;

      const existing = this.byFile.get(file) ?? {
        startedAt: result.startTime?.getTime() ?? Date.now(),
        finishedAt: 0,
        anyFail: false,
        anyPass: false,
        allSkipped: true,
        errors: [],
        passed: 0,
        failed: 0,
        skipped: 0,
        failedTitles: new Set<string>(),
        passedTitles: new Set<string>(),
        passedCaseTitlesTruncated: false,
      };

      const endMs = (result.startTime?.getTime() ?? Date.now()) + result.duration;
      existing.startedAt = Math.min(existing.startedAt, result.startTime?.getTime() ?? Date.now());
      existing.finishedAt = Math.max(existing.finishedAt, endMs);

      switch (result.status) {
        case 'passed':
          existing.passed += 1;
          existing.anyPass = true;
          existing.allSkipped = false;
          {
            const title = playwrightCaseTitle(test);
            if (title && !existing.passedTitles.has(title)) {
              if (existing.passedTitles.size < MAX_RECORDED_PASSED_CASES) existing.passedTitles.add(title);
              else existing.passedCaseTitlesTruncated = true;
            }
          }
          break;
        case 'failed':
        case 'timedOut':
        case 'interrupted':
          existing.failed += 1;
          existing.anyFail = true;
          existing.allSkipped = false;
          for (const e of result.errors ?? []) {
            if (e.message) existing.errors.push(e.message);
          }
          {
            const title = playwrightCaseTitle(test);
            if (title) existing.failedTitles.add(title);
          }
          break;
        case 'skipped':
          existing.skipped += 1;
          // keep allSkipped flag until something else lands
          break;
      }

      this.byFile.set(file, existing);
    } catch {
      /* swallow — D-007 */
    }
  }

  async onEnd(): Promise<void | { status: 'failed' }> {
    // Playwright logs onBegin exceptions but can still run and pass the tests.
    // Its awaited onEnd return is the supported way to fail this verification.
    let nativeRuntimeFailed = Boolean(process.env.VERIFY_TAURI_PID);
    try {
      const runtimeAfter = captureRuntimeEnvironment(this.runtimeReader, this.runtimePreparationFailed);
      nativeRuntimeFailed = Boolean(process.env.VERIFY_TAURI_PID)
        && !stableRecordedRuntimeEnvironment(this.runtimeBefore?.witness, runtimeAfter.witness);
      const runtimeFailure = nativeRuntimeFailed
        ? `[native runtime witness] missing or changed: before=${this.runtimeBefore?.status ?? 'unavailable'} after=${runtimeAfter.status}`
        : null;
      let worktreeAfter: WorktreeGitSnapshot = { commit: null, porcelain: null };
      try {
        // onBegin must finish synchronously before any test executes. onEnd is
        // awaited by Playwright, so final custody can use the bounded async
        // runner instead of mistaking a two-second sync budget for dirty source.
        worktreeAfter = await captureTestSourceSnapshotAsync(this.runRoot);
      } catch {
        // D-007: missing proof of stability is dirty, never a false clean.
      }
      const worktreeDirty = computeWorktreeDirty(
        this.worktreeBefore ?? { commit: null, porcelain: null },
        worktreeAfter,
      );
      const dirtReason = [
        describeWorktreeDirt(this.worktreeBefore ?? { commit: null, porcelain: null }, worktreeAfter),
        this.worktreeBefore?.provenanceError, worktreeAfter.provenanceError,
      ].filter(Boolean).join('; ').slice(0, 500);
      for (const [file, agg] of this.byFile) {
        try {
          const filePath = toWorkspaceRel(file, this.runRoot);
          const status: TestRunRow['status'] = nativeRuntimeFailed ? 'error' : agg.anyFail
            ? 'fail'
            : agg.allSkipped
            ? 'skip'
            : 'pass';
          const durationMs = Math.max(0, agg.finishedAt - agg.startedAt);
          // Preserve diagnostics in the existing text column while deployed
          // strict execution_details readers await the expanded reason field.
          const output = [...agg.errors, ...(dirtReason ? [`[worktree provenance] ${dirtReason}`] : []),
            ...(runtimeFailure ? [runtimeFailure] : [])].join('\n');
          const outputTail = output ? output.slice(-4000) : null;
          this.pending.push(
            insertRow({
              filePath,
              status,
              durationMs,
              startedAt: new Date(agg.startedAt),
              finishedAt: new Date(agg.finishedAt),
              outputTail,
              worktreeDirty,
              ...(worktreeDirty && dirtReason ? { worktreeDirtyReason: dirtReason } : {}),
              mutation: mutationDescriptorForRow(this.mutationInvocation, resolveMutationProbePhase(),
                sha256OfTestFile(file)),
              passed: agg.passed,
              failed: agg.failed,
              skipped: agg.skipped,
              failedCaseTitles: [...agg.failedTitles],
              passedCaseTitles: [...agg.passedTitles],
              ...(agg.passedCaseTitlesTruncated ? { passedCaseTitlesTruncated: true as const } : {}),
              runtimeEnvironmentBefore: this.runtimeBefore,
              runtimeEnvironmentAfter: runtimeAfter,
            }, worktreeAfter, this.runRoot, this.runStartedAt),
          );
        } catch {
          /* swallow per-file */
        }
      }
    } catch {
      /* swallow */
    }
    if (nativeRuntimeFailed) return { status: 'failed' };
  }

  async onExit(): Promise<void> {
    try {
      await settleWithin(Promise.allSettled(this.pending), reporterWriteBudget(process.env).flushBudgetMs);
    } catch {
      /* swallow */
    }
  }
}
