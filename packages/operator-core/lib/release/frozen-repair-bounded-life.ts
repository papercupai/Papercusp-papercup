/**
 * Historical bounded-life records and convergence telemetry.
 * Owner correction D-090/P-041: automatic candidate retirement is forbidden.
 * Age, failure counts and stalled rounds are diagnostic inputs only. A frozen
 * lineage survives until it is green or an explicit owner retirement occurs.
 */
import {
  FROZEN_REPAIR_PERSISTED_FAILURE_CAP,
  type FrozenCandidateRepairQueue,
  type FrozenRepairConvergenceRound,
} from './frozen-candidate-repair-queue';
import { likeForLikeTrajectory } from './round-one-measurement';

/** Historical threshold retained for diagnostics and old record readers only. */
export const FROZEN_REPAIR_BOUNDED_LIFE_ROUNDS_WITHOUT_LOW = 4;
/** Historical age threshold; it grants no retirement authority. */
export const FROZEN_REPAIR_BOUNDED_LIFE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
/** At most one automatic retirement per install inside this window (D-023 #2). */
export const FROZEN_REPAIR_BOUNDED_LIFE_RETIRE_WINDOW_MS = 24 * 60 * 60 * 1_000;
/** Retained retirement records. Bounded so the routine metadata row cannot grow without limit. */
export const FROZEN_REPAIR_BOUNDED_LIFE_HISTORY_CAP = 10;
/** Carried paths recorded per retirement (the admission ledger is itself capped at 200). */
export const FROZEN_REPAIR_BOUNDED_LIFE_CARRY_CAP = 200;

export type FrozenRepairBoundedLifeTrigger = 'non-improving' | 'age';

/**
 * How the re-cut target holds one admitted path:
 *  - `contained`: the target carries exactly the admitted content;
 *  - `superseded`: the target carries a DIFFERENT version of the path;
 *  - `absent-at-target`: the admitted path does not exist at the target;
 *  - `unverified`: the content could not be read (a lookup failed, or the path is inside a
 *    submodule where a superproject tree read answers nothing). Never read as "contained".
 */
export type FrozenRepairCarryStatus = 'contained' | 'superseded' | 'absent-at-target' | 'unverified';

export interface FrozenRepairCarriedPath {
  path: string;
  status: FrozenRepairCarryStatus;
}

export type FrozenRepairRecutTargetSource = 'known-good' | 'staging-tip';

export interface FrozenRepairRecutTarget {
  sha: string;
  source: FrozenRepairRecutTargetSource;
}

export interface FrozenRepairConvergenceTrajectory {
  roundsRecorded: number;
  /** P-016: rounds whose count is comparable (measured the test population, below the cap). */
  comparableRounds: number;
  /** COMPARABLE rounds after the last one that set a new strict low (the first sets the first low). */
  roundsSinceLow: number;
  lowestFailingCount: number | null;
  /** The latest comparable round's count. */
  latestFailingCount: number | null;
}

export interface FrozenRepairBoundedLifeRecord {
  schemaVersion: 1;
  trigger: FrozenRepairBoundedLifeTrigger;
  retiredAtMs: number;
  candidate: string;
  repairHead: string;
  openedAtMs: number;
  ageMs: number;
  roundsRecorded: number;
  roundsSinceLow: number;
  lowestFailingCount: number | null;
  latestFailingCount: number | null;
  recutTarget: string;
  recutTargetSource: FrozenRepairRecutTargetSource;
  carriedPaths: FrozenRepairCarriedPath[];
  /** Admitted paths the re-cut target does not carry — always empty for a staging-tip re-cut. */
  readmitPaths: string[];
  /** True when the queue had more admitted paths than `FROZEN_REPAIR_BOUNDED_LIFE_CARRY_CAP`. */
  carryTruncated: boolean;
}

export interface FrozenRepairBoundedLifeEscalation {
  candidate: string;
  trigger: FrozenRepairBoundedLifeTrigger;
  atMs: number;
  /** The retirement whose 24h window refused this one. */
  lastRetireAtMs: number;
}

/** Per-install state, stored beside (never inside) the queue so it survives the queue's clear. */
export interface FrozenRepairBoundedLifeState {
  schemaVersion: 1;
  lastRetire: FrozenRepairBoundedLifeRecord | null;
  lastRateLimitedEscalation: FrozenRepairBoundedLifeEscalation | null;
  history: FrozenRepairBoundedLifeRecord[];
}

