/**
 * P-021 (green-main-cycle-time-2026-10-08, D-023): a BOUNDED LIFE for a frozen repair queue.
 *
 * WHY. Freeze-and-converge holds one candidate until it is green. That is right while repair is
 * converging and wrong when it is not: queue ad82b273 ran 24 rounds over 161h with its failing
 * count going 3 -> ... -> 28 and never reaching 0, holding `main` the whole time (audit
 * rpt_c1597a17 rec 4). This module decides when such a queue has stopped earning its pin.
 *
 * THE RULE (all PURE here; the gate and the store apply it):
 *  - retire when the failing count has made no new low in
 *    `FROZEN_REPAIR_BOUNDED_LIFE_ROUNDS_WITHOUT_LOW` consecutive rounds (`non-improving`), or the
 *    queue is older than `FROZEN_REPAIR_BOUNDED_LIFE_MAX_AGE_MS` (`age`);
 *  - never retire while the count is still making new lows inside 24h (both bounds unmet);
 *  - at most ONE automatic retirement per install per `FROZEN_REPAIR_BOUNDED_LIFE_RETIRE_WINDOW_MS`;
 *    a second trigger inside that window ESCALATES (once per candidate) instead of retiring;
 *  - every retirement records its trigger, rounds-since-low, the re-cut target and the CARRIED
 *    paths (the queue's admitted fixes and whether the re-cut target contains them).
 *
 * WHAT IT DOES NOT CHANGE. The owner-only `release:repair-queue { op:'retire' }` verb, the 8h age
 * escalation cadence (`FROZEN_REPAIR_AGE_ESCALATION_INTERVAL_MS`) and every hold in
 * `decideFrozenCandidateRepairQueue` are untouched. This is a separate, bounded automatic rule;
 * D-023 records why it supersedes "age is never an input" from
 * frozen-candidate-stays-frozen-through-all-fixes-2026-09-03#D-005/#D-011, and the three limits
 * above are the anti-treadmill protections that rule existed for.
 *
 * RE-CUT TARGET. The newest known-good staging commit (P-012) when the caller can name one;
 * until P-012 ships, the current staging tip. CARRY (the P-010 seam): every admission is taken
 * FROM staging, so a staging-tip re-cut contains each admitted fix or a newer staging version of
 * the same file by construction; only a known-good target OLDER than a fix can lack it, and those
 * paths are listed in `readmitPaths` for re-admission onto the new candidate.
 */
import type {
  FrozenCandidateRepairQueue,
  FrozenRepairConvergenceRound,
} from './frozen-candidate-repair-queue';

/** Consecutive rounds without a new failing-count low that end a queue's life. */
export const FROZEN_REPAIR_BOUNDED_LIFE_ROUNDS_WITHOUT_LOW = 4;
/** A queue strictly older than this is retired even while it is still improving. */
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
  /** Rounds after the last round that set a new strict low (the first round sets the first low). */
  roundsSinceLow: number;
  lowestFailingCount: number | null;
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
  | 'admission-precheck-running'
  | 'dispatch-reserved';

interface BoundedLifeBasis {
  trajectory: FrozenRepairConvergenceTrajectory;
  ageMs: number;
}

export type FrozenRepairBoundedLifeDecision =
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
 * SHORTENS `roundsSinceLow` (delays a retirement), never lengthens it — a real new low is below
 * every retained value too — and the age bound still ends the queue.
 */
export function frozenRepairConvergenceTrajectory(
  rounds: readonly FrozenRepairConvergenceRound[] | undefined,
): FrozenRepairConvergenceTrajectory {
  const ordered = [...(rounds ?? [])].sort((a, b) => a.round - b.round);
  let lowest: number | null = null;
  let lowIndex = -1;
  for (let index = 0; index < ordered.length; index += 1) {
    const count = (ordered[index] as FrozenRepairConvergenceRound).failingCount;
    if (lowest === null || count < lowest) {
      lowest = count;
      lowIndex = index;
    }
  }
  const latest = ordered[ordered.length - 1];
  return {
    roundsRecorded: ordered.length,
    roundsSinceLow: lowIndex < 0 ? 0 : ordered.length - 1 - lowIndex,
    lowestFailingCount: lowest,
    latestFailingCount: latest ? latest.failingCount : null,
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

/**
 * PURE: should this queue be retired now? `state` is the install's bounded-life state (null when
 * none was ever recorded). The store re-checks identity, liveness and the rate limit under the
 * routine row lock; this decision is what the gate acts on and what tests drive.
 */
export function decideFrozenRepairBoundedLife(
  queue: FrozenCandidateRepairQueue,
  input: { nowMs: number; state: FrozenRepairBoundedLifeState | null },
): FrozenRepairBoundedLifeDecision {
  const basis: BoundedLifeBasis = {
    trajectory: frozenRepairConvergenceTrajectory(queue.convergenceRounds),
    ageMs: Math.max(0, input.nowMs - queue.openedAtMs),
  };
  const trigger = frozenRepairBoundedLifeTrigger(basis);
  if (!trigger) return { kind: 'within-bounds', ...basis };
  // A promotion is already in flight: main is moving to this lineage. Never cut under it.
  if (queue.phase === 'ready-to-promote') {
    return { kind: 'deferred', trigger, reason: 'promoting', ...basis };
  }
  const precheck = queue.admissionPrecheck;
  if (precheck && precheck.status === 'running' && precheck.expiresAtMs > input.nowMs) {
    return { kind: 'deferred', trigger, reason: 'admission-precheck-running', ...basis };
  }
  if (queue.dispatchReservation && queue.dispatchReservation.expiresAtMs > input.nowMs) {
    return { kind: 'deferred', trigger, reason: 'dispatch-reserved', ...basis };
  }
  const last = input.state?.lastRetire ?? null;
  if (last && input.nowMs - last.retiredAtMs < FROZEN_REPAIR_BOUNDED_LIFE_RETIRE_WINDOW_MS) {
    const prior = input.state?.lastRateLimitedEscalation ?? null;
    const escalate =
      !prior || prior.candidate !== queue.candidate || prior.lastRetireAtMs !== last.retiredAtMs;
    return {
      kind: 'rate-limited',
      trigger,
      lastRetireAtMs: last.retiredAtMs,
      retryAfterMs: last.retiredAtMs + FROZEN_REPAIR_BOUNDED_LIFE_RETIRE_WINDOW_MS - input.nowMs,
      escalate,
      ...basis,
    };
  }
  return { kind: 'retire', trigger, ...basis };
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
