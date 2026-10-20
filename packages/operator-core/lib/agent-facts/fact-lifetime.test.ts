/**
 * P-001/P-002/P-003 (plan facts-require-explicit-expiry-2026-09-02) — the lifetime
 * declaration at the facts write boundary.
 *
 * Both subjects are PURE, so this suite needs no PG. It is written as matched
 * ACCEPT/REFUSE pairs on purpose: a refusal test that only asserts "some error came
 * back" passes just as happily against a validator that refuses everything, so every
 * refusal here pins a distinctive substring AND has an acceptance twin one case away.
 */
import { describe, expect, it } from 'vitest';
import {
  validateFactLifetime,
  resolveFactLifetime,
  DEAD_END_DEFAULT_TTL_SEC,
  WALL_DEFAULT_TTL_SEC,
  FACT_DEFAULT_TTL_SEC,
  FACT_VOLATILE_MAX_TTL_SEC,
  FACT_PROVISIONAL_DEFAULT_TTL_SEC,
  FACT_SUSPECTED_DEFAULT_TTL_SEC,
} from './store';

const ordinary = { key: 'some-conclusion', kind: null } as const;

describe('validateFactLifetime — P-001: a lifetime must be DECLARED', () => {
  it('REFUSES a write that declares nothing at all (the case the 7d default absorbed)', () => {
    const err = validateFactLifetime({ ...ordinary });
    expect(err).toBeTruthy();
    // The refusal has to TEACH the choice, not just reject: an error that says only
    // "invalid" moves the coin-flip instead of removing it.
    expect(err).toContain('there is no default any more');
    expect(err).toContain('ttlSec');
    expect(err).toContain('permanent:true');
  });

  it('accepts an explicit ttlSec', () => {
    expect(validateFactLifetime({ ...ordinary, ttlSec: 3600 })).toBeNull();
  });

  it("accepts kind:'convention' with no ttlSec — permanence declared SEMANTICALLY (P-002)", () => {
    expect(validateFactLifetime({ key: 'k', kind: 'convention' })).toBeNull();
  });

  it('accepts a provisional/suspected confidence tier — it already IMPLIES a short TTL', () => {
    expect(validateFactLifetime({ ...ordinary, confidence: 'provisional' })).toBeNull();
    expect(validateFactLifetime({ ...ordinary, confidence: 'suspected' })).toBeNull();
  });

  it("does NOT accept confidence:'verified' as a declaration — it says nothing about lifetime", () => {
    expect(validateFactLifetime({ ...ordinary, confidence: 'verified' })).toBeTruthy();
  });

  it("does NOT accept a non-convention kind as a declaration — 'conclusion' implies no lifetime", () => {
    expect(validateFactLifetime({ key: 'k', kind: 'conclusion' })).toBeTruthy();
  });

  it.each(['wall:', 'dead-end:', 'guard-rail:'])(
    'accepts a typed safety slot key (%s) — the slot declares durability by construction',
    (prefix) => {
      expect(validateFactLifetime({ key: `${prefix}something`, kind: null })).toBeNull();
    },
  );
});

