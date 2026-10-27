/**
 * Transfer harness ⇄ learning-governor glue (P-022 / FB-08) — the D-004
 * unattended-refusal gate the `system:transfer-distill` action calls after
 * its own flag check. Mirrors lib/negative-space/governor.ts, with one
 * difference: this loop SPENDS (distillation LLM + replay batteries + the
 * frozen judge), so its budget is a real LIFETIME cap and every tick ledgers
 * spend via recordLearningSpend (accumulate:true — the governor is this
 * loop's only spend store).
 *
 *   - First armed contact SELF-REGISTERS the loop with `budgetUsd` OMITTED:
 *     the row inserts unbudgeted, lands on the D-004 watch list
 *     (summarizeLearningSpend.unbudgetedLoopIds), and the preflight keeps
 *     refusing. Setting the budget is the owner's P-001 arming act.
 *   - Registration fires only on an 'unregistered' verdict, so an owner-set
 *     budget is never re-written (the store upsert also preserves omitted
 *     fields — belt and braces).
 */
import { createLearningGovernorGate } from '../learning-governor/registrants';
import { TRANSFER_LOOP_ID } from './types';

/** First-contact metadata; the shared factory keeps registration unbudgeted. */
export const {
  registrationInput: transferRegistrationInput,
  gate: transferGovernorGate,
} = createLearningGovernorGate({
  loopId: TRANSFER_LOOP_ID,
  displayName: 'Transfer harness (lesson distillation + student-transfer tests)',
  budgetKind: 'lifetime',
  logPrefix: 'transfer-distill',
});
