/**
 * observation-rubric-policy.ts — re-export of the shared "check for a rubric before filing an
 * observation" clause for the operator-launched-role prompt base (rubric-driven-observations-2026-06-20
 * P-005 / D-001 / D-003).
 *
 * The section is owned by the `su.practice` identity document. This wrapper
 * keeps operator-core on the same loader as the spawned-bee prompt path.
 */
import { loadObservationPractice } from '@papercusp/orchestrator/role-prompt';

/** The shared observation-rubric clause, injected into every operator-launched role's prompt base by
 *  `assembleRolePrompt` (mirror of `renderReuseFirstNudge` / `renderFrictionTripwire`). */
export function renderObservationRubricNudge(harnessDir?: string): string {
  return loadObservationPractice(harnessDir).observationRubricNudge;
}