describe('validateFactLifetime — P-002: permanence is GATED on cap-exemption', () => {
  it('REFUSES permanent:true on an ordinary fact — the unevictable-squatter guard', () => {
    const err = validateFactLifetime({ ...ordinary, permanent: true });
    expect(err).toBeTruthy();
    expect(err).toContain('EXEMPT from the per-scope cap');
    // The reason is load-bearing: ordinary facts now refuse at the ceiling;
    // permanence could hold a slot forever rather than making it evictable.
    expect(err).toContain('later ordinary writes at the ceiling are refused rather than evicting an incumbent');
    expect(err).not.toContain('LEAST evictable');
  });

  it("accepts permanent:true on kind:'convention'", () => {
    expect(validateFactLifetime({ key: 'k', kind: 'convention', permanent: true })).toBeNull();
  });

  it.each(['wall:', 'dead-end:', 'guard-rail:'])(
    'accepts permanent:true on a cap-exempt %s key',
    (prefix) => {
      expect(validateFactLifetime({ key: `${prefix}x`, kind: null, permanent: true })).toBeNull();
    },
  );

  it('REFUSES ttlSec and permanent:true together — one lifetime, not two', () => {
    const err = validateFactLifetime({ key: 'k', kind: 'convention', ttlSec: 60, permanent: true });
    expect(err).toContain('declare ONE lifetime, not two');
  });

  it('REFUSES permanent:true for a volatile subject — a snapshot is never standing', () => {
    const err = validateFactLifetime({
      key: 'guard-rail:x', // cap-exempt, so ONLY the volatile rule can be refusing here
      kind: null,
      permanent: true,
      subjectVolatile: true,
    });
    expect(err).toContain('refused for a volatile measurement');
  });

  it('still accepts an explicit ttlSec for a volatile subject (D-011 clamps, never refuses)', () => {
    expect(
      validateFactLifetime({ ...ordinary, ttlSec: 3600, subjectVolatile: true }),
    ).toBeNull();
  });
});

describe('resolveFactLifetime — what actually gets stored', () => {
  const base = { kind: null, subjectVolatile: false, effectiveTtlSec: null } as const;

  it('an explicit (already-clamped) TTL wins over every default', () => {
    expect(resolveFactLifetime({ ...base, key: 'wall:x', effectiveTtlSec: 60 })).toEqual({
      permanent: false,
      ttlSec: 60,
    });
  });

  it("kind:'convention' with no TTL resolves PERMANENT", () => {
    expect(resolveFactLifetime({ ...base, key: 'k', kind: 'convention' })).toEqual({
      permanent: true,
      ttlSec: 0,
    });
  });

  it('explicit permanent:true resolves PERMANENT', () => {
    expect(resolveFactLifetime({ ...base, key: 'dead-end:x', permanent: true })).toEqual({
      permanent: true,
      ttlSec: 0,
    });
  });

  // D-002 — the asymmetry between the three never-drop slots IS the decision.
  it('guard-rail: resolves PERMANENT — a standing decision (D-002)', () => {
    expect(resolveFactLifetime({ ...base, key: 'guard-rail:x' })).toEqual({
      permanent: true,
      ttlSec: 0,
    });
  });

  it('dead-end: resolves to a LONG BUT FINITE ttl — a claim about current code (D-002)', () => {
    const got = resolveFactLifetime({ ...base, key: 'dead-end:x' });
    expect(got.permanent).toBe(false);
    expect(got.ttlSec).toBe(DEAD_END_DEFAULT_TTL_SEC);
    // The whole point of D-002: it must NOT be permanent, and must NOT be the old 7d
    // that let it lapse and become reaper-eligible (the WI-2141838 defect).
    expect(got.ttlSec).toBeGreaterThan(FACT_DEFAULT_TTL_SEC);
  });

  it('wall: resolves to WALL_DEFAULT_TTL_SEC and stays finite — its watchdog fires ON the lapse', () => {
    expect(resolveFactLifetime({ ...base, key: 'wall:x' })).toEqual({
      permanent: false,
      ttlSec: WALL_DEFAULT_TTL_SEC,
    });
  });

  it('a confidence tier resolves to its own short default (EI-18681964809855890 preserved)', () => {
    expect(resolveFactLifetime({ ...base, key: 'k', confidence: 'provisional' }).ttlSec).toBe(
      FACT_PROVISIONAL_DEFAULT_TTL_SEC,
    );
    expect(resolveFactLifetime({ ...base, key: 'k', confidence: 'suspected' }).ttlSec).toBe(
      FACT_SUSPECTED_DEFAULT_TTL_SEC,
    );
  });

  it('a volatile subject with no TTL resolves to the volatile ceiling, never permanent', () => {
    const got = resolveFactLifetime({
      ...base,
      key: 'guard-rail:x', // would be PERMANENT if volatile did not short-circuit first
      subjectVolatile: true,
    });
    expect(got).toEqual({ permanent: false, ttlSec: FACT_VOLATILE_MAX_TTL_SEC });
  });
});

