/**
 * WI-41182 — the recurrence guard for claim-time trap-guard drift.
 *
 * THE CLASS THIS CATCHES: six guards accumulated across four claim surfaces over
 * ~6 weeks, each wired by hand wherever its author was looking. Nothing defined
 * "the set", so nothing could notice a leg landing at three surfaces and missing
 * the fourth — and three of them did exactly that. Measured before the fix:
 * get_next 6/6, work_items:claim 6/6, claim_next 5/6, plan_items:claim 2/6.
 * Every miss was silent: a claim that skipped a guard looked exactly like a claim
 * that passed one.
 *
 * ⚠ WHAT THIS TEST DOES AND DOES NOT PROVE. It is a structural wiring check, not a
 * behavioural one: it parses each surface and requires an invocation for every
 * registered implementation (or the shared builder), not an import, comment, or
 * string containing its name. Dedicated handler tests exercise the runtime paths;
 * port tests prove each guard's behavior. Do not "strengthen" this by asserting on
 * rendered warning text: the four surfaces deliberately render some legs differently
 * (claim_next emits premises as `brief.rendered`, get_next emits the whole brief),
 * and pinning that here would fail on a legitimate presentation change.
 *
 * ⚠ WHY AST INSPECTION HERE. Re-running all four full claim tools would need the
 * claim substrate (org PG, leases, identity) stood up per surface. Existing handler
 * tests exercise those runtime paths with focused fixtures. This test checks the
 * complementary structural invariant, without treating an import as a call. The
 * permanent controls below keep the AST check falsifiable.
 */
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAIM_TIME_ENRICHMENT_LEGS, type ClaimTimeEnrichmentLeg } from './claim-time-enrichment';

const LIB = __dirname;

/**
 * The exported port function that IS each leg. A surface satisfies a leg by
 * calling this directly, or by delegating to `buildClaimTimeEnrichment` (the shared
 * port test below checks that it invokes every registered implementation).
 *
 * ⚠ Adding a member to CLAIM_TIME_ENRICHMENT_LEGS without adding it here fails
 * the exhaustiveness check below — deliberately. That failure is the reminder to
 * wire the new leg at every surface, which is the whole point of this file.
 */
const LEG_IMPLEMENTATION: Record<ClaimTimeEnrichmentLeg, string> = {
  planDecisions: 'getClaimTimePlanDecisions',
  priorAttemptBrief: 'getClaimTimePriorAttemptBrief',
  premises: 'getClaimTimePremises',
  retraction: 'getClaimTimeRetractionAdvisory',
  authorship: 'getClaimTimeAuthorshipRevalidationHint',
  planContradiction: 'getClaimTimePlanItemContradiction',
  behaviorContract: 'getClaimTimeBehaviorContract',
  pathHints: 'getClaimTimeStalePathAdvisory',
  planItemLanded: 'getClaimTimePlanItemLanded',
  siblingPathOverlap: 'getClaimTimeSiblingPathOverlap',
  sourceCitation: 'getClaimTimeSourceCitation',
  taskBrief: 'getClaimTimeTaskBrief',
};

/** Every surface that hands an agent a claimed item and is therefore obliged to warn it. */
const CLAIM_SURFACES: Record<string, string> = {
  'scheduler:get_next': join(LIB, 'agent-tools/scheduler/get_next.ts'),
  'work_items:claim': join(LIB, 'agent-tools/work_items/claim.ts'),
  'work_items:claim_next': join(LIB, 'agent-tools/work_items/claim_next.ts'),
  'plan_items:claim': join(LIB, 'agent-tools/plan-items/claim.ts'),
};

const DELEGATES_TO_PORT = 'buildClaimTimeEnrichment';

