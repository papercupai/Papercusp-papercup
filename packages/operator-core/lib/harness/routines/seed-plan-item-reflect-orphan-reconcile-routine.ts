/**
 * Seed the `plan-item-reflect-orphan-reconcile` routine — the REFLECT-direction
 * periodic data-heal (handler in `plan-item-reflect-orphan-reconcile-action.ts`;
 * logic in `../../plan-items/reflect-orphaned-plan-items.ts`).
 *
 *   - `plan-item-reflect-orphan-reconcile` (every 15 min): find plan items still
 *     reading `todo` whose linked work-items are ALL terminal — the residue the
 *     transition-only reflect reaction (plan-items/reflect-rules.ts) never
 *     re-heals — and reflect them to `done`. Strict + fail-closed: never flips an
 *     item with a non-terminal sibling, with no done-like link, or with
 *     independent in-flight progress; idempotent (a re-sweep of healed data
 *     selects nothing). SQL + the real `plans:set-status` tool only; spawns no
 *     agent, no LLM, no network call.
 *
 * WHY IT EXISTS: the plan-item ⇄ work-item rail is two mirror directions, and
 * only direction A (plan item done → heal work-items) had a periodic backstop.
 * Direction B was reaction-ONLY, so a close during the EI-6960 window, an
 * operator restart, or any path that never emitted the event left the plan item
 * permanently `todo` — the phantom-todo agents re-investigate and nearly
 * re-implement (EI-18713141708830049). Measured 2026-08-13: 30 such items.
 *
 * NOT flag-gated (same class as its direction-A twin and gc-plan-runs — no
 * owner-authority surface; it only ever mirrors the SAME reflection the reaction
 * already performs automatically, extended to the transition-missed cases, and
 * every flip is reversible). Seeded ACTIVE by default. Pass `--inactive` to seed
 * dark instead.
 *
 *   tsx seed-plan-item-reflect-orphan-reconcile-routine.ts                 # seed ACTIVE (default)
 *   tsx seed-plan-item-reflect-orphan-reconcile-routine.ts --inactive      # seed dark
 *   tsx seed-plan-item-reflect-orphan-reconcile-routine.ts --candidate-cap 200
 *
 * trigger_config knobs (optional, editable via the routines admin):
 *   - candidate_cap (default 500, reflect-orphaned-plan-items.ts's DEFAULT_REFLECT_SWEEP_CAP)
 *
 * Idempotent upsert on (install_slug, name), same key discipline as every routine
 * in this dir. A re-run does NOT live-arm an already-running host — the routine
 * engine (routinesTick) picks a freshly-seeded cron row up on its next tick.
 */
import { runRoutineSeed } from './seed-routine-main';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG =
  process.env.PLAN_ITEM_REFLECT_ORPHAN_RECONCILE_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Every 15 minutes, offset from its direction-A twin (which runs at :00) so the
 *  two sweeps never contend for the same plan locks on the same tick. */
const CRON = '0 7-59/15 * * * *';

function argNumber(flag: string): number | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  const v = Number(process.argv[idx + 1]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

void runRoutineSeed({
  scriptTag: 'seed-plan-item-reflect-orphan-reconcile-routine',
  prepare: () => {
    const active = !process.argv.includes('--inactive');
    const candidateCap = argNumber('--candidate-cap');
    const name = 'plan-item-reflect-orphan-reconcile';
    const triggerConfig = {
        cron: CRON,
        ...(candidateCap ? { candidate_cap: candidateCap } : {}),
      };
    return {
      installSlug: SLUG,
      name: name,
      active,
      triggerConfig: JSON.stringify(triggerConfig),
      targetRole: 'system:plan-item-reflect-orphan-reconcile',
      candidateCap,
    };
  },
  afterSeed: async ({ active, id, workspaceId: ws, sql, candidateCap, name, triggerConfig }) => {
    console.log(
        `[seed-plan-item-reflect-orphan-reconcile-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
          `15-min data-heal of \`todo\` plan items whose linked work-items are all terminal` +
          (candidateCap ? `, candidate_cap=${candidateCap}` : '') +
          '.',
      );
  },
});
