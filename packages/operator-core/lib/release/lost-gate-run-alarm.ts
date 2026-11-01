/**
 * Lost gate-run alarm (gate-throughput-shift-left-2026-10-06 P-005 / R-5).
 *
 * A green-checkpoint run publishes a durable `gate_health.inFlightCandidate` marker naming its
 * pid. A hard loss (SIGKILL, OOM, host-generation replacement) cannot run the run's own
 * finalizer, so the marker stays set while nobody is judging anything. The existing handling of
 * that marker (`wakeAbandonedCheckpointAwaits` inside `checkGreenStall`) only resolves
 * `checkpoint:await` waiters, discards its own result, and runs on the 15-minute green-stall
 * pass. Nobody was PAGED: WI-10004928 measured a load-time death of the gate's tooling that sat
 * silent for 70+ minutes.
 *
 * This sweep closes that gap and nothing else:
 *  - it runs on its own short timer (LOST_RUN_SWEEP_INTERVAL_MS), so a death is alarmed within
 *    minutes rather than at the next 15-minute pass;
 *  - it alarms ONCE per dead run, deduped by a compare-and-set stamp
 *    (`gate_health.lostRunAlarm.key = candidate:pid:observedAtMs`), so a restart, an overlapping
 *    pass, or a marker that lingers because the wake failed never re-pages;
 *  - it pages the gate holder (the live claim on the gate's condition item) and a fleet leader
 *    (the holder's own fleet, else this host's PAPERCUSP_FLEET_SLUG), on top of the hive-wide
 *    severe-event broadcast;
 *  - it is silent while the pid is alive, when liveness cannot be determined, and once the marker
 *    is cleared.
 *
 * It deliberately does NOT clear the marker or wake waiters: that stays with the 15-minute pass,
 * so the two paths never run the record/emit/clear transaction on the same marker concurrently.
 */
import type { Sql } from 'postgres';
import type { SevereEventRoute } from '../severe-event-broadcast';
import { resolveAlarm, type AlarmAttentionDeps } from '../alarm-attention';
import type { AttentionNotifyInput } from '../attention-notify';
import { currentRepairLimbExecutor, type RepairLimbExecutor } from './repair-limb-executor';
import {
  CHECKPOINT_QUALIFICATION_METADATA_KEY,
  classifyQualificationVerdict,
  isPostVerdictHang,
  parseCheckpointQualificationTransaction,
  probeRunnerLiveness,
  projectCheckpointQualificationState,
  recordStoredQualificationVerdict,
  reconcileStoredSupersededRepairVerdict,
  type CheckpointQualificationTransaction,
  type RunnerLivenessProber,
} from './checkpoint-qualification-transaction';
import { GREEN_CHECKPOINT_RESULT_MARKER, isFixtureLogLine } from './checkpoint-log-tags';
import type { CheckpointSystemdTerminalEvidence } from '../release-checkpoint-launch';
import {
  describeAbandonedInFlightCandidate,
  isPidAlive,
  judgeAbandonedInFlightCandidate,
  parseInFlightCandidate,
  type StoredInFlightCandidate,
} from './in-flight-candidate';

/** R-5 requires the alarm within 10 minutes of the death; a 2-minute sweep leaves wide margin. */
export const LOST_RUN_SWEEP_INTERVAL_MS = 2 * 60 * 1000;

export function lostRunAlarmKey(marker: Pick<StoredInFlightCandidate, 'candidate' | 'pid' | 'observedAtMs'>): string {
  return `${marker.candidate}:${marker.pid}:${marker.observedAtMs}`;
}

export type LostRunAlarmDecision =
  | { action: 'silent'; reason: string }
  | {
      action: 'alarm';
      key: string;
      candidate: string;
      pid: number;
      /** How long ago the dead run published its marker (an upper bound on how long it ran). */
      markerAgeMs: number;
      summary: string;
    };

/**
 * Pure: should this marker raise a lost-run alarm right now?
 *
 * `alreadyAlarmedKey` is the stamp currently stored beside the marker. It is a cheap pre-filter
 * only; the authoritative dedup is the compare-and-set in {@link claimLostRunAlarm}.
 */
