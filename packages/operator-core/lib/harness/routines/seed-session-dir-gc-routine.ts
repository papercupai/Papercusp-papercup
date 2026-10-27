/**
 * Seed the `session-dir-gc` routine — the per-session isolation-dir janitor (the
 * EI-155 follow-on; design in `session-dir-gc.ts`, handler in
 * `session-dir-gc-action.ts`).
 *
 *   - `session-dir-gc` (daily 04:30): sweep `session-claude/`, `session-mcp/`,
 *     the codex homes; remove the dirs of not-live, not-resumable sessions past
 *     the retention window. Pure filesystem maintenance — spawns no agent, makes
 *     no network call.
 *
 * SEEDED INACTIVE by default (mirrors seed-improvement-routines / seed-scan).
 * Bring-up is human-confirmed; idempotent (upsert).
 *
 *   tsx seed-session-dir-gc-routine.ts             # seed INACTIVE
 *   tsx seed-session-dir-gc-routine.ts --active     # seed + enable the daily sweep
 *
 * trigger_config knobs (optional, editable via the routines admin):
 *   - retention_days (default 7) — collect a dir unmaterialized this long.
 *   - dry_run (default false)     — plan + log but remove nothing.
 */

import { runRoutineSeed } from './seed-routine-main';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.SESSION_DIR_GC_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Daily at 04:30 — off the busy hours; the sweep is cheap (a stat + a few rm). */
const CRON = '0 30 4 * * *';

void runRoutineSeed({
  scriptTag: 'seed-session-dir-gc-routine',
  prepare: () => {
    const active = process.argv.includes('--active');
    const name = 'session-dir-gc';
    const triggerConfig = { cron: CRON };
    return {
      installSlug: SLUG,
      name: name,
      active,
      triggerConfig: JSON.stringify(triggerConfig),
      targetRole: 'system:session-dir-gc',
    };
  },
  afterSeed: async ({ active, id, workspaceId: ws, sql, name, triggerConfig }) => {
    console.log(
        `[seed-session-dir-gc-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
          `daily sweep of stale per-session isolation dirs (retention 7d). ` +
          (active ? 'Cadence LIVE.' : 'Inactive — enable with --active or the routines admin.'),
      );
  },
});
