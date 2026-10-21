import { describe, expect, it } from 'vitest';

import {
  ACCEPTANCE_BAR_REPAIR_ORDER,
  nextRepair,
  type AcceptanceBarSnapshotCode,
} from './acceptance-bar-contract-snapshot.js';

/**
 * P-004 of review-system-rework-reduction-2026-09-23 — VET BEFORE PROOF.
 *
 * The acceptance gate's NEXT REPAIR line is how an author learns what to do next, so
 * its ranking IS the runbook order in practice. It used to rank vetting AFTER proof and
 * AFTER grading: an author with an unvetted rubric and no proof was told to bind proof,
 * then to commission grading (which scorecards:emit refuses on an unvetted revision),
 * and only then to vet — after which the vetting critique amended the rubric and the
 * proof had to be re-bound. The audit behind the plan measured that as a whole
 * "vetting after proof" cycle (docs/evidence/review-system-time-audit-2026-09-23.md).
 *
 * The cheap order is amend → vet → attest → bind → cards → grade. These assertions pin
 * the RELATIVE order of the families, not every position, so an unrelated insertion
 * does not break them.
 */

const rank = (order: readonly AcceptanceBarSnapshotCode[], code: AcceptanceBarSnapshotCode): number => {
  const index = order.indexOf(code);
  if (index < 0) throw new Error(`${code} is not ranked`);
  return index;
};

/** Every contract-TEXT code — each repair is a rubrics:amend. */
const CONTRACT_TEXT: AcceptanceBarSnapshotCode[] = [
  'bar_snapshot_method_missing',
  'bar_snapshot_falsifier_missing',
  'bar_snapshot_role_invalid',
  'bar_snapshot_mandatory_invalid',
  'bar_snapshot_scope_invalid',
  'bar_snapshot_pass_ratings_invalid',
  'bar_snapshot_coverage_invalid',
  'bar_snapshot_check_missing',
  'bar_snapshot_check_invalid',
];
const VETTING: AcceptanceBarSnapshotCode[] = ['bar_snapshot_vetting_missing', 'bar_snapshot_vetting_stale'];
/** Everything that spends proof, cards or grading on the CURRENT revision. */
const BIND_CARDS_GRADE: AcceptanceBarSnapshotCode[] = [
  'bar_snapshot_work_contract_missing',
  'bar_snapshot_work_contract_stale',
  'bar_snapshot_proof_missing',
  'bar_snapshot_proof_stale',
  'bar_snapshot_proof_uncertain',
  'bar_snapshot_proof_depth_missing',
  'bar_snapshot_proof_inadequate',
  'bar_snapshot_evidence_plane_unmet',
  'bar_snapshot_evidence_runtime_unmet',
  'bar_snapshot_grading_missing',
  'bar_snapshot_grading_stale',
  'bar_snapshot_grading_not_pass',
];

/** Does `order` put every contract-text code before vetting, and vetting before any proof/grading? */
function vetsBeforeProof(order: readonly AcceptanceBarSnapshotCode[]): boolean {
  const known = (codes: AcceptanceBarSnapshotCode[]) => codes.filter((code) => order.includes(code));
  const lastText = Math.max(...known(CONTRACT_TEXT).map((code) => rank(order, code)));
  const firstVet = Math.min(...VETTING.map((code) => rank(order, code)));
  const lastVet = Math.max(...VETTING.map((code) => rank(order, code)));
  const firstSpend = Math.min(...known(BIND_CARDS_GRADE).map((code) => rank(order, code)));
  return lastText < firstVet && lastVet < firstSpend;
}

// The exact pre-fix ranking, kept as a PERMANENT NEGATIVE CONTROL: it calibrates the
// predicate (a predicate that cannot reject it would be vacuous) and fails loudly if a
// later edit restores the proof-first shape.
const PRE_FIX_ORDER: AcceptanceBarSnapshotCode[] = [
  'bar_snapshot_projection_stale',
  'bar_snapshot_method_missing',
  'bar_snapshot_work_contract_missing',
  'bar_snapshot_work_contract_stale',
  'bar_snapshot_proof_missing',
  'bar_snapshot_proof_stale',
  'bar_snapshot_proof_depth_missing',
  'bar_snapshot_proof_inadequate',
  'bar_snapshot_grading_missing',
  'bar_snapshot_grading_stale',
  'bar_snapshot_grading_not_pass',
  'bar_snapshot_vetting_missing',
  'bar_snapshot_vetting_stale',
  'bar_snapshot_author_verdict_missing',
];

