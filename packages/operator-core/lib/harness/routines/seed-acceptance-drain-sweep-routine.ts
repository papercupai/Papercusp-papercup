/**
 * Seed the `acceptance-drain-sweep` routine — P-020 of
 * design-to-code-coverage-seam-2026-09-02 (handler in
 * `acceptance-drain-sweep-action.ts`; logic in
 * `../../agent-tools/plans/acceptance-drain-sweep.ts`'s
 * `runAcceptanceDrainSweepOnce`).
 *
 *   - `acceptance-drain-sweep` (every 6 h): for each plan held in
 *     `awaiting-acceptance`, run the real ship gate and file ONE claimable work
 *     item naming its actual first blocker, quoting the gate's own repair text.
 *
 *     This is the EXIT for a gate that had none. `plan-drain-sweep` (seeded
 *     alongside) pushes plans INTO `awaiting-acceptance` when their items drain;
 *     the ceremony that gets them out is seven steps long and its refusals were
 *     visible only to someone who explicitly attempted a ship. Measured over all
 *     187 held papercusp plans: 161 (86.1%) had never had `plans:audit` run even
 *     once, oldest 2026-06-04 (D-032). Same queue-not-wall pairing
 *     `spec-triad-sweep` already has, and the same standing mandate — it files
 *     claimable work rather than routing a decision to a person.
 *
 *     Bounded, idempotent, non-throwing. Bounded: `maxFilings` items per tick, so
 *     the accumulated backlog is filed over several ticks rather than 187 items
 *     in one pass. Idempotent: each filing claims a unique condition key and is
 *     refreshed by `payload.acceptanceDrainPlan` on every gate read, so a re-sweep
 *     updates the ledger in place without minting siblings. Bounded SELECTs +
 *     work-item writes only; spawns no agent, no LLM, no network.
 *
 *     Never advances a plan to `shipped` and never edits a plan body — it only
 *     files work. The ship gate needs a code-truth audit and independent
 *     acceptance grading that no sweep can evidence, and auto-shipping would
 *     forge exactly that evidence (the same rule `plan-drain-sweep` states as its
 *     D-005 point 6).
 *
 *     Deliberately does NOT file against rubric-template plans (exempt from
 *     carrying an acceptance rubric of their own — an infinite regress the gate
 *     itself excludes, so the item could never be completed) or scheduled-plan
 *     INSTANCES (auto-generated recurrences, not authored work).
 *
 * Flag-gated on `ACCEPTANCE_DRAIN_SWEEP` (default ON). It changes no gate verdict
 * and has no owner-authority, destructive or outward-facing effect — the only
 * thing it changes is whether anyone is TOLD — so it is seeded ACTIVE by default;
 * pass `--inactive` to seed dark.
 *
 *   tsx seed-acceptance-drain-sweep-routine.ts                   # seed ACTIVE (default)
 *   tsx seed-acceptance-drain-sweep-routine.ts --inactive        # seed dark
 *   tsx seed-acceptance-drain-sweep-routine.ts --max-filings 5   # smaller per-tick bound
 *
 * trigger_config knobs (optional, editable via the routines admin):
 *   - maxFilings (default 25, ACCEPTANCE_DRAIN_MAX_FILINGS_PER_RUN)
 *
 * Idempotent upsert on (install_slug, name), same key discipline as every routine
 * in this dir. A re-run does NOT live-arm an already-running host — the routine
 * engine (routinesTick) picks a freshly-seeded cron row up on its next tick.
 */
import { runRoutineSeed } from './seed-routine-main';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.ACCEPTANCE_DRAIN_SWEEP_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Every 6 hours on the :00 second (6-field: sec min hour dom mon dow). A plan
 *  entering `awaiting-acceptance` has just had its LAST item finished, so nothing
 *  about it is urgent — the work it owes takes a human-scale session to do. At
 *  25 filings a tick this drains the measured 187-plan backlog in under two days
 *  and costs one bounded SELECT pair per tick thereafter. Deliberately slower than
 *  plan-drain-sweep's 30 min: that one only writes a status line, this one files
 *  work into a shared backlog, and over-filing a queue is its own harm. */
const CRON = '0 0 */6 * * *';

function argNumber(flag: string): number | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  const v = Number(process.argv[idx + 1]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

void runRoutineSeed({
  scriptTag: 'seed-acceptance-drain-sweep-routine',
  prepare: () => {
    const active = !process.argv.includes('--inactive');
    const maxFilings = argNumber('--max-filings');
    const name = 'acceptance-drain-sweep';
    const triggerConfig = {
        cron: CRON,
        ...(maxFilings ? { maxFilings } : {}),
      };
    return {
      installSlug: SLUG,
      name: name,
      active,
      triggerConfig: JSON.stringify(triggerConfig),
      targetRole: 'system:acceptance-drain-sweep',
      maxFilings,
    };
  },
  afterSeed: async ({ active, id, workspaceId: ws, sql, maxFilings, name, triggerConfig }) => {
    console.log(
        `[seed-acceptance-drain-sweep-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
          `6-hour sweep filing claimable work for plans the ship gate is holding` +
          (maxFilings ? `, maxFilings=${maxFilings}` : '') +
          '.',
      );
  },
});
