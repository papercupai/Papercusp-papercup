/**
 * EI-19484346966003625 (R1) — the fleet-scope refusal notice must be able to say
 * "this spec is refusing a CLASS", not only "widen the lane for this row".
 *
 * Why this guard exists, stated so a future reader can judge whether it still earns its
 * place: the old notice's ONLY advice was a revision bump shaped around the refused row.
 * On fleet `opencode-omp-research` that framing walked a leader through spec revisions
 * 1→6 across 42h, blocking one member 12 times, and rev 6 still refused 4 of the 6 rows,
 * because the shape it kept missing (`severity: minor`) was not what any single row's
 * widen touched. Every individual patch was correct for the row in front of it.
 *
 * The note is a PURE function of a measured reading, which is what makes it testable here
 * with no database: {@link diagnoseFleetScopeClassRefusal} does the measuring (covered by
 * the sibling integration tests, which own a real pool), and this file pins the decision
 * boundary — including, deliberately, the cases where the note must stay SILENT. A class
 * warning that fires on ordinary one-off refusals is worse than none: leaders learn to
 * skip the line, and it stops being read exactly when it is right.
 */
import { describe, expect, it } from 'vitest';

import { validateClaimSpec } from './claim-spec';
import {
  fencePreservingWidenFilter,
  fleetScopeClassRefusalNote,
  fleetScopeLeaderRemedy,
  type FleetScopeAdmission,
  type FleetScopeClassRefusal,
} from './fleet-scope-admission';

function reading(matchedByFilter: number, poolTotal: number): FleetScopeClassRefusal {
  return { matchedByFilter, poolTotal, specEmpty: matchedByFilter === 0 };
}

/**
 * A refusal admission with a minimal but REAL scope. Only `fleetSlug` and `record.spec`
 * ({specId, revision}) are read by the remedy, so the rest is filled with honest
 * placeholder values rather than a blanket cast of the whole admission.
 */
function refusal(
  code: 'fleet_scope_violation' | 'fleet_winding_down' = 'fleet_scope_violation',
  reporter?: string | null,
): Extract<FleetScopeAdmission, { allowed: false }> {
  return {
    allowed: false,
    scoped: true,
    code,
    reason: 'item does not match the fleet claim spec',
    refusal: { observed: {}, liftsWhen: 'the item matches the fleet claim spec', whoCanMakeItTrue: ['another-agent'] },
    scope: {
      ownerId: 'su-member-0001',
      fleetSlug: 'opencode-omp-research',
      fleetRole: 'member',
      workspaceId: 'ws-test',
      record: {
        source: 'fleet',
        spec: { specId: 'omp-research-lane', revision: 6, states: ['open'], view: { filter: undefined } },
        revision: 6,
        updatedBy: null,
        updatedAt: null,
        // The record type carries fields no code path under test reads; this narrows the
        // stub to the shape the remedy actually consumes without asserting the whole type.
      } as unknown as Extract<FleetScopeAdmission, { allowed: false }>['scope']['record'],
    },
    ...(reporter === undefined ? {} : { reporter }),
  };
}

/**
 * EI-21906739799895413 — the refusal must NAME the fence-preserving widen, not describe it.
 *
 * Measured cost of describing it: a leader whose lane was plan-scoped needed to admit one
 * ad-hoc row, read "…whose view.filter admits this work", invented `{ op:'any', of:[...] }`,
 * was refused "unknown filter op 'any'", and concluded from that one refusal that the DSL
 * has NO boolean composition — then filed a bug asking for a disjunction that had shipped
 * long before. Four blocked calls, two agents idled mid-turn. The missing thing was never
 * the feature; it was the SHAPE, which no amount of prose conveys.
 */
