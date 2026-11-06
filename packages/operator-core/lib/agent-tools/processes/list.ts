/**
 * processes:list — the PROVENANCE inventory of running tasks
 * (task-manager-no-escape-2026-07-27, P-013).
 *
 * Deliberately not a `ps` replacement, and deliberately not a widening of
 * `dev:processes` (which stays frozen at its six agent kinds — plan D-002 explains
 * why that decision is untouched). `ps` and `dev:processes` both answer a
 * KERNEL-shaped question: what processes exist. This answers the one neither can —
 * who launched it, for which work-item and plan, under what budget and deadline,
 * where its log is, and what it is costing right now. That is a join over
 * `harness_shared.task_ledger`, not a process-table read.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listTasksPage, residueTaskId } from '../../task-manager/store';
import { resolveTaskConfinement } from '../../task-manager/confinement';
import { isTaskManagerEnabled } from '../../task-manager/enabled';
import { reconcileTick, type ReconcileTickResult } from '../../task-manager/reconcile-tick';
import { defaultForeignSignature } from '../../task-manager/scan';
import { cpuBusyPercent } from '../../task-manager/inventory-shared';
import { REPO_ROOT } from '../docs/_repo-paths';
import { TASK_STATES, taskIdFromScopeUnit } from '../../task-manager/types';
import type { TaskRow } from '../../task-manager/types';
import { redactSensitiveText } from '../../sensitive-text';
import { readSuperuserToken } from '../../superuser-token';
import { ATTEMPT_EVIDENCE_MAX_CHARS } from '../../verification-attempts/attempt-ledger';

function mb(bytes: number | null | undefined): number | null {
  return bytes == null ? null : Math.round(bytes / 1048576);
}

function ageSec(startedAt: string): number {
  const t = Date.parse(startedAt);
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : 0;
}

function sampleTimestampMs(sampledAt: string | null | undefined): number | null {
  if (sampledAt == null) return null;
  const ms = Date.parse(sampledAt);
  return Number.isFinite(ms) ? ms : null;
}

function sampleAgeSec(sampledAt: string | null | undefined, nowMs: number): number | null {
  const sampledAtMs = sampleTimestampMs(sampledAt);
  return sampledAtMs === null ? null : Math.max(0, Math.round((nowMs - sampledAtMs) / 1000));
}

function sampleFreshness(
  sampledAt: string | null | undefined,
  lastSeenAt: string,
): 'current' | 'stale' | 'unknown' {
  const sampledAtMs = sampleTimestampMs(sampledAt);
  const lastSeenAtMs = sampleTimestampMs(lastSeenAt);
  if (sampledAtMs === null || lastSeenAtMs === null) return 'unknown';
  return sampledAtMs < lastSeenAtMs ? 'stale' : 'current';
}

function safeDiagnosticText(text: string, maxChars?: number, knownSecrets: readonly string[] = []): string {
  const redacted = redactSensitiveText(text, knownSecrets);
  return maxChars === undefined ? redacted : redacted.slice(0, maxChars);
}

const verificationAttemptSchema = z.object({
  schemaVersion: z.literal(1).nullable(),
  outcome: z.enum(['pass', 'fail', 'cancelled', 'unknown']).nullable(),
  fingerprint: z.string().nullable(),
  label: z.string().nullable(),
  source: z.enum(['structured', 'log', 'exit']).nullable(),
  structured: z.object({
    phase: z.string(),
    step: z.string().nullable(),
    reasonCode: z.string(),
  }).nullable(),
  commandFingerprint: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  recordedAt: z.string().nullable(),
  evidenceExcerpt: z.string().nullable(),
  evidenceExcerptTruncated: z.boolean(),
});

function projectVerificationAttempt(
  detail: Record<string, unknown>,
  knownSecrets: readonly string[],
): z.infer<typeof verificationAttemptSchema> | null {
  const value = detail.verificationAttempt;
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const outcome = raw.outcome === 'pass' || raw.outcome === 'fail' || raw.outcome === 'cancelled' || raw.outcome === 'unknown'
    ? raw.outcome
    : null;
  const source = raw.source === 'structured' || raw.source === 'log' || raw.source === 'exit' ? raw.source : null;
  const structuredValue = raw.structured;
  const structuredRaw = structuredValue != null && typeof structuredValue === 'object' && !Array.isArray(structuredValue)
    ? structuredValue as Record<string, unknown>
    : null;
  const phase = structuredRaw && typeof structuredRaw.phase === 'string' ? structuredRaw.phase : null;
  const step = structuredRaw && typeof structuredRaw.step === 'string' ? structuredRaw.step : null;
  const reasonCode = structuredRaw && typeof structuredRaw.reasonCode === 'string' ? structuredRaw.reasonCode : null;
  const redactedExcerpt = typeof raw.evidenceExcerpt === 'string'
    ? redactSensitiveText(raw.evidenceExcerpt, knownSecrets)
    : null;

  return {
    schemaVersion: raw.schemaVersion === 1 ? 1 : null,
    outcome,
    fingerprint: typeof raw.fingerprint === 'string' ? safeDiagnosticText(raw.fingerprint, 80, knownSecrets) : null,
    label: typeof raw.label === 'string' ? safeDiagnosticText(raw.label, 300, knownSecrets) : null,
    source,
    structured: phase !== null && reasonCode !== null
      ? {
          phase: safeDiagnosticText(phase, 160, knownSecrets),
          step: step === null ? null : safeDiagnosticText(step, 200, knownSecrets),
          reasonCode: safeDiagnosticText(reasonCode, 200, knownSecrets),
        }
      : null,
    commandFingerprint: typeof raw.commandFingerprint === 'string'
      ? safeDiagnosticText(raw.commandFingerprint, 80, knownSecrets)
      : null,
    durationMs: typeof raw.durationMs === 'number' && Number.isSafeInteger(raw.durationMs) && raw.durationMs >= 0
      ? raw.durationMs
      : null,
    recordedAt: typeof raw.recordedAt === 'string' ? safeDiagnosticText(raw.recordedAt, 64, knownSecrets) : null,
    evidenceExcerpt: redactedExcerpt === null
      ? null
      : redactedExcerpt.slice(-ATTEMPT_EVIDENCE_MAX_CHARS),
    evidenceExcerptTruncated: raw.evidenceExcerptTruncated === true ||
      (redactedExcerpt !== null && redactedExcerpt.length > ATTEMPT_EVIDENCE_MAX_CHARS),
  };
}

function localDiagnosticSecrets(): readonly string[] {
  const token = readSuperuserToken();
  return token ? [token] : [];
}

type CpuSample = {
  cpuUsecTotal: number;
  sampledAtMs: number;
};

const CPU_SAMPLE_RETENTION_MS = 15 * 60 * 1000;
const cpuSamples = new Map<string, CpuSample>();

type ReconcileTerminalState = 'stranded' | 'ended_unobserved';

/**
 * A dry-run reconciliation is authoritative for a live read, but deliberately
 * does not update the ledger. Overlay its terminal verdicts on the rows shown
 * by `processes:list` so a just-exited task is not reported as still running
 * until the next persistence tick. The returned rows are copies: `live:true`
 * remains a writes-nothing read.
 */
