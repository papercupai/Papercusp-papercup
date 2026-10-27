/**
 * `system:operator-e2e-red-filer` — every red in the standing operator e2e run gets an owner
 * (plan operator-e2e-standing-isolated-run-2026-10-06 P-003, WI-10006806; umbrella WI-10006736).
 *
 * WHY. P-002's routine (`operator-e2e-isolated-action.ts`) runs the operator Playwright suite
 * nightly and its ledger reporter records one `harness_shared.test_runs` row per spec file under
 * the run group `operator-e2e-nightly:<fire>`. A ledger nobody reads is the failure WI-10006736
 * recorded: 40 of 58 specs had gone non-pass without anyone noticing. This sweep turns each red
 * spec in the newest COMPLETED nightly group into an owned work-item.
 *
 * WHY NOT THE EXISTING FILERS. Two filers already read `test_runs`, and neither fits a nightly
 * suite. The improvements watchdog's red-test collector (`improvements/watchdog.ts`) needs >= 3
 * failures in a 6h window, caps each source at 2 captures a tick, and files unassigned captures:
 * a spec that fails once a night never qualifies, and a 30-spec red night would take 15 ticks.
 * `testing:flakiness` autoFile files only flip-rate quarantine candidates. This module reuses
 * their pieces instead of their thresholds: the watchdog's repo-relative path normalization
 * (`normalizeRedTestPath`) and the shared create core (`createOneWorkItem`, which applies the
 * born-pending admission rules and the atomic create+claim).
 *
 * "ALREADY OWNED" (plan D-001 #2): an open work-item with a non-null assignee whose title or
 * summary names the spec. It is matched on the spec STEM as a whole token followed by `:` or
 * `.spec.` — the per-cluster items (WI-10006791 / WI-10006792) name specs as `home:15`, while a
 * filed item names the path. Two more outcomes keep the sweep idempotent without any watermark:
 *   - an item naming the spec that was CLOSED AFTER the group finished already answered this
 *     evidence (fixed or dropped since); the next red group re-files.
 *   - an OPEN but UNASSIGNED item naming the spec is assigned rather than duplicated.
 * So the same group can be swept every hour, and a spec red on two consecutive nights produces
 * exactly one owned item (P-003 acceptance).
 *
 * OWNER (plan D-002). The routine row's `payload_template.redOwner` names the owner explicitly.
 * Without one, the owner is the assignee of the umbrella item (`payload_template.umbrellaItem`,
 * default WI-10006736). With neither, the item is still filed, unassigned, and the result carries
 * `ownerUnresolved` so the routine's health shows the gap instead of hiding it.
 *
 * COMPLETENESS. A group whose run is still in flight (a pending/running task launched by
 * `system:operator-e2e-isolated`) is skipped: its ledger rows are partial until the reporter's
 * onEnd. The newest group that is NOT in flight is swept.
 */
import { open } from 'node:fs/promises';
import { parseSummaryLine, type SummaryLineFields } from '@papercusp/verification-harness';
import { listTasks } from '../../task-manager/store';
import { getOrgPg } from '@papercusp/db-org';
import { createOneWorkItem } from '../../agent-tools/work_items/_create-core';
import { claimWorkItem } from '../../work-items';
import { isTerminalStateInput } from '../../work-item-dispatch-states';
import { normalizeRedTestPath } from '../improvements/watchdog';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { OPERATOR_E2E_ISOLATED_ACTION, OPERATOR_E2E_RUN_GROUP_PREFIX } from './operator-e2e-isolated-action';
import { registerSystemAction, type SystemActionCtx, type SystemActionResult } from './system-actions';