export function decideLostRunAlarm(input: {
  rawMarker: unknown;
  alreadyAlarmedKey: string | null;
  selfPid: number;
  pidAlive: (pid: number) => boolean | null;
  nowMs: number;
}): LostRunAlarmDecision {
  const marker = parseInFlightCandidate(input.rawMarker, input.nowMs);
  if (!marker) return { action: 'silent', reason: 'no-marker' };
  const verdict = judgeAbandonedInFlightCandidate(marker, {
    selfPid: input.selfPid,
    pidAlive: input.pidAlive(marker.pid),
    nowMs: input.nowMs,
  });
  if (!verdict.abandoned) return { action: 'silent', reason: verdict.reason };
  const key = lostRunAlarmKey(marker);
  if (input.alreadyAlarmedKey === key) return { action: 'silent', reason: 'already-alarmed' };
  return {
    action: 'alarm',
    key,
    candidate: marker.candidate,
    pid: marker.pid,
    markerAgeMs: Math.max(0, input.nowMs - marker.observedAtMs),
    summary:
      describeAbandonedInFlightCandidate(verdict) ??
      `Checkpoint run for ${marker.candidate.slice(0, 12)} disappeared without a verdict.`,
  };
}

/**
 * Pure: who gets paged directly. The holder is the agent holding a live claim on the gate's
 * condition item; the fleet leader is the leader of the holder's fleet, else of this host's
 * fleet. An empty list means nobody is directly reachable and the caller must fall back to the
 * owner-facing attention surface.
 */
export function resolveLostRunRoutes(input: {
  installSlug: string;
  holderOwnerId: string | null;
  holderFleetSlug: string | null;
  hostFleetSlug: string | null;
  condition?: 'lost-run' | 'stale-progress' | 'terminal-no-verdict';
}): SevereEventRoute[] {
  const routes: SevereEventRoute[] = [];
  const condition = input.condition === 'terminal-no-verdict'
    ? 'qualification ended with a terminal no-verdict result'
    : input.condition === 'stale-progress'
      ? 'qualification progress is stale'
      : 'in-flight run died';
  if (input.holderOwnerId) {
    routes.push({
      ownerSelector: input.holderOwnerId,
      reason: `you hold the ${input.installSlug} gate and its ${condition}`,
    });
  }
  const fleetSlug = (input.holderFleetSlug ?? input.hostFleetSlug ?? '').trim();
  if (fleetSlug) {
    routes.push({
      ownerSelector: `@fleet-leader:${fleetSlug}`,
      reason: `the ${input.installSlug} gate's ${condition}; fleet ${fleetSlug} leads it`,
    });
  }
  return routes;
}

/** Pure: the alarm text. Names the dead pid and the one thing to do next. */
export function lostRunAlarmBody(opts: {
  installSlug: string;
  decision: Extract<LostRunAlarmDecision, { action: 'alarm' }>;
  paged: readonly string[];
}): { summary: string; body: string } {
  const { decision } = opts;
  const minutes = Math.round(decision.markerAgeMs / 60_000);
  return {
    summary: `green-checkpoint run LOST on ${opts.installSlug}: pid ${decision.pid} is gone, no verdict for ${decision.candidate.slice(0, 12)}`,
    body:
      `${decision.summary} The run's in-flight marker was published ${minutes} min ago and its pid ` +
      `${decision.pid} no longer exists, so no verdict will arrive for this candidate. ` +
      `Next step: read gate.greenCheckpoint.ownership and the checkpoint unit log for the death window, ` +
      `then re-run the verdict (release:checkpoint-run) once the cause is understood. ` +
      (opts.paged.length > 0
        ? `Paged directly: ${opts.paged.join(', ')}.`
        : `No gate holder or fleet leader was resolvable, so this was raised to the owner.`),
  };
}

/**
 * Compare-and-set the dedup stamp. Returns true only for the caller that moved the stored key to
 * `key`; every later caller (another pass, a restarted process) gets false and stays silent.
 */