function overlayReconcileTerminalVerdicts(rows: readonly TaskRow[], tick: ReconcileTickResult): TaskRow[] {
  const terminalByTaskId = new Map<string, { state: ReconcileTerminalState; reason: string }>();
  for (const verdict of tick.result.stranded ?? []) {
    terminalByTaskId.set(verdict.taskId, { state: 'stranded', reason: verdict.reason });
  }
  for (const verdict of tick.result.endedUnobserved ?? []) {
    terminalByTaskId.set(verdict.taskId, { state: 'ended_unobserved', reason: verdict.reason });
  }

  return rows.map((row) => {
    const verdict = terminalByTaskId.get(row.taskId);
    return verdict ? { ...row, state: verdict.state, exitReason: verdict.reason } : row;
  });
}

function pruneCpuSamples(nowMs: number): void {
  for (const [taskId, sample] of cpuSamples) {
    if (nowMs - sample.sampledAtMs > CPU_SAMPLE_RETENTION_MS) {
      cpuSamples.delete(taskId);
    }
  }
}

function currentCpuBusyPercent(
  taskId: string,
  cpuUsec: number | null | undefined,
  sampledAt: string | null | undefined,
): number | null {
  const sampledAtMs = sampleTimestampMs(sampledAt);
  if (cpuUsec == null || sampledAtMs === null || !Number.isFinite(sampledAtMs) || sampledAtMs <= 0) return null;
  const next = { cpuUsecTotal: cpuUsec, sampledAtMs };
  const previous = cpuSamples.get(taskId);
  cpuSamples.set(taskId, next);
  return cpuBusyPercent(previous, next);
}

