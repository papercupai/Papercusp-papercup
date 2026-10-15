import { describe, expect, it } from 'vitest';

import { nextRepair } from './acceptance-bar-contract-snapshot.js';

/**
 * EI-22495407709800667 — the ship gate's proof remediations used to send agents into a trap.
 *
 * `bar_snapshot_proof_depth_missing` said only "Declare requiredTestLayers ... through
 * rubrics:amend". Doing exactly and only that does NOT clear the leg: the evaluator trades it for
 * the strictly harder `bar_snapshot_proof_inadequate`, because `correct-layer` matches declared
 * layers against `details.adequacy.testLayer` on the bound evidence. Worse, amending
 * requiredTestLayers bumps the rubric revision, which invalidates the plan's vetting attestation
 * and independent grading card — so the agent follows the instruction and lands strictly behind.
 *
 * Freshness now comes from server measurement recipes, including read-only evidence reads.
 * The repair must explain recipe renewal and measurement failures, rather than requiring the
 * retired caller-supplied fingerprint array or implying every unknown is inadequate evidence.
 *
 * These assertions pin the CONTENT the strings must carry, not their wording, so they survive
 * rephrasing but fail if either half is dropped again.
 */

/** The remediation must name the evidence half, not just the declaration half. */
function namesEvidenceHalf(action: string): boolean {
  return /details\.adequacy\.testLayer/.test(action);
}

/** The remediation must warn that declaring layers alone only trades one code for a harder one. */
function warnsDeclarationAloneIsNotEnough(action: string): boolean {
  return /alone does not clear|trades it for|strictly harder/i.test(action)
    && /bar_snapshot_proof_inadequate/.test(action);
}

/** The remediation must price the BAR amendment against verification already held. */
function warnsHeldVerificationMayBeInvalidated(action: string): boolean {
  return /meaning revision/i.test(action)
    && /invalidate an existing independent grading card/i.test(action)
    && /vetting attestation/i.test(action)
    && /re-grade and re-vet/i.test(action);
}

/** The remediation must use server measurement and explain unresolved recipe failures. */
function explainsServerMeasuredFreshness(action: string): boolean {
  return /do not need to supply current fingerprints/i.test(action)
    && /server re-measures.*recorded measurement recipe/i.test(action)
    && /unknownReasons/.test(action)
    && /server-measurement-unavailable/.test(action)
    && /re-bind it with fromTestRun or a measurement/i.test(action);
}

/** The BAR revision mismatch must first distinguish stale serving code from a live guard. */
function namesServingBuildCheck(action: string): boolean {
  return /dev:pipeline_position/.test(action)
    && /packages\/operator-core\/lib\/agent-tools\/plans\/with-plan-lock\.ts/.test(action)
    && /synchronizeAcceptanceBarSubjectRevision/.test(action)
    && /not deployed|redeploy/i.test(action);
}

// The exact pre-fix strings, kept as PERMANENT NEGATIVE CONTROLS. If a future edit reverts either
// remediation to its old shape, the corresponding assertion below fails. They also calibrate the
// predicates: a predicate that cannot reject these would be vacuous.
const PRE_FIX_DEPTH_MISSING =
  'Declare requiredTestLayers in the requirement Acceptance section through rubrics:amend.';
const PRE_FIX_INADEQUATE =
  'Run plans:evaluate-spec-test-adequacy for the mapped outcome with current fingerprints; '
  + 'fix every fail/unknown proof obligation before ship.';
const PRE_FIX_REVISION_MISMATCH =
  'Re-seed or amend atomically so subject and rubric revision pins agree.';

describe('acceptance-bar ship-gate proof remediations (EI-22495407709800667)', () => {
  it('calibration: the predicates reject the pre-fix strings', () => {
    // Without this, a predicate broken into always-true would let every assertion below pass.
    expect(namesEvidenceHalf(PRE_FIX_DEPTH_MISSING)).toBe(false);
    expect(warnsDeclarationAloneIsNotEnough(PRE_FIX_DEPTH_MISSING)).toBe(false);
    expect(warnsHeldVerificationMayBeInvalidated(PRE_FIX_DEPTH_MISSING)).toBe(false);
    expect(explainsServerMeasuredFreshness(PRE_FIX_INADEQUATE)).toBe(false);
    expect(namesServingBuildCheck(PRE_FIX_REVISION_MISMATCH)).toBe(false);
  });

  it('proof_depth_missing names the evidence half and the code it trades into', () => {
    const repair = nextRepair(['bar_snapshot_proof_depth_missing'], []);
    expect(repair?.code).toBe('bar_snapshot_proof_depth_missing');
    const action = repair?.action ?? '';

    expect(namesEvidenceHalf(action)).toBe(true);
    expect(warnsDeclarationAloneIsNotEnough(action)).toBe(true);
    expect(warnsHeldVerificationMayBeInvalidated(action)).toBe(true);
    // Still names the declaration half — the fix adds to the instruction, it does not replace it.
    expect(action).toMatch(/requiredTestLayers/);
  });

  it('proof_inadequate explains server-measured freshness and recipe renewal', () => {
    const repair = nextRepair(['bar_snapshot_proof_inadequate'], []);
    expect(repair?.code).toBe('bar_snapshot_proof_inadequate');
    const action = repair?.action ?? '';

    expect(explainsServerMeasuredFreshness(action)).toBe(true);
    expect(explainsServerMeasuredFreshness('A read-only probe needs current fingerprints.')).toBe(false);
    expect(explainsServerMeasuredFreshness('You do not need to supply current fingerprints.')).toBe(false);
    // Still tells the agent what to actually run.
    expect(action).toMatch(/plans:evaluate-spec-test-adequacy/);
  });

  it('revision mismatch checks the serving build before prescribing a BAR mutation', () => {
    const repair = nextRepair(['bar_snapshot_rubric_revision_mismatch'], []);
    expect(repair?.code).toBe('bar_snapshot_rubric_revision_mismatch');
    const action = repair?.action ?? '';

    expect(namesServingBuildCheck(action)).toBe(true);
    // Keep the actionable repair after the disambiguating probe.
    expect(action).toMatch(/re-seed or amend atomically/i);
  });

  it('neither remediation enumerates the substantive adequacy claims', () => {
    // Deliberate NEGATIVE requirement. `falsifiable`, `oracleIndependent` and `coverageRungs` are
    // substantive claims about the proof, not classifications. A remediation that listed them as
    // fields to populate would invite stamping them true to clear the gate, making it certify
    // fabricated proof — strictly worse than today's honest refusal. `testLayer` is exempt: it is a
    // factual classification (unit/integration/e2e) the evaluator matches, not a quality claim.
    for (const code of ['bar_snapshot_proof_depth_missing', 'bar_snapshot_proof_inadequate'] as const) {
      const action = nextRepair([code], [])?.action ?? '';
      expect(action).not.toMatch(/falsifiable/i);
      expect(action).not.toMatch(/oracleIndependent/i);
      expect(action).not.toMatch(/coverageRungs/i);
    }
  });

  it('returns null when no code is present', () => {
    expect(nextRepair([], [])).toBeNull();
  });
});
