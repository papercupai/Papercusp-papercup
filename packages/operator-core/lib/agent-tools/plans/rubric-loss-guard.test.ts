/**
 * rubric-loss-guard.test.ts — the RECURRENCE GUARD for EI-21972673091438558.
 *
 * A rubric's criteria live in a plan row's `template_data`. Two doors write that column,
 * and until this guard only `rubrics:propose` was checked: `plans:set-template-data`
 * validates STRUCTURE ONLY, so a criteria array of length 1 satisfied its zod schema
 * exactly as well as one of length 27. The portfolio-activity-floor criterion added by
 * goal-mode-drift-guards P-001 went in through that unguarded door and could have been
 * deleted through it just as silently.
 *
 * These cases pin the RULES (this file, pure). The WIRING — that withPlanLock actually
 * calls the guard on the set-template-data path — is pinned by
 * rubrics.integration.test.ts § 'template_data persistence boundary', because the
 * boundary itself is DB-bound. Both are required: rules that nothing calls, and a call
 * site with no rules, each look exactly like a working guard from the other side.
 */
import { describe, expect, it } from 'vitest';
import {
  assertNoSilentRubricTemplateDataLoss,
  collectRubricLossViolations,
  criterionProcedureText,
  METHOD_SHRINK_GUARD_MIN_CHARS,
  REPLICATION_DRILL_MARKER,
  type RubricLossCriterion,
  guardAcceptanceBarTemplateDataWrite,
  nextAcceptanceBarMeaningRevision,
} from './rubric-loss-guard';

const LONG_DRILL =
  `${REPLICATION_DRILL_MARKER} — full end-to-end procedure: seed two SYNTHETIC portfolio acts ` +
  'inside the graded window, confirm the ledger query returns exactly those two, then delete ' +
  'them and confirm the same query returns zero. A zero from a mis-scoped query is byte-identical ' +
  'to a genuinely idle subject, so the positive control is what tells the two apart. Only after ' +
  'the control passes may a zero be rated FAIL rather than unknown.';

function crit(over: Partial<RubricLossCriterion> = {}): RubricLossCriterion {
  return { key: 'a', method: LONG_DRILL, ...over };
}

/** The stored rubric these cases defend: two criteria, one carrying a long drill. */
function storedCriteria(): RubricLossCriterion[] {
  return [crit({ key: 'portfolio-activity-floor' }), crit({ key: 'never-implements' })];
}

/** template_data as the rubric schema actually stores it. */
function templateData(criteria: RubricLossCriterion[]): unknown {
  return {
    characteristic: 'goal-mode',
    criteria: criteria.map((c) => ({
      key: c.key,
      title: c.key,
      model: 'model prose',
      method: c.method ?? 'method prose',
      driftMarkers: 'drift prose',
      ...(c.replication !== undefined ? { replication: c.replication } : {}),
      ...(c.check !== undefined ? { check: c.check } : {}),
      ...(c.criterionClass !== undefined ? { criterionClass: c.criterionClass } : {}),
    })),
    ratingScale: ['pass', 'fail', 'unknown'],
  };
}

