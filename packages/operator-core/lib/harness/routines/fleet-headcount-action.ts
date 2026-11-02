/** WI-2479: durable, dark-by-default fleet headcount repair action. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import {
  claimFleetHeadcountAttempt,
  claimFleetLaunchSlot,
  getFleet,
  lapseFleetTopUpRule,
  listExpiredFleetTopUpRules,
  listFleetHeadcountTargets,
  measureFleetProductiveHeadcount,
  mergeFleetLaunchWorkerAttestations,
  recordFleetHeadcountAttempt,
  releaseFleetLaunchSlot,
  setFleetHeadcountTarget,
  setFleetLaunchTransaction,
  type FleetHeadcountConfig,
  type FleetHeadcountTarget,
  type FleetHeadcountBasis,
  type FleetLaunchCapacitySnapshot,
  type FleetLaunchGovernorAction,
  type FleetLaunchGovernorState,
  type FleetLaunchGovernorVerdict,
  type FleetLaunchTransaction,
} from '../../agent-fleets-store';
import type { FleetTopUpRule } from '../../fleet/top-up-rule';
import { buildConsoleEnvelope } from '../../console-launcher';
import { spawnConsole, spawnHeadless } from '../../console-spawn';
import { listFleetRosterDiagnosed, liveFleetMemberIds } from '../../fleet/fleet-roster';
import { readFleetLaneHealthDiagnosed } from '../../fleet/lane-health';
import { isWorkspaceWideLoopStanddownActive } from './release-pause-ttl';
import { getLoopStatuses } from './loop';
import {
  composeModelSpec,
  composeMemberLaunchContext,
  injectLaunchedByArg,
  launchModeFromFleetRecipe,
  memberLaunchCommand,
  modelEffortFromSpec,
  verifyFreshLaunchStarted,
  type FreshLaunchExpectedAttestation,
  type LaunchMode,
} from '../../agent-launch-core';
import { getModes } from '../../modes/store';
import killTool from '../../agent-tools/fleet/kill';
import { countedMemberSet, readFleetMemberSilence } from '../../agent-tools/fleet_registry/silent-member';
import { resolveGoalLaunch } from '../../goal-launch-settings';
import {
  goalFleetFamily,
  goalFleetMemberSlot,
  type GoalLaunchRole,
} from '../../goal-launch-settings-shared';
import { resolveGoalContext } from '../../modes/goal-context';
import { papercuspPathForWorkspace } from '../../papercusp-root';
import { resolveSpawnHostOperatorBaseUrl } from '../../mcp-base-url';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export const FLEET_HEADCOUNT_FLAG = FLAGS.FLEET_HEADCOUNT_GOVERNOR;
export const FLEET_HEADCOUNT_LAUNCH_WINDOW_MS = 300_000;
export const FLEET_HEADCOUNT_ATTESTATION_RETRY_LIMIT = 3;
export const FLEET_HEADCOUNT_BULK_WAVE_SIZE = 3;
export const FLEET_HEADCOUNT_HISTORY_LIMIT = 32;
export const FLEET_HEADCOUNT_VERIFY_TIMEOUT_MS = 10_000;

export function computeHeadcountDeficit(target: number, liveMembers: number): number {
  return Math.max(0, Math.floor(target) - Math.max(0, Math.floor(liveMembers)));
}

export function nextHeadcountBackoff(currentMs: number): number {
  return Math.min(15 * 60_000, Math.max(60_000, Math.max(0, currentMs) * 2));
}

/**
 * WI-6554700010029299: consecutive governor waves in which EVERY member died at boot
 * with the SAME failure fingerprint before the governor holds relaunching. A
 * deterministic boot refusal (on 10-24/25 it was psu's account-route check) makes
 * every replacement die the same way. The 15-minute backoff cap alone kept minting
 * up to FLEET_HEADCOUNT_BULK_WAVE_SIZE dead members per wave, about 232 over two
 * days in nonp2p-bug-drain-luna-max-0930.
 */
export const FLEET_HEADCOUNT_BOOT_FAILURE_STREAK = 3;
/** How long the governor waits once that streak is reached. One probe wave runs after it. */
export const FLEET_HEADCOUNT_BOOT_FAILURE_HOLD_MS = 6 * 60 * 60_000;

/**
 * PURE. A stable fingerprint for a boot-death failure reason, or null when the
 * reason is not a boot death. The boot-death text comes from console-spawn
 * ("… agent command died at boot (exit N) … log tail: …"). The fingerprint is the
 * last substantive line of that log tail, lowercased, with digit runs normalized,
 * so session ids and ports do not split one cause into many.
 */
export function bootFailureFingerprint(reason: string | null | undefined): string | null {
  if (!reason || !/died at boot/i.test(reason)) return null;
  // eslint-disable-next-line no-control-regex
  const clean = reason.replace(/\u001b\][^\u0007]*\u0007/g, '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
  const tailAt = clean.toLowerCase().lastIndexOf('log tail:');
  const lines = (tailAt >= 0 ? clean.slice(tailAt + 'log tail:'.length) : '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('[papercusp]'));
  const basis = lines.length > 0
    ? lines[lines.length - 1]
    : (clean.match(/died at boot \(exit [^)]*\)/i)?.[0] ?? 'died at boot');
  return basis.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 160);
}

/**
 * PURE. The fingerprint of a wave in which every requested member failed with one
 * boot-death cause, or null when any member did not fail that way (a mixed or
 * partial wave says nothing deterministic about the launch path).
 */
export function bootFailureWaveFingerprint(
  failed: ReadonlyArray<{ ownerId: string; reason: string }>,
  requestedOwnerIds: readonly string[],
): string | null {
  if (requestedOwnerIds.length === 0) return null;
  let fingerprint: string | null = null;
  for (const ownerId of requestedOwnerIds) {
    const prints = failed
      .filter((entry) => entry.ownerId === ownerId)
      .map((entry) => bootFailureFingerprint(entry.reason))
      .filter((print): print is string => print != null);
    if (prints.length === 0) return null;
    if (fingerprint == null) fingerprint = prints[0];
    if (!prints.includes(fingerprint)) return null;
  }
  return fingerprint;
}

/**
 * PURE. The trailing run of identical `boot-failure` waves in governor history.
 * Only `boot-failure` / `boot-ok` events count. Ticks that launch nothing (wait,
 * observe, terminal) neither extend nor break the run. A `boot-ok` wave or a
 * different fingerprint ends it.
 */
export function bootFailureStreak(
  history: ReadonlyArray<{ action: string; reason: string }>,
): { fingerprint: string; count: number } | null {
  let fingerprint: string | null = null;
  let count = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const event = history[i];
    if (event.action === 'boot-ok') break;
    if (event.action !== 'boot-failure') continue;
    if (fingerprint == null) fingerprint = event.reason;
    else if (event.reason !== fingerprint) break;
    count += 1;
  }
  return fingerprint == null ? null : { fingerprint, count };
}

export function resolveProductiveCapacityFloor(target: number, configured?: number): number {
  const boundedTarget = Math.max(1, Math.floor(target));
  const raw = Number.isFinite(configured) ? Math.floor(configured as number) : 1;
  return Math.min(boundedTarget, Math.max(1, raw));
}

export interface FleetHeadcountGovernorAssessment {
  target: number;
  productiveCapacityFloor: number;
  liveMemberIds: string[];
  workerReadyMemberIds: string[];
  unreadyMemberIds: string[];
  /**
   * WI-6554700010029353: the subset of `unreadyMemberIds` outside the governor's
   * current probe cohort. Their attestation is never re-taken, so they never hold the
   * `wait` (only probed unready members do). Refill proceeds against the deficit
   * instead. They are surfaced so a spawn past a non-empty unready set can be explained.
   */
  frozenUnreadyMemberIds: string[];
  unverifiedMemberIds: string[];
  pendingOpenedMemberIds: string[];
  /**
   * WI-2034601: opened members that never became live within
   * FLEET_HEADCOUNT_LAUNCH_WINDOW_MS and are therefore classified LAUNCH-FAILED
   * rather than waited on. Surfaced so the transition out of `wait` is
   * observable: without it the governor's move to `spawn` reads as an
   * unexplained replacement instead of a deadline being enforced.
   */
  launchDeadlineExceededMemberIds: string[];
  pruneCandidateIds: string[];
  productiveMemberCount: number | null;
  headcountBasis: FleetHeadcountBasis;
  deficit: number;
  action: FleetLaunchGovernorAction;
  actionOwnerId: string | null;
  spawnCount: number;
  reason: string;
}

/** Pure P-004 policy. It consumes typed launch evidence but never substitutes it
 * for live roster state: readiness is intersected with the independently-read
 * live ids, and an unverified/slow boot can only produce wait/retry.
 *
 * WI-2034624: transaction worker-readiness governs THIS TRANSACTION'S own
 * prune/retry/wait decisions and nothing else. The population the deficit is
 * sized from comes from `executingMemberIds` — recent agent-origin execution
 * over the canonical live roster — so a member launched by a prior transaction
 * or rebuilt by a carry-respawn counts exactly like one this transaction
 * opened. `executingMemberIds` is required for that reason: a caller that could
 * omit it would silently resurrect the transaction-scoped count. */