export async function claimLostRunAlarm(
  sql: Sql,
  target: { installSlug: string; workspaceId: string; alarmField?: 'lostRunAlarm' | 'qualificationProgressAlarm' },
  key: string,
  nowMs: number,
  // gate-repair-plane-on-current-build-2026-10-15 R-1: the alarm record names the host and the
  // build of the process that raised it, from that process's getBuildInfo().
  executor: RepairLimbExecutor = currentRepairLimbExecutor(),
): Promise<boolean> {
  const alarmField = target.alarmField ?? 'lostRunAlarm';
  const result = await sql`
    UPDATE harness_shared.routines
       SET metadata = jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             '{gate_health}',
             COALESCE(metadata->'gate_health', '{}'::jsonb)
               || jsonb_build_object(${alarmField}::text,
                    jsonb_build_object('key', ${key}::text, 'alarmedAtMs', ${nowMs}::bigint)
                      || ${JSON.stringify(executor)}::text::jsonb),
             true
           )
     WHERE install_slug = ${target.installSlug}
       AND workspace_id = ${target.workspaceId}
       AND target_role = 'system:green-checkpoint'
       AND (metadata->'gate_health'->${alarmField}->>'key') IS DISTINCT FROM ${key}::text`;
  return result.count === 1;
}

async function readHolder(installSlug: string): Promise<string | null> {
  const { readGateOwnership } = await import('../coord/gate-ownership');
  const own = await readGateOwnership({ harness: installSlug });
  return own.claimState === 'held' && own.takenBy ? own.takenBy : null;
}

async function readOwnerFleetSlug(sql: Sql, workspaceId: string, ownerId: string): Promise<string | null> {
  const rows = await sql<{ fleet_slug: string | null }[]>`
    SELECT fleet_slug FROM harness_shared.coord_presence
     WHERE workspace_id = ${workspaceId} AND owner_id = ${ownerId}
     LIMIT 1`;
  const slug = rows[0]?.fleet_slug?.trim();
  return slug ? slug : null;
}

export interface LostRunSweepDeps {
  nowMs?: number;
  selfPid?: number;
  pidAlive?: (pid: number) => boolean | null;
  /** Substitutes the whole probeRunnerLiveness verdict, whose reservation-ceiling and
   *  launch-grace checks are judged against the sweep clock, so it receives `nowMs` too. */
  probeQualificationRunner?: (
    runner: Parameters<RunnerLivenessProber>[0],
    nowMs: number,
  ) => ReturnType<RunnerLivenessProber>;
  /** Focused seam for the exact runner log used to distinguish a clean superseded round from a crash. */
  readQualificationRunLog?: (runner: NonNullable<CheckpointQualificationTransaction['currentPhysicalRunner']>) => Promise<string | null>;
  /** Row-locked reconciliation of a successful superseded red round; production uses the stored transaction writer. */
  reconcileSupersededRun?: typeof reconcileStoredSupersededRepairVerdict;
  /** Reconcile an exact terminal non-verdict result before the dead-run retry path. */
  reconcileTerminalNoVerdict?: typeof recordStoredQualificationVerdict;
  hostFleetSlug?: string | null;
  claim?: typeof claimLostRunAlarm;
  readHolder?: (installSlug: string) => Promise<string | null>;
  readOwnerFleetSlug?: (sql: Sql, workspaceId: string, ownerId: string) => Promise<string | null>;
  broadcast?: (ev: import('../severe-event-broadcast').SevereEventBroadcast) => Promise<boolean>;
  /** Existing condition/owner delivery seams, including measured recovery. */
  attention?: AlarmAttentionDeps;
  notifyOwner?: (opts: { workspaceId: string; title: string; body: string; data: Record<string, unknown> }) => Promise<void>;
}

export interface LostRunSweepResult {
  /** install slugs paged this pass (exactly once per dead run). */
  alarmed: string[];
  /** install slugs with a dead run whose alarm another pass already claimed. */
  deduped: string[];
  /** install slugs whose alarm could not be delivered this pass (retried next pass). */
  failed: string[];
}

