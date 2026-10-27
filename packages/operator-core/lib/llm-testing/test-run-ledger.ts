/**
 * test-run-ledger.ts — record a LIVE llm-test scenario run in `harness_shared.test_runs`.
 *
 * EI-24434635346407728. `llm-test run` executes a scenario against a live model and
 * persists its rich report to `harness_shared.llm_test_runs`, but acceptance BAR
 * clauses bind to the shared test ledger (`test_runs` + `execution_details`). Before
 * this module a live scenario left no `test_runs` row, so a clause whose
 * `requiredTestLayers` includes `llm` had nothing to bind to and was unsatisfiable.
 *
 * The recorded layer is a RUNTIME fact: only the live runner calls this, so it stamps
 * `llm`. Replaying stored model output under the unit Vitest config never reaches here
 * and records `unit` through the ordinary Vitest reporter.
 *
 * Fail-soft like the Vitest/Playwright reporters: a ledger write must never change the
 * scenario verdict or the CLI exit code.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';

import type { LlmCallDiagnosticSummary, RunReport } from '@papercusp/testing-shell/llm';
import { resolveTestRunHarnessSlug, resolveTestRunWorkspaceId } from '@papercusp/test-config/admin-test-runs-reporter';
import {
  TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
  parseRecordedRuntimeEnvironment,
  type RecordedRuntimeEnvironment,
  type RuntimeEnvironmentCaptureStatus,
  type TestRunExecutionDetails,
} from '@papercusp/test-config/execution-details';

import { resolveAgentWorkspaceRoot } from '../agent-tools/capability/base-dir';
import { getLongLivedAdminPool } from '../long-lived-admin-pool';
import { sharedUtilityPoolMax } from '../resource-profile';
import { resolveGitContext } from '../testing-branch-resolve';
import { resolveTestRunSource } from '../testing-run-source';
import { captureWorktreeSnapshot, computeWorktreeDirty, type WorktreeGitSnapshot } from '../testing-worktree';
import { toolDeliveryBlockLedgerIdentity, type ToolDeliveryCleanBlock } from '../tool-delivery-clean-runtime';

export interface LlmScenarioLedgerRow {
  filePath: string;
  status: 'pass' | 'fail' | 'skip' | 'error';
  durationMs: number;
  startedAt: Date;
  finishedAt: Date;
  outputTail: string | null;
  executionDetails: TestRunExecutionDetails;
}

export interface LlmScenarioLedgerContext {
  root: string;
  filePath: string;
  runGroupId: string | null;
  workspaceId: string | null;
  harnessSlug: string | null;
  commitSha: string | null;
  worktreeDirty: boolean;
  runtimeEnvironmentBefore?: RecordedRuntimeEnvironment;
  runtimeEnvironmentAfter?: RecordedRuntimeEnvironment;
  runtimeEnvironmentBeforeCaptureStatus?: RuntimeEnvironmentCaptureStatus;
  runtimeEnvironmentAfterCaptureStatus?: RuntimeEnvironmentCaptureStatus;
  /** Fallback clock when the report carries no runs. */
  now?: Date;
}