describe('acceptance BAR repair order: vet before proof (P-004)', () => {
  it('calibration: the predicate rejects the pre-fix proof-first ranking', () => {
    expect(vetsBeforeProof(PRE_FIX_ORDER)).toBe(false);
  });

  it('ranks contract text, then vetting, then every proof/card/grading repair', () => {
    expect(vetsBeforeProof(ACCEPTANCE_BAR_REPAIR_ORDER)).toBe(true);
  });

  it('an unvetted rubric with missing proof is told to VET, not to bind', () => {
    const repair = nextRepair(['bar_snapshot_proof_missing', 'bar_snapshot_vetting_missing'], []);
    expect(repair?.code).toBe('bar_snapshot_vetting_missing');
    // The action itself carries the order, so the reason to vet first travels with it.
    // The vetting step is spelled `critique` since the attestation card was dropped from
    // the order (critique is read directly); the invariant is that it precedes `bind`.
    expect(repair?.action).toMatch(/amend → (?:vet|critique)\b[^.]*?→ bind → cards → grade/);
    expect(repair?.action).toMatch(/BEFORE binding proof/i);
  });

  it('an unvetted rubric is never told to commission grading first', () => {
    const repair = nextRepair(['bar_snapshot_grading_missing', 'bar_snapshot_vetting_stale'], []);
    expect(repair?.code).toBe('bar_snapshot_vetting_stale');
  });

  it('a contract-text gap still outranks vetting — vet the text you will ship', () => {
    const repair = nextRepair(['bar_snapshot_vetting_missing', 'bar_snapshot_check_missing'], []);
    expect(repair?.code).toBe('bar_snapshot_check_missing');
  });

  it('every code is ranked exactly once, so no blocker renders without a NEXT REPAIR', () => {
    // Nine contract/proof codes used to be absent from the order: a BAR blocked only by,
    // e.g., check_missing got nextRepair:null. The typecheck now enforces completeness;
    // this is the runtime half, and it also catches a duplicated entry.
    expect(new Set(ACCEPTANCE_BAR_REPAIR_ORDER).size).toBe(ACCEPTANCE_BAR_REPAIR_ORDER.length);
    for (const code of ACCEPTANCE_BAR_REPAIR_ORDER) {
      const repair = nextRepair([code], []);
      expect(repair?.code).toBe(code);
      expect(repair?.action).toBeTruthy();
      expect(repair?.action).not.toBe(code);
    }
  });

  it('ranks accepting a draft clause after vetting and before every proof/card/grading repair (WI-10003187)', () => {
    const accept = rank(ACCEPTANCE_BAR_REPAIR_ORDER, 'bar_snapshot_clause_not_accepted');
    expect(accept).toBeGreaterThan(Math.max(...VETTING.map((code) => rank(ACCEPTANCE_BAR_REPAIR_ORDER, code))));
    expect(accept).toBeLessThan(Math.min(...BIND_CARDS_GRADE.map((code) => rank(ACCEPTANCE_BAR_REPAIR_ORDER, code))));
    expect(nextRepair(['bar_snapshot_proof_missing', 'bar_snapshot_clause_not_accepted'], [])?.code)
      .toBe('bar_snapshot_clause_not_accepted');
  });

  it('attributes the repair to the BAR whose readiness carries it', () => {
    const repair = nextRepair(
      ['bar_snapshot_proof_missing'],
      [
        { barKey: 'R-1', readiness: { codes: [] } },
        { barKey: 'R-2', readiness: { codes: ['bar_snapshot_proof_missing'] } },
      ],
    );
    expect(repair).toMatchObject({ code: 'bar_snapshot_proof_missing', barKey: 'R-2' });
  });
});