/** Reuse the routine's forward-only retry; exact runner identity prevents a stale scan moving a successor. */
async function requeueDeadQualification(
  sql: Sql,
  target: { installSlug: string; workspaceId: string },
  transaction: CheckpointQualificationTransaction,
): Promise<void> {
  await sql`
    UPDATE harness_shared.routines
       SET next_fire_at = now() + interval '1 minute', updated_at = now()
     WHERE install_slug = ${target.installSlug} AND workspace_id = ${target.workspaceId}
       AND target_role = 'system:green-checkpoint' AND active = true
       AND metadata->'pause' IS NULL
       AND metadata->${CHECKPOINT_QUALIFICATION_METADATA_KEY}->>'attemptId' = ${transaction.attemptId}
       AND metadata->${CHECKPOINT_QUALIFICATION_METADATA_KEY}->'currentPhysicalRunner'->>'id' = ${transaction.currentPhysicalRunner!.id}
       AND (next_fire_at IS NULL OR next_fire_at > now() + interval '1 minute')`;
}

interface BoundQualificationRunLog {
  runId: string;
  logPath: string;
  log: string;
  terminal: CheckpointSystemdTerminalEvidence | undefined;
}

interface TerminalQualificationNoVerdict {
  runId: string;
  candidate: string;
  repairHead: string | null;
  reason: string;
  green: boolean | null;
  evidenceRefs: string[];
}

async function readBoundQualificationRunLog(
  runner: NonNullable<CheckpointQualificationTransaction['currentPhysicalRunner']>,
  deps: LostRunSweepDeps,
): Promise<BoundQualificationRunLog | null> {
  const boundRuns = runner.evidenceRefs.filter(ref => ref.startsWith('checkpoint-run:'));
  if (boundRuns.length !== 1 || !boundRuns[0]!.slice('checkpoint-run:'.length) || !runner.unit?.trim()) return null;
  try {
    const launch = await import('../release-checkpoint-launch');
    const unit = runner.unit.trim().replace(/\.service$/, '');
    const logPath = launch.checkpointLatestLogPath(unit);
    const log = await (deps.readQualificationRunLog
      ? deps.readQualificationRunLog(runner)
      : Promise.resolve(launch.defaultReadLogTail(logPath)));
    if (!log) return null;
    return {
      runId: boundRuns[0]!.slice('checkpoint-run:'.length),
      logPath,
      log,
      terminal: launch.parseCheckpointSystemdTerminalEvidence(log),
    };
  } catch {
    return null;
  }
}

function terminalQualificationNoVerdict(
  runner: NonNullable<CheckpointQualificationTransaction['currentPhysicalRunner']>,
  source: BoundQualificationRunLog,
): TerminalQualificationNoVerdict | null {
  if (!source.terminal || typeof runner.candidate !== 'string') return null;
  const result = source.log.split(/\r?\n/).filter(line => !isFixtureLogLine(line)).flatMap(line => {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith(GREEN_CHECKPOINT_RESULT_MARKER)) return [];
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(GREEN_CHECKPOINT_RESULT_MARKER.length).trim());
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
      const value = parsed as Record<string, unknown>;
      return value.runId === source.runId && typeof value.candidate === 'string' &&
        typeof value.reason === 'string' ? [value] : [];
    } catch { return []; }
  }).at(-1);
  if (!result) return null;
  const repairQueue = result.repairQueue && typeof result.repairQueue === 'object' && !Array.isArray(result.repairQueue)
    ? result.repairQueue as Record<string, unknown>
    : null;
  const repairHead = typeof repairQueue?.repairHead === 'string' ? repairQueue.repairHead.trim() : null;
  if (typeof result.candidate !== 'string' ||
      (result.candidate !== runner.candidate && repairHead !== runner.candidate)) return null;
  const green = typeof result.green === 'boolean' ? result.green : null;
  const outcome = classifyQualificationVerdict({ reason: result.reason as string, green });
  if (outcome.kind !== 'pre-suite-no-verdict') return null;
  return {
    runId: source.runId,
    candidate: result.candidate,
    repairHead,
    reason: outcome.reason,
    green,
    evidenceRefs: [`checkpoint-terminal:${source.runId}`, `checkpoint-log:${source.logPath}`],
  };
}

