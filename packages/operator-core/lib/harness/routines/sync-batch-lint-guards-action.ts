/**
 * `system:sync-batch-lint-guards` — the gate's repo-wide lint guards, run per git-sync
 * batch (green-main-cycle-time-2026-10-08 P-028; extends P-011).
 *
 * WIRING ONLY. Every decision (what is a new violation, what is undetermined, routing,
 * the finding body) is pure and unit-tested in `../../release/sync-batch-lint-guards.ts`;
 * the IO seams are `../../release/sync-batch-lint-guards-deps.ts`, lazy-imported so a
 * broken leg can never poison engine boot (the sync-batch-delta-check-action shape).
 *
 * WHY ITS OWN ROUTINE and not a leg of `sync-batch-delta-check`: that routine runs a
 * 25-minute affected leg with concurrency 'skip', so a guard leg inside it would wait
 * behind it. P-028's bar is an attributed red within 15 minutes; a separate 5-minute row
 * keeps guard latency independent of the affected leg.
 *
 * BOUNDED: skips above the hard host-load ceiling, runs only when the integration tip
 * moved, runs at most 3 guards at once at idle priority with a 10-minute cap each, and
 * files at most 6 findings per tick. Observer only: no revert, no gate fire, no spawn.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

/** One tick: up to ceil(10/3)=4 rounds of 10-minute guards, plus git and filing. */
export const SYNC_LINT_GUARDS_ROUTINE_TIMEOUT_MS = 45 * 60_000;

registerSystemAction(
  'sync-batch-lint-guards',
  async (ctx: SystemActionCtx) => {
    const home = operatorHomeHarnessSlug();
    if (ctx.installSlug && ctx.installSlug !== home) {
      console.log(`[sync-lint-guards] skip: not the operator-home harness (got "${ctx.installSlug}", home "${home}")`);
      return;
    }
    const [{ runSyncLintGuardTick }, { buildSyncLintGuardDeps }, { integrationRoot }, { integrationBranch }] =
      await Promise.all([
        import('../../release/sync-batch-lint-guards'),
        import('../../release/sync-batch-lint-guards-deps'),
        import('../../release-deploy-launch'),
        import('../../release/judged-sha-containment'),
      ]);
    const deps = buildSyncLintGuardDeps({
      installSlug: ctx.installSlug || home,
      workspaceId: ctx.workspaceId,
      root: integrationRoot(),
      branch: integrationBranch(),
    });
    await runSyncLintGuardTick(deps);
  },
  // Runs the integration tree's own `npm run lint:*` scripts.
  { routineTimeoutMs: SYNC_LINT_GUARDS_ROUTINE_TIMEOUT_MS, executesIntegrationTreeCode: true },
);