export function assessFleetHeadcountGovernor(args: {
  target: number;
  productiveCapacityFloor?: number;
  liveMemberIds: readonly string[];
  executingMemberIds: ReadonlySet<string> | null;
  transaction: FleetLaunchTransaction | null | undefined;
  retryLimit?: number;
  now?: number;
}): FleetHeadcountGovernorAssessment {
  const target = Math.max(1, Math.floor(args.target));
  const productiveCapacityFloor = resolveProductiveCapacityFloor(
    target,
    args.productiveCapacityFloor,
  );
  const liveMemberIds = [...new Set(args.liveMemberIds)];
  const live = new Set(liveMemberIds);
  const transaction = args.transaction ?? null;
  const retired = new Set(transaction?.governor?.retiredMemberIds ?? []);
  const attestationByOwner = new Map(
    (transaction?.workerAttestations ?? [])
      .filter((item) => typeof item.ownerId === 'string' && item.ownerId.length > 0)
      .map((item) => [item.ownerId as string, item]),
  );
  const workerReadyMemberIds = liveMemberIds.filter(
    (ownerId) => !retired.has(ownerId) && attestationByOwner.get(ownerId)?.ready === true,
  );
  const attempts = transaction?.governor?.attestationAttempts ?? {};
  const retryLimit = Math.max(1, Math.floor(args.retryLimit ?? FLEET_HEADCOUNT_ATTESTATION_RETRY_LIMIT));
  const currentProbeOwners = new Set(transaction?.governor?.probeOwnerIds ?? []);
  // WI-6554700010029346: a not-ready attestation is live evidence only while the
  // governor is still re-taking it — a current probe owner inside its retry budget.
  // Outside that window it is a frozen snapshot that will never be refreshed, and
  // for a member that is DEMONSTRABLY EXECUTING the stronger productivity proof
  // (recent agent-origin execution, WI-2034624) supersedes it. Counting such a
  // member as unready wedged a live fleet: it is never a prune candidate
  // (executing), never retryable (not a probe owner / budget spent), so it fell
  // through to `wait: prune is unsafe` on EVERY tick and the deficit below was
  // never reached (Luna Max sat at 42/50 for hours with zero spawns).
  const attestationStillProbed = (ownerId: string): boolean =>
    currentProbeOwners.has(ownerId) && (attempts[ownerId] ?? 0) < retryLimit;
  const unreadyMemberIds = liveMemberIds.filter(
    (ownerId) =>
      !retired.has(ownerId) &&
      attestationByOwner.has(ownerId) &&
      attestationByOwner.get(ownerId)?.ready !== true &&
      (attestationStillProbed(ownerId) || !args.executingMemberIds?.has(ownerId)),
  );
  const unverifiedMemberIds = liveMemberIds.filter(
    (ownerId) => !retired.has(ownerId) && !attestationByOwner.has(ownerId),
  );
  const terminalFailureIds = new Set(
    (transaction?.failed ?? [])
      .filter((failure) => failure.phase === 'verification' || failure.phase === 'attestation')
      .map((failure) => failure.ownerId),
  );
  const verified = new Set(transaction?.verifiedMemberIds ?? []);
  const pruneCandidateIds = unreadyMemberIds.filter(
    (ownerId) =>
      !args.executingMemberIds?.has(ownerId) &&
      (attempts[ownerId] ?? 0) >= retryLimit &&
      (verified.has(ownerId) || terminalFailureIds.has(ownerId)),
  );
  // WI-2034601: an opened member that never became live must be bounded by the launch
  // window REGARDLESS of whether it verified. The predicate here used to read
  //
  //     !verified.has(ownerId) || elapsed < FLEET_HEADCOUNT_LAUNCH_WINDOW_MS
  //
  // and that disjunction SHORT-CIRCUITS: for an UNVERIFIED member `!verified` is already
  // true, so the elapsed bound was never evaluated and the member stayed pending forever —
  // while a member that HAD verified was the only one the deadline could ever retire. The
  // bound was applied exactly backwards with respect to the failure it exists to catch: a
  // registered-but-never-first-turn member is by definition unverified, so it took the
  // unbounded branch every time. Observed before this fix: fleet nonp2p-bug-drain's launch
  // transaction re-decided `wait` for one such member 278 times across ~3.5 days while the
  // fleet sat at deficit 50.
  const openedButNotLive = (transaction?.openedMemberIds ?? []).filter(
    (ownerId) =>
      !retired.has(ownerId) &&
      !live.has(ownerId) &&
      !terminalFailureIds.has(ownerId),
  );
  // Transaction-scoped, not per-member: `openedMemberIds` carries no per-member open
  // timestamp, so `requestedAt` is the only elapsed signal available — which is also what
  // the previous predicate used. A hard deadline measured from the transaction start is
  // strictly tighter than the unbounded wait it replaces.
  const withinLaunchWindow =
    (args.now ?? Date.now()) - (transaction?.requestedAt ?? 0) < FLEET_HEADCOUNT_LAUNCH_WINDOW_MS;
  const pendingOpenedMemberIds = withinLaunchWindow ? openedButNotLive : [];
  // Past the deadline these are LAUNCH-FAILED. Leaving the pending set is what makes the
  // governor fall through to the deficit path and spawn replacements, instead of returning
  // `wait` on every tick for the life of the transaction.
  const launchDeadlineExceededMemberIds = withinLaunchWindow ? [] : openedButNotLive;
  const retryable = unreadyMemberIds.filter(
    (ownerId) => currentProbeOwners.has(ownerId) && (attempts[ownerId] ?? 0) < retryLimit,
  );
  // WI-6554700010029353: only an unready member the governor is STILL PROBING may hold
  // refill. A probe owner is re-attested every tick (refreshGovernorWorkerAttestation),
  // so its evidence can still move to ready, to verified-and-prunable, or to a terminal
  // failure, and waiting for that is bounded. An unready member OUTSIDE probeOwnerIds is a
  // frozen snapshot: nothing re-takes its attestation and its attempt count never grows,
  // so it can never become a prune candidate either. Letting it gate the deficit branch
  // made the wait unbounded by construction. It also contradicted the headcount itself:
  // such a member is not executing, so it is already excluded from the productive count.
  // An ordinary idle member gets replaced through that deficit, while one with a stale
  // ready:false stalled every spawn (Luna Max, 2026-10-26 10:15Z: one member silent 28m
  // held a 42/50 fleet at `wait`). Frozen members still never get pruned. They are only
  // treated like every other non-productive member.
  const probedUnreadyMemberIds = unreadyMemberIds.filter((ownerId) => currentProbeOwners.has(ownerId));
  const frozenUnreadyMemberIds = unreadyMemberIds.filter((ownerId) => !currentProbeOwners.has(ownerId));
  const headcountMeasurement = measureFleetProductiveHeadcount(
    transaction,
    liveMemberIds,
    args.executingMemberIds,
  );
  const productiveMemberCount = headcountMeasurement.current;
  const deficit = productiveMemberCount == null
    ? 0
    : computeHeadcountDeficit(target, productiveMemberCount);

  const common = {
    target,
    productiveCapacityFloor,
    liveMemberIds,
    workerReadyMemberIds,
    unreadyMemberIds,
    frozenUnreadyMemberIds,
    unverifiedMemberIds,
    pendingOpenedMemberIds,
    launchDeadlineExceededMemberIds,
    pruneCandidateIds,
    productiveMemberCount,
    headcountBasis: headcountMeasurement.basis,
    deficit,
  };

  if (productiveMemberCount == null) {
    return {
      ...common,
      action: 'wait',
      actionOwnerId: null,
      spawnCount: 0,
      reason: 'productive headcount is unknown; refill fails closed until the live roster and the agent-origin execution attestation are both readable',
    };
  }

  if (pruneCandidateIds.length > 0) {
    return {
      ...common,
      action: 'prune',
      actionOwnerId: pruneCandidateIds[0],
      spawnCount: 1,
      reason: `typed worker stages stayed non-ready for ${retryLimit} governor observation(s)`,
    };
  }
  if (pendingOpenedMemberIds.length > 0) {
    return {
      ...common,
      action: 'wait',
      actionOwnerId: null,
      spawnCount: 0,
      reason: `an opened member is still unverified inside the ${Math.round(FLEET_HEADCOUNT_LAUNCH_WINDOW_MS / 1000)}s launch window; a late healthy boot must settle before replay`,
    };
  }
  if (retryable.length > 0) {
    return {
      ...common,
      action: 'retry',
      actionOwnerId: retryable[0],
      spawnCount: 0,
      reason: 'worker stages are observed but not yet terminal; retry after durable backoff',
    };
  }
  if (probedUnreadyMemberIds.length > 0) {
    return {
      ...common,
      action: 'wait',
      actionOwnerId: null,
      spawnCount: 0,
      reason: 'non-ready evidence lacks a verified-start or terminal-failure proof; prune is unsafe',
    };
  }
  if (deficit > 0) {
    // WI-2034624: the floor asks "has this fleet PROVEN it can run a productive
    // member?", and the count above is no longer the only proof. Left scoped to
    // the current transaction's attestations it stays the SECOND transaction-
    // scoped throttle: a fleet whose members all came from prior transactions
    // has an empty `workerReadyMemberIds`, so even with the deficit now sized
    // correctly it would refill one canary at a time forever. Recent agent-origin
    // execution is strictly stronger evidence of the same thing — a member that
    // is DEMONSTRABLY TAKING TURNS has proven productive capacity more directly
    // than a recorded boot-time attestation ever did. The legacy live-roster
    // fallback is deliberately NOT admitted: a live process is not proof of
    // productivity, which is the distinction this floor exists to draw.
    const attestedExecuting = headcountMeasurement.basis.kind === 'agent-origin-execution-attested'
      ? headcountMeasurement.basis.executingMembers ?? 0
      : 0;
    const floorMet =
      workerReadyMemberIds.length >= productiveCapacityFloor ||
      attestedExecuting >= productiveCapacityFloor;
    const hasUnverifiedSeats = unverifiedMemberIds.length > 0;
    // WI-2034601: when this deficit exists BECAUSE opened members blew the launch
    // deadline, say so on the reason. Without it the governor's move out of `wait`
    // reads as an unexplained replacement instead of a deadline being enforced —
    // and the unexplained version is what let the old unbounded wait hide for days.
    // Empty when no member exceeded the deadline, so the existing reasons are
    // unchanged in the ordinary case.
    const launchFailedPrefix = launchDeadlineExceededMemberIds.length > 0
      ? `${launchDeadlineExceededMemberIds.length} opened member(s) never became live within the ${Math.round(FLEET_HEADCOUNT_LAUNCH_WINDOW_MS / 1000)}s launch window and are classified launch-failed; `
      : '';
    // WI-6554700010029353: same observability duty for a refill that proceeds past
    // frozen unready members, which used to hold `wait` here. Empty otherwise.
    const frozenUnreadyPrefix = frozenUnreadyMemberIds.length > 0
      ? `${frozenUnreadyMemberIds.length} unready member(s) outside the probe cohort hold frozen non-ready evidence; they are not pruned and do not count as productive, so the deficit is refilled; `
      : '';
    return {
      ...common,
      action: 'spawn',
      actionOwnerId: null,
      spawnCount: floorMet
        ? Math.min(deficit, FLEET_HEADCOUNT_BULK_WAVE_SIZE)
        : 1,
      reason: launchFailedPrefix + frozenUnreadyPrefix + (floorMet
        ? hasUnverifiedSeats
          ? 'productive-capacity floor is evidenced; preserve unverified live seats and open a capacity-clamped bounded refill wave'
          : 'productive-capacity floor is evidenced; a bounded refill wave is safe'
        : hasUnverifiedSeats
          ? 'unverified live seats do not satisfy productive headcount and the productive-capacity floor is not yet evidenced; open one canary only'
          : 'productive-capacity floor is not yet evidenced; open one canary only'),
    };
  }
  if (unverifiedMemberIds.length > 0) {
    return {
      ...common,
      action: 'wait',
      actionOwnerId: null,
      spawnCount: 0,
      reason: 'live members without typed worker attestation remain unknown and are never pruned',
    };
  }
  return {
    ...common,
    action: 'none',
    actionOwnerId: null,
    spawnCount: 0,
    reason: 'target and productive-capacity floor are both satisfied',
  };
}

export function governorVerdictForAssessment(
  assessment: FleetHeadcountGovernorAssessment,
  now: number,
  overrides: {
    action?: FleetLaunchGovernorAction;
    reason?: string;
    outcome?: FleetLaunchGovernorVerdict['outcome'];
  } = {},
): FleetLaunchGovernorVerdict {
  const action = overrides.action ?? assessment.action;
  const outcome = overrides.outcome ?? (
    action === 'none'
      ? 'productive'
      : action === 'wait' || action === 'retry'
        ? 'unverified'
        : 'repairing'
  );
  return {
    version: 1,
    outcome,
    decidedAt: now,
    target: assessment.target,
    productiveCapacityFloor: assessment.productiveCapacityFloor,
    liveMemberIds: assessment.liveMemberIds,
    workerReadyMemberIds: assessment.workerReadyMemberIds,
    unreadyMemberIds: assessment.unreadyMemberIds,
    unverifiedMemberIds: [
      ...new Set([...assessment.unverifiedMemberIds, ...assessment.pendingOpenedMemberIds]),
    ],
    productiveMemberCount: assessment.productiveMemberCount,
    headcountBasis: assessment.headcountBasis,
    deficit: assessment.deficit,
    action,
    reason: overrides.reason ?? assessment.reason,
  };
}

function ensureGovernorState(
  transaction: FleetLaunchTransaction,
  probeOwnerIds: readonly string[] = transaction.requestedMemberIds,
): FleetLaunchGovernorState {
  if (!transaction.governor) {
    transaction.governor = {
      version: 1,
      probeOwnerIds: [...new Set(probeOwnerIds)],
      attestationAttempts: {},
      retiredMemberIds: [],
      history: [],
      terminalVerdict: null,
    };
  }
  return transaction.governor;
}

function appendGovernorHistory(
  state: FleetLaunchGovernorState,
  event: FleetLaunchGovernorState['history'][number],
): void {
  state.history = [...state.history, event].slice(-FLEET_HEADCOUNT_HISTORY_LIMIT);
}

function recordGovernorVerdict(
  transaction: FleetLaunchTransaction,
  verdict: FleetLaunchGovernorVerdict,
): void {
  const state = ensureGovernorState(transaction);
  state.terminalVerdict = verdict;
  appendGovernorHistory(state, {
    at: verdict.decidedAt,
    action: 'terminal',
    transactionId: transaction.transactionId,
    reason: `${verdict.outcome}/${verdict.action}: ${verdict.reason}`,
  });
  transaction.updatedAt = verdict.decidedAt;
}