const taskResultSchema = z.object({
  ok: z.boolean(),
  enabled: z.boolean().optional(),
  reason: z.string().optional(),
  counts: z.object({
    total: z.number().int().nonnegative(),
    byState: z.record(z.string(), z.number().int().nonnegative()),
    byClass: z.record(z.string(), z.number().int().nonnegative()),
  }),
  taskPage: z.object({
    limit: z.number().int().positive(),
    returned: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }).optional(),
  // `live` is the reconciler's deliberately extensible diagnostic summary. Keep
  // it lossless for structured callers rather than duplicating its evolving
  // shape here; the human-facing text remains the same JSON envelope.
  live: z.record(z.string(), z.unknown()).optional(),
  tasks: z.array(
    z.object({
      taskId: z.string(),
      class: z.string(),
      title: z.string(),
      state: z.string(),
      launchedBy: z.string(),
      workItemId: z.string().nullable().optional(),
      planSlug: z.string().nullable().optional(),
      parentTaskId: z.string().nullable().optional(),
      rootTaskId: z.string(),
      ageSec: z.number().int().nonnegative(),
      rssMb: z.number().int().nonnegative().nullable(),
      peakRssMb: z.number().int().nonnegative().nullable(),
      cpuSec: z.number().int().nonnegative().nullable(),
      cpuBusyPercent: z.number().nonnegative().nullable(),
      cpuSampledAt: z.string().nullable(),
      cpuSampleAgeSec: z.number().int().nonnegative().nullable(),
      cpuSampleFreshness: z.enum(['current', 'stale', 'unknown']),
      rssSampledAt: z.string().nullable(),
      rssSampleAgeSec: z.number().int().nonnegative().nullable(),
      rssSampleFreshness: z.enum(['current', 'stale', 'unknown']),
      pids: z.number().int().nonnegative().nullable(),
      livePids: z.array(z.number().int().positive()).nullable(),
      confined: z.boolean(),
      scopeUnit: z.string().nullable().optional(),
      // P-023/D-111. Flat here because a result schema describes the wire shape; the
      // authority on which fields co-occur is the `TaskConfinement` union itself.
      // `insideOperatorCgroup` is absent — never `false` — when it is unknown.
      confinement: z.object({
        confined: z.boolean(),
        cgroupPath: z.string().nullable(),
        scopeUnit: z.string().nullable(),
        source: z.enum(['derived-from-scope-unit', 'not-derivable', 'recorded-at-spawn', 'observed-at-reconcile']),
        insideOperatorCgroup: z.boolean().optional(),
        reason: z.string().optional(),
      }),
      memoryMaxMb: z.number().int().nonnegative().nullable(),
      deadlineAt: z.string().nullable().optional(),
      exitCode: z.number().int().nullable().optional(),
      exitReason: z.string().nullable().optional(),
      termination: z
        .object({
          capturedAt: z.string(),
          reason: z.string().nullable(),
          serviceResult: z.string().nullable(),
          scopeUnit: z.string(),
          cgroupPath: z.string().nullable(),
          invocationId: z.string().nullable(),
          memoryMaxMb: z.number().int().nonnegative().nullable(),
          peakRssMb: z.number().int().nonnegative().nullable(),
          peakMemorySource: z.enum(['systemd', 'cgroup-sample', 'unknown']),
        })
        .nullable(),
      logPath: z.string().nullable().optional(),
      verificationAttempt: verificationAttemptSchema.nullable().optional(),
    }),
  ),
});

