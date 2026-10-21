/**
 * Operator-core's loader wrapper for the identity-owned turn-end observation
 * practice section. The source prose lives in `su.practice.md` so the su
 * render, spawned-bee base, and operator role base cannot drift.
 */
import { loadObservationPractice } from '@papercusp/orchestrator/role-prompt';

/** The shared turn-end observation clause for operator-launched roles. */
export function renderTurnEndObservation(harnessDir?: string): string {
  return loadObservationPractice(harnessDir).turnEndObservation;
}
