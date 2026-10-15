/**
 * Guard for the claim that `plans:add-decision` hands back a RESOLVABLE
 * decision reference (`<slug>#D-NNN`), never a bare per-plan `D-NNN`.
 *
 * FALSIFIABILITY, without mutating the shared tree. Per the repo's mutation-probe
 * tiers, an imported module is proven with permanent fixture controls rather than
 * an in-tree mutation: the OFFENDING fixtures below must be REJECTED and the
 * COMPLIANT ones ACCEPTED, so a judge hardcoded to "no offenders" fails here
 * instead of passing everything. The calibration case the controls exist to
 * catch is a non-greedy `return {…}` matcher, which stops at the first nested
 * `}` and would report a compliant multi-line return as an offender.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  isQualifiedDecisionRef,
  isBareDecisionId,
  extractReturnObjectLiterals,
  auditDecisionEmitterSource,
} from './decision-ref-qualification';
import { planDecisionRef, planItemRef } from '../agent-goal-ref';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Overridable so falsifiability can be proven against a COPY (mutation-probe
// tier 2) instead of mutating this shared, continuously-swept tree.
const EMITTER =
  process.env.DECISION_EMITTER_PATH ?? path.resolve(HERE, '../agent-tools/plans/add-decision.ts');

describe('planDecisionRef — the qualified form', () => {
  it('qualifies a decision with its plan', () => {
    expect(planDecisionRef('unified-agent-state-plane-2026-07-27', 'D-087')).toBe(
      'unified-agent-state-plane-2026-07-27#D-087',
    );
  });

  it('returns null rather than a half-formed ref when either side is missing', () => {
    expect(planDecisionRef('', 'D-001')).toBeNull();
    expect(planDecisionRef('some-plan-2026-01-01', '')).toBeNull();
    // A blank ref is worse than none: `#D-001` reads as qualified but resolves nowhere.
    expect(planDecisionRef('   ', 'D-001')).toBeNull();
  });

  it('is a SEPARATE namespace from planItemRef even though the shape matches', () => {
    // planItemRef is pinned byte-for-byte to coord_links.dst_ref for the
    // corroboration join. They agree today; this asserts they are two functions,
    // so a join-driven change to one cannot silently move the other.
    expect(planDecisionRef).not.toBe(planItemRef);
  });
});

describe('reference classification', () => {
  it('accepts the qualified form', () => {
    expect(isQualifiedDecisionRef('my-plan-2026-09-05#D-001')).toBe(true);
  });

  it('REJECTS a bare per-plan number — the whole point of the claim', () => {
    // CONTROL: if this ever passes, the classifier has stopped distinguishing a
    // reference from a number, and every other assertion here is worthless.
    expect(isQualifiedDecisionRef('D-001')).toBe(false);
    expect(isBareDecisionId('D-001')).toBe(true);
    expect(isBareDecisionId('my-plan-2026-09-05#D-001')).toBe(false);
  });

  it('rejects a ref with no plan on the left of the #', () => {
    expect(isQualifiedDecisionRef('#D-001')).toBe(false);
  });
});

describe('extractReturnObjectLiterals — brace matching, not first-brace', () => {
  it('CONTROL: captures a return whose ref sits AFTER a nested object', () => {
    // A non-greedy /return \{[^}]*\}/ matcher stops at the nested `}` and never
    // sees `ref`. That broken extractor would report this compliant source as an
    // offender, so this case calibrates the instrument itself.
    const src = `
      function f() {
        return {
          decisionId,
          revision: { seq: 1 },
          ref: 'plan-a-2026-01-01#D-002',
        };
      }`;
    const [lit] = extractReturnObjectLiterals(src);
    expect(lit).toContain('ref:');
    expect(auditDecisionEmitterSource(src).offenders).toEqual([]);
  });

  it('CONTROL: an offending return IS flagged', () => {
    const src = `
      function f() {
        return {
          ok: true,
          decisionId,
          slug: it.slug,
        };
      }`;
    const audit = auditDecisionEmitterSource(src);
    expect(audit.returnsCarryingDecisionId).toBe(1);
    expect(audit.offenders).toHaveLength(1);
  });

  it('ignores returns that have nothing to do with decisions', () => {
    const src = `function f() { return { ok: true, slug: 'x' }; }`;
    expect(auditDecisionEmitterSource(src).returnsCarryingDecisionId).toBe(0);
  });

  it('excludes the INTERNAL lock envelope, which may carry a bare id', () => {
    // withPlanLock's callback shape. The qualified ref is derived once at the
    // outer boundary, so requiring it here would be a false positive.
    const src = `
      function f() {
        return { newBody: final, value: { ok: true, decisionId, slug: it.slug } };
      }`;
    expect(auditDecisionEmitterSource(src).returnsCarryingDecisionId).toBe(0);
  });

  it('CONTROL: a SPREAD-based caller return missing ref is still flagged', () => {
    // The hole a token match leaves: the real success return is written
    // `{ ...result.value, ref }`, so a regression that deletes the ref line
    // leaves no literal `decisionId` token behind to match on.
    const src = `
      function f() {
        return { ...result.value, filePath: result.filePath };
      }`;
    const audit = auditDecisionEmitterSource(src);
    expect(audit.returnsCarryingDecisionId).toBe(1);
    expect(audit.offenders).toHaveLength(1);
  });

  it('excludes a REFUSAL envelope that spreads the lock result (EI-25743754504297634)', () => {
    // A lock refusal spreads `result.value` too, but that value carries a code,
    // never a decisionId, so it owes no `ref`. The success-shaped control above
    // (no `error:` / `ok: false`) is still flagged.
    const src = `
      function f() {
        if (result.kind === 'refused') return { slug: it.slug, error: result.value.code, ...result.value };
        return { ...result.value, ref: decisionRef };
      }`;
    const audit = auditDecisionEmitterSource(src);
    expect(audit.returnsCarryingDecisionId).toBe(1);
    expect(audit.offenders).toEqual([]);
  });

  it('CONTROL: prose ABOUT decisionId in a comment is not mistaken for code', () => {
    // Without comment-stripping, the real file's own explanatory comment would
    // satisfy the match and mask a genuinely offending return.
    const src = `
      function f() {
        // decisionId alone is not a reference; see planDecisionRef.
        return { ok: true, slug: 'x' };
      }`;
    expect(auditDecisionEmitterSource(src).returnsCarryingDecisionId).toBe(0);
  });
});

describe('plans:add-decision never returns a decision id without its ref', () => {
  const source = readFileSync(EMITTER, 'utf8');
  const audit = auditDecisionEmitterSource(source);

  it('actually scanned some returns (anti-vacuity)', () => {
    // Without this, a refactor that renames `decisionId` turns the assertion
    // below into "0 offenders out of 0 scanned" — a green that measured nothing,
    // indistinguishable from a real pass.
    expect(audit.returnsCarryingDecisionId).toBeGreaterThanOrEqual(2);
  });

  it('exposes `ref` on every success return carrying `decisionId`', () => {
    expect(audit.offenders).toEqual([]);
  });

  it('tells the caller to cite `ref`, so the guidance and the code agree', () => {
    expect(source).toContain('CITE `ref`');
  });
});