/** Pure projection of a live scenario report onto one `test_runs` row. */
export function llmScenarioLedgerRow(report: RunReport, ledger: LlmScenarioLedgerContext): LlmScenarioLedgerRow {
  const passed = report.runs.filter((r) => r.status === 'passed').length;
  const failed = report.runs.filter((r) => r.status === 'failed').length;
  const errored = report.runs.filter((r) => r.status === 'errored').length;

  const status: LlmScenarioLedgerRow['status'] =
    report.runs.length === 0 ? 'skip'
      : failed > 0 ? 'fail'
        : errored > 0 ? 'error'
          : 'pass';

  const now = ledger.now ?? new Date();
  const starts = report.runs.map((r) => new Date(r.summary.startedAt).getTime()).filter(Number.isFinite);
  const ends = report.runs.map((r) => new Date(r.summary.finishedAt).getTime()).filter(Number.isFinite);
  const startedAt = starts.length ? new Date(Math.min(...starts)) : now;
  const finishedAt = ends.length ? new Date(Math.max(...ends)) : now;

  const diagnosticTail = report.runs.flatMap((run, index) => {
    const parts: string[] = [];
    if (run.summary.timeout) {
      const timeout = run.summary.timeout;
      parts.push(`run${index + 1}:timeout=${timeout.cause}/${timeout.stage}/turn=${timeout.turnIndex}`);
    }
    const diagnostics = run.summary.llmCallDiagnostics;
    if (diagnostics) {
      const failures = diagnostics.events.filter((event) =>
        event.phase === 'transport-error' || event.phase === 'stream-error');
      const recent = (failures.length > 0 ? failures : diagnostics.events).slice(-2);
      for (const event of recent) {
        const fields = [`run${index + 1}:${event.phase}`, `attempt=${event.attempt}`];
        if (event.status !== null) fields.push(`status=${event.status}`);
        if (event.transportFailureCode) fields.push(`code=${event.transportFailureCode}`);
        if (event.callerAborted !== undefined && event.callerAborted !== null)
          fields.push(`callerAborted=${event.callerAborted}`);
        if (event.callerAbortReason) fields.push(`abortReason=${event.callerAbortReason}`);
        parts.push(fields.join(' '));
      }
      if (diagnostics.omitted > 0) parts.push(`run${index + 1}:diagnosticsOmitted=${diagnostics.omitted}`);
    }
    return parts;
  }).join('; ').slice(0, 800);
  const outputTailBase = `llm-test ${report.scenarioId} verdict=${report.verdict} runs=${report.runs.length} passed=${passed} failed=${failed} errored=${errored}`;
  const outputTail = status === 'pass' ? null
    : `${outputTailBase}${diagnosticTail ? `; ${diagnosticTail}` : ''}`.slice(0, 1200);
  const runIds = report.runs.map(run => run.summary.runId);
  const completeRunIds = runIds.length > 0 && runIds.every(id => typeof id === 'string' && id.length > 0)
    && new Set(runIds).size === runIds.length;

  return {
    filePath: ledger.filePath,
    status,
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    startedAt,
    finishedAt,
    outputTail,
    executionDetails: {
      schemaVersion: TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
      root: ledger.root,
      filePath: ledger.filePath,
      runGroupId: ledger.runGroupId,
      workspaceId: ledger.workspaceId,
      harnessSlug: ledger.harnessSlug,
      testNamePattern: null,
      scenarioId: report.scenarioId,
      testLayer: 'llm',
      ...(completeRunIds ? { llmRunIds: runIds } : {}),
      // Scenarios are imported before their per-scenario snapshot. Reuse the
      // process boundary so proof binding also catches edits after those imports.
      runStartedAt: PROCESS_BOOT_TIME,
      // An errored run measured nothing it could pass; count it against the file.
      passed,
      failed: failed + errored,
      skipped: 0,
      collectionFailed: false,
      mutationPhase: null,
      commitSha: ledger.commitSha,
      worktreeDirty: ledger.worktreeDirty,
      ...(ledger.runtimeEnvironmentBefore ? { runtimeEnvironmentBefore: ledger.runtimeEnvironmentBefore } : {}),
      ...(ledger.runtimeEnvironmentAfter ? { runtimeEnvironmentAfter: ledger.runtimeEnvironmentAfter } : {}),
      ...(ledger.runtimeEnvironmentBeforeCaptureStatus
        ? { runtimeEnvironmentBeforeCaptureStatus: ledger.runtimeEnvironmentBeforeCaptureStatus } : {}),
      ...(ledger.runtimeEnvironmentAfterCaptureStatus
        ? { runtimeEnvironmentAfterCaptureStatus: ledger.runtimeEnvironmentAfterCaptureStatus } : {}),
    },
  };
}

