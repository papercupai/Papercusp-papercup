/**
 * `su-ideate:schedule` — the hourly su ideate pass scheduler as a DETERMINISTIC
 * blueprint step (plan scout-su-ideate-pipeline-gaps-2026-10-08 P-007 / R-14,
 * design D-005, cost bound D-006).
 *
 * Mirrors memory-live-recall-canary.ts: a registered typed function the
 * program-mode spine runs as one checkpointed step, wrapping the shipped
 * orchestration (`runSuIdeateSchedule` — budget → in-flight → per-harness D-015
 * verdict → at most ONE headless su launch). The hour is only the evaluation
 * heartbeat; whether a pass fires stays observation-count keyed (D-015).
 * Kill switch: pause the routine row (routines:set) — no flag.
 */
import { z } from 'zod';
import type { CoordOp } from '../../coord-ops/types.js';
import { registerCoordOp } from '../../coord-ops/registry.js';
import {
  defaultSuIdeateScheduleDeps,
  runSuIdeateSchedule,
  type SuIdeateScheduleDeps,
} from '../../scout/su-ideate-schedule.js';

/** No payload knobs — budget/threshold are env-tunable, the harness set is read live. */
const args = z.object({});

/** Fifty detail rows plus complete disposition counts; the scheduler stops at the first launch. */
const result = z.object({
  stopped: z.enum(['daily-budget-exhausted', 'pass-in-flight', 'no-harnesses']).optional(),
  launchesLast24h: z.number().int(),
  budget: z.number().int(),
  inFlightHarness: z.string().optional(),
  launchedHarness: z.string().optional(),
  lens: z.string().optional(),
  key: z.string().optional(),
  deduped: z.boolean().optional(),
  decisionCount: z.number().int().nonnegative(),
  decisionCounts: z.record(z.string(), z.number().int().nonnegative()),
  decisionsOmitted: z.number().int().nonnegative(),
  decisions: z.array(
    z.object({
      harnessSlug: z.string(),
      disposition: z.string(),
      observationsSince: z.number().int().optional(),
      error: z.string().optional(),
    }),
  ),
});

/** Test seam — inject the schedule deps (mirrors memory-live-recall-canary). */
let _deps: SuIdeateScheduleDeps | null = null;
export function setSuIdeateScheduleDeps(deps: SuIdeateScheduleDeps | null): void {
  _deps = deps;
}

export const suIdeateScheduleOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'su-ideate:schedule',
  description:
    'Deterministic step: evaluate the D-015 ideate-overdue verdict per harness and launch at most ONE headless su ideate pass for the first overdue harness (budgeted, one pass in flight).',
  argsSchema: args,
  resultSchema: result,
  async run(_a, ctx) {
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) throw new Error('su-ideate:schedule requires ctx.workspaceId');
    const out = await runSuIdeateSchedule({ workspaceId }, _deps ?? defaultSuIdeateScheduleDeps);
    const decisionCounts: Record<string, number> = {};
    for (const decision of out.decisions) {
      decisionCounts[decision.disposition] = (decisionCounts[decision.disposition] ?? 0) + 1;
    }
    // A registry can contain many quiet harnesses before the eligible one. Preserve
    // the launch and refusals first, and disclose omitted rows instead of presenting
    // the first fifty quiet decisions as the whole rotation.
    const priority = (disposition: string): number =>
      disposition === 'launched' ? 0 : disposition === 'launch-failed' ? 1 :
        disposition === 'attempts-exhausted' ? 2 : 3;
    const decisions = [...out.decisions]
      .sort((a, b) => priority(a.disposition) - priority(b.disposition))
      .slice(0, 50);
    const output = {
      ...(out.stopped ? { stopped: out.stopped } : {}),
      launchesLast24h: out.launchesLast24h,
      budget: out.budget,
      ...(out.inFlight ? { inFlightHarness: out.inFlight.harnessSlug } : {}),
      ...(out.launched
        ? { launchedHarness: out.launched.harnessSlug, lens: out.launched.lens, key: out.launched.key, deduped: out.launched.deduped }
        : {}),
      decisionCount: out.decisions.length,
      decisionCounts,
      decisionsOmitted: out.decisions.length - decisions.length,
      decisions: decisions.map((d) => ({
        harnessSlug: d.harnessSlug,
        disposition: d.disposition,
        ...(d.verdict ? { observationsSince: d.verdict.observationsSince } : {}),
        ...(d.error ? { error: d.error } : {}),
      })),
    };
    // Scheduled programs do not supply ctx.log. Preserve the decision, including
    // a refused launch, instead of leaving only the generic "program done" log.
    const diagnostic = `su-ideate:schedule ${JSON.stringify(output)}`;
    if (ctx.log) ctx.log(diagnostic);
    else console.info(diagnostic);
    return output;
  },
};

registerCoordOp(suIdeateScheduleOp);