async function successfulSupersededRepairRound(
  runner: NonNullable<CheckpointQualificationTransaction['currentPhysicalRunner']>,
  source: BoundQualificationRunLog | null,
): Promise<{ runId: string; candidate: string; round: number } | null> {
  if (!source?.terminal || source.terminal.abnormal || source.terminal.service_result !== 'success' ||
      source.terminal.exit_code !== 'exited' || source.terminal.exit_status !== '0' ||
      typeof runner.candidate !== 'string') return null;
  const { runId, log } = source;
  const result = log.split(/\r?\n/).filter(line => !isFixtureLogLine(line)).flatMap(line => {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith(GREEN_CHECKPOINT_RESULT_MARKER)) return [];
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(GREEN_CHECKPOINT_RESULT_MARKER.length).trim());
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
      const value = parsed as Record<string, unknown>;
      return value.runId === runId && value.green === false && typeof value.candidate === 'string' &&
        typeof value.reason === 'string' ? [value] : [];
    } catch { return []; }
  }).at(-1);
  if (!result || result.candidate !== runner.candidate) return null;
  const candidatePrefix = result.candidate.slice(0, 8);
  const round = log.split(/\r?\n/).map(line => line.trim()).flatMap(line => {
    const match = line.match(/^FROZEN_REPAIR_VERDICT_SUPERSEDED: (?:full-gate )?red at ([a-f0-9]{8}) recorded as round (\d+)\b/);
    return match && match[1] === candidatePrefix ? [Number(match[2])] : [];
  }).at(-1);
  return Number.isSafeInteger(round) && round! > 0 ? { runId, candidate: result.candidate, round: round! } : null;
}

