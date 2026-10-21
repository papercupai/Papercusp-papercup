/**
 * change-kind-declared-proof-2026-10-15 P-002 — the WIRING guard for the change-kind close gate.
 *
 * ── WHY THIS FILE EXISTS, GIVEN THE GATE IS ALREADY TESTED ─────────────────
 * `change-kind-proof.test.ts` proves the PREDICATE (`evaluateChangeKindGate`): which closes it
 * refuses, which proofs it names, when it only warns. The integration suite
 * (`complete.change-kinds.integration.test.ts`) drives the real handler through persistence for a
 * few representative closes. Neither one fails if a later edit to `complete.ts` stops feeding the
 * gate what the caller actually sent, drops the refusal into a branch that never runs, or computes
 * the verdict and then never returns it: the predicate suite stays green, and the integration
 * cases cover only the kinds they happen to exercise.
 *
 * ── HOW THIS FILE PROVES ITSELF ─────────────────────────────────────────────
 * Each case pins one link of the chain from the caller's arguments to the caller's result:
 * the gate comes from the shared module (not a local fork), it reads the close-time declaration,
 * reason and per-kind evidence the caller sent, its refusal becomes the item's state error (so the
 * close does not land, R-2), its per-kind gaps reach the result, and a clean close is left alone
 * (R-6: no refusal path runs unless the gate said refuse). A stub that satisfies one link fails
 * another.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';

const COMPLETE_TS = nodePath.join(__dirname, 'complete.ts');
const source = readFileSync(COMPLETE_TS, 'utf8');

/** The gate block, from where the gate is computed to where its verdict becomes a requirement. */
function gateBlock(): string {
  const start = source.indexOf('const changeKindGateApplies =');
  const end = source.indexOf("setContractRequirement(\n    'change-kind-proof'", start);
  expect(start, 'the change-kind gate block must exist in complete.ts').toBeGreaterThan(-1);
  expect(end, 'the gate verdict must be recorded as the change-kind-proof requirement').toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('complete.ts WIRES the change-kind close gate (change-kind-declared-proof P-002)', () => {
  it('R-2: declares change-kind-proof in the published completion contract', () => {
    // The contract list is what work_items:complete publishes to callers; a gate missing from it
    // refuses closes that no caller was told to expect.
    expect(source).toMatch(
      /key:\s*'change-kind-proof',\s*\n\s*description:\s*'A successful close carries the proof each declared change kind requires\.'/,
    );
  });

  it('R-2: imports evaluateChangeKindGate from the shared change-kind-proof module, not a local copy', () => {
    expect(source).toMatch(
      /import\s*\{\s*evaluateChangeKindGate,\s*type ChangeKindGateResult\s*\}\s*from\s*'\.\.\/\.\.\/change-kind-proof'/,
    );
    expect(source).not.toMatch(/function\s+evaluateChangeKindGate\s*\(/);
  });

  it('R-2: runs the gate for every successful close, not only for some',
    () => {
      expect(source).toMatch(
        /const changeKindGateApplies =\s*\n\s*closeIntentRequested && successfulClose && !duplicateCloseCoverageException && !isAbandonedClose;/,
      );
    },
  );

  it('R-2: feeds the gate the declaration, reason and per-kind evidence the caller actually sent', () => {
    const block = gateBlock();
    expect(block).toMatch(/changeKindGate = await evaluateChangeKindGate\(/);
    expect(block).toMatch(/declaredAtClose:\s*it\.changeKinds \?\? null,/);
    expect(block).toMatch(/declaredReason:\s*it\.changeKindReason \?\? null,/);
    expect(block).toMatch(/kindEvidence:\s*it\.completion\.kindEvidence \?\? null,/);
    // The stored declaration is read for the item being closed, so an earlier claim-time
    // declaration is what the gate checks when none is sent at close.
    expect(block).toMatch(/await readChangeKinds\(declarationWorkspace, declarationIds\)/);
    expect(block).toMatch(/stored,\s*\n\s*storedReadError,/);
  });

  it('R-2: hands the gate the real live-drove-ui artifact check for ui closes', () => {
    // A ui close is only as strict as the artifact check it is given; a stub here would accept
    // any ui close that names a file.
    expect(gateBlock()).toMatch(/verifyUiArtifacts:\s*\(evidence\)\s*=>\s*verifyLiveDroveUiArtifacts\(evidence\)/);
  });

  it('R-2: a refused gate becomes the state error, so the item does not close', () => {
    expect(source).toMatch(
      /const changeKindProofError =\s*\n\s*changeKindGate\.applicable && changeKindGate\.outcome === 'refuse' \? changeKindGate\.error : undefined;/,
    );
    expect(source).toMatch(/\} else if \(changeKindProofError\) \{[^}]*stateError = changeKindProofError;/);
  });

  it('R-2: the refusal returns every missing proof, typed per kind, so the caller can repair each one', () => {
    expect(source).toMatch(
      /\{\s*changeKindProof:\s*\{\s*kinds:\s*changeKindGate\.kinds,\s*missing:\s*changeKindGate\.missing,\s*problems:\s*changeKindGate\.problems\s*\}\s*\}/,
    );
  });

  it('R-6: only a gate verdict of refuse blocks the close; a complete close is not refused here', () => {
    // The refusal is derived ONLY from outcome === 'refuse'. If any other verdict (pass, warn)
    // produced a state error, a close carrying every catalog proof would not land.
    const refusalDerivations = source.match(/changeKindGate\.outcome === 'refuse' \? changeKindGate\.error/g) ?? [];
    expect(refusalDerivations).toHaveLength(2); // the requirement record and the state error
    expect(source).not.toMatch(/changeKindGate\.outcome === 'pass'[^\n]*stateError/);
    expect(source).not.toMatch(/stateError = changeKindWarning/);
  });

  it('R-6: a warn verdict lands the close and returns the warning on the result', () => {
    // P-004 (R-4) widened this: a 'propose' verdict (reasonless narrowing / UI-looking files without
    // 'ui') also lands — as completionAuthority 'proposed' — and returns its warning the same way.
    expect(source).toMatch(
      /const changeKindWarning =\s*\n\s*changeKindGate\.applicable && \(changeKindGate\.outcome === 'warn' \|\| changeKindGate\.outcome === 'propose'\)\s*\n\s*\? changeKindGate\.warning\s*\n\s*: undefined;/,
    );
    expect(source).toMatch(/\.\.\.\(changeKindWarning && closeLanded && !stateError \? \{ changeKindWarning \} : \{\}\)/);
  });
});
