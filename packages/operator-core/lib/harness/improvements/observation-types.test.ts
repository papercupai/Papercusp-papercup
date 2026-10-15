/**
 * observation-types.test.ts — the structured-observation v2 contract
 * (rubric-driven-observations-2026-06-20 P-001 / D-002 / D-003).
 *
 * Pure unit tests: the mandatory-evidence gate + the read-side surfacing helper.
 */
import { describe, it, expect } from 'vitest';
import {
  validateObservationRatings,
  validateScorecardCompleteness,
  validateScorecardRatingValues,
  validateScorecardPoorRatingDisposition,
  canonicalScorecardRating,
  normalizeScorecardRatings,
  asStructuredObservation,
  ObservationEvidenceError,
  OBSERVATION_KINDS,
  OBSERVATION_RATING_SCALE,
  type StructuredObservation,
} from './observation-types';

describe('OBSERVATION_KINDS', () => {
  it('round-trips complete ALL probe records and refuses empty, nested or contradictory aggregates', () => {
    const probe = { kind: 'tool', tool: 'status:read', args: {}, schemaRevision: 'historical-revision', expect: { path: '$.state', op: 'eq', value: 'green' } };
    const child = { kind: 'probe', probe, verdict: 'pass', status: 'fresh', executed: true, observed: 'green', measuredAt: '2026-10-03T07:00:00Z' };
    const group = { kind: 'probe', all: [child, { ...child, verdict: 'fail', status: 'stale', observed: 'red' }], verdict: 'fail', status: 'stale', executed: true, measuredAt: child.measuredAt };
    expect(asStructuredObservation({ checkRuns: { proof: group } })?.checkRuns?.proof).toEqual(group);
    for (const bad of [
      { ...group, all: [] }, { ...group, all: [group] }, { ...group, verdict: 'pass', status: 'fresh' },
      { ...group, all: [child, { ...child, executed: false }] }, { ...group, probe },
    ]) expect(asStructuredObservation({ checkRuns: { proof: bad } })?.checkRuns).toBeUndefined();
    expect(asStructuredObservation({ checkRuns: { proof: { ...group, all: [{ ...child, observed: { private: 'payload' } }], verdict: 'pass', status: 'fresh' } } })?.checkRuns?.proof)
      .toMatchObject({ all: [expect.not.objectContaining({ observed: expect.anything() })] });
  });
  it('includes test-failure as a supported machine-readable observation kind', () => {
    expect(OBSERVATION_KINDS).toContain('test-failure');
  });
});

describe('OBSERVATION_RATING_SCALE', () => {
  it('is the reconciled 4-value scale (D-003)', () => {
    expect(OBSERVATION_RATING_SCALE).toEqual(['healthy', 'degraded', 'broken', 'unknown']);
  });
});

describe('validateObservationRatings — the D-002 mandatory-evidence gate', () => {
  it('passes a free-text observation (no ratings) — free-text stays first-class', () => {
    expect(() => validateObservationRatings({ kind: 'friction', confidence: 'high' })).not.toThrow();
    expect(() => validateObservationRatings(undefined)).not.toThrow();
    expect(() => validateObservationRatings(null)).not.toThrow();
    expect(() => validateObservationRatings({})).not.toThrow();
  });

  it('passes an empty ratings block', () => {
    expect(() => validateObservationRatings({ rubricRef: 'r', ratings: {} })).not.toThrow();
  });

  it('rejects ratings without a rubricRef (a rating must name its rubric)', () => {
    expect(() =>
      validateObservationRatings({ ratings: { 'placement-health': { rating: 'healthy', evidence: 'e' } } }),
    ).toThrow(ObservationEvidenceError);
    expect(() =>
      validateObservationRatings({ rubricRef: '   ', ratings: { k: { rating: 'healthy', evidence: 'e' } } }),
    ).toThrow(/must name the rubric/);
  });

  it('rejects a rating with missing / blank evidence (the core invariant)', () => {
    expect(() =>
      validateObservationRatings({
        rubricRef: 'r',
        ratings: { 'placement-health': { rating: 'broken', evidence: '' } },
      }),
    ).toThrow(/missing required evidence/);
    expect(() =>
      validateObservationRatings({
        rubricRef: 'r',
        ratings: { 'placement-health': { rating: 'broken', evidence: '   ' } },
      }),
    ).toThrow(ObservationEvidenceError);
  });

  it('rejects projection-truncation and recovery markers copied into rating evidence', () => {
    for (const evidence of [
      '…[TRUNCATED +290 chars — pass payloadTier:"full" for complete output]',
      'Recover the full tool result with _projection.cursor.args',
    ]) {
      expect(() =>
        validateObservationRatings({
          rubricRef: 'spec-quality',
          ratings: {
            'stable-revision-identity': { rating: 'pass', evidence },
          },
        }),
      ).toThrow(/projection.*marker|marker.*projection/i);
    }
  });

  it('rejects a blank rating value', () => {
    expect(() => validateObservationRatings({ rubricRef: 'r', ratings: { k: { rating: '', evidence: 'e' } } })).toThrow(
      /rating is required/,
    );
  });

  it('rejects an empty criterion key', () => {
    expect(() =>
      validateObservationRatings({ rubricRef: 'r', ratings: { '': { rating: 'healthy', evidence: 'e' } } }),
    ).toThrow(/empty criterion key/);
  });

  it('rejects a non-object rating entry', () => {
    expect(() =>
      // a malformed payload (e.g. from a hand-rolled writer) must not slip through.
      validateObservationRatings({
        rubricRef: 'r',
        ratings: { k: 'healthy' as unknown as { rating: string; evidence: string } },
      }),
    ).toThrow(/not a \{rating, evidence\} object/);
  });

  it('passes a fully-evidenced scorecard', () => {
    const obs: StructuredObservation = {
      scope: 'papercusp',
      rubricRef: 'pot-coordination-health',
      ratings: {
        'end-to-end-flow': { rating: 'healthy', evidence: '8 completions/hr last window (hive_throughput_ticks)' },
        'watchdog-determinism': { rating: 'degraded', evidence: 'EI-1607 throttle still live' },
        'tool-utilization': { rating: 'unknown', evidence: 'no tool-call samples this idle wake' },
      },
    };
    expect(() => validateObservationRatings(obs)).not.toThrow();
  });
});

