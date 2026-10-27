/**
 * Negative-space miner ⇄ learning-governor glue (self-learning-frontier
 * P-010 / FB-04 follow-up, unblocked by FB-01) — the D-004 unattended-refusal
 * gate the `system:negative-space-mine` action calls after its own flag check.
 *
 * Contract (FB-01's frontier-loop rule, enforcement 'governor'):
 *
 *   - The preflight is THE gate: governor flag OFF ⇒ 'governor-dark';
 *     unregistered / disabled / unbudgeted / exhausted ⇒ refuse; IO failure ⇒
 *     fail-CLOSED ('governor-error'). The miner runs unattended only past it.
 *   - First armed contact SELF-REGISTERS the loop — with `budgetUsd` OMITTED,
 *     so the row inserts unbudgeted and lands on the governor's D-004 watch
 *     list (summarizeLearningSpend.unbudgetedLoopIds) while the preflight
 *     keeps refusing. Setting the budget is the owner's P-001 arming act.
 *     Registration fires only on an 'unregistered' verdict, so an owner-set
 *     budget is never re-written (the store upsert also preserves omitted
 *     fields — belt and braces).
 *   - budgetKind 'per-cycle': the miner is SQL-only (zero LLM spend), so the
 *     cap is a conscious arming bit, not a real spend bound — per-cycle
 *     verdicts allow on any non-null budget (0 is an honest cap here) and
 *     never exhaust. No spend events are ledgered (gym/scout precedent:
 *     only positive spend lands on the ledger).
 *
 * Deps are injectable (GovernorGlueDeps, the registrants.ts seam) so
 * governor.test.ts covers the gate with zero PG / zero flags IO.
 */
import { createLearningGovernorGate } from '../learning-governor/registrants';

/** Governor registry identity — one miner per workspace (the workspace is the other half of the row key). */
export const NEGATIVE_SPACE_LOOP_ID = 'negative-space-miner';

/** First-contact metadata; the shared factory keeps registration unbudgeted. */
export const {
  registrationInput: negativeSpaceRegistrationInput,
  gate: negativeSpaceGovernorGate,
} = createLearningGovernorGate({
  loopId: NEGATIVE_SPACE_LOOP_ID,
  displayName: 'Negative-space miner (zero-hit search demand)',
  budgetKind: 'per-cycle',
  logPrefix: 'negative-space-mine',
});
