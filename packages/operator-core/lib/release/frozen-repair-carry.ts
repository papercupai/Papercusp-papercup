/**
 * P-010 (green-main-cycle-time-2026-10-08, D-026): CARRY a retired frozen queue's admitted
 * fixes into whatever candidate the gate cuts next.
 *
 * WHY. A frozen queue's fixes are landed on its lineage by admission (`release:repair-queue
 * admit`). When the queue is retired — automatically by P-021's bounded life, or by the owner's
 * `release:repair-queue { op:'retire' }` — the next candidate is a fresh cut from `staging`, and
 * nothing guaranteed that cut contained those fixes: the quiet cut steps back up to
 * `DEFAULT_QUIET_CUT_SEC` from the tip, and P-012's known-good cut steps back further. A fix
 * committed and admitted inside that window was silently absent from the new candidate.
 *
 * THE RECORD. Every retire writes a PENDING CARRY (`routines.metadata.repair_queue_carry`) in the
 * SAME locked row update that deletes the queue: the retired candidate, its repair head, why it
 * was retired, and each admitted path with the content it admitted. It lives in Postgres, so a
 * restart between the retire and the next cut loses nothing.
 *
 * THE CHECK (pure, here). At the next fresh cut each admitted path is compared by content:
 *  - `carried`              — the candidate holds exactly the admitted content;
 *  - `carried-via-staging`  — the candidate holds the staging tip's current version of the path.
 *    Every admission is taken FROM staging, so staging's current version is the authoritative
 *    successor of the fix (it holds the fix plus later work, or deliberately dropped it). This arm
 *    is what makes hunk-exact admissions — whose admitted blob is synthesized and need not equal
 *    any staging blob — read correctly;
 *  - `missing`              — the candidate holds neither: an OLDER version of the path;
 *  - `unverified`           — a lookup failed; never read as carried.
 * Any `missing` or `unverified` path makes the gate judge the staging tip instead. The tip holds
 * staging's current version of every path by definition, so the re-assessment there is
 * `carried`/`carried-via-staging` throughout, and that final assessment is what gets recorded.
 *
 * WHAT IT DOES NOT DO. It does not re-admit fixes onto an OLDER commit: that is P-012's job when it
 * picks a known-good target (P-021's `readmitPaths` already lists those paths), and P-012 must
 * consult this record when it does.
 */
import type { FrozenCandidateRepairQueue } from './frozen-candidate-repair-queue';
import { frozenRepairAdmittedContent } from './frozen-repair-bounded-life';

/** Metadata key of the pending carry on the green-checkpoint routine row. */
export const FROZEN_REPAIR_CARRY_METADATA_KEY = 'repair_queue_carry';
/** Metadata key of the most recent consumed carry (the per-cut assessment record). */
export const FROZEN_REPAIR_CARRY_LAST_METADATA_KEY = 'repair_queue_carry_last';
/** At most this many admitted paths are carried; the record says when it was truncated. */
export const FROZEN_REPAIR_CARRY_PATH_CAP = 200;

export type FrozenRepairCarryReason = 'bounded-life' | 'owner-retire';

export interface FrozenRepairCarryAdmittedPath {
  path: string;
  /** Admitted blob/gitlink; `null` = the admission deleted the path; `undefined` = legacy entry. */
  blob: string | null | undefined;
}

export interface FrozenRepairPendingCarry {
  schemaVersion: 1;
  fromCandidate: string;
  fromRepairHead: string;
  reason: FrozenRepairCarryReason;
  retiredAtMs: number;
  admitted: FrozenRepairCarryAdmittedPath[];
  truncated: boolean;
}

export type FrozenRepairCutCarryStatus = 'carried' | 'carried-via-staging' | 'missing' | 'unverified';

export interface FrozenRepairCutCarryEntry {
  path: string;
  status: FrozenRepairCutCarryStatus;
}

export interface FrozenRepairCutCarryAssessment {
  fromCandidate: string;
  reason: FrozenRepairCarryReason;
  candidate: string;
  stagingTip: string;
  entries: FrozenRepairCutCarryEntry[];
  missing: string[];
  unverified: string[];
  /** True when the candidate misses (or cannot be shown to hold) a fix and is not already the tip. */
  advanceToTip: boolean;
}

/** The consumed carry: what the gate judged and how every admitted path was carried into it. */
export interface FrozenRepairCarryRecord {
  schemaVersion: 1;
  fromCandidate: string;
  fromRepairHead: string;
  reason: FrozenRepairCarryReason;
  retiredAtMs: number;
  assessedAtMs: number;
  /** The cut the gate would have judged (the quiet cut), and the paths it lacked. */
  initialCandidate: string;
  initialMissing: string[];
  initialUnverified: string[];
  /** The candidate actually judged, and every admitted path's status in it. */
  judgedCandidate: string;
  advancedToTip: boolean;
  entries: FrozenRepairCutCarryEntry[];
  truncated: boolean;
}

/** Reads one path's blob (or gitlink) at a commit; `null` = the path is absent there. */
export type FrozenRepairCarryBlobLookup = (sha: string, path: string) => Promise<string | null>;