/** The existing two-minute sweep also investigates missing qualification heartbeats. */
export async function sweepLostGateRuns(sql: Sql, deps: LostRunSweepDeps = {}): Promise<LostRunSweepResult> {
  const out: LostRunSweepResult = { alarmed: [], deduped: [], failed: [] };
  const nowMs = deps.nowMs ?? Date.now();
  let rows: { install_slug: string; workspace_id: string; marker: unknown; alarmed_key: string | null; progress_alarmed_key?: string | null; qualification?: unknown }[];
  try {
    rows = await sql<typeof rows>`
      SELECT install_slug, workspace_id,
             metadata->'gate_health'->'inFlightCandidate' AS marker,
             metadata->'gate_health'->'lostRunAlarm'->>'key' AS alarmed_key,
             metadata->'gate_health'->'qualificationProgressAlarm'->>'key' AS progress_alarmed_key,
             metadata->${CHECKPOINT_QUALIFICATION_METADATA_KEY} AS qualification
        FROM harness_shared.routines
       WHERE target_role = 'system:green-checkpoint'`;
  } catch (e) {
    console.warn(`[lost-gate-run-alarm] row scan failed (will retry): ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }

  for (const row of rows) {
    const markerDecision = decideLostRunAlarm({
      rawMarker: row.marker,
      alreadyAlarmedKey: row.alarmed_key,
      selfPid: deps.selfPid ?? process.pid,
      pidAlive: deps.pidAlive ?? isPidAlive,
      nowMs,
    });
    // An old in-flight marker can outlive its run. Inspect the current qualification independently
    // so the old marker's dedup stamp cannot hide a successor's missing heartbeat.
    const transaction = parseCheckpointQualificationTransaction(row.qualification);
    const runner = transaction?.currentPhysicalRunner;
    const liveness = runner ? await (deps.probeQualificationRunner
      ? deps.probeQualificationRunner(runner, nowMs) : probeRunnerLiveness(runner, nowMs)) : 'unknown';
    const qualification = transaction && transaction.phase !== 'terminal' && runner
      ? projectCheckpointQualificationState(transaction, nowMs, liveness)
      : null;
    let terminalNoVerdict: (TerminalQualificationNoVerdict & { reconciliationStatus: string }) | null = null;
    if (transaction && runner && liveness === 'dead') {
      const boundRunLog = await readBoundQualificationRunLog(runner, deps);
      const terminalOutcome = boundRunLog ? terminalQualificationNoVerdict(runner, boundRunLog) : null;
      if (terminalOutcome) {
        const target = { installSlug: row.install_slug, workspaceId: row.workspace_id };
        let reconciliation: Awaited<ReturnType<typeof recordStoredQualificationVerdict>> | null = null;
        try {
          reconciliation = await (deps.reconcileTerminalNoVerdict ?? recordStoredQualificationVerdict)(target, {
            attemptId: transaction.attemptId,
            reason: terminalOutcome.reason,
            green: terminalOutcome.green,
            candidate: terminalOutcome.candidate,
            repairHead: terminalOutcome.repairHead,
            runId: terminalOutcome.runId,
            evidenceRefs: terminalOutcome.evidenceRefs,
            nowMs,
          });
        } catch {
          console.warn(`[lost-gate-run-alarm] terminal no-verdict reconciliation failed for ${row.install_slug}`);
        }
        const noLongerCurrent = reconciliation && 'transaction' in reconciliation &&
          (reconciliation.transaction.attemptId !== transaction.attemptId ||
            reconciliation.transaction.phase !== 'running' ||
            reconciliation.transaction.currentPhysicalRunner?.id !== runner.id);
        if (reconciliation && (['updated', 'idempotent', 'terminal'].includes(reconciliation.status) || noLongerCurrent)) {
          await resolveAlarm(`green-checkpoint-lost-run:${row.install_slug}`, 'lost-gate-run-alarm', deps.attention);
          await resolveAlarm(`green-checkpoint-run-progress:${row.install_slug}`, 'lost-gate-run-alarm', deps.attention);
          continue;
        }
        terminalNoVerdict = {
          ...terminalOutcome,
          reconciliationStatus: reconciliation?.status ?? 'failed',
        };
      } else {
        const superseded = await successfulSupersededRepairRound(runner, boundRunLog);
        if (superseded) {
          try {
            const target = { installSlug: row.install_slug, workspaceId: row.workspace_id };
            await requeueDeadQualification(sql, target, transaction);
            const reconciled = await (deps.reconcileSupersededRun ?? reconcileStoredSupersededRepairVerdict)(target, {
              attemptId: transaction.attemptId,
              runnerId: runner.id,
              runId: superseded.runId,
              candidate: superseded.candidate,
              round: superseded.round,
              nowMs,
            });
            if (reconciled.status === 'updated' || reconciled.status === 'idempotent') {
              await resolveAlarm(`green-checkpoint-lost-run:${row.install_slug}`, 'lost-gate-run-alarm', deps.attention);
              await resolveAlarm(`green-checkpoint-run-progress:${row.install_slug}`, 'lost-gate-run-alarm', deps.attention);
              continue;
            }
            out.failed.push(row.install_slug);
            continue;
          } catch (e) {
            console.warn(`[lost-gate-run-alarm] superseded qualification recovery failed for ${row.install_slug}: ${e instanceof Error ? e.message : String(e)}`);
            out.failed.push(row.install_slug);
            continue;
          }
        }
      }
    }
    // WI-6554700010009616: a live runner parked in `finalizing` keeps a fresh heartbeat (its interval
    // fires through an awaited hang), so runnerHealth reads `progressing`. Only the phase clock sees it.
    const postVerdictHang = !!transaction && transaction.phase !== 'terminal' && isPostVerdictHang(runner, liveness, nowMs);
    const currentRunnerProgressing = qualification?.runnerHealth.state === 'progressing' && !postVerdictHang;
    // Read routines even after their marker disappears: otherwise recovery is invisible.
    // A malformed marker or unknown marker PID alone is not evidence of recovery; a healthy
    // current qualification runner is independent evidence that the old marker is stale.
    if (row.alarmed_key && (row.marker == null || currentRunnerProgressing ||
        (markerDecision.action === 'silent' && ['pid-alive', 'own-run'].includes(markerDecision.reason)))) {
      await resolveAlarm(`green-checkpoint-lost-run:${row.install_slug}`, 'lost-gate-run-alarm', deps.attention);
    }
    if (row.progress_alarmed_key && (row.qualification == null || transaction?.phase === 'terminal' ||
        (liveness === 'live' && qualification?.runnerHealth.state === 'progressing' && !postVerdictHang))) {
      await resolveAlarm(`green-checkpoint-run-progress:${row.install_slug}`, 'lost-gate-run-alarm', deps.attention);
    }
    const inspect = qualification?.runnerHealth.state === 'stalled' || qualification?.runnerHealth.state === 'dead' ||
      postVerdictHang;
    const progressKey = inspect && transaction && runner
      ? postVerdictHang && liveness !== 'dead'
        ? `qualification:${transaction.attemptId}:${runner.id}:post-verdict-hang:${runner.phaseEnteredAtMs}`
        : `qualification:${transaction.attemptId}:${runner.id}:${liveness === 'dead' ? 'dead' : runner.heartbeatAtMs ?? transaction.lastProgressAtMs ?? runner.reservedAtMs}`
      : null;
    // Prefer the current runner, retaining separate stamps on the same routine metadata so
    // recovery of its heartbeat cannot make an old death alarm look new again.
    const decision = progressKey || currentRunnerProgressing
      ? { action: 'silent', reason: 'qualification-progress' } as const
      : markerDecision;
    if (decision.action === 'silent') {
      if (decision.reason === 'already-alarmed') out.deduped.push(row.install_slug);
      if (!progressKey) continue;
    }
    const target = {
      installSlug: row.install_slug, workspaceId: row.workspace_id,
      alarmField: progressKey ? 'qualificationProgressAlarm' as const : 'lostRunAlarm' as const,
    };
    const key = decision.action === 'alarm' ? decision.key : progressKey!;
    if ((progressKey ? row.progress_alarmed_key : row.alarmed_key) === key) {
      out.deduped.push(row.install_slug);
      continue;
    }
    try {
      const won = await (deps.claim ?? claimLostRunAlarm)(sql, target, key, nowMs);
      if (!won) {
        out.deduped.push(row.install_slug);
        continue;
      }
    } catch (e) {
      console.warn(`[lost-gate-run-alarm] dedup claim failed for ${row.install_slug} (will retry): ${e instanceof Error ? e.message : String(e)}`);
      out.failed.push(row.install_slug);
      continue;
    }

    if (progressKey && liveness === 'dead' && transaction && !terminalNoVerdict) {
      // This requests an ordinary scheduled attempt, which still passes all existing admission
      // and single-flight guards. It never stops a process or creates a code verdict.
      try {
        await requeueDeadQualification(sql, target, transaction);
      } catch (e) {
        await releaseLostRunAlarmClaim(sql, target, key);
        console.warn(`[lost-gate-run-alarm] dead qualification retry failed: ${e instanceof Error ? e.message : String(e)}`);
        out.failed.push(row.install_slug);
        continue;
      }
    }

    // Routing is best-effort: an unreadable holder or fleet must never suppress the alarm itself.
    const holder = await (deps.readHolder ?? readHolder)(row.install_slug).catch(() => null);
    const holderFleetSlug = holder
      ? await (deps.readOwnerFleetSlug ?? readOwnerFleetSlug)(sql, row.workspace_id, holder).catch(() => null)
      : null;
    const routes = resolveLostRunRoutes({
      installSlug: row.install_slug,
      condition: terminalNoVerdict
        ? 'terminal-no-verdict'
        : progressKey && liveness !== 'dead' ? 'stale-progress' : 'lost-run',
      holderOwnerId: holder,
      holderFleetSlug,
      hostFleetSlug: deps.hostFleetSlug !== undefined ? deps.hostFleetSlug : (process.env.PAPERCUSP_FLEET_SLUG ?? null),
    });
    const { summary, body } = decision.action === 'alarm'
      ? lostRunAlarmBody({ installSlug: row.install_slug, decision, paged: routes.map((r) => r.ownerSelector) })
      : {
          summary: terminalNoVerdict
            ? `green-checkpoint qualification ended without a verdict on ${row.install_slug}`
            : `green-checkpoint qualification ${liveness === 'dead' ? 'LOST' : 'progress STALE'} on ${row.install_slug}`,
          body: `Qualification ${transaction!.attemptId}, runner ${runner!.id}, candidate ${transaction!.candidate ?? 'unknown'}: ` +
            (terminalNoVerdict
              ? `the exact run exited with terminal no-verdict reason '${terminalNoVerdict.reason}'. Stored-attempt reconciliation returned '${terminalNoVerdict.reconciliationStatus}'; no automatic retry was requested. Inspect this exact run and the qualification row before selecting the next action.`
              : liveness === 'dead'
              ? 'the exact runner was proved dead without a terminal verdict; an ordinary guarded retry was requested.'
              : postVerdictHang
              ? `POST-VERDICT HANG: the live runner entered its final post-verdict steps ${Math.round((nowMs - (runner!.phaseEnteredAtMs ?? nowMs)) / 60_000)}m ago and never exited, although every post-verdict step is bounded to seconds. Its run-lock and checkpoint tree stay held, so no later tick can run. Read the run log's last "<step> started" line to name the stalled step. Preserve single flight: do not start a parallel run.`
              : `progress heartbeat is ${Math.round((qualification!.runnerHealth.progressAgeMs ?? 0) / 1_000)}s old, process liveness is ${liveness}. Inspect the exact runner and preserve single flight; heartbeat silence alone never authorizes stopping or replacing a live or unknown runner.`),
        };
    const broadcast = deps.broadcast ?? (await import('../severe-event-broadcast')).broadcastSevereEvent;
    const delivered = await broadcast({
      summary,
      body,
      category: 'severe-event',
      conditionKey: `${decision.action === 'alarm' ? 'green-checkpoint-lost-run' : 'green-checkpoint-run-progress'}:${row.install_slug}`,
      oneShot: true,
      ...(routes[0] ? { route: routes[0] } : {}),
      ...(routes.length > 1 ? { extraRoutes: routes.slice(1) } : {}),
    });
    if (routes.length === 0) {
      const notifyOwner = deps.notifyOwner ?? ((input) => defaultNotifyOwner(input, {
        ...deps.attention, broadcast: deps.attention?.broadcast ?? deps.broadcast,
      }));
      await notifyOwner({
        workspaceId: row.workspace_id,
        title: summary,
        body,
        data: decision.action === 'alarm'
          ? { installSlug: row.install_slug, candidate: decision.candidate.slice(0, 12), pid: decision.pid }
          : { installSlug: row.install_slug, attemptId: transaction!.attemptId, runnerId: runner!.id, liveness },
      }).catch((e) => {
        console.warn(`[lost-gate-run-alarm] owner notify failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    if (delivered) {
      out.alarmed.push(row.install_slug);
    } else {
      // The stamp is already claimed, so release it: the next pass must retry an undelivered page.
      await releaseLostRunAlarmClaim(sql, target, key).catch(() => {});
      out.failed.push(row.install_slug);
    }
  }
  return out;
}

async function releaseLostRunAlarmClaim(
  sql: Sql,
  target: { installSlug: string; workspaceId: string; alarmField?: 'lostRunAlarm' | 'qualificationProgressAlarm' },
  key: string,
): Promise<void> {
  const alarmField = target.alarmField ?? 'lostRunAlarm';
  await sql`
    UPDATE harness_shared.routines
       SET metadata = jsonb_set(metadata, '{gate_health}', (metadata->'gate_health') - ${alarmField}::text, true)
     WHERE install_slug = ${target.installSlug}
       AND workspace_id = ${target.workspaceId}
       AND target_role = 'system:green-checkpoint'
       AND metadata->'gate_health'->${alarmField}->>'key' = ${key}::text`;
}

async function defaultNotifyOwner(opts: {
  workspaceId: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
}, deps: AlarmAttentionDeps = {}): Promise<void> {
  const conditionKey = `${'attemptId' in opts.data ? 'green-checkpoint-run-progress' : 'green-checkpoint-lost-run'}:${opts.data.installSlug}`;
  // The owner fallback is itself on the rail; owner-notification failures cannot suppress it.
  const event = { conditionKey, summary: opts.title, body: opts.body, oneShot: true };
  if (deps.broadcast) await deps.broadcast(event);
  else {
    const { broadcastSevereEvent } = await import('../severe-event-broadcast');
    await broadcastSevereEvent(event);
  }
  // ONE input for both legs, so an injected seam observes exactly what production delivers.
  const input: AttentionNotifyInput = {
    kind: 'intervention',
    title: opts.title,
    body: opts.body,
    importance: 'urgent',
    workspaceId: opts.workspaceId,
    data: opts.data,
  };
  if (deps.notify) { await deps.notify(input); return; }
  const { notifyAttention } = await import('../attention-notify');
  await notifyAttention(input);
}