/**
 * Absolute path of the source file that defines `scenarioId`, or undefined.
 *
 * Neither the id prefix nor the basename follows one convention (`op-S01-…` lives in
 * `operator/S01-….ts`, `sn-S01-…` in `papercup/SN01-….ts`), and ONE file may define
 * many scenarios (`S33-goal-agenda.ts` builds `` `su-S33-agenda-${c}` ``). So the file
 * is found by CONTENT: the non-test source (target dir first, then the whole tree)
 * holding the id as a string literal, else the longest template/concatenation prefix. A tie
 * or no match returns undefined — never a guessed path, because a wrong path
 * silently drops the ledger row or misattributes the evidence.
 */
export function resolveScenarioSourceFile(
  scenarioId: string,
  target: string,
  scenariosRoot: string,
): string | undefined {
  if (!existsSync(scenariosRoot)) return undefined;
  const files = listScenarioSources(scenariosRoot);
  const targetDir = join(scenariosRoot, target);
  const pools = [
    { files: files.filter((f) => f.startsWith(`${targetDir}/`)), allowRolePrefix: true },
    // The whole-tree fallback ignores a bare role prefix (`` `su-${n}` ``): outside the
    // scenario's own target dir it names any id of that role, so a fixture id builder in
    // a helper file captured su-S37 and misattributed its llm rows (gitnexus P-015).
    { files, allowRolePrefix: false },
  ];
  for (const pool of pools) {
    let best: { file: string; score: number } | null = null;
    let tie = false;
    for (const file of pool.files) {
      const score = idMatchScore(readFileSync(file, 'utf8'), scenarioId, pool.allowRolePrefix);
      if (score === 0) continue;
      if (!best || score > best.score) { best = { file, score }; tie = false; }
      else if (score === best.score) tie = true;
    }
    if (best) return tie ? undefined : best.file;
  }
  return undefined;
}

function listScenarioSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listScenarioSources(p));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/**
 * Infinity for an exact quoted id; else the longest template or quoted-concatenation prefix.
 * A role-only prefix (one segment, e.g. `su-`, `sn-`) counts only when `allowRolePrefix`.
 */
