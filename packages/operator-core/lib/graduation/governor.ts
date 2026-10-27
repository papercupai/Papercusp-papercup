/**
 * Graduation tracker ⇄ learning-governor glue (self-learning-frontier
 * P-046 / FB-19) — the D-004 unattended-refusal gate `system:graduation-scan`
 * calls after its own flag check. Mirrors lib/negative-space/governor.ts
 * (FB-04's pattern) verbatim:
 *
 *   - The preflight is THE gate: governor flag OFF ⇒ 'governor-dark';
 *     unregistered / disabled / unbudgeted / exhausted ⇒ refuse; IO failure ⇒
 *     fail-CLOSED ('governor-error'). The tracker runs unattended only past it.
 *   - First armed contact SELF-REGISTERS the loop with `budgetUsd` OMITTED, so
 *     the row lands unbudgeted on the governor's D-004 watch list
 *     (summarizeLearningSpend.unbudgetedLoopIds) while the preflight keeps
 *     refusing. Setting the budget is the owner's P-001 arming act (0 is
 *     honest — the scan is SQL-only, zero LLM spend).
 *   - budgetKind 'per-cycle': allows on any non-null budget, never exhausts;
 *     no spend events are ledgered (only positive spend lands on the ledger).
 */
import { createLearningGovernorGate } from '../learning-governor/registrants';

/** Governor registry identity — one tracker per workspace. */
export const GRADUATION_LOOP_ID = 'graduation-tracker';

/** First-contact metadata; the shared factory keeps registration unbudgeted. */
export const {
  registrationInput: graduationRegistrationInput,
  gate: graduationGovernorGate,
} = createLearningGovernorGate({
  loopId: GRADUATION_LOOP_ID,
  displayName: 'Graduation evidence tracker (per-class clean-pass counters)',
  budgetKind: 'per-cycle',
  logPrefix: 'graduation-scan',
});