describe('fleetScopeLeaderRemedy — the fence-preserving widen is rendered, not described', () => {
  const planFilter = { field: 'plan' as const, op: '=' as const, value: 'mail-retirement' };

  function planScopedRefusal(): Extract<FleetScopeAdmission, { allowed: false }> {
    const base = refusal();
    return {
      ...base,
      scope: {
        ...base.scope,
        record: {
          ...base.scope.record,
          spec: { ...base.scope.record.spec, view: { filter: planFilter } },
        },
      },
    };
  }

  it('renders an EXECUTABLE widen that keeps the existing fence', () => {
    const body = fleetScopeLeaderRemedy(planScopedRefusal(), true, null, null, 'WI-1338822');
    // The combinator shape, with BOTH disjuncts — the fence survives, the row is admitted.
    expect(body).toContain('"any"');
    expect(body).toContain('"field":"plan"');
    expect(body).toContain('WI-1338822');
    // Name the thing the author got wrong, at the moment they would get it wrong again.
    expect(body).toContain('COMBINATOR');
    // A plan fence can never match an ad-hoc row, so say so rather than leaving them to
    // rediscover it — and steer them off the stamp, which silently makes blockers vanish.
    expect(body).toContain('PLAN-scoped');
    expect(body).toContain('auto-resolves this row as residue');
  });

  it('THE POINT: the filter it recommends actually validates', () => {
    // This is the assertion the whole item reduces to. The old advice was refused by the
    // validator when a reader tried to act on it; advice that cannot survive the validator
    // is worse than none, because it reads as a missing feature.
    const widened = fencePreservingWidenFilter(planFilter, 'WI-1338822');
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'omp-research-lane',
      revision: 7,
      view: { filter: widened },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect(r.ok).toBe(true);
    expect(r.errors ?? []).toEqual([]);
  });

  it('CONTROL: the syntax the reporter actually guessed is still refused', () => {
    // Pins WHY the rendered shape is load-bearing. If this ever starts validating, the
    // remedy text above is no longer rescuing anyone and this guard should be revisited.
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'omp-research-lane',
      revision: 7,
      view: { filter: { op: 'any', of: [planFilter, { field: 'id', op: '=', value: 'WI-1' }] } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect(r.ok).toBe(false);
  });

  it('WITHHELD on a class refusal — it must not license the per-row patching the class note forbids', () => {
    // The class note leads by telling the leader NOT to patch per-row; printing a concrete
    // one-row widen underneath would license exactly what that warning exists to stop
    // (measured: rev 1→6 over 42h, still refusing 4 of 6 rows).
    //
    // A NON-plan filter is required to exercise this: a plan-scoped lane suppresses the
    // class note outright, because a deliberate fence is SUPPOSED to match few rows.
    const base = refusal();
    const kindScoped: Extract<FleetScopeAdmission, { allowed: false }> = {
      ...base,
      scope: {
        ...base.scope,
        record: {
          ...base.scope.record,
          spec: {
            ...base.scope.record.spec,
            view: { filter: { field: 'kind', op: 'in', value: ['bug'] } },
          },
        },
      },
    };
    const body = fleetScopeLeaderRemedy(kindScoped, true, reading(1, 29883), null, 'WI-1338822');
    expect(body).toContain('POSSIBLE CLASS REFUSAL');
    expect(body).not.toContain('"any"');
    expect(body).toContain('whose view.filter admits this work');
    // Same for a spec that admits nothing at all.
    const empty = fleetScopeLeaderRemedy(kindScoped, true, reading(0, 42), null, 'WI-1338822');
    expect(empty).toContain('CLASS REFUSAL');
    expect(empty).not.toContain('"any"');
  });

  it('a PLAN-scoped lane still gets the widen, because its class note is suppressed anyway', () => {
    // The coupling that matters: withhold the widen exactly when the class note is PRINTED,
    // never merely when a low ratio was measured. Keying off the raw reading would strand
    // the plan-scoped refusal — this item's actual case — with prose AND no class warning.
    const body = fleetScopeLeaderRemedy(planScopedRefusal(), true, reading(1, 29883), null, 'WI-1338822');
    expect(body).not.toContain('CLASS REFUSAL');
    expect(body).toContain('"any"');
    expect(body).toContain('WI-1338822');
  });

  it('degrades to the prose wording when the caller cannot supply an id', () => {
    // work_items:create refuses BEFORE the row is persisted, so some callers genuinely have
    // no id. That path must be unchanged, never a half-rendered filter.
    const withId = fleetScopeLeaderRemedy(planScopedRefusal(), true, null, null, 'WI-1');
    const withoutId = fleetScopeLeaderRemedy(planScopedRefusal(), true, null);
    expect(withoutId).toContain('whose view.filter admits this work');
    expect(withoutId).not.toContain('"any"');
    expect(withId).not.toBe(withoutId);
  });

  it('a lane with NO existing fence widens to a bare id leaf, not a pointless disjunction', () => {
    expect(fencePreservingWidenFilter(undefined, 'WI-7')).toEqual({
      field: 'id',
      op: '=',
      value: 'WI-7',
    });
  });
});

describe('fleetScopeClassRefusalNote — the decision boundary', () => {
  it('a spec matching ZERO of the pool says so, and says a per-row widen cannot help', () => {
    const note = fleetScopeClassRefusalNote(reading(0, 42));
    expect(note).toContain('CLASS REFUSAL');
    expect(note).toContain('ZERO');
    expect(note).toContain('42');
    // The load-bearing claim: not merely "there is a class problem" but that the advice
    // the leader is about to read below it is INAPPLICABLE. Without this the notice
    // contradicts itself and the reader follows the more concrete instruction.
    expect(note).toMatch(/cannot fix that|cannot help/i);
  });

  it('a LOW ratio over a big enough pool poses the class question with both counts', () => {
    const note = fleetScopeClassRefusalNote(reading(3, 100));
    expect(note).toContain('POSSIBLE CLASS REFUSAL');
    expect(note).toContain('3 of 100');
    // The excluded count is the number the leader has to reason about, so it is stated
    // rather than left as arithmetic.
    expect(note).toContain('97');
  });

  it('is SILENT when the spec matches most of the pool — an ordinary one-off refusal', () => {
    expect(fleetScopeClassRefusalNote(reading(80, 100))).toBe('');
    // Exactly at the boundary: half the pool is not evidence of a class problem.
    expect(fleetScopeClassRefusalNote(reading(50, 100))).toBe('');
  });

  it('is SILENT on a pool too small for a ratio to carry information', () => {
    // 1-of-9 is numerically a worse ratio than 3-of-100, and means nothing: a fleet lane
    // legitimately scopes to a handful of rows. Firing here is how the line gets ignored.
    expect(fleetScopeClassRefusalNote(reading(1, 9))).toBe('');
  });

  it('is SILENT on a missing reading, rather than guessing', () => {
    expect(fleetScopeClassRefusalNote(null)).toBe('');
    expect(fleetScopeClassRefusalNote(undefined)).toBe('');
  });

  /**
   * CONTROL — a permanently-wrong implementation kept in the test file, so the assertions
   * above are known to DISCRIMINATE rather than merely to pass. `alwaysWarn` is what a
   * naive "always mention the class" version would do; it must fail the silence cases that
   * the real function passes. If this control ever passes them, the silence assertions have
   * stopped testing anything and the boundary is unguarded.
   */
  it('CONTROL: an always-warn implementation fails the silence cases the real one passes', () => {
    const alwaysWarn = (r: FleetScopeClassRefusal | null | undefined): string =>
      r ? `⚠ POSSIBLE CLASS REFUSAL — matches ${r.matchedByFilter} of ${r.poolTotal}` : '';

    // The real function is silent here…
    expect(fleetScopeClassRefusalNote(reading(80, 100))).toBe('');
    expect(fleetScopeClassRefusalNote(reading(1, 9))).toBe('');
    // …and the naive one is not, which is precisely what those cases detect.
    expect(alwaysWarn(reading(80, 100))).not.toBe('');
    expect(alwaysWarn(reading(1, 9))).not.toBe('');

    // Calibration: the control must still AGREE with the real function on the case that
    // genuinely warrants a warning — otherwise it is failing for an unrelated reason and
    // proves nothing about the boundary.
    expect(alwaysWarn(reading(3, 100))).not.toBe('');
    expect(fleetScopeClassRefusalNote(reading(3, 100))).not.toBe('');
  });
});

describe('fleetScopeLeaderRemedy — how the class reading reaches the leader', () => {
  it('offers the tracker fallback only when a different reporter is known', () => {
    const peerReporter = fleetScopeLeaderRemedy(refusal('fleet_scope_violation', 'su-reporter'), true);
    expect(peerReporter).toContain('only TRACKS work you can perform without holding it');
    expect(peerReporter).toContain('ask the reporter (su-reporter) to close the item against your result');

    const selfReporter = fleetScopeLeaderRemedy(refusal('fleet_scope_violation', 'su-member-0001'), true);
    expect(selfReporter).not.toContain('only TRACKS work you can perform without holding it');

    const unknownReporter = fleetScopeLeaderRemedy(refusal());
    expect(unknownReporter).not.toContain('only TRACKS work you can perform without holding it');
  });

  it('EI-21884167889601047: demotes the plan_item backfill to LAST RESORT, after the safe widen/route remedies, and suppresses the ratio warning', () => {
    // The stamp used to LEAD the refusal, ahead of "widen the lane" / "complete it
    // yourself" — the one-call fix read as THE intended path under an agent's bias
    // toward unblocking itself, and it is not a neutral relabel: a wrong stamp
    // creates a coverage edge that silently makes a blocker disappear once the plan
    // item closes. Demoted to last, phrased as a conditional test, consequence stated
    // inline.
    const base = refusal();
    const planViolation: Extract<FleetScopeAdmission, { allowed: false }> = {
      ...base,
      scope: {
        ...base.scope,
        record: {
          ...base.scope.record,
          spec: {
            ...base.scope.record.spec,
            view: { filter: { field: 'plan', op: '=', value: 'mail-retirement' } },
          },
        },
      },
    };
    const body = fleetScopeLeaderRemedy(planViolation, true, reading(1, 29883));
    const stampAt = body.indexOf('plan_item');
    const widenAt = body.indexOf('WIDEN the fleet lane');

    expect(body).toContain("plan-scoped to 'mail-retirement'");
    expect(body).toContain('work_items:update');
    expect(body).toContain('without a spec revision');
    expect(body).toContain('LAST RESORT');
    expect(body).toContain('CONSEQUENCE');
    // WI-10004362 reworded this consequence: completing the stamped row may reflect its plan
    // item to done, and closing that item later MAY (not always) auto-resolve it as residue.
    expect(body).toContain('may reflect its plan item to `done`');
    expect(body).toContain('auto-resolve this work-item as residue');
    expect(body).not.toContain('POSSIBLE CLASS REFUSAL');
    expect(stampAt).toBeGreaterThanOrEqual(0);
    expect(widenAt).toBeGreaterThanOrEqual(0);
    expect(widenAt).toBeLessThan(stampAt);
  });

  it('PREPENDS the class note, so it is read before the per-row advice it can invalidate', () => {
    const body = fleetScopeLeaderRemedy(refusal(), true, reading(0, 42));
    const classAt = body.indexOf('CLASS REFUSAL');
    const widenAt = body.indexOf('WIDEN the fleet lane');
    expect(classAt).toBeGreaterThanOrEqual(0);
    expect(widenAt).toBeGreaterThanOrEqual(0);
    // Order is the whole point: a leader who reads only the first sentence must not walk
    // away with "bump a revision for this row" when the spec provably admits nothing.
    expect(classAt).toBeLessThan(widenAt);
  });

  it('is byte-identical to the pre-change wording when no reading was taken', () => {
    // Backwards compatibility is the safety property here: every caller that does not (or
    // cannot) supply a harness must get exactly the old notice, never a degraded one.
    const withNull = fleetScopeLeaderRemedy(refusal(), true, null);
    const withoutArg = fleetScopeLeaderRemedy(refusal(), true);
    expect(withNull).toBe(withoutArg);
    expect(withNull).toContain('WIDEN the fleet lane');
    expect(withNull).not.toContain('CLASS REFUSAL');
  });

  it('never emits a class note for a PAUSED fleet, whose remedy is stand-down not widen', () => {
    // A measured, correct class reading would be actively misleading here: the member must
    // not acquire work at all, so any "widen the spec" framing is the wrong instruction.
    const body = fleetScopeLeaderRemedy(refusal('fleet_winding_down'), null, reading(0, 42));
    expect(body).not.toContain('CLASS REFUSAL');
    expect(body).toContain('PAUSED');
    expect(body).toContain('do NOT widen');
  });

  it('still carries the no-live-target warning alongside a class note', () => {
    // The two enrichments are independent; a regression that made one displace the other
    // would be invisible without this.
    const body = fleetScopeLeaderRemedy(refusal(), false, reading(0, 42));
    expect(body).toContain('CLASS REFUSAL');
    expect(body).toContain('no other live agent');
  });
});