/**
 * A TYPED SLOT OUTRANKS `kind` (EI-20307375669832848).
 *
 * The cases above each pass a slot key with a NULL kind, so none of them could see the
 * precedence bug: `kind:'convention'` returned PERMANENT before the slot branches were
 * ever reached, silently overriding the two lifetimes D-002 deliberately kept finite.
 * Measured live when this was fixed: 57/57 `dead-end:` and 4/4 `wall:` facts carrying
 * kind:'convention' had expires_at = infinity, none with a recheck.
 *
 * Both orderings satisfy every pre-existing test, which is exactly why this block has to
 * name the combination.
 */
describe('a typed slot outranks kind — the slot lifetime is not overridable by kind', () => {
  const base = { subjectVolatile: false, effectiveTtlSec: null } as const;

  it("dead-end: + kind:'convention' stays FINITE — a claim about current code (D-002)", () => {
    const got = resolveFactLifetime({ ...base, key: 'dead-end:x', kind: 'convention' });
    expect(got).toEqual({ permanent: false, ttlSec: DEAD_END_DEFAULT_TTL_SEC });
  });

  it("wall: + kind:'convention' stays FINITE — an infinite wall can never lapse, so its watchdog could never fire", () => {
    const got = resolveFactLifetime({ ...base, key: 'wall:x', kind: 'convention' });
    expect(got).toEqual({ permanent: false, ttlSec: WALL_DEFAULT_TTL_SEC });
  });

  it("guard-rail: + kind:'convention' is STILL permanent — reordering must not flip the one slot D-002 makes permanent", () => {
    expect(resolveFactLifetime({ ...base, key: 'guard-rail:x', kind: 'convention' })).toEqual({
      permanent: true,
      ttlSec: 0,
    });
  });

  it('explicit permanent:true still wins over a slot — the deliberate, cap-exempt escape hatch survives', () => {
    expect(
      resolveFactLifetime({ ...base, key: 'dead-end:x', kind: 'convention', permanent: true }),
    ).toEqual({ permanent: true, ttlSec: 0 });
  });

  it('an explicit ttlSec still wins over both slot and kind', () => {
    expect(
      resolveFactLifetime({ ...base, key: 'wall:x', kind: 'convention', effectiveTtlSec: 60 }),
    ).toEqual({ permanent: false, ttlSec: 60 });
  });

  // CALIBRATION / negative control. If the fix had been "stop honouring kind:'convention'"
  // rather than "order the slot above it", every assertion above would still pass while
  // ordinary conventions silently lost their permanence. This is the case that fails if
  // the change was scoped too widely, and it must keep passing.
  it("CONTROL: kind:'convention' on a NON-slot key is still PERMANENT", () => {
    expect(resolveFactLifetime({ ...base, key: 'ordinary-key', kind: 'convention' })).toEqual({
      permanent: true,
      ttlSec: 0,
    });
  });

  /**
   * FALSIFIABILITY CONTROL, kept permanently in-file.
   *
   * CLAUDE.md § "Proving a guard is falsifiable" routes a MODULE-you-import subject to a
   * deliberately-wrong implementation held in the test file — never a mutation of
   * production code, which on this swept tree can be committed by git-sync while the
   * probe legitimately holds it dirty.
   *
   * This is the exact branch order that shipped before the fix. Assertions that pass
   * under BOTH orderings would be worthless, so the control shows the old order
   * producing a DIFFERENT answer for the same inputs.
   */
  const preFixOrdering = (input: { key: string; kind: string | null }) => {
    if (input.kind === 'convention') return { permanent: true, ttlSec: 0 };
    if (input.key.startsWith('guard-rail:')) return { permanent: true, ttlSec: 0 };
    if (input.key.startsWith('dead-end:'))
      return { permanent: false, ttlSec: DEAD_END_DEFAULT_TTL_SEC };
    if (input.key.startsWith('wall:')) return { permanent: false, ttlSec: WALL_DEFAULT_TTL_SEC };
    return { permanent: false, ttlSec: FACT_DEFAULT_TTL_SEC };
  };

  it('CONTROL: the pre-fix ordering DISAGREES on exactly these inputs, so the cases above can fail', () => {
    // What the bug did: permanence, for a claim about current code.
    expect(preFixOrdering({ key: 'dead-end:x', kind: 'convention' }).permanent).toBe(true);
    expect(preFixOrdering({ key: 'wall:x', kind: 'convention' }).permanent).toBe(true);
    // What the live function must do instead.
    expect(resolveFactLifetime({ ...base, key: 'dead-end:x', kind: 'convention' }).permanent).toBe(
      false,
    );
    expect(resolveFactLifetime({ ...base, key: 'wall:x', kind: 'convention' }).permanent).toBe(
      false,
    );
  });

  it('CALIBRATION: the two orderings AGREE wherever a finite slot is not involved', () => {
    // Without this, the control would only be showing that the two functions differ
    // SOMEWHERE, which any unrelated edit to either would also satisfy. Agreement here
    // is what isolates the disagreement above to the precedence itself.
    for (const key of ['ordinary-key', 'guard-rail:x']) {
      expect(preFixOrdering({ key, kind: 'convention' })).toEqual(
        resolveFactLifetime({ ...base, key, kind: 'convention' }),
      );
    }
  });
});