export type FrozenRepairBoundedLifeDeferral =
  | 'promoting'
  | 'repair-verification-pending'
  | 'admission-precheck-running'
  | 'dispatch-reserved';

interface BoundedLifeBasis {
  trajectory: FrozenRepairConvergenceTrajectory;
  ageMs: number;
}

export type FrozenRepairBoundedLifeDecision =
  | ({ kind: 'disabled' } & BoundedLifeBasis)
  | ({ kind: 'within-bounds' } & BoundedLifeBasis)
  | ({
      kind: 'deferred';
      trigger: FrozenRepairBoundedLifeTrigger;
      reason: FrozenRepairBoundedLifeDeferral;
    } & BoundedLifeBasis)
  | ({ kind: 'retire'; trigger: FrozenRepairBoundedLifeTrigger } & BoundedLifeBasis)
  | ({
      kind: 'rate-limited';
      trigger: FrozenRepairBoundedLifeTrigger;
      lastRetireAtMs: number;
      retryAfterMs: number;
      /** False when this candidate was already escalated after the refusing retirement. */
      escalate: boolean;
    } & BoundedLifeBasis);

/**
 * PURE: the shape of a queue's convergence so far. Rounds are ordered by their stable `round`
 * number. The persisted list keeps the first round plus the newest 23 (cap-trimming), so a
 * minimum in the trimmed middle can make a later retained round look like a new low: that only
 * SHORTENS `roundsSinceLow`, never lengthens it. These values describe convergence;
 * neither this telemetry nor candidate age grants automatic retirement authority.
 */
export function frozenRepairConvergenceTrajectory(
  rounds: readonly FrozenRepairConvergenceRound[] | undefined,
): FrozenRepairConvergenceTrajectory {
  // P-016 (green-main-ratchet-convergence-2026-10-17#D-004): compare like with like. A round
  // that measured no tests, or whose count hit the persistence cap, neither sets a low nor
  // counts as a round without improvement (see `likeForLikeTrajectory`).
  const trajectory = likeForLikeTrajectory(rounds, {
    saturationCap: FROZEN_REPAIR_PERSISTED_FAILURE_CAP,
  });
  return {
    roundsRecorded: trajectory.roundsRecorded,
    comparableRounds: trajectory.comparableRounds,
    roundsSinceLow: trajectory.roundsSinceLow,
    lowestFailingCount: trajectory.lowestFailingCount,
    latestFailingCount: trajectory.latestFailingCount,
  };
}

/** PURE: which bound (if any) the queue has crossed. Non-improving wins when both hold. */
export function frozenRepairBoundedLifeTrigger(
  basis: BoundedLifeBasis,
): FrozenRepairBoundedLifeTrigger | null {
  if (basis.trajectory.roundsSinceLow >= FROZEN_REPAIR_BOUNDED_LIFE_ROUNDS_WITHOUT_LOW) {
    return 'non-improving';
  }
  if (basis.ageMs > FROZEN_REPAIR_BOUNDED_LIFE_MAX_AGE_MS) return 'age';
  return null;
}

/** Current policy: candidate retirement always requires an explicit owner action. */
export function decideFrozenRepairBoundedLife(
  queue: FrozenCandidateRepairQueue,
  input: { nowMs: number; state: FrozenRepairBoundedLifeState | null },
): FrozenRepairBoundedLifeDecision {
  // No automatic retirement, including callers replaying pre-D-090 metadata.
  return {
    kind: 'disabled',
    trajectory: frozenRepairConvergenceTrajectory(queue.convergenceRounds),
    ageMs: Math.max(0, input.nowMs - queue.openedAtMs),
  };
}

/**
 * PURE: the paths this queue admitted, each with the content it admitted (the NEWEST admission
 * of a path wins; `null` = the admission deleted it; `undefined` = a legacy entry recorded no
 * blob for it).
 */
export function frozenRepairAdmittedContent(
  queue: Pick<FrozenCandidateRepairQueue, 'admissions'>,
): Map<string, string | null | undefined> {
  const admitted = new Map<string, string | null | undefined>();
  for (const admission of queue.admissions ?? []) {
    for (const path of admission.paths) {
      const blobs = admission.blobs ?? {};
      admitted.set(path, Object.prototype.hasOwnProperty.call(blobs, path) ? blobs[path] : undefined);
    }
  }
  return admitted;
}

/** Reads one path's blob (or gitlink) at a commit; `null` = the path is absent there. */
export type FrozenRepairBlobLookup = (sha: string, path: string) => Promise<string | null>;