export default defineTool({
  name: 'processes:list',
  profile: 'engineer',
  // @not-a-cell live state, but a SINGLE DOOR: `queryTasks()` (task-manager/store.ts) is the one
  // derivation of the ledger join. `listTasks()` is its array view for /admin/tasks; this tool
  // uses `listTasksPage()` to include exact population metadata, which is axis 5 satisfied
  // without a registry entry. Nothing answers this question twice: `ps` and `dev:processes` answer
  // the KERNEL-shaped question (what exists), frozen at six agent kinds by task-manager D-002, and
  // `scheduler:running` answers bee-run liveness. Registering a cell here would add a door without
  // removing one — the D-010 failure this gate exists to prevent (see WI-6464 and the exemption's
  // reason-class (ii)). Revisit the moment a SECOND surface derives the inventory independently.
  description:
    'Task-ledger inventory of operator-launched work: launcher/work-item/plan, budget/deadline, log, CPU/RSS/PIDs, confinement, unaccounted processes and verifier scopes. `live:true` reconciles with the kernel; `taskPage` separates ledger coverage from scan bounds.',
  capability: 'intel:read',
  guidance: {
    when: 'You want to know WHAT IS RUNNING AND WHY — who started a job, what a work-item costs, which task uses CPU or memory, whether anything bypassed the spawn chokepoint, whether a managedSpawn job is still alive, or to inspect one slow-attempt failure excerpt.',
    notWhen:
      "NOT a `ps` substitute — a process nothing in this operator launched is invisible unless it landed in our cgroup slice. For the six tracked AGENT process kinds use `dev:processes`; for a raw host process list, plain `ps`/`pgrep` is correct and is never gated. For a capability:bash job's OUTPUT use `capability:bash_output`.",
    chaining:
      'Filter one exact row with `taskId`, `scopeUnit`, `invocationId` or `dispatchCallId`. Use `includeAttemptEvidence:true` for its bounded redacted excerpt. Lost a bash launch response? Search by `dispatchCallId` with `includeEnded:true`; do not relaunch. Then use `processes:kill`, `freeze` or `limit` on the exact task. Check `taskPage.truncated` and kernel scan truncation before treating a row as absent.',
    returns:
      '{ ok, counts:{ byState, byClass }, tasks:[{ taskId, class, title, state, launchedBy, workItemId, planSlug, ageSec, rssMb, peakRssMb, cpuSec, cpuBusyPercent, pids: number|null (PID count), livePids: number[]|null (PID array for live unaccounted tasks; null otherwise), confined, scopeUnit, confinement, deadlineAt, logPath }], live?: { unaccountedGroups?: Array<{ taskId: string (stable ledger key), pids: number[] (PID array), ageSec: number|null }>, exactScopeUnitMatches?: Array<{ taskId: string, pids: number[], ageSec: number|null (lower bound; null if any PID start is unknown) }> } } — `confinement` answers "what confines this task, and therefore what can kill it": `{ confined, cgroupPath, scopeUnit, source, insideOperatorCgroup?, reason? }`. Read `source` before the path. `derived-from-scope-unit` is the trustworthy case — the path is DERIVED, because the stored `cgroup_path` column holds the SPAWNER cgroup on ~1300 historical rows and would answer "would restarting the operator kill this agent?" with the pre-EI-9748 YES (D-111). `insideOperatorCgroup` IS that answer, and is absent — never false — when unknown. `not-derivable` means confined but no scope unit was recorded: that is UNKNOWN, not unconfined, so `confined` stays true. `recorded-at-spawn` is the unconfined case, where the /proc read is correct. `observed-at-reconcile` means an unaccounted residue had an exact `pc-<taskId>` scope and matching kernel-scanned path; it uses that observed path because its original task class is unknown. To find your OWN row pass `coordOwnerId` (your coord owner id) — `launchedBy` is whoever spawned you, and `pgrep -f <ownerId>` self-matches your own command line. `cpuSec` is cumulative CPU time; `cpuBusyPercent` is derived from two cumulative samples (100% = one saturated core) and is null until a second valid sample exists. Unfiltered `live:true` reads include `live.verifierGroups` and other reconciler groups; a task-filtered live read keeps the compact reconciliation summary but omits unrelated global group samples. `confined:false` means the task is ledgered but NOT cgroup-isolated, so a kill falls back to a pid signal and freeze is unavailable. An exact-identity lookup (`dispatchCallId` especially) that finds nothing is not proof no command ran: legacy jobs may lack that identity.',
  },
  requirePrincipal: false,
  // Release-fixer must inspect the managed task ledger when classifying a
  // failed checkpoint or diagnosing a dead prior fixer. Mug receives this same
  // read-only inventory for the lifecycle-verdict pass; the protected
  // processes:kill capability remains unavailable to that role.
  agentRoles: ['operator', 'architect', 'debugger', 'cup', 'mug', 'release-fixer'],
  args: z.object({
    state: z.enum(TASK_STATES).optional().describe('filter by one lifecycle state (shorthand for `states: [state]`)'),
    states: z.array(z.enum(TASK_STATES)).optional().describe('filter by one or more lifecycle states'),
    classes: z.array(z.string().min(1)).max(20).optional().describe('filter by task class'),
    launchedBy: z.string().max(120).optional().describe('only tasks this agent id launched'),
    coordOwnerId: z
      .string()
      .max(120)
      .optional()
      .describe(
        'only tasks BELONGING to this coord owner id — pass your own to find your own row. Not `launchedBy`, which is whoever SPAWNED it (for a fleet member those differ, so launchedBy cannot answer "which row is me"). Recorded only when the spawn supplied it: ~70% of agent-session rows and none of bash-job/sidecar/test-run (measured 2026-09-02). So an empty result means "no row RECORDED this owner id", NOT "this agent has no task" — do not read it as absence.',
    ),
    taskId: z.string().max(64).optional().describe('one exact task-ledger row (also accepted by processes:kill)'),
    dispatchCallId: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe('exact server-owned capability:bash dispatch identity; workspace-scoped lookup before limit, without relaunch'),
    scopeUnit: z
      .string()
      .max(255)
      .optional()
      .describe('one exact systemd scope/service unit; pushed into the ledger query before limit'),
    invocationId: z
      .string()
      .max(255)
      .optional()
      .describe('one exact systemd InvocationID from terminal provenance; pushed into the ledger query before limit'),
    workItemId: z.string().max(120).optional().describe('only tasks attributed to this work-item'),
    rootTaskId: z.string().max(64).optional().describe('one task tree'),
    includeEnded: z.boolean().optional().describe('include finished tasks (the "what ran overnight" read)'),
    includeAttemptEvidence: z.boolean().optional().describe('include the redacted, bounded verification-attempt stamp; requires an exact taskId'),
    live: z
      .boolean()
      .optional()
      .describe('reconcile against the kernel before answering — authoritative, ~100ms slower, writes nothing'),
    limit: z.number().int().positive().max(2000).optional(),
  }),
  // Keep the lossless object available as MCP structuredContent for programmatic
  // callers (ptool / MCP clients that request `_meta.structured`). The text body
  // still goes through the ordinary result door for model-facing calls, but a
  // door-truncated JSON string is not a valid machine-readable response.
  result: taskResultSchema,
  async handler(args) {
    if (args.includeAttemptEvidence && !args.taskId) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: false,
            reason: 'includeAttemptEvidence requires an exact taskId to keep the evidence read bounded',
            counts: { total: 0, byState: {}, byClass: {} },
            tasks: [],
          }),
        }],
      };
    }
    // WI-6499: with the task manager flag-OFF nothing enrols, so the ledger is
    // frozen at whatever it last held. Serving those rows would be worse than
    // serving none — they read as "what is running" while describing processes
    // that exited long ago. Say the subsystem is off instead.
    if (!(await isTaskManagerEnabled('processes:list'))) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                ok: true,
                enabled: false,
                reason:
                  'The task manager is disabled (papercusp-task-manager is off), so no spawns are being ledgered and the reconciler is not running. Use `ps`/`pgrep` for a raw host process list, or `dev:processes` for the tracked agent kinds.',
                counts: { total: 0, byState: {}, byClass: {} },
                tasks: [],
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Read once per inventory, not once per row. readSuperuserToken() tracks the
    // token file's mtime, so a rotation is reflected on the next tool call.
    const diagnosticSecrets = localDiagnosticSecrets();

    const hasTaskSelector =
      args.state !== undefined ||
      (args.states?.length ?? 0) > 0 ||
      (args.classes?.length ?? 0) > 0 ||
      args.launchedBy !== undefined ||
      args.coordOwnerId !== undefined ||
      args.taskId !== undefined ||
      args.dispatchCallId !== undefined ||
      args.scopeUnit !== undefined ||
      args.invocationId !== undefined ||
      args.workItemId !== undefined ||
      args.rootTaskId !== undefined;

    let live: unknown;
    let liveTick: ReconcileTickResult | undefined;
    if (args.live) {
      const tick = await reconcileTick({
        dryRun: true,
        scanOptions: { foreignSignature: defaultForeignSignature(REPO_ROOT) },
      });
      liveTick = tick;
      // Keep scalar totals distinct from the group arrays below. Unsuffixed
      // names such as `unaccounted` are easy for consumers to treat as lists,
      // then silently turn into [] through an Array.isArray fallback.
      const summary = tick.summary;
      const liveSummary = {
        aliveCount: summary.alive,
        strandedCount: summary.stranded,
        endedUnobservedCount: summary.endedUnobserved,
        unaccountedCount: summary.unaccounted,
        unaccountedPidCount: summary.unaccountedPids,
        abandonedWindowCount: summary.abandonedWindow,
        abandonedWindowPidCount: summary.abandonedWindowPids,
        consoleWindowCount: summary.consoleWindow,
        consoleWindowPidCount: summary.consoleWindowPids,
        verifierScopeCount: summary.verifierScope,
        verifierScopePidCount: summary.verifierScopePids,
        foreignCount: summary.foreign,
        overdueCount: summary.overdue,
        tooYoungCount: summary.tooYoung,
        degraded: tick.degraded,
        degradedReason: tick.degradedReason,
        // Keep scan bounds visible on filtered reads too; an exact group list can
        // still come from a census whose owned or foreign pass hit its cap.
        ownedTruncated: tick.scan.ownedTruncated,
        foreignTruncated: tick.scan.foreignTruncated,
      };
      const processStartsByPid = new Map(
        tick.scannedProcesses.map((process) => [process.pid, process.startedAtMs] as const),
      );
      const groupAgeSampledAtMs = Date.now();
      const groupAgeSec = (pids: number[]): number | null => {
        if (pids.length === 0) return null;
        let youngestStartAtMs = Number.NEGATIVE_INFINITY;
        for (const pid of pids) {
          const startedAtMs = processStartsByPid.get(pid);
          if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs)) return null;
          youngestStartAtMs = Math.max(youngestStartAtMs, startedAtMs);
        }
        // The scope predates its youngest PID, so this is a conservative age lower bound.
        return Math.max(0, Math.floor((groupAgeSampledAtMs - youngestStartAtMs) / 1000));
      };
      const mapLiveGroup = (group: {
        cgroupPath: string;
        scopeUnit: string | null;
        pids: number[];
        sampleCmdline: string;
      }) => ({
        taskId: (group.scopeUnit && taskIdFromScopeUnit(group.scopeUnit)) || residueTaskId(group.cgroupPath),
        cgroupPath: group.cgroupPath,
        scopeUnit: group.scopeUnit,
        pids: group.pids,
        ageSec: groupAgeSec(group.pids),
        sample: safeDiagnosticText(group.sampleCmdline, 160, diagnosticSecrets),
      });
      // EI-20974969153018746: a task selector answers a narrow ledger question.
      // Keep reconciliation health visible, but do not spend the result budget on
      // unrelated host-wide process samples. Call without a selector to request
      // the full live group inventory used by the kill/chaining workflow.
      live = hasTaskSelector
        ? args.scopeUnit !== undefined
          ? {
              ...liveSummary,
              // An exact systemd unit can be visible to the kernel without a ledger row
              // (for example a detached green-checkpoint service). Preserve the bounded
              // task-selector read, but return only groups carrying the requested unit so
              // the exact lookup still resolves under a crowded inventory.
              exactScopeUnitMatches: [
                ...tick.result.unaccounted.map((group) => ({ kind: 'unaccounted', ...mapLiveGroup(group) })),
                ...tick.result.abandonedWindow.map((group) => ({ kind: 'abandoned-window', ...mapLiveGroup(group) })),
                ...tick.result.consoleWindow.map((group) => ({ kind: 'console-window', ...mapLiveGroup(group) })),
                ...tick.result.verifierScope.map((group) => ({ kind: 'verifier', ...mapLiveGroup(group) })),
                ...tick.result.foreign.map((group) => ({ kind: 'foreign', ...mapLiveGroup(group) })),
              ].filter((group) => group.scopeUnit === args.scopeUnit),
            }
          : {
              ...liveSummary,
              diagnosticsOmitted: 'global process groups omitted because a task selector is active',
            }
        : {
            ...liveSummary,
            scannedProcesses: tick.scan.processes,
            foreignTruncated: tick.scan.foreignTruncated,
            unaccountedGroups: tick.result.unaccounted.map(mapLiveGroup),
            foreignGroups: tick.result.foreign.map(mapLiveGroup),
            verifierGroups: tick.result.verifierScope.map(mapLiveGroup),
          };
    }

    const page = await listTasksPage({
      states: args.states ?? (args.state == null ? undefined : [args.state]),
      classes: args.classes,
      launchedBy: args.launchedBy,
      coordOwnerId: args.coordOwnerId,
      taskId: args.taskId,
      dispatchCallId: args.dispatchCallId,
      scopeUnit: args.scopeUnit,
      invocationId: args.invocationId,
      workItemId: args.workItemId,
      rootTaskId: args.rootTaskId,
      includeEnded: args.includeEnded,
      limit: args.limit,
    });
    // EI-21386942224757425: a dry-run reconciliation can prove that a ledger
    // row disappeared from the kernel while the persistence tick has not yet
    // written its terminal state. Show that proof in this authoritative read.
    const displayRows = args.live && liveTick ? overlayReconcileTerminalVerdicts(page.rows, liveTick) : page.rows;
    // Unaccounted rows are not enrolled task processes: their stored
    // pids_current is normally null even while the cgroup is populated. Join
    // the SAME authoritative dry-run scan used above to each residue row.
    // A missing/degraded scan is unknown (null), never an empty PID set.
    const unaccountedPids = new Map(
      (args.live && liveTick && !liveTick.degraded ? liveTick.result.unaccounted : []).map((group) => [
        (group.scopeUnit && taskIdFromScopeUnit(group.scopeUnit)) || residueTaskId(group.cgroupPath),
        group.pids,
      ]),
    );

    const byState: Record<string, number> = {};
    const byClass: Record<string, number> = {};
    for (const r of displayRows) {
      byState[r.state] = (byState[r.state] ?? 0) + 1;
      byClass[r.class] = (byClass[r.class] ?? 0) + 1;
    }
    const sampledAtMs = Date.now();
    pruneCpuSamples(sampledAtMs);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              ok: true,
              counts: { total: displayRows.length, byState, byClass },
              taskPage: {
                limit: page.limit,
                returned: displayRows.length,
                total: page.totalCount,
                truncated: page.totalCount > displayRows.length,
              },
              ...(live ? { live } : {}),
              tasks: displayRows.map((r) => {
                const confinement = resolveTaskConfinement(r);
                const nowMs = Date.now();
                const cpuSampledAt = r.cpuSampledAt ?? null;
                const rssSampledAt = r.rssSampledAt ?? null;
                return {
                taskId: r.taskId,
                class: r.class,
                title: safeDiagnosticText(r.title, undefined, diagnosticSecrets),
                state: r.state,
                launchedBy: r.launchedBy,
                workItemId: r.workItemId,
                planSlug: r.planSlug,
                parentTaskId: r.parentTaskId,
                rootTaskId: r.rootTaskId,
                ageSec: ageSec(r.startedAt),
                rssMb: mb(r.lastMemoryBytes),
                rssSampledAt,
                rssSampleAgeSec: sampleAgeSec(rssSampledAt, nowMs),
                rssSampleFreshness: sampleFreshness(rssSampledAt, r.lastSeenAt),
                peakRssMb: mb(r.peakMemoryBytes),
                cpuSec: r.cpuUsec == null ? null : Math.round(r.cpuUsec / 1_000_000),
                cpuSampledAt,
                cpuSampleAgeSec: sampleAgeSec(cpuSampledAt, nowMs),
                cpuSampleFreshness: sampleFreshness(cpuSampledAt, r.lastSeenAt),
                // A partial scan can advance liveness without refreshing this counter.
                // Use its sample time so that scan is not mistaken for a quiet interval.
                cpuBusyPercent: currentCpuBusyPercent(r.taskId, r.cpuUsec, cpuSampledAt),
                pids: r.state === 'unaccounted' && args.live
                  ? unaccountedPids.get(r.taskId)?.length ?? null
                  : r.pidsCurrent,
                // A measured empty group is []/0; null says the live scan
                // could not establish this row's processes.
                livePids: r.state === 'unaccounted' && args.live
                  ? unaccountedPids.get(r.taskId) ?? null
                  : null,
                confined: confinement.confined,
                scopeUnit: r.scopeUnit,
                // P-023: "what confines this, and therefore what can kill it" — DERIVED
                // from scope_unit, never the stored cgroup_path, which holds the spawner's
                // cgroup on ~1300 historical rows (D-111).
                confinement,
                memoryMaxMb: mb(r.memoryMaxBytes),
                deadlineAt: r.deadlineAt,
                exitCode: r.exitCode,
                exitReason:
                  r.exitReason == null ? r.exitReason : safeDiagnosticText(r.exitReason, undefined, diagnosticSecrets),
                termination: r.terminalProvenance
                  ? {
                      capturedAt: r.terminalProvenance.capturedAt,
                      reason: r.exitReason ?? null,
                      serviceResult: r.terminalProvenance.serviceResult,
                      scopeUnit: r.terminalProvenance.scopeUnit,
                      cgroupPath: r.terminalProvenance.cgroupPath,
                      invocationId: r.terminalProvenance.invocationId,
                      memoryMaxMb: mb(r.terminalProvenance.memoryMaxBytes),
                      peakRssMb: mb(r.terminalProvenance.peakMemoryBytes),
                      peakMemorySource: r.terminalProvenance.peakMemorySource,
                    }
                  : null,
                logPath: r.logPath == null ? r.logPath : safeDiagnosticText(r.logPath, undefined, diagnosticSecrets),
                ...(args.includeAttemptEvidence
                  ? { verificationAttempt: projectVerificationAttempt(r.detail, diagnosticSecrets) }
                  : {}),
                };
              }),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
});
