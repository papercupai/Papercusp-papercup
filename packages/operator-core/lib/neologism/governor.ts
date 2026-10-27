/**
 * Neologism miner ⇄ learning-governor glue (self-learning-frontier
 * P-011 / FB-05) — the D-004 unattended-refusal gate the
 * `system:neologism-mine` action calls after its own flag check. Mirrors
 * the negative-space miner's gate (FB-04 follow-up) exactly:
 *
 *   - The preflight is THE gate: governor flag OFF ⇒ 'governor-dark';
 *     unregistered / disabled / unbudgeted / exhausted ⇒ refuse; IO failure
 *     ⇒ fail-CLOSED ('governor-error'). The miner runs unattended only past it.
 *   - First armed contact SELF-REGISTERS the loop — with `budgetUsd`
 *     OMITTED, so the row inserts unbudgeted and lands on the governor's
 *     D-004 watch list while the preflight keeps refusing. Setting the
 *     budget is the owner's P-001 arming act. Registration fires only on an
 *     'unregistered' verdict, so an owner-set budget is never re-written.
 *   - budgetKind 'per-cycle': the miner is SQL/fs-only (zero LLM spend), so
 *     the cap is a conscious arming bit, not a real spend bound — and no
 *     spend events are ledgered (gym/scout precedent: only positive spend
 *     lands on the ledger).
 *
 * Deps are injectable (GovernorGlueDeps, the registrants.ts seam) so
 * governor.test.ts covers the gate with zero PG / zero flags IO.
 */
import { createLearningGovernorGate } from '../learning-governor/registrants';

/** Governor registry identity — one miner per workspace (the workspace is the other half of the row key). */
export const NEOLOGISM_LOOP_ID = 'neologism-miner';

/** First-contact metadata; the shared factory keeps registration unbudgeted. */
export const {
  registrationInput: neologismRegistrationInput,
  gate: neologismGovernorGate,
} = createLearningGovernorGate({
  loopId: NEOLOGISM_LOOP_ID,
  displayName: 'Neologism miner (emergent fleet vocabulary)',
  budgetKind: 'per-cycle',
  logPrefix: 'neologism-mine',
});
