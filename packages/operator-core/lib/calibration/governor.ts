/**
 * Calibration markets ⇄ learning-governor glue (P-041 / FB-13) — the D-004
 * unattended-refusal gate `system:calibration-resolve` calls after its own
 * flag check. Mirrors lib/negative-space/governor.ts (the FB-04 pattern):
 *
 *   - preflight is THE gate (governor dark / unregistered / disabled /
 *     unbudgeted / exhausted ⇒ refuse; IO failure ⇒ fail-CLOSED);
 *   - first armed contact self-registers with `budgetUsd` OMITTED so the row
 *     lands unbudgeted on the D-004 watch list while the preflight keeps
 *     refusing — setting the budget is the owner's P-001 arming act;
 *   - budgetKind 'per-cycle': the sweep is SQL-only (zero LLM spend), so the
 *     cap is a conscious arming bit (0 is honest) and no spend events are
 *     ledgered (gym/scout precedent: only positive spend).
 */
import { createLearningGovernorGate } from '../learning-governor/registrants';

/** Governor registry identity — one calibration sweep per workspace. */
export const CALIBRATION_LOOP_ID = 'calibration-markets';

/** First-contact metadata; the shared factory keeps registration unbudgeted. */
export const {
  registrationInput: calibrationRegistrationInput,
  gate: calibrationGovernorGate,
} = createLearningGovernorGate({
  loopId: CALIBRATION_LOOP_ID,
  displayName: 'Calibration markets (bet resolution sweep)',
  budgetKind: 'per-cycle',
  logPrefix: 'calibration-resolve',
});