/**
 * Plan the CARRY of a retired queue's admitted fixes onto the re-cut target. Each admitted path
 * is compared with the target by content. Lookups that fail are `unverified`, never `contained`.
 */
export async function planFrozenRepairCarry(input: {
  queue: Pick<FrozenCandidateRepairQueue, 'admissions' | 'repairHead'>;
  target: FrozenRepairRecutTarget;
  blobAt: FrozenRepairBlobLookup;
}): Promise<{ carriedPaths: FrozenRepairCarriedPath[]; readmitPaths: string[]; truncated: boolean }> {
  const admitted = frozenRepairAdmittedContent(input.queue);
  const paths = [...admitted.keys()].sort();
  const truncated = paths.length > FROZEN_REPAIR_BOUNDED_LIFE_CARRY_CAP;
  const carriedPaths: FrozenRepairCarriedPath[] = [];
  for (const path of paths.slice(0, FROZEN_REPAIR_BOUNDED_LIFE_CARRY_CAP)) {
    carriedPaths.push({ path, status: await carryStatus(input, path, admitted.get(path)) });
  }
  // Every admission comes FROM staging, so a staging-tip target holds each fix or a newer
  // staging version of the same file. Only an older known-good target can lack a fix.
  const readmitPaths =
    input.target.source === 'known-good'
      ? carriedPaths
          .filter((entry) => entry.status === 'superseded' || entry.status === 'absent-at-target')
          .map((entry) => entry.path)
      : [];
  return { carriedPaths, readmitPaths, truncated };
}

async function carryStatus(
  input: { queue: Pick<FrozenCandidateRepairQueue, 'repairHead'>; target: FrozenRepairRecutTarget; blobAt: FrozenRepairBlobLookup },
  path: string,
  admittedBlob: string | null | undefined,
): Promise<FrozenRepairCarryStatus> {
  try {
    const atTarget = await input.blobAt(input.target.sha, path);
    let expected = admittedBlob;
    if (expected === undefined) {
      // Legacy admission without recorded blobs: the repair head carries what was admitted.
      expected = await input.blobAt(input.queue.repairHead, path);
      if (expected === null && atTarget === null) return 'unverified';
    }
    if (expected === null) return atTarget === null ? 'contained' : 'superseded';
    if (atTarget === null) return 'absent-at-target';
    return atTarget === expected ? 'contained' : 'superseded';
  } catch {
    return 'unverified';
  }
}

/** PURE: the durable record of one automatic retirement. */
export function buildFrozenRepairBoundedLifeRecord(input: {
  queue: FrozenCandidateRepairQueue;
  decision: Extract<FrozenRepairBoundedLifeDecision, { kind: 'retire' }>;
  nowMs: number;
  target: FrozenRepairRecutTarget;
  carry: { carriedPaths: FrozenRepairCarriedPath[]; readmitPaths: string[]; truncated: boolean };
}): FrozenRepairBoundedLifeRecord {
  const { queue, decision } = input;
  return {
    schemaVersion: 1,
    trigger: decision.trigger,
    retiredAtMs: input.nowMs,
    candidate: queue.candidate,
    repairHead: queue.repairHead,
    openedAtMs: queue.openedAtMs,
    ageMs: decision.ageMs,
    roundsRecorded: decision.trajectory.roundsRecorded,
    roundsSinceLow: decision.trajectory.roundsSinceLow,
    lowestFailingCount: decision.trajectory.lowestFailingCount,
    latestFailingCount: decision.trajectory.latestFailingCount,
    recutTarget: input.target.sha,
    recutTargetSource: input.target.source,
    carriedPaths: input.carry.carriedPaths,
    readmitPaths: input.carry.readmitPaths,
    carryTruncated: input.carry.truncated,
  };
}

/** PURE: state after a retirement (newest first, history bounded). */
export function frozenRepairBoundedLifeStateAfterRetire(
  previous: FrozenRepairBoundedLifeState | null,
  record: FrozenRepairBoundedLifeRecord,
): FrozenRepairBoundedLifeState {
  return {
    schemaVersion: 1,
    lastRetire: record,
    lastRateLimitedEscalation: previous?.lastRateLimitedEscalation ?? null,
    history: [record, ...(previous?.history ?? [])].slice(0, FROZEN_REPAIR_BOUNDED_LIFE_HISTORY_CAP),
  };
}