export const OPERATOR_E2E_RED_FILER_ACTION = 'operator-e2e-red-filer';
/** The creator identity stamped on filed items. */
export const OPERATOR_E2E_RED_FILER_OWNER_ID = `system:${OPERATOR_E2E_RED_FILER_ACTION}`;
/** The umbrella item whose assignee owns reds when the routine names no explicit owner. */
export const OPERATOR_E2E_UMBRELLA_ITEM = 'WI-10006736';
/** How far back to look for nightly groups. A week covers a missed run or two. */
export const OPERATOR_E2E_GROUP_LOOKBACK_DAYS = 7;
/** Bound the ledger read; one scheduled run per hour fits comfortably inside this window. */
const OPERATOR_E2E_TASK_FAILURE_SCAN_LIMIT = 2_000;
/** Read only the tail, where the verification-harness contract writes its summary marker. */
const OPERATOR_E2E_TASK_LOG_TAIL_BYTES = 16 * 1024;
/** Output kept on a filed item: enough for the failing assertion, bounded for the item body. */
export const OPERATOR_E2E_RED_TAIL_CHARS = 1_500;

const RED_STATUSES = new Set(['fail', 'error']);

export interface GroupSpecRow {
  filePath: string;
  status: string;
  finishedAt: string;
  outputTail: string | null;
  failedCaseTitles: string[];
}

export interface RedSpec {
  specPath: string;
  status: string;
  finishedAt: string;
  outputTail: string | null;
  failedCaseTitles: string[];
}

export interface TerminalTaskFailure {
  taskId: string;
  runGroup: string;
  state: string;
  exitCode: number | null;
  exitReason: string | null;
  finishedAt: string;
  logPath: string | null;
  summaryLine?: SummaryLineFields;
}

