/**
 * The blind gap reviewer's backend ladder — the single source of truth for WHICH agent
 * backends may run a blind review. Three seams consume it and must agree:
 *
 *   - the mint and the replacement path LAUNCH on it, in preference order
 *     (`blind-reviewer-mint.ts`, `blind-review-replacement.ts`);
 *   - the session binding RECORDS a launch only when its ADV row is on it
 *     (`blind-review-session-bindings.ts`, `inspectAdv`);
 *   - runtime custody AUTHORISES a reviewer only when its native session is on it
 *     (`blind-review-runtime-authority.ts`, `checkRuntimeReviewerAuthority`).
 *
 * A dependency-free leaf on purpose: the mint imports the session-bindings module, so the
 * ladder cannot live in the mint without an import cycle once the bindings check it too.
 * Before this module each seam carried its own hardcoded `agent === 'codex'`, so widening
 * the launch ladder (owner directive #2503, 2026-10-27) launched an Opus reviewer that the
 * binding then refused (`launch_profile_mismatch`) and custody would have refused
 * (`reviewer_authority_invalid`) — EI-27127088253419654.
 */
export interface BlindReviewerBackend {
  readonly agent: 'claude' | 'codex';
  readonly model?: string;
  readonly effort?: string;
}

/**
 * Preference order (owner directive #2503, 2026-10-27). The mint and the replacement path
 * try each in turn; a launch whose receipt PROVES nothing started
 * (`launchProvablyNotStarted` — e.g. every account of that provider is walled) falls
 * through to the next. A single pinned backend made one provider's capacity a hard wall
 * for every blind review: the earlier `agent: 'codex'` pin (a mitigation for
 * EI-25752839878478687) left reviews unmintable whenever all Codex accounts were walled
 * (EI-27127088253419654).
 */
export const BLIND_REVIEWER_BACKENDS: readonly BlindReviewerBackend[] = Object.freeze([
  Object.freeze({ agent: 'claude', model: 'opus', effort: 'xhigh' } as const),
  Object.freeze({ agent: 'codex' } as const),
]);

/**
 * May a session launched as `agent` hold blind-reviewer authority? True exactly for the
 * agents on the ladder. The model is deliberately NOT re-checked here: the binding pins
 * the launched model (`model_spec`) and custody compares the native launch to it, so a
 * second model check would only add a normalisation hazard.
 */
export function isBlindReviewerBackendAgent(agent: string | null | undefined): boolean {
  return typeof agent === 'string' && BLIND_REVIEWER_BACKENDS.some((backend) => backend.agent === agent);
}