function calledFunctions(source: string): Set<string> {
  const file = ts.createSourceFile('claim-surface.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const called = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) called.add(node.expression.text);
      else if (ts.isPropertyAccessExpression(node.expression)) called.add(node.expression.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return called;
}

function attachesLeg(source: string, leg: ClaimTimeEnrichmentLeg): boolean {
  const calls = calledFunctions(source);
  return calls.has(DELEGATES_TO_PORT) || calls.has(LEG_IMPLEMENTATION[leg]);
}

describe('claim-time enrichment parity (WI-41182)', () => {
  it('names an implementation for every registered leg', () => {
    // Calibration: if the registry and this map drift apart, every other
    // assertion below silently narrows. Check that first, so a shrunk map can
    // never look like passing parity.
    expect(Object.keys(LEG_IMPLEMENTATION).sort()).toEqual([...CLAIM_TIME_ENRICHMENT_LEGS].sort());
  });

  it('the shared port attaches every registered leg', () => {
    const port = readFileSync(join(LIB, 'claim-time-enrichment.ts'), 'utf8');
    const calls = calledFunctions(port);
    const missing = CLAIM_TIME_ENRICHMENT_LEGS.filter((leg) => !calls.has(LEG_IMPLEMENTATION[leg]));
    expect(missing, 'the shared port must invoke every registered implementation').toEqual([]);
  });

  it.each(Object.entries(CLAIM_SURFACES))('%s attaches every registered leg', (surface, path) => {
    const source = readFileSync(path, 'utf8');
    const missing = CLAIM_TIME_ENRICHMENT_LEGS.filter((leg) => !attachesLeg(source, leg));
    expect(
      missing,
      `${surface} does not attach: ${missing.join(', ')}. Either call the leg's port directly or ` +
        `delegate the whole set to ${DELEGATES_TO_PORT}. A claim surface that skips a guard is ` +
        `indistinguishable, to the agent it answers, from one where the guard passed.`,
    ).toEqual([]);
  });

  /**
   * PERMANENT CONTROLS (repo mutation-probe policy, "a MODULE / logic you import"
   * row): a deliberately-wrong source kept in the test file forever, rather than
   * mutating a real file to prove falsifiability. Without these, the parity
   * assertion above would still pass if `attachesLeg` were broken to return true
   * unconditionally — the failure mode that turns a guard into decoration.
   */
  describe('falsifiability controls', () => {
    /**
     * The omitted leg is `planContradiction` because that was claim_next's real
     * pre-fix shape — a surface attaching every leg but one.
     *
     * ⚠ DERIVED from the registry, deliberately, rather than a hand-written list of
     * calls. This fixture describes CLAIM_TIME_ENRICHMENT_LEGS, and a hand-maintained
     * second copy drifts. Building it from the registry keeps the control asserting
     * that `attachesLeg` detects exactly one omitted call without needing an edit
     * every time the leg set grows.
     */
    const OMITTED_LEG: ClaimTimeEnrichmentLeg = 'planContradiction';
    const implementedLegs = CLAIM_TIME_ENRICHMENT_LEGS.filter((leg) => leg !== OMITTED_LEG).map(
      (leg) => LEG_IMPLEMENTATION[leg],
    );
    const SURFACE_MISSING_ONE_LEG = [
      ...implementedLegs.map((implementation) => `import { ${implementation} } from './claim-leg-port';`),
      'async function attach(subject: unknown) {',
      ...implementedLegs.map((implementation) => `  await ${implementation}({ workItem: subject });`),
      '}',
    ].join('\n');

    it('rejects a surface that omits a leg', () => {
      const missing = CLAIM_TIME_ENRICHMENT_LEGS.filter((leg) => !attachesLeg(SURFACE_MISSING_ONE_LEG, leg));
      expect(missing).toEqual([OMITTED_LEG]);
    });

    it('does not mistake an imported implementation for an invocation', () => {
      const importOnly = `import { ${LEG_IMPLEMENTATION.planDecisions} } from './plan-decisions-port';`;
      expect(attachesLeg(importOnly, 'planDecisions')).toBe(false);
    });

    it('accepts a surface that delegates the whole set to the port', () => {
      const delegating =
        `import { ${DELEGATES_TO_PORT} } from './claim-time-enrichment';\n` +
        `async function attach(subject: unknown) { return ${DELEGATES_TO_PORT}({ workItem: subject }); }`;
      const missing = CLAIM_TIME_ENRICHMENT_LEGS.filter((leg) => !attachesLeg(delegating, leg));
      expect(missing).toEqual([]);
    });

    it('rejects a surface that attaches nothing', () => {
      const missing = CLAIM_TIME_ENRICHMENT_LEGS.filter((leg) => !attachesLeg('export default {};', leg));
      expect(missing).toEqual([...CLAIM_TIME_ENRICHMENT_LEGS]);
    });
  });
});