describe('validateScorecardCompleteness — the P-014a completeness gate', () => {
  const required = ['placement', 'wake', 'federation'];

  it('passes a complete scorecard (every required criterion rated)', () => {
    expect(() =>
      validateScorecardCompleteness(
        {
          rubricRef: 'pot-coordination-health',
          ratings: {
            placement: { rating: 'healthy', evidence: 'e' },
            wake: { rating: 'healthy', evidence: 'e' },
            federation: { rating: 'degraded', evidence: 'e' },
          },
        },
        required,
      ),
    ).not.toThrow();
  });

  it('rejects a partial scorecard, naming the missing key(s) (the D-005 silent-truncation)', () => {
    let err: unknown;
    try {
      validateScorecardCompleteness(
        { rubricRef: 'pot-coordination-health', ratings: { placement: { rating: 'healthy', evidence: 'e' } } },
        required,
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ObservationEvidenceError);
    const msg = String((err as Error).message);
    expect(msg).toContain('INCOMPLETE');
    expect(msg).toContain('wake'); // both missing keys are named (fail-loud)
    expect(msg).toContain('federation');
  });

  it('passes a free-text / no-ratings observation (rubrics augment, never force)', () => {
    expect(() => validateScorecardCompleteness({ kind: 'friction' }, required)).not.toThrow();
    expect(() => validateScorecardCompleteness(undefined, required)).not.toThrow();
    expect(() => validateScorecardCompleteness({ rubricRef: 'r', ratings: {} }, required)).not.toThrow();
  });

  it('skips when requiredKeys is null/empty (unknown or criteria-less rubric — unenforceable)', () => {
    const partial: StructuredObservation = {
      rubricRef: 'r',
      ratings: { placement: { rating: 'healthy', evidence: 'e' } },
    };
    expect(() => validateScorecardCompleteness(partial, null)).not.toThrow();
    expect(() => validateScorecardCompleteness(partial, [])).not.toThrow();
  });

  it('rejects EXTRA rated keys and names them (WI-4761 trend-pollution guard)', () => {
    expect(() =>
      validateScorecardCompleteness(
        {
          rubricRef: 'pot-coordination-health',
          ratings: {
            placement: { rating: 'healthy', evidence: 'e' },
            wake: { rating: 'healthy', evidence: 'e' },
            federation: { rating: 'healthy', evidence: 'e' },
            extraKey: { rating: 'healthy', evidence: 'e' },
          },
        },
        required,
      ),
    ).toThrow(/unexpected criterion key\(s\): extraKey/);
  });

  it('reports missing and extra keys together so one retry can repair the whole scorecard', () => {
    expect(() =>
      validateScorecardCompleteness(
        {
          rubricRef: 'pot-coordination-health',
          ratings: {
            placement: { rating: 'healthy', evidence: 'e' },
            invented: { rating: 'healthy', evidence: 'e' },
          },
        },
        required,
      ),
    ).toThrow(/missing required criterion key\(s\): wake, federation; unexpected criterion key\(s\): invented/);
  });
});

describe('asStructuredObservation — read-side payload surfacing', () => {
  it('preserves an awaiting-reemit grading audit and its source-card re-emit requirement', () => {
    const gradingAudit = {
      state: 'awaiting-reemit',
      metaRubricRef: 'grading-integrity',
      stampedAt: '2026-10-02T02:30:01.384Z',
      rubricRevision: 7,
      criteriaHash: 'criteria-hash-v7',
      lastDispatchReservation: {
        key: 'grading-audit:EI-lapsed',
        reservedAt: '2026-10-02T02:30:00.000Z',
      },
      reemitRequired: {
        code: 'grading_audit_evaluator_changed',
        at: '2026-10-02T02:31:00.000Z',
        reason: 'evaluator revision changed the replayed rating',
      },
    } as const;

    const out = asStructuredObservation({
      rubricRef: 'spec-test-adequacy',
      ratings: { traceability: { rating: 'pass', evidence: 'exact replay passed' } },
      gradingAudit,
    });

    expect(out?.gradingAudit).toEqual(gradingAudit);
  });

  it('preserves a server-stamped vetting seat through the structured observation parser', () => {
    const seat = {
      succeededFrom: 'su-ended-author',
      authorSessionState: 'ended',
      basisWorkItemId: 'WI-vetting',
      basisPlanSlug: 'some-plan',
      succeededAt: '2026-09-06T04:26:17.205Z',
    };
    const out = asStructuredObservation({
      rubricRef: 'meta-acceptance-rubric',
      ratings: { quality: { rating: 'pass', evidence: 'e' } },
      vetting: { consultId: 'conv-vet', rubricRevision: 7, seat },
    });
    expect(out?.vetting).toEqual({ consultId: 'conv-vet', rubricRevision: 7, seat });
  });

  it('round-trips a full v2 observation', () => {
    const out = asStructuredObservation({
      kind: 'friction',
      scope: 'papercusp',
      confidence: 'high',
      refs: ['tool:pot:survey', 'WI-1'],
      sourceHive: 'papercusp',
      targetHive: 'shared-hive-test',
      rubricRef: 'pot-coordination-health',
      ratings: { 'end-to-end-flow': { rating: 'healthy', evidence: 'e1', suggestion: 'keep it' } },
      testedSha: 'abcdef123456',
      releaseGateBinding: {
        status: 'bound',
        reasonCode: null,
        reason: null,
        checkedAt: '2026-09-04T16:00:00.000Z',
        testedSha: 'abcdef123456',
        gateVerdict: 'green',
        gateCandidate: 'abcdef123456',
        lastGreenCommit: 'abcdef1234567890',
        stagingHead: 'abcdef1234567890',
        commitsBehindHead: 0,
        failingTests: [],
      },
      acceptance: {
        verdict: 'accept',
        reasoning: 'The independent grading meets this plan.',
        seat: {
          succeededFrom: 'su-ended-author',
          authorSessionState: 'ended',
          basisWorkItemId: 'WI-2147562',
          basisPlanSlug: 'some-plan',
          succeededAt: '2026-09-06T04:26:17.205Z',
        },
      },
      evidenceFingerprint: 'abc123',
      instrumentSnapshots: { flow: { verdict: 'pass' } },
    });
    expect(out).toBeDefined();
    expect(out?.kind).toBe('friction');
    expect(out?.sourceHive).toBe('papercusp');
    expect(out?.targetHive).toBe('shared-hive-test');
    expect(out?.rubricRef).toBe('pot-coordination-health');
    expect(out?.ratings?.['end-to-end-flow']).toEqual({ rating: 'healthy', evidence: 'e1', suggestion: 'keep it' });
    expect(out?.testedSha).toBe('abcdef123456');
    expect(out?.releaseGateBinding).toMatchObject({
      status: 'bound',
      testedSha: 'abcdef123456',
      gateVerdict: 'green',
      commitsBehindHead: 0,
    });
    expect(out?.acceptance).toEqual({
      verdict: 'accept',
      reasoning: 'The independent grading meets this plan.',
      seat: {
        succeededFrom: 'su-ended-author',
        authorSessionState: 'ended',
        basisWorkItemId: 'WI-2147562',
        basisPlanSlug: 'some-plan',
        succeededAt: '2026-09-06T04:26:17.205Z',
      },
    });
    expect(out?.evidenceFingerprint).toBe('abc123');
    expect(out?.instrumentSnapshots).toEqual({ flow: { verdict: 'pass' } });
    expect(out?.refs).toEqual(['tool:pot:survey', 'WI-1']);
  });

  it('round-trips the evaluator build stamp while preserving historical unstamped recipes', () => {
    const recipe = {
      schemaVersion: 1 as const,
      evaluator: 'plans:evaluate-spec-test-adequacy' as const,
      classRef: 'plan-class-feature-ship',
      selection: {
        planSlug: 'reconnect-plan',
        specId: 'SPEC-003-01',
        specRevision: 1,
        specFingerprint: 'sha256:spec-v1',
        evidence: [],
      },
      current: { supplied: false, fingerprints: [] },
      derivation: {
        kind: 'listSpecEvidence.currentness' as const,
        classifier: 'classifySpecEvidenceCurrentness' as const,
        unknownWhenMissing: true as const,
      },
    };
    const stamped = asStructuredObservation({
      sourceHive: 'papercusp',
      rerunRecipe: {
        ...recipe,
        evaluatorBuild: { sha: 'abc1234', version: '0.0.13' },
      },
    });
    expect(stamped?.rerunRecipe?.evaluatorBuild).toEqual({ sha: 'abc1234', version: '0.0.13' });
    expect(stamped?.rerunRecipe?.args).toMatchObject({ harness: 'papercusp' });

    const historical = asStructuredObservation({ rerunRecipe: recipe });
    expect(historical?.rerunRecipe).toBeDefined();
    expect(historical?.rerunRecipe).not.toHaveProperty('evaluatorBuild');
    expect(historical?.rerunRecipe?.args).not.toHaveProperty('harness');

    expect(
      asStructuredObservation({
        rerunRecipe: { ...recipe, evaluatorBuild: { sha: 42, version: '0.0.13' } },
      })?.rerunRecipe,
    ).toBeUndefined();
  });

  it('preserves valid rerun population selectors and rejects malformed ones instead of widening', () => {
    const recipe = {
      schemaVersion: 1 as const,
      evaluator: 'plans:evaluate-spec-test-adequacy' as const,
      classRef: 'plan-class-feature-ship',
      args: {
        harness: 'papercusp',
        workItemIds: ['WI-123'],
        evidenceRefs: ['testing:run:current#packages/operator-core/lib/reconnect.test.ts'],
        planItemIds: ['P-001'],
      },
      selection: {
        planSlug: 'reconnect-plan',
        specId: 'SPEC-003-01',
        specRevision: 1,
        specFingerprint: 'sha256:spec-v1',
        evidence: [
          {
            evidenceKind: 'test',
            evidenceRef: 'testing:run:current#packages/operator-core/lib/reconnect.test.ts',
          },
        ],
      },
      current: { supplied: false, fingerprints: [] },
      derivation: {
        kind: 'listSpecEvidence.currentness' as const,
        classifier: 'classifySpecEvidenceCurrentness' as const,
        unknownWhenMissing: true as const,
      },
    };

    expect(asStructuredObservation({ rerunRecipe: recipe })?.rerunRecipe?.args).toMatchObject({
      workItemIds: ['WI-123'],
      evidenceRefs: ['testing:run:current#packages/operator-core/lib/reconnect.test.ts'],
      planItemIds: ['P-001'],
    });

    for (const malformedArgs of [
      { ...recipe.args, workItemIds: [] },
      { ...recipe.args, evidenceRefs: [''] },
      { ...recipe.args, planItemIds: ['P-1'] },
    ]) {
      expect(
        asStructuredObservation({ rerunRecipe: { ...recipe, args: malformedArgs } })?.rerunRecipe,
      ).toBeUndefined();
    }
  });

  it('preserves immutable clause pins and replay mode in adequacy rerun recipes', () => {
    const fingerprints = [
      {
        planSlug: 'reconnect-plan',
        specId: 'SPEC-003-01',
        specRevision: 2,
        specFingerprint: 'sha256:spec-v2',
        evidenceKind: 'test',
        evidenceRef: 'test/reconnect.test.ts#terminal-close',
        sourceFingerprint: 'git:spec-v2',
        testFingerprint: 'sha256:test-v2',
        fixtureFingerprint: null,
        rubricFingerprint: null,
        environmentFingerprint: null,
      },
    ];
    const recipe = {
      schemaVersion: 1 as const,
      evaluator: 'plans:evaluate-spec-test-adequacy' as const,
      classRef: 'plan-class-feature-ship',
      args: {
        harness: 'papercusp',
        slug: 'reconnect-plan',
        classRef: 'plan-class-feature-ship',
        specIds: ['SPEC-003-01'],
        specRevision: 2,
        specFingerprint: 'sha256:spec-v2',
        replaySnapshot: true as const,
        includeDraft: true,
        current: fingerprints,
      },
      selection: {
        planSlug: 'reconnect-plan',
        specId: 'SPEC-003-01',
        specRevision: 2,
        specFingerprint: 'sha256:spec-v2',
        evidence: [
          { evidenceKind: 'test', evidenceRef: 'test/reconnect.test.ts#terminal-close' },
        ],
      },
      current: { supplied: true, fingerprints },
      derivation: {
        kind: 'listSpecEvidence.currentness' as const,
        classifier: 'classifySpecEvidenceCurrentness' as const,
        unknownWhenMissing: true as const,
      },
    };

    expect(asStructuredObservation({ rerunRecipe: recipe })?.rerunRecipe?.args).toMatchObject({
      specRevision: 2,
      specFingerprint: 'sha256:spec-v2',
      replaySnapshot: true,
      current: fingerprints,
    });
  });

  it('rejects a partially scoped currentness fingerprint instead of silently falling back to legacy identity', () => {
    const recipe = {
      schemaVersion: 1 as const,
      evaluator: 'plans:evaluate-spec-test-adequacy' as const,
      classRef: 'plan-class-feature-ship',
      args: {
        slug: 'reconnect-plan',
        classRef: 'plan-class-feature-ship',
        specIds: ['SPEC-003-01'],
        includeDraft: true as const,
      },
      selection: {
        planSlug: 'reconnect-plan',
        specId: 'SPEC-003-01',
        specRevision: 2,
        specFingerprint: 'sha256:spec-v2',
        evidence: [{ evidenceKind: 'test', evidenceRef: 'artifact:shared-index' }],
      },
      current: {
        supplied: true,
        fingerprints: [
          {
            planSlug: 'reconnect-plan',
            specId: 'SPEC-003-01',
            specRevision: 2,
            specFingerprint: 'sha256:spec-v2',
            evidenceKind: 'test',
            evidenceRef: 'artifact:shared-index',
            sourceFingerprint: 'git:spec-v2',
          },
        ],
      },
      derivation: {
        kind: 'listSpecEvidence.currentness' as const,
        classifier: 'classifySpecEvidenceCurrentness' as const,
        unknownWhenMissing: true as const,
      },
    };

    expect(asStructuredObservation({ rerunRecipe: recipe })?.rerunRecipe).toBeDefined();
    const { specId: _specId, ...partialIdentity } = recipe.current.fingerprints[0];
    expect(
      asStructuredObservation({
        rerunRecipe: {
          ...recipe,
          current: { supplied: true, fingerprints: [partialIdentity] },
        },
      })?.rerunRecipe,
    ).toBeUndefined();
  });

  it('round-trips native Cargo check runs and drops malformed native records', () => {
    const out = asStructuredObservation({
      rubricRef: 'pui-tui-remediation-and-consolidation-2026-08-27-acceptance',
      checkRuns: {
        native: {
          kind: 'cargo',
          manifestPath: 'apps/tui/Cargo.toml',
          sourceFiles: ['apps/tui/src/app.rs', 'apps/tui/src/ui.rs'],
          test: 'app::tests',
          verdict: 'pass',
          passed: 12,
          failed: 0,
          ignored: 1,
          runId: 'cargo-run-1',
          measuredAt: '2026-08-30T07:30:00.000Z',
        },
      },
    });
    expect(out?.checkRuns?.native).toEqual({
      kind: 'cargo',
      manifestPath: 'apps/tui/Cargo.toml',
      sourceFiles: ['apps/tui/src/app.rs', 'apps/tui/src/ui.rs'],
      test: 'app::tests',
      verdict: 'pass',
      passed: 12,
      failed: 0,
      ignored: 1,
      runId: 'cargo-run-1',
      measuredAt: '2026-08-30T07:30:00.000Z',
    });

    const malformed = asStructuredObservation({
      rubricRef: 'r',
      checkRuns: {
        native: {
          kind: 'cargo',
          manifestPath: 'apps/tui/Cargo.toml',
          sourceFiles: [],
          verdict: 'pass',
          passed: 1,
          failed: 0,
          ignored: 0,
          measuredAt: '2026-08-30T07:30:00.000Z',
        },
      },
    });
    expect(malformed?.checkRuns).toBeUndefined();
  });

  it('round-trips scoped test-run ids on tests check runs while keeping the field optional', () => {
    const out = asStructuredObservation({
      rubricRef: 'checked-rubric',
      checkRuns: {
        tests: {
          kind: 'tests',
          files: ['packages/example.test.ts'],
          verdict: 'pass',
          passed: 4,
          failed: 0,
          runId: 'run-group-1',
          testRunIds: [77, 78, 0, 'bad'],
          measuredAt: '2026-09-13T22:00:00.000Z',
        },
        legacy: {
          kind: 'tests',
          files: ['packages/legacy.test.ts'],
          verdict: 'pass',
          passed: 1,
          failed: 0,
          runId: 'legacy-run',
          measuredAt: '2026-09-13T22:00:00.000Z',
        },
      },
    });
    expect(out?.checkRuns?.tests).toMatchObject({ testRunIds: [77, 78] });
    expect(out?.checkRuns?.legacy).not.toHaveProperty('testRunIds');
  });

  it('preserves an explicit empty ratings object for a zero-criterion rubric', () => {
    const out = asStructuredObservation({
      rubricRef: 'zero-criterion-investigation',
      subject: { kind: 'plan', ref: 'plan-with-no-criteria' },
      ratings: {},
    });

    expect(out?.rubricRef).toBe('zero-criterion-investigation');
    expect(out?.ratings).toEqual({});
  });

  it('does not turn a non-empty malformed ratings object into a valid empty card', () => {
    const out = asStructuredObservation({
      rubricRef: 'malformed-rubric',
      ratings: { criterion: { rating: 'healthy' } },
    });

    expect(out?.ratings).toBeUndefined();
  });

  it('ignores unknown keys so B10 learnings/observationKind can ride alongside', () => {
    const out = asStructuredObservation({ rubricRef: 'r', learnings: ['x'], observationKind: 'deprecation' });
    expect(out?.rubricRef).toBe('r');
    expect((out as Record<string, unknown>).learnings).toBeUndefined();
  });

  // goal-mode-rubric-v2-2026-08-10 P-009. These guard a SILENT failure mode, not a
  // loud one: this parse is an allowlist, so a field added to the zod schema + the
  // interface but NOT taught here persists to payload.observation and then reads
  // back undefined forever. Nothing throws; the data is simply invisible, which is
  // exactly how the five v1 goal-mode-e2e scorecards ended up unattributable.
  it('round-trips graded rubric and BAR meaning revisions separately from vetting revision', () => {
    const out = asStructuredObservation({
      rubricRef: 'goal-mode-e2e',
      rubricRevision: 7,
      rubricMeaningRevision: 5,
      vetting: { consultId: 'conv-1', rubricRevision: 3, rubricMeaningRevision: 2 },
    });
    expect(out?.rubricRevision).toBe(7);
    expect(out?.rubricMeaningRevision).toBe(5);
    expect(out?.vetting?.rubricRevision).toBe(3);
    expect(out?.vetting?.rubricMeaningRevision).toBe(2);
    expect(
      asStructuredObservation({ rubricRef: 'goal-mode-e2e', rubricRevision: '7' })?.rubricRevision,
    ).toBeUndefined();
    expect(
      asStructuredObservation({ rubricRef: 'goal-mode-e2e', rubricMeaningRevision: '5' })?.rubricMeaningRevision,
    ).toBeUndefined();
  });

  it('round-trips the graded subject (the drill parameter binding)', () => {
    const out = asStructuredObservation({
      rubricRef: 'goal-mode-e2e',
      subject: {
        kind: 'agent-run',
        ref: 'su-12b70e95-84ce-4ea0-b546-8a692cdc949c',
        windowStart: '2026-08-10T00:00:00.000Z',
        windowEnd: '2026-08-10T23:59:59.000Z',
      },
    });
    expect(out?.subject).toEqual({
      kind: 'agent-run',
      ref: 'su-12b70e95-84ce-4ea0-b546-8a692cdc949c',
      windowStart: '2026-08-10T00:00:00.000Z',
      windowEnd: '2026-08-10T23:59:59.000Z',
    });
  });

  it('keeps a subject that carries only ref (window + kind are optional)', () => {
    const out = asStructuredObservation({ subject: { ref: 'WI-37831' } });
    expect(out?.subject).toEqual({ ref: 'WI-37831' });
  });

  it('DROPS a subject with no usable ref rather than half-keeping it', () => {
    // A subject block that cannot say WHAT it graded is worse than none: it reads
    // as "identity recorded" to every consumer while answering nothing.
    for (const bad of [{ kind: 'agent-run' }, { ref: '' }, { ref: '   ' }, { ref: 42 }]) {
      expect(asStructuredObservation({ rubricRef: 'r', subject: bad })?.subject).toBeUndefined();
    }
    expect(asStructuredObservation({ rubricRef: 'r', subject: 'su-123' })?.subject).toBeUndefined();
    expect(asStructuredObservation({ rubricRef: 'r', subject: ['su-123'] })?.subject).toBeUndefined();
  });

  it('drops unknown keys INSIDE subject (the allowlist holds one level down too)', () => {
    const out = asStructuredObservation({
      subject: { ref: 'su-1', runId: 'nope', notes: 'also nope' },
    });
    expect(out?.subject).toEqual({ ref: 'su-1' });
  });

  it('drops malformed ratings entries but keeps the valid ones', () => {
    const out = asStructuredObservation({
      ratings: { good: { rating: 'healthy', evidence: 'e' }, missingEvidence: { rating: 'healthy' }, junk: 5 },
    });
    expect(out?.ratings?.good).toEqual({ rating: 'healthy', evidence: 'e' });
    expect(out?.ratings?.missingEvidence).toBeUndefined();
    expect(out?.ratings?.junk).toBeUndefined();
  });

  it('drops malformed acceptance blocks rather than projecting a partial verdict', () => {
    expect(
      asStructuredObservation({ rubricRef: 'r', acceptance: { verdict: 'maybe', reasoning: 'x' } })?.acceptance,
    ).toBeUndefined();
    expect(
      asStructuredObservation({ rubricRef: 'r', acceptance: { verdict: 'accept', reasoning: '   ' } })?.acceptance,
    ).toBeUndefined();
    expect(asStructuredObservation({ rubricRef: 'r', acceptance: 'accept' })?.acceptance).toBeUndefined();
  });

  it('drops a partial succession seat while retaining the otherwise valid verdict', () => {
    expect(
      asStructuredObservation({
        rubricRef: 'r',
        acceptance: {
          verdict: 'accept',
          reasoning: 'The independent grading meets this plan.',
          seat: { succeededFrom: 'su-ended-author' },
        },
      })?.acceptance,
    ).toEqual({ verdict: 'accept', reasoning: 'The independent grading meets this plan.' });
  });

  it('returns undefined for non-object / empty / unknown-only input', () => {
    expect(asStructuredObservation(null)).toBeUndefined();
    expect(asStructuredObservation(5)).toBeUndefined();
    expect(asStructuredObservation('x')).toBeUndefined();
    expect(asStructuredObservation({})).toBeUndefined();
    expect(asStructuredObservation({ unknownOnly: 1 })).toBeUndefined();
  });

  // ── the vetting stamp (consult-min-max-and-rubric-vetting-2026-08-17 P-004) ──

  it('surfaces a well-formed consult vetting stamp, including critique metadata', () => {
    const out = asStructuredObservation({
      rubricRef: 'meta-acceptance-rubric',
      subject: { kind: 'rubric', ref: 'ar-some-plan' },
      vetting: {
        consultId: 'conv-1',
        rubricRevision: 7,
        critiquePosts: 2,
        critics: ['su-reviewer'],
        unanswered: true,
        unansweredReason: 'No reviewer answered before the bounded deadline.',
        junk: 'nope',
      },
    });
    expect(out?.vetting).toEqual({
      consultId: 'conv-1',
      rubricRevision: 7,
      critiquePosts: 2,
      critics: ['su-reviewer'],
      unanswered: true,
      unansweredReason: 'No reviewer answered before the bounded deadline.',
    });
    expect(out?.subject).toEqual({ kind: 'rubric', ref: 'ar-some-plan' });
  });

  it('surfaces the work-item critique channel used by launched independent reviewers', () => {
    const out = asStructuredObservation({
      rubricRef: 'meta-acceptance-rubric',
      vetting: {
        workItemId: 'WI-42379',
        rubricRevision: 8,
        critiquePosts: 1,
        critics: ['su-critic', 42, ''],
        unanswered: true,
        unansweredReason: 'not valid on this channel',
      },
    });
    expect(out?.vetting).toEqual({
      workItemId: 'WI-42379',
      rubricRevision: 8,
      critiquePosts: 1,
      critics: ['su-critic'],
    });
  });

  it('discards a vetting block without exactly one critique-channel link', () => {
    expect(asStructuredObservation({ rubricRef: 'r', vetting: { rubricRevision: 7 } })?.vetting).toBeUndefined();
    expect(asStructuredObservation({ rubricRef: 'r', vetting: { consultId: '  ' } })?.vetting).toBeUndefined();
    expect(
      asStructuredObservation({
        rubricRef: 'r',
        vetting: { consultId: 'conv-1', workItemId: 'WI-1', rubricRevision: 7 },
      })?.vetting,
    ).toBeUndefined();
    expect(asStructuredObservation({ rubricRef: 'r', vetting: 'conv-1' })?.vetting).toBeUndefined();
    expect(asStructuredObservation({ rubricRef: 'r', vetting: ['conv-1'] })?.vetting).toBeUndefined();
  });

  it('drops a non-numeric rubricRevision but keeps the consult linkage', () => {
    const out = asStructuredObservation({ rubricRef: 'r', vetting: { consultId: 'conv-1', rubricRevision: '7' } });
    expect(out?.vetting).toEqual({ consultId: 'conv-1' });
  });
});

describe('canonical scorecard ratings (EI-12458)', () => {
  const rubric = {
    ratingScale: ['PASS', 'AT-RISK', 'FAIL', 'UNKNOWN'],
    criteria: [{ key: 'a' }, { key: 'b', ratingScale: ['healthy', 'degraded', 'broken', 'unknown'] }],
  };

  it('resolves case-insensitively to the exact rubric spelling', () => {
    expect(canonicalScorecardRating('pass', rubric.ratingScale)).toBe('PASS');
    expect(canonicalScorecardRating(' At-Risk ', rubric.ratingScale)).toBe('AT-RISK');
    expect(canonicalScorecardRating('unknown', ['PASS', 'FAIL'])).toBe('unknown');
  });

  it('resolves an unambiguous short label before an em dash or colon', () => {
    const detailedScale = [
      'pass — debug reachable at root and per-triple',
      'partial: some checks pass',
      'fail — checks fail',
    ];
    expect(canonicalScorecardRating(' PASS ', detailedScale)).toBe(detailedScale[0]);
    expect(canonicalScorecardRating('partial', detailedScale)).toBe(detailedScale[1]);
  });

  it('leaves an ambiguous short label unchanged so validation can reject it', () => {
    const ambiguousScale = ['pass — root checks pass', 'pass: per-triple checks pass', 'fail — checks fail'];
    expect(canonicalScorecardRating('pass', ambiguousScale)).toBe('pass');
  });

  it('normalizes every entry without losing evidence or suggestions', () => {
    expect(
      normalizeScorecardRatings(
        {
          a: { rating: 'pass', evidence: 'metric=1', suggestion: 'retain' },
          b: { rating: 'HEALTHY', evidence: 'metric=2' },
        },
        rubric,
      ),
    ).toEqual({
      a: { rating: 'PASS', evidence: 'metric=1', suggestion: 'retain' },
      b: { rating: 'healthy', evidence: 'metric=2' },
    });
  });

  it('uses criterion scales before the rubric default when canonicalizing short labels', () => {
    const detailedRubric = {
      ratingScale: ['pass — default rubric pass', 'fail — default rubric fail'],
      criteria: [
        { key: 'defaulted' },
        { key: 'overridden', ratingScale: ['pass: criterion pass', 'fail: criterion fail'] },
      ],
    };
    expect(
      normalizeScorecardRatings(
        {
          defaulted: { rating: 'pass', evidence: 'default' },
          overridden: { rating: 'pass', evidence: 'override' },
        },
        detailedRubric,
      ),
    ).toEqual({
      defaulted: { rating: 'pass — default rubric pass', evidence: 'default' },
      overridden: { rating: 'pass: criterion pass', evidence: 'override' },
    });
  });
});

describe('validateScorecardRatingValues — the P-002 rating-VALUE gate (rubric-system-improvements-2026-07-12)', () => {
  const rubric = {
    ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
    criteria: [
      { key: 'placement' },
      { key: 'wake', ratingScale: ['exemplary', 'pass', 'partial', 'fail', 'severe', 'unknown'] },
    ],
  };
  const sc = (ratings: Record<string, { rating: string; evidence: string }>): StructuredObservation => ({
    rubricRef: 'r',
    ratings,
  });

  it('passes on-scale ratings (rubric default + per-criterion override, case-insensitive)', () => {
    expect(() =>
      validateScorecardRatingValues(
        sc({
          placement: { rating: 'Healthy', evidence: 'e' },
          wake: { rating: 'exemplary', evidence: 'e' },
        }),
        rubric,
      ),
    ).not.toThrow();
  });

  it('rejects an off-scale rating, naming the key, the value, and the allowed values (the silent-exclusion class of the missing-pass-vocabulary bug)', () => {
    let err: unknown;
    try {
      validateScorecardRatingValues(sc({ placement: { rating: 'pas', evidence: 'e' } }), rubric);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ObservationEvidenceError);
    const msg = String((err as Error).message);
    expect(msg).toContain("'placement'");
    expect(msg).toContain("'pas'");
    expect(msg).toContain('healthy | degraded | broken | unknown');
  });

  it('a per-criterion scale override governs that criterion (rubric default does not leak in)', () => {
    // 'healthy' is on the RUBRIC scale but not on wake's override.
    expect(() => validateScorecardRatingValues(sc({ wake: { rating: 'healthy', evidence: 'e' } }), rubric)).toThrow(
      ObservationEvidenceError,
    );
  });

  it("'unknown' is always accepted, even off a scale that omits it", () => {
    const noUnknown = { ratingScale: ['healthy', 'degraded'], criteria: [{ key: 'c' }] };
    expect(() =>
      validateScorecardRatingValues(sc({ c: { rating: 'unknown', evidence: 'e' } }), noUnknown),
    ).not.toThrow();
  });

  it('skips when the rubric is null/unloaded or scale-less (unenforceable, like completeness)', () => {
    expect(() => validateScorecardRatingValues(sc({ c: { rating: 'whatever', evidence: 'e' } }), null)).not.toThrow();
    expect(() =>
      validateScorecardRatingValues(sc({ c: { rating: 'whatever', evidence: 'e' } }), { criteria: [{ key: 'c' }] }),
    ).not.toThrow();
  });

  it('passes free-text / no-ratings observations unconditionally', () => {
    expect(() => validateScorecardRatingValues({ kind: 'friction' }, rubric)).not.toThrow();
    expect(() => validateScorecardRatingValues(undefined, rubric)).not.toThrow();
  });
});

describe('validateScorecardPoorRatingDisposition (scorecard-poor-rating-disposition, owner-directed 2026-08-31)', () => {
  const standard = { kind: 'standard' };
  const obs = (ratings: Record<string, unknown>): StructuredObservation =>
    ({ rubricRef: 'r', ratings }) as StructuredObservation;

  it('rejects a fail rating with neither remediation nor disregard', () => {
    expect(() =>
      validateScorecardPoorRatingDisposition(obs({ a: { rating: 'fail', evidence: 'e' } }), standard),
    ).toThrow(/NO disposition/);
  });

  it.each(['fail', 'severe', 'broken', 'degraded', 'partial', 'FAIL', ' Partial '])(
    'treats %s as a poor rating that needs a disposition',
    (rating) => {
      expect(() =>
        validateScorecardPoorRatingDisposition(obs({ a: { rating, evidence: 'e' } }), standard),
      ).toThrow(ObservationEvidenceError);
    },
  );

  it('accepts a poor rating routed to a work-item ref, bare or inside a note', () => {
    expect(() =>
      validateScorecardPoorRatingDisposition(
        obs({
          a: { rating: 'fail', evidence: 'e', remediation: 'WI-1234' },
          b: { rating: 'partial', evidence: 'e', remediation: 'tracked as EI-21830980285885156 (watchdog class)' },
          c: { rating: 'degraded', evidence: 'e', remediation: 'F-77 — follow-up feature' },
        }),
        standard,
      ),
    ).not.toThrow();
  });

  it('rejects a remediation that names no WI-/EI-/F- work-item', () => {
    expect(() =>
      validateScorecardPoorRatingDisposition(
        obs({ a: { rating: 'fail', evidence: 'e', remediation: 'we will fix this later' } }),
        standard,
      ),
    ).toThrow(/names no work-item/);
  });

  it('accepts an explicit reasoned disregard and rejects a thin one', () => {
    expect(() =>
      validateScorecardPoorRatingDisposition(
        obs({
          a: {
            rating: 'degraded',
            evidence: 'e',
            disregard: 'known cold-start artifact; accepted until the Q4 window matures',
          },
        }),
        standard,
      ),
    ).not.toThrow();
    expect(() =>
      validateScorecardPoorRatingDisposition(
        obs({ a: { rating: 'degraded', evidence: 'e', disregard: 'n/a' } }),
        standard,
      ),
    ).toThrow(/too thin/);
  });

  it('needs nothing on pass/healthy/exemplary/unknown ratings', () => {
    expect(() =>
      validateScorecardPoorRatingDisposition(
        obs({
          a: { rating: 'pass', evidence: 'e' },
          b: { rating: 'healthy', evidence: 'e' },
          c: { rating: 'exemplary', evidence: 'e' },
          d: { rating: 'unknown', evidence: 'idle: no signal this wake' },
        }),
        standard,
      ),
    ).not.toThrow();
  });

  it('skips acceptance-kind rubrics and unknown rubrics — their flows own disposition', () => {
    const failNoDisposition = obs({ a: { rating: 'fail', evidence: 'e' } });
    expect(() => validateScorecardPoorRatingDisposition(failNoDisposition, { kind: 'acceptance' })).not.toThrow();
    expect(() => validateScorecardPoorRatingDisposition(failNoDisposition, null)).not.toThrow();
  });

  it('skips grading-integrity audit cards — a failing audit settles the subject, which IS the disposition', () => {
    expect(() =>
      validateScorecardPoorRatingDisposition(
        { rubricRef: 'grading-integrity', ratings: { a: { rating: 'fail', evidence: 'e' } } } as StructuredObservation,
        standard,
      ),
    ).not.toThrow();
  });

  it('treats a kind-less rubric as standard (the default kind) and enforces', () => {
    expect(() =>
      validateScorecardPoorRatingDisposition(obs({ a: { rating: 'fail', evidence: 'e' } }), {}),
    ).toThrow(ObservationEvidenceError);
  });

  it('passes free-text / no-ratings observations unconditionally', () => {
    expect(() =>
      validateScorecardPoorRatingDisposition({ kind: 'friction' } as StructuredObservation, standard),
    ).not.toThrow();
    expect(() => validateScorecardPoorRatingDisposition(undefined, standard)).not.toThrow();
    expect(() => validateScorecardPoorRatingDisposition(null, standard)).not.toThrow();
  });

  it('carries remediation/disregard through the read-side narrowing (asStructuredObservation)', () => {
    const narrowed = asStructuredObservation({
      rubricRef: 'r',
      ratings: {
        a: { rating: 'fail', evidence: 'e', remediation: 'WI-9', disregard: '' },
        b: { rating: 'partial', evidence: 'e', disregard: 'accepted: bounded historical artifact' },
      },
    });
    expect(narrowed?.ratings?.a).toEqual({ rating: 'fail', evidence: 'e', remediation: 'WI-9' });
    expect(narrowed?.ratings?.b).toEqual({
      rating: 'partial',
      evidence: 'e',
      disregard: 'accepted: bounded historical artifact',
    });
  });

  // design-to-code-coverage-seam P-026. This parse is an explicit ALLOWLIST, so a new
  // check kind that is not added here PERSISTS fine and is silently dropped on READ —
  // a data loss with no error anywhere. These cases exist because that failure is
  // invisible to the writing side's own tests.
  describe("kind:'requirements' check runs survive the read-side narrowing", () => {
    it('round-trips a complete requirements run', () => {
      const out = asStructuredObservation({
        rubricRef: 'r',
        checkRuns: {
          realized: {
            kind: 'requirements',
            verdict: 'fail',
            mappingsJudged: 9,
            checkedTargets: 14,
            unrealized: 2,
            unrealizedEntries: 3,
            exemptMappings: 1,
            droppedTargets: 4,
            droppedTargetsVouchedByStaleAudit: 2,
            unrealizedRequirements: ['requirement M-003', 42, 'requirement M-007'],
            measuredAt: '2026-09-03T00:00:00.000Z',
          },
        },
      });
      expect(out?.checkRuns?.realized).toEqual({
        kind: 'requirements',
        verdict: 'fail',
        mappingsJudged: 9,
        checkedTargets: 14,
        unrealized: 2,
        unrealizedEntries: 3,
        exemptMappings: 1,
        droppedTargets: 4,
        droppedTargetsVouchedByStaleAudit: 2,
        // The non-string entry is filtered, not preserved and not fatal.
        unrealizedRequirements: ['requirement M-003', 'requirement M-007'],
        measuredAt: '2026-09-03T00:00:00.000Z',
      });
    });

    it('keeps the verdict when the reported-population fields are absent, defaulting them to 0', () => {
      // A card written before those fields existed still carries a real judgement;
      // discarding it to gain a field nobody wrote would lose more than it protects.
      const out = asStructuredObservation({
        rubricRef: 'r',
        checkRuns: {
          realized: {
            kind: 'requirements',
            verdict: 'pass',
            mappingsJudged: 3,
            checkedTargets: 3,
            unrealized: 0,
            measuredAt: '2026-09-03T00:00:00.000Z',
          },
        },
      });
      expect(out?.checkRuns?.realized).toMatchObject({
        verdict: 'pass',
        exemptMappings: 0,
        droppedTargets: 0,
        droppedTargetsVouchedByStaleAudit: 0,
        // Falls back to `unrealized`, which is exact for single-target mappings and
        // can never overstate the entry count.
        unrealizedEntries: 0,
      });
    });

    it('DISCARDS a run that cannot say how it came out', () => {
      const out = asStructuredObservation({
        rubricRef: 'r',
        checkRuns: {
          realized: {
            kind: 'requirements',
            verdict: 'inconclusive',
            mappingsJudged: 3,
            checkedTargets: 3,
            unrealized: 0,
            measuredAt: '2026-09-03T00:00:00.000Z',
          },
        },
      });
      expect(out?.checkRuns).toBeUndefined();
    });
  });
});