/** PURE: state after a rate-limited trigger was escalated (dedupes the next tick's escalation). */
export function frozenRepairBoundedLifeStateAfterEscalation(
  previous: FrozenRepairBoundedLifeState | null,
  escalation: FrozenRepairBoundedLifeEscalation,
): FrozenRepairBoundedLifeState {
  return {
    schemaVersion: 1,
    lastRetire: previous?.lastRetire ?? null,
    lastRateLimitedEscalation: escalation,
    history: previous?.history ?? [],
  };
}

const TRIGGERS: readonly FrozenRepairBoundedLifeTrigger[] = ['non-improving', 'age'];
const CARRY_STATUSES: readonly FrozenRepairCarryStatus[] = [
  'contained',
  'superseded',
  'absent-at-target',
  'unverified',
];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nullableCount(value: unknown): number | null | undefined {
  if (value === null) return null;
  return isFiniteNumber(value) ? value : undefined;
}

function parseRecord(value: unknown): FrozenRepairBoundedLifeRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const trigger = raw.trigger as FrozenRepairBoundedLifeTrigger;
  const source = raw.recutTargetSource as FrozenRepairRecutTargetSource;
  const lowest = nullableCount(raw.lowestFailingCount);
  const latest = nullableCount(raw.latestFailingCount);
  if (
    raw.schemaVersion !== 1 ||
    !TRIGGERS.includes(trigger) ||
    (source !== 'known-good' && source !== 'staging-tip') ||
    typeof raw.candidate !== 'string' ||
    typeof raw.repairHead !== 'string' ||
    typeof raw.recutTarget !== 'string' ||
    !isFiniteNumber(raw.retiredAtMs) ||
    !isFiniteNumber(raw.openedAtMs) ||
    !isFiniteNumber(raw.ageMs) ||
    !isFiniteNumber(raw.roundsRecorded) ||
    !isFiniteNumber(raw.roundsSinceLow) ||
    lowest === undefined ||
    latest === undefined
  ) {
    return null;
  }
  const carriedPaths = Array.isArray(raw.carriedPaths)
    ? raw.carriedPaths.flatMap((entry): FrozenRepairCarriedPath[] => {
        const item = entry as Partial<FrozenRepairCarriedPath> | null;
        return item && typeof item.path === 'string' && CARRY_STATUSES.includes(item.status as FrozenRepairCarryStatus)
          ? [{ path: item.path, status: item.status as FrozenRepairCarryStatus }]
          : [];
      })
    : [];
  const readmitPaths = Array.isArray(raw.readmitPaths)
    ? raw.readmitPaths.filter((path): path is string => typeof path === 'string')
    : [];
  return {
    schemaVersion: 1,
    trigger,
    retiredAtMs: raw.retiredAtMs,
    candidate: raw.candidate,
    repairHead: raw.repairHead,
    openedAtMs: raw.openedAtMs,
    ageMs: raw.ageMs,
    roundsRecorded: raw.roundsRecorded,
    roundsSinceLow: raw.roundsSinceLow,
    lowestFailingCount: lowest,
    latestFailingCount: latest,
    recutTarget: raw.recutTarget,
    recutTargetSource: source,
    carriedPaths,
    readmitPaths,
    carryTruncated: raw.carryTruncated === true,
  };
}

/**
 * Parse the persisted state. A malformed row reads as `null` ("nothing recorded"), which can
 * only PERMIT the first retirement of a window — the store's locked transaction parses the same
 * row, so it is the one authority on the rate limit either way.
 */