describe('the two functions AGREE — resolve is only ever reached past validate', () => {
  /**
   * resolveFactLifetime keeps a final `FACT_DEFAULT_TTL_SEC` fallback so it is a total
   * function. That fallback is UNREACHABLE in production because assertFact runs
   * validateFactLifetime first and throws. This pins that relationship: the only input
   * that reaches the fallback is exactly the input validate refuses, so the removed
   * default cannot quietly come back as resolve's behaviour.
   */
  it('the ONLY input that hits the legacy-default fallback is the one validate REFUSES', () => {
    const undeclared = { key: 'k', kind: null } as const;
    expect(validateFactLifetime(undeclared)).toBeTruthy();
    expect(
      resolveFactLifetime({ ...undeclared, subjectVolatile: false, effectiveTtlSec: null }).ttlSec,
    ).toBe(FACT_DEFAULT_TTL_SEC);
  });

  it('every input validate ACCEPTS resolves without falling through to the legacy default', () => {
    const accepted = [
      { key: 'k', kind: null, effectiveTtlSec: 3600 },
      // `as const`: without it this literal widens to `string`, which no longer
      // satisfies FactLifetimeInput['kind'] (FactKind | null) — see store.ts.
      { key: 'k', kind: 'convention' as const, effectiveTtlSec: null },
      { key: 'wall:x', kind: null, effectiveTtlSec: null },
      { key: 'dead-end:x', kind: null, effectiveTtlSec: null },
      { key: 'guard-rail:x', kind: null, effectiveTtlSec: null },
      { key: 'k', kind: null, confidence: 'provisional' as const, effectiveTtlSec: null },
      { key: 'k', kind: null, confidence: 'suspected' as const, effectiveTtlSec: null },
    ];
    for (const a of accepted) {
      expect(
        validateFactLifetime({ ...a, ttlSec: a.effectiveTtlSec }),
        `validate should accept ${a.key}`,
      ).toBeNull();
      const got = resolveFactLifetime({ ...a, subjectVolatile: false });
      // dead-end deliberately RESOLVES to 90d; nothing accepted should land on 7d.
      expect(got.permanent || got.ttlSec !== FACT_DEFAULT_TTL_SEC, `${a.key} fell to the legacy default`).toBe(
        true,
      );
    }
  });
});
