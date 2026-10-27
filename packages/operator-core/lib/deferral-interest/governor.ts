/**
 * Deferral-interest ⇄ learning-governor glue (self-learning-frontier P-042 /
 * FB-14) — the D-004 unattended-refusal gate the
 * `system:deferral-interest-refit` action calls after its own flag check.
 * Mirrors lib/negative-space/governor.ts (the FB-04 follow-up pattern):
 *
 *   - learningGovernorPreflight is THE gate (governor dark / unregistered /
 *     disabled / unbudgeted / exhausted ⇒ refuse; IO failure ⇒ fail-CLOSED).
 *   - First armed contact SELF-REGISTERS the loop with budgetUsd OMITTED —
 *     the row lands unbudgeted on the D-004 watch list and keeps refusing;
 *     setting the (per-cycle) budget is the owner's P-001 arming act. The
 *     refit is SQL-only (zero LLM spend), so 0 is an honest cap and no spend
 *     events are ledgered (gym/scout precedent: only positive spend).
 */
import { createLearningGovernorGate } from '../learning-governor/registrants';

/** Governor registry identity — one refit loop per workspace. */
export const DEFERRAL_INTEREST_LOOP_ID = 'deferral-interest-refit';

/** First-contact metadata; the shared factory keeps registration unbudgeted. */
export const {
  registrationInput: deferralInterestRegistrationInput,
  gate: deferralInterestGovernorGate,
} = createLearningGovernorGate({
  loopId: DEFERRAL_INTEREST_LOOP_ID,
  displayName: 'Deferral-interest refit (learned deferral pricing)',
  budgetKind: 'per-cycle',
  logPrefix: 'deferral-interest-refit',
});
