/**
 * The EI-13285 distinct-entity check, shared by every federation projection that lands a
 * remote op on `harness_shared.work_items` (engineer-issues for the issue family,
 * harness-features for the feature family — scope-unique-identifiers-2026-07-26 P-015 /
 * D-019).
 *
 * A work item's creation instant (`created_ts`, epoch ms) is set once at INSERT and never
 * rewritten for a genuine edit or re-delivery of the SAME logical item. So a stored row
 * whose `created_ts` disagrees with an incoming remote op's by more than clock-skew slop is
 * NOT an edit of that row: it is a DIFFERENT item that was allocated the same id (a slot-0
 * WI- id minted before first federation, two databases holding the same node slot, a
 * pre-1442 peer, a restored copy — the residue D-005/D-006 accept in WI- minting). The
 * caller refuses such an op instead of upserting over the local item: a dropped op is
 * bounded, logged, recoverable data loss (the authoring peer's own copy is untouched);
 * silently overwriting was unbounded, permanent local data loss.
 *
 * WI-6327: only a CARRIED `created_ts` is judged. An op without one (every op appended
 * before mig 688 had a drain-time stand-in) fails OPEN, because judging an invented value
 * refused 10,070 distinct ids on the P-302 rig. Callers must not pass a null instant here.
 */
export const COLLISION_CREATED_AT_TOLERANCE_MS = 5_000;

/**
 * Does an incoming op carrying `incomingCreatedTs` name a DIFFERENT item than the stored
 * row created at `existingCreatedTs`? A non-finite value on either side (a NULL column read
 * back as NaN, a malformed wire value) cannot be judged and is never a collision.
 */
export function isDistinctEntityCollision(
  incomingCreatedTs: number,
  existingCreatedTs: number,
): { collided: boolean; existingCreatedAtIso?: string } {
  const incomingMs = Number(incomingCreatedTs);
  const existingMs = Number(existingCreatedTs);
  if (!Number.isFinite(incomingMs) || !Number.isFinite(existingMs)) return { collided: false };
  if (Math.abs(incomingMs - existingMs) <= COLLISION_CREATED_AT_TOLERANCE_MS) return { collided: false };
  return { collided: true, existingCreatedAtIso: new Date(existingMs).toISOString() };
}