/**
 * PURE: the pending carry a retire must write, or `null` when the queue admitted nothing (an
 * unstarted queue has no fixes to carry).
 */
export function buildFrozenRepairPendingCarry(
  queue: Pick<FrozenCandidateRepairQueue, 'candidate' | 'repairHead' | 'admissions'>,
  reason: FrozenRepairCarryReason,
  nowMs: number,
): FrozenRepairPendingCarry | null {
  const admittedContent = frozenRepairAdmittedContent(queue);
  if (admittedContent.size === 0) return null;
  const paths = [...admittedContent.keys()].sort();
  return {
    schemaVersion: 1,
    fromCandidate: queue.candidate,
    fromRepairHead: queue.repairHead,
    reason,
    retiredAtMs: nowMs,
    admitted: paths.slice(0, FROZEN_REPAIR_CARRY_PATH_CAP).map((path) => ({ path, blob: admittedContent.get(path) })),
    truncated: paths.length > FROZEN_REPAIR_CARRY_PATH_CAP,
  };
}

/**
 * PURE: the pending carry a retire writes, given whatever pending carry the locked row already
 * holds. A carry is consumed only at a fresh cut, so a queue opened on an explicit candidate and
 * retired before any fresh cut would otherwise OVERWRITE an unconsumed carry and lose its fixes.
 * The union keeps both: the newer retire's header and its content for a shared path. An older
 * entry with a legacy (`undefined`) blob is then checked against the newer repair head, which can
 * only make it read `missing` and advance the cut to the tip — the safe direction.
 * Returns `null` when there is nothing to carry (no prior carry and no admissions).
 */
export function nextFrozenRepairPendingCarry(
  storedPrior: unknown,
  queue: Pick<FrozenCandidateRepairQueue, 'candidate' | 'repairHead' | 'admissions'>,
  reason: FrozenRepairCarryReason,
  nowMs: number,
): FrozenRepairPendingCarry | null {
  const prior = parseFrozenRepairPendingCarry(storedPrior);
  const next = buildFrozenRepairPendingCarry(queue, reason, nowMs);
  if (!prior) return next;
  const byPath = new Map<string, FrozenRepairCarryAdmittedPath>();
  for (const entry of prior.admitted) byPath.set(entry.path, entry);
  for (const entry of next?.admitted ?? []) byPath.set(entry.path, entry);
  const paths = [...byPath.keys()].sort();
  return {
    schemaVersion: 1,
    fromCandidate: next?.fromCandidate ?? queue.candidate,
    fromRepairHead: next?.fromRepairHead ?? queue.repairHead,
    reason,
    retiredAtMs: nowMs,
    admitted: paths.slice(0, FROZEN_REPAIR_CARRY_PATH_CAP).map((path) => byPath.get(path)!),
    truncated: prior.truncated || next?.truncated === true || paths.length > FROZEN_REPAIR_CARRY_PATH_CAP,
  };
}

/**
 * Assess whether `candidate` carries every admitted fix of the pending carry. Lookups that fail
 * are `unverified`, never `carried`.
 */
export async function assessFrozenRepairCarryAtCut(input: {
  pending: FrozenRepairPendingCarry;
  candidate: string;
  stagingTip: string;
  blobAt: FrozenRepairCarryBlobLookup;
}): Promise<FrozenRepairCutCarryAssessment> {
  const entries: FrozenRepairCutCarryEntry[] = [];
  for (const admitted of input.pending.admitted) {
    entries.push({ path: admitted.path, status: await cutCarryStatus(input, admitted) });
  }
  const missing = entries.filter((entry) => entry.status === 'missing').map((entry) => entry.path);
  const unverified = entries.filter((entry) => entry.status === 'unverified').map((entry) => entry.path);
  return {
    fromCandidate: input.pending.fromCandidate,
    reason: input.pending.reason,
    candidate: input.candidate,
    stagingTip: input.stagingTip,
    entries,
    missing,
    unverified,
    advanceToTip: input.candidate !== input.stagingTip && (missing.length > 0 || unverified.length > 0),
  };
}

async function cutCarryStatus(
  input: { pending: FrozenRepairPendingCarry; candidate: string; stagingTip: string; blobAt: FrozenRepairCarryBlobLookup },
  admitted: FrozenRepairCarryAdmittedPath,
): Promise<FrozenRepairCutCarryStatus> {
  try {
    const atCandidate = await input.blobAt(input.candidate, admitted.path);
    let expected = admitted.blob;
    // A legacy admission recorded no blob: the retired repair head carries what was admitted.
    if (expected === undefined) expected = await input.blobAt(input.pending.fromRepairHead, admitted.path);
    if (atCandidate === expected) return 'carried';
    // The tip IS staging's current version; comparing a commit with itself needs no lookup.
    const atTip =
      input.candidate === input.stagingTip ? atCandidate : await input.blobAt(input.stagingTip, admitted.path);
    return atCandidate === atTip ? 'carried-via-staging' : 'missing';
  } catch {
    return 'unverified';
  }
}