function idMatchScore(source: string, id: string, allowRolePrefix: boolean): number {
  for (const q of ["'", '"', '`']) if (source.includes(`${q}${id}${q}`)) return Number.POSITIVE_INFINITY;
  let best = 0;
  const prefixes = [
    ...Array.from(source.matchAll(/`([A-Za-z0-9_-]+)\$\{/g), m => m[1]!),
    ...Array.from(source.matchAll(/(['"])([A-Za-z0-9_-]+)\1\s*\+/g), m => m[2]!),
  ];
  for (const prefix of prefixes) {
    if (!prefix.includes('-') || !id.startsWith(prefix) || id.length <= prefix.length) continue;
    if (!allowRolePrefix && prefix.split('-').filter(Boolean).length < 2) continue;
    best = Math.max(best, prefix.length);
  }
  return best;
}

/** Workspace-relative POSIX path, or null when the scenario file is not on disk. */
export function scenarioLedgerPath(absPath: string | undefined, root: string): string | null {
  if (!absPath || !existsSync(absPath)) return null;
  const rel = relative(root, absPath);
  if (rel.startsWith('..')) return null;
  return rel.split(/[/\\]/).join(posix.sep);
}

type RuntimeReader = () => Promise<RecordedRuntimeEnvironment | null>;
type RuntimeCapture = { status: RuntimeEnvironmentCaptureStatus; witness?: RecordedRuntimeEnvironment };
const PROCESS_BOOT_TIME = new Date(Date.now() - process.uptime() * 1000).toISOString();
export interface LlmScenarioLedgerStart {
  worktree: WorktreeGitSnapshot | null;
  runtime: RuntimeCapture;
  readRuntimeEnvironment?: RuntimeReader;
}

/** Use the executing in-process SUT, rather than its external inference provider. */
export async function prepareLlmScenarioRuntimeReader(
  scenarioFilePath: string | undefined,
  transport: string,
): Promise<RuntimeReader | undefined> {
  if (transport !== 'in-process') return undefined;
  try {
    const workspaceId = resolveTestRunWorkspaceId();
    if (!workspaceId) return async () => null;
    const root = resolveAgentWorkspaceRoot(scenarioFilePath ? { projectDir: dirname(scenarioFilePath) } : {});
    const snapshot = captureWorktreeSnapshot(root);
    if (!snapshot.commit) return async () => null;
    const { reportRuntimeVintage, listRuntimeVintage, measureRuntimeVintageEnvironment } = await import('../runtime-vintage');
    // Concurrent CLI processes use separate units; the kernel still verifies the
    // actual local PID. Repeated scenarios in this process share one boot instant.
    const units = [`llm-test-in-process-${process.pid}`];
    await reportRuntimeVintage({ unit: units[0]!, workspaceId, pid: process.pid,
      treeSha: snapshot.commit, buildTime: PROCESS_BOOT_TIME });
    // Retain the original own-unit pin once. Each boundary independently reads
    // the live kernel through measureRuntimeVintageEnvironment; a fleet-wide PG
    // census cannot consume the bounded observation window after a model turn.
    const rows = (await listRuntimeVintage(workspaceId, undefined, units))
      .map(row => ({ ...row, extra: { ...row.extra } }));
    return async () => {
      const fingerprint = measureRuntimeVintageEnvironment(rows, units);
      return fingerprint ? { schemaVersion: 1, units, fingerprint, observedAt: new Date().toISOString() } : null;
    };
  } catch { return async () => null; }
}

/** Same bounded, recorder-owned observation contract as the Vitest reporter. */
async function captureRuntimeEnvironment(read?: RuntimeReader): Promise<RuntimeCapture> {
  if (!read) return { status: 'not-configured' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol('runtime-capture-timeout');
  try {
    const result = await Promise.race([
      Promise.resolve().then(read),
      new Promise<typeof timedOut>(resolve => { timer = setTimeout(() => resolve(timedOut), 1_000); }),
    ]);
    if (result === timedOut) return { status: 'timed-out' };
    if (result === null) return { status: 'unavailable' };
    const parsed = parseRecordedRuntimeEnvironment(result);
    if (!parsed) return { status: 'invalid' };
    return { status: 'captured', witness: { ...parsed, units: [...parsed.units], observedAt: new Date().toISOString() } };
  } catch { return { status: 'error' }; }
  finally { if (timer) clearTimeout(timer); }
}

/** Snapshot taken BEFORE the scenario runs, so the row can prove the tree and SUT were stable. */
export async function beginLlmScenarioLedger(
  scenarioFilePath?: string,
  readRuntimeEnvironment?: RuntimeReader,
): Promise<LlmScenarioLedgerStart> {
  let worktree: WorktreeGitSnapshot | null = null;
  try {
    const root = resolveAgentWorkspaceRoot(scenarioFilePath ? { projectDir: dirname(scenarioFilePath) } : {});
    worktree = captureWorktreeSnapshot(root);
  } catch { /* A missing tree snapshot must keep cleanliness unproven. */ }
  return { worktree, runtime: await captureRuntimeEnvironment(readRuntimeEnvironment), readRuntimeEnvironment };
}

/**
 * Insert the ledger row for a finished live scenario. Returns the new `test_runs.id`, or
 * null when it could not be recorded (no scenario file, DB unreachable). Never throws.
 */
export async function recordLlmScenarioTestRun(
  report: RunReport,
  scenarioFilePath: string | undefined,
  before: LlmScenarioLedgerStart | null,
  cleanBlock?: { experimentId: string; blockIndex: number; block: ToolDeliveryCleanBlock },
): Promise<number | null> {
  try {
    // The scenario's executed source owns this receipt. An inherited integration
    // root may point at the shared tree while lint:as-committed runs a private clone.
    const root = resolveAgentWorkspaceRoot(scenarioFilePath ? { projectDir: dirname(scenarioFilePath) } : {});
    const filePath = scenarioLedgerPath(scenarioFilePath, root);
    if (!filePath) {
      console.warn('[llm-test] test-run ledger source unavailable', { scenarioFilePath, root });
      return null;
    }

    const runtimeAfter = await captureRuntimeEnvironment(before?.readRuntimeEnvironment);
    const after = captureWorktreeSnapshot(root);
    const worktreeDirty = before?.worktree ? computeWorktreeDirty(before.worktree, after) : true;
    const { branch } = await resolveGitContext().catch(() => ({ branch: null as string | null }));
    const runGroupId = process.env.PAPERCUSP_TEST_RUN_GROUP ?? report.matrixGroupId ?? null;
    const workspaceId = resolveTestRunWorkspaceId();
    const harnessSlug = resolveTestRunHarnessSlug();

    const row = llmScenarioLedgerRow(report, {
      root, filePath, runGroupId, workspaceId, harnessSlug,
      commitSha: after.commit ?? null,
      worktreeDirty,
      runtimeEnvironmentBefore: before?.runtime.witness,
      runtimeEnvironmentAfter: runtimeAfter.witness,
      runtimeEnvironmentBeforeCaptureStatus: before?.runtime.status ?? 'not-configured',
      runtimeEnvironmentAfterCaptureStatus: runtimeAfter.status,
    });
    if (cleanBlock) {
      const { block, blockIndex, experimentId } = cleanBlock;
      if (report.scenarioId !== block.scenario || JSON.stringify(report.runs.map(run => run.summary.runId)) !== JSON.stringify(block.runIds)
          || report.runs.some(run => run.summary.variantId !== block.variantId)) throw new Error('Clean block differs from original scenario report.');
      row.executionDetails.llmBlockCustody = toolDeliveryBlockLedgerIdentity(experimentId, blockIndex, block);
    }

    // Same pool + options as ./storage, so the two writers share one connection budget.
    const sql = getLongLivedAdminPool('llm-testing-storage', { max: sharedUtilityPoolMax(), prepare: false });
    const inserted = (await sql`
      INSERT INTO harness_shared.test_runs
        (file_path, framework, status, duration_ms, started_at, finished_at, output_tail,
         run_group_id, source, branch, commit_sha, harness_slug, workspace_id, worktree_dirty, execution_details)
      VALUES
        (${row.filePath}, 'llm-test', ${row.status}, ${row.durationMs}, ${row.startedAt}, ${row.finishedAt},
         ${row.outputTail}, ${runGroupId}, ${resolveTestRunSource()}, ${branch ?? null}, ${after.commit ?? null},
         ${harnessSlug}, ${workspaceId}, ${worktreeDirty}, ${row.executionDetails as never}::jsonb)
      RETURNING id
    `) as unknown as Array<{ id: string | number }>;
    const id = inserted[0]?.id;
    return id === undefined ? null : Number(id);
  } catch (error) {
    console.warn('[llm-test] test-run ledger write failed', error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** Record a runner exception that occurred before runScenario could return a RunReport. */
export async function recordLlmScenarioTestRunFailure(
  failure: {
    scenarioId: string;
    startedAt: Date;
    finishedAt: Date;
    llmCallDiagnostics: LlmCallDiagnosticSummary;
  },
  scenarioFilePath: string | undefined,
  before: LlmScenarioLedgerStart | null,
): Promise<number | null> {
  // This synthetic report intentionally contains only the fields consumed by
  // llmScenarioLedgerRow: state, timing, timeout, and the bounded diagnostics.
  const report = {
    scenarioId: failure.scenarioId,
    verdict: 'errored',
    runs: [{
      status: 'errored',
      summary: {
        startedAt: failure.startedAt,
        finishedAt: failure.finishedAt,
        llmCallDiagnostics: failure.llmCallDiagnostics,
      },
    }],
    varianceByAxis: {},
    varianceFindings: [],
  } as unknown as RunReport;
  return recordLlmScenarioTestRun(report, scenarioFilePath, before);
}
