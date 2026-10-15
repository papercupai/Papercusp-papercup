/**
 * Read-time derivation of the graph dependency-snapshot health that the gitnexus-reindex
 * routine stores on `harness_shared.routines.metadata.gitnexus_health.dependencySnapshot`.
 *
 * WI-10006666. The stored block is a READING taken at `checkedAt`, not a live value. The
 * routine row is `concurrency: 'skip'`, so while one tick awaits a long analyze, every later
 * fire is dropped before the action runs and nothing re-judges the snapshot. Measured
 * 2026-10-06: a 10:36Z analyze was still running at 12:49Z under pc-heavy memory-PSI
 * freeze/thaw, the 11:36Z and 12:37Z fires logged nothing, and `routines:list` reported
 * `status: 'fresh', ageMs: 34 min` (checked 09:37Z) for a snapshot that was 3h45m old. A
 * reader that trusts those stored fields would keep calling a snapshot past the selector
 * ceiling `fresh` in exactly the condition (a wedged rebuild) that makes it go over-age.
 *
 * So readers derive the age from `generatedAt` at read time. Statuses that do not depend on
 * time (`absent`, `invalid`) pass through untouched. This module is deliberately free of
 * runtime imports from `gitnexus-reindex-action.ts`, which registers a system action on
 * import; a tool module must be able to use it without that side effect.
 */
import type { DependencySnapshotJudgement, DependencySnapshotStatus } from './gitnexus-reindex-action';

/**
 * The selector ceiling, as the read side applies it. PINNED equal to the action's
 * `DEPENDENCY_SNAPSHOT_MAX_AGE_MS` (and through it the selector's `DEFAULT_MAX_AGE_MS`) by
 * `dependency-snapshot-health.test.ts`, so the two cannot drift silently.
 */
export const DEPENDENCY_SNAPSHOT_READ_CEILING_MS = 24 * 60 * 60_000;

/** Statuses whose truth depends on the snapshot's age and so must be re-derived on read. */
const AGE_DEPENDENT: ReadonlySet<DependencySnapshotStatus> = new Set(['fresh', 'behind-index', 'stale']);

export type RevivedDependencySnapshot<T> = T & {
  /** When `ageMs` (and, if it flipped, `status`) were derived: the read, not the stored check. */
  ageDerivedAt?: string;
  /** The stored `ageMs`, as of the stored `checkedAt`. */
  storedAgeMs?: number | null;
  /** Present only when the read flipped the status; the stored value it replaced. */
  storedStatus?: DependencySnapshotStatus;
};

/**
 * Re-derive `ageMs` from `generatedAt` and flip an age-dependent `fresh`/`behind-index` status
 * to `stale` once the snapshot is past the ceiling. Pure. Returns the input unchanged when it
 * has no parseable `generatedAt` or its status is not age-dependent.
 */
export function reviveDependencySnapshotHealth<T extends Partial<DependencySnapshotJudgement>>(
  stored: T,
  nowMs: number,
  ceilingMs: number = DEPENDENCY_SNAPSHOT_READ_CEILING_MS,
): RevivedDependencySnapshot<T> {
  if (!stored || typeof stored !== 'object') return stored;
  const status = stored.status;
  if (!status || !AGE_DEPENDENT.has(status)) return stored;
  const generatedMs = typeof stored.generatedAt === 'string' ? Date.parse(stored.generatedAt) : Number.NaN;
  if (!Number.isFinite(generatedMs)) return stored;
  const ageMs = Math.max(0, nowMs - generatedMs);
  const revived: RevivedDependencySnapshot<T> = {
    ...stored,
    ageMs,
    ageDerivedAt: new Date(nowMs).toISOString(),
    storedAgeMs: stored.ageMs ?? null,
  };
  if (ageMs > ceilingMs && status !== 'stale') {
    revived.status = 'stale';
    revived.reason =
      `older than the ${Math.round(ceilingMs / 3_600_000)}h selector ceiling ` +
      `(derived at read time; the stored check said ${status})`;
    revived.storedStatus = status;
  }
  return revived;
}

/**
 * Apply {@link reviveDependencySnapshotHealth} to a stored `gitnexus_health` metadata value.
 * Anything that is not an object carrying a `dependencySnapshot` object passes through as-is.
 */
export function reviveGitnexusHealth(value: unknown, nowMs: number): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const v = value as Record<string, unknown>;
  const ds = v.dependencySnapshot;
  if (!ds || typeof ds !== 'object' || Array.isArray(ds)) return value;
  return { ...v, dependencySnapshot: reviveDependencySnapshotHealth(ds as Partial<DependencySnapshotJudgement>, nowMs) };
}