async function readTaskLogSummaryLine(logPath: string | null): Promise<SummaryLineFields | null> {
  if (!logPath) return null;
  try {
    const file = await open(logPath, 'r');
    try {
      const size = (await file.stat()).size;
      const length = Math.min(size, OPERATOR_E2E_TASK_LOG_TAIL_BYTES);
      if (length === 0) return null;
      const buffer = Buffer.alloc(length);
      const start = size - length;
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await file.read(buffer, offset, length - offset, start + offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const lines = buffer.subarray(0, offset).toString('utf8').split(/\r?\n/).reverse();
      for (const line of lines) {
        const summary = parseSummaryLine(line);
        if (summary) return summary;
      }
      return null;
    } finally {
      await file.close();
    }
  } catch {
    // Keep filing the task failure even when its retained log is unavailable.
    return null;
  }
}

export interface OwnershipCandidate {
  id: string;
  status: string;
  assignee: string | null;
  closedAt: string | null;
  title: string;
  summary: string | null;
}

export type Ownership =
  | { kind: 'owned'; id: string; assignee: string }
  | { kind: 'resolved-after-evidence'; id: string }
  | { kind: 'unassigned-open'; id: string }
  | { kind: 'none' };

export interface TaskFailureFilingOutcome {
  taskId: string;
  runGroup: string;
  outcome: 'filed' | 'assigned' | 'owned' | 'resolved-after-evidence' | 'unassigned-open' | 'error';
  id?: string;
  detail?: string;
}

/** PURE: `apps/operator/e2e/home.spec.ts` -> `home`. */
export function specStem(specPath: string): string {
  const base = specPath.split('/').pop() ?? specPath;
  return base.replace(/\.(spec|test)\.[cm]?[jt]sx?$/, '').replace(/\.[cm]?[jt]sx?$/, '');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * PURE: a regex (valid in both JavaScript and Postgres ARE) that matches text NAMING the spec:
 * its stem as a whole token followed by `:` (a cluster item's `home:15`) or `.spec.` (a path).
 * `workspace-home:12` does not name `home`, because `-` counts as part of the token.
 */
export function specMentionPattern(specPath: string): string {
  return `(^|[^A-Za-z0-9_-])${escapeRegex(specStem(specPath))}(:[0-9]|\\.spec\\.)`;
}

export function namesSpec(text: string | null | undefined, specPath: string): boolean {
  return text != null && new RegExp(specMentionPattern(specPath)).test(text);
}

/** PURE: the latest row per spec in one group, kept only when that latest row is red. */
export function redSpecsFromGroupRows(rows: readonly GroupSpecRow[]): RedSpec[] {
  const latest = new Map<string, GroupSpecRow>();
  for (const row of rows) {
    const specPath = normalizeRedTestPath(row.filePath);
    if (specPath == null) continue;
    const prev = latest.get(specPath);
    if (!prev || Date.parse(row.finishedAt) > Date.parse(prev.finishedAt)) latest.set(specPath, { ...row, filePath: specPath });
  }
  return [...latest.values()]
    .filter((row) => RED_STATUSES.has(row.status))
    .map((row) => ({
      specPath: row.filePath,
      status: row.status,
      finishedAt: row.finishedAt,
      outputTail: row.outputTail,
      failedCaseTitles: row.failedCaseTitles,
    }))
    .sort((a, b) => a.specPath.localeCompare(b.specPath));
}

/**
 * PURE: decide whether a red spec already has an answer (plan D-001 #2). An open assigned item
 * wins; then an item closed after the evidence; then an open unassigned item to adopt.
 */
export function classifyOwnership(
  specPath: string,
  candidates: readonly OwnershipCandidate[],
  groupFinishedAt: string,
): Ownership {
  const naming = candidates.filter((c) => namesSpec(c.title, specPath) || namesSpec(c.summary, specPath));
  return classifyEvidenceOwnership(naming, groupFinishedAt);
}

/** Pure matching of already-scoped candidates against the evidence timestamp. */
function classifyEvidenceOwnership(candidates: readonly OwnershipCandidate[], evidenceAt: string): Ownership {
  const open = candidates.filter((c) => !isTerminalStateInput(c.status));
  const owned = open.find((c) => c.assignee != null && c.assignee.trim() !== '');
  if (owned) return { kind: 'owned', id: owned.id, assignee: owned.assignee as string };
  const evidenceMs = Date.parse(evidenceAt);
  const answered = candidates.find(
    (c) => isTerminalStateInput(c.status) && c.closedAt != null && Date.parse(c.closedAt) >= evidenceMs,
  );
  if (answered) return { kind: 'resolved-after-evidence', id: answered.id };
  if (open[0]) return { kind: 'unassigned-open', id: open[0].id };
  return { kind: 'none' };
}

/** Candidates are already matched by the exact managed task id in their payload. */
export function classifyTaskFailureOwnership(
  candidates: readonly OwnershipCandidate[],
  taskFinishedAt: string,
): Ownership {
  return classifyEvidenceOwnership(candidates, taskFinishedAt);
}

/** PURE: the filed item's title and summary. */
export function renderRedItem(red: RedSpec, runGroup: string): { title: string; summary: string } {
  const cases =
    red.failedCaseTitles.length > 0
      ? red.failedCaseTitles.map((title) => `- ${title}`).join('\n')
      : '- (the ledger row carries no case identities; read the output tail below)';
  const tail = (red.outputTail ?? '').replace(/\u001b\[[0-9;]*m/g, '').slice(-OPERATOR_E2E_RED_TAIL_CHARS);
  return {
    title: `Operator e2e red: ${red.specPath}`,
    summary:
      `${red.specPath} finished ${red.status} in the standing isolated operator e2e run ` +
      `(run group ${runGroup}, finished ${red.finishedAt}). Filed by ${OPERATOR_E2E_RED_FILER_OWNER_ID} ` +
      `(plan operator-e2e-standing-isolated-run-2026-10-06 P-003): every red in that run gets one owned item.\n\n` +
      `Failing tests:\n${cases}\n\n` +
      `Re-run just this spec in the isolated rig: npm --prefix apps/operator run test:e2e:isolated -- ${red.specPath}\n` +
      `Decide whether the spec is stale (the product changed on purpose) or the product regressed, and fix that side.\n\n` +
      `Output tail:\n${tail || '(no output captured)'}`,
  };
}

/** The failed child had no reporter rows, so this is a run-level item rather than a spec red. */
export function renderTaskFailureItem(failure: TerminalTaskFailure): { title: string; summary: string } {
  const exitCode = failure.exitCode == null ? 'unknown' : String(failure.exitCode);
  const reason = failure.exitReason?.slice(-500) || '(none recorded)';
  const logPath = failure.logPath ?? '(none recorded)';
  const parsedFailure = failure.summaryLine?.firstFailure;
  const firstFailure = parsedFailure
    ? `${parsedFailure.phase}/${parsedFailure.step ?? '-'}/${parsedFailure.reasonCode ?? '-'}`
    : 'none';
  const harnessResult = failure.summaryLine
    ? `\nParsed harness result: HARNESS_RESULT harness=${failure.summaryLine.harness} verdict=${failure.summaryLine.verdict} run=${failure.summaryLine.runId} first_failure=${firstFailure}`
    : '';
  return {
    title: `Operator e2e run has no reporter result: ${failure.runGroup}`,
    summary:
      `The managed operator e2e task ${failure.taskId} ended in state ${failure.state} ` +
      `(exit code ${exitCode}) at ${failure.finishedAt}, and no test_runs rows exist for run group ${failure.runGroup}. ` +
      `This is a run-level failure or unknown result; it does not identify a failing spec.\n\n` +
      `Task exit reason: ${reason}\nTask log: ${logPath}${harnessResult}\n\n` +
      `Inspect the isolated-run preparation/reporter path, then rerun the standing isolated suite if needed.`,
  };
}

export interface LatestGroup {
  runGroup: string;
  finishedAt: string;
}

export interface RedFilerDeps {
  /** Newest-first nightly groups recorded for this workspace inside the lookback. */
  listGroups(workspaceId: string): Promise<LatestGroup[]>;
  /** Run groups of runs that are still in flight. */
  inFlightGroups(workspaceId: string): Promise<string[]>;
  /** Recent terminal isolated-e2e tasks that did not prove a clean exit. */
  terminalTaskFailures(workspaceId: string): Promise<TerminalTaskFailure[]>;
  /** Exact reporter groups present for the supplied run-group ids. */
  groupsWithRows(workspaceId: string, runGroups: string[]): Promise<string[]>;
  /** Parse the bounded tail of a managed task log for its HARNESS_RESULT marker. */
  readTaskSummaryLine(logPath: string | null): Promise<SummaryLineFields | null>;
  groupRows(runGroup: string): Promise<GroupSpecRow[]>;
  ownershipCandidates(workspaceId: string, harnessSlug: string, specPath: string): Promise<OwnershipCandidate[]>;
  taskFailureOwnershipCandidates(
    workspaceId: string,
    harnessSlug: string,
    taskId: string,
  ): Promise<OwnershipCandidate[]>;
  /** The assignee of `id`, or null when unassigned or missing. */
  assigneeOf(id: string, harnessSlug: string): Promise<string | null>;
  create(args: Parameters<typeof createOneWorkItem>[0], ctx: Parameters<typeof createOneWorkItem>[1]): Promise<{ id: string | null; error?: string }>;
  assign(id: string, owner: string, harnessSlug: string): Promise<boolean>;
}

export interface RedFilingOutcome {
  specPath: string;
  outcome: 'filed' | 'assigned' | 'owned' | 'resolved-after-evidence' | 'unassigned-open' | 'error';
  id?: string;
  detail?: string;
}

export interface RedFilerResult {
  status: 'swept' | 'skipped';
  reason?: string;
  runGroup?: string;
  reds?: number;
  taskFailures?: number;
  owner?: string | null;
  ownerUnresolved?: boolean;
  outcomes?: RedFilingOutcome[];
  taskFailureOutcomes?: TaskFailureFilingOutcome[];
  taskFailureScanError?: string;
}

export async function resolveRedOwner(
  ctx: Pick<SystemActionCtx, 'payloadTemplate'>,
  harnessSlug: string,
  deps: Pick<RedFilerDeps, 'assigneeOf'>,
): Promise<string | null> {
  const template = ctx.payloadTemplate ?? {};
  const explicit = typeof template.redOwner === 'string' ? template.redOwner.trim() : '';
  if (explicit) return explicit;
  const umbrella =
    typeof template.umbrellaItem === 'string' && template.umbrellaItem.trim() !== ''
      ? template.umbrellaItem.trim()
      : OPERATOR_E2E_UMBRELLA_ITEM;
  return deps.assigneeOf(umbrella, harnessSlug).catch(() => null);
}

export async function fileOperatorE2eReds(
  ctx: Pick<SystemActionCtx, 'installSlug' | 'workspaceId' | 'payloadTemplate'>,
  deps: RedFilerDeps = defaultRedFilerDeps(),
): Promise<RedFilerResult> {
  const home = operatorHomeHarnessSlug();
  if (ctx.installSlug && ctx.installSlug !== home) {
    return { status: 'skipped', reason: `not the operator-home harness (got "${ctx.installSlug}", home is "${home}")` };
  }
  const harnessSlug = ctx.installSlug || home;
  const [groups, inFlight] = await Promise.all([deps.listGroups(ctx.workspaceId), deps.inFlightGroups(ctx.workspaceId)]);
  const busy = new Set(inFlight);
  const group = groups.find((g) => !busy.has(g.runGroup));
  const reds = group ? redSpecsFromGroupRows(await deps.groupRows(group.runGroup)) : [];
  let taskFailures: TerminalTaskFailure[] = [];
  let taskFailureScanError: string | undefined;
  try {
    const taskCandidates = (await deps.terminalTaskFailures(ctx.workspaceId)).filter((task) => !busy.has(task.runGroup));
    const reporterGroups = new Set(
      await deps.groupsWithRows(ctx.workspaceId, [...new Set(taskCandidates.map((task) => task.runGroup))]),
    );
    const missingReporterRows = taskCandidates.filter((task) => !reporterGroups.has(task.runGroup));
    taskFailures = await Promise.all(missingReporterRows.map(async (task) => {
      try {
        const summaryLine = await deps.readTaskSummaryLine(task.logPath);
        return summaryLine ? { ...task, summaryLine } : task;
      } catch {
        return task;
      }
    }));
  } catch (error) {
    taskFailureScanError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  }
  if (!group && taskFailures.length === 0) {
    return {
      status: 'skipped',
      reason: groups.length === 0 ? 'no nightly run group in the lookback' : 'the only recent group is still running',
      ...(taskFailureScanError ? { taskFailureScanError } : {}),
    };
  }
  const owner = reds.length > 0 || taskFailures.length > 0 ? await resolveRedOwner(ctx, harnessSlug, deps) : null;
  const taskFailureOutcomes: TaskFailureFilingOutcome[] = [];
  for (const failure of taskFailures) {
    try {
      const ownership = classifyTaskFailureOwnership(
        await deps.taskFailureOwnershipCandidates(ctx.workspaceId, harnessSlug, failure.taskId),
        failure.finishedAt,
      );
      if (ownership.kind === 'owned' || ownership.kind === 'resolved-after-evidence') {
        taskFailureOutcomes.push({ taskId: failure.taskId, runGroup: failure.runGroup, outcome: ownership.kind, id: ownership.id });
        continue;
      }
      if (ownership.kind === 'unassigned-open') {
        const assigned = owner ? await deps.assign(ownership.id, owner, harnessSlug) : false;
        taskFailureOutcomes.push({
          taskId: failure.taskId,
          runGroup: failure.runGroup,
          outcome: assigned ? 'assigned' : 'unassigned-open',
          id: ownership.id,
          ...(owner ? {} : { detail: 'no owner resolved' }),
        });
        continue;
      }
      const { title, summary } = renderTaskFailureItem(failure);
      const created = await deps.create(
        {
          kind: 'bug',
          title,
          summary,
          harness: harnessSlug,
          severity: 'major',
          ...(owner ? { assign_to: owner } : {}),
          payload: {
            source: OPERATOR_E2E_RED_FILER_ACTION,
            operatorE2eTaskId: failure.taskId,
            runGroup: failure.runGroup,
            taskState: failure.state,
            exitCode: failure.exitCode,
            exitReason: failure.exitReason,
            harnessResult: failure.summaryLine ?? null,
            plan: 'operator-e2e-standing-isolated-run-2026-10-06',
            umbrella: OPERATOR_E2E_UMBRELLA_ITEM,
          },
        },
        { ownerId: OPERATOR_E2E_RED_FILER_OWNER_ID, workspaceId: ctx.workspaceId, harnessSlug },
      );
      taskFailureOutcomes.push(
        created.id
          ? { taskId: failure.taskId, runGroup: failure.runGroup, outcome: 'filed', id: created.id }
          : { taskId: failure.taskId, runGroup: failure.runGroup, outcome: 'error', detail: created.error ?? 'create_failed' },
      );
    } catch (error) {
      taskFailureOutcomes.push({
        taskId: failure.taskId,
        runGroup: failure.runGroup,
        outcome: 'error',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const outcomes: RedFilingOutcome[] = [];
  for (const red of reds) {
    // Spec rows are derived from a group; task-only failures were handled above.
    if (!group) continue;
    try {
      const ownership = classifyOwnership(
        red.specPath,
        await deps.ownershipCandidates(ctx.workspaceId, harnessSlug, red.specPath),
        group.finishedAt,
      );
      if (ownership.kind === 'owned' || ownership.kind === 'resolved-after-evidence') {
        outcomes.push({ specPath: red.specPath, outcome: ownership.kind, id: ownership.id });
        continue;
      }
      if (ownership.kind === 'unassigned-open') {
        const assigned = owner ? await deps.assign(ownership.id, owner, harnessSlug) : false;
        outcomes.push({
          specPath: red.specPath,
          outcome: assigned ? 'assigned' : 'unassigned-open',
          id: ownership.id,
          ...(owner ? {} : { detail: 'no owner resolved' }),
        });
        continue;
      }
      const { title, summary } = renderRedItem(red, group.runGroup);
      const created = await deps.create(
        {
          kind: 'bug',
          title,
          summary,
          harness: harnessSlug,
          severity: 'major',
          ...(owner ? { assign_to: owner } : {}),
          payload: {
            source: OPERATOR_E2E_RED_FILER_ACTION,
            specPath: red.specPath,
            runGroup: group.runGroup,
            failedCaseTitles: red.failedCaseTitles,
            plan: 'operator-e2e-standing-isolated-run-2026-10-06',
            umbrella: OPERATOR_E2E_UMBRELLA_ITEM,
          },
        },
        { ownerId: OPERATOR_E2E_RED_FILER_OWNER_ID, workspaceId: ctx.workspaceId, harnessSlug },
      );
      outcomes.push(
        created.id
          ? { specPath: red.specPath, outcome: 'filed', id: created.id }
          : { specPath: red.specPath, outcome: 'error', detail: created.error ?? 'create_failed' },
      );
    } catch (error) {
      outcomes.push({ specPath: red.specPath, outcome: 'error', detail: error instanceof Error ? error.message : String(error) });
    }
  }
  // A routine-level owner is only required when this sweep leaves red work unassigned.
  // Existing assigned items and items resolved after the test evidence need no new owner.
  const ownerUnresolved =
    owner == null &&
    [...outcomes, ...taskFailureOutcomes].some(
      (outcome) => outcome.outcome === 'filed' || outcome.outcome === 'unassigned-open',
    );
  return {
    status: 'swept',
    ...(group ? { runGroup: group.runGroup } : {}),
    reds: reds.length,
    taskFailures: taskFailures.length,
    owner,
    ownerUnresolved,
    outcomes,
    taskFailureOutcomes,
    ...(taskFailureScanError ? { taskFailureScanError } : {}),
  };
}

/** The live implementations. Every query is workspace-scoped and bounded. */
export function defaultRedFilerDeps(): RedFilerDeps {
  const prefix = `${OPERATOR_E2E_RUN_GROUP_PREFIX}:%`;
  return {
    readTaskSummaryLine: readTaskLogSummaryLine,
    async listGroups(workspaceId) {
      const { sql } = getOrgPg();
      const rows = await sql<{ run_group_id: string; finished_at: Date | string }[]>`
        SELECT run_group_id, max(finished_at) AS finished_at
          FROM harness_shared.test_runs
         WHERE run_group_id LIKE ${prefix}
           AND workspace_id = ${workspaceId}
           AND created_at > now() - make_interval(days => ${OPERATOR_E2E_GROUP_LOOKBACK_DAYS})
         GROUP BY run_group_id
         ORDER BY max(finished_at) DESC
         LIMIT 10`;
      return rows.map((r) => ({ runGroup: r.run_group_id, finishedAt: new Date(r.finished_at).toISOString() }));
    },
    async inFlightGroups(workspaceId) {
      const rows = await listTasks({
        workspaceId,
        launchedBy: `system:${OPERATOR_E2E_ISOLATED_ACTION}`,
        states: ['pending', 'running'],
        limit: 5,
      });
      return rows
        .map((row) => (row.detail as { runGroup?: unknown } | null | undefined)?.runGroup)
        .filter((group): group is string => typeof group === 'string');
    },
    async terminalTaskFailures(workspaceId) {
      const cutoff = Date.now() - OPERATOR_E2E_GROUP_LOOKBACK_DAYS * 24 * 60 * 60 * 1_000;
      const rows = await listTasks({
        workspaceId,
        launchedBy: `system:${OPERATOR_E2E_ISOLATED_ACTION}`,
        classes: ['test-run'],
        states: ['exited', 'timed_out', 'stranded', 'ended_unobserved'],
        includeEnded: true,
        limit: OPERATOR_E2E_TASK_FAILURE_SCAN_LIMIT,
      });
      return rows.flatMap((row) => {
        const runGroup = row.detail?.runGroup;
        const finishedAt = row.endedAt;
        const finishedMs = finishedAt ? Date.parse(finishedAt) : NaN;
        const hasNoPass = row.state === 'exited'
          ? row.exitCode !== 0
          : row.state === 'timed_out' || row.state === 'stranded' || row.state === 'ended_unobserved';
        if (
          !hasNoPass ||
          typeof runGroup !== 'string' ||
          !runGroup.startsWith(`${OPERATOR_E2E_RUN_GROUP_PREFIX}:`) ||
          !finishedAt ||
          !Number.isFinite(finishedMs) ||
          finishedMs < cutoff
        ) {
          return [];
        }
        return [{
          taskId: row.taskId,
          runGroup,
          state: row.state,
          exitCode: row.exitCode ?? null,
          exitReason: row.exitReason ?? null,
          finishedAt,
          logPath: row.logPath ?? null,
        }];
      });
    },
    async groupsWithRows(workspaceId, runGroups) {
      const unique = [...new Set(runGroups)];
      if (unique.length === 0) return [];
      const { sql } = getOrgPg();
      const rows = await sql<{ run_group_id: string }[]>`
        SELECT DISTINCT run_group_id
          FROM harness_shared.test_runs
         WHERE workspace_id = ${workspaceId}
           AND run_group_id = ANY(${sql.array(unique)})`;
      return rows.map((row) => row.run_group_id);
    },
    async groupRows(runGroup) {
      const { sql } = getOrgPg();
      const rows = await sql<{ file_path: string; status: string; finished_at: Date | string; output_tail: string | null; titles: unknown }[]>`
        SELECT file_path, status, finished_at, output_tail, execution_details->'failedCaseTitles' AS titles
          FROM harness_shared.test_runs
         WHERE run_group_id = ${runGroup}
         ORDER BY finished_at DESC
         LIMIT 500`;
      return rows.map((r) => ({
        filePath: r.file_path,
        status: r.status,
        finishedAt: new Date(r.finished_at).toISOString(),
        outputTail: r.output_tail,
        failedCaseTitles: Array.isArray(r.titles) ? r.titles.filter((t): t is string => typeof t === 'string') : [],
      }));
    },
    async ownershipCandidates(workspaceId, harnessSlug, specPath) {
      const { sql } = getOrgPg();
      const pattern = specMentionPattern(specPath);
      const rows = await sql<{ feature_id: string; status: string; taken_by: string | null; closed_ts: Date | string | null; title: string; summary: string | null }[]>`
        SELECT feature_id, status, taken_by, closed_ts, title, summary
          FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId}
           AND harness_slug = ${harnessSlug}
           AND lane IS DISTINCT FROM 'observation'
           AND (title ~ ${pattern} OR coalesce(summary, '') ~ ${pattern})
         ORDER BY updated_ts DESC
         LIMIT 25`;
      return rows.map((r) => ({
        id: r.feature_id,
        status: r.status,
        assignee: r.taken_by,
        closedAt: r.closed_ts == null ? null : new Date(r.closed_ts).toISOString(),
        title: r.title,
        summary: r.summary,
      }));
    },
    async taskFailureOwnershipCandidates(workspaceId, harnessSlug, taskId) {
      const { sql } = getOrgPg();
      const rows = await sql<{ feature_id: string; status: string; taken_by: string | null; closed_ts: Date | string | null; title: string; summary: string | null }[]>`
        SELECT feature_id, status, taken_by, closed_ts, title, summary
          FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId}
           AND harness_slug = ${harnessSlug}
           AND lane IS DISTINCT FROM 'observation'
           AND payload->>'source' = ${OPERATOR_E2E_RED_FILER_ACTION}
           AND payload->>'operatorE2eTaskId' = ${taskId}
         ORDER BY updated_ts DESC
         LIMIT 25`;
      return rows.map((r) => ({
        id: r.feature_id,
        status: r.status,
        assignee: r.taken_by,
        closedAt: r.closed_ts == null ? null : new Date(r.closed_ts).toISOString(),
        title: r.title,
        summary: r.summary,
      }));
    },
    async assigneeOf(id, harnessSlug) {
      const { sql } = getOrgPg();
      const rows = await sql<{ taken_by: string | null; status: string }[]>`
        SELECT taken_by, status FROM harness_shared.work_items
         WHERE feature_id = ${id} AND harness_slug = ${harnessSlug}
         LIMIT 1`;
      const row = rows[0];
      return row && !isTerminalStateInput(row.status) && row.taken_by ? row.taken_by : null;
    },
    async create(args, ctx) {
      const res = await createOneWorkItem(args, ctx);
      return res.ok ? { id: res.workItem.id } : { id: null, error: res.error ?? 'create_failed' };
    },
    async assign(id, owner, harnessSlug) {
      const claimed = await claimWorkItem(id, owner, { harness: harnessSlug, assignedBy: OPERATOR_E2E_RED_FILER_OWNER_ID });
      return claimed != null;
    },
  };
}

registerSystemAction(
  OPERATOR_E2E_RED_FILER_ACTION,
  async (ctx: SystemActionCtx): Promise<SystemActionResult> => {
    const result = await fileOperatorE2eReds(ctx);
    const specErrors = (result.outcomes ?? []).filter((o) => o.outcome === 'error');
    const taskErrors = (result.taskFailureOutcomes ?? []).filter((o) => o.outcome === 'error');
    if (result.status === 'skipped') console.log(`[${OPERATOR_E2E_RED_FILER_ACTION}] skip: ${result.reason}`);
    const softErrors = [
      ...(specErrors.length || taskErrors.length
        ? [`${specErrors.length} red spec(s) and ${taskErrors.length} terminal task failure(s) could not be filed`]
        : []),
      ...(result.taskFailureScanError ? [`terminal task scan failed: ${result.taskFailureScanError}`] : []),
      ...(result.ownerUnresolved ? ['operator e2e failures were filed without an owner: set payload_template.redOwner or assign the umbrella item'] : []),
    ];
    return {
      diagnostics: { ...result },
      ...(softErrors.length > 0 ? { softError: softErrors.join('; ').slice(0, 500) } : {}),
    };
  },
  { routineTimeoutMs: 120_000 },
);
