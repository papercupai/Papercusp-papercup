/**
 * Seed the `doc-anchor-reconcile` routine — the periodic FULL doc-anchor reconcile
 * (#5 PART B; design + impl in `docs/sweep-after-sync.ts` → `reconcileAllDocAnchors`,
 * handler in `doc-anchor-reconcile-action.ts`).
 *
 *   - `doc-anchor-reconcile` (daily 05:00): re-derive anchors from CURRENT frontmatter
 *     for ALL anchor-derived (manual/augmented) docs of this harness and rewrite the
 *     denormalised anchor cache where it drifted — the safety net for the git-sync
 *     re-anchor-on-change path (a stale cache that slipped past it). Pure DB/git
 *     maintenance — spawns no agent, makes no LLM call; idempotent (a clean cache is
 *     a no-op). Off-set from telemetry-retention (04:00) + session-dir-gc (04:30).
 *
 * SEEDED INACTIVE by default (mirrors seed-session-dir-gc-routine / seed-telemetry-retention-routine).
 * Bring-up is human-confirmed; idempotent (upsert).
 *
 *   tsx seed-doc-anchor-reconcile-routine.ts             # seed INACTIVE
 *   tsx seed-doc-anchor-reconcile-routine.ts --active     # seed + enable the daily reconcile
 */

import { runRoutineSeed } from './seed-routine-main';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.DOC_ANCHOR_RECONCILE_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Daily at 05:00 — off the busy hours; off-set from telemetry-retention (04:00) + session-dir-gc (04:30). */
const CRON = '0 0 5 * * *';

void runRoutineSeed({
  scriptTag: 'seed-doc-anchor-reconcile-routine',
  prepare: () => {
    const active = process.argv.includes('--active');
    const name = 'doc-anchor-reconcile';
    const triggerConfig = { cron: CRON };
    return {
      installSlug: SLUG,
      name: name,
      active,
      triggerConfig: JSON.stringify(triggerConfig),
      targetRole: 'system:doc-anchor-reconcile',
    };
  },
  afterSeed: async ({ active, id, workspaceId: ws, sql, name, triggerConfig }) => {
    console.log(
        `[seed-doc-anchor-reconcile-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
          `daily full re-derive of doc anchors from current frontmatter (the re-anchor-on-change safety net). ` +
          (active ? 'Cadence LIVE.' : 'Inactive — enable with --active or the routines admin.'),
      );
  },
});
