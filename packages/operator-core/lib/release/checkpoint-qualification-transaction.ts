/**
 * Durable logical qualification transaction.
 *
 * One record lives beside the green-checkpoint routine's existing gate_health /
 * repair_queue metadata. It is a coordination root, not a second scheduler or
 * lock: the existing routine claimant and physical run lock remain the safety
 * authorities. This record makes the logical attempt, retry policy, current
 * physical runner, blockers, and evidence machine-readable across processes.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import { isDeepStrictEqual, promisify } from 'node:util';
import { getOrgPg } from '@papercusp/db-org';
import type { GateVerdictTarget } from './gate-verdict-target';
import { isCheckpointCandidateSource, type CheckpointCandidateSource } from './checkpoint-candidate-source';
import type { FreezeCutRecord } from './known-good-freeze';
import { FROZEN_REPAIR_CARRY_METADATA_KEY, FROZEN_REPAIR_CARRY_LAST_METADATA_KEY,
  parseFrozenRepairPendingCarry, parseFrozenRepairCarryRecord,
  type FrozenRepairPendingCarry, type FrozenRepairCarryRecord } from './frozen-repair-carry';
import { boundedOrgTxn } from '../pg-bounded-txn';
import { appendPipelineEvent } from '../harness/git-sync/pipeline-events';
import { evaluatePartialTaskContinuation, readPartialCurrentCommandCompletion, readPartialTaskCommandCompletion, readPartialNativeCompletion, readPartialNativeProducer } from '../../../../scripts/lib/partial-task-resume.mjs';
import {
  dependencyGenerationInfraCode,
  GREEN_CHECKPOINT_RESULT_MARKER,
  isFixtureLogLine,
  ORCHESTRATOR_STDOUT_TAG,
} from './checkpoint-log-tags';
import {
  createFrozenCandidateQueue,
  frozenRepairHeadAwaitsVerification,
  frozenRepairHeadOwesVerification,
  parseFrozenCandidateRepairQueue,
  type FrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';
import {
  parseCheckpointEligibilitySnapshot,
  type CheckpointEligibilitySnapshot,
} from './checkpoint-eligibility-snapshot';

export const CHECKPOINT_QUALIFICATION_METADATA_KEY = 'qualificationTransaction';
export const CHECKPOINT_QUALIFICATION_SCHEMA_VERSION = 1 as const;
/** Transported into a detached checkpoint so its verdict settles the exact logical attempt. */
export const CHECKPOINT_QUALIFICATION_ATTEMPT_ENV = 'PAPERCUSP_CHECKPOINT_QUALIFICATION_ATTEMPT_ID';
/** The scheduled wrapper reserves this attempt before spawn; the CLI activates that same runner. */
export const CHECKPOINT_SCHEDULED_RUN_ENV = 'PAPERCUSP_CHECKPOINT_SCHEDULED_RUN';
// Only the row-locked composer below can authorize a continuation's green terminal.
const COMPOSED_QUALIFICATION_GREEN = Symbol('composed-qualification-green');

export function checkpointPidIdentity(pid: number): string | null {
  try {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    if (!bootId || commandEnd < 0) return null;
    const startTicks = stat.slice(commandEnd + 2).trim().split(/\s+/)[19];
    return startTicks && /^\d+$/.test(startTicks) ? `${bootId}:${startTicks}` : null;
  } catch {
    return null;
  }
}

/**
 * What a caller has PROVED about a runner's process. 'unknown' is not a soft 'dead': every
 * reclaim path below treats it exactly as the pre-liveness code did, so a probe that breaks
 * degrades to the old lease-only behaviour instead of handing one candidate to two runners.
 */
export type RunnerLiveness = 'live' | 'dead' | 'unknown';
export type RunnerLivenessProber = (runner: QualificationPhysicalRunner) => RunnerLiveness | Promise<RunnerLiveness>;

/**
 * How long an attempt with NO physical runner may sit untouched before it is treated as abandoned.
 *
 * Deliberately derived, not tuned: a runner cannot outlive the detached suite's own systemd
 * ceiling (`CHECKPOINT_MAX_RUNTIME_SEC`, 3h — duplicated here rather than imported to keep this
 * coordination record free of a dependency on the launcher). So a record untouched for longer than
 * that ceiling cannot still have a living owner, whatever it claims.
 */
export const QUALIFICATION_OWNER_ABANDONED_MS = 3 * 60 * 60 * 1_000;
/** Three missed one-minute runner heartbeats warrant investigation, never a second runner. */
export const QUALIFICATION_PROGRESS_STALE_MS = 3 * 60_000;
/** An admitted scheduler fire may be probed before systemd has created its named scope. */
export const QUALIFICATION_LAUNCH_GRACE_MS = 60_000;

/**
 * WI-6554700010009616: how long a LIVE runner may sit in `finalizing` before the lost-run sweep
 * calls it a post-verdict hang. Every post-verdict step is bounded (30-60s each, WI-6554700010009547),
 * so 20m is far past any legitimate tail. The heartbeat cannot catch this case: its interval keeps
 * firing through an awaited hang (run b874ad21 sat ~2h with a fresh heartbeat).
 */
export const QUALIFICATION_POST_VERDICT_HANG_MS = 20 * 60_000;

/** True when a live runner has been parked past its final verdict longer than the bound above. */
export function isPostVerdictHang(
  runner: Pick<QualificationPhysicalRunner, 'phase' | 'phaseEnteredAtMs'> | null | undefined,
  liveness: RunnerLiveness,
  nowMs: number,
  boundMs = QUALIFICATION_POST_VERDICT_HANG_MS,
): boolean {
  return !!runner && runner.phase === 'finalizing' && liveness === 'live' &&
    typeof runner.phaseEnteredAtMs === 'number' && nowMs - runner.phaseEnteredAtMs > boundMs;
}

function launchReservationInGrace(runner: QualificationPhysicalRunner | null | undefined, nowMs: number): boolean {
  return !!runner && runner.phase === 'launching' && nowMs - runner.reservedAtMs < QUALIFICATION_LAUNCH_GRACE_MS;
}