export function parseFrozenRepairBoundedLifeState(value: unknown): FrozenRepairBoundedLifeState | null {
  let decoded = value;
  if (typeof decoded === 'string') {
    try {
      decoded = JSON.parse(decoded) as unknown;
    } catch {
      return null;
    }
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
  const raw = decoded as Record<string, unknown>;
  if (raw.schemaVersion !== 1) return null;
  const escalationRaw = raw.lastRateLimitedEscalation as Record<string, unknown> | null | undefined;
  const lastRateLimitedEscalation =
    escalationRaw &&
    typeof escalationRaw.candidate === 'string' &&
    TRIGGERS.includes(escalationRaw.trigger as FrozenRepairBoundedLifeTrigger) &&
    isFiniteNumber(escalationRaw.atMs) &&
    isFiniteNumber(escalationRaw.lastRetireAtMs)
      ? {
          candidate: escalationRaw.candidate,
          trigger: escalationRaw.trigger as FrozenRepairBoundedLifeTrigger,
          atMs: escalationRaw.atMs,
          lastRetireAtMs: escalationRaw.lastRetireAtMs,
        }
      : null;
  return {
    schemaVersion: 1,
    lastRetire: parseRecord(raw.lastRetire),
    lastRateLimitedEscalation,
    history: (Array.isArray(raw.history) ? raw.history : [])
      .map(parseRecord)
      .filter((record): record is FrozenRepairBoundedLifeRecord => record !== null)
      .slice(0, FROZEN_REPAIR_BOUNDED_LIFE_HISTORY_CAP),
  };
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

function describeTrigger(record: Pick<FrozenRepairBoundedLifeRecord, 'trigger' | 'roundsSinceLow' | 'ageMs' | 'lowestFailingCount' | 'latestFailingCount'>): string {
  const hours = Math.round(record.ageMs / 3_600_000);
  return record.trigger === 'non-improving'
    ? `${record.roundsSinceLow} rounds without a new failing-count low ` +
        `(lowest ${record.lowestFailingCount ?? 'n/a'}, latest ${record.latestFailingCount ?? 'n/a'}; ${hours}h old)`
    : `${hours}h old, past the ${FROZEN_REPAIR_BOUNDED_LIFE_MAX_AGE_MS / 3_600_000}h bound ` +
        `(${record.roundsSinceLow} rounds since the last low)`;
}

/** One-line summary for logs and escalations. */
export function frozenRepairBoundedLifeSummary(record: FrozenRepairBoundedLifeRecord): string {
  const contained = record.carriedPaths.filter((entry) => entry.status === 'contained').length;
  return (
    `P-021 bounded queue life: retired frozen candidate ${shortSha(record.candidate)} ` +
    `(repairHead ${shortSha(record.repairHead)}) after ${describeTrigger(record)}; ` +
    `re-cut at ${record.recutTargetSource} ${shortSha(record.recutTarget)}; carried ` +
    `${record.carriedPaths.length} admitted path(s), ${contained} contained at the target` +
    (record.readmitPaths.length ? `, ${record.readmitPaths.length} to re-admit` : '') +
    (record.carryTruncated ? ' (carry list truncated)' : '')
  );
}

/** Escalation body for a retirement — the owner reads what was retired, why and what carried. */
export function frozenRepairBoundedLifeRetireBody(record: FrozenRepairBoundedLifeRecord): string {
  const lines = record.carriedPaths
    .slice(0, 40)
    .map((entry) => `- ${entry.path}: ${entry.status}`);
  return [
    frozenRepairBoundedLifeSummary(record),
    '',
    'Rule: plan green-main-cycle-time-2026-10-08#P-021 / #D-023 (at most one automatic retirement per 24h; a second trigger escalates instead).',
    `Carried paths (${record.carriedPaths.length}${record.carryTruncated ? '+' : ''}):`,
    ...(lines.length ? lines : ['- none (the queue admitted no fixes)']),
    ...(record.carriedPaths.length > lines.length
      ? [`- … ${record.carriedPaths.length - lines.length} more in routine metadata repair_queue_bounded_life`]
      : []),
    ...(record.readmitPaths.length
      ? ['', `Re-admit onto the new candidate: ${record.readmitPaths.join(', ')}`]
      : []),
  ].join('\n');
}

/** Escalation body for a trigger refused by the 24h rate limit. */
export function frozenRepairBoundedLifeRateLimitedBody(
  queue: Pick<FrozenCandidateRepairQueue, 'candidate' | 'repairHead'>,
  decision: Extract<FrozenRepairBoundedLifeDecision, { kind: 'rate-limited' }>,
): string {
  const hours = Math.round(decision.ageMs / 3_600_000);
  return [
    `P-021 bounded queue life: frozen candidate ${shortSha(queue.candidate)} (repairHead ` +
      `${shortSha(queue.repairHead)}) crossed its ${decision.trigger} bound ` +
      `(${decision.trajectory.roundsSinceLow} rounds since the last low; ${hours}h old), but an ` +
      `automatic retirement already ran at ${new Date(decision.lastRetireAtMs).toISOString()}.`,
    'At most one automatic retirement per 24h per install (green-main-cycle-time-2026-10-08#D-023), so this one is escalated instead of retired.',
    `The automatic rule may retire it again after ${new Date(decision.lastRetireAtMs + FROZEN_REPAIR_BOUNDED_LIFE_RETIRE_WINDOW_MS).toISOString()}; ` +
      "an owner can retire it now with release:repair-queue { op: 'retire', confirm: true }.",
  ].join('\n');
}
