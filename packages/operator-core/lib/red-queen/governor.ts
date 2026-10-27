/**
 * Red Queen ⇄ learning-governor glue (self-learning-frontier-2026-06-12
 * P-031 / FB-20) — the D-004 unattended-refusal gate the
 * `system:red-queen-drill` action calls after its own flag check. Mirrors
 * lib/fleet-ekg/governor.ts (the SQL-only-loop precedent):
 *
 *   - The preflight is THE gate: governor flag OFF ⇒ 'governor-dark';
 *     unregistered / disabled / unbudgeted / exhausted ⇒ refuse; IO failure ⇒
 *     fail-CLOSED ('governor-error').
 *   - First armed contact SELF-REGISTERS the loop with `budgetUsd` OMITTED —
 *     unbudgeted, so it lands on the governor's D-004 watch list while the
 *     preflight keeps refusing. Setting the budget is the owner's P-001
 *     arming act; registration fires only on an 'unregistered' verdict so an
 *     owner-set budget is never re-written.
 *   - budgetKind 'per-cycle': drills are SQL-only (zero LLM spend) — the cap
 *     is a conscious arming bit (0 is an honest cap), and no spend events are
 *     ledgered (only positive spend lands on the ledger).
 */
import { createLearningGovernorGate } from '../learning-governor/registrants';
import { RED_QUEEN_LOOP_ID } from './types';

/** First-contact metadata; the shared factory keeps registration unbudgeted. */
export const {
  registrationInput: redQueenRegistrationInput,
  gate: redQueenGovernorGate,
} = createLearningGovernorGate({
  loopId: RED_QUEEN_LOOP_ID,
  displayName: 'Red Queen (vaccination drills + MTTSH)',
  budgetKind: 'per-cycle',
  logPrefix: 'red-queen-drill',
});
