/**
 * Canonical ID allowlist for positional work-item claims (D-008 / EI-7927).
 * New rows use WI-NNN; legacy rows retain F-NNN / EI-NNN, promoted fixes use
 * F-FIX-NNN, and scheduled plan-run rows use PR-<run>-P-<item>.
 *
 * Keep this leaf free of runtime imports: prompt schema registration needs the
 * pattern without initializing the work-item datastore and its dependencies.
 */
export const WORK_ITEM_ID_PATTERN = '^(?:(?:WI|F|EI)-\\d+|F-FIX-\\d+|PR-\\d+-P-\\d+)$';