function recordCapacitySnapshot(
  transaction: FleetLaunchTransaction,
  snapshot: FleetLaunchCapacitySnapshot,
): void {
  ensureGovernorState(transaction).capacity = snapshot;
}

/**
 * A bounded launch verifier can miss a healthy member's first turn and observe it on a
 * later governor tick. Keep the durable recovery ledger aligned with that late positive
 * observation: `retryOwnerIds` describes identities whose process start is unresolved,
 * not members whose stricter worker-readiness contract is still incomplete.
 *
 * D-016 remains fail-closed for unrelated legacy seats. This helper only settles members
 * already present in `verifiedMemberIds`; it neither invents typed readiness nor retires an
 * unprobed/non-ready live member.
 */
function reconcileVerifiedGovernorLaunchProgress(
  transaction: FleetLaunchTransaction,
): void {
  const verified = new Set(transaction.verifiedMemberIds);
  transaction.recovery.retryOwnerIds = transaction.recovery.retryOwnerIds.filter(
    (ownerId) => !verified.has(ownerId),
  );
  transaction.unconfirmedMemberIds = (transaction.unconfirmedMemberIds ?? []).filter(
    (ownerId) => !verified.has(ownerId),
  );

  const opened = new Set(transaction.openedMemberIds);
  for (const wave of transaction.waves) {
    const verifiedOwnerIds = wave.ownerIds.filter((ownerId) => verified.has(ownerId));
    if (verifiedOwnerIds.length > 0) wave.verifiedOwnerIds = verifiedOwnerIds;
    if (
      wave.ownerIds.length > 0 &&
      wave.ownerIds.every((ownerId) => opened.has(ownerId) && verified.has(ownerId))
    ) {
      wave.state = 'verified';
    }
  }
  if (transaction.waves.length > 0 && transaction.waves.every((wave) => wave.state === 'verified')) {
    transaction.state = 'verified';
  }
}