const systemdRunnerLiveness: RunnerLivenessProber = async (runner) => {
  if (runner.pid != null) {
    try {
      process.kill(runner.pid, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
    }
    const observed = checkpointPidIdentity(runner.pid);
    return !observed || !runner.pidIdentity ? 'unknown' : observed === runner.pidIdentity ? 'live' : 'dead';
  }
  const unit = runner.unit?.trim();
  // Rows written before `unit` existed cannot be falsified — say so rather than guessing.
  if (!unit) return 'unknown';
  const read = (value: unknown): RunnerLiveness | null => {
    const state = String(value ?? '').trim();
    if (state === 'active' || state === 'activating' || state === 'deactivating') return 'live';
    // `is-active` prints `inactive` for a unit systemd has never heard of, which is precisely the
    // case we care about: a transient unit that has already been collected.
    if (state === 'inactive' || state === 'failed') return 'dead';
    return null;
  };
  try {
    const { stdout } = await promisify(execFile)('systemctl', ['--user', 'is-active', unit], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    return read(stdout) ?? 'unknown';
  } catch (error) {
    // A non-active unit makes `is-active` exit non-zero WITH the state on stdout, so the throw is
    // the normal path for a dead unit, not an error.
    return read((error as { stdout?: unknown } | null)?.stdout) ?? 'unknown';
  }
};

let runnerLivenessProber: RunnerLivenessProber = systemdRunnerLiveness;

/** Host seam — tests install a deterministic prober instead of shelling out to systemd. */
export function configureRunnerLivenessProber(prober: RunnerLivenessProber | null): void {
  runnerLivenessProber = prober ?? systemdRunnerLiveness;
}

/**
 * A reservation that never bound a process (no pid, no unit) and has gone untouched for longer than
 * any runner may legally live cannot have a living owner. Without this, the prober can only answer
 * 'unknown' for it, and an 'unknown' incumbent keeps its claim FOREVER — measured 2026-10-01
 * (WI-10004694): a 'launching' reservation from 2026-09-24 with pid/unit null wedged
 * hello-world-3-pot's gate for 7 days, every fire returning `conflict`.
 */
function unboundReservationOutlivedCeiling(runner: QualificationPhysicalRunner, nowMs: number): boolean {
  if (runner.pid != null || runner.unit?.trim() || runner.childScopeUnits?.length) return false;
  const lastSign = Math.max(runner.reservedAtMs, runner.heartbeatAtMs ?? 0, runner.leaseExpiresAtMs ?? 0);
  return nowMs - lastSign > QUALIFICATION_OWNER_ABANDONED_MS;
}

export async function probeRunnerLiveness(
  runner: QualificationPhysicalRunner | null | undefined,
  nowMs = Date.now(),
): Promise<RunnerLiveness> {
  if (!runner) return 'unknown';
  // A checkpoint parent can die before its independently confined payload.
  // Neither an expired lease nor the parent's PID proves that payload is gone.
  let childUnknown = false;
  for (const unit of runner.childScopeUnits ?? []) {
    const child = await runnerLivenessProber({ ...runner, unit, pid: null, pidIdentity: null,
      childScopeUnits: [] });
    if (child === 'live') return 'live';
    // Enrollment precedes systemd's asynchronous unit creation. Its absence
    // during handoff cannot permit a successor to race the original launch.
    if (child !== 'dead' || !Number.isSafeInteger(runner.childScopeReservedAtMs) ||
        nowMs - runner.childScopeReservedAtMs! < QUALIFICATION_LAUNCH_GRACE_MS) childUnknown = true;
  }
  if (childUnknown) return 'unknown';
  if (unboundReservationOutlivedCeiling(runner, nowMs)) return 'dead';
  const observed = await runnerLivenessProber(runner);
  // A scope name is reserved in the DB before systemd-run creates it. Its temporary absence
  // cannot authorize a second physical run during that launch interval.
  return observed === 'dead' && launchReservationInGrace(runner, nowMs) ? 'unknown' : observed;
}

export const PRE_SUITE_NO_VERDICT_REASONS = [
  'authority-unreadable',
  'authority-held',
  'migrations-pending',
  'source-mutated',
  'eligibility-wait',
  'would-exclude-declared-paths',
  'wait-for-eligibility-unavailable',
  'repair-in-progress',
  'repair-queue-unreadable',
  'required-ancestor-missing',
  'required-ancestor-unverifiable',
  'probe-failed',
  'already-running',
  'skipped-locked',
  'cancelled',
  'deadline-exceeded',
  // The reserving process PROVED the incumbent runner's unit was gone and took the lease from it.
  // Distinct from 'deadline-exceeded' (a runner that overran) and from 'cancelled' (a deliberate
  // stop): this one means nobody was ever going to advance that attempt.
  'runner-vanished',
  'disk-headroom',
  'infra-inconclusive',
  'target-readers',
  'dependency-generation',
  'backup-admission',
  'launch-refused',
] as const;

export type PreSuiteNoVerdictReason = (typeof PRE_SUITE_NO_VERDICT_REASONS)[number];
export type QualificationPhase = 'waiting' | 'ready' | 'running' | 'terminal';
export type QualificationOutcome =
  | { kind: 'pending' }
  | { kind: 'pre-suite-no-verdict'; reason: PreSuiteNoVerdictReason }
  | { kind: 'green'; reason: string }
  | { kind: 'red'; reason: string }
  | { kind: 'code-inconclusive'; reason: string };

export interface QualificationBlocker {
  code: string;
  detail?: string;
  clearEvents: string[];
  observedAtMs: number;
}

export interface QualificationPhysicalRunner {
  id: string;
  candidate: string | null;
  reservedAtMs: number;
  leaseExpiresAtMs?: number;
  evidenceRefs: string[];
  /**
   * The systemd unit that IS this runner, when the reserver knows it — the only field here that
   * can FALSIFY the lease. Everything else is a timestamp, and a timestamp cannot tell a working
   * runner from a dead one; see `reserveQualificationRunner`. Optional because rows written before
   * this field existed have none, and those must keep their pre-existing (lease-only) behaviour.
   */
  unit?: string | null;
  /** Enrolled before fork; retained until the scoped payload is positively dead. */
  childScopeUnits?: string[];
  /** Last child enrollment; all missing units retain the launch handoff grace. */
  childScopeReservedAtMs?: number;
  pid?: number | null;
  pidIdentity?: string | null;
  heartbeatAtMs?: number;
  /** `finalizing` (WI-6554700010009616): the tick is past its final verdict and no further suite can
   * start, so only bounded post-verdict steps remain. A runner parked here is a post-verdict hang. */
  phase?: 'launching' | 'materializing' | 'suite' | 'isolating' | 'delivering' | 'finalizing';
  /** When `phase` last changed. The heartbeat keeps advancing through an awaited hang, so only
   * this clock can say how long the runner has been parked in one phase. */
  phaseEnteredAtMs?: number;
}

export interface QualificationPhysicalRun extends QualificationPhysicalRunner {
  endedAtMs: number;
  outcome: QualificationOutcome;
}

export type QualificationSafeNextAction =
  | { code: 'launch-physical-run'; reason: string; waitEvents: string[] }
  | { code: 'launch-preflight-runner'; reason: string; waitEvents: string[] }
  | { code: 'await-blocker-events'; reason: string; waitEvents: string[] }
  | { code: 'await-current-run'; reason: string; waitEvents: string[] }
  | { code: 'recover-expired-runner'; reason: string; waitEvents: string[] }
  | { code: 'inspect-runner-liveness'; reason: string; waitEvents: string[] }
  | { code: 'repair-code'; reason: string; waitEvents: string[] }
  | { code: 'inspect-terminal-evidence'; reason: string; waitEvents: string[] }
  | { code: 'read-release-control'; reason: string; waitEvents: string[] };

export interface CheckpointQualificationState {
  status: 'none' | 'unreadable' | 'present';
  attemptId: string | null;
  candidate: string | null;
  phase: QualificationPhase | null;
  outcome: QualificationOutcome | null;
  owner: { kind: 'routine'; id: 'system:green-checkpoint' };
  lease: {
    holder: string;
    acquiredAtMs: number;
    expiresAtMs: number;
    expired: boolean;
  } | null;
  runnerHealth: {
    state: 'none' | 'progressing' | 'stalled' | 'dead';
    liveness: RunnerLiveness;
    phase: QualificationPhysicalRunner['phase'] | null;
    progressAgeMs: number | null;
  };
  blockers: QualificationBlocker[];
  phaseDurationsMs: Partial<Record<QualificationPhase, number>>;
  clocks: {
    lastScheduledAtMs: number | null;
    lastStartedAtMs: number | null;
    lastProgressAtMs: number | null;
    lastTerminalVerdictAtMs: number | null;
  };
  agesMs: {
    attempt: number | null;
    scheduled: number | null;
    started: number | null;
    progress: number | null;
    terminal: number | null;
  };
  consumedPhysicalRuns: QualificationPhysicalRun[];
  eligibilitySnapshot: CheckpointEligibilitySnapshot | null;
  safeNextAction: QualificationSafeNextAction;
  unknown: { code: 'resolver-failed'; detail: string } | null;
}

export interface CheckpointQualificationTransaction {
  schemaVersion: typeof CHECKPOINT_QUALIFICATION_SCHEMA_VERSION;
  attemptId: string;
  createdAtMs: number;
  updatedAtMs: number;
  /** A scheduler tick is not evidence that a suite started or progressed. */
  lastScheduledAtMs?: number;
  lastStartedAtMs?: number;
  lastProgressAtMs?: number;
  lastTerminalVerdictAtMs?: number;
  requiredAncestorSha: string | null;
  candidatePolicy: {
    kind: 'quiet-cut';
    declaredPaths: string[];
  };
  candidate: string | null;
  /** Exact repair-head identity selected for this attempt, when a frozen queue supplied one. */
  repairHead: string | null;
  /** A newly admitted head waiting for its own successor verification attempt. */
  pendingRepairHead?: string | null;
  /** Physical run identity that currently owns (or produced) this logical attempt. */
  runId: string | null;
  phase: QualificationPhase;
  phaseEnteredAtMs?: number;
  phaseDurationsMs?: Partial<Record<QualificationPhase, number>>;
  outcome: QualificationOutcome;
  blockers: QualificationBlocker[];
  waitGeneration: number;
  currentPhysicalRunner: QualificationPhysicalRunner | null;
  consumedPhysicalRuns?: QualificationPhysicalRun[];
  evidenceRefs: string[];
  previousAttemptId: string | null;
  eligibilitySnapshot?: CheckpointEligibilitySnapshot | null;
  /** The full selected population and durable outcomes, under this record's existing runner fence. */
  continuation?: QualificationWorkContinuation;
  /** Selection and carry consumption are committed together before materialization. */
  preparedSelection?: PreparedCheckpointSelectionRecord;
}

export interface PreparedCheckpointSelectionRecord {
  schemaVersion: 1;
  attemptId: string;
  integrationRoot: string;
  checkpointRoot: string;
  candidate: string;
  tip: string;
  base: string | null;
  candidateSource: CheckpointCandidateSource;
  quietCutApplied: boolean;
  freezeCut: FreezeCutRecord | null;
  generation: { candidate: string; identity: string; token: string; inputFingerprint: string; reused: boolean; root: string };
  carry: FrozenRepairCarryRecord | null;
  /** Captured queue authority, including its version, for restart validation. */
  queue?: FrozenCandidateRepairQueue | null;
}

export function isPreparedCheckpointSelectionRecord(value: unknown): value is PreparedCheckpointSelectionRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as PreparedCheckpointSelectionRecord;
  const freeze = r.freezeCut;
  const validFreeze = freeze === null || (freeze && typeof freeze === 'object' &&
    ['known-good', 'staging-tip'].includes(freeze.source) &&
    ['known-good-selected', 'no-known-good', 'known-good-unreadable', 'known-good-not-on-tip-lineage',
      'known-good-not-ahead-of-green', 'carry-advanced-to-tip'].includes(freeze.reason) &&
    freeze.candidate === r.candidate && freeze.tip === r.tip &&
    (freeze.knownGood === null || (typeof freeze.knownGood === 'string' && freeze.knownGood.length > 0)));
  const carry = parseFrozenRepairCarryRecord(r.carry);
  return r.schemaVersion === 1 && [r.attemptId, r.integrationRoot, r.checkpointRoot,
    r.candidate, r.tip, r.candidateSource, r.generation?.root, r.generation?.identity,
    r.generation?.token].every(v => typeof v === 'string' && v.length > 0) &&
    isCheckpointCandidateSource(r.candidateSource) &&
    (r.base === null || typeof r.base === 'string') && typeof r.quietCutApplied === 'boolean' &&
    r.generation.candidate === r.candidate && /^[a-f0-9]{64}$/.test(r.generation.inputFingerprint) &&
    typeof r.generation.reused === 'boolean' &&
    Boolean(validFreeze) &&
    (r.queue === undefined || r.queue === null || parseFrozenCandidateRepairQueue(r.queue) !== null) &&
    (r.carry === null || (carry !== null && isDeepStrictEqual(carry, r.carry) && carry.judgedCandidate === r.candidate));
}

/**
 * WI-6554700010029580: the queue facts the preflight's candidate choice reads — the queue's lineage,
 * the repair head, and whether the frozen candidate itself is still owed its first verdict
 * (`ready-to-test`). Fixer, verdict and latency bookkeeping (`updatedAtMs`, `fixerStateChangedAtMs`,
 * `fixerSpawnId`, `attempts`, `freeRetries`, `lastVerdictAtMs`, rounds, legs, …) moves between one
 * attempt's physical runs without changing that choice. Whole-row equality here crashed every such
 * resume (the EI-21813295393334986 lesson the queue CAS already learned). The runner re-reads the
 * queue under the serializer and still refuses a changed selection, so this stays fail-closed.
 */
function preparedSelectionQueueAuthority(queue: FrozenCandidateRepairQueue) {
  return {
    candidate: queue.candidate,
    openedAtMs: queue.openedAtMs,
    qualificationAttemptId: queue.qualificationAttemptId ?? null,
    base: queue.base,
    repairHead: queue.repairHead,
    judgesCandidate: queue.phase === 'ready-to-test',
  };
}

/**
 * WI-6554700010030147: the preflight's pre-commit re-read and the commit CAS ask the same
 * question the recovery path above asks — "would this queue still select the same candidate?" —
 * so they compare the same authority, never the whole row. A running admission pre-check rewrites
 * its heartbeat, currentFile and per-file results every few seconds; whole-row equality made every
 * preparation replan until the run budget expired (papercusp 2026-10-27 10:23Z, candidate
 * 8c03b5dcd156: "prepared selection authority churn exhausted run deadline/refire budget").
 * The runner still re-reads the queue under the serializer, so this stays fail-closed.
 */
export function checkpointSelectionQueueAuthorityMatches(
  a: FrozenCandidateRepairQueue | null,
  b: FrozenCandidateRepairQueue | null,
): boolean {
  if (a === null || b === null) return a === b;
  return isDeepStrictEqual(preparedSelectionQueueAuthority(a), preparedSelectionQueueAuthority(b));
}

/** A fresh run may have persisted its own initial queue before dying in materialization. */
export function preparedCheckpointQueueMatches(
  record: PreparedCheckpointSelectionRecord,
  queue: FrozenCandidateRepairQueue | null,
): boolean {
  if (record.queue === undefined || isDeepStrictEqual(record.queue, queue)) return true;
  if (record.queue !== null) {
    // A captured queue never takes the fresh-cut exception below; it must still select the same candidate.
    const captured = parseFrozenCandidateRepairQueue(record.queue);
    return captured !== null && queue !== null && isDeepStrictEqual(
      preparedSelectionQueueAuthority(captured), preparedSelectionQueueAuthority(queue));
  }
  if (queue === null) return false;
  // Reconstruct exactly the initial queue this attempt is allowed to publish.
  // An admission, verdict, version change, or another attempt still invalidates it.
  const initial = createFrozenCandidateQueue({
    candidate: record.candidate, qualificationAttemptId: record.attemptId, base: record.base,
    affectedTestProofGroup: queue.affectedTestProofGroup, nowMs: queue.openedAtMs,
  });
  return isDeepStrictEqual(parseFrozenCandidateRepairQueue(queue), parseFrozenCandidateRepairQueue(initial));
}

/**
 * WI-6554700010010801: an attempt's write-once `preparedSelection` is reusable only while it
 * names the attempt's own `candidate`. A joined scheduled fire attaches its runner on the
 * stored candidate, and then `beginPreparedCheckpointPreflight` recovers the stored selection
 * and hands the writer ITS candidate. The post-preflight reservation refresh then refuses the
 * difference (`candidate-mismatch:pre-suite-retarget-runner-already-attached`), so every
 * joined fire crashes before the writer can act. Measured on papercusp 2026-10-26 23:25Z:
 * attempt 1c4273b1 stored candidate 8c03b5dc after a pre-suite `repair-in-progress`
 * settlement, but kept the selection an earlier physical run had committed for 327e4d1d.
 *
 * A transition that moves the candidate therefore voids a selection made for the old one.
 * The next physical run plans and commits afresh. Only the recovery path reads the stored
 * record (a running writer uses the copy it was handed), so voiding it cannot strand a run.
 */
export function voidPreparedSelectionForMovedCandidate(
  transaction: CheckpointQualificationTransaction,
): CheckpointQualificationTransaction {
  const selection = transaction.preparedSelection;
  if (!selection || preparedSelectionNamesAttemptCandidate(transaction, selection)) return transaction;
  const { preparedSelection: _voided, ...rest } = transaction;
  return {
    ...rest,
    evidenceRefs: uniqueStrings([...transaction.evidenceRefs, `prepared-selection-voided:${selection.candidate}`]),
  };
}

/**
 * WI-6554700010029754: the one invariant behind every prepared-selection guard. A selection is
 * usable only while it names the attempt's pinned `candidate` (an unpinned attempt accepts any).
 * The CLI attaches its runner on that candidate BEFORE the preflight selects, and the
 * post-preflight reservation refresh refuses any other candidate for an attached runner, so a
 * selection naming a different candidate can only end in that refusal.
 */
export function preparedSelectionNamesAttemptCandidate(
  transaction: Pick<CheckpointQualificationTransaction, 'candidate'>,
  selection: Pick<PreparedCheckpointSelectionRecord, 'candidate'>,
): boolean {
  const candidate = transaction.candidate?.trim();
  return !candidate || selection.candidate === candidate;
}

/** Read the existing qualification authority; absence is distinct from unreadability. */
export async function readPreparedCheckpointSelection(
  target: GateVerdictTarget,
  input: Pick<PreparedCheckpointSelectionRecord, 'attemptId' | 'integrationRoot' | 'checkpointRoot'>,
): Promise<PreparedCheckpointSelectionRecord | null> {
  const read = await readStoredQualification(target);
  if (read.status !== 'present') throw new Error('prepared selection qualification authority unavailable');
  const current = read.transaction;
  if (current.attemptId !== input.attemptId) throw new Error('prepared selection attempt authority mismatch');
  const record = current.preparedSelection;
  if (record === undefined) return null;
  if (!isPreparedCheckpointSelectionRecord(record) || record.attemptId !== input.attemptId ||
      record.integrationRoot !== input.integrationRoot || record.checkpointRoot !== input.checkpointRoot)
    throw new Error('malformed or mismatched prepared selection authority');
  // A stored selection for a different candidate is void, not recoverable: handing it to the
  // writer would only reproduce the attached-runner refusal. Plan afresh instead; the commit
  // below replaces the void record.
  if (!preparedSelectionNamesAttemptCandidate(current, record)) return null;
  return record;
}

/** The routine row serializes selection publication and carry consumption in one transaction. */
export async function commitPreparedCheckpointSelection(
  target: GateVerdictTarget,
  record: PreparedCheckpointSelectionRecord,
  expected: { queue: FrozenCandidateRepairQueue | null; pendingCarry: FrozenRepairPendingCarry | null },
): Promise<boolean> {
  if (!isPreparedCheckpointSelectionRecord(record)) throw new Error('invalid prepared selection authority');
  return boundedOrgTxn(async tx => {
    const rows = await tx<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM harness_shared.routines
      WHERE workspace_id = ${target.workspaceId} AND install_slug = ${target.installSlug}
        AND target_role = 'system:green-checkpoint' FOR UPDATE`;
    if (!rows[0]) throw new Error('missing prepared selection qualification authority');
    const metadata = rows[0].metadata ?? {};
    const current = parseCheckpointQualificationTransaction(metadata[CHECKPOINT_QUALIFICATION_METADATA_KEY]);
    if (!current) throw new Error('unreadable prepared selection qualification authority');
    if (current.attemptId !== record.attemptId || current.phase === 'terminal') return false;
    const queueRaw = metadata.repair_queue ?? null;
    const queue = queueRaw === null ? null : parseFrozenCandidateRepairQueue(queueRaw);
    const pendingRaw = metadata[FROZEN_REPAIR_CARRY_METADATA_KEY] ?? null;
    const pending = pendingRaw === null ? null : parseFrozenRepairPendingCarry(pendingRaw);
    if ((queueRaw !== null && !queue) || (pendingRaw !== null && !pending))
      throw new Error('unreadable prepared selection queue/carry authority');
    if (!checkpointSelectionQueueAuthorityMatches(queue, expected.queue) || !isDeepStrictEqual(pending, expected.pendingCarry)) return false;
    // WI-6554700010029754: fail fast instead of returning false. The caller would replan, the
    // selector would pick the same candidate until the run budget expired, and the attached
    // runner's post-preflight refresh refuses it anyway. Publishing it would also hand this
    // record to every later fire of the attempt. Without an attached runner the refresh re-pins
    // the attempt to the selection, so that case may still commit.
    if (current.currentPhysicalRunner && !preparedSelectionNamesAttemptCandidate(current, record)) {
      throw new Error(`prepared selection candidate-mismatch: selected ${record.candidate} but attempt ` +
        `${current.attemptId} is pinned to ${current.candidate} by an attached runner (WI-6554700010029754)`);
    }
    const voided = current.preparedSelection &&
      !preparedSelectionNamesAttemptCandidate(current, current.preparedSelection) ? current.preparedSelection : null;
    if (current.preparedSelection && !voided) return isDeepStrictEqual(current.preparedSelection, record);
    if (record.carry && (!pending || record.carry.fromCandidate !== pending.fromCandidate ||
        record.carry.fromRepairHead !== pending.fromRepairHead)) return false;
    const nextMetadata: Record<string, unknown> = { ...metadata, [CHECKPOINT_QUALIFICATION_METADATA_KEY]: {
      ...current, preparedSelection: record, updatedAtMs: Date.now(),
      ...(voided ? { evidenceRefs: uniqueStrings([...current.evidenceRefs, `prepared-selection-voided:${voided.candidate}`]) } : {}),
    } };
    if (record.carry) {
      delete nextMetadata[FROZEN_REPAIR_CARRY_METADATA_KEY];
      nextMetadata[FROZEN_REPAIR_CARRY_LAST_METADATA_KEY] = record.carry;
    }
    await tx`UPDATE harness_shared.routines SET metadata = ${JSON.stringify(nextMetadata)}::jsonb, updated_at = now()
      WHERE workspace_id = ${target.workspaceId} AND install_slug = ${target.installSlug}
        AND target_role = 'system:green-checkpoint'`;
    return true;
  }, QUALIFICATION_STORE_TXN_OPTIONS);
}

export interface QualificationWorkUnit {
  id: string;
  kind: 'test' | 'guard' | 'post-suite';
  path: string;
  exclusion?: { reason: string; policyRef: string };
}

export interface QualificationWorkReceipt {
  unitId: string;
  completionId: string;
  observedAtMs: number;
  state: 'pass' | 'fail' | 'infra';
  worktreeDirty?: boolean;
  observedCount?: number;
  firstAttemptVerdict?: 'pass' | 'fail' | 'unknown';
  proof?: Record<string, unknown>;
}

export interface QualificationWorkContinuation {
  schemaVersion: 1;
  attemptId: string;
  candidate: string;
  repairHead: string | null;
  root: string;
  taskKey: string;
  manifest: { schemaVersion: 1; units: QualificationWorkUnit[] };
  receipts: QualificationWorkReceipt[];
  retryStates: Array<'fail' | 'infra'>;
  supersededReceipts: QualificationWorkReceipt[];
  /** Immutable enrollment references, retained across physical runner replacement. */
  nativeProducers?: QualificationNativeProducerReference[];
  /** Saved under the same row lock as receipts; never releases a still-live runner. */
  lastYield?: QualificationWorkYield;
}

export interface QualificationWorkYield {
  runnerId: string;
  runId: string;
  savedAtMs: number;
  executionCutoffEpochMs: number;
  yieldDeadlineEpochMs: number;
  cleanupDeadlineEpochMs: number;
  orphanDeadlineEpochMs: number;
  callerDeadlineEpochMs: number | null;
  completed: Array<{ unitId: string; completionId: string }>;
  pendingUnitIds: string[];
}

function validQualificationWorkYield(value: QualificationWorkYield, work: QualificationWorkContinuation): boolean {
  if (!value || typeof value.runnerId !== 'string' || !value.runnerId || typeof value.runId !== 'string' || !value.runId ||
      ![value.savedAtMs, value.executionCutoffEpochMs, value.yieldDeadlineEpochMs,
        value.cleanupDeadlineEpochMs, value.orphanDeadlineEpochMs].every(at => Number.isSafeInteger(at) && at >= 0) ||
      value.executionCutoffEpochMs > value.savedAtMs || value.savedAtMs >= value.yieldDeadlineEpochMs ||
      value.yieldDeadlineEpochMs >= value.cleanupDeadlineEpochMs || value.cleanupDeadlineEpochMs > value.orphanDeadlineEpochMs ||
      (value.callerDeadlineEpochMs !== null && (!Number.isSafeInteger(value.callerDeadlineEpochMs) ||
        value.cleanupDeadlineEpochMs > value.callerDeadlineEpochMs)) ||
      !Array.isArray(value.completed) || !Array.isArray(value.pendingUnitIds)) return false;
  const units = new Set(work.manifest.units.filter(unit => !unit.exclusion).map(unit => unit.id));
  const ids = [...value.completed.map(receipt => receipt?.unitId), ...value.pendingUnitIds];
  return ids.length === units.size && new Set(ids).size === ids.length && ids.every(id => units.has(id)) &&
    new Set(value.completed.map(receipt => receipt?.completionId)).size === value.completed.length &&
    value.completed.every(receipt => typeof receipt?.completionId === 'string' && !!receipt.completionId);
}

/** Persist a quantum cursor without surrendering custody before process cleanup.
 * The caller's snapshot is checked against the locked canonical receipt population.
 * Source validity and reuse permission remain the existing continuation validator's job. */
export function recordQualificationWorkYield(current: CheckpointQualificationTransaction,
  input: QualificationWorkProgressInput, checkpoint: QualificationWorkYield): QualificationTransition {
  const conflict = (refusalReason: string): QualificationTransition => ({ status: 'conflict', transaction: current, refusalReason });
  if (input.updates.length) return conflict('yield-mixed-updates');
  const custody = recordQualificationWorkProgress(current, input);
  if (custody.status !== 'updated' && custody.status !== 'idempotent') return custody;
  const work = custody.transaction.continuation!;
  const activeUnits = new Set(work.manifest.units.filter(unit => !unit.exclusion).map(unit => unit.id));
  const receipts = work.receipts.filter(receipt => activeUnits.has(receipt.unitId));
  if (!validQualificationWorkYield(checkpoint, work) || checkpoint.runnerId !== input.runnerId || checkpoint.runId !== input.runId ||
      checkpoint.savedAtMs !== (input.nowMs ?? Date.now()) ||
      checkpoint.savedAtMs < current.updatedAtMs ||
      checkpoint.completed.length !== receipts.length || checkpoint.completed.some(saved =>
        !receipts.some(receipt => receipt.unitId === saved.unitId && receipt.completionId === saved.completionId)))
    return conflict('yield-cursor-mismatch');
  if (isDeepStrictEqual(work.lastYield, checkpoint)) return { status: 'idempotent', transaction: custody.transaction };
  if (!receipts.some(receipt => receipt.observedAtMs >= current.currentPhysicalRunner!.reservedAtMs &&
      receipt.observedAtMs <= checkpoint.savedAtMs &&
      !work.lastYield?.completed.some(saved => saved.completionId === receipt.completionId)))
    return conflict('yield-no-new-completion');
  return { status: 'updated', transaction: { ...custody.transaction, updatedAtMs: checkpoint.savedAtMs,
    continuation: { ...work, lastYield: structuredClone(checkpoint) } } };
}

export interface QualificationNativeProducerReference {
  path: string;
  outPath: string;
  taskKey: string;
  workspaceName: string;
  runGroupId: string;
  registeredAtMs: number;
  selectedSpecifications: unknown[];
  /** Binds command, environment digest and selection as well as producer identity. */
  sha256: string;
  /** Exact retry predecessors admitted when this producer was enrolled. */
  supersedesCompletionIds?: Record<string, string>;
  /** No outcome existed, no receipt was banked, and the ended runner was proved dead. */
  missingSnapshot?: { runnerId: string; confirmedAtMs: number };
}

function validNativeProducerReferences(value: unknown): value is QualificationNativeProducerReference[] {
  if (!Array.isArray(value)) return false;
  const paths = new Set<string>(), outputs = new Set<string>();
  return value.every(ref => {
    if (!ref || [ref.path, ref.outPath, ref.taskKey, ref.workspaceName, ref.runGroupId]
      .some(field => typeof field !== 'string' || !field) || !ref.path.startsWith('/') ||
      !ref.outPath.startsWith('/') || ref.path !== `${ref.outPath}.producer.json` ||
      paths.has(ref.path) || outputs.has(ref.outPath) || !Number.isSafeInteger(ref.registeredAtMs) ||
      ref.registeredAtMs <= 0 || !Array.isArray(ref.selectedSpecifications) || !ref.selectedSpecifications.length ||
      !/^[a-f0-9]{64}$/.test(ref.sha256)) return false;
    if (ref.supersedesCompletionIds !== undefined &&
        (!ref.supersedesCompletionIds || typeof ref.supersedesCompletionIds !== 'object' ||
        Array.isArray(ref.supersedesCompletionIds) || Object.entries(ref.supersedesCompletionIds)
          .some(([unit, completion]) => !unit || typeof completion !== 'string' || !completion))) return false;
    if (ref.missingSnapshot !== undefined && (!ref.missingSnapshot ||
        typeof ref.missingSnapshot.runnerId !== 'string' || !ref.missingSnapshot.runnerId ||
        !Number.isSafeInteger(ref.missingSnapshot.confirmedAtMs) ||
        ref.missingSnapshot.confirmedAtMs < ref.registeredAtMs)) return false;
    paths.add(ref.path); outputs.add(ref.outPath);
    return true;
  });
}

function workLineageConflicts(
  current: CheckpointQualificationTransaction,
  input: { candidate?: string | null; repairHead?: string | null },
): boolean {
  const work = current.continuation;
  return !!work && ((!!input.candidate?.trim() && input.candidate.trim() !== work.candidate) ||
    (!!input.repairHead?.trim() && input.repairHead.trim() !== work.repairHead));
}

export interface QualificationWorkProgressInput {
  attemptId: string;
  candidate: string;
  repairHead: string | null;
  runnerId: string;
  runId: string;
  pidIdentity: string;
  root: string;
  taskKey: string;
  manifest: QualificationWorkContinuation['manifest'];
  retryStates: QualificationWorkContinuation['retryStates'];
  runContext: string;
  runnerIdentity: string;
  updates: Array<{ receipt: QualificationWorkReceipt; supersedesCompletionId?: string }>;
  nowMs?: number;
}

/** Commit a frozen population/outcome update inside the existing qualification row lock. */
export function recordQualificationWorkProgress(
  current: CheckpointQualificationTransaction,
  input: QualificationWorkProgressInput,
): QualificationTransition {
  const conflict = (refusalReason: string): QualificationTransition => ({ status: 'conflict', transaction: current, refusalReason });
  const runner = current.currentPhysicalRunner;
  if (isTerminalQualificationOutcome(current.outcome)) return { status: 'terminal', transaction: current };
  if (current.attemptId !== input.attemptId || current.phase !== 'running' ||
      !runner || runner.id !== input.runnerId || !current.runId || current.runId !== input.runId ||
      !runner.pidIdentity || runner.pidIdentity !== input.pidIdentity) return conflict('runner-fence-mismatch');
  if (!input.candidate || current.candidate !== input.candidate || runner.candidate !== input.candidate ||
      current.repairHead !== input.repairHead) return conflict('continuation-lineage-mismatch');
  if (!input.root || !input.taskKey || !Array.isArray(input.updates) || !Array.isArray(input.retryStates) ||
      input.retryStates.some(state => state !== 'fail' && state !== 'infra')) return conflict('continuation-input-invalid');
  const prior = current.continuation;
  if (prior && (prior.attemptId !== current.attemptId || prior.candidate !== current.candidate ||
      prior.repairHead !== current.repairHead)) return conflict('continuation-lineage-mismatch');
  const retryStates = [...new Set(input.retryStates)].sort();
  if (prior && (prior.root !== input.root || prior.taskKey !== input.taskKey ||
      JSON.stringify(prior.retryStates) !== JSON.stringify(retryStates))) return conflict('continuation-policy-mismatch');
  const receipts = new Map((prior?.receipts ?? []).map(receipt => [receipt.unitId, receipt]));
  const history = [...(prior?.supersededReceipts ?? [])];
  const expected = { root: input.root, taskKey: input.taskKey, attemptId: current.attemptId,
    candidate: current.candidate, repairHead: current.repairHead, sourceCommit: input.candidate,
    runContext: input.runContext, runnerIdentity: input.runnerIdentity, manifest: input.manifest, retryStates };
  const grade = (manifest: QualificationWorkContinuation['manifest'], values: QualificationWorkReceipt[]) =>
    evaluatePartialTaskContinuation({ root: input.root, taskKey: input.taskKey,
      continuation: { schemaVersion: 1, attemptId: current.attemptId, candidate: current.candidate,
        repairHead: current.repairHead, manifest, receipts: values } }, expected);
  const before = grade(prior?.manifest ?? input.manifest, [...receipts.values()]);
  if (before.status !== 'ready') return conflict(`continuation-${before.reason}`);
  const updatedUnits = new Set<string>();
  const completionIds = new Set([...receipts.values(), ...history].map(receipt => receipt.completionId));
  let changed = !prior;
  for (const update of input.updates) {
    const receipt = update?.receipt;
    if (!receipt || updatedUnits.has(receipt.unitId)) return conflict('continuation-duplicate-unit-update');
    updatedUnits.add(receipt.unitId);
    const previous = receipts.get(receipt.unitId);
    // JSONB may reorder object keys; a durable replay still names the identical
    // completion rather than conflicting solely on serialization order.
    if (previous && isDeepStrictEqual(previous, receipt)) continue;
    if (completionIds.has(receipt.completionId)) return conflict('continuation-completion-id-conflict');
    if (previous) {
      if (update.supersedesCompletionId !== previous.completionId || !new Set<string>(before.run).has(receipt.unitId))
        return conflict('continuation-replacement-not-admitted');
      history.push(previous);
    } else if (update.supersedesCompletionId !== undefined) return conflict('continuation-predecessor-missing');
    receipts.set(receipt.unitId, structuredClone(receipt));
    completionIds.add(receipt.completionId);
    changed = true;
  }
  const result = grade(input.manifest, [...receipts.values()]);
  if (result.status !== 'ready') return conflict(`continuation-${result.reason}`);
  if (!changed) return { status: 'idempotent', transaction: current };
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < current.updatedAtMs) return conflict('continuation-clock-regressed');
  return { status: 'updated', transaction: { ...current, updatedAtMs: nowMs, lastProgressAtMs: nowMs,
    continuation: { schemaVersion: 1, attemptId: current.attemptId, candidate: input.candidate,
      repairHead: current.repairHead, root: input.root, taskKey: input.taskKey,
      manifest: structuredClone(prior?.manifest ?? input.manifest), receipts: [...receipts.values()],
      retryStates, supersededReceipts: history,
      ...(prior?.lastYield ? { lastYield: structuredClone(prior.lastYield) } : {}),
      ...(prior?.nativeProducers ? { nativeProducers: structuredClone(prior.nativeProducers) } : {}) } } };
}

export interface BeginQualificationInput {
  attemptId: string;
  requiredAncestorSha?: string | null;
  declaredPaths?: readonly string[];
  candidate?: string | null;
  repairHead?: string | null;
  runId?: string | null;
  evidenceRefs?: readonly string[];
  /** What the caller proved about the INCUMBENT attempt's runner. Default 'unknown' = old behaviour. */
  incumbentLiveness?: RunnerLiveness;
  /**
   * WI-10007408: what the caller measured about the fixer an `awaiting-fixer` frozen queue
   * names, keyed by the EXACT spawn id it probed. Successor reconciliation is pure and cannot
   * probe, and the probe necessarily runs before the locked row is read, so the spawn id is the
   * binding: a verdict about a superseded fixer can never vouch for whichever fixer the locked
   * row names now. Absent / 'unknown' / mismatched = old fail-closed behaviour.
   */
  assignedFixerLiveness?: { spawnId: string; liveness: RunnerLiveness } | null;
  nowMs?: number;
  /**
   * Same-row proof that an unowned `repair-in-progress` wait now has an exact,
   * never-judged `ready-to-verify` repair head. Set only by
   * {@link beginStoredQualification}; callers cannot infer this from the
   * qualification record alone because the repair queue is the authority.
   */
  resumeUnownedRepairVerification?: boolean;
  /**
   * EI-22931381517977345: derive the logical attempt identity from the frozen repair queue's
   * VERIFICATION TARGET (`repairHead`, else `candidate`), read from the SAME locked routine row
   * the transaction lives in. Without it a request that declares no paths hashes to a per-root
   * constant (the pre-launch preflight yields candidate:null/tip:null), so one terminal
   * code-inconclusive attempt refuses every later verify of the lineage — even after an
   * admission advanced `repairHead` — via the same-id 'terminal' branch, which never reaches the
   * distinct-successor reconciliation. Called only when a queue target exists; the returned id
   * replaces `attemptId`.
   */
  attemptIdForVerificationTarget?: (target: string) => string;
}

export interface CancelQualificationInput {
  /** The exact logical attempt the caller intends to stop. */
  attemptId: string;
  /** The exact systemd unit recorded on that attempt's physical runner. */
  unit: string;
  /** A durable, human-readable reason for the inconclusive terminal outcome. */
  reason?: string;
  evidenceRefs?: readonly string[];
  nowMs?: number;
}

export type QualificationTransition =
  | { status: 'updated' | 'idempotent'; transaction: CheckpointQualificationTransaction }
  | { status: 'conflict' | 'terminal'; transaction: CheckpointQualificationTransaction; refusalReason?: string };

/**
 * A scheduled fire may safely retarget only a runner placeholder that never attached a CLI.
 * The gate-fire reference is just the pre-spawn reservation; `checkpoint-run:<id>` is the
 * evidence that a process actually attached. The same-row queue check lives in
 * beginStoredQualification, and this physical check keeps an attached runner pinned.
 */
function isUnstartedDeadRepairRunner(
  current: CheckpointQualificationTransaction | null,
  incumbentLiveness: RunnerLiveness | undefined,
  nowMs: number,
): boolean {
  const runner = current?.currentPhysicalRunner;
  return Boolean(
    current &&
    current.phase === 'running' &&
    current.outcome.kind === 'pending' &&
    current.pendingRepairHead &&
    runner &&
    runner.phase === 'launching' &&
    runner.pid == null &&
    runner.pidIdentity == null &&
    !(runner.evidenceRefs ?? []).some((ref) => ref.startsWith('checkpoint-run:')) &&
    incumbentLiveness === 'dead' &&
    !launchReservationInGrace(runner, nowMs) &&
    (!current.runId || storedRunIdIsFromEndedRunner(current) || storedRunIdOrphanedAtUnattachedRunner(current))
  );
}

/**
 * EI-21643577467008123 — this waiting reason is emitted only after the durable
 * waiter failed to start. It therefore has no owner that can ever advance it and
 * must not retain the singleton transaction against a later retry/successor.
 *
 * WI-10005450 — a scheduled fire can also leave a `running` logical attempt with only an
 * unattached launch placeholder after the prior CLI vanished. When the same locked repair queue
 * proves a new untested head and liveness says the placeholder is dead, resume that exact attempt
 * at the new head instead of letting every tick reserve the old candidate and conflict at CLI
 * activation. Unknown/live runners remain exclusive.
 */
function isUnstartedAncestryRefusal(current: CheckpointQualificationTransaction | null): boolean {
  return Boolean(current && current.phase === 'waiting' &&
    current.outcome.kind === 'pre-suite-no-verdict' &&
    ['required-ancestor-missing', 'required-ancestor-unverifiable'].includes(current.outcome.reason) &&
    current.currentPhysicalRunner === null &&
    !(current.consumedPhysicalRuns ?? []).some(run => run.outcome.kind !== 'pre-suite-no-verdict'));
}

function isRetryableUnownedWait(
  current: CheckpointQualificationTransaction | null,
  resumeUnownedRepairVerification = false,
  incumbentLiveness?: RunnerLiveness,
  nowMs = Date.now(),
): boolean {
  if (resumeUnownedRepairVerification && isUnstartedDeadRepairRunner(current, incumbentLiveness, nowMs)) return true;
  if (
    !current ||
    current.phase !== 'waiting' ||
    current.outcome.kind !== 'pre-suite-no-verdict' ||
    current.currentPhysicalRunner !== null
  )
    return false;
  if (current.outcome.reason === 'wait-for-eligibility-unavailable') return true;
  return resumeUnownedRepairVerification &&
    (current.outcome.reason === 'repair-in-progress' || isUnstartedAncestryRefusal(current));
}

/**
 * Has the attempt's owner GONE, leaving the singleton held by nobody?
 *
 * The exclusivity above is correct only while "its real owner advances it" holds. Nothing enforced
 * that: an owner that died mid-attempt kept the transaction non-terminal AND non-retryable
 * forever, so `beginQualificationTransaction` returned `conflict` to every later attempt — the
 * scheduled routine included. The gate then renders no verdict at all while looking merely red,
 * and no amount of fixing tests moves it. Two provable ways an owner is gone:
 *
 *  - a physical runner whose unit the caller probed and found absent; or
 *  - no runner at all, and no write for longer than a runner could legally live.
 *
 * Both require evidence. An owner we cannot prove dead keeps its claim.
 */
function isAbandonedQualification(
  current: CheckpointQualificationTransaction | null,
  incumbentLiveness: RunnerLiveness | undefined,
  nowMs: number,
): boolean {
  if (!current || isTerminalQualificationOutcome(current.outcome)) return false;
  if (current.currentPhysicalRunner)
    return incumbentLiveness === 'dead' && !launchReservationInGrace(current.currentPhysicalRunner, nowMs);
  return nowMs - current.updatedAtMs > QUALIFICATION_OWNER_ABANDONED_MS;
}

const uniqueStrings = (values: readonly string[], cap = 64): string[] =>
  [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, cap);

export const isTerminalQualificationOutcome = (outcome: QualificationOutcome): boolean =>
  outcome.kind === 'green' || outcome.kind === 'red' || outcome.kind === 'code-inconclusive';

function isQualificationOutcome(value: unknown): value is QualificationOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const outcome = value as { kind?: unknown; reason?: unknown };
  if (outcome.kind === 'pending') return true;
  if (outcome.kind === 'pre-suite-no-verdict') {
    return (PRE_SUITE_NO_VERDICT_REASONS as readonly unknown[]).includes(outcome.reason);
  }
  return ['green', 'red', 'code-inconclusive'].includes(String(outcome.kind)) && typeof outcome.reason === 'string';
}

function isPhysicalRun(value: unknown): value is QualificationPhysicalRun {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const run = value as Partial<QualificationPhysicalRun>;
  return (
    typeof run.id === 'string' &&
    !!run.id &&
    (run.candidate === null || typeof run.candidate === 'string') &&
    Number.isFinite(run.reservedAtMs) &&
    Number.isFinite(run.leaseExpiresAtMs) &&
    Number.isFinite(run.endedAtMs) &&
    (run.pid == null || (Number.isInteger(run.pid) && run.pid > 0)) &&
    (run.pidIdentity == null || typeof run.pidIdentity === 'string') &&
    Array.isArray(run.evidenceRefs) &&
    run.evidenceRefs.every((ref) => typeof ref === 'string') &&
    isQualificationOutcome(run.outcome)
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = uniqueStrings(left).sort();
  const b = uniqueStrings(right).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function completedPhaseDurations(
  current: CheckpointQualificationTransaction,
  nextPhase: QualificationPhase,
  nowMs: number,
): Partial<Record<QualificationPhase, number>> {
  if (current.phase === nextPhase) return current.phaseDurationsMs ?? {};
  const phaseDurations = current.phaseDurationsMs ?? {};
  const phaseEnteredAtMs = current.phaseEnteredAtMs ?? current.updatedAtMs;
  return {
    ...phaseDurations,
    [current.phase]: (phaseDurations[current.phase] ?? 0) + Math.max(0, nowMs - phaseEnteredAtMs),
  };
}

function consumedRunner(
  current: CheckpointQualificationTransaction,
  outcome: QualificationOutcome,
  nowMs: number,
  settledRunId: string | null = null,
): QualificationPhysicalRun[] {
  const runner = current.currentPhysicalRunner;
  if (!runner) return current.consumedPhysicalRuns ?? [];
  const evidenceRefs = settledRunId && canBindRunIdToRunner(runner, settledRunId)
    ? uniqueStrings([...runner.evidenceRefs, `checkpoint-run:${settledRunId}`])
    : runner.evidenceRefs;
  return [
    ...(current.consumedPhysicalRuns ?? []),
    { ...runner, evidenceRefs, endedAtMs: nowMs, outcome },
  ].slice(-32);
}

/** A runner may carry at most one run id: bind only when it has none yet, or already has this one. */
function canBindRunIdToRunner(runner: { evidenceRefs?: readonly string[] }, runId: string): boolean {
  const bound = (runner.evidenceRefs ?? []).filter((ref) => ref.startsWith('checkpoint-run:'));
  return bound.length === 0 || bound.includes(`checkpoint-run:${runId}`);
}

/**
 * WI-10003212 — the run id a transition that RELEASES the current runner (wait / terminal settle)
 * may store on the attempt, plus the id to bind into the released runner's history.
 *
 * A runner binds its run id at activation (`checkpoint-run:<runId>`). A run that settles BEFORE
 * activating — `skipped-locked`, which emits its verdict before it ever attaches to its
 * reservation — used to store its run id on the attempt while the released runner carried no
 * binding. `storedRunIdIsFromEndedRunner` therefore could not recognise the id as history, every
 * fresh reservation inherited it (`runIdForFreshRunner`), and each later scheduled CLI was refused
 * at activation (`run stored=<skipped run> produced=<own run>`): attempt 075de039 wedged every fire
 * from 04:23Z on 2026-09-26 on run 1977bd22, the 02:23Z fire that lock-skipped behind a manual run.
 * The released runner now takes the binding, and an id no runner can carry is never stored.
 */
function runIdOnRelease(
  current: CheckpointQualificationTransaction,
  inputRunId: string | null | undefined,
): { runId: string | null; bind: string | null } {
  const own = inputRunId?.trim() || null;
  if (!own) return { runId: current.runId, bind: null };
  const runner = current.currentPhysicalRunner;
  if (runner && canBindRunIdToRunner(runner, own)) return { runId: own, bind: own };
  if ((current.consumedPhysicalRuns ?? []).some((run) => runIdBoundToRunner(run, own))) {
    return { runId: own, bind: null };
  }
  return { runId: current.runId, bind: null };
}

/**
 * WI-10002602 — a run id belongs to the physical runner that bound it. A runner that starts
 * records `checkpoint-run:<runId>` in its evidence (activateScheduledCheckpointRunner), so this
 * evidence is how an id is traced back to its runner. A transition that releases a runner
 * (wait, displacement) keeps `runId` on the attempt as history. Before this helper, the next
 * runner INHERITED that id: its CLI activated with its own run id, the stale id did not match,
 * and activation refused with `conflict`. Every later fire re-joined the same attempt, so the
 * gate wedged permanently (attempt 984d0934: 08:23Z fire refused, stored=abf32d6d, which was
 * bound to the runner consumed at 06:38Z).
 */
function runIdBoundToRunner(
  runner: { evidenceRefs?: readonly string[] } | null | undefined,
  runId: string,
): boolean {
  return Boolean(runner?.evidenceRefs?.includes(`checkpoint-run:${runId}`));
}

/**
 * WI-10003215 — the verdict came from the attempt's own incumbent physical run: the producer's run
 * id is the stored run id AND the live runner bound it at activation (`checkpoint-run:<runId>`).
 * Run ids are unique per CLI invocation, and requiring the incumbent binding (not merely a stored
 * id, which can be inherited history) rules out a late verdict from an earlier run.
 */
function verdictIsFromIncumbentRun(current: CheckpointQualificationTransaction, runId: string | null): boolean {
  return Boolean(runId && current.runId === runId && runIdBoundToRunner(current.currentPhysicalRunner, runId));
}

/**
 * The candidate half of the settle identity check. Two cases name the same judged code even though
 * the stored and produced candidates differ:
 *
 * - WI-10002602: a repair-head verification is RESERVED against the head it verifies (the launcher
 *   pins queue.repairHead as the run's candidate), but its verdict names the FROZEN candidate as
 *   `candidate` and the verified head as `repairHead`. A stored candidate equal to the verdict's
 *   repair head is the same identity. Comparing only `candidate` returned conflict for every
 *   repair-head verdict, and the attempt wedged every later scheduled fire.
 * - WI-10003215: the incumbent run re-resolved its target after reservation — a scheduled
 *   reservation stores the quiet-cut tip, then the run resumes the frozen lineage and its own
 *   lockfile convergence advances repairHead mid-run. Its verdict names the sha it actually judged
 *   (and, once promotion retires the queue, no repair head). Refusing it DISCARDED a green that had
 *   already promoted main, withheld every release:green wake, and left the attempt `running` under
 *   a dead runner (attempt 1cf6ef83, run e787243b, 2026-09-26).
 */
function candidateIdentityConflicts(
  current: CheckpointQualificationTransaction,
  produced: { candidate: string | null; repairHead: string | null; runId: string | null },
): boolean {
  if (!current.candidate || !produced.candidate || current.candidate === produced.candidate) return false;
  if (current.candidate === produced.repairHead) return false;
  return !verdictIsFromIncumbentRun(current, produced.runId);
}

/** The stored run id is history: it is bound to a consumed runner, not the incumbent. */
function storedRunIdIsFromEndedRunner(current: CheckpointQualificationTransaction): boolean {
  const runId = current.runId;
  if (!runId) return false;
  if (runIdBoundToRunner(current.currentPhysicalRunner, runId)) return false;
  return (current.consumedPhysicalRuns ?? []).some((run) => runIdBoundToRunner(run, runId));
}

/**
 * WI-10003212 recovery — the stored run id cannot belong to the incumbent's CLI: the incumbent is a
 * placeholder no CLI ever attached to (no pid, still `launching`, no `checkpoint-run:` binding),
 * so the id was inherited, not assigned. The scheduled pre-spawn reservation never carries a run
 * id, so its first attach is the only claimant. Needed for rows wedged BEFORE `runIdOnRelease`
 * existed, whose orphaned id has aged out of the 32-run history (oddsmith attempt de070acc: run
 * 8e9dbf64 lock-skipped at 2026-09-25T16:01Z and wedged every later fire). An attached runner keeps
 * single flight: a second, different run id against it still conflicts.
 */
function storedRunIdOrphanedAtUnattachedRunner(current: CheckpointQualificationTransaction): boolean {
  const runner = current.currentPhysicalRunner;
  if (!runner || !current.runId) return false;
  if (runner.pid != null || runner.pidIdentity || runner.phase !== 'launching') return false;
  return !(runner.evidenceRefs ?? []).some((ref) => ref.startsWith('checkpoint-run:'));
}

/** The run id a FRESH runner reservation carries: its own, never one bound to another runner. */
function runIdForFreshRunner(current: CheckpointQualificationTransaction, inputRunId: string | null | undefined): string | null {
  const own = inputRunId?.trim() || null;
  if (own) return own;
  if (!current.runId) return null;
  if (runIdBoundToRunner(current.currentPhysicalRunner, current.runId)) return null;
  if (storedRunIdIsFromEndedRunner(current)) return null;
  return current.runId;
}

export function qualificationPhaseDurations(
  current: CheckpointQualificationTransaction,
  nowMs = Date.now(),
): Partial<Record<QualificationPhase, number>> {
  return {
    ...(current.phaseDurationsMs ?? {}),
    [current.phase]:
      ((current.phaseDurationsMs ?? {})[current.phase] ?? 0) +
      Math.max(0, nowMs - (current.phaseEnteredAtMs ?? current.updatedAtMs)),
  };
}

export function projectCheckpointQualificationState(
  raw: unknown,
  nowMs = Date.now(),
  runnerLiveness: RunnerLiveness = 'unknown',
): CheckpointQualificationState {
  const owner = { kind: 'routine' as const, id: 'system:green-checkpoint' as const };
  const emptyClocks = {
    lastScheduledAtMs: null,
    lastStartedAtMs: null,
    lastProgressAtMs: null,
    lastTerminalVerdictAtMs: null,
  };
  const emptyAges = { attempt: null, scheduled: null, started: null, progress: null, terminal: null };
  if (raw == null) {
    return {
      status: 'none',
      attemptId: null,
      candidate: null,
      phase: null,
      outcome: null,
      owner,
      lease: null,
      runnerHealth: { state: 'none', liveness: 'unknown', phase: null, progressAgeMs: null },
      blockers: [],
      phaseDurationsMs: {},
      clocks: emptyClocks,
      agesMs: emptyAges,
      consumedPhysicalRuns: [],
      unknown: null,
      eligibilitySnapshot: null,
      safeNextAction: {
        code: 'read-release-control',
        reason:
          'no logical qualification attempt exists; read current serializer/manual-run authority before starting one',
        waitEvents: [],
      },
    };
  }
  const transaction = parseCheckpointQualificationTransaction(raw);
  if (!transaction) {
    return {
      status: 'unreadable',
      attemptId: null,
      candidate: null,
      phase: null,
      outcome: null,
      owner,
      lease: null,
      runnerHealth: { state: 'none', liveness: 'unknown', phase: null, progressAgeMs: null },
      blockers: [],
      phaseDurationsMs: {},
      clocks: emptyClocks,
      agesMs: emptyAges,
      consumedPhysicalRuns: [],
      eligibilitySnapshot: null,
      safeNextAction: {
        code: 'read-release-control',
        reason: 'qualification metadata is malformed; repair the durable record before launching',
        waitEvents: [],
      },
      unknown: { code: 'resolver-failed', detail: 'qualification transaction metadata is malformed' },
    };
  }
  const runner = transaction.currentPhysicalRunner;
  const age = (at: number | undefined): number | null =>
    at === undefined ? null : Math.max(0, nowMs - at);
  const lease = runner
    ? {
        holder: runner.id,
        acquiredAtMs: runner.reservedAtMs,
        expiresAtMs: runner.leaseExpiresAtMs ?? runner.reservedAtMs,
        expired: nowMs >= (runner.leaseExpiresAtMs ?? runner.reservedAtMs),
      }
    : null;
  const progressAgeMs = runner
    ? Math.max(0, nowMs - (runner.heartbeatAtMs ?? transaction.lastProgressAtMs ?? runner.reservedAtMs))
    : null;
  const runnerHealth: CheckpointQualificationState['runnerHealth'] = {
    state: !runner ? 'none' : runnerLiveness === 'dead' ? 'dead'
      : progressAgeMs != null && progressAgeMs > QUALIFICATION_PROGRESS_STALE_MS ? 'stalled' : 'progressing',
    liveness: runner ? runnerLiveness : 'unknown',
    phase: runner?.phase ?? null,
    progressAgeMs,
  };
  const waitEvents = uniqueStrings(transaction.blockers.flatMap((blocker) => blocker.clearEvents));
  let safeNextAction: QualificationSafeNextAction;
  if (transaction.outcome.kind === 'green') {
    safeNextAction = {
      code: 'read-release-control',
      reason: 'qualification is green; read promotion/deploy authority before acting',
      waitEvents: [],
    };
  } else if (transaction.outcome.kind === 'red') {
    safeNextAction = {
      code: 'repair-code',
      reason: 'a real red is terminal for this logical attempt; repair code before starting a successor',
      waitEvents: [],
    };
  } else if (transaction.outcome.kind === 'code-inconclusive') {
    safeNextAction = {
      code: 'inspect-terminal-evidence',
      reason: 'the terminal code outcome is inconclusive; inspect evidence before a successor',
      waitEvents: [],
    };
  } else if (runner && runnerLiveness === 'dead') {
    safeNextAction = {
      code: 'recover-expired-runner',
      reason: 'the exact physical runner was proved dead without a terminal result',
      waitEvents: [],
    };
  } else if (runner && (lease?.expired || runnerHealth.state === 'stalled')) {
    safeNextAction = {
      code: 'inspect-runner-liveness',
      reason: 'the runner missed progress or its deadline; preserve single flight until exact process liveness is proved',
      waitEvents: [],
    };
  } else if (runner) {
    safeNextAction = { code: 'await-current-run', reason: 'one physical runner owns the live lease', waitEvents: [] };
  } else if (transaction.eligibilitySnapshot) {
    // The snapshot describes request-time preflight only. A physical runner's lease is
    // action-time authority and must win over a stale snapshot, so this branch is reached
    // only when the transaction has no current runner.
    safeNextAction = transaction.eligibilitySnapshot.safeNextAction;
  } else if (transaction.phase === 'waiting') {
    safeNextAction = {
      code: 'await-blocker-events',
      reason: 'pre-suite infrastructure blocked this attempt; resume it after the named events clear',
      waitEvents,
    };
  } else {
    safeNextAction = {
      code: 'launch-physical-run',
      reason: 'the logical attempt is ready and has no live physical runner',
      waitEvents: [],
    };
  }
  return {
    status: 'present',
    attemptId: transaction.attemptId,
    candidate: transaction.candidate,
    phase: transaction.phase,
    outcome: transaction.outcome,
    owner,
    lease,
    runnerHealth,
    blockers: transaction.blockers,
    phaseDurationsMs: qualificationPhaseDurations(transaction, nowMs),
    clocks: {
      lastScheduledAtMs: transaction.lastScheduledAtMs ?? null,
      lastStartedAtMs: transaction.lastStartedAtMs ?? null,
      lastProgressAtMs: transaction.lastProgressAtMs ?? null,
      lastTerminalVerdictAtMs: transaction.lastTerminalVerdictAtMs ?? null,
    },
    agesMs: {
      attempt: age(transaction.createdAtMs),
      scheduled: age(transaction.lastScheduledAtMs),
      started: age(transaction.lastStartedAtMs),
      progress: age(transaction.lastProgressAtMs),
      terminal: age(transaction.lastTerminalVerdictAtMs),
    },
    consumedPhysicalRuns: transaction.consumedPhysicalRuns ?? [],
    eligibilitySnapshot: transaction.eligibilitySnapshot ?? null,
    safeNextAction,
    unknown: null,
  };
}

/**
 * A waiting/running logical attempt survives candidate movement. The caller intent is the
 * required ancestor plus the declared-path policy; the candidate is a physical-run snapshot.
 */
export function qualificationIntentMatches(
  current: CheckpointQualificationTransaction,
  input: Pick<BeginQualificationInput, 'requiredAncestorSha' | 'declaredPaths'>,
): boolean {
  if (isTerminalQualificationOutcome(current.outcome)) return false;
  return qualificationRequestPolicyMatches(current, input);
}

function qualificationRequestPolicyMatches(
  current: CheckpointQualificationTransaction,
  input: Pick<BeginQualificationInput, 'requiredAncestorSha' | 'declaredPaths'>,
): boolean {
  return (
    current.requiredAncestorSha === (input.requiredAncestorSha?.trim() || null) &&
    sameStrings(current.candidatePolicy.declaredPaths, input.declaredPaths ?? [])
  );
}

/**
 * The sha a suite would judge for a stored frozen repair queue: the advanced `repairHead` when
 * one exists, else the frozen `candidate`. Deliberately a lenient structural read (not the full
 * queue parser): the identity of a logical attempt must be derivable from a legacy or partially
 * populated row too, and the policy read that decides whether a suite RUNS happens later.
 */
export function frozenRepairQueueVerificationTarget(rawRepairQueue: unknown): string | null {
  if (!rawRepairQueue || typeof rawRepairQueue !== 'object' || Array.isArray(rawRepairQueue)) return null;
  const row = rawRepairQueue as Record<string, unknown>;
  const pick = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
  return pick(row.repairHead) ?? pick(row.candidate);
}

/**
 * EI-22931381517977345: the logical attempt id a begin request actually installs. With a frozen
 * queue present and a caller-supplied `attemptIdForVerificationTarget`, the id is derived from
 * the queue's verification target so an advanced repairHead is a NEW logical attempt after a
 * terminal predecessor; otherwise the caller's `attemptId` stands.
 */
export function resolveQualificationAttemptId(input: BeginQualificationInput, rawRepairQueue: unknown): string {
  const target = frozenRepairQueueVerificationTarget(rawRepairQueue);
  if (target === null || !input.attemptIdForVerificationTarget) return input.attemptId;
  const derived = input.attemptIdForVerificationTarget(target);
  return typeof derived === 'string' && derived.trim() ? derived.trim() : input.attemptId;
}

export function parseCheckpointQualificationTransaction(value: unknown): CheckpointQualificationTransaction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<CheckpointQualificationTransaction>;
  if (
    row.schemaVersion !== CHECKPOINT_QUALIFICATION_SCHEMA_VERSION ||
    typeof row.attemptId !== 'string' ||
    !row.attemptId ||
    !Number.isFinite(row.createdAtMs) ||
    !Number.isFinite(row.updatedAtMs) ||
    !Number.isInteger(row.waitGeneration) ||
    (row.waitGeneration ?? -1) < 0 ||
    !row.outcome ||
    typeof row.outcome !== 'object' ||
    !['waiting', 'ready', 'running', 'terminal'].includes(String(row.phase)) ||
    !row.candidatePolicy ||
    row.candidatePolicy.kind !== 'quiet-cut' ||
    !Array.isArray(row.candidatePolicy.declaredPaths) ||
    !Array.isArray(row.blockers) ||
    !Array.isArray(row.evidenceRefs) ||
    (row.repairHead != null && (typeof row.repairHead !== 'string' || !row.repairHead.trim())) ||
    (row.pendingRepairHead != null && (typeof row.pendingRepairHead !== 'string' || !row.pendingRepairHead.trim())) ||
    (row.runId != null && (typeof row.runId !== 'string' || !row.runId.trim())) ||
    [row.lastScheduledAtMs, row.lastStartedAtMs, row.lastProgressAtMs, row.lastTerminalVerdictAtMs].some(
      (at) => at != null && (!Number.isFinite(at) || at < 0),
    ) ||
    (row.phaseEnteredAtMs != null && !Number.isFinite(row.phaseEnteredAtMs)) ||
    (row.phaseDurationsMs != null &&
      (typeof row.phaseDurationsMs !== 'object' ||
        Array.isArray(row.phaseDurationsMs) ||
        Object.entries(row.phaseDurationsMs).some(
          ([phase, duration]) =>
            !['waiting', 'ready', 'running', 'terminal'].includes(phase) ||
            typeof duration !== 'number' ||
            !Number.isFinite(duration) ||
            duration < 0,
        ))) ||
    (row.consumedPhysicalRuns != null &&
      (!Array.isArray(row.consumedPhysicalRuns) || row.consumedPhysicalRuns.some((run) => !isPhysicalRun(run)))) ||
    (row.eligibilitySnapshot != null && !parseCheckpointEligibilitySnapshot(row.eligibilitySnapshot))
  )
    return null;
  if (!isQualificationOutcome(row.outcome)) return null;
  if (row.preparedSelection !== undefined && (!isPreparedCheckpointSelectionRecord(row.preparedSelection) ||
      row.preparedSelection.attemptId !== row.attemptId)) return null;
  if (row.continuation !== undefined) {
    const work = row.continuation;
    if (!work || work.schemaVersion !== 1 || typeof work.root !== 'string' || !work.root ||
        work.attemptId !== row.attemptId || work.candidate !== row.candidate || work.repairHead !== (row.repairHead ?? null) ||
        typeof work.taskKey !== 'string' || !work.taskKey || !Array.isArray(work.receipts) ||
        !Array.isArray(work.supersededReceipts) || !Array.isArray(work.retryStates) ||
        work.retryStates.some(state => state !== 'fail' && state !== 'infra') || !row.candidate) return null;
    if (work.nativeProducers !== undefined && !validNativeProducerReferences(work.nativeProducers)) return null;
    const expected = { root: work.root, taskKey: work.taskKey, sourceCommit: row.candidate,
      attemptId: row.attemptId, candidate: row.candidate, repairHead: row.repairHead ?? null,
      manifest: work.manifest, retryStates: work.retryStates, runContext: 'schema-check', runnerIdentity: 'schema-check' };
    const validate = (receipts: QualificationWorkReceipt[]) => evaluatePartialTaskContinuation({
      root: work.root, taskKey: work.taskKey, continuation: { schemaVersion: 1, attemptId: row.attemptId,
        candidate: row.candidate, repairHead: row.repairHead ?? null, manifest: work.manifest, receipts },
    }, expected).status === 'ready';
    if (!validate(work.receipts)) return null;
    if (work.lastYield !== undefined && !validQualificationWorkYield(work.lastYield, work)) return null;
    const completions = new Set(work.receipts.map(receipt => receipt.completionId));
    for (const receipt of work.supersededReceipts) {
      if (!validate([receipt]) || completions.has(receipt.completionId)) return null;
      completions.add(receipt.completionId);
    }
  }
  if (
    row.blockers.some(
      (blocker) =>
        !blocker ||
        typeof blocker !== 'object' ||
        typeof blocker.code !== 'string' ||
        !Array.isArray(blocker.clearEvents) ||
        blocker.clearEvents.some((event) => typeof event !== 'string') ||
        !Number.isFinite(blocker.observedAtMs),
    ) ||
    row.evidenceRefs.some((ref) => typeof ref !== 'string') ||
    row.candidatePolicy.declaredPaths.some((declaredPath) => typeof declaredPath !== 'string')
  )
    return null;
  if (
    row.currentPhysicalRunner != null &&
    (typeof row.currentPhysicalRunner !== 'object' ||
      typeof row.currentPhysicalRunner.id !== 'string' ||
      !row.currentPhysicalRunner.id ||
      !Number.isFinite(row.currentPhysicalRunner.reservedAtMs) ||
      (row.currentPhysicalRunner.leaseExpiresAtMs != null &&
        !Number.isFinite(row.currentPhysicalRunner.leaseExpiresAtMs)) ||
      (row.currentPhysicalRunner.pid != null &&
        (!Number.isInteger(row.currentPhysicalRunner.pid) || row.currentPhysicalRunner.pid <= 0)) ||
      (row.currentPhysicalRunner.pidIdentity != null && typeof row.currentPhysicalRunner.pidIdentity !== 'string') ||
      (row.currentPhysicalRunner.childScopeUnits !== undefined &&
        (!Array.isArray(row.currentPhysicalRunner.childScopeUnits) ||
          (row.currentPhysicalRunner.childScopeUnits.length > 0 &&
            (!Number.isSafeInteger(row.currentPhysicalRunner.childScopeReservedAtMs) || row.currentPhysicalRunner.childScopeReservedAtMs! < 0)) ||
          new Set(row.currentPhysicalRunner.childScopeUnits).size !== row.currentPhysicalRunner.childScopeUnits.length ||
          row.currentPhysicalRunner.childScopeUnits.some(unit => typeof unit !== 'string' || !/^pc-[0-9a-z]{4,64}\.scope$/.test(unit)))) ||
      !Array.isArray(row.currentPhysicalRunner.evidenceRefs) ||
      row.currentPhysicalRunner.evidenceRefs.some((ref) => typeof ref !== 'string'))
  )
    return null;
  const phaseEnteredAtMs = Number.isFinite(row.phaseEnteredAtMs) ? row.phaseEnteredAtMs! : row.updatedAtMs!;
  const phaseDurationsMs =
    row.phaseDurationsMs && typeof row.phaseDurationsMs === 'object' && !Array.isArray(row.phaseDurationsMs)
      ? Object.fromEntries(
          Object.entries(row.phaseDurationsMs).filter(
            ([phase, duration]) =>
              ['waiting', 'ready', 'running', 'terminal'].includes(phase) &&
              typeof duration === 'number' &&
              Number.isFinite(duration) &&
              duration >= 0,
          ),
        )
      : {};
  const consumedPhysicalRuns = Array.isArray(row.consumedPhysicalRuns) ? row.consumedPhysicalRuns.slice(-32) : [];
  const currentPhysicalRunner = row.currentPhysicalRunner
    ? {
        ...row.currentPhysicalRunner,
        leaseExpiresAtMs:
          typeof row.currentPhysicalRunner.leaseExpiresAtMs === 'number'
            ? row.currentPhysicalRunner.leaseExpiresAtMs
            : row.currentPhysicalRunner.reservedAtMs,
      }
    : null;
  const eligibilitySnapshot =
    row.eligibilitySnapshot == null ? null : parseCheckpointEligibilitySnapshot(row.eligibilitySnapshot);
  return {
    ...(row as CheckpointQualificationTransaction),
    repairHead: typeof row.repairHead === 'string' ? row.repairHead.trim() : null,
    pendingRepairHead: typeof row.pendingRepairHead === 'string' ? row.pendingRepairHead.trim() : null,
    runId: typeof row.runId === 'string' ? row.runId.trim() : null,
    phaseEnteredAtMs,
    phaseDurationsMs,
    currentPhysicalRunner,
    consumedPhysicalRuns,
    eligibilitySnapshot,
  };
}

export function beginQualificationTransaction(
  current: CheckpointQualificationTransaction | null,
  input: BeginQualificationInput,
): QualificationTransition {
  const nowMs = input.nowMs ?? Date.now();
  const retryableUnownedWait = isRetryableUnownedWait(
    current,
    input.resumeUnownedRepairVerification === true,
    input.incumbentLiveness,
    nowMs,
  );
  const abandoned = isAbandonedQualification(current, input.incumbentLiveness, nowMs);
  if (current?.attemptId === input.attemptId) {
    if (workLineageConflicts(current, input)) return { status: 'conflict', transaction: current,
      refusalReason: 'continuation-lineage-mismatch' };
    if (retryableUnownedWait) {
      const reclaimingDeadRepairRunner = isUnstartedDeadRepairRunner(
        current,
        input.incumbentLiveness,
        nowMs,
      );
      const runnerVanished: QualificationOutcome = { kind: 'pre-suite-no-verdict', reason: 'runner-vanished' };
      return {
        status: 'updated',
        transaction: {
          ...current,
          updatedAtMs: nowMs,
          requiredAncestorSha: input.requiredAncestorSha?.trim() || current.requiredAncestorSha,
          candidatePolicy: {
            ...current.candidatePolicy,
            declaredPaths: uniqueStrings(input.declaredPaths ?? current.candidatePolicy.declaredPaths),
          },
          candidate: input.candidate?.trim() || current.candidate,
          repairHead: input.repairHead?.trim() || current.repairHead,
          pendingRepairHead: null,
          runId: reclaimingDeadRepairRunner ? null : input.runId?.trim() || current.runId,
          lastProgressAtMs: nowMs,
          phase: 'ready',
          phaseEnteredAtMs: nowMs,
          phaseDurationsMs: completedPhaseDurations(current, 'ready', nowMs),
          outcome: { kind: 'pending' },
          blockers: [],
          currentPhysicalRunner: reclaimingDeadRepairRunner ? null : current.currentPhysicalRunner,
          consumedPhysicalRuns: reclaimingDeadRepairRunner
            ? consumedRunner(current, runnerVanished, nowMs)
            : current.consumedPhysicalRuns,
          eligibilitySnapshot: input.resumeUnownedRepairVerification === true ? null : current.eligibilitySnapshot,
          evidenceRefs: uniqueStrings([...current.evidenceRefs, ...(input.evidenceRefs ?? [])]),
        },
      };
    }
    return {
      status: isTerminalQualificationOutcome(current.outcome) ? 'terminal' : 'idempotent',
      transaction: current,
    };
  }
  if (current && !isTerminalQualificationOutcome(current.outcome) && !retryableUnownedWait && !abandoned) {
    return { status: 'conflict', transaction: current };
  }
  const transaction: CheckpointQualificationTransaction = {
    schemaVersion: CHECKPOINT_QUALIFICATION_SCHEMA_VERSION,
    attemptId: input.attemptId,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    requiredAncestorSha: input.requiredAncestorSha?.trim() || null,
    candidatePolicy: {
      kind: 'quiet-cut',
      declaredPaths: uniqueStrings(input.declaredPaths ?? []),
    },
    candidate: input.candidate?.trim() || null,
    repairHead: input.repairHead?.trim() || null,
    pendingRepairHead: null,
    runId: input.runId?.trim() || null,
    phase: 'ready',
    phaseEnteredAtMs: nowMs,
    phaseDurationsMs: {},
    outcome: { kind: 'pending' },
    blockers: [],
    waitGeneration: 0,
    currentPhysicalRunner: null,
    consumedPhysicalRuns: [],
    evidenceRefs: uniqueStrings(input.evidenceRefs ?? []),
    previousAttemptId: current?.attemptId ?? null,
    eligibilitySnapshot: null,
  };
  return { status: 'updated', transaction };
}

/** A colliding scheduler fire joins the active attempt without manufacturing progress. */
export function recordQualificationScheduledFire(
  current: CheckpointQualificationTransaction,
  nowMs = Date.now(),
): QualificationTransition {
  if (isTerminalQualificationOutcome(current.outcome)) return { status: 'terminal', transaction: current };
  if (current.lastScheduledAtMs !== undefined && current.lastScheduledAtMs >= nowMs) {
    return { status: 'idempotent', transaction: current };
  }
  return {
    status: 'updated',
    transaction: { ...current, lastScheduledAtMs: nowMs },
  };
}

/** A scheduler collision is not another run. Unknown owner life fails closed. */
export function classifyScheduledQualificationJoin(
  current: CheckpointQualificationTransaction,
  runnerLiveness: RunnerLiveness,
): 'launch' | 'join' | 'unknown-liveness' {
  if (current.phase !== 'running' || !current.currentPhysicalRunner || isTerminalQualificationOutcome(current.outcome)) {
    return 'launch';
  }
  if (runnerLiveness === 'live') return 'join';
  if (runnerLiveness === 'unknown') return 'unknown-liveness';
  return 'launch';
}

export function recordQualificationEligibilitySnapshot(
  current: CheckpointQualificationTransaction,
  input: {
    attemptId: string;
    snapshot: CheckpointEligibilitySnapshot;
    nowMs?: number;
  },
): QualificationTransition {
  if (current.attemptId !== input.attemptId || input.snapshot.attemptId !== input.attemptId)
    return { status: 'conflict', transaction: current };
  if (isTerminalQualificationOutcome(current.outcome)) {
    return { status: 'terminal', transaction: current };
  }
  const parsed = parseCheckpointEligibilitySnapshot(input.snapshot);
  if (!parsed) return { status: 'conflict', transaction: current };
  if (JSON.stringify(current.eligibilitySnapshot ?? null) === JSON.stringify(parsed)) {
    return { status: 'idempotent', transaction: current };
  }
  const evidenceRefs = uniqueStrings([
    ...current.evidenceRefs,
    ...parsed.predicates.flatMap((predicate) => predicate.evidenceRefs),
  ]);
  return {
    status: 'updated',
    transaction: {
      ...current,
      updatedAtMs: input.nowMs ?? Date.now(),
      eligibilitySnapshot: parsed,
      evidenceRefs,
    },
  };
}

export function waitQualificationTransaction(
  current: CheckpointQualificationTransaction,
  input: {
    attemptId: string;
    reason: PreSuiteNoVerdictReason;
    blockers?: readonly Omit<QualificationBlocker, 'observedAtMs'>[];
    candidate?: string | null;
    repairHead?: string | null;
    runId?: string | null;
    evidenceRefs?: readonly string[];
    nowMs?: number;
  },
): QualificationTransition {
  if (current.attemptId !== input.attemptId) return { status: 'conflict', transaction: current };
  if (current.currentPhysicalRunner?.childScopeUnits?.length)
    return { status: 'conflict', transaction: current, refusalReason: 'child-scope-custody-held' };
  if (workLineageConflicts(current, input)) return { status: 'conflict', transaction: current,
    refusalReason: 'continuation-lineage-mismatch' };
  if (isTerminalQualificationOutcome(current.outcome)) return { status: 'terminal', transaction: current };
  if (
    current.phase === 'waiting' &&
    current.outcome.kind === 'pre-suite-no-verdict' &&
    current.outcome.reason === input.reason &&
    (input.blockers ?? []).length === current.blockers.length &&
    (input.blockers ?? []).every((blocker, index) => {
      const existing = current.blockers[index];
      return (
        existing?.code === blocker.code &&
        existing.detail === blocker.detail &&
        sameStrings(existing.clearEvents, blocker.clearEvents)
      );
    }) &&
    (input.evidenceRefs ?? []).every((ref) => current.evidenceRefs.includes(ref))
  ) {
    return { status: 'idempotent', transaction: current };
  }
  const nowMs = input.nowMs ?? Date.now();
  const outcome = { kind: 'pre-suite-no-verdict' as const, reason: input.reason };
  const released = runIdOnRelease(current, input.runId);
  return {
    status: 'updated',
    transaction: {
      ...current,
      updatedAtMs: nowMs,
      phase: 'waiting',
      phaseEnteredAtMs: current.phase === 'waiting' ? current.phaseEnteredAtMs : nowMs,
      phaseDurationsMs: completedPhaseDurations(current, 'waiting', nowMs),
      outcome,
      candidate: input.candidate?.trim() || current.candidate,
      repairHead: input.repairHead?.trim() || current.repairHead,
      runId: released.runId,
      blockers: (input.blockers ?? []).slice(0, 24).map((blocker) => ({ ...blocker, observedAtMs: nowMs })),
      waitGeneration: current.waitGeneration + 1,
      currentPhysicalRunner: null,
      consumedPhysicalRuns: consumedRunner(current, outcome, nowMs, released.bind),
      evidenceRefs: uniqueStrings([...current.evidenceRefs, ...(input.evidenceRefs ?? [])]),
    },
  };
}

export function reserveQualificationRunner(
  current: CheckpointQualificationTransaction,
  input: {
    attemptId: string;
      runnerId: string;
    runId?: string | null;
    repairHead?: string | null;
    candidate?: string | null;
    evidenceRefs?: readonly string[];
    leaseDurationMs: number;
    unit?: string | null;
    pid?: number | null;
    pidIdentity?: string | null;
    /** false reserves the scheduled launch; true attaches the real CLI process. */
    started?: boolean;
    /**
     * What the caller PROVED about the incumbent runner's process. Default 'unknown' keeps the
     * historical lease-only behaviour, so this can never loosen the lock on its own.
     */
    incumbentLiveness?: RunnerLiveness;
    nowMs?: number;
  },
): QualificationTransition {
  if (current.attemptId !== input.attemptId) {
    return { status: 'conflict', transaction: current, refusalReason: 'attempt-id-mismatch' };
  }
  if (workLineageConflicts(current, input)) return { status: 'conflict', transaction: current,
    refusalReason: 'continuation-lineage-mismatch' };
  if (isTerminalQualificationOutcome(current.outcome)) return { status: 'terminal', transaction: current };
  const nowMs = input.nowMs ?? Date.now();
  const incumbent = current.currentPhysicalRunner;
  if (incumbent?.id === input.runnerId) {
    // Preserve the exact failed invariant. Matching physical ids do not imply that the
    // candidate, logical run or process identity also matches (P-033).
    const refusalReason =
      current.candidate && input.candidate && current.candidate !== input.candidate.trim()
        ? 'candidate-mismatch'
        : current.repairHead && input.repairHead && current.repairHead !== input.repairHead.trim()
          ? 'repair-head-mismatch'
          : current.runId && input.runId && current.runId !== input.runId.trim() &&
            !storedRunIdIsFromEndedRunner(current) && !storedRunIdOrphanedAtUnattachedRunner(current)
            ? 'run-id-mismatch'
            : incumbent.pidIdentity && input.pidIdentity && incumbent.pidIdentity !== input.pidIdentity
              ? 'pid-identity-mismatch'
              : null;
    if (refusalReason) return { status: 'conflict', transaction: current, refusalReason };
    if (input.started !== true && input.pid == null && !input.unit) {
      return { status: 'idempotent', transaction: current };
    }
    const evidenceRefs = uniqueStrings([...incumbent.evidenceRefs, ...(input.evidenceRefs ?? [])]);
    return {
      status: 'updated',
      transaction: {
        ...current,
        updatedAtMs: nowMs,
        candidate: input.candidate?.trim() || current.candidate,
        repairHead: input.repairHead?.trim() || current.repairHead,
        runId: input.runId?.trim() || current.runId,
        lastStartedAtMs: input.started === true ? nowMs : current.lastStartedAtMs,
        lastProgressAtMs: input.started === true ? nowMs : current.lastProgressAtMs,
        currentPhysicalRunner: {
          ...incumbent,
          candidate: input.candidate?.trim() || incumbent.candidate,
          leaseExpiresAtMs: nowMs + Math.max(1, input.leaseDurationMs),
          evidenceRefs,
          unit: input.unit?.trim() || incumbent.unit,
          pid: input.pid ?? incumbent.pid,
          pidIdentity: input.pidIdentity ?? incumbent.pidIdentity,
          heartbeatAtMs: nowMs,
          phase: input.started === true ? 'materializing' : incumbent.phase,
        },
        evidenceRefs: uniqueStrings([...current.evidenceRefs, ...evidenceRefs]),
      },
    };
  }
  // A lease timeout alone cannot prove death. Unknown or live ownership keeps single flight.
  if (incumbent && (input.incumbentLiveness !== 'dead' || launchReservationInGrace(incumbent, nowMs))) {
    return { status: 'conflict', transaction: current, refusalReason: 'runner-held' };
  }
  const evidenceRefs = uniqueStrings(input.evidenceRefs ?? []);
  // Keep the two displacement causes distinct in the history: a lease that ran out is a runner that
  // overran, a reclaimed one is a runner that DIED. Collapsing them would hide exactly the signal
  // that makes a recurring vanish diagnosable.
  const displacedOutcome: QualificationOutcome = {
    kind: 'pre-suite-no-verdict',
    reason: 'runner-vanished',
  };
  const expiredRuns = incumbent
    ? consumedRunner(current, displacedOutcome, nowMs)
    : (current.consumedPhysicalRuns ?? []);
  return {
    status: 'updated',
    transaction: {
      ...current,
      updatedAtMs: nowMs,
      candidate: input.candidate?.trim() || current.candidate,
      repairHead: input.repairHead?.trim() || current.repairHead,
      runId: runIdForFreshRunner(current, input.runId),
      phase: 'running',
      ...(input.started === false ? {} : { lastStartedAtMs: nowMs, lastProgressAtMs: nowMs }),
      phaseEnteredAtMs:
        current.phase === 'running' && !current.currentPhysicalRunner
          ? (current.phaseEnteredAtMs ?? current.updatedAtMs)
          : nowMs,
      phaseDurationsMs: completedPhaseDurations(current, 'running', nowMs),
      outcome: { kind: 'pending' },
      blockers: [],
      currentPhysicalRunner: {
        id: input.runnerId,
        candidate: input.candidate?.trim() || current.candidate,
        reservedAtMs: nowMs,
        leaseExpiresAtMs: nowMs + Math.max(1, input.leaseDurationMs),
        evidenceRefs,
        unit: input.unit?.trim() || null,
        pid: input.pid ?? null,
        pidIdentity: input.pidIdentity ?? null,
        heartbeatAtMs: nowMs,
        phase: input.started === false ? 'launching' : 'materializing',
      },
      consumedPhysicalRuns: expiredRuns,
      evidenceRefs: uniqueStrings([...current.evidenceRefs, ...evidenceRefs]),
    },
  };
}

/** Progress belongs to the exact active runner. A scheduler tick cannot call this transition. */
export function recordQualificationRunnerProgress(
  current: CheckpointQualificationTransaction,
  input: {
    attemptId: string;
    runnerId: string;
    runId: string;
    phase: NonNullable<QualificationPhysicalRunner['phase']>;
    pidIdentity?: string | null;
    nowMs?: number;
  },
): QualificationTransition {
  const runner = current.currentPhysicalRunner;
  if (isTerminalQualificationOutcome(current.outcome)) return { status: 'terminal', transaction: current };
  if (current.attemptId !== input.attemptId || current.phase !== 'running' ||
      !runner || runner.id !== input.runnerId || !current.runId || current.runId !== input.runId ||
      !runner.pidIdentity || !input.pidIdentity || runner.pidIdentity !== input.pidIdentity) {
    return { status: 'conflict', transaction: current };
  }
  const nowMs = input.nowMs ?? Date.now();
  if (nowMs < (runner.heartbeatAtMs ?? 0) ||
      (nowMs === runner.heartbeatAtMs && input.phase === runner.phase)) {
    return { status: 'idempotent', transaction: current };
  }
  return {
    status: 'updated',
    transaction: {
      ...current,
      updatedAtMs: nowMs,
      lastProgressAtMs: nowMs,
      currentPhysicalRunner: {
        ...runner,
        heartbeatAtMs: nowMs,
        phase: input.phase,
        phaseEnteredAtMs: runner.phase === input.phase ? runner.phaseEnteredAtMs ?? nowMs : nowMs,
      },
    },
  };
}

export function classifyQualificationVerdict(input: { reason: string; green?: boolean | null }): QualificationOutcome {
  const normalized = input.reason.trim().replaceAll('_', '-');
  if (input.green === true || ['advanced', 'up-to-date', 'advanced-prefix'].includes(normalized)) {
    return { kind: 'green', reason: input.reason };
  }
  if ((PRE_SUITE_NO_VERDICT_REASONS as readonly string[]).includes(normalized)) {
    return { kind: 'pre-suite-no-verdict', reason: normalized as PreSuiteNoVerdictReason };
  }
  if (input.green === false || normalized === 'not-green') return { kind: 'red', reason: input.reason };
  return { kind: 'code-inconclusive', reason: input.reason || 'unknown' };
}

/** Child custody uses the same row and physical-run fence as durable results.
 * Enrollment must commit before fork; release requires a positive death probe. */
export function recordQualificationChildScope(current: CheckpointQualificationTransaction, input: {
  attemptId: string; runnerId: string; runId: string; pidIdentity: string;
  unit: string; operation: 'enroll' | 'release'; scopeLiveness?: RunnerLiveness; nowMs?: number;
}): QualificationTransition {
  const runner = current.currentPhysicalRunner;
  if (current.phase !== 'running' || isTerminalQualificationOutcome(current.outcome) ||
      current.attemptId !== input.attemptId || !runner || runner.id !== input.runnerId ||
      current.runId !== input.runId || !runner.pidIdentity || runner.pidIdentity !== input.pidIdentity ||
      !/^pc-[0-9a-z]{4,64}\.scope$/.test(input.unit) || !['enroll', 'release'].includes(input.operation))
    return { status: 'conflict', transaction: current, refusalReason: 'child-scope-fence-mismatch' };
  const units = runner.childScopeUnits ?? [];
  if (input.operation === 'release' && input.scopeLiveness !== 'dead')
    return { status: 'conflict', transaction: current, refusalReason: 'child-scope-death-unmeasured' };
  if (units.includes(input.unit) === (input.operation === 'enroll'))
    return { status: 'idempotent', transaction: current };
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < current.updatedAtMs)
    return { status: 'conflict', transaction: current, refusalReason: 'child-scope-stale-clock' };
  return { status: 'updated', transaction: { ...current, updatedAtMs: nowMs,
    currentPhysicalRunner: { ...runner,
      ...(input.operation === 'enroll' ? { childScopeReservedAtMs: nowMs } : {}),
      childScopeUnits: input.operation === 'enroll'
      ? [...units, input.unit] : units.filter(unit => unit !== input.unit) } } };
}

export function settleQualificationTransaction(
  current: CheckpointQualificationTransaction,
  input: {
    attemptId: string;
    reason: string;
    green?: boolean | null;
    candidate?: string | null;
    repairHead?: string | null;
    runId?: string | null;
    evidenceRefs?: readonly string[];
    nowMs?: number;
    [COMPOSED_QUALIFICATION_GREEN]?: true;
  },
): QualificationTransition {
  if (current.attemptId !== input.attemptId) return { status: 'conflict', transaction: current };
  if (workLineageConflicts(current, input)) return { status: 'conflict', transaction: current,
    refusalReason: 'continuation-lineage-mismatch' };
  const candidate = input.candidate?.trim() || null;
  const verifiedRepairHead = input.repairHead?.trim() || null;
  const runId = input.runId?.trim() || null;
  const sameRun = verdictIsFromIncumbentRun(current, runId);
  if (candidateIdentityConflicts(current, { candidate, repairHead: verifiedRepairHead, runId })) {
    return { status: 'conflict', transaction: current };
  }
  if (current.runId && runId && current.runId !== runId && !storedRunIdIsFromEndedRunner(current)) {
    return { status: 'conflict', transaction: current };
  }
  const outcome = classifyQualificationVerdict(input);
  if (current.currentPhysicalRunner?.childScopeUnits?.length)
    return { status: 'conflict', transaction: current, refusalReason: 'child-scope-custody-held' };
  // Only the identical outcome is a replay. A changed run, candidate, or verdict may
  // never turn a terminal red into a green wake under the same logical attempt.
  if (isTerminalQualificationOutcome(current.outcome)) {
    return {
      status: current.outcome.kind === outcome.kind &&
        'reason' in current.outcome && 'reason' in outcome && current.outcome.reason === outcome.reason
        ? 'terminal' : 'conflict',
      transaction: current,
    };
  }
  if (outcome.kind === 'pre-suite-no-verdict') {
    return waitQualificationTransaction(current, {
      attemptId: input.attemptId,
      reason: outcome.reason,
      candidate,
      repairHead: input.repairHead,
      runId,
      evidenceRefs: input.evidenceRefs,
      nowMs: input.nowMs,
    });
  }
  if (current.continuation && outcome.kind === 'green' && input[COMPOSED_QUALIFICATION_GREEN] !== true)
    return { status: 'conflict', transaction: current, refusalReason: 'continuation-composition-required' };
  const nowMs = input.nowMs ?? Date.now();
  const released = runIdOnRelease(current, runId);
  // WI-10003215: when the incumbent run judged the pending admission handoff itself (the gate's
  // in-run convergence moved repairHead and this same run verified the new head), that handoff
  // is consumed here. Leaving it set would hand an already-judged head to the next attempt.
  const judgedPending = sameRun && current.pendingRepairHead != null &&
    (current.pendingRepairHead === candidate || current.pendingRepairHead === verifiedRepairHead);
  if (current.continuation && judgedPending && current.pendingRepairHead !== current.continuation.repairHead)
    return { status: 'conflict', transaction: current, refusalReason: 'continuation-lineage-mismatch' };
  return {
    status: 'updated',
    transaction: {
      ...current,
      updatedAtMs: nowMs,
      phase: 'terminal',
      lastTerminalVerdictAtMs: nowMs,
      phaseEnteredAtMs: nowMs,
      phaseDurationsMs: completedPhaseDurations(current, 'terminal', nowMs),
      outcome,
      candidate: candidate ?? current.candidate,
      repairHead: verifiedRepairHead || (judgedPending ? current.pendingRepairHead ?? null : current.repairHead),
      ...(judgedPending ? { pendingRepairHead: null } : {}),
      // A TERMINAL attempt pins the verdict's own run id even with no runner to bind it to: a
      // terminal attempt refuses every later runner reservation, so the id can never be inherited
      // (the WI-10003212 wedge was a non-terminal wait), and the pin is what makes a different
      // run's replay conflict instead of reading as an idempotent `terminal`.
      runId: runId ?? released.runId,
      blockers: [],
      currentPhysicalRunner: null,
      consumedPhysicalRuns: consumedRunner(current, outcome, nowMs, released.bind),
      evidenceRefs: uniqueStrings([...current.evidenceRefs, ...(input.evidenceRefs ?? [])]),
    },
  };
}

/** Recover only the exact unstarted scheduled runner proved finished by its terminal marker. */
export function recoverQualificationScheduledTerminal(
  current: CheckpointQualificationTransaction,
  input: {
    attemptId: string;
    runnerId: string;
    runId: string;
    reason: string;
    finishedAtMs: number;
    evidenceRefs: readonly string[];
    nowMs?: number;
  },
): QualificationTransition {
  const terminalRef = `checkpoint-terminal:${input.runId}`;
  if (current.attemptId !== input.attemptId || !input.evidenceRefs.includes(terminalRef)) {
    return { status: 'conflict', transaction: current };
  }
  const outcome = classifyQualificationVerdict({ reason: input.reason });
  if (outcome.kind !== 'pre-suite-no-verdict') return { status: 'conflict', transaction: current };
  const recoveredReason = `orphaned-reservation-after-${outcome.reason}`;
  if (isTerminalQualificationOutcome(current.outcome)) {
    return current.outcome.kind === 'code-inconclusive' &&
      current.outcome.reason === recoveredReason && current.evidenceRefs.includes(terminalRef)
      ? { status: 'terminal', transaction: current }
      : { status: 'conflict', transaction: current };
  }
  const runner = current.currentPhysicalRunner;
  if (current.phase !== 'running' || !runner || runner.id !== input.runnerId ||
      runner.pid != null || runner.unit || runner.childScopeUnits?.length || runner.phase !== 'launching' ||
      !runner.evidenceRefs.includes(`gate-fire:${input.runnerId}`) ||
      !Number.isFinite(input.finishedAtMs) || input.finishedAtMs < runner.reservedAtMs) {
    return { status: 'conflict', transaction: current };
  }
  const nowMs = input.nowMs ?? Date.now();
  const recoveredOutcome: QualificationOutcome = { kind: 'code-inconclusive', reason: recoveredReason };
  return {
    status: 'updated',
    transaction: {
      ...current,
      updatedAtMs: nowMs,
      phase: 'terminal',
      lastTerminalVerdictAtMs: nowMs,
      phaseEnteredAtMs: nowMs,
      phaseDurationsMs: completedPhaseDurations(current, 'terminal', nowMs),
      outcome: recoveredOutcome,
      blockers: [],
      currentPhysicalRunner: null,
      consumedPhysicalRuns: consumedRunner(current, recoveredOutcome, nowMs),
      evidenceRefs: uniqueStrings([...current.evidenceRefs, ...input.evidenceRefs]),
    },
  };
}

export interface HistoricalPreSuiteRecoveryInput {
  attemptId: string;
  runId: string;
  candidate: string;
  /** Hash of the COMPLETE archived producer log, never a tail or a summary. */
  logSha256: string;
  logPath: string;
  log: string;
  nowMs?: number;
}

function historicalRecoveryAttemptId(input: HistoricalPreSuiteRecoveryInput): string {
  return createHash('sha256').update(JSON.stringify([
    'historical-pre-suite-recovery-v1', input.attemptId, input.runId, input.candidate, input.logSha256,
  ])).digest('hex').slice(0, 24);
}

/**
 * Recover a historically misclassified dependency preflight by starting a DISTINCT attempt.
 * Terminal verdicts remain immutable. Positive producer evidence must prove that this exact
 * run failed before the checkpoint lock; a missing suite line alone proves nothing.
 */
export function recoverQualificationHistoricalPreSuiteError(
  current: CheckpointQualificationTransaction,
  input: HistoricalPreSuiteRecoveryInput,
): QualificationTransition {
  const conflict = (refusalReason: string): QualificationTransition => ({
    status: 'conflict', transaction: current, refusalReason,
  });
  if (!input.attemptId || !input.runId || !input.candidate || !input.logPath.trim() ||
      !/^[a-f0-9]{64}$/.test(input.logSha256)) return conflict('archive-input-invalid');
  if (createHash('sha256').update(input.log).digest('hex') !== input.logSha256) return conflict('archive-hash-mismatch');
  const lines = input.log.split(/\r?\n/).filter(line => !isFixtureLogLine(line));
  const markerLines = lines.filter(line => line.trimStart().startsWith(GREEN_CHECKPOINT_RESULT_MARKER));
  if (markerLines.length !== 1) return conflict('archive-result-count');
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(markerLines[0].trimStart().slice(GREEN_CHECKPOINT_RESULT_MARKER.length).trim());
  } catch { return conflict('archive-result-json'); }
  if (!result || result.runId !== input.runId || result.candidate !== input.candidate ||
      result.reason !== 'error' || result.green !== null || result.advanced !== false ||
      result.crashed !== true || result.recorded !== true) return conflict('archive-result-mismatch');
  // Fixture lines are already filtered out above, so this matches the PRODUCTION tag — derived from
  // its one definition (WI-37605 guard), never re-typed, so it cannot drift from the emitter.
  const prelock = lines.findIndex(line => line.startsWith(`${ORCHESTRATOR_STDOUT_TAG} FAILED before checkpoint lock:`));
  const marker = lines.indexOf(markerLines[0]);
  if (prelock < 0 || prelock >= marker ||
      !lines[prelock].includes('dependency-generation.sh') ||
      !dependencyGenerationInfraCode(null, lines.slice(prelock, marker).join('\n'))) return conflict('archive-prelock-unproven');
  if (lines.some(line => /checkpointing candidate|full suite output|TEST_FILE_RESULT|phase[=:]suite|suite (?:started|round)|running (?:affected|full) (?:test|suite)/i.test(line))) {
    return conflict('archive-suite-evidence');
  }
  const attemptId = historicalRecoveryAttemptId(input);
  const proofRef = `historical-pre-suite-recovery:${input.attemptId}:${input.runId}:${input.logSha256}`;
  if (current.attemptId === attemptId && current.previousAttemptId === input.attemptId &&
      current.evidenceRefs.includes(proofRef)) {
    return { status: 'idempotent', transaction: current };
  }
  if (current.attemptId !== input.attemptId) return conflict('predecessor-attempt-mismatch');
  if (current.runId !== input.runId) return conflict('predecessor-run-mismatch');
  if (current.candidate !== input.candidate) return conflict('predecessor-candidate-mismatch');
  if (current.phase !== 'terminal' ||
      current.outcome.kind !== 'code-inconclusive' || current.outcome.reason !== 'error' ||
      current.currentPhysicalRunner !== null || current.pendingRepairHead) return conflict('predecessor-not-recoverable');
  if ((current.consumedPhysicalRuns ?? []).some(run =>
    run.phase === 'suite' || run.phase === 'isolating' || run.phase === 'delivering' || run.phase === 'finalizing' ||
    (run.outcome.kind !== 'pre-suite-no-verdict' &&
      !(run.id === input.runId && run.candidate === input.candidate &&
        run.outcome.kind === 'code-inconclusive' && run.outcome.reason === 'error')))) return conflict('consumed-run-not-pre-suite');
  return beginQualificationTransaction(current, {
    attemptId,
    requiredAncestorSha: current.requiredAncestorSha,
    declaredPaths: current.candidatePolicy.declaredPaths,
    candidate: current.candidate,
    repairHead: current.repairHead,
    evidenceRefs: [...current.evidenceRefs, proofRef, `archived-log:${input.logPath}`, `log-sha256:${input.logSha256}`],
    nowMs: input.nowMs,
  });
}

/**
 * WI-10002454 (b): name the measurements behind a `settleQualificationTransaction` conflict —
 * each identity the producer carried that disagrees with the stored transaction, as
 * `<field> stored=<x> produced=<y>`. Mirrors the three conflict predicates above (attempt,
 * candidate, run). Unlike the settle, it reports EVERY mismatch, not just the first.
 * An EMPTY result is itself a finding: the conflict did not come from an identity
 * mismatch but from the store-level CAS (a concurrent writer changed the row between read and
 * update). Callers must say so rather than print nothing.
 */
export function describeQualificationSettleConflict(
  stored: CheckpointQualificationTransaction,
  produced: { attemptId: string; candidate?: string | null; repairHead?: string | null; runId?: string | null },
): string[] {
  const mismatches: string[] = [];
  if (stored.attemptId !== produced.attemptId) {
    mismatches.push(`attempt stored=${stored.attemptId} produced=${produced.attemptId}`);
  }
  const candidate = produced.candidate?.trim() || null;
  const runId = produced.runId?.trim() || null;
  if (candidateIdentityConflicts(stored, { candidate, repairHead: produced.repairHead?.trim() || null, runId })) {
    mismatches.push(`candidate stored=${stored.candidate} produced=${candidate}`);
  }
  if (stored.runId && runId && stored.runId !== runId) {
    mismatches.push(`run stored=${stored.runId} produced=${runId}`);
  }
  return mismatches;
}

/**
 * Deliberately cancel one known physical runner without turning an ordinary external
 * SIGTERM into a retryable pre-suite wait. The caller must name both identities that
 * make the destructive action safe: the logical attempt and the systemd unit recorded
 * for its current runner. A terminal `code-inconclusive` result preserves the repair
 * queue and prevents the producer's later signal/result callback from settling a newer
 * attempt by accident.
 */
export function cancelQualificationTransaction(
  current: CheckpointQualificationTransaction,
  input: CancelQualificationInput,
): QualificationTransition {
  if (current.attemptId !== input.attemptId) return { status: 'conflict', transaction: current };
  if (current.currentPhysicalRunner?.childScopeUnits?.length)
    return { status: 'conflict', transaction: current, refusalReason: 'child-scope-custody-held' };
  if (isTerminalQualificationOutcome(current.outcome)) return { status: 'terminal', transaction: current };
  const runner = current.currentPhysicalRunner;
  if (!runner || runner.unit !== input.unit.trim()) return { status: 'conflict', transaction: current };
  const nowMs = input.nowMs ?? Date.now();
  const outcome: QualificationOutcome = {
    kind: 'code-inconclusive',
    reason: input.reason?.trim() || 'cancelled',
  };
  return {
    status: 'updated',
    transaction: {
      ...current,
      updatedAtMs: nowMs,
      phase: 'terminal',
      lastTerminalVerdictAtMs: nowMs,
      phaseEnteredAtMs: nowMs,
      phaseDurationsMs: completedPhaseDurations(current, 'terminal', nowMs),
      outcome,
      blockers: [],
      currentPhysicalRunner: null,
      consumedPhysicalRuns: consumedRunner(current, outcome, nowMs),
      evidenceRefs: uniqueStrings([...current.evidenceRefs, ...(input.evidenceRefs ?? []), `cancelled:${runner.id}`]),
    },
  };
}

export type RepairQueueReconciliation = {
  status: 'none' | 'preserved' | 'blocked';
  reason:
    | 'no-queue'
    | 'queue-malformed'
    | 'queue-origin-mismatch'
    | 'queue-origin-unknown'
    | 'queue-not-safe-unstarted'
    | 'matching-untested-repair-head'
    | 'promoted-awaiting-staging-bridge'
    | 'awaiting-unassigned-fixer'
    | 'awaiting-dead-fixer'
    | 'exact-safe-unstarted'
    | 'blocked-hold-handoff'
    | 'cas-miss';
  /**
   * WI-6554700010015312: which safety fence refused a known-lineage queue. Present only on a
   * `queue-not-safe-unstarted` refusal so the refusal names the concrete competing owner or
   * missing proof instead of reading as "this shape is not on the list".
   */
  fence?: RepairQueueFence;
  predecessorAttemptId: string;
  successorAttemptId: string;
  candidate?: string;
};

/**
 * The only reasons a queue whose provenance links to the terminal lineage is withheld from the
 * successor. Each names a concrete hazard; none is "unrecognized shape".
 */
export type RepairQueueFence =
  /** An unexpired dispatch reservation: a fixer launch is in flight right now. */
  | 'dispatch-reserved'
  /** A fixer is assigned and its death is not proven (live, or liveness unmeasured). */
  | 'fixer-not-proven-dead'
  /** ready-to-verify whose head owes no verification pass: a run would decline to judge it. */
  | 'head-already-judged'
  /** ready-to-promote without green proof at this head (a red or non-terminal predecessor). */
  | 'promotion-unproven'
  /** ready-to-test whose moved repairHead is not explained by an exact pending admission. */
  | 'admission-unproven'
  /** A field combination no transition produces (e.g. ready-to-test with attempts > 0). */
  | 'queue-integrity';

export type StoredQualificationMutation =
  | (QualificationTransition & { repairQueueReconciliation?: RepairQueueReconciliation })
  | { status: 'missing' | 'unreadable'; error?: string };

export type StoredQualificationCancellation =
  | StoredQualificationMutation
  | { status: 'stop-failed'; transaction: CheckpointQualificationTransaction; error: string };

/**
 * A successor inherits the predecessor's exact frozen queue. An idle unstarted
 * queue is still the selected candidate, never disposable runner bookkeeping.
 * Unrelated, malformed or concurrently owned queues remain blocked fail-closed.
 *
 * WI-6554700010015312 — GENERAL HANDOFF, not a shape allowlist. Before this, the function
 * preserved only an enumerated list of queue shapes and refused every other one with
 * `queue-not-safe-unstarted`. Each legitimate lifecycle state that was missing from the list
 * deadlocked the gate: the refused successor is the ONLY run that can act on the queue, so
 * the refusal repeated every tick (EI-24610407938327281 ready-to-promote, WI-10000288
 * ready-to-verify, WI-10007398 unassigned awaiting-fixer, WI-10007408 dead awaiting-fixer,
 * WI-6554700010018169 unmeasured retest; papercusp measured 42 verdictless skips on
 * 2026-10-23..25 alone). `decideFrozenCandidateRepairQueue` already chooses the correct
 * action for every phase, so the successor is handed the queue UNLESS:
 *   1. provenance does not link it to this lineage (`queue-origin-mismatch` /
 *      `queue-origin-unknown`), or
 *   2. a named fence holds (`queue-not-safe-unstarted` + `fence`): a competing owner is live
 *      (dispatch reservation, an assigned fixer not proven dead) or the proof the next run's
 *      decision depends on is missing (head already judged, promotion unproven, admission
 *      unproven, impossible field combination).
 * The phase switch is exhaustive, so adding a phase is a compile error here rather than a
 * silent new refusal.
 */
export function assessTerminalRepairQueueReconciliation(
  current: CheckpointQualificationTransaction,
  successor: BeginQualificationInput,
  rawRepairQueue: unknown,
): RepairQueueReconciliation {
  const base = {
    predecessorAttemptId: current.attemptId,
    successorAttemptId: successor.attemptId,
  };
  if (rawRepairQueue == null) return { status: 'none', reason: 'no-queue', ...base };
  const queue = parseFrozenCandidateRepairQueue(rawRepairQueue);
  if (!queue) return { status: 'blocked', reason: 'queue-malformed', ...base };
  // A NULL origin is an ABSENCE of provenance, not evidence of a competing owner: schema v3
  // permits a queue created without a stamped `qualificationAttemptId` (see WI-41667), and such
  // a queue is well-formed, not corrupt. Only a KNOWN, DIFFERENT attemptId is a genuine mismatch
  // (someone else's queue) that must stay fail-closed forever. A null origin instead falls
  // through to the same phase/attempts/fixer safety checks below, so it is judged on its actual
  // state rather than being permanently blocked (WI-2142947).
  const originUnknown = queue.qualificationAttemptId === null;
  const originMatchesTerminal = queue.qualificationAttemptId === current.attemptId;
  // A logical qualification can inherit the queue selected by its immediate predecessor.
  // If that inherited run then terminates inconclusively, the queue still names the earlier
  // attempt while `previousAttemptId` is the durable link from the terminal transaction back
  // to it. It is the same single lineage one hop back, so it carries provenance in every phase.
  const originMatchesImmediatePredecessor =
    current.previousAttemptId !== null && queue.qualificationAttemptId === current.previousAttemptId;
  // A legacy/null-origin queue can still be handed forward safely when the caller independently
  // pins the exact never-judged repairHead. The required-ancestor equality supplies the missing
  // provenance link without weakening takeover safety: absent/mismatched pins remain blocked.
  const unknownOriginPinnedToRepairHead = originUnknown && successor.requiredAncestorSha?.trim() === queue.repairHead;
  const knownLineage = originMatchesTerminal || originMatchesImmediatePredecessor;
  const lineage = knownLineage || unknownOriginPinnedToRepairHead;
  if (!originUnknown && !knownLineage) {
    return { status: 'blocked', reason: 'queue-origin-mismatch', candidate: queue.candidate, ...base };
  }
  const originUnknownRefusal: RepairQueueReconciliation = {
    status: 'blocked',
    reason: 'queue-origin-unknown',
    candidate: queue.candidate,
    ...base,
  };
  // An unpinned null-origin queue is handed forward only in its one self-evidently idle state:
  // a never-judged candidate nobody has touched. Every other state needs a provenance link.
  const idleUnstartedCandidate =
    queue.phase === 'ready-to-test' &&
    queue.repairHead === queue.candidate &&
    queue.attempts === 0 &&
    queue.fixerSpawnId === null &&
    queue.dispatchReservation == null;
  if (!lineage && !idleUnstartedCandidate) return originUnknownRefusal;

  const fenced = (fence: RepairQueueFence): RepairQueueReconciliation => ({
    status: 'blocked',
    reason: 'queue-not-safe-unstarted',
    fence,
    candidate: queue.candidate,
    ...base,
  });
  const preserved = (reason: RepairQueueReconciliation['reason']): RepairQueueReconciliation => ({
    status: 'preserved',
    reason,
    candidate: queue.candidate,
    ...base,
  });

  // An unexpired dispatch reservation means a launch is in flight in EVERY phase. An expired one
  // is abandoned: `decideFrozenCandidateRepairQueue` already treats it as dispatchable, so
  // refusing on it would recreate the deadlock one field over. Fail closed without a clock: an
  // unmeasurable expiry counts as live.
  const reservationLive =
    queue.dispatchReservation != null &&
    !(typeof successor.nowMs === 'number' && queue.dispatchReservation.expiresAtMs <= successor.nowMs);
  if (reservationLive) return fenced('dispatch-reserved');

  // `fixerSpawnId` is historical provenance once the queue reaches ready-to-verify or
  // ready-to-promote: markFrozenRepairFixerFinished keeps the completed spawn id so the lineage
  // can explain who produced the head. In the other phases an assigned fixer may still be
  // working, so only CONFIRMED death ('dead' = releaseFixerSpawnAlive === false, the exact
  // predicate `recover-dead-fixer` acts on) releases it. Live and unknown liveness stay fenced:
  // a live fixer advances the queue itself by admission, and an unmeasurable one must not be raced.
  const assignedFixerProvablyDead =
    queue.fixerSpawnId !== null &&
    successor.assignedFixerLiveness?.spawnId === queue.fixerSpawnId &&
    successor.assignedFixerLiveness.liveness === 'dead';

  switch (queue.phase) {
    case 'ready-to-test': {
      // No transition assigns a fixer or counts an attempt before the candidate is judged.
      if (queue.attempts !== 0 || queue.fixerSpawnId !== null) return fenced('queue-integrity');
      if (queue.repairHead === queue.candidate) return preserved('exact-safe-unstarted');
      // Admission deliberately retains ready-to-test until the immutable candidate is judged.
      // Preserve both heads only with exact same-lineage admission and pending-retest proof;
      // the ordinary queue policy still tests the candidate first.
      if (!knownLineage) return originUnknownRefusal;
      const latestAdmission = queue.admissions?.at(-1);
      const admittedRepairPending =
        latestAdmission?.toRepairHead === queue.repairHead &&
        queue.retestRequested?.candidate === queue.candidate &&
        queue.retestRequested.repairHead === queue.repairHead &&
        queue.retestRequested.requestedAtMs === latestAdmission.atMs;
      return admittedRepairPending ? preserved('exact-safe-unstarted') : fenced('admission-unproven');
    }
    case 'ready-to-verify':
      // WI-6554700010018169: "owes" rather than "awaits" — a same-head unmeasured retest
      // (WI-10003213) is a pending verification too. A head that owes nothing would be declined
      // by the run's own unchanged-since-verdict short-circuit, so handing it forward trades one
      // verdictless outcome for another; refuse with the fence that names that state instead.
      return frozenRepairHeadOwesVerification(queue)
        ? preserved('matching-untested-repair-head')
        : fenced('head-already-judged');
    case 'awaiting-fixer':
      // WI-10007398 / WI-10007408: only the successor's `dispatch-fixer` / `recover-dead-fixer`
      // decision moves this row, so a refusal here closes the only automatic exit.
      if (queue.fixerSpawnId === null) return preserved('awaiting-unassigned-fixer');
      return assignedFixerProvablyDead ? preserved('awaiting-dead-fixer') : fenced('fixer-not-proven-dead');
    case 'ready-to-promote':
      // EI-24610407938327281: main already advanced to repairHead but the post-promotion staging
      // bridge did not complete; only a gate RUN retries it. The green proof the phase carries
      // must survive the predecessor: a green at THIS head, or an inconclusive attempt that
      // recorded no verdict and so cannot have invalidated it. A RED terminal fails closed, and
      // a null-origin row has no lineage to carry that proof.
      if (!knownLineage) return originUnknownRefusal;
      return current.phase === 'terminal' &&
        ((current.outcome.kind === 'green' && queue.repairHead === current.candidate) ||
          current.outcome.kind === 'code-inconclusive')
        ? preserved('promoted-awaiting-staging-bridge')
        : fenced('promotion-unproven');
    case 'blocked':
      // D-005: a blocked queue re-decides to the same `hold-exhausted` every tick and only an
      // admission (or an owner retire) moves it. Handing it forward lets the successor run hold
      // and age-escalate visibly; refusing it turned the hold into a silent
      // skipped-qualification-conflict on every tick. (A NULL-origin blocked row, as on
      // email/portal/sidestage 2026-10-01..27, still stops above at queue-origin-unknown: its
      // remedy is a requiredAncestorSha pin or an owner retire, not this branch.)
      // markFrozenRepairExhausted clears the fixer, so an assigned one here is anomalous.
      if (queue.fixerSpawnId !== null && !assignedFixerProvablyDead) return fenced('fixer-not-proven-dead');
      return preserved('blocked-hold-handoff');
    default: {
      const unhandled: never = queue.phase;
      void unhandled;
      return fenced('queue-integrity');
    }
  }
}

/** What the locked routine row held beside the transaction when a mutation was decided. */
type StoredQualificationRowContext = {
  /** `metadata.repair_queue` exactly as stored (null when no frozen queue exists). */
  rawRepairQueue: unknown;
};

type StoredQualificationMutationOptions = {
  /**
   * Reconcile the predecessor's exact safe queue in the SAME locked row update that
   * installs a distinct successor qualification. A function form receives the locked row's
   * context so the successor's attempt id can be derived from the queue it will verify.
   */
  successorInput?: BeginQualificationInput | ((context: StoredQualificationRowContext) => BeginQualificationInput);
  /** A terminal pipeline result committed with the exact qualification transition. */
  terminalEvent?: { status: string; detail: Record<string, unknown> };
  /** Preserve the predecessor snapshot atomically with an evidence-backed successor. */
  historicalRecovery?: HistoricalPreSuiteRecoveryInput;
};

// Qualification writes must ride through short PostgreSQL restart windows while
// retaining one hard acquisition ceiling. Keep pool-pressure deadline retries
// disabled here so the 15 safe setup retries share this 135s cap.
const QUALIFICATION_STORE_TXN_OPTIONS = {
  acquireTimeoutMs: 135_000,
  acquireRetries: 0,
  connectionSetupRetries: 15,
  connectionSetupBackoffMs: 1_000,
} as const;

/** The stored queue's origin attempt, read structurally (null when absent or malformed). */
function repairQueueOriginAttemptId(rawRepairQueue: unknown): string | null {
  if (!rawRepairQueue || typeof rawRepairQueue !== 'object' || Array.isArray(rawRepairQueue)) return null;
  const origin = (rawRepairQueue as { qualificationAttemptId?: unknown }).qualificationAttemptId;
  return typeof origin === 'string' && origin ? origin : null;
}

/** The stored queue's CAS version (0 when absent or malformed, so a bump is still positive). */
function repairQueueUpdatedAtMs(rawRepairQueue: unknown): number {
  if (!rawRepairQueue || typeof rawRepairQueue !== 'object' || Array.isArray(rawRepairQueue)) return 0;
  const value = Number((rawRepairQueue as { updatedAtMs?: unknown }).updatedAtMs);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

async function mutateStoredQualification(
  target: GateVerdictTarget,
  change: (
    current: CheckpointQualificationTransaction | null,
    context: StoredQualificationRowContext,
  ) => StoredQualificationMutation | Promise<StoredQualificationMutation>,
  options: StoredQualificationMutationOptions = {},
): Promise<StoredQualificationMutation> {
  try {
    return await boundedOrgTxn<StoredQualificationMutation>(async (tx) => {
      const rows = await tx<{ metadata: Record<string, unknown> | null }[]>`
        SELECT metadata
          FROM harness_shared.routines
         WHERE workspace_id = ${target.workspaceId}
           AND install_slug = ${target.installSlug}
           AND target_role = 'system:green-checkpoint'
         FOR UPDATE`;
      if (!rows[0]) return { status: 'missing' as const };
      const metadata = rows[0].metadata ?? {};
      const raw = metadata[CHECKPOINT_QUALIFICATION_METADATA_KEY];
      const current = raw == null ? null : parseCheckpointQualificationTransaction(raw);
      if (raw != null && !current) {
        return { status: 'unreadable' as const, error: 'qualification transaction metadata is malformed' };
      }
      const rowContext: StoredQualificationRowContext = { rawRepairQueue: metadata.repair_queue ?? null };
      const queueHead = frozenRepairQueueVerificationTarget(rowContext.rawRepairQueue);
      if (current?.pendingRepairHead && queueHead && current.pendingRepairHead !== queueHead) {
        return { status: 'conflict' as const, transaction: current,
          refusalReason: 'pending-head-queue-mismatch' };
      }
      // Keep async probes under this row lock. Moving the probe outside the mutation would let
      // it describe one runner while the following decision acts on a replacement.
      const changed = await change(current, rowContext);
      const successorInput =
        typeof options.successorInput === 'function' ? options.successorInput(rowContext) : options.successorInput;
      // WI-6554700010030197: a SAME-attempt resume never reaches the successor reconciliation
      // below. When the queue's origin sits exactly one hop behind this attempt (its own begin
      // re-stamped the queue, then a queue write built from an older snapshot restored the
      // predecessor id), every later fire resumes this attempt and the admission handoff guard,
      // which needs origin === attemptId, refuses every admit until a verdict an awaiting-fixer
      // queue never produces. Heal exactly that one-hop lineage under this row lock, and only on
      // a 'preserved' verdict: a fenced or blocked assessment leaves the resume's result as it was.
      const staleOriginResume =
        successorInput &&
        current &&
        (changed.status === 'updated' || changed.status === 'idempotent') &&
        changed.transaction.attemptId === current.attemptId &&
        current.previousAttemptId != null &&
        repairQueueOriginAttemptId(metadata.repair_queue) === current.previousAttemptId
          ? current
          : null;
      const staleOriginHeal =
        staleOriginResume && successorInput
          ? assessTerminalRepairQueueReconciliation(staleOriginResume, successorInput, metadata.repair_queue)
          : null;
      const healStaleOrigin = staleOriginHeal?.status === 'preserved';
      if (changed.status !== 'updated' && !(healStaleOrigin && changed.status === 'idempotent')) return changed;
      // One choke point for every candidate-moving transition (settlement, retarget, reserve).
      // An idempotent resume moved nothing, so it is carried through unchanged.
      const transition =
        changed.status === 'updated'
          ? { ...changed, transaction: voidPreparedSelectionForMovedCandidate(changed.transaction) }
          : changed;
      const persistTerminalEvent = async (): Promise<void> => {
        if (transition.status !== 'updated') return;
        if (options.historicalRecovery && current && transition.transaction.previousAttemptId === current.attemptId) {
          await appendPipelineEvent({
            workspaceId: target.workspaceId,
            installSlug: target.installSlug,
            kind: 'green_checkpoint',
            status: 'qualification-recovered-pre-suite',
            detail: {
              attemptId: transition.transaction.attemptId,
              predecessor: current,
              logPath: options.historicalRecovery.logPath,
              logSha256: options.historicalRecovery.logSha256,
            },
          }, tx as unknown as Sql, { required: true });
        }
        if (!options.terminalEvent || !isTerminalQualificationOutcome(transition.transaction.outcome)) return;
        // WI-10007497: stamp the logical attempt this event settles. The event commits in the same
        // row write as the transition, so the transaction's own id is the authoritative one; without
        // it, attempt-to-verdict latency (and joins from skipped-joined-attempt rows) is unmeasurable.
        await appendPipelineEvent({
          workspaceId: target.workspaceId,
          installSlug: target.installSlug,
          kind: 'green_checkpoint',
          status: options.terminalEvent.status,
          detail: { ...options.terminalEvent.detail, attemptId: transition.transaction.attemptId },
        }, tx as unknown as Sql, { required: true });
      };
      // A distinct successor may replace a proved-dead nonterminal runner as well as a
      // terminal attempt. Both inherit the predecessor's queue, so both must reconcile and
      // re-stamp its owner in the same row write. Leaving the abandoned queue's old id in
      // place makes a later gate self-heal fail its handoff guard despite a matching CAS.
      const predecessor =
        successorInput && current && current.attemptId !== transition.transaction.attemptId
          ? current
          : null;
      const reconciliation =
        predecessor && successorInput
          ? assessTerminalRepairQueueReconciliation(predecessor, successorInput, metadata.repair_queue)
          : healStaleOrigin
            ? staleOriginHeal
            : null;
      const reconciledFrom = predecessor ?? staleOriginResume;
      if (reconciliation?.status === 'blocked') {
        return {
          status: 'conflict' as const,
          transaction: reconciledFrom!,
          repairQueueReconciliation: reconciliation,
          ...(options.historicalRecovery ? { refusalReason: 'repair-queue-reconciliation' } : {}),
        };
      }
      if (reconciliation?.status === 'preserved') {
        // Preservation is a queue handoff, not just permission to leave an old id behind.
        // Re-stamp the queue to the successor in the SAME exact-row CAS that installs the
        // successor transaction. Otherwise the next inconclusive run sees ancestry two hops
        // old and wedges on queue-origin-mismatch again.
        //
        // WI-6554700010030197: the re-stamp is a queue change, so it advances the queue's CAS
        // version too. Every queue writer CASes on repair_queue.updatedAtMs and writes its whole
        // snapshot back; with the version unchanged, a writer that read the queue before this
        // begin passed its CAS and silently restored the predecessor id (measured 2026-10-27:
        // origin e4eaae3b restored under successor a7dca9be, every admit then refused).
        const restampedQueueUpdatedAtMs = Math.max(
          repairQueueUpdatedAtMs(metadata.repair_queue) + 1,
          transition.transaction.updatedAtMs,
        );
        const updatedRows = await tx<{ metadata: Record<string, unknown> }[]>`
          UPDATE harness_shared.routines
             SET metadata = jsonb_set(
                   jsonb_set(
                     jsonb_set(
                       COALESCE(metadata, '{}'::jsonb),
                       '{repair_queue,qualificationAttemptId}',
                       ${JSON.stringify(transition.transaction.attemptId)}::text::jsonb,
                       true
                     ),
                     '{repair_queue,updatedAtMs}',
                     ${String(restampedQueueUpdatedAtMs)}::text::jsonb,
                     true
                   ),
                   '{${tx.unsafe(CHECKPOINT_QUALIFICATION_METADATA_KEY)}}',
                   ${JSON.stringify(transition.transaction)}::text::jsonb,
                   true
                 ),
                 updated_at = now()
           WHERE workspace_id = ${target.workspaceId}
             AND install_slug = ${target.installSlug}
             AND target_role = 'system:green-checkpoint'
             AND metadata->'repair_queue' = ${JSON.stringify(metadata.repair_queue)}::text::jsonb
             AND metadata->${CHECKPOINT_QUALIFICATION_METADATA_KEY} = ${JSON.stringify(raw)}::text::jsonb
           RETURNING metadata`;
        if (updatedRows.length === 0) {
          return {
            status: 'conflict' as const,
            transaction: reconciledFrom!,
            repairQueueReconciliation: {
              ...reconciliation,
              status: 'blocked',
              reason: 'cas-miss',
            },
            ...(options.historicalRecovery ? { refusalReason: 'repair-queue-cas-miss' } : {}),
          };
        }
        await persistTerminalEvent();
        return { ...transition, repairQueueReconciliation: reconciliation };
      }
      await tx`
        UPDATE harness_shared.routines
           SET metadata = jsonb_set(
                 COALESCE(metadata, '{}'::jsonb),
                 '{${tx.unsafe(CHECKPOINT_QUALIFICATION_METADATA_KEY)}}',
                 ${JSON.stringify(transition.transaction)}::text::jsonb,
                 true
               ),
               updated_at = now()
         WHERE workspace_id = ${target.workspaceId}
           AND install_slug = ${target.installSlug}
           AND target_role = 'system:green-checkpoint'`;
      await persistTerminalEvent();
      return reconciliation ? { ...transition, repairQueueReconciliation: reconciliation } : transition;
    }, QUALIFICATION_STORE_TXN_OPTIONS);
  } catch (error) {
    return { status: 'unreadable', error: error instanceof Error ? error.message : String(error) };
  }
}

export function beginStoredQualification(
  target: GateVerdictTarget,
  input: BeginQualificationInput,
  options: { reconcileTerminalRepairQueueForSuccessor?: boolean } = {},
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(
    target,
    // Probe INSIDE the mutation so the liveness verdict is taken against the same `current` the
    // transition decides on. Probing outside would race: the incumbent can die, or a fresh runner
    // can take the lease, between the read and the write.
    async (current, context) => {
      const queue = parseFrozenCandidateRepairQueue(context.rawRepairQueue);
      const incumbentLiveness =
        input.incumbentLiveness ?? await probeRunnerLiveness(current?.currentPhysicalRunner);
      const queueOwnsUntestedRepairHead = Boolean(
        current &&
        queue?.phase === 'ready-to-verify' &&
        queue.qualificationAttemptId === current.attemptId &&
        queue.fixerSpawnId === null &&
        queue.dispatchReservation == null &&
        // WI-6554700010018169: a pending same-head unmeasured retest is untested work too.
        frozenRepairHeadOwesVerification(queue)
      );
      const resumableRepairHead =
        current && queue && queueOwnsUntestedRepairHead && (
          (current.phase === 'waiting' &&
            current.outcome.kind === 'pre-suite-no-verdict' &&
            (current.outcome.reason === 'repair-in-progress' ||
              // A rejected ancestry request never launched a suite. Correct its
              // pin only to the untested head owned by this same locked queue,
              // retaining its attempt and declared-path policy.
              (isUnstartedAncestryRefusal(current) &&
                input.requiredAncestorSha === queue.repairHead &&
                sameStrings(current.candidatePolicy.declaredPaths, input.declaredPaths ?? []))) &&
            current.currentPhysicalRunner === null) ||
          (current.pendingRepairHead === queue.repairHead &&
            isUnstartedDeadRepairRunner(current, incumbentLiveness, input.nowMs ?? Date.now()))
        )
          ? queue.repairHead
          : null;
      return beginQualificationTransaction(current, {
        ...input,
        // EI-22931381517977345: the identity is decided against the SAME locked row's queue.
        // A repair wait already owns that queue. Reuse its logical attempt when the SAME
        // locked row proves the fixer has published a never-judged head; a new id would
        // conflict with the still-nonterminal waiter before it could verify its own repair.
        attemptId: resumableRepairHead
          ? current!.attemptId
          : resolveQualificationAttemptId(input, context.rawRepairQueue),
        candidate: resumableRepairHead ?? input.candidate,
        repairHead: resumableRepairHead ?? input.repairHead,
        incumbentLiveness,
        resumeUnownedRepairVerification: resumableRepairHead !== null,
      });
    },
    options.reconcileTerminalRepairQueueForSuccessor
      ? {
          successorInput: (context) => ({
            ...input,
            attemptId: resolveQualificationAttemptId(input, context.rawRepairQueue),
          }),
        }
      : {},
  );
}

export function recordStoredQualificationScheduledFire(
  target: GateVerdictTarget,
  attemptId: string,
  nowMs = Date.now(),
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, (current) =>
    current && current.attemptId === attemptId
      ? recordQualificationScheduledFire(current, nowMs)
      : current
        ? { status: 'conflict', transaction: current }
        : { status: 'unreadable', error: 'missing attempt' },
  );
}

export function waitStoredQualification(
  target: GateVerdictTarget,
  input: Parameters<typeof waitQualificationTransaction>[1],
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, (current) =>
    current ? waitQualificationTransaction(current, input) : { status: 'unreadable', error: 'missing attempt' },
  );
}

/**
 * WI-10005957 — retarget an attempt that a PRE-SUITE no-verdict pinned to a sha nobody judged.
 *
 * A scheduled run that tears before its candidate is resolved (dependency prewarm, torn source)
 * still settles with the integration TIP it read, so the stored attempt adopts that tip. The
 * frozen repair queue keeps owning the attempt, and every later scheduled CLI resumes the queue's
 * never-judged repairHead (`scheduledAttemptPrewarmTarget`). Activation then compares the stored
 * tip with the head and refuses `conflict` on every fire — a wedge that nothing else clears,
 * because `beginStoredQualification` only retargets a `repair-in-progress` waiter or a pending
 * repair head.
 *
 * The same locked row is the authority: when its queue owns this attempt, its head awaits
 * verification, the attaching CLI asks for exactly that head on its OWN unstarted placeholder,
 * and no physical run under the attempt ever reached a suite, the queue's head is the only
 * candidate the attempt can judge. Anything else is returned unchanged and keeps failing closed.
 */
export function retargetPreSuiteAttemptToOwningRepairHead(
  current: CheckpointQualificationTransaction,
  input: Pick<Parameters<typeof reserveQualificationRunner>[1], 'attemptId' | 'runnerId' | 'candidate' | 'started'>,
  rawRepairQueue: unknown,
): CheckpointQualificationTransaction {
  return assessPreSuiteRepairRetarget(current, input, rawRepairQueue).transaction;
}

/** Preserve the failed locked-row guard so an attach refusal remains diagnosable later. */
function assessPreSuiteRepairRetarget(
  current: CheckpointQualificationTransaction,
  input: Pick<Parameters<typeof reserveQualificationRunner>[1], 'attemptId' | 'runnerId' | 'candidate' | 'started'>,
  rawRepairQueue: unknown,
): { transaction: CheckpointQualificationTransaction; refusalReason?: string } {
  const unchanged = { transaction: current };
  const refused = (refusalReason: string) => ({ transaction: current, refusalReason });
  const requested = input.candidate?.trim();
  if (!requested || input.started !== true) return unchanged;
  if (current.attemptId !== input.attemptId || current.outcome.kind !== 'pending') return unchanged;
  if (!current.candidate || current.candidate === requested) return unchanged;
  if (current.continuation) return refused('continuation-lineage-pinned');
  const runner = current.currentPhysicalRunner;
  if (!runner || runner.id !== input.runnerId) return unchanged;
  if (runner.phase !== 'launching' || runner.pid != null) return refused('runner-already-attached');
  const everJudged = (current.consumedPhysicalRuns ?? []).some((run) => run.outcome.kind !== 'pre-suite-no-verdict');
  if (everJudged) return refused('attempt-already-judged');
  const queue = parseFrozenCandidateRepairQueue(rawRepairQueue);
  if (!queue) return refused('queue-missing-or-unreadable');
  if (queue.phase !== 'ready-to-verify') return refused('queue-not-ready-to-verify');
  if (queue.qualificationAttemptId !== current.attemptId) return refused('queue-attempt-mismatch');
  if (queue.fixerSpawnId !== null) return refused('queue-fixer-active');
  if (queue.dispatchReservation != null) return refused('queue-dispatch-reserved');
  if (queue.repairHead !== requested) return refused('queue-head-mismatch');
  if (!frozenRepairHeadAwaitsVerification(queue)) return refused('queue-head-already-judged');
  return {
    transaction: {
      ...current,
      candidate: requested,
      repairHead: requested,
      currentPhysicalRunner: { ...runner, candidate: requested },
      evidenceRefs: uniqueStrings([...current.evidenceRefs, `candidate:${requested}`, `retargeted-from:${current.candidate}`]),
    },
  };
}

export function reserveStoredQualificationRunner(
  target: GateVerdictTarget,
  input: Parameters<typeof reserveQualificationRunner>[1],
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, async (current, context) => {
    if (!current) return { status: 'unreadable', error: 'missing attempt' };
    const retarget = assessPreSuiteRepairRetarget(current, input, context.rawRepairQueue);
    const transition = reserveQualificationRunner(retarget.transaction, {
      ...input,
      incumbentLiveness: input.incumbentLiveness ?? await probeRunnerLiveness(current.currentPhysicalRunner),
    });
    return transition.status === 'conflict' && transition.refusalReason === 'candidate-mismatch' && retarget.refusalReason
      ? { ...transition, refusalReason: `candidate-mismatch:pre-suite-retarget-${retarget.refusalReason}` }
      : transition;
  });
}

export function recordStoredQualificationRunnerProgress(
  target: GateVerdictTarget,
  input: Parameters<typeof recordQualificationRunnerProgress>[1],
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, (current) =>
    current ? recordQualificationRunnerProgress(current, input)
      : { status: 'unreadable', error: 'missing attempt' },
  );
}

export function recordStoredQualificationChildScope(target: GateVerdictTarget,
  input: Parameters<typeof recordQualificationChildScope>[1]): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, async current => {
    if (!current) return { status: 'unreadable', error: 'missing attempt' };
    const runner = current.currentPhysicalRunner;
    // Never trust a caller-authored liveness value on the stored release path.
    const scopeLiveness = input.operation === 'release' && runner
      ? await runnerLivenessProber({ ...runner, unit: input.unit, pid: null, pidIdentity: null,
        childScopeUnits: [] }) : undefined;
    return recordQualificationChildScope(current, { ...input, scopeLiveness, nowMs: Date.now() });
  });
}

export function recordStoredQualificationWorkProgress(
  target: GateVerdictTarget,
  input: QualificationWorkProgressInput,
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, current => current
    ? recordQualificationWorkProgress(current, input)
    : { status: 'unreadable', error: 'missing attempt' });
}

export function recordStoredQualificationWorkYield(target: GateVerdictTarget,
  input: QualificationWorkProgressInput, checkpoint: QualificationWorkYield,
  signal?: AbortSignal): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, current => {
    if (!current) return { status: 'unreadable', error: 'missing attempt' };
    // Acquisition can outlive the caller's persistence reserve. Check again
    // inside the locked transaction rather than trusting its pre-await clock.
    const nowMs = Date.now();
    if (signal?.aborted || nowMs >= checkpoint.yieldDeadlineEpochMs)
      return { status: 'conflict', transaction: current, refusalReason: 'yield-deadline-exceeded' };
    return recordQualificationWorkYield(current, { ...input, nowMs }, { ...checkpoint, savedAtMs: nowMs });
  });
}

export interface QualificationNativeCompletionInput {
  path: string;
  producerPath?: string;
  /** Native task identity differs from the whole qualification's taskKey. */
  taskKey?: string;
  workspaceName: string;
  selectedSpecifications: unknown[];
  classifyReadPaths?: (reads: unknown, root: string) => { readPaths: string[]; opaqueReasons: string[] };
  requireTerminal?: boolean;
  supersedesCompletionIds?: Record<string, string>;
}

/** Recover native OUT outcomes under the current fence, with physical-run provenance. */
export function recordStoredQualificationNativeCompletion(
  target: GateVerdictTarget,
  input: QualificationWorkProgressInput,
  observation: QualificationNativeCompletionInput,
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, current => current
    ? recordQualificationNativeCompletion(current, input, observation)
    : { status: 'unreadable', error: 'missing attempt' });
}

function recordQualificationNativeCompletion(
  current: CheckpointQualificationTransaction,
  input: QualificationWorkProgressInput,
  observation: QualificationNativeCompletionInput,
  nativeObservation?: ReturnType<typeof readPartialNativeCompletion>,
): QualificationTransition {
    const conflict = (reason: string): QualificationTransition => ({ status: 'conflict', transaction: current, refusalReason: reason });
    if (input.updates.length !== 0) return conflict('native-recovery-mixed-updates');
    const custody = recordQualificationWorkProgress(current, input);
    if (custody.status !== 'updated' && custody.status !== 'idempotent') return custody;
    const observed = nativeObservation ?? readPartialNativeCompletion(observation.path, { ...input,
      taskKey: observation.taskKey ?? input.taskKey,
      workspaceName: observation.workspaceName, selectedSpecifications: observation.selectedSpecifications,
      ...(observation.producerPath !== undefined ? { producerPath: observation.producerPath } : {}),
    }, { classifyReadPaths: observation.classifyReadPaths, requireTerminal: observation.requireTerminal });
    if (observed.status !== 'ready' || !('origin' in observed)) return conflict(observed.reason ?? 'native-observation-unmeasured');
    const group = observed.origin.runGroupId;
    const active = group === current.runId ? current.currentPhysicalRunner : null;
    const ended = (current.consumedPhysicalRuns ?? []).find(run =>
      !!group && runIdBoundToRunner(run, group) && run.outcome.kind === 'pre-suite-no-verdict');
    const origin = active ?? ended;
    const cutoff = active ? input.nowMs ?? Date.now() : ended?.endedAtMs;
    if (!group || !origin || origin.candidate !== input.candidate || observed.origin.sourceCommit !== input.candidate ||
        observed.origin.startedAtMs === null || observed.origin.startedAtMs < origin.reservedAtMs ||
        cutoff === undefined || observed.origin.startedAtMs > cutoff ||
        observed.receipts.some(receipt => receipt.observedAtMs < observed.origin.startedAtMs! || receipt.observedAtMs > cutoff))
      return conflict('native-physical-run-unmeasured-or-outside-custody');
    // Recovery replays the entire enrolled population, including earlier attempts.
    // An exact archived receipt is already accounted for; a changed old artifact
    // still reaches the conflict checks and cannot eclipse its terminal demotion.
    const receipts = observed.receipts.filter(receipt => !(current.continuation?.supersededReceipts ?? [])
      .some(archived => isDeepStrictEqual(archived, receipt)));
    return recordQualificationWorkProgress(current, { ...input, updates: receipts.map(receipt => ({
      receipt: receipt as QualificationWorkReceipt,
      ...(observation.supersedesCompletionIds?.[receipt.unitId]
        ? { supersedesCompletionId: observation.supersedesCompletionIds[receipt.unitId] } : {}),
    })) });
}

/** Register the independently selected native producer on the existing fenced row.
 * The caller must hold the physical checkpoint lock and supply its own selection.
 * No filesystem discovery or new coordination root is introduced.
 */
export function recordStoredQualificationNativeProducer(
  target: GateVerdictTarget,
  input: QualificationWorkProgressInput,
  observation: Pick<QualificationNativeCompletionInput, 'path' | 'taskKey' | 'workspaceName' | 'selectedSpecifications' | 'supersedesCompletionIds'> & {
    producerPath: string;
  },
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, current => {
    if (!current) return { status: 'unreadable', error: 'missing attempt' };
    const conflict = (refusalReason: string): QualificationTransition => ({ status: 'conflict', transaction: current, refusalReason });
    if (input.updates.length) return conflict('native-recovery-mixed-updates');
    const custody = recordQualificationWorkProgress(current, input);
    if (custody.status !== 'updated' && custody.status !== 'idempotent') return custody;
    const producer = readPartialNativeProducer(observation.producerPath, {
      attemptId: input.attemptId, root: input.root, sourceCommit: input.candidate,
      runGroupId: input.runId, outPath: observation.path, taskKey: observation.taskKey ?? input.taskKey,
      workspaceName: observation.workspaceName,
    });
    const runner = current.currentPhysicalRunner!;
    if (!producer || observation.producerPath !== `${observation.path}.producer.json` ||
        !isDeepStrictEqual(producer.selectedSpecifications, observation.selectedSpecifications) ||
        producer.registeredAtMs < runner.reservedAtMs || producer.registeredAtMs > (input.nowMs ?? Date.now()))
      return conflict('native-producer-mismatch');
    const selected = new Set(observation.selectedSpecifications.map(spec => (spec as { testFile?: string })?.testFile));
    if ([...selected].some(path => input.manifest.units.filter(unit =>
      unit.kind === 'test' && !unit.exclusion && unit.path === path).length !== 1))
      return conflict('native-producer-outside-manifest');
    const ref: QualificationNativeProducerReference = {
      path: observation.producerPath, outPath: observation.path, taskKey: producer.taskKey,
      workspaceName: producer.workspaceName, runGroupId: producer.runGroupId,
      registeredAtMs: producer.registeredAtMs, selectedSpecifications: structuredClone(producer.selectedSpecifications),
      sha256: createHash('sha256').update(JSON.stringify(producer)).digest('hex'),
      ...(observation.supersedesCompletionIds !== undefined
        ? { supersedesCompletionIds: structuredClone(observation.supersedesCompletionIds) } : {}),
    };
    const prior = custody.transaction.continuation!.nativeProducers ?? [];
    const existing = prior.find(value => value.path === ref.path || value.outPath === ref.outPath);
    if (existing) return isDeepStrictEqual(existing, ref) ? custody : conflict('native-producer-reference-conflict');
    if (!validNativeProducerReferences([ref])) return conflict('native-producer-reference-invalid');
    const selection = evaluatePartialTaskContinuation({ root: input.root, taskKey: input.taskKey,
      continuation: custody.transaction.continuation }, { ...input, sourceCommit: input.candidate });
    if (selection.status !== 'ready') return conflict('native-producer-eligibility-unmeasured');
    const selectedUnits = input.manifest.units.filter(unit => unit.kind === 'test' && selected.has(unit.path));
    const eligible = new Set<string>(selection.run);
    for (const unit of selectedUnits) {
      if (!eligible.has(unit.id)) return conflict('native-producer-unit-not-eligible');
      const previous = custody.transaction.continuation!.receipts.find(receipt => receipt.unitId === unit.id);
      if (previous?.completionId !== observation.supersedesCompletionIds?.[unit.id])
        return conflict('native-producer-predecessor-mismatch');
    }
    if (Object.keys(observation.supersedesCompletionIds ?? {}).some(id => !selectedUnits.some(unit => unit.id === id)))
      return conflict('native-producer-predecessor-outside-selection');
    const nowMs = input.nowMs ?? Date.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < current.updatedAtMs) return conflict('continuation-clock-regressed');
    return { status: 'updated', transaction: { ...custody.transaction,
      updatedAtMs: nowMs, lastProgressAtMs: nowMs,
      continuation: { ...custody.transaction.continuation!, nativeProducers: [...prior, ref] } } };
  });
}

/** Re-read every enrolled OUT atomically before using any banked receipt.
 * A missing/tampered/latest-demoted artifact refuses the entire batch; callers
 * must stop and may not fall back to composing the previously stored passes.
 */
export function recoverStoredQualificationNativeCompletions(
  target: GateVerdictTarget,
  input: QualificationWorkProgressInput,
  classifyReadPaths?: QualificationNativeCompletionInput['classifyReadPaths'],
  options: { recoverMissingSnapshots?: boolean } = {},
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, async current => {
    if (!current) return { status: 'unreadable', error: 'missing attempt' };
    const conflict = (refusalReason: string): QualificationTransition => ({ status: 'conflict', transaction: current, refusalReason });
    if (input.updates.length) return conflict('native-recovery-mixed-updates');
    const custody = recordQualificationWorkProgress(current, input);
    if (custody.status !== 'updated' && custody.status !== 'idempotent') return custody;
    const refs = current.continuation?.nativeProducers;
    if (!refs?.length) return conflict('native-producers-unmeasured');
    let transaction = custody.transaction, changed = custody.status === 'updated';
    for (const ref of refs) {
      const producer = readPartialNativeProducer(ref.path, {
        attemptId: input.attemptId, root: input.root, sourceCommit: input.candidate,
        runGroupId: ref.runGroupId, outPath: ref.outPath, taskKey: ref.taskKey, workspaceName: ref.workspaceName,
      });
      if (!producer || createHash('sha256').update(JSON.stringify(producer)).digest('hex') !== ref.sha256)
        return conflict('native-producer-reference-mismatch');
      // ENOENT is distinct from an unreadable/corrupt artifact. Never retire a
      // missing OUT if this enrollment could have contributed a durable receipt.
      const absent = () => {
        try { lstatSync(ref.outPath); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
      };
      if (ref.missingSnapshot) {
        if (!absent()) return conflict('retired-native-output-appeared');
        continue;
      }
      if (options.recoverMissingSnapshots && absent()) {
        const ended = (current.consumedPhysicalRuns ?? []).find(run =>
          runIdBoundToRunner(run, ref.runGroupId) && run.outcome.kind === 'pre-suite-no-verdict');
        if (ref.runGroupId === current.runId || !ended ||
            await probeRunnerLiveness(ended, input.nowMs) !== 'dead') return conflict('native-producer-not-proved-dead');
        const selectedPaths = new Set(ref.selectedSpecifications.map(spec => (spec as { testFile?: string })?.testFile));
        const selectedIds = new Set(input.manifest.units.filter(unit => selectedPaths.has(unit.path)).map(unit => unit.id));
        if ([...transaction.continuation!.receipts, ...transaction.continuation!.supersededReceipts]
          .some(receipt => selectedIds.has(receipt.unitId))) return conflict('missing-native-output-has-banked-receipts');
        const confirmedAtMs = input.nowMs ?? Date.now();
        if (!Number.isSafeInteger(confirmedAtMs) || confirmedAtMs < transaction.updatedAtMs ||
            confirmedAtMs < ended.endedAtMs || !absent()) return conflict('native-producer-retirement-unmeasured');
        transaction = { ...transaction, updatedAtMs: confirmedAtMs, lastProgressAtMs: confirmedAtMs,
          continuation: { ...transaction.continuation!, nativeProducers: transaction.continuation!.nativeProducers!.map(value =>
            value.path === ref.path ? { ...value, missingSnapshot: { runnerId: ended.id, confirmedAtMs } } : value) } };
        changed = true;
        continue;
      }
      const result = recordQualificationNativeCompletion(transaction, input, {
        path: ref.outPath, producerPath: ref.path, taskKey: ref.taskKey, workspaceName: ref.workspaceName,
        selectedSpecifications: ref.selectedSpecifications, classifyReadPaths,
        ...(ref.supersedesCompletionIds ? { supersedesCompletionIds: ref.supersedesCompletionIds } : {}),
      });
      if (result.status !== 'updated' && result.status !== 'idempotent')
        return result.status === 'conflict' ? conflict(result.refusalReason ?? 'native-recovery-conflict') : result;
      changed ||= result.status === 'updated';
      transaction = result.transaction;
    }
    return { status: changed ? 'updated' : 'idempotent', transaction };
  });
}

/**
 * Advance work while the caller holds the existing physical checkpoint run lock.
 * No new runner/attempt is created here. The frozen population is committed before
 * the first callback, and every observed outcome is fenced and durable before the
 * next unit starts. The callback owns its ordinary hung-child/DB/process bounds.
 * A thrown/interrupted callback leaves that unacknowledged unit pending. A phase
 * driver can name its exact unitIds without narrowing the frozen manifest or the
 * final evaluation. This lets command/post-suite adapters retain their ordinary
 * execution boundaries while sharing the same custody and durable receipt store.
 */
export async function continueStoredQualificationWork(
  target: GateVerdictTarget,
  input: QualificationWorkProgressInput,
  execute: (unit: QualificationWorkUnit) => Promise<QualificationWorkReceipt>,
  options: { classifyReadPaths?: QualificationNativeCompletionInput['classifyReadPaths']; recoverMissingSnapshots?: boolean;
    unitIds?: readonly string[] } = {},
): Promise<{
  status: 'settled'; transaction: CheckpointQualificationTransaction;
  evaluation: ReturnType<typeof evaluatePartialTaskContinuation>; executed: string[];
} | { status: 'refused'; reason: string; executed: string[] }> {
  const executed: string[] = [];
  const refused = (reason: string) => ({ status: 'refused' as const, reason, executed });
  let requested: Set<string> | undefined;
  if (options.unitIds !== undefined) {
    if (!Array.isArray(options.unitIds) || !options.unitIds.length ||
        options.unitIds.some(id => typeof id !== 'string' || !id) ||
        new Set(options.unitIds).size !== options.unitIds.length) return refused('unit-selection-invalid');
    requested = new Set(options.unitIds);
    const population = new Set(input.manifest.units.map(unit => unit.id));
    if ([...requested].some(id => !population.has(id))) return refused('unit-selection-outside-manifest');
    if (input.updates.some(update => !requested!.has(update?.receipt?.unitId)))
      return refused('unit-selection-mixed-updates');
  }
  const grade = (transaction: CheckpointQualificationTransaction) => evaluatePartialTaskContinuation({
    root: input.root, taskKey: input.taskKey, continuation: { ...transaction.continuation,
      attemptId: transaction.attemptId, candidate: transaction.candidate, repairHead: transaction.repairHead },
  }, { ...input, sourceCommit: input.candidate });
  const synchronize = async (progress: QualificationWorkProgressInput): Promise<StoredQualificationMutation> => {
    const custody = await recordStoredQualificationWorkProgress(target, progress);
    if ((custody.status !== 'updated' && custody.status !== 'idempotent') ||
        !custody.transaction.continuation?.nativeProducers?.length) return custody;
    return recoverStoredQualificationNativeCompletions(target, { ...progress, updates: [] }, options.classifyReadPaths, options);
  };
  const initial = await synchronize(input);
  if (initial.status !== 'updated' && initial.status !== 'idempotent') return refused(`custody-${initial.status}`);
  let transaction = initial.transaction;
  const selection = grade(transaction);
  if (selection.status !== 'ready') return refused(`continuation-${selection.reason}`);
  const units = new Map(input.manifest.units.map(unit => [unit.id, unit]));
  for (const id of selection.run) {
    if (requested && !requested.has(id)) continue;
    // Re-read and validate the exact fence under the row lock immediately before
    // starting another unit, including after a slow or interrupted predecessor.
    const ownership = await synchronize({ ...input, updates: [] });
    if (ownership.status !== 'updated' && ownership.status !== 'idempotent') return refused(`custody-${ownership.status}`);
    transaction = ownership.transaction;
    const eligible = grade(transaction);
    if (eligible.status !== 'ready') return refused(`continuation-${eligible.reason}`);
    if (!new Set<string>(eligible.run).has(id)) continue;
    const unit = units.get(id);
    if (!unit) return refused('selected-unit-missing');
    const receipt = await execute(structuredClone(unit));
    executed.push(id);
    if (receipt?.unitId !== id) return refused('executed-unit-mismatch');
    const previous = transaction.continuation?.receipts.find(value => value.unitId === id);
    const committed = await recordStoredQualificationWorkProgress(target, { ...input,
      updates: [{ receipt, ...(previous ? { supersedesCompletionId: previous.completionId } : {}) }] });
    if (committed.status !== 'updated' && committed.status !== 'idempotent') return refused(`completion-${committed.status}`);
    transaction = committed.transaction;
  }
  // Include missing, retained-failure and infrastructure populations in the
  // final evaluation even when this invocation had no eligible units to run.
  // Re-read enrolled artifacts after the final callback too: a terminal reporter
  // error must not be eclipsed by an earlier durable per-file pass.
  const final = await synchronize({ ...input, updates: [] });
  if (final.status !== 'updated' && final.status !== 'idempotent') return refused(`completion-${final.status}`);
  transaction = final.transaction;
  return { status: 'settled', transaction, evaluation: grade(transaction), executed };
}

export function recordStoredQualificationEligibility(
  target: GateVerdictTarget,
  input: Parameters<typeof recordQualificationEligibilitySnapshot>[1],
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, (current) =>
    current
      ? recordQualificationEligibilitySnapshot(current, input)
      : { status: 'unreadable', error: 'missing attempt' },
  );
}

export async function readStoredQualification(
  target: GateVerdictTarget,
): Promise<
  | { status: 'present'; transaction: CheckpointQualificationTransaction }
  | { status: 'none' | 'unreadable'; error?: string }
> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ transaction: unknown }[]>`
      SELECT metadata->${CHECKPOINT_QUALIFICATION_METADATA_KEY} AS transaction
        FROM harness_shared.routines
       WHERE workspace_id = ${target.workspaceId}
         AND install_slug = ${target.installSlug}
         AND target_role = 'system:green-checkpoint'
       LIMIT 1`;
    if (!rows[0]?.transaction) return { status: 'none' };
    const transaction = parseCheckpointQualificationTransaction(rows[0].transaction);
    return transaction
      ? { status: 'present', transaction }
      : { status: 'unreadable', error: 'qualification transaction metadata is malformed' };
  } catch (error) {
    return { status: 'unreadable', error: error instanceof Error ? error.message : String(error) };
  }
}

export function recordStoredQualificationVerdict(
  target: GateVerdictTarget,
  input: {
    attemptId?: string;
    reason: string;
    green?: boolean | null;
    candidate?: string | null;
    repairHead?: string | null;
    runId?: string | null;
    evidenceRefs?: readonly string[];
    nowMs?: number;
    /** Present for a recordable terminal verdict; included in the same DB transaction. */
    terminalEvent?: { status: string; detail: Record<string, unknown> };
  },
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, (current) => {
    if (!current) return { status: 'unreadable', error: 'missing attempt' };
    return settleQualificationTransaction(current, {
      ...input,
      attemptId: input.attemptId ?? current.attemptId,
    });
  }, { terminalEvent: input.terminalEvent });
}

/**
 * Compose and settle a green continuation in ONE existing qualification transaction.
 * A previous evaluation is not an authorization: re-read the current fence, frozen
 * population and enrolled native artifacts while the row is locked. No final event
 * or terminal state is written when any obligation or source check is unknown.
 */
export interface QualificationCompositionOptions {
  classifyReadPaths?: QualificationNativeCompletionInput['classifyReadPaths'];
  /** Independent source-owned inventory; observed outcomes may not define it. */
  currentCommandDefinition?: (unit: QualificationWorkUnit, input: QualificationWorkProgressInput) => unknown | Promise<unknown>;
}

export function recordStoredQualificationComposedVerdict(
  target: GateVerdictTarget,
  input: QualificationWorkProgressInput,
  verdict: Omit<Parameters<typeof recordStoredQualificationVerdict>[1], 'attemptId'>,
  options: QualificationCompositionOptions = {},
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, async current => {
    if (!current) return { status: 'unreadable', error: 'missing attempt' };
    const conflict = (refusalReason: string): QualificationTransition => ({ status: 'conflict', transaction: current, refusalReason });
    if (classifyQualificationVerdict(verdict).kind !== 'green') return conflict('continuation-composition-not-green');
    if (verdict.candidate !== input.candidate || verdict.runId !== input.runId ||
        (verdict.repairHead ?? null) !== input.repairHead) return conflict('continuation-lineage-mismatch');
    const composed = await composeQualificationWork(current, input, options);
    if (composed.status !== 'updated' && composed.status !== 'idempotent') return composed;
    return settleQualificationTransaction(composed.transaction, { ...verdict, attemptId: input.attemptId,
      [COMPOSED_QUALIFICATION_GREEN]: true });
  }, { terminalEvent: verdict.terminalEvent });
}

/** Run the same row-locked full-population composer BEFORE the caller may promote.
 * Keep the attempt running: a successful composition is not a promotion receipt,
 * and the ordinary terminal path must still recheck and settle the final verdict.
 */
export function composeStoredQualificationWork(
  target: GateVerdictTarget,
  input: QualificationWorkProgressInput,
  options: QualificationCompositionOptions = {},
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, current => current
    ? composeQualificationWork(current, input, options)
    : { status: 'unreadable', error: 'missing attempt' });
}

async function composeQualificationWork(
  current: CheckpointQualificationTransaction,
  input: QualificationWorkProgressInput,
  options: QualificationCompositionOptions,
): Promise<QualificationTransition> {
    const conflict = (refusalReason: string): QualificationTransition => ({ status: 'conflict', transaction: current, refusalReason });
    if (input.updates.length || !current.continuation) return conflict('continuation-composition-unmeasured');
    const custody = recordQualificationWorkProgress(current, input);
    if (custody.status !== 'updated' && custody.status !== 'idempotent') return custody;
    let transaction = custody.transaction;
    // Ephemeral capabilities come only from rereading native artifacts under
    // this row's current fence. They are never recovered from stored receipts.
    const currentEvidence: object[] = [];
    const interruptedTasks: Array<{ taskKey: string; endedAtMs: number }> = [];
    const terminalTasks: Array<{ taskKey: string; startedAtMs: number }> = [];
    const nativePaths = new Set((transaction.continuation!.nativeProducers ?? []).filter(ref => !ref.missingSnapshot)
      .flatMap(ref => ref.selectedSpecifications.map(value => (value as { testFile: string }).testFile)));
    if (input.manifest.units.some(unit => unit.kind === 'test' && !unit.exclusion && !nativePaths.has(unit.path)))
      return conflict('native-producer-population-incomplete');
    for (const ref of transaction.continuation!.nativeProducers ?? []) {
      const producer = readPartialNativeProducer(ref.path, { attemptId: input.attemptId, root: input.root,
        taskKey: ref.taskKey, workspaceName: ref.workspaceName, runGroupId: ref.runGroupId,
        sourceCommit: input.candidate, outPath: ref.outPath });
      if (!producer || createHash('sha256').update(JSON.stringify(producer)).digest('hex') !== ref.sha256 ||
          !isDeepStrictEqual(producer.selectedSpecifications, ref.selectedSpecifications))
        return conflict('native-producer-reference-mismatch');
      if (ref.missingSnapshot) {
        // Retirement never excuses a late artifact, nor a pass banked against a
        // producer whose first snapshot was proved missing during dead handoff.
        const selected = new Set(ref.selectedSpecifications.map(value => (value as { testFile: string }).testFile));
        const units = new Set(input.manifest.units.filter(unit => selected.has(unit.path)).map(unit => unit.id));
        const banked = [...transaction.continuation!.receipts, ...transaction.continuation!.supersededReceipts]
          .some(receipt => units.has(receipt.unitId) && receipt.observedAtMs <= ref.missingSnapshot!.confirmedAtMs);
        try { lstatSync(ref.outPath); return conflict('retired-native-output-reappeared'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return conflict('native-output-unreadable'); }
        if (banked) return conflict('missing-native-output-has-banked-receipts');
        continue;
      }
      const ended = ref.runGroupId === input.runId ? undefined : transaction.consumedPhysicalRuns?.find(run =>
        runIdBoundToRunner(run, ref.runGroupId) && run.outcome.kind === 'pre-suite-no-verdict');
      const observation = {
        path: ref.outPath, producerPath: ref.path, taskKey: ref.taskKey, workspaceName: ref.workspaceName,
        selectedSpecifications: ref.selectedSpecifications, classifyReadPaths: options.classifyReadPaths, requireTerminal: true,
        ...(ref.supersedesCompletionIds ? { supersedesCompletionIds: ref.supersedesCompletionIds } : {}),
      };
      const observed = readPartialNativeCompletion(ref.outPath, { ...input, ...observation,
        continuationTaskKey: input.taskKey,
        runnerReservedAtMs: transaction.currentPhysicalRunner!.reservedAtMs,
        nowMs: input.nowMs ?? Date.now(),
      }, {
        classifyReadPaths: options.classifyReadPaths, requireTerminal: true,
        allowInterrupted: !!ended && await probeRunnerLiveness(ended, input.nowMs) === 'dead',
      });
      if (observed.status !== 'ready' || !('origin' in observed))
        return conflict(observed.reason ?? 'native-observation-unmeasured');
      currentEvidence.push(...observed.currentEvidence);
      if (observed.origin.terminal === 'interrupted') {
        if (!ended) return conflict('native-producer-not-proved-dead');
        interruptedTasks.push({ taskKey: ref.taskKey, endedAtMs: ended.endedAtMs });
      } else if (observed.origin.terminal === 'passed' && observed.origin.startedAtMs !== null) {
        terminalTasks.push({ taskKey: ref.taskKey, startedAtMs: observed.origin.startedAtMs });
      }
      const recovered = recordQualificationNativeCompletion(transaction, input, observation, observed);
      if (recovered.status !== 'updated' && recovered.status !== 'idempotent') return recovered;
      transaction = recovered.transaction;
    }
    // A banked prefix never substitutes for the task's final runtime guard. A
    // later producer must actually finish cleanly under the same enrolled task;
    // full-manifest evaluation below still accounts for every selected file.
    if (interruptedTasks.some(prior => !terminalTasks.some(next => next.taskKey === prior.taskKey &&
        next.startedAtMs >= prior.endedAtMs))) return conflict('native-successor-terminal-unmeasured');
    const retained = evaluatePartialTaskContinuation({ root: input.root, taskKey: input.taskKey,
      continuation: transaction.continuation }, { ...input, sourceCommit: input.candidate });
    if (retained.status !== 'ready') return conflict('continuation-reuse-unmeasured');
    const reusable = new Set<string>(retained.reused);
    const authenticatedTasks = new Set<string>();
    for (const unit of input.manifest.units.filter(unit => unit.kind !== 'test' && !unit.exclusion)) {
      // Eligible retained work is disjoint from current-only authentication.
      // Requiring its old physical capture to match this runner would silently
      // revoke the reuse decision that already omitted its original command.
      if (reusable.has(unit.id)) continue;
      const receipt = transaction.continuation!.receipts.find(receipt => receipt.unitId === unit.id);
      if (receipt?.state !== 'pass') continue;
      const definition = await options.currentCommandDefinition?.(unit, input);
      if (!definition) continue;
      const expected = { ...input, sourceCommit: input.candidate,
        runnerReservedAtMs: transaction.currentPhysicalRunner!.reservedAtMs, nowMs: input.nowMs ?? Date.now() };
      if (unit.kind === 'guard') {
        // A generic zero-exit command observation cannot discharge source-owned
        // npm hooks/chains. Authenticate the complete atomic guard population.
        const task = definition as { task?: string };
        if (typeof task.task !== 'string' || authenticatedTasks.has(task.task)) continue;
        const outcomes = receipt.proof?.commandOutcomes;
        if (!Array.isArray(outcomes) || outcomes.length !== 1) return conflict('task-command-outcome-unmeasured');
        const observed = readPartialTaskCommandCompletion(outcomes[0], expected, definition);
        if (observed.status !== 'ready' || observed.receipts.some(value =>
            !isDeepStrictEqual(value, transaction.continuation!.receipts.find(saved => saved.unitId === value.unitId))))
          return conflict('task-command-completion-mismatch');
        authenticatedTasks.add(task.task);
        currentEvidence.push(...observed.currentEvidence);
        continue;
      }
      const observed = readPartialCurrentCommandCompletion(receipt, expected, definition);
      if (observed.status === 'ready') currentEvidence.push(...observed.currentEvidence);
    }
    const evaluation = evaluatePartialTaskContinuation({ root: input.root, taskKey: input.taskKey,
      continuation: transaction.continuation }, { ...input, sourceCommit: input.candidate }, { currentEvidence });
    if (evaluation.status !== 'ready' || evaluation.verdict !== 'green') return conflict('continuation-verdict-not-green');
    try {
      // Frozen candidates are immutable. Inspect the actual root instead of
      // inferring present cleanliness from a receipt's historical dirty flag.
      const git = async (...args: string[]) => (await promisify(execFile)('git', ['-C', input.root, ...args],
        { timeout: 5_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout.trim();
      if (await git('rev-parse', '--show-prefix') !== '' ||
          await git('rev-parse', '--verify', 'HEAD') !== input.candidate ||
          await git('status', '--porcelain', '--untracked-files=normal') !== '')
        return conflict('continuation-source-changed');
    } catch { return conflict('continuation-source-unmeasured'); }
    return { status: isDeepStrictEqual(current, transaction) ? 'idempotent' : 'updated', transaction };
}

export function recordStoredQualificationScheduledTerminalRecovery(
  target: GateVerdictTarget,
  input: Parameters<typeof recoverQualificationScheduledTerminal>[1],
): Promise<StoredQualificationMutation> {
  return mutateStoredQualification(target, (current) =>
    current ? recoverQualificationScheduledTerminal(current, input)
      : { status: 'unreadable', error: 'missing attempt' },
  );
}

/** Read the archive ourselves; validate and install its successor under the existing row lock. */
export function recoverStoredQualificationHistoricalPreSuiteError(
  target: GateVerdictTarget,
  input: Omit<HistoricalPreSuiteRecoveryInput, 'log'>,
  request?: Pick<BeginQualificationInput, 'requiredAncestorSha' | 'declaredPaths'>,
): Promise<StoredQualificationMutation> {
  let proof: HistoricalPreSuiteRecoveryInput;
  try {
    proof = { ...input, log: readFileSync(input.logPath, 'utf8') };
  } catch (error) {
    return Promise.resolve({ status: 'unreadable', error: error instanceof Error ? error.message : String(error) });
  }
  let successorInput: BeginQualificationInput;
  return mutateStoredQualification(target, (current) => {
    if (!current) return { status: 'unreadable', error: 'missing attempt' };
    // Validate the archive and exact predecessor before attributing a request-policy
    // conflict. A newer attempt may have different policy; that must not suggest
    // changing the caller's original guard to recover an unrelated terminal.
    // This transition is pure: every policy/store guard still precedes any write.
    const transition = recoverQualificationHistoricalPreSuiteError(current, proof);
    if (transition.status !== 'updated' && transition.status !== 'idempotent') return transition;
    if (request && !qualificationRequestPolicyMatches(current, request)) {
      return { status: 'conflict', transaction: current,
        refusalReason: current.requiredAncestorSha !== (request.requiredAncestorSha?.trim() || null)
          ? 'request-ancestor-mismatch' : 'request-paths-mismatch' };
    }
    if (transition.status === 'updated') {
      successorInput = {
        attemptId: transition.transaction.attemptId,
        requiredAncestorSha: transition.transaction.requiredAncestorSha,
        declaredPaths: transition.transaction.candidatePolicy.declaredPaths,
        candidate: transition.transaction.candidate,
        repairHead: transition.transaction.repairHead,
        nowMs: transition.transaction.updatedAtMs,
      };
    }
    return transition;
  }, { successorInput: () => successorInput, historicalRecovery: proof });
}

/**
 * Stop and settle a runner while the qualification row is held FOR UPDATE. The exact
 * attempt/unit predicates are repeated on the UPDATE as a row-level CAS, and the repair
 * queue is intentionally absent from the SET clause: cancelling a verifier may abandon
 * the physical run, but it must never retire or rewrite the frozen repair lineage.
 */
export async function cancelStoredQualification(
  target: GateVerdictTarget,
  input: CancelQualificationInput,
  stop: () => Promise<{ stopped: boolean; reason?: string }> | { stopped: boolean; reason?: string },
): Promise<StoredQualificationCancellation> {
  try {
    return await boundedOrgTxn<StoredQualificationCancellation>(async (tx) => {
      const rows = await tx<{ metadata: Record<string, unknown> | null }[]>`
        SELECT metadata
          FROM harness_shared.routines
         WHERE workspace_id = ${target.workspaceId}
           AND install_slug = ${target.installSlug}
           AND target_role = 'system:green-checkpoint'
         FOR UPDATE`;
      if (!rows[0]) return { status: 'missing' as const };
      const metadata = rows[0].metadata ?? {};
      const raw = metadata[CHECKPOINT_QUALIFICATION_METADATA_KEY];
      const current = raw == null ? null : parseCheckpointQualificationTransaction(raw);
      if (raw != null && !current) {
        return { status: 'unreadable' as const, error: 'qualification transaction metadata is malformed' };
      }
      if (!current) return { status: 'unreadable' as const, error: 'missing attempt' };
      const transition = cancelQualificationTransaction(current, input);
      if (transition.status !== 'updated') return transition;

      const stopped = await stop();
      if (!stopped.stopped) {
        return {
          status: 'stop-failed' as const,
          transaction: current,
          error: stopped.reason?.trim() || 'systemd kill did not stop the exact checkpoint unit',
        };
      }

      const updatedRows = await tx<{ metadata: Record<string, unknown> }[]>`
        UPDATE harness_shared.routines
           SET metadata = jsonb_set(
                 COALESCE(metadata, '{}'::jsonb),
                 '{${tx.unsafe(CHECKPOINT_QUALIFICATION_METADATA_KEY)}}',
                 ${JSON.stringify(transition.transaction)}::text::jsonb,
                 true
               ),
               updated_at = now()
         WHERE workspace_id = ${target.workspaceId}
           AND install_slug = ${target.installSlug}
           AND target_role = 'system:green-checkpoint'
           AND metadata->${CHECKPOINT_QUALIFICATION_METADATA_KEY}->>'attemptId' = ${input.attemptId}
           AND metadata->${CHECKPOINT_QUALIFICATION_METADATA_KEY}->'currentPhysicalRunner'->>'unit' = ${input.unit.trim()}
           AND metadata->${CHECKPOINT_QUALIFICATION_METADATA_KEY} = ${JSON.stringify(raw)}::text::jsonb
         RETURNING metadata`;
      if (updatedRows.length === 0) return { status: 'conflict' as const, transaction: current };
      return transition;
    }, QUALIFICATION_STORE_TXN_OPTIONS);
  } catch (error) {
    return { status: 'unreadable', error: error instanceof Error ? error.message : String(error) };
  }
}
