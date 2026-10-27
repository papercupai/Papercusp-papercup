/**
 * Fleet EKG ⇄ learning-governor glue (self-learning-frontier-2026-06-12
 * P-030 / FB-10) — the D-004 unattended-refusal gate the
 * `system:fleet-ekg-scan` action calls after its own flag check. Mirrors
 * lib/negative-space/governor.ts (the FB-04 precedent for a SQL-only loop):
 *
 *   - The preflight is THE gate: governor flag OFF ⇒ 'governor-dark';
 *     unregistered / disabled / unbudgeted / exhausted ⇒ refuse; IO failure ⇒
 *     fail-CLOSED ('governor-error').
 *   - First armed contact SELF-REGISTERS the loop with `budgetUsd` OMITTED —
 *     unbudgeted, so it lands on the governor's D-004 watch list while the
 *     preflight keeps refusing. Setting the budget is the owner's P-001
 *     arming act; registration fires only on an 'unregistered' verdict so an
 *     owner-set budget is never re-written.
 *   - budgetKind 'per-cycle': the EKG is SQL-only (zero LLM spend) — the cap
 *     is a conscious arming bit (0 is an honest cap), and no spend events are
 *     ledgered (only positive spend lands on the ledger).
 */
import { createLearningGovernorGate } from '../learning-governor/registrants';

/** Governor registry identity — one EKG per workspace. */
export const FLEET_EKG_LOOP_ID = 'fleet-ekg';

/** First-contact metadata; the shared factory keeps registration unbudgeted. */
export const {
  registrationInput: fleetEkgRegistrationInput,
  gate: fleetEkgGovernorGate,
} = createLearningGovernorGate({
  loopId: FLEET_EKG_LOOP_ID,
  displayName: 'Fleet EKG (behavioral drift monitor)',
  budgetKind: 'per-cycle',
  logPrefix: 'fleet-ekg-scan',
});