async function refreshGovernorWorkerAttestation(
  transaction: FleetLaunchTransaction,
  workspaceId: string,
  now: number,
  expectedAttestations?: FreshLaunchExpectedAttestation[],
): Promise<{ measured: boolean; error: string | null }> {
  const state = ensureGovernorState(transaction);
  // Repair transactions written before the late-verification reconciliation below. A
  // ready member is excluded from the probe cohort, so without this pre-pass an already
  // stale retry row can otherwise survive every future tick indefinitely.
  reconcileVerifiedGovernorLaunchProgress(transaction);
  const retired = new Set(state.retiredMemberIds);
  const ready = new Set(transaction.workerReadyMemberIds ?? []);
  const probeOwnerIds = state.probeOwnerIds.filter(
    (ownerId) => !retired.has(ownerId) && !ready.has(ownerId),
  );
  if (probeOwnerIds.length === 0) return { measured: true, error: null };
  if (!transaction.launcherOwnerId) {
    return {
      measured: false,
      error: 'legacy launch transaction has no launcherOwnerId/--launched-by correlation key',
    };
  }

  try {
    const verdict = await verifyFreshLaunchStarted(
      {
        workspaceId,
        launcherOwnerId: transaction.launcherOwnerId,
        since: transaction.requestedAt,
        expected: probeOwnerIds.length,
        expectedOwnerIds: probeOwnerIds,
        ...(expectedAttestations?.length ? { expectedAttestations } : {}),
      },
      { timeoutMs: FLEET_HEADCOUNT_VERIFY_TIMEOUT_MS },
    );
    mergeFleetLaunchWorkerAttestations(transaction, verdict.sessions);

    const byOwner = new Map(
      verdict.sessions
        .filter((session) => typeof session.ownerId === 'string')
        .map((session) => [session.ownerId as string, session]),
    );
    for (const ownerId of probeOwnerIds) {
      const session = byOwner.get(ownerId);
      if (!session) continue;
      state.attestationAttempts[ownerId] = session.workerAttestation.ready
        ? 0
        : (state.attestationAttempts[ownerId] ?? 0) + 1;
    }

    const verifiedNow = new Set(
      verdict.sessions
        .filter((session) => session.ownerId != null && session.successfulCalls > 0)
        .map((session) => session.ownerId as string),
    );
    transaction.verifiedMemberIds = [
      ...new Set([...transaction.verifiedMemberIds, ...verifiedNow]),
    ];
    const unconfirmed = new Set(transaction.unconfirmedMemberIds ?? []);
    for (const ownerId of probeOwnerIds) {
      if (verifiedNow.has(ownerId) || verdict.agentStarted === false) unconfirmed.delete(ownerId);
      else unconfirmed.add(ownerId);
    }
    transaction.unconfirmedMemberIds = [...unconfirmed];
    reconcileVerifiedGovernorLaunchProgress(transaction);

    if (verdict.agentStarted === false) {
      const phase = verdict.note.includes('ATTESTATION MISMATCH') ? 'attestation' : 'verification';
      const failedOwnerIds = verdict.sessions
        .filter((session) =>
          session.ownerId != null && (
            phase === 'verification' ||
            (session.successfulCalls > 0 && session.attestationDiffs.length > 0)
          ),
        )
        .map((session) => session.ownerId as string);
      for (const ownerId of failedOwnerIds) {
        if (!transaction.failed.some((failure) => failure.ownerId === ownerId && failure.phase === phase)) {
          transaction.failed.push({ ownerId, phase, reason: verdict.note });
        }
      }
    }
    appendGovernorHistory(state, {
      at: now,
      action: verdict.workerReady ? 'observe' : 'retry',
      transactionId: transaction.transactionId,
      reason: verdict.note.slice(0, 500),
    });
    transaction.updatedAt = now;
    return { measured: true, error: null };
  } catch (error) {
    return {
      measured: false,
      error: `worker-attestation refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function killOutcome(res: unknown): { ok: boolean; alreadyGone: boolean; error: string | null } {
  const data = ((res as { data?: unknown }).data ?? {}) as Record<string, unknown>;
  const counts = data.counts as { failed?: number } | undefined;
  const results = data.results as { ok?: boolean; code?: string; error?: string }[] | undefined;
  const failed = counts?.failed ?? results?.filter((row) => row.ok === false).length ?? 0;
  const alreadyGone = failed > 0 && Boolean(results?.length) && results!.every(
    (row) => row.ok === false && (row.code === 'not_found' || row.error === 'not_found'),
  );
  return {
    ok: failed === 0,
    alreadyGone,
    error: failed === 0 || alreadyGone
      ? null
      : results?.find((row) => row.ok === false)?.error ?? 'fleet:kill failed',
  };
}

/** Legacy target rows predate explicit placement. Fleet restoration is headless
 * unless a persisted profile deliberately requests visible terminals. */
export function resolveFleetHeadcountProfile(
  config: FleetHeadcountConfig,
): FleetHeadcountConfig & { headless: boolean } {
  return { ...config, headless: config.headless ?? true };
}

/**
 * WI-6554700010029298: the mode a governor top-up member launches in. Before this,
 * a top-up passed no mode at all, so every replacement in a drain fleet booted
 * AUTO-only (Luna Max: 721 joiners in 7 days, 0 with a DRAIN row). The recipe's
 * declared mode wins; a legacy recipe without one falls back to the launching
 * leader's live DRAIN row, the same caller-overlay rule launch-on-plan applies.
 */
export function resolveGovernorMemberLaunchMode(args: {
  config: { mode?: unknown };
  launcherModes: ReadonlyArray<{ mode?: unknown }>;
}): LaunchMode | null {
  const fromRecipe = launchModeFromFleetRecipe(args.config);
  if (fromRecipe) return fromRecipe;
  return args.launcherModes.some((row) => row?.mode === 'drain')
    ? launchModeFromFleetRecipe({ mode: 'drain' })
    : null;
}

/** Read the launcher's modes only when the recipe does not already decide; a mode
 * read outage degrades to the recipe's answer instead of refusing the top-up. */
async function readGovernorMemberLaunchMode(
  workspaceId: string,
  launcherOwnerId: string,
  config: { mode?: unknown },
): Promise<LaunchMode | null> {
  if (launchModeFromFleetRecipe(config)) return resolveGovernorMemberLaunchMode({ config, launcherModes: [] });
  try {
    return resolveGovernorMemberLaunchMode({ config, launcherModes: await getModes(workspaceId, launcherOwnerId) });
  } catch {
    return null;
  }
}

/**
 * D-016: resolve the launch SLOT for a governor refill from durable goal
 * context, not from `AgentFleetRecord` or `FleetHeadcountConfig` (neither
 * carries a slot). The goal's `metadata.drainFleet` declaration is the
 * canonical identity written by `mintDrainFleetForGoal`; every other fleet
 * attached to that goal is a plan-fleet member. Fleets outside a goal keep the
 * absent role layer rather than inheriting a persona's `--role`.
 */
export function resolveFleetHeadcountLaunchRole(args: {
  goalId: string | null;
  fleetSlug: string;
  drainFleetSlug: string | null;
}): GoalLaunchRole | null {
  if (!args.goalId) return null;
  // The family rule moved to goal-launch-settings-shared when the fleet-LAUNCH
  // boundary needed it too (P-006). Delegated rather than copied: a governor that
  // disagreed with the launch door about which fleet is the drain fleet would
  // refill a fleet under a different profile than the one it was opened with —
  // silently heterogeneous members, which is the bug EI-20219409083169975 fixed
  // here in the first place.
  return goalFleetMemberSlot(goalFleetFamily(args));
}

/** Resolve the governor's slot from the launcher's goal and its declaration. */
async function resolveFleetHeadcountLaunchRoleForFleet(
  workspaceId: string,
  fleetSlug: string,
  launcherOwnerId: string,
): Promise<GoalLaunchRole | null> {
  let goalId: string | null;
  try {
    goalId = await resolveGoalContext(workspaceId, launcherOwnerId);
  } catch {
    return null;
  }
  if (!goalId) return null;

  try {
    const rows = await getOrgPg().sql<{ drain_fleet: string | null }[]>`
      SELECT metadata->>'drainFleet' AS drain_fleet
        FROM harness_shared.goals
       WHERE id = ${goalId} AND workspace_id = ${workspaceId}
       LIMIT 1`;
    return resolveFleetHeadcountLaunchRole({
      goalId,
      fleetSlug,
      drainFleetSlug: rows[0]?.drain_fleet ?? null,
    });
  } catch {
    // Preserve the resolver's fail-open launch behavior if the declaration
    // read is unavailable; applying a guessed slot could bind the wrong role.
    return null;
  }
}

// WI-6154: this-host identity (PAPERCUSP_HONO_PORT) must win over an inherited
// PAPERCUSP_OPERATOR_URL — see resolveSpawnHostOperatorBaseUrl's doc for why.
const operatorBaseUrl = resolveSpawnHostOperatorBaseUrl;

const FLEET_HEADCOUNT_EVENT_PREFIX = 'fleet:headcount';

interface FleetRefillCapacityDecision {
  /** Number of fresh members the measured provider can admit this wave. */
  allowance: number;
  /** Whether the allowance came from a live, fleet-scoped capacity read. */
  measured: boolean;
  provider: string | null;
  reason: string;
}

/**
 * Read the same fleet-scoped capacity surface used by the Queen. Keeping this
 * behind the existing `fleet:capacity` handler is important: WI-41067 fixed
 * provider resolution there, and duplicating a config/model fallback here would
 * silently re-introduce the wrong-pool refill bug.
 */
async function measureFleetRefillCapacity(args: {
  workspaceId: string;
  fleetSlug: string;
  harness: string;
  requested: number;
  gatewayRouted: boolean;
}): Promise<FleetRefillCapacityDecision> {
  const requested = Math.max(0, Math.floor(args.requested));
  try {
    const { default: capacityTool } = await import('../../agent-tools/fleet/capacity');
    const result = await capacityTool.handler(
      { fleet: args.fleetSlug, headroom: requested },
      {
        workspaceId: args.workspaceId,
        harnessSlug: args.harness,
        principal: {
          slug: 'system:fleet-headcount-governor',
          kind: 'system',
          workspaceId: args.workspaceId,
        },
      } as never,
    );
    const text = (result as { content?: Array<{ type?: string; text?: string }> })
      .content?.find((entry) => entry.type === 'text')?.text;
    const payload = text ? JSON.parse(text) as Record<string, unknown> : null;
    if (!payload || payload.ok !== true) {
      return {
        allowance: 0,
        measured: false,
        provider: null,
        reason: 'fleet capacity read returned no usable report',
      };
    }
    const provider = typeof payload.provider === 'string' ? payload.provider : null;
    const verdict = payload.verdict;
    // An unreachable gateway is explicitly fail-safe in fleet:capacity: do not
    // strand a fleet because an optional diagnostic is down. Unknown/mixed
    // provider scope is different — spawning would guess at the wrong pool, so
    // hold the refill and leave a durable wall for the next governor tick.
    if (payload.reachable !== true) {
      return {
        allowance: requested,
        measured: false,
        provider,
        reason: typeof payload.advice === 'string'
          ? `capacity read unavailable (fail-safe): ${payload.advice}`
          : 'capacity gateway unavailable (fail-safe no clamp)',
      };
    }
    if (verdict !== 'measured' || provider == null) {
      return {
        allowance: 0,
        measured: false,
        provider,
        reason: typeof payload.reason === 'string'
          ? payload.reason
          : 'fleet provider capacity is unknown; refusing an unmeasured refill',
      };
    }
    // `recommendedHeadroom` deliberately preserves a small tier-one floor when
    // the pool is exhausted, so a human placement round can still attempt the
    // highest-priority work. An unattended headcount top-up must not inherit
    // that floor: doing so repeatedly creates gateway-routed members that can
    // only fail until an account becomes serviceable again. Keep the separate
    // `dispatchBudget`/headroom meanings intact and bind this automated caller
    // to the explicit pool-exhaustion verdict. Direct system credentials bypass
    // the gateway pool and must remain eligible.
    if (payload.poolExhausted === true && args.gatewayRouted) {
      const advice = typeof payload.advice === 'string'
        ? payload.advice
        : 'the gateway has no serviceable account';
      return {
        allowance: 0,
        measured: true,
        provider,
        reason: `${provider} gateway account pool is exhausted; automated refill is held until serviceability returns: ${advice}`,
      };
    }
    const recommended = Number(payload.recommendedHeadroom);
    if (!Number.isFinite(recommended)) {
      return {
        allowance: 0,
        measured: false,
        provider,
        reason: 'fleet provider capacity report omitted measured headroom',
      };
    }
    return {
      allowance: Math.min(requested, Math.max(0, Math.floor(recommended))),
      measured: true,
      provider,
      reason: typeof payload.advice === 'string' ? payload.advice : 'fleet provider capacity measured',
    };
  } catch (error) {
    return {
      allowance: 0,
      measured: false,
      provider: null,
      reason: `fleet provider capacity read failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function emitFleetHeadcountEvent(args: {
  workspaceId: string;
  fleetSlug: string;
  kind: 'refill' | 'refill-clamped' | 'refusal';
  summary: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  try {
    const { emitAwaitedEvent } = await import('../../events/await/engine');
    await emitAwaitedEvent({
      key: `${FLEET_HEADCOUNT_EVENT_PREFIX}:${args.fleetSlug}`,
      summary: args.summary,
      payload: { kind: args.kind, fleetSlug: args.fleetSlug, ...args.payload },
      source: 'system:fleet-headcount-governor',
      workspaceId: args.workspaceId,
    });
  } catch {
    // Event delivery is observability. Never turn a successful refill into a
    // failed attempt because a transient await-store write was unavailable.
  }
}

function transactionForGovernorVerdict(args: {
  transaction: FleetLaunchTransaction | null;
  liveMemberIds: readonly string[];
  launcherOwnerId: string | null;
  now: number;
}): FleetLaunchTransaction {
  if (args.transaction) return args.transaction;
  return {
    version: 1,
    transactionId: randomUUID(),
    state: 'partial',
    requestedAt: args.now,
    updatedAt: args.now,
    requestedMemberIds: [...new Set(args.liveMemberIds)],
    openedMemberIds: [],
    verifiedMemberIds: [],
    failed: [],
    waves: [],
    recovery: {
      retryOwnerIds: [],
      nextAction: 'await typed worker evidence; never replace an unverified legacy member',
    },
    ...(args.launcherOwnerId ? { launcherOwnerId: args.launcherOwnerId } : {}),
    governor: {
      version: 1,
      // These members were not launched by this observation transaction. An
      // empty probe cohort prevents a fabricated provenance correlation.
      probeOwnerIds: [],
      attestationAttempts: {},
      retiredMemberIds: [],
      history: [],
      terminalVerdict: null,
    },
  };
}

/**
 * Replace a pre-launcherOwnerId transaction with a truthful observation
 * transaction. Legacy members cannot be correlated to a fabricated
 * `--launched-by` value, so the new transaction deliberately adopts only the
 * independently-live roster and any typed attestations already stored for it;
 * its probe cohort is empty. A later refill wave gets a fresh transaction with
 * the CURRENT leader correlation before any terminal opens.
 *
 * This is a supersession, never an in-place label patch: assigning the current
 * leader to the legacy transaction would make verifyFreshLaunchStarted search
 * for a launch marker those old processes never carried and could misclassify
 * healthy members as failed. The new transaction also clears legacy opened ids,
 * preventing them from looking like pending boots and suppressing a real
 * deficit indefinitely.
 */
export function supersedeLegacyHeadcountTransaction(args: {
  transaction: FleetLaunchTransaction;
  liveMemberIds: readonly string[];
  launcherOwnerId: string;
  now: number;
}): FleetLaunchTransaction {
  if (args.transaction.launcherOwnerId) return args.transaction;

  const liveMemberIds = [...new Set(args.liveMemberIds)];
  const live = new Set(liveMemberIds);
  const workerAttestations = (args.transaction.workerAttestations ?? []).filter(
    (attestation) => attestation.ownerId != null && live.has(attestation.ownerId),
  );
  const workerReadyMemberIds = (args.transaction.workerReadyMemberIds ?? []).filter(
    (ownerId) => live.has(ownerId),
  );
  const verifiedMemberIds = (args.transaction.verifiedMemberIds ?? []).filter(
    (ownerId) => live.has(ownerId),
  );
  const priorHistory = args.transaction.governor?.history ?? [];
  const supersessionEvent: FleetLaunchGovernorState['history'][number] = {
    at: args.now,
    action: 'observe',
    transactionId: args.transaction.transactionId,
    reason:
      `superseded legacy launch transaction ${args.transaction.transactionId} without ` +
      'fabricating a launcher correlation; adopted the independently-live roster as unprobed',
  };
  const history: FleetLaunchGovernorState['history'] = [
    ...priorHistory,
    supersessionEvent,
  ].slice(-FLEET_HEADCOUNT_HISTORY_LIMIT);

  return {
    version: 1,
    transactionId: randomUUID(),
    previousTransactionId: args.transaction.transactionId,
    launcherOwnerId: args.launcherOwnerId,
    state: 'partial',
    requestedAt: args.now,
    updatedAt: args.now,
    requestedMemberIds: liveMemberIds,
    openedMemberIds: [],
    verifiedMemberIds,
    unconfirmedMemberIds: [],
    ...(workerReadyMemberIds.length ? { workerReadyMemberIds } : {}),
    ...(workerAttestations.length ? { workerAttestations } : {}),
    failed: [],
    waves: [],
    recovery: {
      retryOwnerIds: [],
      nextAction: 'legacy launch transaction superseded; assess the live deficit before any refill',
    },
    governor: {
      version: 1,
      // These sessions predate a usable launcher correlation. Empty is
      // intentional: only a newly opened refill wave is eligible for probing.
      probeOwnerIds: [],
      attestationAttempts: {},
      retiredMemberIds: [...new Set(args.transaction.governor?.retiredMemberIds ?? [])],
      history,
      terminalVerdict: null,
      ...(args.transaction.governor?.capacity
        ? { capacity: args.transaction.governor.capacity }
        : {}),
    },
  };
}

/**
 * WI-10008195: the governor top-up's launch profile. The goal profile wins over
 * the fleet config field by field, and the AGENT follows the same precedence as
 * the MODEL so the pair stays coherent (a codex model never ships with the
 * fleet config's default `--agent=claude`, which psu refuses at boot).
 */
export function resolveGovernorMemberLaunchProfile(
  goalEffective: { agent?: FleetHeadcountConfig['agent']; model?: string; effort?: string; account?: string },
  config: Pick<FleetHeadcountConfig, 'agent' | 'model' | 'effort' | 'account'>,
): { agent: FleetHeadcountConfig['agent']; model: string | undefined; effort: string | undefined; account: string } {
  return {
    agent: goalEffective.agent ?? config.agent,
    model: goalEffective.model ?? config.model,
    effort: goalEffective.effort ?? config.effort,
    account: goalEffective.account ?? config.account ?? 'default',
  };
}

function governorLaunchTransaction(args: {
  prior: FleetLaunchTransaction | null;
  liveMemberIds: readonly string[];
  newMemberIds: readonly string[];
  launcherOwnerId: string;
  now: number;
  config: FleetHeadcountConfig & { headless: boolean };
  /** WI-10008195: the RESOLVED agent (goal profile > fleet config), never config.agent alone. */
  agent: FleetHeadcountConfig['agent'];
  model: string | null;
  account: string;
  action: 'spawn' | 'respawn';
}): FleetLaunchTransaction {
  const live = new Set(args.liveMemberIds);
  const priorAttestations = (args.prior?.workerAttestations ?? []).filter(
    (attestation) => attestation.ownerId != null && live.has(attestation.ownerId),
  );
  const priorReady = (args.prior?.workerReadyMemberIds ?? []).filter((ownerId) => live.has(ownerId));
  const priorVerified = (args.prior?.verifiedMemberIds ?? []).filter((ownerId) => live.has(ownerId));
  const history = [...(args.prior?.governor?.history ?? [])];
  if (args.prior) {
    history.push({
      at: args.now,
      action: 'observe',
      transactionId: args.prior.transactionId,
      reason: `preserved prior launch transaction ${args.prior.transactionId} before governor ${args.action}`,
    });
    for (const failure of args.prior.failed) {
      history.push({
        at: args.now,
        action: 'observe',
        transactionId: args.prior.transactionId,
        ownerId: failure.ownerId,
        reason: `preserved ${failure.phase} failure: ${failure.reason}`.slice(0, 500),
      });
    }
  }
  history.push({
    at: args.now,
    action: args.action,
    reason: `${args.action} wave pre-pinned ${args.newMemberIds.length} replacement/refill identity(s)`,
  });
  const requestedMemberIds = [...new Set([...args.liveMemberIds, ...args.newMemberIds])];
  const transaction: FleetLaunchTransaction = {
    version: 1,
    transactionId: randomUUID(),
    ...(args.prior ? { previousTransactionId: args.prior.transactionId } : {}),
    launcherOwnerId: args.launcherOwnerId,
    state: 'launching',
    requestedAt: args.now,
    updatedAt: args.now,
    requestedMemberIds,
    openedMemberIds: [],
    verifiedMemberIds: priorVerified,
    unconfirmedMemberIds: [...args.newMemberIds],
    ...(priorReady.length ? { workerReadyMemberIds: priorReady } : {}),
    ...(priorAttestations.length ? { workerAttestations: priorAttestations } : {}),
    failed: [],
    waves: [{ index: 0, ownerIds: [...args.newMemberIds], state: 'opening' }],
    recovery: {
      retryOwnerIds: [...args.newMemberIds],
      nextAction: 'refresh typed worker attestation before any replay',
    },
    requestedMembers: args.newMemberIds.map((ownerId, index) => ({
      index,
      ownerId,
      agent: args.agent,
      model: args.model,
      account: args.account,
      carry: args.config.carry ?? 'warm',
      headless: args.config.headless,
    })),
    governor: {
      version: 1,
      probeOwnerIds: [...args.newMemberIds],
      attestationAttempts: {},
      retiredMemberIds: [...new Set(args.prior?.governor?.retiredMemberIds ?? [])],
      history: history.slice(-FLEET_HEADCOUNT_HISTORY_LIMIT),
      terminalVerdict: null,
      ...(args.prior?.governor?.capacity
        ? { capacity: args.prior.governor.capacity }
        : {}),
    },
  };
  return transaction;
}

type FleetHeadcountLeaderAdmission =
  | { live: true }
  | { live: false; terminal: boolean; reason: string };

/** A persisted leader id is not launch authority; require complete, current liveness. */
async function readFleetHeadcountLeaderAdmission(args: {
  fleetSlug: string;
  workspaceId: string;
  leaderOwnerId: string | null;
}): Promise<FleetHeadcountLeaderAdmission> {
  if (args.leaderOwnerId == null) {
    return {
      live: false,
      terminal: true,
      reason:
        'headcount repair disarmed: the fleet has no durable leader identity; ' +
        'a live authorized leader must supply a fresh mission before replacement resumes',
    };
  }

  let roster;
  try {
    roster = await listFleetRosterDiagnosed({
      fleetSlug: args.fleetSlug,
      workspaceId: args.workspaceId,
      leaderOwnerId: args.leaderOwnerId,
    });
  } catch (error) {
    return {
      live: false,
      terminal: false,
      reason:
        'headcount repair held: registered leader liveness could not be read; ' +
        (error instanceof Error ? error.message : String(error)),
    };
  }

  const leader = roster.leaderLiveness;
  const leaderEvidenceComplete = leader?.complete === true;
  const leaderLive =
    leaderEvidenceComplete &&
    leader?.presenceRow === true &&
    leader?.sessionState === 'live';
  if (!leaderLive) {
    const unknown = !leaderEvidenceComplete;
    return {
      live: false,
      terminal: !unknown,
      reason: unknown
        ? 'headcount repair held: registered leader liveness is unknown; an unattended member must not inherit an unconfirmed lane'
        : 'headcount repair disarmed: the registered leader is not positively live; ' +
          'a live authorized leader must supply a fresh mission before replacement resumes',
    };
  }

  return { live: true };
}

type FleetHeadcountRepairAdmission =
  | { allowed: true }
  | { allowed: false; terminal?: boolean; reason: string };

/**
 * Unattended repair acts on behalf of a live fleet leader and must launch only
 * into a measured, currently claimable fleet lane. A stored leader id or a
 * stale claim spec alone is not launch authority.
 */
async function readFleetHeadcountRepairAdmission(args: {
  fleetSlug: string;
  workspaceId: string;
  leaderOwnerId: string | null;
  harness?: string;
}): Promise<FleetHeadcountRepairAdmission> {
  const leader = await readFleetHeadcountLeaderAdmission(args);
  if (!leader.live) {
    return {
      allowed: false,
      ...(leader.terminal ? { terminal: true } : {}),
      reason: leader.reason,
    };
  }

  let lane;
  try {
    lane = await readFleetLaneHealthDiagnosed({
      fleet: args.fleetSlug,
      harness: args.harness,
      workspaceId: args.workspaceId,
    });
  } catch (error) {
    return {
      allowed: false,
      reason:
        'headcount repair held: current fleet lane eligibility could not be read; ' +
        (error instanceof Error ? error.message : String(error)),
    };
  }

  const claimable = lane.laneHealth?.effective.claimable;
  if (claimable == null) {
    return {
      allowed: false,
      reason:
        'headcount repair held: current fleet lane eligibility is unknown; ' +
        (lane.unavailable?.detail ?? 'the family-complete claimable count was not measured'),
    };
  }
  if (!(claimable > 0)) {
    const spec = lane.laneHealth?.spec;
    const specRef = spec
      ? ' ' + spec.specId + '@' + (spec.revision ?? 'unknown')
      : '';
    return {
      allowed: false,
      reason:
        'headcount repair held: fleet claim spec' + specRef +
        ' has no currently claimable work; no member was pruned or launched',
    };
  }
  return { allowed: true };
}

async function topUpOneFleet(ctx: SystemActionCtx, fleetSlug: string): Promise<void> {
  const { workspaceId } = ctx;
  // EI-23259368987233359, half 2 of 2 — THE BARRIER A MEMBER IS ACTUALLY OPENED
  // BEHIND. This repeats the check `runFleetHeadcountGovernor` already made, on
  // purpose and for the same reason `claimFleetHeadcountAttempt` repeats the
  // winding-down predicate that `listFleetHeadcountTargets` already applied:
  // either half alone leaves the trap re-armable, because this function is
  // reachable without going through the enumerating sweep.
  //
  // Checked BEFORE claiming the attempt: `claimFleetHeadcountAttempt` advances
  // `headcount_next_attempt_at` by a lease, so claiming first would burn a
  // backoff window on a top-up that is about to be refused anyway and delay the
  // legitimate refill once the stand-down lifts.
  if (await isWorkspaceWideLoopStanddownActive(getOrgPg().sql, { workspaceId })) {
    console.warn(
      `[${FLEET_HEADCOUNT_EVENT_PREFIX}] top-up blocked for ${fleetSlug}: a workspace-wide `
      + 'loop:standdown-all is in force; members would repopulate behind the stand-down',
    );
    return;
  }
  // Exact continuation takes precedence over manufacturing another identity.
  // Both this actor and the interruption routine enter the same durable claim.
  const { sweepSessionInterruptions } = await import('./session-interruption-runtime');
  const recovery = await sweepSessionInterruptions(ctx, false, { fleetSlug });
  const attempt = await claimFleetHeadcountAttempt({ workspaceId, fleetSlug });
  if (!attempt) return;
  const fleet = await getFleet(workspaceId, fleetSlug);
  if (!fleet) return;
  let transaction = fleet.lastLaunchTransaction;
  let persistedLaunchRevision = transaction
    ? { transactionId: transaction.transactionId, updatedAt: transaction.updatedAt }
    : null;
  let liveMemberIds: string[] = [];
  // WI-2034624: the population `current` is sized from. `null` = the telemetry
  // leg failed, which the measurement resolves to UNKNOWN (refill fails closed)
  // rather than to a narrower, transaction-scoped count.
  let executingMemberIds: ReadonlySet<string> | null = null;
  let assessment: FleetHeadcountGovernorAssessment | null = null;
  let claimedLaunchSlotAt: number | null = null;
  let spawnAttempted = false;
  const persistTransaction = async (next: FleetLaunchTransaction): Promise<void> => {
    next.updatedAt = Math.max(
      Date.now(),
      persistedLaunchRevision?.transactionId === next.transactionId
        ? persistedLaunchRevision.updatedAt + 1
        : next.updatedAt,
    );
    const persisted = await setFleetLaunchTransaction({
      workspaceId,
      fleetSlug,
      transaction: next,
      expectedRevision: persistedLaunchRevision,
    });
    if (persisted === false) {
      throw new Error(
        'the durable launch transaction changed concurrently; stale governor evidence was not persisted',
      );
    }
    persistedLaunchRevision = {
      transactionId: next.transactionId,
      updatedAt: next.updatedAt,
    };
  };
  const recordAdmissionRefusal = async (
    reason: string,
    terminal: boolean,
    launcherOwnerId: string | null,
  ): Promise<void> => {
    if (claimedLaunchSlotAt != null) {
      await releaseFleetLaunchSlot({ workspaceId, fleetSlug, at: claimedLaunchSlotAt }).catch(() => {});
      claimedLaunchSlotAt = null;
    }
    if (terminal) {
      await disarmStaleMissionTarget({ workspaceId, fleetSlug, reason });
    }
    if (assessment) {
      transaction = transactionForGovernorVerdict({
        transaction,
        liveMemberIds,
        launcherOwnerId,
        now: Date.now(),
      });
      const verdict = governorVerdictForAssessment(assessment, Date.now(), {
        action: terminal ? 'none' : 'wait',
        outcome: 'unverified',
        reason,
      });
      recordGovernorVerdict(transaction, verdict);
      transaction.recovery.nextAction = reason;
      await persistTransaction(transaction);
    }
    if (!terminal) {
      await recordFleetHeadcountAttempt({ workspaceId, fleetSlug, succeeded: false, error: reason });
    }
  };
  try {
    const config = resolveFleetHeadcountProfile(attempt.config);
    const productiveCapacityFloor = resolveProductiveCapacityFloor(
      attempt.target,
      config.productiveCapacityFloor,
    );
    const now = Date.now();
    liveMemberIds = (await liveFleetMemberIds(fleetSlug, workspaceId, 'launch'))
      .filter((id) => id !== fleet.leaderOwnerId);
    // P-007 / R-17: a member silent past FLEET_MEMBER_SILENCE_THRESHOLD_MS (heartbeats
    // only) does not count, so its seat is refilled. The governor only reaches this
    // point for a fleet that is not winding down, hence fleetPaused:false.
    executingMemberIds = countedMemberSet(
      await readFleetMemberSilence(liveMemberIds, { fleetPaused: false }),
    );
    const pendingOriginals = recovery.protectedOwnerIds.filter(id => !executingMemberIds?.has(id));
    if (pendingOriginals.length > 0) {
      await recordFleetHeadcountAttempt({ workspaceId, fleetSlug, succeeded: false,
        error: `exact member continuation awaiting execution census: ${pendingOriginals.join(', ')}` });
      return;
    }

    // EI-27234017287695175 / EI-27209771505784406: a deliberate loop:end is
    // an admission boundary, just as it is for exact interruption recovery.
    // A stale no-assignment boot must not be killed/replaced for obeying its
    // launch fence. Keep readiness truthful and preserve the stop until an
    // explicit rearm or a new authorized launch replaces the stopped cohort.
    const holdForDeliberateStop = async (): Promise<boolean> => {
      const retired = new Set(transaction?.governor?.retiredMemberIds ?? []);
      const owners = [...new Set([
        ...liveMemberIds,
        ...(transaction?.requestedMemberIds ?? []),
        ...(transaction?.openedMemberIds ?? []),
        ...(transaction?.governor?.probeOwnerIds ?? []),
      ])].filter(owner => !retired.has(owner));
      if (owners.length === 0) return false;
      let reason: string;
      try {
        const loops = await getLoopStatuses(owners);
        const stopped = owners.filter(owner => {
          const loop = loops.get(owner);
          return loop?.active === false && loop.explicitlyEnded === true;
        });
        if (stopped.length === 0) return false;
        reason = `headcount repair held by explicit loop:end: ${stopped.join(', ')}; ` +
          'resolve the current assignment with the fleet leader, then explicitly loop:arm ' +
          'the member or authorize a fresh fleet launch';
      } catch (error) {
        reason = `headcount repair held: deliberate loop-end evidence is unreadable: ` +
          `${error instanceof Error ? error.message : String(error)}`;
      }
      if (claimedLaunchSlotAt != null) {
        await releaseFleetLaunchSlot({ workspaceId, fleetSlug, at: claimedLaunchSlotAt });
        claimedLaunchSlotAt = null;
      }
      assessment = assessFleetHeadcountGovernor({
        target: attempt.target, productiveCapacityFloor, liveMemberIds,
        executingMemberIds, transaction, now: Date.now(),
      });
      transaction = transactionForGovernorVerdict({
        transaction, liveMemberIds, launcherOwnerId: fleet.leaderOwnerId, now: Date.now(),
      });
      const verdict = governorVerdictForAssessment(assessment, Date.now(), {
        action: 'wait', outcome: 'unverified', reason,
      });
      recordGovernorVerdict(transaction, verdict);
      transaction.recovery.nextAction = reason;
      await persistTransaction(transaction);
      await recordFleetHeadcountAttempt({ workspaceId, fleetSlug, succeeded: false, error: reason });
      return true;
    };
    if (await holdForDeliberateStop()) return;

    // Legacy launch records have no truthful --launched-by correlation. Adopt
    // the independently-live roster into a fresh, unprobed transaction before
    // attestation refresh; this removes the permanent wait while preserving the
    // no-duplicate invariant (the deficit is still computed from live members).
    if (transaction && !transaction.launcherOwnerId && fleet.leaderOwnerId) {
      transaction = supersedeLegacyHeadcountTransaction({
        transaction,
        liveMemberIds,
        launcherOwnerId: fleet.leaderOwnerId,
        now,
      });
      await persistTransaction(transaction);
    }

    if (transaction) {
      const refreshed = await refreshGovernorWorkerAttestation(transaction, workspaceId, now);
      if (!refreshed.measured) {
        const assessment = assessFleetHeadcountGovernor({
          target: attempt.target,
          productiveCapacityFloor,
          liveMemberIds,
          executingMemberIds,
          transaction,
          now,
        });
        const verdict = governorVerdictForAssessment(assessment, now, {
          action: 'wait',
          outcome: 'unverified',
          reason: refreshed.error ?? 'worker-attestation refresh is unverified',
        });
        recordGovernorVerdict(transaction, verdict);
        transaction.recovery.nextAction = verdict.reason;
        await persistTransaction(transaction);
        await recordFleetHeadcountAttempt({
          workspaceId,
          fleetSlug,
          succeeded: false,
          error: verdict.reason,
        });
        return;
      }
    }

    assessment = assessFleetHeadcountGovernor({
      target: attempt.target,
      productiveCapacityFloor,
      liveMemberIds,
      executingMemberIds,
      transaction,
      now,
    });

    if (assessment.action === 'spawn' || assessment.action === 'prune') {
      const admission = await readFleetHeadcountRepairAdmission({
        fleetSlug,
        workspaceId,
        leaderOwnerId: fleet.leaderOwnerId,
        harness: config.harness,
      });
      if (!admission.allowed) {
        await recordAdmissionRefusal(admission.reason, admission.terminal === true, fleet.leaderOwnerId);
        return;
      }
    }

    if (assessment.action === 'none' || assessment.action === 'wait' || assessment.action === 'retry') {
      transaction = transactionForGovernorVerdict({
        transaction,
        liveMemberIds,
        launcherOwnerId: fleet.leaderOwnerId,
        now,
      });
      const verdict = governorVerdictForAssessment(assessment, now);
      recordGovernorVerdict(transaction, verdict);
      transaction.recovery.nextAction = verdict.reason;
      await persistTransaction(transaction);
      await recordFleetHeadcountAttempt({
        workspaceId,
        fleetSlug,
        succeeded: assessment.action === 'none',
        ...(assessment.action === 'none' ? {} : { error: assessment.reason }),
      });
      return;
    }

    const launcherOwnerId = fleet.leaderOwnerId;
    if (!launcherOwnerId) {
      transaction = transactionForGovernorVerdict({
        transaction,
        liveMemberIds,
        launcherOwnerId: null,
        now,
      });
      const verdict = governorVerdictForAssessment(assessment, now, {
        action: 'wait',
        outcome: 'failed',
        reason: 'fleet has no durable leader identity; unattended governor launch is refused',
      });
      recordGovernorVerdict(transaction, verdict);
      await persistTransaction(transaction);
      await recordFleetHeadcountAttempt({
        workspaceId,
        fleetSlug,
        succeeded: false,
        error: verdict.reason,
      });
      return;
    }

    const pruneOwnerId = assessment.action === 'prune' ? assessment.actionOwnerId : null;
    const action: 'spawn' | 'respawn' = pruneOwnerId ? 'respawn' : 'spawn';
    const requestedWaveCount = pruneOwnerId ? 1 : assessment.spawnCount;
    let waveCount = requestedWaveCount;

    // Resolve the actual future launch profile before measuring capacity. Goal
    // profiles can override the fleet recipe's account route, and the pool
    // exhaustion gate below only applies when those members use the gateway.
    const goalRole = await resolveFleetHeadcountLaunchRoleForFleet(
      workspaceId,
      fleetSlug,
      launcherOwnerId,
    );
    const requestedGoalLaunch = await resolveGoalLaunch({
      workspaceId,
      launcherOwnerId,
      // D-016 (WI-38048): `config.role` is psu `--role`, a persona — NOT a launch
      // slot, so it must not key the goal's profiles. The slot above is derived
      // from durable goal context instead.
      goalRole,
      fleetSlug,
      count: requestedWaveCount,
    });
    const requestedLaunchProfile = resolveGovernorMemberLaunchProfile(requestedGoalLaunch.effective, config);
    const gatewayRouted = requestedLaunchProfile.account !== 'default' && requestedLaunchProfile.account !== 'system';

    // Capacity is measured before claiming the launch slot or pruning a member.
    // A respawn with no provider headroom must leave the existing member alive;
    // a bulk refill is reduced to the measured allowance rather than consuming
    // a slot and then discovering that the provider is exhausted.
    const capacityDecision = await measureFleetRefillCapacity({
      workspaceId,
      fleetSlug,
      harness: config.harness,
      requested: requestedWaveCount,
      gatewayRouted,
    });
    const residualShortfall = Math.max(0, requestedWaveCount - capacityDecision.allowance);
    const capacitySnapshot: FleetLaunchCapacitySnapshot = {
      measuredAt: Date.now(),
      provider: capacityDecision.provider,
      requested: requestedWaveCount,
      allowance: capacityDecision.allowance,
      residualShortfall,
      measured: capacityDecision.measured,
      wall: residualShortfall > 0 || !capacityDecision.measured
        ? capacityDecision.reason
        : null,
    };
    transaction = transactionForGovernorVerdict({
      transaction,
      liveMemberIds,
      launcherOwnerId,
      now,
    });
    recordCapacitySnapshot(transaction, capacitySnapshot);

    if (capacityDecision.allowance <= 0) {
      const reason =
        `fleet provider capacity refused ${requestedWaveCount} requested member(s): ` +
        capacityDecision.reason;
      const verdict = governorVerdictForAssessment(assessment, capacitySnapshot.measuredAt, {
        action: 'wait',
        outcome: 'failed',
        reason,
      });
      recordGovernorVerdict(transaction, verdict);
      transaction.recovery.nextAction = reason;
      await persistTransaction(transaction);
      await emitFleetHeadcountEvent({
        workspaceId,
        fleetSlug,
        kind: 'refusal',
        summary: reason,
        payload: {
          action,
          requested: requestedWaveCount,
          allowance: 0,
          residualShortfall,
          provider: capacityDecision.provider,
          measured: capacityDecision.measured,
          reason: capacityDecision.reason,
        },
      });
      await recordFleetHeadcountAttempt({
        workspaceId,
        fleetSlug,
        succeeded: false,
        error: reason,
      });
      return;
    }

    if (capacityDecision.allowance < waveCount) {
      waveCount = capacityDecision.allowance;
      appendGovernorHistory(transaction.governor!, {
        at: capacitySnapshot.measuredAt,
        action: 'observe',
        transactionId: transaction.transactionId,
        reason:
          `capacity-clamped ${requestedWaveCount}→${waveCount} member(s) for ` +
          `${capacityDecision.provider ?? 'unknown'}: ${capacityDecision.reason}`,
      });
    }
    // ── The goal ceilings bind the GOVERNOR too (P-004/D-009) ─────────────────
    // This is the path that most needs them. Every other launch door is driven by
    // an agent or a human who would at least see a refusal; this one tops a fleet
    // back up to target on a routine, unattended, forever. Left unwired it would
    // quietly hold a fleet ABOVE a goal's maxAgents indefinitely — refusing the
    // owner's own launches while a background routine ignored the same ceiling.
    //
    // The launcher is the fleet's LEADER: the governor is acting on the leader's
    // behalf, so the goal it serves is the leader's goal context (D-008). The
    // launch slot is inferred from the goal's durable drainFleet declaration;
    // it is not present on the fleet registry/config rows.
    // Capacity can shrink a bulk wave. Re-resolve only in that case so a
    // count-sensitive goal profile still matches the members actually opened.
    const goalLaunch = waveCount === requestedWaveCount
      ? requestedGoalLaunch
      : await resolveGoalLaunch({
          workspaceId,
          launcherOwnerId,
          goalRole,
          fleetSlug,
          count: waveCount,
        });
    if (goalLaunch.refusal) {
      // Recorded as a failed attempt rather than thrown: the governor must keep
      // running (the fleet may shrink back under the ceiling on its own), and the
      // reason belongs on the attempt so an operator sees WHY the fleet is being
      // held below target instead of reading it as the top-up silently breaking.
      transaction = transactionForGovernorVerdict({
        transaction,
        liveMemberIds,
        launcherOwnerId,
        now,
      });
      const verdict = governorVerdictForAssessment(assessment, now, {
        outcome: 'failed',
        reason: goalLaunch.refusal.message,
      });
      recordGovernorVerdict(transaction, verdict);
      transaction.recovery.nextAction = verdict.reason;
      await persistTransaction(transaction);
      await recordFleetHeadcountAttempt({
        workspaceId,
        fleetSlug,
        succeeded: false,
        error: verdict.reason,
      });
      return;
    }

    const envelope = await buildConsoleEnvelope({
      workspaceId,
      slug: config.harness,
      operatorBaseUrl: operatorBaseUrl(),
      skipMcpJson: true,
    });
    let launchContext = config.launchContext;
    if (config.brief) {
      const contextDir = join(papercuspPathForWorkspace(workspaceId), 'launch-context');
      mkdirSync(contextDir, { recursive: true });
      launchContext = join(contextDir, `fleet-${fleetSlug}-headcount-context.md`);
      writeFileSync(
        launchContext,
        composeMemberLaunchContext({
          fleetSlug,
          count: attempt.target,
          carry: config.carry,
          customBriefText: config.brief,
        }),
        'utf8',
      );
    }
    // WI-10008195: the agent backend MUST come from the same precedence as the
    // model. A goal profile pinning a codex model (gpt-6.1-sol) on a fleet whose
    // config.agent defaulted to claude produced `--agent=claude` + a codex model,
    // which psu refuses at boot, so every governor top-up died silently.
    const {
      agent: effectiveAgent,
      model: effectiveModel,
      effort: effectiveEffort,
      account: effectiveAccount,
    } = resolveGovernorMemberLaunchProfile(goalLaunch.effective, config);
    const modelSpec = composeModelSpec(effectiveModel, effectiveEffort) ?? null;
    const newMemberIds = Array.from({ length: waveCount }, () => `su-${randomUUID()}`);
    const memberLaunchMode = await readGovernorMemberLaunchMode(workspaceId, launcherOwnerId, config);
    const commands = newMemberIds.map((ownerId) => injectLaunchedByArg(memberLaunchCommand({
      fleetSlug,
      agent: effectiveAgent,
      harness: config.harness,
      headless: config.headless,
      ownerId,
      workspace: workspaceId,
      launchMode: memberLaunchMode,
      // The goal's profile applies to a governor top-up exactly as it does to the
      // leader's own launches — otherwise a replaced member silently comes back
      // on a different model/account than the one the goal pinned.
      model: effectiveModel,
      effort: effectiveEffort,
      account: effectiveAccount,
      role: config.role,
      launchContext,
      contextSize: config.contextSize,
      compactionLimit: config.compactionLimit,
      carry: config.carry,
      extraArgs: config.extraArgs,
    }), launcherOwnerId).command);
    const expectedAttestations: FreshLaunchExpectedAttestation[] = newMemberIds.map((ownerId) => ({
      ownerId,
      agent: effectiveAgent,
      workspaceId,
      harnessSlug: config.harness,
      // Governor members pull from the fleet claim spec. The persisted plan is
      // the leader fleet's provenance, not a member launch lane; forwarding it
      // transiently claims the parent plan item before scheduler:get_next runs.
      planSlug: null,
      model: modelSpec,
      modelSource: effectiveAgent === 'codex' ? (modelSpec ? 'explicit' : 'configured-default') : null,
      effort: modelEffortFromSpec(modelSpec),
      account: effectiveAccount,
      carry: config.carry ?? 'warm',
      visibility: config.headless ? 'headless' : 'visible',
      fleetSlug,
      fleetRole: 'member',
    }));

    const slot = await claimFleetLaunchSlot({
      workspaceId,
      fleetSlug,
      count: waveCount,
      windowMs: FLEET_HEADCOUNT_LAUNCH_WINDOW_MS,
    });
    if (!slot.won) {
      transaction = transactionForGovernorVerdict({
        transaction,
        liveMemberIds,
        launcherOwnerId,
        now,
      });
      const verdict = governorVerdictForAssessment(assessment, now, {
        action: 'wait',
        outcome: 'unverified',
        reason: `repair suppressed by launch window; prior wave at ${slot.priorAt}`,
      });
      recordGovernorVerdict(transaction, verdict);
      await persistTransaction(transaction);
      await recordFleetHeadcountAttempt({
        workspaceId,
        fleetSlug,
        succeeded: false,
        error: verdict.reason,
      });
      return;
    }
    claimedLaunchSlotAt = slot.at;

    // Launch preflight awaits provider/goal/slot reads. Respect a stop that
    // arrived meanwhile, and release the reservation without opening a process.
    if (!pruneOwnerId && await holdForDeliberateStop()) return;

    // The earlier admission read precedes provider, goal, and slot preflight.
    // Recheck the governing mission at the side-effect boundary so a plan archived
    // or leader reaped during that work cannot open a stale replacement.
    const finalPlanStatus = await terminalPlanStatusForFleet(workspaceId, config);
    if (finalPlanStatus) {
      await recordAdmissionRefusal(
        `plan ${config.plan ?? '(unknown)'} is ${finalPlanStatus}; stale mission has no authorized assignment`,
        true,
        launcherOwnerId,
      );
      return;
    }
    const finalLeader = await readFleetHeadcountLeaderAdmission({
      fleetSlug,
      workspaceId,
      leaderOwnerId: launcherOwnerId,
    });
    if (!finalLeader.live) {
      await recordAdmissionRefusal(finalLeader.reason, finalLeader.terminal, launcherOwnerId);
      return;
    }

    // Persist the measurement before any prune or terminal spawn side effect.
    // The next transaction wave carries this snapshot forward for durable
    // inspection; a failed CAS still releases the launch slot in the catch path.
    await persistTransaction(transaction);

    if (pruneOwnerId) {
      // Launch-stage attestations can lag a member's actual work. Recheck the
      // independent execution/wait signal after the asynchronous launch preflight
      // so a worker that resumed meanwhile is not killed by an old prune decision.
      const currentExecuting = countedMemberSet(
        await readFleetMemberSilence([pruneOwnerId], { fleetPaused: false }),
      );
      if (currentExecuting == null || currentExecuting.has(pruneOwnerId)) {
        await releaseFleetLaunchSlot({ workspaceId, fleetSlug, at: slot.at });
        claimedLaunchSlotAt = null;
        const reason = currentExecuting == null
          ? 'prune deferred: current member execution evidence is unreadable'
          : 'prune deferred: member has current execution or a declared wait';
        const verdict = governorVerdictForAssessment(assessment, Date.now(), {
          action: 'wait',
          outcome: 'unverified',
          reason,
        });
        recordGovernorVerdict(transaction, verdict);
        transaction.recovery.nextAction = reason;
        await persistTransaction(transaction);
        await recordFleetHeadcountAttempt({ workspaceId, fleetSlug, succeeded: false, error: reason });
        return;
      }
      if (await holdForDeliberateStop()) return;
      const killed = killOutcome(await killTool.handler(
        {
          owner: pruneOwnerId,
          reason: `fleet headcount governor: ${assessment.reason}`,
          close_terminal: true,
          workspace: workspaceId,
        } as never,
        {
          principal: {
            slug: 'system:fleet-headcount-governor',
            kind: 'system',
            workspaceId,
          },
          workspaceId,
          harnessSlug: config.harness,
        } as never,
      ));
      if (!killed.ok && !killed.alreadyGone) {
        await releaseFleetLaunchSlot({ workspaceId, fleetSlug, at: slot.at }).catch(() => {});
        claimedLaunchSlotAt = null;
        transaction = transactionForGovernorVerdict({
          transaction,
          liveMemberIds,
          launcherOwnerId,
          now,
        });
        const verdict = governorVerdictForAssessment(assessment, now, {
          action: 'prune',
          outcome: 'failed',
          reason: `typed prune was refused: ${killed.error ?? 'unknown fleet:kill failure'}`,
        });
        recordGovernorVerdict(transaction, verdict);
        await persistTransaction(transaction);
        await recordFleetHeadcountAttempt({
          workspaceId,
          fleetSlug,
          succeeded: false,
          error: verdict.reason,
        });
        return;
      }
      if (transaction) {
        const state = ensureGovernorState(transaction);
        state.retiredMemberIds = [...new Set([...state.retiredMemberIds, pruneOwnerId])];
        transaction.workerReadyMemberIds = (transaction.workerReadyMemberIds ?? [])
          .filter((ownerId) => ownerId !== pruneOwnerId);
        transaction.unconfirmedMemberIds = (transaction.unconfirmedMemberIds ?? [])
          .filter((ownerId) => ownerId !== pruneOwnerId);
        appendGovernorHistory(state, {
          at: now,
          action: 'prune',
          transactionId: transaction.transactionId,
          ownerId: pruneOwnerId,
          replacementOwnerId: newMemberIds[0],
          reason: assessment.reason,
        });
        transaction.updatedAt = now;
        await persistTransaction(transaction);
      }
      liveMemberIds = liveMemberIds.filter((ownerId) => ownerId !== pruneOwnerId);
    }

    const launchTransaction = governorLaunchTransaction({
      prior: transaction,
      liveMemberIds,
      newMemberIds,
      launcherOwnerId,
      now,
      config,
      agent: effectiveAgent,
      model: modelSpec,
      account: effectiveAccount,
      action,
    });
    if (pruneOwnerId) {
      appendGovernorHistory(launchTransaction.governor!, {
        at: now,
        action: 'respawn',
        transactionId: launchTransaction.transactionId,
        ownerId: pruneOwnerId,
        replacementOwnerId: newMemberIds[0],
        reason: assessment.reason,
      });
    }
    await persistTransaction(launchTransaction);

    const logDir = config.headless ? `${papercuspPathForWorkspace(workspaceId)}/fleet-logs` : null;
    // Keep the original cohort until this last fence passes. A reserved new
    // identity has no stop history; switching early would erase a stop by the
    // departed member and let the following tick refill it again.
    if (await holdForDeliberateStop()) return;
    transaction = launchTransaction;
    spawnAttempted = true;
    const results = await Promise.all(
      newMemberIds.map((ownerId, i) =>
        config.headless
          ? spawnHeadless({
              envelope: { ...envelope, greetingCmd: commands[i], cwd: envelope.cwd },
              label: `${fleetSlug} · governor member ${i + 1}/${waveCount} (${config.plan ?? 'claim-spec'})`,
              logDir: logDir!,
              launchedBy: launcherOwnerId,
              fleetSlug,
              coordOwnerId: ownerId,
            })
          : spawnConsole({
              envelope: { ...envelope, greetingCmd: commands[i], cwd: envelope.cwd },
              label: `${fleetSlug} · governor member ${i + 1}/${waveCount} (${config.plan ?? 'claim-spec'})`,
              writeMcpJson: false,
              allowDesktopBridge: true,
            }),
      ),
    );
    const openedMemberIds: string[] = [];
    results.forEach((result, index) => {
      const ownerId = newMemberIds[index];
      if (result.status === 'ok') openedMemberIds.push(ownerId);
      else launchTransaction.failed.push({ ownerId, phase: 'spawn', reason: result.error });
    });
    launchTransaction.openedMemberIds = openedMemberIds;
    launchTransaction.waves[0].openedOwnerIds = [...openedMemberIds];
    launchTransaction.governor!.probeOwnerIds = [...openedMemberIds];
    launchTransaction.unconfirmedMemberIds = [...openedMemberIds];
    launchTransaction.recovery.retryOwnerIds = newMemberIds.filter(
      (ownerId) => !openedMemberIds.includes(ownerId),
    );
    launchTransaction.waves[0].state = 'partial';
    await persistTransaction(launchTransaction);

    if (openedMemberIds.length === 0) {
      await releaseFleetLaunchSlot({ workspaceId, fleetSlug, at: slot.at }).catch(() => {});
      claimedLaunchSlotAt = null;
    }

    const refresh = openedMemberIds.length > 0
      ? await refreshGovernorWorkerAttestation(
          launchTransaction,
          workspaceId,
          Date.now(),
          expectedAttestations.filter((item) => openedMemberIds.includes(item.ownerId)),
        )
      : { measured: false, error: 'no member process opened' };
    const verified = new Set(launchTransaction.verifiedMemberIds);
    launchTransaction.recovery.retryOwnerIds = newMemberIds.filter((ownerId) => !verified.has(ownerId));
    if (openedMemberIds.length === newMemberIds.length && openedMemberIds.every((ownerId) => verified.has(ownerId))) {
      launchTransaction.state = 'verified';
      launchTransaction.waves[0].state = 'verified';
      launchTransaction.waves[0].verifiedOwnerIds = [...openedMemberIds];
    } else {
      launchTransaction.state = 'partial';
    }

    // WI-6554700010029299: record this wave's boot outcome in governor history, which
    // later transactions carry forward. A deterministic boot refusal is then recognised
    // across ticks instead of being retried every 15 minutes indefinitely.
    const governorState = ensureGovernorState(launchTransaction);
    const waveBootFailure = bootFailureWaveFingerprint(launchTransaction.failed, newMemberIds);
    if (waveBootFailure != null) {
      appendGovernorHistory(governorState, {
        at: Date.now(),
        action: 'boot-failure',
        transactionId: launchTransaction.transactionId,
        reason: waveBootFailure,
      });
    } else if (newMemberIds.some((ownerId) => verified.has(ownerId))) {
      appendGovernorHistory(governorState, {
        at: Date.now(),
        action: 'boot-ok',
        transactionId: launchTransaction.transactionId,
        reason: 'wave verified at least one member',
      });
    }
    const bootStreak = waveBootFailure != null ? bootFailureStreak(governorState.history) : null;
    const bootFailureHold = bootStreak != null && bootStreak.count >= FLEET_HEADCOUNT_BOOT_FAILURE_STREAK
      ? bootStreak
      : null;

    let rosterError: string | null = null;
    try {
      liveMemberIds = (await liveFleetMemberIds(fleetSlug, workspaceId, 'launch'))
        .filter((id) => id !== launcherOwnerId);
      // Re-attest over the post-launch roster: the members just opened are the
      // ones whose execution the next deficit must account for.
      executingMemberIds = countedMemberSet(
        await readFleetMemberSilence(liveMemberIds, { fleetPaused: false }),
      );
    } catch (error) {
      rosterError = `post-launch live roster read failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    assessment = assessFleetHeadcountGovernor({
      target: attempt.target,
      productiveCapacityFloor,
      liveMemberIds,
      executingMemberIds,
      transaction: launchTransaction,
      now: Date.now(),
    });
    const spawnFailures = results.length - openedMemberIds.length;
    const terminalReason = spawnFailures > 0
      ? `${spawnFailures}/${results.length} ${config.headless ? 'headless' : 'visible'} governor spawn(s) failed`
      : refresh.error ?? rosterError ?? assessment.reason;
    const terminalVerdict = governorVerdictForAssessment(assessment, Date.now(),
      spawnFailures > 0
        ? { action, outcome: 'failed', reason: terminalReason }
        : refresh.error || rosterError
          ? { action: 'wait', outcome: 'unverified', reason: terminalReason }
          : {});
    recordGovernorVerdict(launchTransaction, terminalVerdict);
    launchTransaction.recovery.nextAction = terminalVerdict.reason;
    await persistTransaction(launchTransaction);
    const refillEventKind = capacitySnapshot.residualShortfall > 0
      ? 'refill-clamped'
      : 'refill';
    await emitFleetHeadcountEvent({
      workspaceId,
      fleetSlug,
      kind: refillEventKind,
      summary:
        `${action} opened ${openedMemberIds.length}/${waveCount} member(s) ` +
        `with ${capacitySnapshot.provider ?? 'unknown'} provider allowance ` +
        `${capacitySnapshot.allowance}/${capacitySnapshot.requested}`,
      payload: {
        action,
        requested: capacitySnapshot.requested,
        allowance: capacitySnapshot.allowance,
        residualShortfall: capacitySnapshot.residualShortfall,
        provider: capacitySnapshot.provider,
        measured: capacitySnapshot.measured,
        opened: openedMemberIds.length,
        spawnFailures,
        reason: capacitySnapshot.wall,
      },
    });
    const productive = terminalVerdict.outcome === 'productive';
    if (!productive && bootFailureHold) {
      const holdReason = `boot-failure hold: the last ${bootFailureHold.count} governor waves all died at boot with `
        + `'${bootFailureHold.fingerprint}'; relaunch held for ${Math.round(FLEET_HEADCOUNT_BOOT_FAILURE_HOLD_MS / 3_600_000)}h `
        + '(one probe wave after the hold). Fix the boot refusal, then a verified wave clears this.';
      await emitFleetHeadcountEvent({
        workspaceId,
        fleetSlug,
        kind: 'refusal',
        summary: `fleet ${fleetSlug}: ${holdReason}`,
        payload: {
          reason: 'boot-failure-hold',
          fingerprint: bootFailureHold.fingerprint,
          consecutiveWaves: bootFailureHold.count,
          holdMs: FLEET_HEADCOUNT_BOOT_FAILURE_HOLD_MS,
        },
      });
      await recordFleetHeadcountAttempt({
        workspaceId,
        fleetSlug,
        succeeded: false,
        error: holdReason,
        holdMs: FLEET_HEADCOUNT_BOOT_FAILURE_HOLD_MS,
      });
    } else {
      await recordFleetHeadcountAttempt({
        workspaceId,
        fleetSlug,
        succeeded: productive,
        ...(productive ? {} : { error: terminalVerdict.reason }),
      });
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (claimedLaunchSlotAt != null && !spawnAttempted) {
      await releaseFleetLaunchSlot({
        workspaceId,
        fleetSlug,
        at: claimedLaunchSlotAt,
      }).catch(() => {});
      claimedLaunchSlotAt = null;
    }
    if (transaction && assessment) {
      const verdict = governorVerdictForAssessment(assessment, Date.now(), {
        action: 'wait',
        outcome: 'failed',
        reason,
      });
      recordGovernorVerdict(transaction, verdict);
      transaction.recovery.nextAction = verdict.reason;
      await persistTransaction(transaction).catch(() => {});
    }
    await recordFleetHeadcountAttempt({
      workspaceId,
      fleetSlug,
      succeeded: false,
      error: reason,
    });
  }
}

/** A terminal or archived plan has no authorized assignment for governor replacements. */
const TERMINAL_PLAN_STATUSES = new Set(['shipped', 'superseded']);

/**
 * WI-1457060: is this fleet's configured plan finished?
 *
 * The governor reasoned only about member headcount and readiness — never about whether
 * the WORK still existed — so a fleet whose plan had shipped kept having replacements
 * opened forever. Measured 2026-08-31: `pui-remediation-ship-2026-08-28` sat at target 4
 * with `headless:false` against a shipped plan, i.e. four desktop windows reopening in
 * perpetuity, and `capless-inference-gateway-ship-2026-08-28` had opened 20 members in 23h.
 *
 * WI-1454201 closed the sibling path (a fleet explicitly wound down). This closes the one
 * where nobody ever said "stop" because the work simply ran out.
 *
 * FAILS OPEN, deliberately. A missing config field, an unmatched plan row, or a database
 * error returns null and the fleet is topped up as before: a fleet doing real work must
 * never be disarmed because a status lookup failed. Only a positive terminal status or
 * archived=true reading disarms.
 */
async function terminalPlanStatusForFleet(
  workspaceId: string,
  config: FleetHeadcountConfig | undefined,
): Promise<string | null> {
  const planSlug = typeof config?.plan === 'string' ? config.plan : null;
  const harnessSlug = typeof config?.harness === 'string' ? config.harness : null;
  if (!planSlug || !harnessSlug) return null;
  try {
    const rows = await getOrgPg().sql<{ status: string | null; archived: boolean }[]>`
      SELECT status, archived
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${harnessSlug}
         AND plan_slug = ${planSlug}
       LIMIT 1
    `;
    const plan = rows[0];
    if (plan?.archived === true) return 'archived';
    const status = plan?.status ?? null;
    return status && TERMINAL_PLAN_STATUSES.has(status) ? status : null;
  } catch {
    return null;
  }
}

async function disarmStaleMissionTarget(args: {
  workspaceId: string;
  fleetSlug: string;
  reason: string;
}): Promise<void> {
  await setFleetHeadcountTarget({
    workspaceId: args.workspaceId,
    fleetSlug: args.fleetSlug,
    target: null,
  });
  await recordFleetHeadcountAttempt({
    workspaceId: args.workspaceId,
    fleetSlug: args.fleetSlug,
    succeeded: false,
    error: args.reason,
  });
  console.warn(
    `[${FLEET_HEADCOUNT_EVENT_PREFIX}] disarmed ${args.fleetSlug}: ${args.reason}; ` +
      'launch recipe preserved; a live authorized leader must supply and arm a fresh mission',
  );
}

/** R5 (interrupted-member-recovery-hardening-2026-09-01): the per-fleet
 * supervise/auto-topup GRANT. Only a fleet whose persisted launch recipe
 * explicitly carries `supervise: true` is eligible for ANY governor action.
 * A recipe persisted for reuse/respawn alone (D-008/WI-41145 — every fresh
 * homogeneous plan fleet gets one) is deliberately NOT consent: without this
 * filter, flipping FLEET_HEADCOUNT_GOVERNOR ON would auto-top-up every fleet
 * ever launched. Legacy rows with no config can never be granted. */
export function grantingHeadcountTargets(
  targets: readonly FleetHeadcountTarget[],
): FleetHeadcountTarget[] {
  return targets.filter((target) => target.config?.supervise === true);
}

/**
 * P-005 / D-030: a no-top-up rule SUSPENDS holding; when its `until` passes
 * without re-ratification the suspension ends and the governor restores what
 * the rule suspended (target and/or supervise grant). A fleet whose plan is
 * terminal only has the rule cleared, mirroring the terminal-plan disarm below,
 * so an expiry can never re-arm finished work. Returns the lapses performed.
 */
export async function lapseExpiredTopUpRules(
  workspaceId: string,
  now: number = Date.now(),
): Promise<Array<{ fleetSlug: string; restored: boolean; rule: FleetTopUpRule }>> {
  const done: Array<{ fleetSlug: string; restored: boolean; rule: FleetTopUpRule }> = [];
  for (const expired of (await listExpiredFleetTopUpRules(workspaceId, now)).slice(0, 8)) {
    const terminalStatus = await terminalPlanStatusForFleet(workspaceId, expired.config);
    const restored = !terminalStatus;
    const lapsed = await lapseFleetTopUpRule({
      workspaceId,
      fleetSlug: expired.fleetSlug,
      expectedUntil: expired.rule.until,
      restore: restored,
      now,
    });
    if (!lapsed) continue; // re-ratified or wound down concurrently
    done.push({ fleetSlug: expired.fleetSlug, restored, rule: expired.rule });
    console.warn(
      `[${FLEET_HEADCOUNT_EVENT_PREFIX}] no-top-up rule on ${expired.fleetSlug} expired ` +
        `(ratified by ${expired.rule.ratifiedBy}: ${expired.rule.reason.slice(0, 120)}); ` +
        (restored
          ? `restored target=${expired.rule.suspendedTarget ?? '(unchanged)'} supervise=${expired.rule.suspendedSupervise ?? '(unchanged)'}`
          : `plan is ${terminalStatus}; rule cleared without restoring`),
    );
  }
  return done;
}

export async function runFleetHeadcountGovernor(ctx: SystemActionCtx): Promise<void> {
  if (!(await getFlag(FLEET_HEADCOUNT_FLAG, 'system').catch(() => false))) return;
  // EI-23259368987233359, half 1 of 2 — a workspace-wide `loop:standdown-all`
  // freezes the CONTROLLER, not just the members' loops. Without this, a
  // stand-down verified at zero live sessions silently repopulated a fleet
  // (five members, four loops, four claims): pausing every loop-su-% row does
  // nothing to the governor, and each member it opens arms a fresh loop of its
  // own, so the stand-down manufactured exactly the wakes it existed to stop.
  //
  // Placed here rather than expressed as `control_state = 'winding-down'`,
  // which is the tempting one-line fix and is DESTRUCTIVE: `setFleetControlState`
  // NULLs `headcount_target` on wind-down, so a reversible 4h-TTL stand-down
  // would permanently erase the restoration target of every fleet it touched.
  // Stand-down is reversible by design; wind-down is terminal. Guard, do not
  // wind down.
  if (await isWorkspaceWideLoopStanddownActive(getOrgPg().sql, { workspaceId: ctx.workspaceId })) {
    console.warn(
      `[${FLEET_HEADCOUNT_EVENT_PREFIX}] governor wave skipped: a workspace-wide `
      + 'loop:standdown-all is in force (auto-resumes on its TTL, which lifts this hold too)',
    );
    return;
  }
  // P-005 / D-030: end expired no-top-up rules BEFORE listing granting targets, so
  // a fleet whose rule lapsed is held again on this same tick. Never fatal: a
  // failed lapse leaves the rule expired-and-alarming on every read surface.
  await lapseExpiredTopUpRules(ctx.workspaceId).catch((e) => {
    console.warn(
      `[${FLEET_HEADCOUNT_EVENT_PREFIX}] top-up rule lapse sweep failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  });
  // R5: the flag above is the MASTER gate; the per-fleet grant scopes it. The
  // filter runs BEFORE the wave cap so ungranted rows neither consume the
  // per-tick budget nor receive any action (top-up OR the terminal-plan
  // disarm) — an ungranted armed row is inert by construction, because this
  // sweep is topUpOneFleet's only caller.
  const targets = grantingHeadcountTargets(await listFleetHeadcountTargets(ctx.workspaceId));
  // Bounded one-wave-per-tick: the durable per-fleet lease prevents duplicate
  // opens, while this cap prevents a large fleet registry from creating a burst.
  for (const target of targets.slice(0, 4)) {
    // DISARM rather than skip. Skipping would re-evaluate this fleet every single tick,
    // forever, and leave the armed row looking identical to one still doing work. Clearing
    // the target is a one-shot state transition that is visible in the registry and
    // self-heals the fleets already stuck in this state. The launch RECIPE is preserved
    // (setFleetHeadcountTarget(null) keeps headcount_config), so an explicit re-arm still
    // has the boot-baked model/account/headless/carry contract.
    const terminalStatus = await terminalPlanStatusForFleet(ctx.workspaceId, target.config);
    if (terminalStatus) {
      await disarmStaleMissionTarget({
        workspaceId: ctx.workspaceId,
        fleetSlug: target.fleetSlug,
        reason:
          `plan ${target.config?.plan ?? '(unknown)'} is ${terminalStatus}; ` +
          'stale mission has no authorized assignment',
      });
      continue;
    }
    await topUpOneFleet(ctx, target.fleetSlug);
  }
}

registerSystemAction('fleet-headcount-governor', runFleetHeadcountGovernor);
