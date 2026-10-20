/**
 * The immutable winner a memory row names, if any.
 *
 * A closed validity window has two shapes. A SUPERSEDED row carries
 * `superseded_by = <replacement id>`. A soft-forgotten (retracted) row is closed
 * with `superseded_by = NULL`. Both fold to `validity.status = 'superseded'`, so
 * the status alone cannot tell "another replacement won" from "retracted, no
 * successor yet". Supersede callers (memory:update, memory:remember, the write
 * journal drain) treated every closed row as a lost race. They refused with an
 * error naming a winner that did not exist, and closed the only current
 * replacement (EI-26515229747561182). Read the winner instead of the status.
 */
export function supersessionWinner(
  entry: { metadata?: Record<string, unknown> | null } | null | undefined,
): string | null {
  const validity = entry?.metadata?.validity as { superseded_by?: unknown } | undefined;
  const winner = validity?.superseded_by;
  return typeof winner === 'string' && winner.length > 0 ? winner : null;
}