describe('collectRubricLossViolations — the shared rule core', () => {
  it('passes an identical resubmit and an ADDITIVE one (the P-001 write itself)', () => {
    expect(collectRubricLossViolations(storedCriteria(), storedCriteria())).toEqual([]);
    expect(
      collectRubricLossViolations(storedCriteria(), [...storedCriteria(), crit({ key: 'new' })]),
    ).toEqual([]);
  });

  it('reports a dropped criterion, and names the dropKeys ack that would allow it', () => {
    const violations = collectRubricLossViolations(storedCriteria(), [
      crit({ key: 'never-implements' }),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("'portfolio-activity-floor'");
    expect(violations[0]).toContain('dropKeys');
  });

  it('accepts a dropped criterion once it is acknowledged', () => {
    expect(
      collectRubricLossViolations(storedCriteria(), [crit({ key: 'never-implements' })], {
        dropKeys: ['portfolio-activity-floor'],
      }),
    ).toEqual([]);
  });

  it('reports a gutted procedure (marker loss) on a surviving criterion', () => {
    const gutted = storedCriteria().map((c) =>
      c.key === 'portfolio-activity-floor' ? { ...c, method: 'Check it.' } : c,
    );
    const violations = collectRubricLossViolations(storedCriteria(), gutted);
    expect(violations.join(' ')).toContain(REPLICATION_DRILL_MARKER);
    // ...and an explained shrink is allowed.
    expect(
      collectRubricLossViolations(storedCriteria(), gutted, {
        allowMethodShrink: true,
        shrinkReason: 'drill moved to the shared methodRef',
      }),
    ).toEqual([]);
  });

  it('reports structured-check removal and violatable→settle-once downgrade', () => {
    const withCheck = storedCriteria().map((c) =>
      c.key === 'never-implements'
        ? { ...c, check: { kind: 'tests' }, criterionClass: 'violatable' }
        : c,
    );
    const weakened = withCheck.map((c) =>
      c.key === 'never-implements' ? { key: c.key, method: c.method } : c,
    );
    const violations = collectRubricLossViolations(withCheck, weakened).join(' ');
    expect(violations).toContain('LOSES its structured tests check');
    expect(violations).toContain('DOWNGRADES');
  });

  it('does not fire on a short method being reworded (below the shrink floor)', () => {
    const short = [crit({ key: 'a', method: 'Count the acts.' })];
    expect(short[0]!.method!.length).toBeLessThan(METHOD_SHRINK_GUARD_MIN_CHARS);
    expect(collectRubricLossViolations(short, [crit({ key: 'a', method: 'Count acts.' })])).toEqual(
      [],
    );
  });

  it('treats method+replication as ONE procedure text — moving the drill is not a loss', () => {
    const before = [crit({ key: 'a', method: LONG_DRILL })];
    const after = [crit({ key: 'a', method: 'See the drill.', replication: LONG_DRILL })];
    expect(criterionProcedureText(after[0]!)).toContain(REPLICATION_DRILL_MARKER);
    expect(collectRubricLossViolations(before, after)).toEqual([]);
  });
});

describe('assertNoSilentRubricTemplateDataLoss — the persistence boundary', () => {
  const stored = templateData(storedCriteria());

  it('THROWS when a template_data write would delete a stored criterion', () => {
    expect(() =>
      assertNoSilentRubricTemplateDataLoss({
        slug: 'goal-mode-e2e',
        storedTemplateData: stored,
        nextTemplateData: templateData([crit({ key: 'never-implements' })]),
      }),
    ).toThrowError(/portfolio-activity-floor/);
  });

  it('THROWS with the invalid_args caller-error prefix, pointing at the acking verbs', () => {
    let message = '';
    try {
      assertNoSilentRubricTemplateDataLoss({
        slug: 'goal-mode-e2e',
        storedTemplateData: stored,
        nextTemplateData: templateData([crit({ key: 'never-implements' })]),
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message.startsWith('invalid_args:')).toBe(true);
    expect(message).toContain('rubrics:propose');
    expect(message).toContain('plans:set-template-data');
  });

  it('THROWS on a CLEAR — data:null erases every criterion at once', () => {
    expect(() =>
      assertNoSilentRubricTemplateDataLoss({
        slug: 'goal-mode-e2e',
        storedTemplateData: stored,
        nextTemplateData: null,
      }),
    ).toThrowError(/DROPS 2 stored criteria/);
  });

  it('allows the same deletion once the caller acknowledged it (the propose door)', () => {
    expect(() =>
      assertNoSilentRubricTemplateDataLoss({
        slug: 'goal-mode-e2e',
        storedTemplateData: stored,
        nextTemplateData: templateData([crit({ key: 'never-implements' })]),
        ack: { dropKeys: ['portfolio-activity-floor'] },
      }),
    ).not.toThrow();
  });

  it('allows an ADDITIVE write — how P-001 added the floor criterion in the first place', () => {
    expect(() =>
      assertNoSilentRubricTemplateDataLoss({
        slug: 'goal-mode-e2e',
        storedTemplateData: templateData([crit({ key: 'never-implements' })]),
        nextTemplateData: stored,
      }),
    ).not.toThrow();
  });

  it('is inert for a brand-new rubric and for unparseable stored data', () => {
    const next = templateData([crit({ key: 'only-one' })]);
    for (const storedData of [null, undefined, { not: 'a rubric' }, { criteria: [] }]) {
      expect(() =>
        assertNoSilentRubricTemplateDataLoss({
          slug: 'fresh',
          storedTemplateData: storedData,
          nextTemplateData: next,
        }),
      ).not.toThrow();
    }
  });
});

describe('guardAcceptanceBarTemplateDataWrite — P-004 started-BAR chokepoint', () => {
  const contract = {
    schemaVersion: 1 as const,
    adoptionEpoch: 1,
    cohort: 'post-epoch' as const,
    subjectPlanRevision: 7,
    seededAt: '2026-09-04T20:00:00.000Z',
    seededBy: 'seed-author',
  };
  const criterion = (overrides: Record<string, unknown> = {}) => ({
    key: 'r-1',
    title: 'Outcome',
    model: 'The outcome holds.',
    method: 'Initial method.',
    driftMarkers: 'The outcome is absent.',
    barKey: 'R-1',
    barHash: 'a'.repeat(64),
    role: 'outcome' as const,
    mandatory: true,
    requiredScope: ['tree'],
    evidencePlane: 'tree' as const,
    passRatings: ['healthy'],
    barProvenance: {
      lifecycle: 'pre-implementation' as const,
      declaredAt: contract.seededAt,
      declaredBy: 'seed-author',
    },
    ...overrides,
  });
  const started = (overrides: Record<string, unknown> = {}) => ({
    kind: 'acceptance' as const,
    subjectPlan: 'subject-plan',
    characteristic: 'contract',
    criteria: [criterion(overrides)],
    ratingScale: ['healthy', 'unknown'],
    barSetHash: 'b'.repeat(64),
    barContract: contract,
    proposedBy: 'seed-author',
  });

  it('fails closed when an adopted subject points at a rubric whose server contract is missing', () => {
    const { barContract: _contract, barSetHash: _setHash, ...orphaned } = started();
    expect(() =>
      guardAcceptanceBarTemplateDataWrite({
        slug: 'acceptance-subject-plan',
        storedTemplateData: orphaned,
        nextTemplateData: orphaned,
        // A genuinely adopted subject carries seeding evidence, not merely an epoch.
        subjectPlan: {
          adoptionEpoch: 1,
          cohort: 'post-epoch',
          seededAt: '2026-09-06T00:00:00.000Z',
          seededBy: 'seed-author',
          rubricSlug: 'acceptance-subject-plan',
        },
      }),
    ).toThrow(/already adopted an acceptance BAR contract.*missing its server-owned barContract/);

    expect(
      guardAcceptanceBarTemplateDataWrite({
        slug: 'acceptance-subject-plan',
        storedTemplateData: orphaned,
        nextTemplateData: orphaned,
        subjectPlan: { adoptionEpoch: null },
      }).started,
    ).toBe(false);
  });

  it('allows authoring an unstarted successor while another rubric remains pinned', () => {
    const { barContract: _contract, barSetHash: _setHash, ...successor } = started();
    const next = { ...successor, criteria: [criterion({ method: 'Successor replication procedure.' })] };
    const result = guardAcceptanceBarTemplateDataWrite({
      slug: 'acceptance-subject-successor',
      storedTemplateData: successor,
      nextTemplateData: next,
      subjectPlan: {
        adoptionEpoch: 1,
        cohort: 'post-epoch',
        seededAt: '2026-09-06T00:00:00.000Z',
        seededBy: 'seed-author',
        rubricSlug: 'acceptance-subject-plan',
      },
    });
    expect(result.started).toBe(false);
    expect(result.data).not.toHaveProperty('barContract');
    expect(result.data.criteria).toEqual(next.criteria);
  });

  it.each([undefined, null, '', '   '])('keeps an unknown seeded rubric pin fail-closed (%s)', (rubricSlug) => {
    const { barContract: _contract, barSetHash: _setHash, ...orphaned } = started();
    expect(() => guardAcceptanceBarTemplateDataWrite({
      slug: 'acceptance-subject-successor',
      storedTemplateData: orphaned,
      nextTemplateData: orphaned,
      subjectPlan: {
        adoptionEpoch: 1,
        seededAt: '2026-09-06T00:00:00.000Z',
        seededBy: 'seed-author',
        rubricSlug,
      },
    })).toThrow(/missing its server-owned barContract/);
  });

  // A cohort backfill stamps acceptance_bar_epoch/_cohort onto plans it never seeded
  // (acceptance_bar_seeded_at/_by stay NULL).  Testing the bare epoch read those plans as
  // "already adopted" and refused every generic template_data write to their rubric — with no
  // barContract to protect and the named recovery path itself blocked by the refusal.  That
  // deadlock stranded plan gmail-oauth-system-browser-2026-09-05 short of ship: its criteria
  // could not be filled at all.  Observed on that row: epoch=1, cohort='post-epoch',
  // seeded_at=NULL, seeded_by=NULL, set_hash=NULL, rubric_slug=NULL.
  it('permits template_data writes when the subject is cohort-stamped but was never seeded', () => {
    const { barContract: _contract, barSetHash: _setHash, ...orphaned } = started();
    const stamped = {
      adoptionEpoch: 1,
      cohort: 'post-epoch' as const,
      seededAt: null,
      seededBy: null,
    };

    expect(
      guardAcceptanceBarTemplateDataWrite({
        slug: 'acceptance-subject-plan',
        storedTemplateData: orphaned,
        nextTemplateData: orphaned,
        subjectPlan: stamped,
      }).started,
    ).toBe(false);

    // The write this unblocks is the real one: filling a criterion's empty model.
    const filled = {
      ...orphaned,
      criteria: [criterion({ model: 'The flow completes in the system browser.' })],
    };
    expect(() =>
      guardAcceptanceBarTemplateDataWrite({
        slug: 'acceptance-subject-plan',
        storedTemplateData: orphaned,
        nextTemplateData: filled,
        subjectPlan: stamped,
      }),
    ).not.toThrow();

    // Half-evidence is not adoption evidence: neither column alone re-arms the refusal.
    for (const partial of [
      { ...stamped, seededAt: '2026-09-06T00:00:00.000Z' },
      { ...stamped, seededBy: 'seed-author' },
    ]) {
      expect(
        guardAcceptanceBarTemplateDataWrite({
          slug: 'acceptance-subject-plan',
          storedTemplateData: orphaned,
          nextTemplateData: orphaned,
          subjectPlan: partial,
        }).started,
      ).toBe(false);
    }
  });

  it('refuses BAR meaning changes through a generic writer', () => {
    expect(() =>
      guardAcceptanceBarTemplateDataWrite({
        slug: 'acceptance-subject-plan',
        storedTemplateData: started(),
        nextTemplateData: started({ model: 'A weaker outcome.' }),
      }),
    ).toThrow(/cannot change outside rubrics:amend/);
  });

  it('approval-gates a check-only change through the shared BAR meaning fields', () => {
    const stored = started({ check: { kind: 'tests', files: ['packages/x/a.test.ts'] } });
    const next = started({ check: { kind: 'tests', files: ['packages/x/b.test.ts'] } });
    expect(() => guardAcceptanceBarTemplateDataWrite({
      slug: 'acceptance-subject-plan',
      storedTemplateData: stored,
      nextTemplateData: next,
    })).toThrow(/cannot change outside rubrics:amend/);

    const amended = guardAcceptanceBarTemplateDataWrite({
      slug: 'acceptance-subject-plan',
      storedTemplateData: stored,
      nextTemplateData: next,
      actorId: 'amend-author',
      amendment: { actorId: 'amend-author', reason: 'Update the deterministic test coverage.' },
    });
    expect(amended.changes).toEqual([
      expect.objectContaining({ barKey: 'R-1', kind: 'meaning', fields: ['check'] }),
    ]);
  });

  it('allows METHOD edits but overwrites spoofed provenance from the stored contract', () => {
    const result = guardAcceptanceBarTemplateDataWrite({
      slug: 'acceptance-subject-plan',
      storedTemplateData: started(),
      nextTemplateData: started({
        method: 'Run the new structured check.',
        barProvenance: {
          lifecycle: 'legacy-backfilled',
          declaredAt: '2030-01-01T00:00:00.000Z',
          declaredBy: 'spoofed-caller',
        },
      }),
      subjectPlan: { revision: 8, adoptionEpoch: 1, cohort: 'post-epoch' },
    });
    expect(result.data.criteria).toMatchObject([
      { method: 'Run the new structured check.', barProvenance: criterion().barProvenance },
    ]);
    expect(result.data.barContract).toMatchObject({ subjectPlanRevision: 8, seededBy: 'seed-author' });
  });

  it('corrects a pre-implementation label through an authenticated amendment without rewriting its declaration', () => {
    const stored = started();
    const corrected = guardAcceptanceBarTemplateDataWrite({
      slug: 'acceptance-subject-plan',
      storedTemplateData: stored,
      nextTemplateData: started({
        barProvenance: {
          lifecycle: 'legacy-backfilled',
          declaredAt: '2030-01-01T00:00:00.000Z',
          declaredBy: 'spoofed-caller',
        },
      }),
      actorId: 'amend-author',
      amendment: { actorId: 'amend-author', reason: 'These outcomes were declared after implementation.' },
    });
    expect(corrected.data.criteria).toMatchObject([{
      barHash: stored.criteria[0].barHash,
      barProvenance: { ...stored.criteria[0].barProvenance, lifecycle: 'legacy-backfilled' },
    }]);
    expect(corrected.changes).toEqual([{ barKey: 'R-1', kind: 'provenance', fields: ['barProvenance'] }]);
    expect(corrected.data.barContract).toEqual(contract);
  });

  it.each([
    { storedLifecycle: 'pre-implementation', offeredLifecycle: 'legacy-backfilled', authenticated: false },
    { storedLifecycle: 'legacy-backfilled', offeredLifecycle: 'pre-implementation', authenticated: true },
    { storedLifecycle: 'legacy-backfilled', offeredLifecycle: 'legacy-backfilled', authenticated: true },
  ])('preserves declaration provenance for unsupported corrections: %j', ({ storedLifecycle, offeredLifecycle, authenticated }) => {
    const prior = { ...criterion().barProvenance, lifecycle: storedLifecycle };
    const result = guardAcceptanceBarTemplateDataWrite({
      slug: 'acceptance-subject-plan',
      storedTemplateData: started({ barProvenance: prior }),
      nextTemplateData: started({
        barProvenance: { lifecycle: offeredLifecycle, declaredAt: '2030-01-01T00:00:00.000Z', declaredBy: 'spoofed-caller' },
      }),
      ...(authenticated ? { actorId: 'amend-author' } : {}),
      amendment: { actorId: 'amend-author', reason: 'Request a provenance correction.' },
    });
    expect(result.data.criteria).toMatchObject([{ barProvenance: prior }]);
  });

  it.each([
    { actorId: 'other-author', reason: 'Correct the provenance.', error: /does not match/ },
    { actorId: 'amend-author', reason: ' ', error: /requires authenticated actorId and a reason/ },
  ])('refuses an invalid correction capability: %j', ({ actorId, reason, error }) => {
    expect(() => guardAcceptanceBarTemplateDataWrite({
      slug: 'acceptance-subject-plan',
      storedTemplateData: started(),
      nextTemplateData: started({ barProvenance: { ...criterion().barProvenance, lifecycle: 'legacy-backfilled' } }),
      actorId,
      amendment: { actorId: 'amend-author', reason },
    })).toThrow(error);
  });

  it('stamps a newly added BAR at amendment time and attributes it to the authenticated amender', () => {
    const now = '2026-10-15T09:20:00.000Z';
    const stored = started();
    const added = criterion({
      key: 'r-2',
      title: 'Second outcome',
      model: 'The second outcome holds.',
      barKey: 'R-2',
      barHash: 'c'.repeat(64),
      barProvenance: {
        lifecycle: 'pre-implementation',
        declaredAt: '2030-01-01T00:00:00.000Z',
        declaredBy: 'spoofed-caller',
      },
    });
    const result = guardAcceptanceBarTemplateDataWrite({
      slug: 'acceptance-subject-plan',
      storedTemplateData: stored,
      nextTemplateData: { ...stored, criteria: [...stored.criteria, added] },
      subjectPlan: {
        status: 'active',
        revision: 8,
        adoptionEpoch: 1,
        cohort: 'legacy-backfilled',
        seededAt: contract.seededAt,
        seededBy: 'seed-author',
      },
      actorId: 'authenticated-amendment-author',
      amendment: {
        actorId: 'authenticated-amendment-author',
        reason: 'Add the newly discovered outcome.',
      },
      now,
    });

    expect(result.changes).toContainEqual({ barKey: 'R-2', kind: 'added', fields: ['bar'] });
    const newCriterion = (result.data.criteria as Array<Record<string, unknown>>)
      .find((candidate) => candidate.barKey === 'R-2');
    expect(newCriterion?.barProvenance).toEqual({
      lifecycle: 'legacy-backfilled',
      declaredAt: now,
      declaredBy: 'authenticated-amendment-author',
    });
  });

  it('accepts a meaning change only with the canonical amendment capability', () => {
    const result = guardAcceptanceBarTemplateDataWrite({
      slug: 'acceptance-subject-plan',
      storedTemplateData: started(),
      nextTemplateData: started({ model: 'An intentionally amended outcome.' }),
      actorId: 'amend-author',
      amendment: { actorId: 'amend-author', reason: 'Correct the declared contract.' },
    });
    expect(result.changed).toBe(true);
    expect(result.data.criteria).toMatchObject([{ model: 'An intentionally amended outcome.' }]);
    expect((result.data.criteria as Array<Record<string, unknown>>)[0]).toMatchObject({
      barProvenance: criterion().barProvenance,
    });
  });

  it('keeps METHOD updates readable when the subject timestamp is PostgreSQL text', () => {
    const input = {
      slug: 'acceptance-subject-plan',
      storedTemplateData: started(),
      nextTemplateData: started({ method: 'Run the new check.' }),
      subjectPlan: { seededAt: '2026-09-04 16:00:00-04' },
    };
    const result = guardAcceptanceBarTemplateDataWrite(input);
    expect(result.data.barContract).toMatchObject({ seededAt: contract.seededAt });
    expect(() => guardAcceptanceBarTemplateDataWrite({
      ...input, subjectPlan: { seededAt: 'not-a-timestamp' },
    })).toThrow();
  });

  /**
   * The WRITE half of the meaning epoch (P-003).
   *
   * The read half is pinned in acceptance-bar-contract-snapshot.test.ts, but those
   * cases INJECT `meaningRevision` into their fixtures — so they pass whether or not
   * any writer can actually produce one. Measured 2026-09-07: no writer could. This
   * guard rebuilt `barContract` from the STORED contract alone, so every epoch
   * `amendRubric` stamped was discarded on its way to the column, and the field was
   * unwritable by any path while the read tests stayed green. These cases pin the
   * writer end of the same contract so that gap cannot reopen silently.
   */
  describe('acceptance-BAR meaning epoch — the WRITE half (P-003)', () => {
    const withEpoch = (epoch: number | undefined, overrides: Record<string, unknown> = {}) => {
      const data = started(overrides) as Record<string, unknown>;
      data.barContract = epoch === undefined ? { ...contract } : { ...contract, meaningRevision: epoch };
      return data;
    };
    const epochOf = (result: { data: Record<string, unknown> }) =>
      (result.data.barContract as { meaningRevision?: number }).meaningRevision;

    it('CARRIES an incoming epoch through a method-only write (the regression)', () => {
      const result = guardAcceptanceBarTemplateDataWrite({
        slug: 'acceptance-subject-plan',
        storedTemplateData: withEpoch(undefined),
        nextTemplateData: withEpoch(7, { method: 'Run the as-built check.' }),
      });
      // Before the fix this was `undefined`: the guard rebuilt barContract from
      // `stored` and never looked at what the amender had just stamped.
      expect(epochOf(result)).toBe(7);
    });

    it('CONTROL — refuses to LOWER a recorded epoch (the dangerous direction)', () => {
      const result = guardAcceptanceBarTemplateDataWrite({
        slug: 'acceptance-subject-plan',
        storedTemplateData: withEpoch(9),
        nextTemplateData: withEpoch(4, { method: 'Run the as-built check.' }),
      });
      // Lowering would bless a card graded BEFORE a real meaning change as current —
      // exactly the failure the field exists to prevent. The stored floor stands.
      expect(epochOf(result)).toBe(9);
    });

    it('accepts a RAISED epoch (the safe direction — it only ever invalidates)', () => {
      const result = guardAcceptanceBarTemplateDataWrite({
        slug: 'acceptance-subject-plan',
        storedTemplateData: withEpoch(4),
        nextTemplateData: withEpoch(9, { model: 'An intentionally amended outcome.' }),
        actorId: 'amend-author',
        amendment: { actorId: 'amend-author', reason: 'Correct the declared contract.' },
      });
      expect(epochOf(result)).toBe(9);
    });

    it('CONTROL — absence stays ABSENT, never defaulted to 1', () => {
      const result = guardAcceptanceBarTemplateDataWrite({
        slug: 'acceptance-subject-plan',
        storedTemplateData: withEpoch(undefined),
        nextTemplateData: withEpoch(undefined, { method: 'Run the as-built check.' }),
      });
      // A fabricated epoch would bless a card from before an UNTRACKED meaning change;
      // readers must fall back to strict revision equality instead.
      expect(epochOf(result)).toBeUndefined();
    });

    it('CONTROL — a non-epoch value is REFUSED at the boundary, never written', () => {
      // A revision counter is a positive integer; the contract schema rejects
      // anything else before this guard ever sees it, and a started BAR turns that
      // parse failure into a refusal rather than a silent pass-through. Pinned here
      // because the carry-forward above is only safe while this door stays shut.
      for (const bogus of [0, -3, 2.5]) {
        expect(
          () =>
            guardAcceptanceBarTemplateDataWrite({
              slug: 'acceptance-subject-plan',
              storedTemplateData: withEpoch(5),
              nextTemplateData: withEpoch(bogus, { method: 'Run the as-built check.' }),
            }),
          `offered ${bogus}`,
        ).toThrow(/started acceptance BAR contract/);
      }
    });

    it('composes with the amender: a method-only edit holds the epoch, a meaning edit advances it', () => {
      const priorCriteria = [criterion()];
      // Method-only: meaning is unchanged, so the epoch stays put at the prior floor…
      const held = nextAcceptanceBarMeaningRevision({
        priorCriteria,
        nextCriteria: [criterion({ method: 'Run the as-built check.' })],
        priorMeaningRevision: null,
        priorRevision: 6,
        nextRevision: 7,
      });
      expect(held).toBe(6);
      // …and SURVIVES the guard, which is the half that was broken.
      expect(
        epochOf(
          guardAcceptanceBarTemplateDataWrite({
            slug: 'acceptance-subject-plan',
            storedTemplateData: withEpoch(undefined),
            nextTemplateData: withEpoch(held, { method: 'Run the as-built check.' }),
          }),
        ),
      ).toBe(6);

      // A real meaning change advances the epoch to the new revision.
      const advanced = nextAcceptanceBarMeaningRevision({
        priorCriteria,
        nextCriteria: [criterion({ model: 'An intentionally amended outcome.' })],
        priorMeaningRevision: 6,
        priorRevision: 6,
        nextRevision: 7,
      });
      expect(advanced).toBe(7);
      expect(
        epochOf(
          guardAcceptanceBarTemplateDataWrite({
            slug: 'acceptance-subject-plan',
            storedTemplateData: withEpoch(6),
            nextTemplateData: withEpoch(advanced, { model: 'An intentionally amended outcome.' }),
            actorId: 'amend-author',
            amendment: { actorId: 'amend-author', reason: 'Correct the declared contract.' },
          }),
        ),
      ).toBe(7);
    });
  });
});
