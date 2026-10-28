/**
 * Seed the `acceptance-grading-sweep` routine — the acceptance-grading stall
 * sweep's 60s cadence (acceptance-grading-stall-sweep-2026-08-26 P-004; handler in
 * `acceptance-grading-sweep-action.ts`, orchestration in
 * `../../acceptance-grading-sweep-run.ts`, decision core in
 * `../../acceptance-grading-sweep.ts`).
 *
 * A bespoke `tier:'ephemeral'` seed (interval_sec, NO cron, `next_fire_at = NULL`)
 * rather than a per-install blueprint `triggers.schedule` entry — the sweep is an
 * operator-HOME-level substrate concern (ONE bounded sweep serves every workspace's
 * plans), not a per-blueprint-install cadence, mirroring
 * `seed-consult-expiry-routine.ts`'s documented reasoning. Ephemeral rows are armed
 * by the per-host ephemeral executor (`../../dbos/ephemeral-executor.ts`) on boot —
 * NOT a bare `setInterval` (`lint:no-raw-setinterval`).
 *
 * 60s cadence: the decision core's own thresholds are 2h (re-dispatch) and 12h
 * (escalate), so a one-minute sweep bounds detection overshoot at ~0.8% of the shortest
 * contract. The cadence is deliberately far below both thresholds so that sweep
 * TIMING can never be the thing that decides an outcome — the thresholds decide, and
 * the sweep merely observes often enough not to matter.
 *
 * SEEDED ACTIVE by default: the sweep is bounded on both axes (a scan cap and an
 * action cap per tick), it can only re-dispatch an idempotent grader resolve or mint
 * one condition-keyed work-item, and "finished work never ships dark" (root
 * CLAUDE.md). It cannot grade, score, record a verdict or alter a refusal code —
 * those capabilities are absent from its dependency interface, not merely unused.
 * Pass `--inactive` to seed dark instead.
 *
 *   tsx seed-acceptance-grading-sweep-routine.ts              # seed ACTIVE (default)
 *   tsx seed-acceptance-grading-sweep-routine.ts --inactive   # seed dark
 *
 * Idempotent (upsert on (install_slug, name), same key discipline as every routine
 * in this dir). A re-run does NOT live-arm a host that's already running (restart
 * papercup-bg-host to pick up a freshly-seeded row live).
 */
import { runRoutineSeed } from './seed-routine-main';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.ACCEPTANCE_GRADING_SWEEP_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const NAME = 'acceptance-grading-sweep';
const TARGET_ROLE = 'system:acceptance-grading-sweep';
const DEFAULT_INTERVAL_SEC = 60;

void runRoutineSeed({
  scriptTag: 'seed-acceptance-grading-sweep-routine',
  prepare: () => {
    const active = !process.argv.includes('--inactive');
    const triggerConfig = JSON.stringify({ interval_sec: DEFAULT_INTERVAL_SEC });
    return {
      installSlug: SLUG,
      name: NAME,
      active,
      triggerConfig: triggerConfig,
      targetRole: TARGET_ROLE,
      tier: 'ephemeral' as const,
      nextFire: 'null' as const,
      updateTriggerKind: true,
    };
  },
  afterSeed: async ({ active, id, workspaceId: ws, sql, triggerConfig }) => {
    console.log(
        `[seed-acceptance-grading-sweep-routine] seeded "${NAME}" for "${SLUG}" (ws=${ws}, active=${active}, ` +
          `tier=ephemeral, interval=${DEFAULT_INTERVAL_SEC}s) — acceptance-grading stall sweep cadence. ` +
          (active
            ? 'Cadence seeded ACTIVE — restart papercusp-bg-host to live-arm on a host that was already up.'
            : 'Inactive — enable via the routines admin or re-run without --inactive.'),
      );
  },
});
