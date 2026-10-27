/**
 * Regret mining ⇄ learning-governor glue (self-learning-frontier-2026-06-12
 * P-021 / FB-07) — the D-004 unattended-refusal gate the `system:regret-mine`
 * action calls after its own flag check. Mirrors the negative-space miner's
 * governor.ts (the FB-04 + FB-01 layering).
 *
 *   - The preflight is THE gate: governor flag OFF ⇒ 'governor-dark';
 *     unregistered / disabled / unbudgeted / exhausted ⇒ refuse; IO failure ⇒
 *     fail-CLOSED ('governor-error').
 *   - First armed contact SELF-REGISTERS the loop with `budgetUsd` OMITTED —
 *     the row lands unbudgeted on the D-004 watch list while the preflight
 *     keeps refusing; setting the budget is the owner's P-001 arming act.
 *   - budgetKind 'per-cycle': unlike the SQL-only miners, regret mining's
 *     replay leg SPENDS (counterfactual replays ride FB-06's lib/replay).
 *     The owner-set per-cycle cap becomes the tick's replayBudgetUsd, and the
 *     action ledgers realized spend via recordLearningSpend (origin=replay).
 *
 * Deps are injectable (GovernorGlueDeps) so governor.test.ts covers the gate
 * with zero PG / zero flags IO.
 */
import { createLearningGovernorGate } from '../../learning-governor/registrants';

/** Governor registry identity — one regret miner per workspace. */
export const REGRET_LOOP_ID = 'regret-mining';

/** First-contact metadata; the shared factory keeps registration unbudgeted. */
export const {
  registrationInput: regretRegistrationInput,
  gate: regretGovernorGate,
} = createLearningGovernorGate({
  loopId: REGRET_LOOP_ID,
  displayName: 'Regret mining (bad-session counterfactual replay)',
  budgetKind: 'per-cycle',
  logPrefix: 'regret-mine',
});