/** PURE: the record written when the gate consumes a pending carry at a cut. */
export function buildFrozenRepairCarryRecord(input: {
  pending: FrozenRepairPendingCarry;
  initial: FrozenRepairCutCarryAssessment;
  judged: FrozenRepairCutCarryAssessment;
  nowMs: number;
}): FrozenRepairCarryRecord {
  return {
    schemaVersion: 1,
    fromCandidate: input.pending.fromCandidate,
    fromRepairHead: input.pending.fromRepairHead,
    reason: input.pending.reason,
    retiredAtMs: input.pending.retiredAtMs,
    assessedAtMs: input.nowMs,
    initialCandidate: input.initial.candidate,
    initialMissing: input.initial.missing,
    initialUnverified: input.initial.unverified,
    judgedCandidate: input.judged.candidate,
    advancedToTip: input.judged.candidate !== input.initial.candidate,
    entries: input.judged.entries,
    truncated: input.pending.truncated,
  };
}

const REASONS: readonly FrozenRepairCarryReason[] = ['bounded-life', 'owner-retire'];
const CUT_STATUSES: readonly FrozenRepairCutCarryStatus[] = ['carried', 'carried-via-staging', 'missing', 'unverified'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Parse a stored pending carry; anything malformed is `null` (the gate then has nothing to carry). */
export function parseFrozenRepairPendingCarry(value: unknown): FrozenRepairPendingCarry | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  const { fromCandidate, fromRepairHead, reason, retiredAtMs } = value;
  if (typeof fromCandidate !== 'string' || !fromCandidate) return null;
  if (typeof fromRepairHead !== 'string' || !fromRepairHead) return null;
  if (!REASONS.includes(reason as FrozenRepairCarryReason)) return null;
  if (typeof retiredAtMs !== 'number' || !Number.isFinite(retiredAtMs)) return null;
  if (!Array.isArray(value.admitted)) return null;
  const admitted: FrozenRepairCarryAdmittedPath[] = [];
  for (const item of value.admitted) {
    if (!isRecord(item) || typeof item.path !== 'string' || !item.path) return null;
    const blob = item.blob;
    if (blob !== undefined && blob !== null && typeof blob !== 'string') return null;
    admitted.push({ path: item.path, blob: blob as string | null | undefined });
  }
  return {
    schemaVersion: 1,
    fromCandidate,
    fromRepairHead,
    reason: reason as FrozenRepairCarryReason,
    retiredAtMs,
    admitted,
    truncated: value.truncated === true,
  };
}

/** Parse a stored carry record; `null` when absent or malformed. */
export function parseFrozenRepairCarryRecord(value: unknown): FrozenRepairCarryRecord | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  const strings = ['fromCandidate', 'fromRepairHead', 'initialCandidate', 'judgedCandidate'] as const;
  for (const key of strings) if (typeof value[key] !== 'string' || !value[key]) return null;
  if (!REASONS.includes(value.reason as FrozenRepairCarryReason)) return null;
  if (typeof value.retiredAtMs !== 'number' || typeof value.assessedAtMs !== 'number') return null;
  if (!Array.isArray(value.entries)) return null;
  const entries: FrozenRepairCutCarryEntry[] = [];
  for (const item of value.entries) {
    if (!isRecord(item) || typeof item.path !== 'string') return null;
    if (!CUT_STATUSES.includes(item.status as FrozenRepairCutCarryStatus)) return null;
    entries.push({ path: item.path, status: item.status as FrozenRepairCutCarryStatus });
  }
  return {
    schemaVersion: 1,
    fromCandidate: value.fromCandidate as string,
    fromRepairHead: value.fromRepairHead as string,
    reason: value.reason as FrozenRepairCarryReason,
    retiredAtMs: value.retiredAtMs,
    assessedAtMs: value.assessedAtMs,
    initialCandidate: value.initialCandidate as string,
    initialMissing: stringList(value.initialMissing),
    initialUnverified: stringList(value.initialUnverified),
    judgedCandidate: value.judgedCandidate as string,
    advancedToTip: value.advancedToTip === true,
    entries,
    truncated: value.truncated === true,
  };
}

/** One line for logs and the run outcome. */
export function frozenRepairCarrySummary(record: FrozenRepairCarryRecord): string {
  const counts = new Map<FrozenRepairCutCarryStatus, number>();
  for (const entry of record.entries) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
  const parts = CUT_STATUSES.filter((status) => counts.has(status)).map((status) => `${counts.get(status)} ${status}`);
  return (
    `carry from retired ${record.fromCandidate.slice(0, 8)} (${record.reason}) into ${record.judgedCandidate.slice(0, 8)}: ` +
    (parts.length ? parts.join(', ') : 'no admitted paths') +
    (record.advancedToTip
      ? ` — the quiet cut ${record.initialCandidate.slice(0, 8)} lacked ${record.initialMissing.length + record.initialUnverified.length} fix(es), judging the staging tip instead`
      : '') +
    (record.truncated ? ' (carry list truncated)' : '')
  );
}
