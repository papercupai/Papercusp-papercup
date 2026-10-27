/**
 * Prompt-ablation ⇄ learning-governor glue (self-learning-frontier P-023 /
 * FB-09) — the D-004 unattended-refusal gate the `system:prompt-ablation`
 * action calls after its own flag check. Mirrors lib/negative-space/governor.ts
 * (the frontier-loop precedent), with one difference that matters: THIS loop
 * spends real LLM tokens (SUT + sim-user + judge per scenario arm), so its
 * per-cycle budget is a genuine spend bound, not just an arming bit — the
 * runner hard-caps the cycle at the governor's per-cycle budget and the action
 * ledgers the realized spend (`recordLearningSpend`, accumulate, the scout
 * pattern).
 *
 * Contract (FB-01's frontier-loop rule, enforcement 'governor'):
 *
 *   - The preflight is THE gate: governor flag OFF ⇒ 'governor-dark';
 *     unregistered / disabled / unbudgeted / exhausted ⇒ refuse; IO failure ⇒
 *     fail-CLOSED. The cycle runs unattended only past it.
 *   - First armed contact SELF-REGISTERS the loop with `budgetUsd` OMITTED —
 *     the row lands unbudgeted on the D-004 watch list while the preflight
 *     keeps refusing. Setting the per-cycle budget is the owner's P-001
 *     arming act; registration fires only on an 'unregistered' verdict, so an
 *     owner-set budget is never re-written.
 */
import { createLearningGovernorGate } from '../learning-governor/registrants';

/** Governor registry identity — one ablation loop per workspace. */
export const PROMPT_ABLATION_LOOP_ID = 'prompt-ablation';

/** First-contact metadata; the shared factory keeps registration unbudgeted. */
export const {
  registrationInput: promptAblationRegistrationInput,
  gate: promptAblationGovernorGate,
} = createLearningGovernorGate({
  loopId: PROMPT_ABLATION_LOOP_ID,
  displayName: 'Prompt sedimentology (weekly shadow ablation)',
  budgetKind: 'per-cycle',
  logPrefix: 'prompt-ablation',
  budgetLabel: 'per-cycle budget',
});
