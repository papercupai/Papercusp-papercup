/**
 * `system:periodic-full-run` — the periodic full-suite run of `main`
 * (green-main-ratchet-convergence-2026-10-17 P-013, R-11, D-016).
 *
 * WIRING ONLY. Every decision (cadence, the new-failure delta, bisection over promotions,
 * the fix -> eject -> downgrade route) is pure and unit-tested in
 * `../../release/periodic-full-run.ts`; the IO seams live in
 * `../../release/periodic-full-run-deps.ts`, lazy-imported so a broken leg can never poison
 * engine boot (the sync-batch-delta-check-action.ts shape).
 *
 * The routine fires every 30 minutes; the run itself starts only when the cadence interval
 * (6h) has passed since the last full run. Its legs run in the reserved `source-checks.slice`
 * and it has no host-load skip, so load shedding cannot starve it (R-11 falsifier 3). It is an
 * OBSERVER that files deduped bugs: no revert, no gate firing, no agent spawn.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

/** A whole-suite run in a clean tree plus a bounded bisection (16 probe points). */
export const PERIODIC_FULL_RUN_ROUTINE_TIMEOUT_MS = 6 * 60 * 60_000;

registerSystemAction(
  'periodic-full-run',
  async (ctx: SystemActionCtx) => {
    const home = operatorHomeHarnessSlug();
    if (ctx.installSlug && ctx.installSlug !== home) {
      console.log(`[periodic-full-run] skip: not the operator-home harness (got "${ctx.installSlug}", home "${home}")`);
      return;
    }
    const [{ runPeriodicFullRun }, { buildPeriodicFullRunDeps }, { integrationRoot }] = await Promise.all([
      import('../../release/periodic-full-run'),
      import('../../release/periodic-full-run-deps'),
      import('../../release-deploy-launch'),
    ]);
    const deps = buildPeriodicFullRunDeps({
      installSlug: ctx.installSlug || home,
      workspaceId: ctx.workspaceId,
      root: integrationRoot(),
      releaseRef: process.env.PAPERCUSP_RELEASE_REF ?? 'main',
    });
    const report = await runPeriodicFullRun(deps);
    console.log(`[periodic-full-run] ${JSON.stringify(report).slice(0, 2000)}`);
  },
  // Spawns lint:as-committed clean-tree runs from the integration tree.
  { routineTimeoutMs: PERIODIC_FULL_RUN_ROUTINE_TIMEOUT_MS, executesIntegrationTreeCode: true },
);
