import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getBuildInfo } from '../../build-info';
import type { SpecClauseRevision } from './spec-clauses-store';
import type { SpecEvidenceForAdequacy } from './spec-test-adequacy';
import {
  ADEQUACY_CRITERIA,
  EPHEMERAL_EVIDENCE_ROOTS,
  SPEC_TEST_ADEQUACY_EVALUATOR_REVISION,
  activeSpecEvidence,
  classifySpecEvidenceLineage,
  crossGenerationAuditProbeArgs,
  evaluateSpecTestAdequacy,
  evaluateSpecEvidenceMatrix,
  isAcceptedMutationTarget,
  resolveFixtureAbsenceVerifications,
  latestLogicalEvidence,
  mutationMeasuredFailedCase,
  requiredProofFloor,
  supersedeEligibilityGaps,
} from './spec-test-adequacy';
import { isNonCodeWorkItemKind } from '../../plan-verification-profile';
import { argsSchema as evaluatorArgsSchema } from './evaluate-spec-test-adequacy';
import getSpecEvidenceTool from './get-spec-evidence';
import { scorecardEmitArgs } from '../scorecards/emit';
import { classifySpecEvidenceCurrentness, type EvidenceCurrentInput } from './spec-evidence-store';
import { asStructuredObservation } from '../../harness/improvements/observation-types';
import { resolveLocalRubric } from '../../cupboard/rubric-store';

const DEFAULT_MUTATION_TEST_CASE = 'the mutation is detected';

describe('shared adequacy-card binding evidence', () => {
  it('stores four detailed bindings once while preserving criterion verdicts and references', () => {
    const markers = Array.from({ length: 4 }, (_, index) => `shared-proof-${index}-${'x'.repeat(500)}`);
    const rows = markers.map((marker, index) => {
      const row = evidence({ id: 101 + index, evidenceRef: `surface:binding-${index}` });
      row.fingerprints.fixtureFingerprint = marker;
      return row;
    });
    const result = evaluateSpecTestAdequacy({ clause: clause(), evidence: rows, classRef: 'plan-class-feature-ship' });
    const cardText = [result.scorecardDraft.body, ...Object.values(result.scorecardDraft.ratings).map(rating => rating.evidence)].join('\n');
    for (const marker of markers) {
      expect(cardText.split(marker)).toHaveLength(2);
      for (const [criterion, rating] of Object.entries(result.scorecardDraft.ratings)) {
        if (criterion === 'traceability' && result.scorecardDraft.body.includes('resolves in the traceability')) continue;
        expect(rating.evidence).not.toContain(marker);
      }
    }
    for (const criterion of ADEQUACY_CRITERIA) {
      expect(result.scorecardDraft.ratings[criterion].rating).toBe(result.ratings[criterion].rating);
      expect(result.scorecardDraft.ratings[criterion].suggestion).toBe(result.ratings[criterion].suggestion);
    }
    const detailed = Object.values(result.ratings).map((rating) => rating.evidence).join('\n');
    const references = Object.values(result.scorecardDraft.ratings).map((rating) => rating.evidence).join('\n');
    expect(references).toContain('binding=B1');
    expect(references.length).toBeLessThan(detailed.length / 2);
    expect(result.scorecardDraft.rerunRecipe.args.bindingIds).toEqual([101, 102, 103, 104]);
  });

  it('stores shared replay instructions once and keeps a criterion-specific replay result pointer', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence()],
      classRef: 'plan-class-feature-ship',
    });
    const card = result.scorecardDraft;
    const allEvidence = Object.values(card.ratings).map((rating) => rating.evidence).join('\n');

    expect(card.body.match(/Replay instructions: execute the card-level rerunRecipe/g)).toHaveLength(1);
    expect(card.body).toContain('It is not a historical as-of replay; grading-integrity audits reconstruct this card');
    expect(allEvidence).not.toContain('This replay remeasures currentness at replay time');
    for (const criterion of ADEQUACY_CRITERIA) {
      expect(card.ratings[criterion].evidence).toContain(
        `Replay result: rows[0].ratings[${JSON.stringify(criterion)}] via rerunRecipe.`,
      );
    }
  });

  it.each([true, false])('makes every criterion evidence probe executable with exact selectors (binding ids: %s)', (withIds) => {
    const rows = [evidence({ ...(withIds ? { id: 41001 } : {}) })];
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: rows,
      harness: 'papercusp',
      classRef: 'plan-class-feature-ship',
    });

    for (const criterion of ADEQUACY_CRITERIA) {
      const text = result.scorecardDraft.ratings[criterion].evidence;
      const match = text.match(/Evidence probe: plans:get-spec-evidence (\{[^\n]*\})\. Inspect evidence\[\]/);
      expect(match, criterion).not.toBeNull();
      const args = getSpecEvidenceTool.args.parse(JSON.parse(match![1]!));
      expect(args).toMatchObject({
        harness: 'papercusp',
        slug: 'reconnect-plan',
        specIds: ['SPEC-003-01'],
        detail: 'full',
      });
      if (withIds) {
        expect(args.bindingIds).toEqual([41001]);
        expect(args.includeRetracted).toBe(true);
      } else {
        expect(args.evidenceRefs).toEqual(['surface:reconnect']);
        expect(args).not.toHaveProperty('bindingIds');
      }
      expect(text).toContain('specRevision=1');
      expect(text).toContain('specFingerprint="sha256:spec-v1"');
      expect(text).toContain('bounded.truncatedByLimit=false');
      expect(text).toContain(`rows[0].ratings[${JSON.stringify(criterion)}]`);
    }
  });

  it.each([false, true])('pins the full disclosed-gap census independently of selected proofs (historical disclosure: %s)', (disclosed) => {
    const selected = [evidence({ id: 41001, evidenceRef: 'surface:first' }), evidence({ id: 41002, evidenceRef: 'surface:second' })];
    const historical = evidence({ id: 41003, evidenceRef: 'surface:other' });
    if (disclosed) {
      historical.details.adequacy = { ...(historical.details.adequacy as Record<string, unknown>), disclosedGap: ['The failure path is not covered.'] };
    }
    const replacement = evidence({ id: 41004, evidenceRef: historical.evidenceRef });
    const population = [...selected, historical, replacement];
    const result = evaluateSpecTestAdequacy({
      clause: clause(), evidence: selected, disclosedGapEvidence: population,
      harness: 'papercusp', classRef: 'plan-class-feature-ship',
    });
    const probe = (criterion: 'disclosed-gap' | 'traceability') => {
      const text = result.scorecardDraft.ratings[criterion].evidence;
      const match = text.match(/Evidence probe: plans:get-spec-evidence (\{[^\n]*\})\. Inspect evidence\[\]/);
      expect(match).not.toBeNull();
      return getSpecEvidenceTool.args.parse(JSON.parse(match![1]!));
    };
    const gapProbe = probe('disclosed-gap');
    expect(gapProbe.bindingIds).toEqual([41001, 41002, 41003, 41004]);
    expect(gapProbe.includeRetracted).toBe(true);
    expect(probe('traceability').bindingIds).toEqual([41001, 41002]);
    expect(result.scorecardDraft.rerunRecipe.args.bindingIds).toEqual([41001, 41002]);
    const fetched = population.filter(row => gapProbe.bindingIds!.includes(row.id!));
    expect(activeSpecEvidence(fetched).map(row => row.id)).toEqual([41001, 41002, 41004]);
    const rendered = result.scorecardDraft.ratings['disclosed-gap'].evidence;
    expect(rendered).toContain('Apply activeSpecEvidence to these clause rows: 4 raw binding(s), 3 active logical binding(s); active bindingIds=[41001,41002,41004].');
    if (disclosed) {
      expect(result.ratings['disclosed-gap'].rating).toBe('fail');
      expect(result.wouldBlock).toContain('disclosed-gap');
      expect(rendered).toContain('The failure path is not covered.');
    } else {
      expect(rendered).toContain('Checked 3 active binding(s) for the clause.');
    }
  });

  it('includes a withdrawn renewal predecessor in the disclosed-gap probe without grading it', () => {
    const selected = [
      evidence({ id: 41001, evidenceRef: 'surface:first' }),
      evidence({ id: 41002, evidenceRef: 'surface:second' }),
    ];
    const baseline = evaluateSpecTestAdequacy({
      clause: clause(), evidence: selected, harness: 'papercusp', classRef: 'plan-class-feature-ship',
    });
    // A withdrawn row is absent from listSpecEvidence's active population, but
    // remains explicitly cited by the replacement's persisted renewal metadata.
    selected[1]!.details.renewal = { priorBindingId: 40999 };
    const result = evaluateSpecTestAdequacy({
      clause: clause(), evidence: selected, harness: 'papercusp', classRef: 'plan-class-feature-ship',
    });
    const text = result.scorecardDraft.ratings['disclosed-gap'].evidence;
    const match = text.match(/Evidence probe: plans:get-spec-evidence (\{[^\n]*\})\. Inspect evidence\[\]/);
    expect(match).not.toBeNull();
    const probe = getSpecEvidenceTool.args.parse(JSON.parse(match![1]!));
    expect(probe.bindingIds).toEqual([40999, 41001, 41002]);
    expect(probe.includeRetracted).toBe(true);
    expect(text).toContain('renewal predecessor bindingIds=[40999]');
    expect(text).toContain('Exclude withdrawn rows before applying activeSpecEvidence');
    expect(text).toContain('2 raw binding(s), 2 active logical binding(s); active bindingIds=[41001,41002].');
    expect(result.scorecardDraft.rerunRecipe.args.bindingIds).toEqual([41001, 41002]);
    for (const criterion of ADEQUACY_CRITERIA) {
      expect(result.ratings[criterion].rating).toBe(baseline.ratings[criterion].rating);
    }
  });

  it('keeps the empty evidence probe empty after later bindings are added', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(), evidence: [], harness: 'papercusp', classRef: 'plan-class-feature-ship',
    });
    const text = result.scorecardDraft.ratings.traceability.evidence;
    const match = text.match(/Evidence probe: plans:get-spec-evidence (\{[^\n]*\})\. Inspect evidence\[\]/);
    expect(match).not.toBeNull();
    const args = getSpecEvidenceTool.args.parse(JSON.parse(match![1]!));
    expect(args.bindingIds).toEqual([]);
    expect(args).not.toHaveProperty('includeRetracted');
  });

  it('keeps a large multi-binding proof valid for the actual emit schema without losing binding details', () => {
    const rows = Array.from({ length: 5 }, (_, index) => {
      const row = evidence({ id: 201 + index, evidenceRef: `surface:large-binding-${index}` });
      const caseTitle = `binding-${index} selected case ${'detail'.repeat(200)}`;
      row.testRunExecution!.passedCaseTitles = [caseTitle];
      row.testRunExecution!.passed = 1;
      row.details.adequacy = { ...(row.details.adequacy as Record<string, unknown>), testCases: [caseTitle] };
      return row;
    });
    const result = evaluateSpecTestAdequacy({ clause: clause(), evidence: rows, classRef: 'plan-class-feature-ship' });
    const draft = result.scorecardDraft;
    expect(scorecardEmitArgs.safeParse(draft).success).toBe(true);
    expect(draft.body.length).toBeLessThanOrEqual(8_000);
    expect(draft.body).toContain('resolves in the traceability criterion evidence');
    for (const [index, row] of rows.entries()) {
      expect(draft.ratings.traceability.evidence).toContain(`id=${row.id}`);
      expect(draft.ratings.traceability.evidence).toContain(`binding-${index} selected case`);
    }
    expect(draft.rerunRecipe.args.bindingIds).toEqual([201, 202, 203, 204, 205]);
    for (const criterion of ADEQUACY_CRITERIA) {
      expect(draft.ratings[criterion].rating).toBe(result.ratings[criterion].rating);
    }
  });

  it('identifies every binding when traceability evidence is capped', () => {
    const rows = Array.from({ length: 7 }, (_, index) => evidence({
      id: 301 + index,
      evidenceRef: `surface:traceability-binding-${index}`,
      testRunId: 301 + index,
    }));
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: rows,
      classRef: 'plan-class-feature-ship',
    });

    expect(result.scorecardDraft.ratings.traceability.evidence).toContain(
      '7 distinct immutable proof record(s)',
    );
    for (const row of rows) {
      expect(result.scorecardDraft.ratings.traceability.evidence).toContain(`id=${row.id}`);
    }
  });

  it('renders measurement-pin repository namespaces and child commits for historical reads', () => {
    const childCommit = 'b'.repeat(40);
    const row = evidence({
      id: 38801,
      evidenceKind: 'test',
      evidenceRef: 'libs/generic/tooldef/src/tool.test.ts',
      testRunId: 38801,
    });
    row.details.measurementPin = {
      schemaVersion: 1,
      repos: [
        { repo: '.', head: 'a'.repeat(40), gitlink: null },
        { repo: 'libs/generic/tooldef', head: childCommit, gitlink: childCommit },
      ],
      files: [
        {
          path: 'libs/generic/tooldef/src/tool.ts',
          dimension: 'source',
          sha256: 'c'.repeat(64),
          gitBlob: 'd'.repeat(40),
          repo: 'libs/generic/tooldef',
          headBlob: 'd'.repeat(40),
          clean: true,
        },
      ],
    };

    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [row],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.traceability.evidence).toContain('measurementPin=');
    expect(result.ratings.traceability.evidence).toContain('"repo":"libs/generic/tooldef"');
    expect(result.ratings.traceability.evidence).toContain(`"head":"${childCommit}"`);
    expect(result.ratings.traceability.evidence).toContain('"repositoryPath":"libs/generic/tooldef"');
    expect(result.ratings.traceability.evidence).toContain('"path":"src/tool.ts"');
  });

  it('renders one shared-binding entry per immutable binding id when projections differ', () => {
    const first = evidence({ id: 39099, evidenceRef: 'surface:shared-first' });
    const second = successfulTestBinding('shared-binding.integration.test.ts', {
      testCases: ['acting in TeamChat shows the selected result', 'is a clean workspace starts empty'],
    });
    second.id = 39100;
    const duplicateProjection = {
      ...second,
      details: {
        ...second.details,
        adequacy: {
          ...(second.details.adequacy as Record<string, unknown>),
          testCases: ['is a clean workspace starts empty', 'acting in TeamChat shows the selected result'],
        },
      },
    };
    const disclosureProjection = {
      ...duplicateProjection,
      details: { ...duplicateProjection.details, note: 'reviewed' },
    };

    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [first, second],
      disclosedGapEvidence: [first, disclosureProjection],
      classRef: 'plan-class-feature-ship',
    });
    const sharedBindings = result.scorecardDraft.body.slice(
      result.scorecardDraft.body.indexOf('Shared binding evidence'),
    );

    expect(sharedBindings.match(/id=39100, binding=B\d+/g) ?? []).toHaveLength(1);
    expect(sharedBindings).not.toContain('id=39100, binding=B3');
    expect(sharedBindings).toContain('id=39099, binding=B1');
    expect(sharedBindings).toContain('id=39100, binding=B2');
    expect(result.scorecardDraft.ratings.traceability.evidence).toContain('id=39100, binding=B2');
  });
});

describe('supersession of measured passing case scopes', () => {
  it('allows selected passing cases with unrelated unselected file cases', () => {
    const row = successfulTestBinding('selected.integration.test.ts', {
      testCases: ['suite > selected', 'suite > another selected'],
    });
    row.testRunExecution!.skipped = 95;
    row.testRunExecution!.passedCaseTitles = [
      'outer > suite > selected',
      'outer > suite > another selected',
    ];

    expect(supersedeEligibilityGaps(row)).toEqual([]);
  });

  it.each([
    ['empty declaration', []],
    ['missing selected case', ['suite > selected', 'suite > skipped']],
    ['partial title', ['suite > select']],
  ])('refuses scoped supersession with %s', (_label, testCases) => {
    const row = successfulTestBinding('selected.integration.test.ts', { testCases });
    row.testRunExecution!.skipped = 95;
    row.testRunExecution!.passedCaseTitles = ['outer > suite > selected'];

    expect(supersedeEligibilityGaps(row)).toEqual([
      expect.stringContaining('canonical execution=fail'),
    ]);
  });
});

describe('supersession preserves measured mutation provenance', () => {
  function caughtMutation(): SpecEvidenceForAdequacy {
    return evidence({
      evidenceKind: 'mutation',
      testRunProvenance: {
        filePath: 'test/claim-policy.integration.test.ts',
        commitSha: 'abc123',
        worktreeDirty: false,
        mutationFailureLines: [`${DEFAULT_MUTATION_TEST_CASE}: recorded failed assertion`],
        mutationFailedCaseTitles: [DEFAULT_MUTATION_TEST_CASE],
      },
    });
  }

  it('allows a caught ledger-backed mutant to replace earlier proof', () => {
    expect(supersedeEligibilityGaps(caughtMutation())).toEqual([]);
  });

  it('retains exact failed identities for an explicitly bounded filtered mutant', () => {
    const row = caughtMutation();
    row.testRunExecution!.skipped = 23;
    expect(supersedeEligibilityGaps(row)).toEqual([]);
    row.testRunProvenance!.mutationFailedCaseTitles = ['a different failed case'];
    expect(supersedeEligibilityGaps(row)).toEqual([
      expect.stringContaining('canonical execution=unknown'),
    ]);
  });

  it('refuses binder success claims without measured mutation assertions', () => {
    const row = caughtMutation();
    delete row.testRunProvenance;
    expect(supersedeEligibilityGaps(row)).toEqual([
      expect.stringContaining('measuredMutationFailure=false'),
    ]);
  });

  it.each([
    { status: 'pass', passed: 1, failed: 0, collectionFailed: false },
    { status: 'fail', passed: 0, failed: 1, collectionFailed: true },
    { status: 'fail', passed: 0, failed: 0, collectionFailed: false },
  ])('refuses an uncaught or non-assertion mutant %j', execution => {
    const row = caughtMutation();
    row.testRunExecution = { ...row.testRunExecution!, ...execution };
    expect(supersedeEligibilityGaps(row)).not.toEqual([]);
  });

  it('matches measured mutation titles across Vitest joiner spellings without accepting a suffix', () => {
    const exactTitle = 'suite > selected case';
    const recorded = evidence({
      evidenceKind: 'mutation',
      testRunProvenance: {
        filePath: 'test/case.integration.test.ts',
        commitSha: 'abc123',
        worktreeDirty: false,
        mutationFailedCaseTitles: [exactTitle],
      },
    });
    const lineOnly = evidence({
      evidenceKind: 'mutation',
      testRunProvenance: {
        filePath: 'test/case.integration.test.ts',
        commitSha: 'abc123',
        worktreeDirty: false,
        mutationFailureLines: [`${exactTitle}: expected true to be false`],
      },
    });

    expect(mutationMeasuredFailedCase(recorded, 'suite selected case')).toBe(true);
    expect(mutationMeasuredFailedCase(lineOnly, 'suite selected case')).toBe(true);
    expect(mutationMeasuredFailedCase(recorded, 'selected case')).toBe(false);
  });
});

function clause(over: Partial<SpecClauseRevision> = {}): SpecClauseRevision {
  return {
    planSlug: 'reconnect-plan',
    specId: 'SPEC-003-01',
    sourceValId: 'VAL-003-01',
    currentRevision: 1,
    revision: 1,
    planItemId: 'P-003',
    behavior: 'An acknowledged event is not replayed after reconnect.',
    behaviorClass: 'happy-path',
    requiredEvidence: ['integration fixture'],
    requiredTestLayers: ['integration'],
    mutationRequired: false,
    lifecycleStatus: 'active',
    supersedes: null,
    exemption: null,
    falsifier: null,
    contentHash: 'sha256:spec-v1',
    createdBy: 'su-test',
    createdAt: '2026-08-20T00:00:00.000Z',
    acceptedBy: 'reviewer',
    acceptedAt: '2026-08-20T00:01:00.000Z',
    acceptanceRef: 'D-003',
    ...over,
  };
}

function evidence(over: Partial<SpecEvidenceForAdequacy> = {}): SpecEvidenceForAdequacy {
  const defaultExecution: NonNullable<SpecEvidenceForAdequacy['testRunExecution']> = over.evidenceKind === 'mutation'
    ? { status: 'fail', passed: 0, failed: 1, skipped: 0, collectionFailed: false, testLayer: 'integration' }
    : {
        status: 'pass',
        passed: 1,
        failed: 0,
        skipped: 0,
        collectionFailed: false,
        testLayer: 'integration',
        passedCaseTitles: [DEFAULT_MUTATION_TEST_CASE],
      };
  const row: SpecEvidenceForAdequacy = {
    workItemId: 'WI-101',
    planSlug: 'reconnect-plan',
    specId: 'SPEC-003-01',
    specRevision: 1,
    specFingerprint: 'sha256:spec-v1',
    evidenceKind: 'coverage-census',
    evidenceRef: 'surface:reconnect',
    fingerprints: {
      sourceFingerprint: 'git:abc',
      testFingerprint: 'sha256:test',
      fixtureFingerprint: 'sha256:fixture',
      rubricFingerprint: 'sha256:rubric',
      environmentFingerprint: 'node:24',
    },
    coverageEvidenceRef: 42,
    testRunId: 43,
    testRunExecution: defaultExecution,
    details: {
      adequacy: {
        fixtureCalibrated: true,
        falsifiable: true,
        testLayer: 'integration',
        pathReachable: true,
        oracleIndependent: true,
        collected: true,
        skipped: false,
        executed: true,
        outcome: 'passed',
        targeted: 'SPEC-003-01',
        testCases: [DEFAULT_MUTATION_TEST_CASE],
        coverageRungs: { l3: true, l4: false },
      },
    },
    currentness: {
      // WI-2146375: every dimension here reads 'current', which is only reachable when a
      // comparison input WAS supplied — `unknown` is what you get when nobody asked.
      comparisonSupplied: true,
      provenance: 'server-measured',
      overall: 'current',
      dimensions: {
        spec: 'current',
        source: 'current',
        test: 'current',
        fixture: 'current',
        rubric: 'current',
        environment: 'current',
        coverageEvidence: 'current',
        testRun: 'current',
      },
      staleReasons: [],
      unknownReasons: [],
    },
    ...over,
  };
  if (over.testRunExecution && row.testRunExecution) {
    row.testRunExecution = { ...defaultExecution, ...over.testRunExecution };
  }
  if (
    row.evidenceKind === 'mutation' &&
    row.testRunProvenance &&
    !row.testRunProvenance.mutationFailureLines
  ) {
    row.testRunProvenance = {
      ...row.testRunProvenance,
      mutationFailureLines: [`${DEFAULT_MUTATION_TEST_CASE}: expected true to be false`],
    };
  }
  return row;
}

function ledgerCensusEvidence(): SpecEvidenceForAdequacy {
  const base = evidence();
  return evidence({
    evidenceRef: 'WI-101#manual-census',
    evidenceKind: 'coverage-census',
    coverageEvidenceRef: null,
    testRunId: null,
    testRunExecution: null,
    fingerprints: {
      sourceFingerprint: 'sha256-work-item-set-v1:ledger',
      testFingerprint: null,
      fixtureFingerprint: null,
      rubricFingerprint: null,
      environmentFingerprint: null,
    },
    details: {
      evidencePlane: 'tree',
      currentMeasurement: { schemaVersion: 1, kind: 'work-items', workItemIds: ['WI-101'] },
      adequacy: { collected: true, skipped: false, executed: true, outcome: 'passed',
        pathReachable: true, oracleIndependent: true },
    },
    currentness: {
      ...base.currentness!,
      dimensions: { ...base.currentness!.dimensions, test: 'not-applicable', fixture: 'not-applicable',
        rubric: 'not-applicable', environment: 'not-applicable', coverageEvidence: 'not-applicable',
        testRun: 'not-applicable' },
    },
  });
}

function successfulTestBinding(
  filePath: string,
  options: {
    layer?: string;
    testCases?: string[];
    targeted?: boolean | string;
    scenarioIds?: string[];
    scenarioTestCases?: Record<string, string[]>;
  } = {},
): SpecEvidenceForAdequacy {
  const testLayer = options.layer ?? 'integration';
  const testCases = options.testCases ?? [DEFAULT_MUTATION_TEST_CASE];
  return evidence({
    evidenceKind: 'test',
    evidenceRef: `test-run:${filePath}`,
    coverageEvidenceRef: null,
    testRunProvenance: { filePath, commitSha: 'abc123', worktreeDirty: false },
    testRunExecution: {
      status: 'pass',
      passed: Math.max(1, testCases.length),
      failed: 0,
      skipped: 0,
      collectionFailed: false,
      testLayer,
      passedCaseTitles: testCases,
    },
    details: {
      adequacy: {
        testLayer,
        targeted: options.targeted ?? 'SPEC-003-01',
        pathReachable: true,
        collected: true,
        skipped: false,
        executed: true,
        outcome: 'passed',
        testCases,
        ...(options.scenarioIds ? { scenarioIds: options.scenarioIds } : {}),
        ...(options.scenarioTestCases ? { scenarioTestCases: options.scenarioTestCases } : {}),
      },
    },
  });
}

describe('machine-first R5 evidence matrix calibration', () => {
  // Deliberately synthetic, complete controls. Actual plan receipts are separately measured;
  // these fixtures must never be cited as execution of the machine-first journeys.
  function matrix() {
    const owners = [
      ['R-1', 'P-001', 'machine-switch'], ['R-2', 'P-002', 'hosted-signup'],
      ['R-3', 'P-003', 'personal-machine'], ['R-4', 'P-004', 'machine-first-launch'],
      ['R-6', 'P-003', 'tenant-boundary'], ['R-8', 'P-006', 'connection-guide'],
      ['R-9', 'P-005', 'byoc-cli'], ['R-10', 'P-005', 'unsealed-refusal'],
    ];
    const required = owners.map(([bar, item, scenario]) => ({
      rowId: `${item}/${bar}/${scenario}`,
      clause: clause({
        planSlug: 'machine-first-calibration', planItemId: item!,
        specId: `AUTO-BAR-${bar}-${item}`, contentHash: `sha256:${bar}-${item}`,
      }),
      scenarioId: scenario!, caseTitle: `machine-first > ${scenario}`,
      candidate: {
        sourceSha: 'candidate-source', testFile: `test/${scenario}.integration.test.ts`,
        testBlob: 'candidate-test-blob', artifact: { buildId: 'candidate-build', sha256: 'candidate-archive' },
      },
      evidencePlane: 'tree' as const,
    }));
    const observed = required.map((row, index) => ({
      rowId: row.rowId,
      evidence: {
        ...successfulTestBinding(row.candidate.testFile, { testCases: [row.caseTitle] }),
        id: index + 1, planSlug: row.clause.planSlug, specId: row.clause.specId,
        specFingerprint: row.clause.contentHash,
        details: {
          ...successfulTestBinding(row.candidate.testFile, { testCases: [row.caseTitle] }).details,
          evidencePlane: 'tree',
        },
      },
      observed: structuredClone(row.candidate), evidencePlane: 'tree' as const,
      claimsShipment: false, setupOnly: false,
    }));
    return { required, observed, classRef: 'plan-class-feature-ship' as const };
  }

  it('accepts the complete matched executed baseline without certifying journey behavior', () => {
    const result = evaluateSpecEvidenceMatrix(matrix());
    expect(result).toMatchObject({ healthy: true, requiredRowCount: 8, observedRowCount: 8, extraRowIds: [] });
    expect(result.rows.every((row) => row.rules.length === 0)).toBe(true);
  });

  it('rejects an altered copy with a missing required journey without shrinking the inventory', () => {
    const copy = matrix();
    const removed = copy.observed.splice(1, 1)[0]!;
    const result = evaluateSpecEvidenceMatrix(copy);
    expect(result).toMatchObject({ healthy: false, requiredRowCount: 8, observedRowCount: 7 });
    expect(result.rows.find((row) => row.rowId === removed.rowId)?.rules).toEqual(['missing-required-row']);
  });

  it.each(['sourceSha', 'testBlob', 'artifact', 'freshness'] as const)(
    'rejects an altered copy with mismatched/stale %s identity', (field) => {
      const copy = matrix();
      const row = copy.observed[1]!;
      if (field === 'artifact') row.observed.artifact.sha256 = 'older-archive';
      else if (field === 'freshness') {
        row.evidence.currentness = { ...row.evidence.currentness, overall: 'stale', staleReasons: ['source-fingerprint-changed'] };
      } else row.observed[field] = 'older-bytes';
      const result = evaluateSpecEvidenceMatrix(copy);
      expect(result.healthy).toBe(false);
      expect(result.rows[1]!.rules).toContain(field === 'freshness' ? field : `${field}-identity-mismatch`);
      expect(result.rows.filter((entry) => entry.rules.length > 0)).toHaveLength(1);
    },
  );

  it.each(['skipped', 'setup-only', 'unexecuted', 'unmatched-case'] as const)(
    'rejects an altered copy with a %s receipt despite binder success claims', (mode) => {
      const copy = matrix();
      const row = copy.observed[1]!;
      if (mode === 'setup-only') row.setupOnly = true;
      else if (mode === 'unexecuted') row.evidence.testRunExecution!.passed = 0;
      else {
        row.evidence.testRunExecution!.passedCaseTitles = ['some other case'];
        if (mode === 'skipped') row.evidence.testRunExecution!.skipped = 1;
      }
      const result = evaluateSpecEvidenceMatrix(copy);
      expect(result.healthy).toBe(false);
      expect(result.rows[1]!.rules).toContain(mode === 'setup-only' ? 'setup-only-or-unknown' :
        mode === 'unexecuted' ? 'execution-integrity' : 'unmatched-executed-case');
    },
  );

  it('rejects an altered copy relabelling tree evidence as deployed shipment', () => {
    const copy = matrix();
    copy.observed[1]!.claimsShipment = true;
    const result = evaluateSpecEvidenceMatrix(copy);
    expect(result.healthy).toBe(false);
    expect(result.rows[1]!.rules).toContain('tree-evidence-claimed-as-shipment');
  });

  it('uses the binding plane when a matrix row is relabelled as live', () => {
    const copy = matrix();
    const observed = { ...copy.observed[1]!, evidencePlane: 'live' as const, claimsShipment: true };
    const required = { ...copy.required[1]!, evidencePlane: 'live' as const };
    const result = evaluateSpecEvidenceMatrix({ ...copy, required: [required], observed: [observed] });
    expect(result.healthy).toBe(false);
    expect(result.rows[0]!.rules).toContain('binding-plane-mismatch');
  });

  it('refuses empty, duplicate, extra, unknown and attested matrices', () => {
    expect(evaluateSpecEvidenceMatrix({ ...matrix(), required: [], observed: [] }).healthy).toBe(false);
    const changes = [
      (copy: ReturnType<typeof matrix>) => copy.required.push(copy.required[0]!),
      (copy: ReturnType<typeof matrix>) => copy.observed.push(copy.observed[0]!),
      (copy: ReturnType<typeof matrix>) => { copy.observed[0]!.rowId = 'unexpected-journey'; },
      (copy: ReturnType<typeof matrix>) => { copy.required[0]!.candidate.sourceSha = ''; copy.observed[0]!.observed.sourceSha = ''; },
      (copy: ReturnType<typeof matrix>) => { copy.observed[0]!.evidence.currentness.provenance = 'attested-current'; },
      (copy: ReturnType<typeof matrix>) => { Reflect.deleteProperty(copy.observed[0]!.evidence, 'id'); },
      (copy: ReturnType<typeof matrix>) => { copy.observed[0]!.evidence.specRevision = 99; },
    ];
    for (const alter of changes) {
      const copy = matrix();
      alter(copy);
      expect(evaluateSpecEvidenceMatrix(copy).healthy).toBe(false);
    }
  });
});

describe('source BAR registered test files', () => {
  const requiredFiles = [
    'packages/service/src/api.test.ts',
    'packages/service/src/store.test.ts',
  ];
  const sourceBar = {
    barKey: 'BAR-TESTS',
    barHash: 'bar-hash',
    barSetHash: 'bar-set-hash',
    rubricSlug: 'acceptance-service',
    rubricRevision: 4,
    evidencePlane: 'tree' as const,
  };

  function fileRun(
    filePath: string,
    testRunId: number,
    options: { currentness?: 'current' | 'stale'; status?: 'pass' | 'fail' } = {},
  ): SpecEvidenceForAdequacy {
    const row = successfulTestBinding(filePath);
    row.testRunId = testRunId;
    row.evidenceRef = `test-run:${testRunId}:${filePath}`;
    row.currentness = { ...row.currentness, overall: options.currentness ?? 'current' };
    if (options.status === 'fail') {
      row.testRunExecution = {
        ...row.testRunExecution!,
        status: 'fail',
        passed: 0,
        failed: 1,
      };
      row.details = {
        ...row.details,
        adequacy: { ...(row.details.adequacy as Record<string, unknown>), outcome: 'failed' },
      };
    }
    return row;
  }

  function grade(evidenceRows: SpecEvidenceForAdequacy[]) {
    return evaluateSpecTestAdequacy({
      clause: clause({ sourceBar, requiredTestLayers: [] }),
      evidence: evidenceRows,
      classRef: 'plan-class-feature-ship',
      sourceBarTestRequirements: { status: 'required', files: requiredFiles },
    });
  }

  it('passes only when every registered file has current passing ledger evidence', () => {
    const result = grade([
      fileRun(requiredFiles[0]!, 101),
      fileRun(requiredFiles[1]!, 102),
    ]);

    expect(result.ratings['correct-layer'].rating).toBe('pass');
    expect(result.ratings['correct-layer'].evidence).toContain(requiredFiles[0]!);
    expect(result.ratings['correct-layer'].evidence).toContain(requiredFiles[1]!);
  });

  it('deduplicates overlapping correct-layer evidence and explains excluded mutation proof', () => {
    const first = fileRun(requiredFiles[0]!, 35282);
    first.id = 35282;
    const second = fileRun(requiredFiles[1]!, 35627);
    second.id = 35627;
    const mutation = evidence({
      id: 35586,
      evidenceKind: 'mutation',
      evidenceRef: 'mutation:35586',
      testRunId: 35586,
    });
    const result = evaluateSpecTestAdequacy({
      clause: clause({ sourceBar, requiredTestLayers: ['integration'] }),
      evidence: [first, second, mutation],
      classRef: 'plan-class-feature-ship',
      sourceBarTestRequirements: { status: 'required', files: requiredFiles },
    });
    const explanation = result.ratings['correct-layer'].evidence;
    const boundIds = [...explanation.matchAll(/id=(\d+), kind=/g)].map((match) => Number(match[1]));

    expect(result.ratings['correct-layer'].rating).toBe('pass');
    expect(boundIds).toHaveLength(2);
    expect(boundIds).toEqual(expect.arrayContaining([35282, 35627]));
    expect(explanation).toContain(
      'Mutation binding(s) id=35586 are excluded because mutation outcomes establish falsifiability, not correct-layer path reachability.',
    );
  });

  it('keeps missing and stale registered-file evidence unknown', () => {
    const missing = grade([fileRun(requiredFiles[0]!, 103)]);
    expect(missing.ratings['correct-layer'].rating).toBe('unknown');
    expect(missing.ratings['correct-layer'].evidence).toContain(requiredFiles[1]!);

    const stale = grade([
      fileRun(requiredFiles[0]!, 104),
      fileRun(requiredFiles[1]!, 105, { currentness: 'stale' }),
    ]);
    expect(stale.ratings['correct-layer'].rating).toBe('unknown');
    expect(stale.ratings['correct-layer'].evidence).toContain(requiredFiles[1]!);
  });

  it('fails a current registered-file run that failed', () => {
    const result = grade([
      fileRun(requiredFiles[0]!, 106),
      fileRun(requiredFiles[1]!, 107, { status: 'fail' }),
    ]);

    expect(result.ratings['correct-layer'].rating).toBe('fail');
    expect(result.ratings['correct-layer'].evidence).toContain(requiredFiles[1]!);
  });

  it('counts aliases of one testRunId once in traceability evidence', () => {
    const first = fileRun(requiredFiles[0]!, 108);
    const alias = { ...first, id: 109, evidenceRef: 'test-run-alias:108' };
    const result = grade([first, alias, fileRun(requiredFiles[1]!, 110)]);

    expect(result.ratings.traceability.evidence).toContain('2 distinct immutable proof record(s)');
    expect(result.ratings.traceability.evidence).not.toContain('3 immutable binding(s)');
  });

  describe('explicit shared source BAR cases', () => {
    const target = clause({ sourceBar, specId: 'AUTO-BAR-R-08-P-010', requiredTestLayers: ['integration'] });
    const ownCase = `${target.specId}: onboarding`;
    const sharedCase = 'AUTO-BAR-R-08-P-011: package lifecycle';
    const selectors = [{ file: requiredFiles[0]!, testName: ownCase }, { file: requiredFiles[1]!, testName: sharedCase }];
    function selectedRun(file: string, title: string, id: number): SpecEvidenceForAdequacy {
      const row = successfulTestBinding(file, { targeted: target.specId, testCases: [`suite > ${title}`] });
      return { ...row, planSlug: target.planSlug, specId: target.specId, specFingerprint: target.contentHash, testRunId: id };
    }
    const own = () => selectedRun(requiredFiles[0]!, ownCase, 201);
    const shared = () => selectedRun(requiredFiles[1]!, sharedCase, 202);
    function evaluate(rows = [own(), shared()], cases: typeof selectors | undefined = selectors) {
      return evaluateSpecTestAdequacy({ clause: target, evidence: rows, classRef: 'plan-class-feature-ship', sourceBarTestRequirements: { status: 'required', files: requiredFiles, ...(cases ? { cases } : {}) } });
    }

    it('credits an explicitly selected shared suite case while requiring independent same-clause path proof', () => {
      const result = evaluate();
      expect(result.ratings['correct-layer'].rating).toBe('pass');
      expect(result.ratings.traceability.rating).toBe('pass');
      const noOwnPath = evaluate([
        selectedRun(requiredFiles[0]!, sharedCase, 203), shared(),
      ], [{ file: requiredFiles[0]!, testName: sharedCase }, selectors[1]!]);
      expect(noOwnPath.ratings['correct-layer'].rating).toBe('unknown');
      expect(noOwnPath.ratings['correct-layer'].evidence).toContain('Every registered source BAR test file has a current passing binding');
      expect(noOwnPath.ratings.traceability.rating).toBe('unknown');
      expect(noOwnPath.ratings.falsifiability.rating).not.toBe('pass');
    });

    it('does not treat a different registered sibling as named-case proof', () => {
      expect(evaluate(undefined, [selectors[0]!, { ...selectors[1]!, testName: 'AUTO-BAR-R-08-P-012: other case' }]).ratings['correct-layer'].rating).toBe('unknown');
    });

    describe('whole-file shared source BAR coverage', () => {
      function wholeFile(rows = [own(), shared()]) {
        return evaluateSpecTestAdequacy({
          clause: target, evidence: rows, classRef: 'plan-class-feature-ship',
          sourceBarTestRequirements: { status: 'required', files: requiredFiles },
        });
      }

      it('credits a complete passing shared file without named selectors', () => {
        const result = wholeFile();
        expect(result.ratings['correct-layer'].rating).toBe('pass');
        expect(result.ratings['correct-layer'].evidence).toContain(requiredFiles[1]!);
        expect(result.ratings.traceability.rating).toBe('pass');
      });

      it('requires independent same-clause path proof even when both whole files pass', () => {
        const result = wholeFile([selectedRun(requiredFiles[0]!, sharedCase, 203), shared()]);
        expect(result.ratings['correct-layer'].evidence).toContain('Every registered source BAR test file has a current passing binding');
        expect(result.ratings['correct-layer'].rating).toBe('unknown');
        expect(result.ratings.traceability.rating).toBe('unknown');
        expect(result.ratings.falsifiability.rating).not.toBe('pass');
      });

      it.each(['stale', 'failed', 'filtered', 'skipped', 'unrecorded', 'missing-file'] as const)(
        'refuses incomplete whole-file shared suite coverage: %s', mode => {
          const row = shared();
          if (mode === 'stale') row.currentness = { ...row.currentness, overall: 'stale' };
          if (mode === 'failed') row.testRunExecution = { ...row.testRunExecution!, status: 'fail', passed: 0, failed: 1 };
          if (mode === 'filtered') row.testRunExecution = { ...row.testRunExecution!, testNamePattern: sharedCase };
          // A passed declared case cannot stand in for the skipped remainder of a whole file.
          if (mode === 'skipped') row.testRunExecution = { ...row.testRunExecution!, skipped: 1 };
          if (mode === 'unrecorded') row.testRunId = null;
          const result = wholeFile(mode === 'missing-file' ? [own()] : [own(), row]);
          expect(result.ratings['correct-layer'].rating).toBe(mode === 'failed' ? 'fail' : 'unknown');
        },
      );
    });

    it.each(['stale', 'failed', 'unrecorded', 'unselected', 'missing-selector', 'missing-file'] as const)('refuses incomplete shared suite coverage: %s', mode => {
      const row = shared();
      if (mode === 'stale') row.currentness = { ...row.currentness, overall: 'stale' };
      if (mode === 'failed') row.testRunExecution = { ...row.testRunExecution!, status: 'fail', passed: 0, failed: 1 };
      if (mode === 'unrecorded') row.testRunExecution = { ...row.testRunExecution!, passedCaseTitles: ['unrelated passed case'] };
      if (mode === 'unselected') row.details = { adequacy: { ...(row.details.adequacy as Record<string, unknown>), testCases: ['unrelated declared case'] } };
      const cases = mode === 'missing-selector' ? [...selectors, { file: requiredFiles[1]!, testName: 'AUTO-BAR-R-08-P-018: archive' }] : selectors;
      const result = evaluate(mode === 'missing-file' ? [own()] : [own(), row], cases);
      expect(result.ratings['correct-layer'].rating).toBe(mode === 'failed' ? 'fail' : 'unknown');
    });
  });
});

function negativeEvidence(over: Partial<SpecEvidenceForAdequacy> = {}): SpecEvidenceForAdequacy {
  const base = evidence();
  return {
    ...base,
    evidenceKind: 'counterexample',
    evidenceRef: 'counterexample:reconnect',
    testRunProvenance: {
      filePath: '',
      commitSha: null,
      worktreeDirty: null,
      ...(base.testRunProvenance ?? {}),
      source: 'mutation-probe',
      mutationPhase: 'mutant',
      mutationFailedCaseTitles: [DEFAULT_MUTATION_TEST_CASE],
    },
    testRunExecution: {
      ...base.testRunExecution!,
      status: 'fail',
      passed: 0,
      failed: 1,
    },
    details: {
      adequacy: {
        ...((base.details.adequacy ?? {}) as Record<string, unknown>),
        targeted: true,
        outcome: 'pass',
      },
    },
    ...over,
  };
}

const RECONNECT_FALSIFIER_SCENARIO = 'reconnect-failure';
const CASE_SCOPED_TEST_PATH = 'test/reconnect.integration.ts';

function caseScopedClause(over: Partial<SpecClauseRevision> = {}): SpecClauseRevision {
  return clause({
    ...over,
    falsifier: {
      observation: 'The reconnect promise is violated.',
      requiredScenarios: [RECONNECT_FALSIFIER_SCENARIO],
    },
  });
}

function caseScopedNegativeEvidence(over: Partial<SpecEvidenceForAdequacy> = {}): SpecEvidenceForAdequacy {
  const base = negativeEvidence(over);
  return {
    ...base,
    testRunProvenance: {
      ...(base.testRunProvenance ?? {}),
      filePath: CASE_SCOPED_TEST_PATH,
      commitSha: 'abc123',
      worktreeDirty: false,
    },
    details: {
      ...base.details,
      adequacy: {
        ...(base.details.adequacy as Record<string, unknown>),
        targeted: RECONNECT_FALSIFIER_SCENARIO,
        scenarioIds: [RECONNECT_FALSIFIER_SCENARIO],
      },
    },
  };
}

function caseScopedTestBinding(): SpecEvidenceForAdequacy {
  return successfulTestBinding(CASE_SCOPED_TEST_PATH, {
    scenarioIds: [RECONNECT_FALSIFIER_SCENARIO],
    scenarioTestCases: {
      [RECONNECT_FALSIFIER_SCENARIO]: [DEFAULT_MUTATION_TEST_CASE],
    },
  });
}

function attempt(
  n: number,
  patch: {
    outcome?: string;
    sources?: string[];
    layer?: string;
    plane?: string;
    scenarios?: string[];
    pair?: string;
    filter?: string;
    phase?: string;
  } = {},
): SpecEvidenceForAdequacy[] {
  const binding = {
    specId: clause().specId,
    specRevision: 1,
    testPath: 'test/reconnect.test.ts',
    sourcePaths: patch.sources ?? ['src/reconnect.ts'],
    testLayer: patch.layer ?? 'integration',
    ...(patch.scenarios ? { scenarioIds: patch.scenarios } : {}),
    ...(patch.pair ? { causalPairId: patch.pair } : {}),
  };
  const base = evidence({
    evidenceKind: 'test',
    evidenceRef: `test-run-group:attempt-${n}:0`,
    coverageEvidenceRef: null,
    testRunId: null,
  });
  const adequacy = {
    ...(base.details.adequacy as object),
    testLayer: binding.testLayer,
    ...(patch.scenarios ? { scenarioIds: patch.scenarios } : {}),
    ...(patch.pair ? { causalPairIds: [patch.pair] } : {}),
  };
  const details = {
    currentMeasurement: {
      schemaVersion: 1,
      kind: 'repo-files',
      sourcePaths: binding.sourcePaths,
      testPaths: [binding.testPath],
    },
    testExecution: { schemaVersion: 1, phase: 'pending', originRunId: `attempt-${n}`, runId: `attempt-${n}`, binding },
    adequacy: { ...adequacy, outcome: 'pending', collected: false, executed: false },
  };
  const pending = {
    ...base,
    id: n * 10,
    testRunExecution: null,
    createdAt: `2026-09-09T00:${String(n).padStart(2, '0')}:00Z`,
    details,
  };
  const outcome = patch.outcome ?? 'pass';
  const runStatus = patch.phase === 'pending'
    ? 'running'
    : outcome === 'failed' || outcome === 'fail'
      ? 'fail'
      : outcome === 'unknown' || outcome === 'pending'
        ? 'running'
        : 'pass';
  return [
    pending,
    {
      ...pending,
      id: n * 10 + 1,
      testRunId: n,
      testRunExecution: {
        status: runStatus,
        passed: runStatus === 'pass' ? 1 : 0,
        failed: runStatus === 'fail' ? 1 : 0,
        skipped: 0,
        collectionFailed: false,
        testLayer: binding.testLayer,
        ...(runStatus === 'pass' ? { passedCaseTitles: [DEFAULT_MUTATION_TEST_CASE] } : {}),
      },
      details: {
        ...details,
        ...(patch.plane ? { evidencePlane: patch.plane } : {}),
        testExecution: {
          ...details.testExecution,
          phase: patch.phase ?? 'settled',
          ...(patch.filter ? { testNamePattern: patch.filter } : {}),
        },
        adequacy: { ...adequacy, outcome: patch.outcome ?? 'pass', collected: true, executed: true },
      },
    },
  ];
}

describe('active registered test attempts (EI-22773954051523742)', () => {
  it('retires an older unknown attempt after a wider-source rerun, without changing history', () => {
    const old = attempt(1, { outcome: 'unknown' });
    const fresh = attempt(2, { sources: ['src/reconnect.ts', 'src/reporter.ts'] });
    const rows = [...old, ...fresh];
    const unchanged = JSON.stringify(rows);
    expect(latestLogicalEvidence(rows)).toEqual([old[1], fresh[1]]);
    expect(activeSpecEvidence(rows)).toEqual([fresh[1]]);
    expect(JSON.stringify(rows)).toBe(unchanged);
    expect(
      evaluateSpecTestAdequacy({
        clause: caseScopedClause(),
        evidence: [...rows, caseScopedTestBinding(), caseScopedNegativeEvidence()],
        classRef: 'plan-class-feature-ship',
      }).verdict,
    ).toBe('pass');
  });

  it.each(['failed', 'unknown', 'pending'])('never selects a past pass over a newer %s', (outcome) => {
    const old = attempt(1);
    const fresh = attempt(2, { outcome });
    if (outcome === 'pending') fresh.pop();
    const rows = [...old, ...fresh];
    expect(activeSpecEvidence(rows)).toEqual([fresh.at(-1)]);
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [...rows, negativeEvidence()],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.wouldBlock).toContain('execution-integrity');
  });

  it.each(['unknown', 'stale'] as const)('does not hide %s freshness behind another current passing proof', (state) => {
    const fresh = attempt(2);
    fresh[1]!.currentness = {
      ...fresh[1]!.currentness,
      overall: state,
      provenance: 'not-supplied',
      unknownReasons: state === 'unknown' ? ['server-measurement-unavailable'] : [],
      staleReasons: state === 'stale' ? ['source-fingerprint-changed'] : [],
    };
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [...attempt(1), ...fresh, negativeEvidence()],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.evidenceRefs).toContain(fresh[1]!.evidenceRef);
    expect(result.wouldBlock).toContain('freshness');
  });

  it.each([
    { sources: ['src/other.ts'] },
    { sources: ['src/one.ts'] },
    { layer: 'unit' },
    { plane: 'live' },
    { scenarios: ['scenario-a'] },
    { pair: 'cause-a' },
    { filter: 'one selected test' },
  ])('keeps distinct obligations or narrower measured scope: %j', (patch) => {
    const old = attempt(1, { sources: ['src/reconnect.ts', 'src/one.ts'], outcome: 'failed' });
    const fresh = attempt(2, patch);
    expect(activeSpecEvidence([...old, ...fresh])).toEqual([old[1], fresh[1]]);
    expect(
      evaluateSpecTestAdequacy({
        clause: clause(),
        evidence: [...old, ...fresh, negativeEvidence()],
        classRef: 'plan-class-feature-ship',
      }).wouldBlock,
    ).toContain('execution-integrity');
  });

  it('cannot reverse attempt order by annotating or future-dating old evidence', () => {
    const old = attempt(1);
    const fresh = attempt(2, { outcome: 'failed' });
    const late = { ...old[1]!, id: 99, createdAt: '2099-01-01T00:00:00Z', observedAt: '2099-01-01T00:00:00Z' };
    expect(activeSpecEvidence([...old, ...fresh, late])).toEqual([fresh[1]]);
  });

  it('allows matching reviewed planes but does not borrow an older different plane', () => {
    const old = attempt(1, { plane: 'live' });
    const fresh = attempt(2, { plane: 'tree' });
    expect(activeSpecEvidence([...old, ...fresh])).toEqual([old[1], fresh[1]]);
    const matching = attempt(3, { plane: 'tree' });
    expect(activeSpecEvidence([...fresh, ...matching])).toEqual([matching[1]]);
  });

  it('keeps attempts on different nested evidence planes distinct', () => {
    const nestedAttempt = (n: number, plane: string) => attempt(n).map((row) => ({
      ...row,
      details: { ...row.details, adequacy: { ...(row.details.adequacy as object), evidencePlane: plane } },
    }));
    const live = nestedAttempt(1, 'live');
    const tree = nestedAttempt(2, 'tree');
    expect(activeSpecEvidence([...live, ...tree])).toEqual([live[1], tree[1]]);
    const matching = nestedAttempt(3, 'tree');
    expect(activeSpecEvidence([...tree, ...matching])).toEqual([matching[1]]);
  });

  it('fails closed without original registration and for altered registered obligations', () => {
    const old = attempt(1, { outcome: 'failed' });
    const fresh = attempt(2);
    expect(activeSpecEvidence([old[1]!, ...fresh])).toEqual([old[1], fresh[1]]);
    const altered = {
      ...fresh[1]!,
      details: {
        ...fresh[1]!.details,
        adequacy: { ...(fresh[1]!.details.adequacy as object), scenarioIds: ['unregistered'] },
      },
    };
    expect(activeSpecEvidence([...old, fresh[0]!, altered])).toEqual([old[1], altered]);
  });

  it('keeps changed root, fixture, counterexample and separate work-item proof distinct', () => {
    const old = attempt(1, { outcome: 'failed' });
    for (const mutate of [
      (row: SpecEvidenceForAdequacy) => {
        row.workItemId = 'WI-102';
      },
      (row: SpecEvidenceForAdequacy) => {
        row.evidenceKind = 'counterexample';
      },
      (row: SpecEvidenceForAdequacy) => {
        row.fingerprints = { ...row.fingerprints, fixtureFingerprint: 'different' };
      },
      (row: SpecEvidenceForAdequacy) => {
        row.details.currentMeasurement = {
          ...(row.details.currentMeasurement as object),
          rootHarnessSlug: 'another-root',
        };
      },
    ]) {
      const fresh = structuredClone(attempt(2));
      fresh.forEach(mutate);
      expect(activeSpecEvidence([...old, ...fresh])).toEqual([old[1], fresh[1]]);
    }
  });

  it('does not classify stale manual negative-control history as a registered attempt from copied metadata', () => {
    const rows = attempt(2);
    const historical = {
      ...rows[1]!,
      evidenceKind: 'counterexample' as const,
      evidenceRef: 'manual-negative-controls:old',
      currentness: { ...rows[1]!.currentness, overall: 'stale' as const, staleReasons: ['source-stale'] },
    };
    const result = evaluateSpecTestAdequacy({
      clause: caseScopedClause(),
      evidence: [...rows, historical, caseScopedTestBinding(), caseScopedNegativeEvidence()],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.verdict).toBe('pass');
    expect(result.evidenceRefs).not.toContain(historical.evidenceRef);
    expect(historical.currentness.overall).toBe('stale');
  });
});

describe('spec-test-adequacy per-clause evaluator', () => {
  it.each([41, 43])('preserves explicit proof over a late automatic receipt %i in either input order', (testRunId) => {
    const explicit = evidence({ id: 70, evidenceKind: 'test', createdBy: 'su-reviewer',
      createdAt: '2026-10-16T21:36:00Z', testRunId: 43 });
    const automatic = evidence({ ...explicit, id: 71, createdBy: 'system:spec-evidence-autobind',
      createdAt: '2026-10-16T21:42:00Z', testRunId, details: { adequacy: { executed: true } } });
    for (const rows of [[explicit, automatic], [automatic, explicit]]) {
      expect(latestLogicalEvidence(rows)).toEqual([explicit]);
      expect(activeSpecEvidence(rows)[0]?.details.adequacy).toEqual(explicit.details.adequacy);
    }
  });

  it('allows a genuinely newer automatic receipt to replace explicit proof without inheriting calibration', () => {
    const explicit = evidence({ id: 70, evidenceKind: 'test', createdBy: 'su-reviewer',
      createdAt: '2026-10-16T21:36:00Z', testRunId: 43 });
    const automatic = evidence({ ...explicit, id: 71, createdBy: 'system:spec-evidence-autobind',
      createdAt: '2026-10-16T21:42:00Z', testRunId: 44, details: { adequacy: { executed: true } } });
    expect(latestLogicalEvidence([explicit, automatic])).toEqual([automatic]);
    expect(activeSpecEvidence([explicit, automatic])[0]?.details.adequacy).toEqual(automatic.details.adequacy);
  });

  it('preserves the latest explicit correction rather than reviving richer explicit history', () => {
    const original = evidence({ id: 70, evidenceKind: 'test', createdBy: 'su-reviewer',
      createdAt: '2026-10-16T21:36:00Z', testRunId: 43 });
    const corrected = evidence({ ...original, id: 71, createdAt: '2026-10-16T21:40:00Z',
      details: { adequacy: { executed: true, fixtureCalibrated: false } } });
    const automatic = evidence({ ...original, id: 72, createdBy: 'system:spec-evidence-autobind',
      createdAt: '2026-10-16T21:42:00Z', details: { adequacy: { executed: true } } });
    expect(latestLogicalEvidence([automatic, original, corrected])).toEqual([corrected]);
  });

  it('grades the newest server-created version even when an older row has a future observedAt', () => {
    const evidenceRef = 'test/reconnect.integration.ts#recorded';
    const older = evidence({
      id: 41,
      evidenceRef,
      observedAt: '2099-08-20T00:00:00.000Z',
      createdAt: '2026-08-20T00:00:00.000Z',
      coverageEvidenceRef: null,
      testRunId: null,
      details: { adequacy: { executed: false, skipped: true, coverageRungs: { l3: false } } },
      currentness: {
        ...evidence().currentness,
        overall: 'unknown',
        provenance: 'not-supplied',
        unknownReasons: ['source-current-fingerprint-not-supplied'],
      },
    });
    const newer = evidence({
      id: 42,
      evidenceRef,
      observedAt: '2020-08-20T00:01:00.000Z',
      createdAt: '2026-08-20T00:01:00.000Z',
    });

    expect(latestLogicalEvidence([older, newer])).toEqual([newer]);
    const result = evaluateSpecTestAdequacy({
      clause: caseScopedClause(),
      evidence: [older, newer, caseScopedTestBinding(), caseScopedNegativeEvidence()],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.verdict).toBe('pass');
    expect(result.evidenceRefs).toEqual([evidenceRef, 'counterexample:reconnect', `test-run:${CASE_SCOPED_TEST_PATH}`].sort());
    expect(result.ratings['execution-integrity'].rating).toBe('pass');
  });

  it('lets a ledger-backed re-bind filed under a DIFFERENT work item supersede an unbacked row', () => {
    // Regression: the logical key once included workItemId, so a corrected
    // re-bind of the SAME proof by a different binder landed BESIDE the stale
    // row instead of superseding it. The table is append-only by design, so the
    // stale row was unreachable and dragged execution-integrity to 'unknown'
    // forever via the any-drags unbackedExecution rule.
    const evidenceRef = 'test-run:18136690:R-2-integration-leg@2d6cd439b6';
    const stale = evidence({
      id: 51,
      workItemId: 'WI-1980934',
      evidenceRef,
      createdAt: '2026-09-16T10:18:56.016Z',
      coverageEvidenceRef: null,
      testRunId: null,
      details: { adequacy: { executed: false, skipped: true, coverageRungs: { l3: false } } },
      currentness: {
        ...evidence().currentness,
        overall: 'unknown',
        provenance: 'not-supplied',
        unknownReasons: ['source-current-fingerprint-not-supplied'],
      },
    });
    const rebound = evidence({
      id: 52,
      workItemId: 'WI-10001789',
      evidenceRef,
      testRunId: 18136690,
      testRunProvenance: {
        filePath: 'R-2-integration-leg@2d6cd439b6',
        commitSha: '2d6cd439b6',
        worktreeDirty: false,
      },
      createdAt: '2026-09-18T02:36:09.882Z',
    });

    expect(latestLogicalEvidence([stale, rebound])).toEqual([rebound]);
    const result = evaluateSpecTestAdequacy({
      clause: caseScopedClause(),
      evidence: [stale, rebound, caseScopedTestBinding(), caseScopedNegativeEvidence()],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings['execution-integrity'].rating).toBe('pass');
    expect(result.verdict).toBe('pass');
  });

  it.each([
    { measured: 'operational', claimed: 'operational', expected: 'pass' },
    { measured: undefined, claimed: 'operational', expected: 'unknown' },
    { measured: 'unsupported-adapter', claimed: undefined, expected: 'fail' },
    { measured: 'integration', claimed: 'operational', expected: 'fail' },
  ])('recognizes the canonical operational adapter without accepting caller-only layer claims: $measured/$claimed', ({ measured, claimed, expected }) => {
    const row = evidence({ evidenceKind: measured === 'operational' ? 'operational' : 'test' });
    row.testRunExecution = { ...row.testRunExecution!, testLayer: measured };
    row.details = { adequacy: {
      ...(row.details.adequacy as Record<string, unknown>),
      testLayer: claimed,
      targeted: clause().specId,
    } };
    const result = evaluateSpecTestAdequacy({
      clause: clause({ requiredEvidence: [], requiredTestLayers: ['operational'] }),
      evidence: [row], classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings['correct-layer'].rating).toBe(expected);
  });

  it.each([
    { measured: 'operational', expected: 'pass', matchedCase: true },
    { measured: 'unit', expected: 'fail', matchedCase: true },
    { measured: undefined, expected: 'unknown', matchedCase: true },
    { measured: 'operational', expected: 'unknown', matchedCase: false },
  ])('maps manual-provenance only to a measured operational case: $measured/$matchedCase', ({ measured, expected, matchedCase }) => {
    const caseTitle = 'actual goal has its stored worklist in the native DOM';
    const row = evidence({
      evidenceKind: measured === 'unit' ? 'test' : 'operational',
      testRunProvenance: { filePath: 'docs/evidence/native-goal.json', commitSha: 'abc123', worktreeDirty: false },
      testRunExecution: {
        status: 'pass', passed: 1, failed: 0, skipped: 0,
        collectionFailed: false, testLayer: measured,
        passedCaseTitles: [matchedCase ? caseTitle : 'another check'],
      },
      details: { adequacy: {
        testLayer: 'manual-provenance', pathReachable: true,
        collected: true, skipped: false, executed: true, outcome: 'passed',
        targeted: clause().specId,
        testCases: [caseTitle],
      } },
    });
    const result = evaluateSpecTestAdequacy({
      clause: clause({ requiredEvidence: [], requiredTestLayers: ['manual-provenance'] }),
      evidence: [row], classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings['correct-layer'].rating).toBe(expected);
  });

  it('maps a legacy behavioral requirement only to passing measured operational evidence', () => {
    const caseTitle = 'goal handoff reaches its member-claim behavior';
    const legacyClause = clause({ requiredEvidence: [], requiredTestLayers: ['behavioral'] });
    const operational = evidence({
      evidenceKind: 'operational',
      evidenceRef: 'docs/evidence/goal-handoff.json',
      testRunProvenance: { filePath: 'docs/evidence/goal-handoff.json', commitSha: 'abc123', worktreeDirty: false },
      testRunExecution: {
        status: 'pass',
        passed: 1,
        failed: 0,
        skipped: 0,
        collectionFailed: false,
        testLayer: 'operational',
        passedCaseTitles: [caseTitle],
      },
      details: {
        adequacy: {
          testLayer: 'behavioral',
          pathReachable: true,
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'passed',
          targeted: legacyClause.specId,
          testCases: [caseTitle],
        },
      },
    });
    const measuredOperational = evaluateSpecTestAdequacy({
      clause: legacyClause,
      evidence: [operational],
      classRef: 'plan-class-feature-ship',
    });
    expect(measuredOperational.ratings['correct-layer'].rating).toBe('pass');
    expect(measuredOperational.ratings['correct-layer'].evidence).toContain(
      'behavioral (canonical operational adapter)',
    );
    expect(measuredOperational.ratings['correct-layer'].evidence).toContain('docs/evidence/goal-handoff.json');

    const callerOnly = successfulTestBinding('test/goal-handoff.integration.test.ts', {
      layer: 'integration',
      testCases: [caseTitle],
    });
    callerOnly.details = {
      adequacy: {
        testLayer: 'behavioral',
        pathReachable: true,
        collected: true,
        skipped: false,
        executed: true,
        outcome: 'passed',
        targeted: legacyClause.specId,
        testCases: [caseTitle],
      },
    };
    const mismatchedTestClaim = evaluateSpecTestAdequacy({
      clause: legacyClause,
      evidence: [callerOnly],
      classRef: 'plan-class-feature-ship',
    });
    expect(mismatchedTestClaim.ratings['correct-layer'].rating).toBe('fail');
    expect(mismatchedTestClaim.wouldBlock).toContain('correct-layer');

    const invented = successfulTestBinding('test/invented-layer.test.ts', {
      layer: 'integration',
      testCases: [caseTitle],
    });
    invented.testRunExecution = { ...invented.testRunExecution!, testLayer: undefined };
    invented.details = {
      adequacy: {
        testLayer: 'invented-layer',
        pathReachable: true,
        collected: true,
        skipped: false,
        executed: true,
        outcome: 'passed',
        testCases: [caseTitle],
      },
    };
    const unmeasuredInventedLayer = evaluateSpecTestAdequacy({
      clause: clause({ requiredEvidence: [], requiredTestLayers: ['invented-layer'] }),
      evidence: [invented],
      classRef: 'plan-class-feature-ship',
    });
    expect(unmeasuredInventedLayer.ratings['correct-layer'].rating).toBe('unknown');
    expect(unmeasuredInventedLayer.ratings['correct-layer'].rating).not.toBe('pass');
  });

  it('produces a complete scorecards:emit draft for a current L3 feature proof', () => {
    const result = evaluateSpecTestAdequacy({
      clause: caseScopedClause(),
      evidence: [evidence(), caseScopedTestBinding(), caseScopedNegativeEvidence()],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.verdict).toBe('pass');
    expect(result.requiredProofFloor).toBe('l3');
    expect(result.wouldBlock).toEqual([]);
    expect(result.scorecardDraft).toMatchObject({
      rubricRef: 'spec-test-adequacy',
      subject: { kind: 'plan', ref: 'reconnect-plan#SPEC-003-01@1' },
      terminal: true,
      rerunRecipe: {
        schemaVersion: 1,
        evaluator: 'plans:evaluate-spec-test-adequacy',
        selection: {
          planSlug: 'reconnect-plan',
          specId: 'SPEC-003-01',
          specRevision: 1,
          specFingerprint: 'sha256:spec-v1',
          evidence: expect.arrayContaining([
            { evidenceKind: 'coverage-census', evidenceRef: 'surface:reconnect' },
            { evidenceKind: 'counterexample', evidenceRef: 'counterexample:reconnect' },
          ]),
        },
        current: { supplied: false, fingerprints: [] },
        derivation: {
          kind: 'listSpecEvidence.currentness',
          classifier: 'classifySpecEvidenceCurrentness',
          unknownWhenMissing: true,
        },
      },
    });
    // 9 since P-002 added `disclosed-gap`. Deliberately a literal, not
    // ADEQUACY_CRITERIA.length — a derived count cannot catch an unintended criterion.
    expect(Object.keys(result.ratings)).toHaveLength(9);
    expect(result.ratings['correct-layer'].rating).toBe('pass');
    expect(result.ratings['execution-integrity'].rating).toBe('pass');
    for (const [criterion, rating] of Object.entries(result.ratings)) {
      expect(rating.evidence).toMatch(/surface:reconnect|counterexample:reconnect/);
      expect(rating.evidence).not.toMatch(
        /^Every bound proof dimension is current\.?$|^Bound proof was collected, not skipped, executed, and produced a successful outcome\.?$/,
      );
    }
    expect(result.ratings.traceability.evidence).toContain('kind=coverage-census');
    expect(result.ratings['execution-integrity'].evidence).toContain('testRunId=43');
    expect(result.ratings['plan-class-risk-floor'].evidence).toContain('coverageRungs=l3:true|l4:false');
  });

  it('requires an exact clause target for L3 coverage-rung credit', () => {
    const grade = (row: SpecEvidenceForAdequacy) => evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [row],
      classRef: 'plan-class-feature-ship',
    });

    const missingTarget = evidence();
    delete (missingTarget.details.adequacy as Record<string, unknown>).targeted;
    const missingResult = grade(missingTarget);
    expect(missingResult.ratings['plan-class-risk-floor'].rating).toBe('unknown');
    expect(missingResult.ratings['plan-class-risk-floor'].evidence).toContain('binding target does not identify the exact clause');
    expect(missingResult.ratings['plan-class-risk-floor'].suggestion).toContain('adequacy.targeted="SPEC-003-01"');

    const siblingResult = grade(evidence({
      details: { adequacy: { targeted: 'SPEC-003-02', coverageRungs: { l3: true } } },
    }));
    expect(siblingResult.ratings['plan-class-risk-floor'].rating).toBe('unknown');
    expect(siblingResult.ratings['plan-class-risk-floor'].evidence).toContain('binding target does not identify the exact clause');

    expect(grade(evidence()).ratings['plan-class-risk-floor'].rating).toBe('pass');

    const highRiskClause = clause({ behaviorClass: 'concurrency' });
    const gradeL4 = (row: SpecEvidenceForAdequacy) => evaluateSpecTestAdequacy({
      clause: highRiskClause,
      evidence: [row],
      classRef: 'plan-class-feature-ship',
    });
    const missingL4Target = gradeL4(evidence({
      details: { adequacy: { coverageRungs: { l4: true } } },
    }));
    expect(missingL4Target.ratings['plan-class-risk-floor'].rating).toBe('unknown');
    const siblingL4Target = gradeL4(evidence({
      details: { adequacy: { targeted: 'SPEC-003-02', coverageRungs: { l4: true } } },
    }));
    expect(siblingL4Target.ratings['plan-class-risk-floor'].rating).toBe('unknown');
    expect(gradeL4(evidence({
      details: { adequacy: { targeted: highRiskClause.specId, coverageRungs: { l4: true } } },
    })).ratings['plan-class-risk-floor'].rating).toBe('pass');
  });

  it('prints the bound run\'s ledger file and dirty-tree provenance beside its id', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence({
        evidenceRef: 'tests/claimed-file.test.ts — test-run: 43, at current HEAD.',
        testRunProvenance: {
          filePath: 'tests/actual-file.test.ts',
          commitSha: 'abc123',
          worktreeDirty: true,
        },
      })],
      classRef: 'plan-class-feature-ship',
    });
    const rendered = result.ratings['execution-integrity'].evidence;
    expect(rendered).toContain('testRunId=43');
    expect(rendered).toContain('testRunLedgerFile="tests/actual-file.test.ts"');
    expect(rendered).toContain('testRunLedgerCommit="abc123"');
    expect(rendered).toContain('testRunLedgerWorktreeDirty=true');
    expect(rendered).toContain('ref="tests/claimed-file.test.ts — test-run: 43"');
    expect(rendered.split(' Re-run plans:evaluate-spec-test-adequacy')[0]).not.toContain('at current HEAD');
  });

  it('summarizes large test-run case lists while retaining the exact bound case and run pointer', () => {
    const base = evidence();
    const passedCaseTitles = Array.from({ length: 100 }, (_, index) => `suite > case ${index}`);
    const row = evidence({
      testRunId: 43,
      testRunExecution: {
        status: 'pass',
        passed: 100,
        failed: 0,
        skipped: 0,
        collectionFailed: false,
        testLayer: 'integration',
        passedCaseTitles,
      },
      details: {
        adequacy: {
          ...((base.details.adequacy ?? {}) as Record<string, unknown>),
          testCases: [passedCaseTitles[42]],
        },
      },
    });
    const result = evaluateSpecTestAdequacy({ clause: clause(), evidence: [row], classRef: 'plan-class-feature-ship' });
    const rendered = Object.values(result.ratings).map((rating) => rating.evidence).join('\n');

    expect(rendered).toContain('testRunId=43');
    expect(rendered).toContain('passedCaseTitleCount":100');
    expect(rendered).toContain('"declared":["suite > case 42"],"passed":["suite > case 42"],"missing":[]');
    expect(rendered).not.toContain('passedCaseTitles');
    expect(rendered).not.toContain('suite > case 0');
    expect(rendered.length).toBeLessThan(JSON.stringify(passedCaseTitles).length * Object.keys(result.ratings).length);
  });

  it('does not treat a binder falsifiability attestation as a demonstrated negative control', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence()],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.falsifiability).toMatchObject({
      rating: 'unknown',
      suggestion: expect.stringContaining('successful ledger-backed mutation or counterexample'),
    });
    expect(result.ratings.falsifiability.evidence).toContain('Binder-attested falsifiable=true');
    expect(result.ratings.falsifiability.evidence).toContain('no mutation or counterexample binding is bound');
    expect(result.wouldBlock).toContain('falsifiability');
    expect(result.verdict).toBe('unknown');
  });

  it('points each rating to the exact evaluator replay in the card-level recipe', () => {
    const bound = evidence();
    const current: EvidenceCurrentInput[] = [
      {
        evidenceKind: bound.evidenceKind,
        evidenceRef: bound.evidenceRef,
        ...bound.fingerprints,
      },
    ];
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [bound],
      current,
      harness: 'papercusp',
      classRef: 'plan-class-feature-ship',
    });
    const recipe = result.scorecardDraft.rerunRecipe;
    expect(evaluatorArgsSchema.safeParse(recipe.args).success).toBe(true);
    expect(recipe.args.harness).toBe('papercusp');
    expect(recipe.args.current).toEqual([
      {
        evidenceKind: bound.evidenceKind,
        evidenceRef: bound.evidenceRef,
        ...bound.fingerprints,
      },
    ]);
    expect(recipe.args).toEqual(crossGenerationAuditProbeArgs(recipe));

    for (const criterion of ADEQUACY_CRITERIA) {
      expect(result.ratings[criterion].evidence).toContain(
        `Replay the shared scorecard rerunRecipe (plans:evaluate-spec-test-adequacy) once with its stored args; ` +
          `inspect rows[0].ratings[${JSON.stringify(criterion)}] against the current evidence state. ` +
          'This replay remeasures currentness at replay time, so freshness-dependent ratings may differ from the emitted card after evidence changes. ' +
          'It is not a historical as-of replay; grading-integrity audits reconstruct the emitted card using its creation-time snapshot.',
      );
      expect(result.ratings[criterion].evidence).not.toContain('with args=');
    }
  });

  it.each([
    ['test-run id', { evidenceRef: '/tmp/session-proof.log', coverageEvidenceRef: null, testRunId: 43 }, 'durable'],
    [
      'coverage evidence id',
      { evidenceRef: '/tmp/session-proof.log', coverageEvidenceRef: 42, testRunId: null },
      'durable',
    ],
    ['work-item ref', { evidenceRef: 'WI-10000512', coverageEvidenceRef: null, testRunId: null }, 'durable'],
    [
      'engineer-issue ref',
      { evidenceRef: 'EI-22595744337561241', coverageEvidenceRef: null, testRunId: null },
      'durable',
    ],
    ['feature ref', { evidenceRef: 'F-1234', coverageEvidenceRef: null, testRunId: null }, 'durable'],
    ['artifact ref', { evidenceRef: 'artifact:scorecard-42', coverageEvidenceRef: null, testRunId: null }, 'durable'],
    ['test-run ref', { evidenceRef: 'test-run:42', coverageEvidenceRef: null, testRunId: null }, 'durable'],
    [
      'durable file probe',
      { evidenceRef: 'test/reconnect.integration.ts#proof', coverageEvidenceRef: null, testRunId: null },
      'durable',
    ],
    [
      'temporary path',
      { evidenceRef: '/tmp/pui-counterexample.log', coverageEvidenceRef: null, testRunId: null },
      'ephemeral',
    ],
    ['bash command', { evidenceRef: 'bash -lc "run proof"', coverageEvidenceRef: null, testRunId: null }, 'ephemeral'],
    [
      'session-local marker',
      { evidenceRef: 'session-local:proof', coverageEvidenceRef: null, testRunId: null },
      'ephemeral',
    ],
    ['unanchored ref', { evidenceRef: 'surface:reconnect', coverageEvidenceRef: null, testRunId: null }, 'unknown'],
    // WI-10005325: a work-item id anchors only as the reference's leading token.
    [
      'leading work-item ref with prose',
      { evidenceRef: 'WI-2144847 terminal tree proof for AUTO-BAR-R-1', coverageEvidenceRef: null, testRunId: null },
      'durable',
    ],
    [
      'typed work-item ref',
      { evidenceRef: 'scorecard:EI-22595744337561241', coverageEvidenceRef: null, testRunId: null },
      'durable',
    ],
    [
      'chained typed work-item ref',
      { evidenceRef: 'testing:run :: WI-2144851 P-007 proof', coverageEvidenceRef: null, testRunId: null },
      'durable',
    ],
    [
      'tool-call work-item ref',
      { evidenceRef: 'work_items:get WI-3849 → comment 2026-09-05', coverageEvidenceRef: null, testRunId: null },
      'durable',
    ],
    [
      'hyphen-joined work-item thread ref',
      { evidenceRef: 'work-item-thread-WI-10000411#post-200196', coverageEvidenceRef: null, testRunId: null },
      'durable',
    ],
    [
      'parenthetical work-item mention',
      {
        evidenceRef: 'LIVE PLANE RE-VERIFICATION 2026-09-27 (su-f08bc8c5, WI-10002212) on the running operator',
        coverageEvidenceRef: null,
        testRunId: null,
      },
      'unknown',
    ],
    [
      'mid-sentence work-item mention',
      {
        evidenceRef: 'live: Jev timeouts 0/984 after the fix (WI-10005319)',
        coverageEvidenceRef: null,
        testRunId: null,
      },
      'unknown',
    ],
    [
      'work-item id after a prose word',
      { evidenceRef: 'Note: see WI-10005319 for details', coverageEvidenceRef: null, testRunId: null },
      'unknown',
    ],
    [
      'leading test file followed by prose',
      {
        evidenceRef: 'apps/operator/app/settings/agent/assemble-config.test.ts — 21 passed @ b97d892c71',
        coverageEvidenceRef: null,
        testRunId: null,
      },
      'durable',
    ],
    [
      'leading evidence file followed by prose',
      {
        evidenceRef: 'docs/evidence/pty-incident-census-2026-09-26.json — live census',
        coverageEvidenceRef: null,
        testRunId: null,
      },
      'durable',
    ],
  ] as const)('classifies %s evidence lineage as %s', (_label, over, expected) => {
    expect(classifySpecEvidenceLineage(over).lineage).toBe(expected);
  });

  // WI-6554700010008517: repo-relative durability is DERIVED (any relative path not under an ephemeral root), not a
  // hand-listed set of leading directories. Binding 36973 (relative reports/ path) graded unknown while 36974 (the
  // same file, absolute) graded durable.
  const ref = (evidenceRef: string) => ({ evidenceRef, coverageEvidenceRef: null, testRunId: null });
  it.each([
    ['a committed reports/ evidence file', 'reports/bug-audits/2026-10-11-p005-r5-current-build.json', 'durable'],
    ['a submodule-root file with a test anchor', 'papercusp-desktop/src-tauri/src/custom_protocol.rs#custom_protocol::tests::', 'durable'],
    ['a tracked .papercusp/reports file', '.papercusp/reports/portal-global-shortcuts-2026-09-06/summary.json', 'durable'],
    ['a gitignored scratchpad/ file', 'scratchpad/feature-change-audit-p004-final-ledger.md#fresh-census', 'unknown'],
    ['a gitignored .papercusp/scratch file', '.papercusp/scratch/6baa8-p005-census/census-0957-summary.json', 'unknown'],
    ['a gitignored glob root (coverage-*)', 'coverage-unit/coverage-final.json', 'unknown'],
    ['a gitignored glob root (scratch-*)', 'scratch-probe/out.json', 'unknown'],
    ['a host:port URL path', 'measured on 127.0.0.1:3170/api/health.json', 'unknown'],
    ['an absolute .papercusp/scratch file', '/home/u/repo/.papercusp/scratch/6baa8/census.json', 'unknown'],
    ['a relative tmp/ file', 'tmp/run-output.json', 'ephemeral'],
  ] as const)('classifies %s as %s', (_label, evidenceRef, expected) => {
    expect(classifySpecEvidenceLineage(ref(evidenceRef)).lineage).toBe(expected);
  });

  it('grades the relative and absolute spellings of one file identically (WI-6554700010008517)', () => {
    for (const rel of ['reports/bug-audits/a.json', 'scratchpad/a.json', '.papercusp/scratch/a.json', 'coverage/a.json']) {
      const abs = `/home/u/papercusp/${rel}`;
      expect(classifySpecEvidenceLineage(ref(abs)).lineage === 'durable', rel)
        .toBe(classifySpecEvidenceLineage(ref(rel)).lineage === 'durable');
    }
  });

  it('pins EPHEMERAL_EVIDENCE_ROOTS to every plain directory the repo .gitignore ignores', () => {
    const gitignore = readFileSync(fileURLToPath(new URL('../../../../../.gitignore', import.meta.url)), 'utf8');
    const ignoredDirs = [...new Set(gitignore.split('\n').map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
      .filter((l) => /^\/?[A-Za-z0-9_.@-]+\/?$/.test(l) && (l.endsWith('/') || l.startsWith('/')))
      .map((l) => l.replace(/^\/|\/$/g, '')))];
    // Positive control: the parser must see the roots this fix was written against, or the pin is vacuous.
    expect(ignoredDirs).toEqual(expect.arrayContaining(['scratchpad', 'node_modules', 'coverage']));
    expect(ignoredDirs.filter((d) => !EPHEMERAL_EVIDENCE_ROOTS.includes(d))).toEqual([]);
    for (const root of EPHEMERAL_EVIDENCE_ROOTS) {
      expect(classifySpecEvidenceLineage(ref(`${root}/evidence.json`)).lineage, root).not.toBe('durable');
      expect(classifySpecEvidenceLineage(ref(`/home/u/repo/${root}/evidence.json`)).lineage, root).not.toBe('durable');
    }
  });

  it('fails traceability and the overall verdict for ephemeral-only proof', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [
        evidence({ evidenceRef: '/tmp/pui-p001-counterexample-guard.log', coverageEvidenceRef: null, testRunId: null }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.traceability.rating).toBe('fail');
    expect(result.ratings.traceability.evidence).toContain('Ephemeral-only evidence');
    expect(result.ratings.traceability.evidence).toContain('lineage=ephemeral');
    expect(result.wouldBlock).toContain('traceability');
    expect(result.verdict).toBe('fail');
  });

  it('marks an otherwise complete but unanchored proof unknown', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence({ evidenceRef: 'surface:reconnect', coverageEvidenceRef: null, testRunId: null })],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.traceability.rating).toBe('unknown');
    expect(result.ratings.traceability.evidence).toContain('no durable rerun anchor');
    expect(result.wouldBlock).toContain('traceability');
    expect(result.verdict).toBe('unknown');
  });

  it('does not pass execution-integrity from author-attested booleans without a ledger reference', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [
        evidence({
          evidenceRef: 'packages/operator-core/lib/reconnect.integration.test.ts#targeted-counterexamples',
          coverageEvidenceRef: null,
          testRunId: null,
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['execution-integrity'].rating).toBe('unknown');
    expect(result.ratings['execution-integrity'].evidence).toContain(
      'no durable ledger reference',
    );
    expect(result.ratings['execution-integrity'].evidence).toContain('executed=true');
    expect(result.verdict).toBe('unknown');
  });

  it('matches bare case declarations to runner full names and explains diagnostic unmatched labels', () => {
    const selected = successfulTestBinding('selected.integration.test.ts', {
      testCases: ['suite > selected', 'suite > not-recorded'],
    });
    selected.testRunExecution!.passed = 1;
    selected.testRunExecution!.passedCaseTitles = ['outer > suite > selected'];

    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [selected],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['correct-layer'].rating).toBe('pass');
    expect(result.ratings['correct-layer'].evidence).toContain('"missing":["suite > not-recorded"]');
    expect(result.ratings['execution-integrity'].rating).toBe('pass');
    expect(result.ratings['execution-integrity'].evidence).toContain(
      'Unmatched adequacy.testCases labels remain visible in the per-run detail but do not invalidate execution-integrity for a non-skipped passing run',
    );
    expect(result.ratings['execution-integrity'].evidence).toContain(
      'a skipped ordinary run requires every declared case to have canonically passed',
    );
    expect(result.ratings['execution-integrity'].evidence).toContain(
      'correct-layer separately checks required-layer reachability using at least one corroborated declared case per required layer',
    );
  });

  it('accepts measured passing selections while rejecting skipped or unmatched selected cases', () => {
    const selected = successfulTestBinding('selected.integration.test.ts', { testCases: ['suite > selected'] });
    selected.testRunId = 20919771;
    selected.testRunExecution!.skipped = 165;
    const evaluate = () => evaluateSpecTestAdequacy({ clause: clause(), evidence: [selected], classRef: 'plan-class-feature-ship' });
    expect(evaluate().ratings['execution-integrity'].rating).toBe('pass');

    const bareDeclaration = successfulTestBinding('bare-selected.integration.test.ts', { testCases: ['selected'] });
    bareDeclaration.testRunExecution!.passedCaseTitles = ['suite > selected'];
    bareDeclaration.testRunExecution!.skipped = 71;
    expect(evaluateSpecTestAdequacy({ clause: clause(), evidence: [bareDeclaration], classRef: 'plan-class-feature-ship' })
      .ratings['execution-integrity'].rating).toBe('pass');

    // Neither an absent selected case nor a prefix of a real title is proof.
    selected.details.adequacy = { ...(selected.details.adequacy as object), testCases: ['suite > selected', 'suite > skipped'] };
    expect(evaluate().ratings['execution-integrity'].rating).toBe('fail');
    selected.details.adequacy = { ...(selected.details.adequacy as object), testCases: ['suite'] };
    expect(evaluate().ratings['execution-integrity'].rating).toBe('fail');
    selected.details.adequacy = { ...(selected.details.adequacy as object), testCases: [] };
    expect(evaluate().ratings['execution-integrity'].rating).toBe('fail');
    selected.details.adequacy = { ...(selected.details.adequacy as object), testCases: ['suite > selected'] };
    selected.testRunExecution!.passedCaseTitles = [];
    expect(evaluate().ratings['execution-integrity'].rating).toBe('fail');
  });

  it('retains collection and failure rejection even when all selected case titles passed', () => {
    for (const execution of [
      { collectionFailed: true },
      { failed: 1 },
      { status: 'fail' },
      { passed: 0 },
      { status: 'running' },
      { status: 'cancelled' },
      { status: 'skipped' },
    ]) {
      const selected = successfulTestBinding('selected.integration.test.ts', { testCases: ['suite > selected'] });
      Object.assign(selected.testRunExecution!, { skipped: 71 }, execution);
      const result = evaluateSpecTestAdequacy({ clause: clause(), evidence: [selected], classRef: 'plan-class-feature-ship' });
      expect(result.ratings['execution-integrity'].rating).not.toBe('pass');
    }
  });

  it('requires an exact selected mutant failure and execution of every claimed case when other cases skipped', () => {
    const selected = evidence({
      evidenceKind: 'mutation',
      testRunExecution: { status: 'fail', passed: 0, failed: 1, skipped: 88, collectionFailed: false },
      testRunProvenance: {
        filePath: 'selected.integration.test.ts', commitSha: 'abc123', worktreeDirty: false,
        mutationFailedCaseTitles: [DEFAULT_MUTATION_TEST_CASE],
      },
    });
    const evaluate = () => evaluateSpecTestAdequacy({ clause: clause(), evidence: [selected], classRef: 'plan-class-feature-ship' });
    expect(evaluate().ratings['execution-integrity'].rating).toBe('pass');
    selected.testRunProvenance!.mutationFailedCaseTitles = ['different failure'];
    expect(evaluate().ratings['execution-integrity'].rating).not.toBe('pass');
    selected.testRunProvenance!.mutationFailedCaseTitles = [DEFAULT_MUTATION_TEST_CASE];
    selected.details.adequacy = { ...(selected.details.adequacy as object), testCases: [DEFAULT_MUTATION_TEST_CASE, 'skipped selected case'] };
    expect(evaluate().ratings['execution-integrity'].rating).not.toBe('pass');
    // Legacy failure lines must not grant a scoped exception without measured titles.
    selected.testRunProvenance!.mutationFailedCaseTitles = undefined;
    expect(evaluate().ratings['execution-integrity'].rating).not.toBe('pass');
    selected.details.adequacy = { ...(selected.details.adequacy as object), testCases: [DEFAULT_MUTATION_TEST_CASE] };
    selected.testRunExecution!.passedCaseTitles = [DEFAULT_MUTATION_TEST_CASE];
    expect(evaluate().ratings['execution-integrity'].rating).not.toBe('pass');
  });

  it('uses test-run ledger skip counts instead of an unskipped binding attestation', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [
        evidence({
          evidenceKind: 'test',
          testRunId: 20846633,
          coverageEvidenceRef: null,
          testRunExecution: { status: 'pass', passed: 6, failed: 0, skipped: 2, collectionFailed: false },
          details: {
            adequacy: {
              collected: true,
              skipped: false,
              executed: true,
              outcome: 'passed',
            },
          },
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['execution-integrity'].rating).toBe('fail');
    expect(result.ratings['execution-integrity'].evidence).toContain(
      'testRunLedgerExecution={"status":"pass","passed":6,"failed":0,"skipped":2,"collectionFailed":false,"testLayer":"integration","passedCaseTitleCount":1}',
    );
    expect(result.ratings['execution-integrity'].evidence).not.toContain('passedCaseTitles');

    const unavailable = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence({ testRunExecution: null })],
      classRef: 'plan-class-feature-ship',
    });
    expect(unavailable.ratings['execution-integrity'].rating).toBe('unknown');
    expect(unavailable.ratings['execution-integrity'].evidence).toContain(
      'execution_details, so canonical status, counts, and case identities cannot be verified',
    );
  });

  it('names the measured execution failure and recommends the matching repair', () => {
    const skippedAndDirty = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence({
        id: 18250,
        evidenceKind: 'test',
        testRunId: 20369821,
        coverageEvidenceRef: null,
        testRunExecution: {
          status: 'pass',
          passed: 1,
          failed: 0,
          skipped: 67,
          collectionFailed: false,
          testLayer: 'integration',
          passedCaseTitles: [],
        },
        testRunProvenance: {
          filePath: 'packages/operator-core/lib/harness/improvements/digest.test.ts',
          commitSha: '22a41ff6e9',
          worktreeDirty: true,
        },
        details: {
          adequacy: {
            collected: true,
            skipped: false,
            executed: true,
            outcome: 'passed',
          },
        },
      })],
      classRef: 'plan-class-feature-ship',
    });
    const skippedRating = skippedAndDirty.ratings['execution-integrity'];
    expect(skippedRating.rating).toBe('fail');
    expect(skippedRating.evidence).toContain('binding 18250 / run 20369821');
    expect(skippedRating.evidence).toContain('predicate=skipped>0 without complete measured case scope');
    expect(skippedRating.evidence).toContain('skipped=67');
    expect(skippedRating.evidence).toContain('passedCaseTitleCount=0');
    expect(skippedRating.evidence).toContain('worktreeDirty=true');
    expect(skippedRating.suggestion).toContain('remove -t');
    expect(skippedRating.suggestion).toContain('clean worktree');
    expect(skippedRating.suggestion).not.toContain('Ledger row required');

    const collectionFailed = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence({
        evidenceKind: 'test',
        testRunId: 20369822,
        coverageEvidenceRef: null,
        testRunExecution: {
          status: 'pass',
          passed: 1,
          failed: 0,
          skipped: 0,
          collectionFailed: true,
          testLayer: 'integration',
        },
      })],
      classRef: 'plan-class-feature-ship',
    }).ratings['execution-integrity'];
    expect(collectionFailed.suggestion).toContain('Fix test collection errors');
    expect(collectionFailed.suggestion).not.toContain('Ledger row required');

    const failedCase = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence({
        evidenceKind: 'test',
        testRunId: 20369823,
        coverageEvidenceRef: null,
        testRunExecution: {
          status: 'fail',
          passed: 0,
          failed: 1,
          skipped: 0,
          collectionFailed: false,
          testLayer: 'integration',
        },
      })],
      classRef: 'plan-class-feature-ship',
    }).ratings['execution-integrity'];
    expect(failedCase.suggestion).toContain('Fix the failing test case(s)');
    expect(failedCase.suggestion).not.toContain('Ledger row required');
  });

  it('uses canonical test-run status and counts instead of binder execution claims', () => {
    const contradictoryCounts = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence({
        evidenceKind: 'test',
        coverageEvidenceRef: null,
        testRunExecution: {
          status: 'pass', passed: 1, failed: 1, skipped: 0, collectionFailed: false,
        },
        details: { adequacy: { collected: true, skipped: false, executed: true, outcome: 'passed' } },
      })],
      classRef: 'plan-class-feature-ship',
    });
    expect(contradictoryCounts.ratings['execution-integrity'].rating).toBe('fail');
    expect(contradictoryCounts.ratings['execution-integrity'].evidence).toContain('"failed":1');

    const binderSaysFail = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence({
        evidenceKind: 'test',
        coverageEvidenceRef: null,
        details: { adequacy: { collected: false, skipped: true, executed: false, outcome: 'failed' } },
      })],
      classRef: 'plan-class-feature-ship',
    });
    expect(binderSaysFail.ratings['execution-integrity'].rating).toBe('pass');

    const coverageOnly = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence({ evidenceKind: 'test', testRunId: null, coverageEvidenceRef: 42 })],
      classRef: 'plan-class-feature-ship',
    });
    expect(coverageOnly.ratings['execution-integrity'].rating).toBe('unknown');
  });

  it('explains a canonical failed counterexample despite successful binder attestations', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence({
        evidenceKind: 'counterexample',
        coverageEvidenceRef: null,
        testRunExecution: {
          status: 'fail', passed: 13, failed: 1, skipped: 0, collectionFailed: false,
        },
        details: { adequacy: { collected: true, skipped: false, executed: true, outcome: 'caught', falsifiable: true } },
      })],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings['execution-integrity'].rating).toBe('fail');
    expect(result.ratings.falsifiability.evidence).toContain(
      'canonical execution=fail for counterexample: status=fail, passed=13, failed=1, skipped=0, collectionFailed=false',
    );
    expect(result.ratings.falsifiability.evidence).not.toContain('no unmet conjunct identified');
  });

  it('does not let a ledger-backed sibling hide an unbacked executable binding', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [
        evidence({ evidenceRef: 'test/reconnect.integration.ts#recorded', coverageEvidenceRef: 42, testRunId: null }),
        evidence({
          evidenceRef: 'test/reconnect.integration.ts#attested-only',
          coverageEvidenceRef: null,
          testRunId: null,
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['execution-integrity'].rating).toBe('unknown');
    expect(result.ratings['execution-integrity'].evidence).toContain('attested-only');
    expect(result.verdict).toBe('unknown');
  });

  it('surfaces a provisional scorecard proof base in every criterion evidence string', () => {
    const result = evaluateSpecTestAdequacy({
      clause: caseScopedClause(),
      evidence: [
        evidence({
          provisionalProofBase: true,
          provisionalScorecard: {
            issueId: 'EI-123',
            stampedAt: '2026-08-20T17:09:00.000Z',
            violatableKeys: ['criterion-a'],
          },
        }),
        caseScopedTestBinding(),
        caseScopedNegativeEvidence({
          provisionalProofBase: true,
          provisionalScorecard: {
            issueId: 'EI-123',
            stampedAt: '2026-08-20T17:09:00.000Z',
            violatableKeys: ['criterion-a'],
          },
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.verdict).toBe('pass');
    for (const criterion of ADEQUACY_CRITERIA) {
      expect(result.ratings[criterion].evidence).toContain('provisionalProofBase=true');
      expect(result.ratings[criterion].evidence).toContain('EI-123');
    }
  });

  it('emits a submittable get-specs probe for the declared required layer when evidence is missing', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [
        evidence({
          details: {
            adequacy: {
              testLayer: 'unit',
              pathReachable: true,
            },
          },
        }),
      ],
      harness: 'papercusp',
      classRef: 'plan-class-feature-ship',
    });
    const correctLayerEvidence = result.ratings['correct-layer'].evidence;

    expect(correctLayerEvidence).toContain(
      'Probe plans:get-specs with args={"harness":"papercusp","slug":"reconnect-plan","specIds":["SPEC-003-01"]}; inspect specs[0].requiredTestLayers.',
    );
    expect(correctLayerEvidence).toContain('expected ["integration"]');
    expect(correctLayerEvidence).not.toContain('Probe plans:get-spec-evidence');
    expect(correctLayerEvidence).not.toMatch(/\b(planSlug|specId|specRevision|specFingerprint)=/);
  });

  it('requires targeted L4 for high-risk, bugfix, migration, and mutation-required clauses', () => {
    expect(requiredProofFloor(clause({ behaviorClass: 'authorization' }), 'plan-class-feature-ship')).toBe('l4');
    expect(requiredProofFloor(clause(), 'plan-class-bugfix')).toBe('l4');
    expect(requiredProofFloor(clause(), 'plan-class-migration')).toBe('l4');
    expect(requiredProofFloor(clause({ mutationRequired: true }), 'plan-class-feature-ship')).toBe('l4');

    const result = evaluateSpecTestAdequacy({
      clause: clause({ behaviorClass: 'concurrency' }),
      evidence: [evidence()],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.verdict).toBe('fail');
    expect(result.ratings['plan-class-risk-floor']).toMatchObject({ rating: 'fail' });
    expect(result.wouldBlock).toContain('plan-class-risk-floor');
  });

  it('does not assign an executable proof floor to the canonical non-code task kind', () => {
    const nonCodeClause = clause({
      behaviorClass: 'lifecycle',
      requiredTestLayers: ['integration'],
      mutationRequired: true,
    });

    expect(isNonCodeWorkItemKind(' TASK ')).toBe(true);
    expect(requiredProofFloor(nonCodeClause, 'plan-class-bugfix', 'task')).toBe('none');
    expect(requiredProofFloor(nonCodeClause, 'plan-class-bugfix', 'change')).toBe('l4');

    const result = evaluateSpecTestAdequacy({
      clause: nonCodeClause,
      evidence: [],
      classRef: 'plan-class-bugfix',
      workItemKind: 'task',
    });
    expect(result.requiredProofFloor).toBe('none');
    expect(result.ratings['plan-class-risk-floor'].rating).toBe('not-applicable');
  });

  it('accepts exact targeted mutation proof and only a justified current approved L4 waiver', () => {
    const highRisk = clause({ behaviorClass: 'concurrency' });
    const testPath = 'packages/operator-core/lib/agent-tools/plans/high-risk.integration.test.ts';
    const mutation = evidence({
      evidenceKind: 'mutation',
      evidenceRef: 'mutant:drop-dedupe',
      testRunProvenance: { filePath: testPath, commitSha: 'abc123', worktreeDirty: false },
      details: {
        adequacy: {
          falsifiable: true,
          oracleIndependent: true,
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'killed',
          targeted: 'spec-003-01',
          coverageRungs: { l3: true },
        },
      },
    });
    const proved = evaluateSpecTestAdequacy({
      clause: highRisk,
      evidence: [evidence(), successfulTestBinding(testPath), mutation],
      classRef: 'plan-class-feature-ship',
    });
    expect(proved.ratings['plan-class-risk-floor'].rating).toBe('pass');
    expect(proved.ratings['plan-class-risk-floor'].evidence).toContain('L4 risk floor is met via');
    expect(proved.ratings['plan-class-risk-floor'].evidence).toContain(
      'clause-bound mutation/counterexample evidence with a passing baseline case',
    );
    expect(proved.ratings['plan-class-risk-floor'].evidence).toContain('coverageRungs=l3:true');
    expect(proved.ratings.falsifiability.rating).toBe('pass');

    const waived = evaluateSpecTestAdequacy({
      clause: clause({
        behaviorClass: 'concurrency',
        exemption: {
          testAdequacyWaivers: {
            l4: {
              justification: 'The external transport cannot be mutated in this environment.',
              approvalRef: 'D-099',
              expiresAt: '2026-09-01T00:00:00.000Z',
            },
          },
        },
      }),
      evidence: [evidence()],
      classRef: 'plan-class-feature-ship',
      now: new Date('2026-08-20T00:00:00.000Z'),
    });
    expect(waived.ratings['plan-class-risk-floor']).toMatchObject({ rating: 'waived' });
    expect(waived.ratings.falsifiability.rating).toBe('unknown');
    expect(waived.verdict).toBe('unknown');

    const expired = evaluateSpecTestAdequacy({
      clause: clause({
        behaviorClass: 'concurrency',
        exemption: {
          testAdequacyWaivers: {
            l4: {
              justification: 'The external transport cannot be mutated in this environment.',
              approvalRef: 'D-099',
              expiresAt: '2026-08-19T00:00:00.000Z',
            },
          },
        },
      }),
      evidence: [evidence()],
      classRef: 'plan-class-feature-ship',
      now: new Date('2026-08-20T00:00:00.000Z'),
    });
    expect(expired.ratings['plan-class-risk-floor'].rating).toBe('fail');
  });

  it('counts a mutation probe only when it targets a declared clause scenario', () => {
    const testPath = 'packages/operator-core/lib/agent-tools/plans/promotion-readable.integration.test.ts';
    const mutation = evidence({
      evidenceKind: 'mutation',
      evidenceRef: 'mutation-probe:drop-dedupe:caught',
      testRunProvenance: { filePath: testPath, commitSha: 'abc123', worktreeDirty: false },
      details: {
        adequacy: {
          falsifiable: true,
          oracleIndependent: true,
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'caught',
          targeted: 'promotion-readable',
          scenarioIds: ['promotion-readable'],
          testCases: [DEFAULT_MUTATION_TEST_CASE],
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause({
        behaviorClass: 'concurrency',
        falsifier: {
          observation: 'The promoted directive cannot be read from the open standing state.',
          requiredScenarios: ['promotion-readable', 'refused-transition-preserved'],
        },
      }),
      evidence: [evidence(), successfulTestBinding(testPath), mutation],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['plan-class-risk-floor'].rating).toBe('pass');
    expect(result.ratings.falsifiability.rating).toBe('pass');
    expect(result.ratings['execution-integrity'].rating).toBe('pass');
  });

  it('pairs exact and lowercase self-clause targets with the same measured mutation case', () => {
    const testPath = 'packages/operator-core/lib/agent-tools/search/report-source.integration.test.ts';
    const mutationFor = (id: number, targeted: string) => negativeEvidence({
      id,
      evidenceKind: 'mutation',
      evidenceRef: 'test-run 21169433 mutation-probe mutant fail report-source.integration.test.ts',
      testRunId: 21169433,
      testRunProvenance: {
        filePath: testPath,
        commitSha: 'abc123',
        worktreeDirty: false,
        source: 'mutation-probe',
        mutationPhase: 'mutant',
        mutationFailureLines: [`${DEFAULT_MUTATION_TEST_CASE}: expected true to be false`],
        mutationFailedCaseTitles: [DEFAULT_MUTATION_TEST_CASE],
      },
      details: {
        adequacy: {
          targeted,
          outcome: 'caught',
          collected: true,
          skipped: false,
          executed: true,
        },
      },
    });
    const baseline = successfulTestBinding(testPath);
    const exactTarget = mutationFor(40095, 'SPEC-003-01');
    const singleTarget = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [baseline, exactTarget],
      classRef: 'plan-class-feature-ship',
    });
    expect(singleTarget.ratings.falsifiability.rating).toBe('pass');
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [baseline, exactTarget, mutationFor(40096, 'spec-003-01')],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.falsifiability.rating).toBe('pass');
    expect(result.ratings['plan-class-risk-floor'].rating).toBe('pass');
  });

  describe('explicit shared-run scenario case associations', () => {
    const testPath = 'packages/operator-core/lib/dao-hr/hiring.integration.test.ts';
    const cases = ['hiring requirements > missing offer amount is refused', 'hiring requirements > missing currency is refused'];
    const targets = ['missing-amount', 'missing-currency'];
    const scenarioClause = () => clause({ falsifier: { observation: 'An incomplete offer is accepted.', requiredScenarios: targets } });
    const mutationFor = (index: number, testCases: string[]) => negativeEvidence({
      id: 40101 + index,
      evidenceKind: 'mutation',
      evidenceRef: 'test-run 21169434 mutation-probe mutant fail hiring.integration.test.ts',
      testRunId: 21169434,
      testRunProvenance: {
        filePath: testPath, commitSha: 'abc123', worktreeDirty: false,
        source: 'mutation-probe', mutationPhase: 'mutant', mutationFailedCaseTitles: cases,
        mutationFailureLines: cases.map(title => `${title}: expected refusal`),
      },
      details: { adequacy: { targeted: targets[index], scenarioIds: [targets[index]], testCases,
        outcome: 'caught', collected: true, skipped: false, executed: true } },
    });
    const evaluate = (mutations: SpecEvidenceForAdequacy[]) => evaluateSpecTestAdequacy({
      clause: scenarioClause(), evidence: [successfulTestBinding(testPath, { testCases: cases }), ...mutations],
      classRef: 'plan-class-feature-ship',
    });

    it('keeps declared case and scenario metadata confined to each mutation target', () => {
      const rows = activeSpecEvidence(targets.map((_, index) => mutationFor(index, [cases[index]!])));
      expect(rows.map(row => row.details.adequacy)).toEqual(targets.map((target, index) => expect.objectContaining({
        targeted: target, scenarioIds: [target], testCases: [cases[index]],
      })));
    });

    it('credits exact declared colon-free cases with measured failures and passing baselines', () => {
      const result = evaluate(targets.map((_, index) => mutationFor(index, [cases[index]!])));
      expect(result.ratings.falsifiability.rating, result.ratings.falsifiability.evidence).toBe('pass');
      expect(result.ratings.falsifiability.evidence).toContain('id=40101');
      expect(result.ratings.falsifiability.evidence).toContain('id=40102');
    });

    it('refuses a measured case declared for different targets on the shared run', () => {
      const result = evaluate([mutationFor(0, [cases[0]!]), mutationFor(1, [cases[0]!])]);
      expect(result.ratings.falsifiability.rating).not.toBe('pass');
    });

    it('does not rescue ambiguous explicit mappings through the legacy colon fallback', () => {
      const colonCase = 'hiring requirements > missing-amount: offer amount is refused';
      const rows = targets.map((_, index) => mutationFor(index, [colonCase]));
      rows.forEach(row => { row.testRunProvenance!.mutationFailedCaseTitles = [colonCase]; });
      const result = evaluateSpecTestAdequacy({ clause: scenarioClause(),
        evidence: [successfulTestBinding(testPath, { testCases: [colonCase] }), ...rows],
        classRef: 'plan-class-feature-ship' });
      expect(result.ratings.falsifiability.rating).not.toBe('pass');
    });

    it('recognizes the canonical full-title joiner in explicit associations', () => {
      const rows = targets.map((_, index) => mutationFor(index, [cases[index]!.replace(' > ', ' ')]));
      const result = evaluate(rows);
      expect(result.ratings.falsifiability.rating, result.ratings.falsifiability.evidence).toBe('pass');
    });

    it.each(['unmeasured', 'off-scenario', 'missing-baseline'] as const)('refuses an explicit %s association', mode => {
      const rows = targets.map((_, index) => mutationFor(index, [cases[index]!]));
      if (mode === 'unmeasured') rows.forEach(row => { row.testRunProvenance!.mutationFailedCaseTitles = ['another failed case']; });
      if (mode === 'off-scenario') rows.forEach(row => { (row.details.adequacy as Record<string, unknown>).targeted = 'unregistered'; });
      const baseline = successfulTestBinding(testPath, { testCases: mode === 'missing-baseline' ? ['another passing case'] : cases });
      const result = evaluateSpecTestAdequacy({ clause: scenarioClause(), evidence: [baseline, ...rows], classRef: 'plan-class-feature-ship' });
      expect(result.ratings.falsifiability.rating).not.toBe('pass');
    });
  });

  it('preserves same-run mutation targets and credits only the measured scenario case', () => {
    const testPath = 'packages/operator-core/lib/dao-hr/work-profile.integration.test.ts';
    const evidenceRef = 'test-run 21094686 mutation-probe mutant fail packages/operator-core/lib/dao-hr/work-profile.integration.test.ts @484a585cc8a6+dirty';
    const employeeCase = 'SPEC-P-002-C — a saved profile reloads unchanged > employee: every field round-trips';
    const contractorCase = 'SPEC-P-002-C — a saved profile reloads unchanged > contractor: every field round-trips';
    const mutationFor = (id: number, targeted: string) => {
      const mutation = negativeEvidence({
        id,
        workItemId: 'WI-6554700010008608',
        evidenceKind: 'mutation',
        evidenceRef,
        testRunId: 21094686,
      });
      mutation.testRunProvenance = {
        ...mutation.testRunProvenance!,
        filePath: testPath,
        source: 'mutation-probe',
        mutationPhase: 'mutant',
        mutationFailureLines: [`${employeeCase}: expected jurisdiction to retain its original case`],
        mutationFailedCaseTitles: [employeeCase],
      };
      mutation.details = {
        ...mutation.details,
        adequacy: {
          ...((mutation.details.adequacy ?? {}) as Record<string, unknown>),
          targeted,
          outcome: 'caught',
        },
      };
      // This exercises the legacy title convention without an explicit mapping.
      delete (mutation.details.adequacy as Record<string, unknown>).testCases;
      return mutation;
    };
    const baseline = successfulTestBinding(testPath, { testCases: [employeeCase, contractorCase] });
    baseline.id = 37600;
    baseline.testRunId = 21094671;
    baseline.evidenceRef = testPath;
    const employeeMutation = mutationFor(37603, 'employee');
    const contractorMutation = mutationFor(37604, 'contractor');
    const scenarioClause = clause({
      falsifier: {
        observation: 'A saved work profile reloads with a changed or missing field.',
        requiredScenarios: ['contractor', 'employee'],
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: scenarioClause,
      evidence: [baseline, employeeMutation, contractorMutation],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.traceability.evidence).toContain('id=37603');
    expect(result.ratings.traceability.evidence).toContain('id=37604');
    expect(result.ratings.falsifiability.rating).toBe('pass');
    expect(result.ratings.falsifiability.evidence).toContain('id=37603');
    expect(result.ratings.falsifiability.evidence).not.toContain('id=37604');
    expect(result.scorecardDraft.rerunRecipe.args.bindingIds).toEqual([37600, 37603, 37604]);
  });

  it('fails closed when mutation binding details point to a different canonical test run and file', () => {
    const canonicalPath = 'packages/operator-core/lib/agent-tools/plans/reproducibility.test.ts';
    const claimedPath = 'packages/operator-core/lib/agent-tools/plans/capability-ablations.test.ts';
    const mutationFor = (detailsRunId: number, detailsPath: string) => evidence({
      evidenceKind: 'mutation',
      evidenceRef: `test-run ${detailsRunId} mutation-probe mutant fail ${detailsPath} @abc123`,
      testRunId: 21147093,
      testRunProvenance: {
        filePath: canonicalPath,
        commitSha: 'abc123',
        worktreeDirty: false,
        mutationFailureLines: [`${DEFAULT_MUTATION_TEST_CASE}: recorded failed assertion`],
      },
      details: {
        testRun: { id: detailsRunId, filePath: detailsPath },
        adequacy: {
          falsifiable: true,
          oracleIndependent: true,
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'caught',
          targeted: 'promotion-readable',
          scenarioIds: ['promotion-readable'],
          testCases: [DEFAULT_MUTATION_TEST_CASE],
        },
      },
    });
    const grade = (mutation: SpecEvidenceForAdequacy) => evaluateSpecTestAdequacy({
      clause: clause({
        behaviorClass: 'concurrency',
        falsifier: {
          observation: 'The promoted directive cannot be read from the open standing state.',
          requiredScenarios: ['promotion-readable', 'refused-transition-preserved'],
        },
      }),
      evidence: [evidence(), successfulTestBinding(canonicalPath), mutation],
      classRef: 'plan-class-feature-ship',
    });

    const consistent = grade(mutationFor(21147093, canonicalPath));
    expect(consistent.ratings.falsifiability.rating).toBe('pass');
    expect(consistent.ratings['plan-class-risk-floor'].rating).toBe('pass');

    const mismatched = grade(mutationFor(21147118, claimedPath));
    expect(mismatched.ratings.falsifiability.rating).not.toBe('pass');
    expect(mismatched.ratings['plan-class-risk-floor'].rating).not.toBe('pass');
    expect(mismatched.ratings.falsifiability.evidence).toContain('details.testRun.id=21147118');
  });

  it('requires the measured mutation failed case to exactly match a successful same-clause testCases entry', () => {
    const testPath = 'packages/operator-core/lib/bash-substitution/pairs/code-search.test.ts';
    const failedCaseTitle = 'code-search.callers-lookup';
    const successfulTest = (testCases: string[]) => {
      return successfulTestBinding(testPath, { testCases });
    };
    const mutation = evidence({
      evidenceKind: 'mutation',
      evidenceRef: 'mutation-probe:callers-lookup:caught',
      testRunProvenance: {
        filePath: testPath,
        commitSha: 'abc123',
        worktreeDirty: false,
        mutationFailureLines: [`${failedCaseTitle}: expected true to be false`],
      },
      details: {
        adequacy: {
          falsifiable: true,
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'caught',
          targeted: RECONNECT_FALSIFIER_SCENARIO,
          scenarioIds: [RECONNECT_FALSIFIER_SCENARIO],
          testCases: [failedCaseTitle],
        },
      },
    });
    const input = {
      clause: caseScopedClause(),
      classRef: 'plan-class-feature-ship' as const,
    };
    // Remove the independent coverage-census L3 rung so these assertions isolate whether the
    // mutation itself establishes the risk floor.
    const noCoverageCensus = evidence({ coverageEvidenceRef: null });

    const siblingCase = evaluateSpecTestAdequacy({
      ...input,
      evidence: [noCoverageCensus, successfulTest(['code-search.definition-lookup']), mutation],
    });
    expect(siblingCase.ratings.falsifiability.rating).toBe('unknown');
    expect(siblingCase.ratings.falsifiability.evidence).toContain(failedCaseTitle);
    expect(siblingCase.ratings.falsifiability.suggestion).toContain('adequacy.testCases');
    expect(siblingCase.ratings['plan-class-risk-floor'].rating).toBe('unknown');
    expect(siblingCase.verdict).not.toBe('pass');

    const exactCase = evaluateSpecTestAdequacy({
      ...input,
      evidence: [noCoverageCensus, successfulTest([failedCaseTitle]), mutation],
    });
    expect(exactCase.ratings.falsifiability.rating).toBe('pass');
    expect(exactCase.ratings['plan-class-risk-floor'].rating).toBe('pass');

    // WI-10006745: an earlier same-clause same-file binding with no testCases must not shadow a
    // later one that declares the measured case (the evaluator used to inspect only the first).
    const shadowedByOlderBinding = evaluateSpecTestAdequacy({
      ...input,
      evidence: [evidence(), successfulTestBinding(testPath), successfulTest([failedCaseTitle]), mutation],
    });
    expect(shadowedByOlderBinding.ratings.falsifiability.rating).toBe('pass');
  });

  it('pairs exact Cargo source-case receipts with measured legacy mutation files without crediting siblings', () => {
    const testPath = 'crates/core/tests/client_test.rs';
    const caseTitle = 'plans_list_tolerates_null_status';
    const measured = (path: string, rootHarnessSlug?: string) => ({
      schemaVersion: 1, kind: 'repo-files', sourcePaths: ['crates/core/src/client.rs'],
      testPaths: [path], ...(rootHarnessSlug ? { rootHarnessSlug } : {}),
    });
    const mutation = evidence({
      evidenceKind: 'mutation',
      testRunProvenance: {
        filePath: `crates/core::${caseTitle}`, commitSha: 'abc123', worktreeDirty: false,
        mutationFailedCaseTitles: [caseTitle],
      },
      details: {
        currentMeasurement: measured(testPath),
        adequacy: { collected: true, executed: true, skipped: false, outcome: 'killed',
          targeted: 'spec-003-01', testCases: [caseTitle] },
      },
    });
    const baseline = successfulTestBinding(`${testPath}::${caseTitle}`, { testCases: [caseTitle] });
    const evaluate = (test = baseline, mutant = mutation) => evaluateSpecTestAdequacy({
      clause: clause(), evidence: [test, mutant], classRef: 'plan-class-feature-ship',
    }).ratings.falsifiability.rating;
    expect(evaluate()).toBe('pass');
    expect(evaluate(baseline, { ...mutation, testRunProvenance: {
      ...mutation.testRunProvenance!, filePath: testPath,
    } })).toBe('pass');
    expect(evaluate(baseline, { ...mutation, testRunProvenance: {
      ...mutation.testRunProvenance!, filePath: `${testPath}::${caseTitle}`,
    } })).toBe('pass');
    expect(evaluate(successfulTestBinding(`crates/core/tests/sibling.rs::${caseTitle}`, { testCases: [caseTitle] }))).toBe('unknown');
    expect(evaluate(successfulTestBinding(`${testPath}::another_case`, { testCases: ['another_case'] }))).toBe('unknown');
    expect(evaluate({ ...baseline, details: { ...baseline.details, currentMeasurement: measured(testPath, 'other-root') } })).toBe('unknown');
    expect(evaluate(baseline, { ...mutation, details: { ...mutation.details, currentMeasurement: measured('crates/other/tests/client_test.rs') } })).toBe('unknown');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace-only', '   '],
    ['surrounding whitespace', ' code-search.callers-lookup '],
    ['control character', 'code-search.callers-lookup' + String.fromCharCode(10)],
  ] as const)('fails closed when the measured mutation case title is %s', (_label, failedCaseTitle) => {
    const testPath = 'packages/operator-core/lib/bash-substitution/pairs/code-search.test.ts';
    const successfulTest = successfulTestBinding(testPath);
    successfulTest.details = {
      ...successfulTest.details,
      adequacy: {
        ...(successfulTest.details.adequacy as Record<string, unknown>),
        testCases: failedCaseTitle === undefined ? ['code-search.callers-lookup'] : [failedCaseTitle],
      },
    };
    const mutation = evidence({
      evidenceKind: 'mutation',
      evidenceRef: 'mutation-probe:callers-lookup:caught',
      testRunProvenance: {
        filePath: testPath,
        commitSha: 'abc123',
        worktreeDirty: false,
        ...(failedCaseTitle === undefined
          ? {}
          : { mutationFailureLines: [`${failedCaseTitle}: expected true to be false`] }),
      },
      details: {
        adequacy: {
          falsifiable: true,
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'caught',
          targeted: RECONNECT_FALSIFIER_SCENARIO,
        },
      },
    });
    const result = evaluateSpecTestAdequacy({
      clause: caseScopedClause(),
      evidence: [evidence(), successfulTest, mutation],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.falsifiability.rating).toBe('unknown');
    expect(result.verdict).not.toBe('pass');
  });

  it('does not credit a sibling-case mutation failure to this clause', () => {
    const testPath = 'test/promotion-readable.integration.test.ts';
    const failedCaseTitle = 'refused-transition-preserved';
    const mutation = evidence({
      evidenceKind: 'mutation',
      evidenceRef: 'mutation-probe:refused-transition:caught',
      testRunProvenance: {
        filePath: testPath,
        commitSha: 'abc123',
        worktreeDirty: false,
        mutationFailureLines: [`${failedCaseTitle}: expected true to be false`],
      },
      details: {
        adequacy: {
          falsifiable: true,
          oracleIndependent: true,
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'caught',
          targeted: 'refused-transition-preserved',
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause({
        behaviorClass: 'concurrency',
        falsifier: {
          observation: 'The promoted directive cannot be read from the open standing state.',
          requiredScenarios: ['promotion-readable'],
        },
      }),
      evidence: [evidence(), successfulTestBinding(testPath, { testCases: [failedCaseTitle] }), mutation],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.falsifiability.rating).toBe('unknown');
    expect(result.ratings.falsifiability.evidence).toContain('do not name a scenario declared in falsifier.requiredScenarios');
    expect(result.verdict).not.toBe('pass');
  });

  it('does not treat legacy boolean targeted=true as a clause-case link', () => {
    const mutation = evidence({
      evidenceKind: 'mutation',
      evidenceRef: 'mutation-probe:unscoped:caught',
      details: {
        adequacy: {
          falsifiable: true,
          oracleIndependent: true,
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'caught',
          targeted: true,
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause({
        behaviorClass: 'concurrency',
        falsifier: {
          observation: 'The promoted directive cannot be read from the open standing state.',
          requiredScenarios: ['promotion-readable'],
        },
      }),
      evidence: [evidence(), mutation],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.falsifiability.rating).toBe('unknown');
  });

  // WI-10002724: a clause declaring NO falsifier.requiredScenarios has no scenario id to name, so
  // a target naming its own specId is its clause-scoped claim.
  describe('clause without declared falsifier scenarios', () => {
    const testPath = 'packages/operator-core/lib/agent-tools/plans/spec-test-adequacy.integration.test.ts';
    const mutationTargeting = (targeted: boolean | string, specId = clause().specId) =>
      evidence({
        specId,
        evidenceKind: 'mutation',
        evidenceRef: `mutation-probe:self-target:${String(targeted)}`,
        testRunProvenance: { filePath: testPath, commitSha: 'abc123', worktreeDirty: false },
        details: {
          adequacy: {
            falsifiable: true,
            oracleIndependent: true,
            collected: true,
            skipped: false,
            executed: true,
            outcome: 'caught',
            targeted,
          },
        },
      });

    it('passes a mutation binding that targets the clause\'s own specId', () => {
      const result = evaluateSpecTestAdequacy({
        clause: clause(),
        evidence: [evidence(), successfulTestBinding(testPath), mutationTargeting('spec-003-01')],
        classRef: 'plan-class-feature-ship',
      });

      expect(clause().falsifier).toBeNull();
      expect(result.ratings.falsifiability.rating).toBe('pass');
      expect(result.ratings.falsifiability.evidence).toContain('which declares no structured falsifier.requiredScenarios list');
    });

    it('accepts measured same-clause proof for an observation without declared scenarios', () => {
      const targetClause = clause({
        falsifier: { observation: 'The promoted directive cannot be read from the open standing state.' },
      });
      expect(isAcceptedMutationTarget(targetClause, 'spec-003-01')).toBe(true);

      const result = evaluateSpecTestAdequacy({
        clause: targetClause,
        evidence: [evidence(), successfulTestBinding(testPath), mutationTargeting('spec-003-01')],
        classRef: 'plan-class-feature-ship',
      });

      expect(result.ratings.falsifiability.rating).toBe('pass');
      expect(result.ratings.falsifiability.evidence).toContain('which declares no structured falsifier.requiredScenarios list');
    });

    it('accepts the exact uppercase ID of a platform-generated clause as its self-target', () => {
      const specId = 'AUTO-BAR-R-5-P-004';
      const generatedClause = clause({ specId });
      const result = evaluateSpecTestAdequacy({
        clause: generatedClause,
        evidence: [
          evidence({ specId }),
          { ...successfulTestBinding(testPath), specId },
          mutationTargeting(specId, specId),
        ],
        classRef: 'plan-class-feature-ship',
      });

      expect(result.ratings.falsifiability.rating).toBe('pass');
    });

    it('accepts measured self-target proof when observation and probe declare no scenarios', () => {
      const result = evaluateSpecTestAdequacy({
        clause: clause({
          falsifier: {
            observation: 'At least one diagnosed failure lacks a measured outcome.',
            probeMethod: 'Compare diagnosed failures with the verification report.',
          },
        }),
        evidence: [evidence(), successfulTestBinding(testPath), mutationTargeting('spec-003-01')],
        classRef: 'plan-class-feature-ship',
      });

      expect(result.ratings.falsifiability.rating).toBe('pass');
      expect(result.ratings.falsifiability.evidence).toContain('which declares no structured falsifier.requiredScenarios list');
      expect(result.ratings.falsifiability.evidence).not.toContain('observation and probe method do not name scenarios');
      expect(result.ratings.falsifiability.evidence).not.toContain('declares no falsifier scenarios');
    });

    it('does not interpret prose examples as a declared scenario list', () => {
      const result = evaluateSpecTestAdequacy({
        clause: clause({
          falsifier: {
            observation: 'The returned refusal and stores are checked against each counterexample.',
            probeMethod: 'Try missing, wrong-workspace, wrong-goal, inaccessible, unresolved, retired/superseded and body-substituted references; then stale/future snapshots and changed source generation.',
          },
        }),
        evidence: [evidence(), successfulTestBinding(testPath), mutationTargeting('spec-003-01')],
        classRef: 'plan-class-feature-ship',
      });

      expect(result.ratings.falsifiability.rating).toBe('pass');
      expect(result.ratings.falsifiability.evidence).toContain('which declares no structured falsifier.requiredScenarios list');
      expect(result.ratings.falsifiability.evidence).not.toContain('observation and probe method do not name scenarios');
    });

    it('does not credit a mutation binding that targets a sibling spec', () => {
      const result = evaluateSpecTestAdequacy({
        clause: clause(),
        evidence: [evidence(), mutationTargeting('spec-003-02')],
        classRef: 'plan-class-feature-ship',
      });

      expect(result.ratings.falsifiability.rating).toBe('unknown');
      expect(result.ratings.falsifiability.evidence).toContain("do not target this clause's own specId");
      expect(result.ratings.falsifiability.suggestion).toContain("adequacy.targeted = 'SPEC-003-01'");
    });

    it('does not treat boolean targeted=true as the clause-scoped target', () => {
      const result = evaluateSpecTestAdequacy({
        clause: clause(),
        evidence: [evidence(), mutationTargeting(true)],
        classRef: 'plan-class-feature-ship',
      });

      expect(result.ratings.falsifiability.rating).toBe('unknown');
    });

    it('does not let a self-target bypass declared falsifier scenarios', () => {
      const result = evaluateSpecTestAdequacy({
        clause: clause({
          falsifier: {
            observation: 'The promoted directive cannot be read from the open standing state.',
            requiredScenarios: ['promotion-readable'],
          },
        }),
        evidence: [evidence(), mutationTargeting('spec-003-01')],
        classRef: 'plan-class-feature-ship',
      });

      expect(result.ratings.falsifiability.rating).toBe('unknown');
      expect(result.ratings.falsifiability.evidence).toContain('do not name a scenario declared in falsifier.requiredScenarios');
    });
  });

  it('does not accept a self-attested mutation target when its test file is not bound to the clause', () => {
    const targetClause = clause();
    const mutation = evidence({
      evidenceKind: 'mutation',
      evidenceRef: 'mutation-probe:r9-refusal:caught',
      testRunId: 700,
      testRunProvenance: {
        filePath: 'packages/operator-core/lib/agent-tools/plans/r9-refusal.integration.test.ts',
        commitSha: 'abc123',
        worktreeDirty: false,
      },
      details: {
        adequacy: {
          falsifiable: true,
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'caught',
          targeted: 'spec-003-01',
          coverageRungs: { l3: true, l4: false },
        },
      },
    });
    const unrelatedTestBinding = evidence({
      evidenceKind: 'test',
      evidenceRef: 'test-run:r8-materialization:passed',
      testRunId: 701,
      coverageEvidenceRef: null,
      testRunProvenance: {
        filePath: 'packages/operator-core/lib/agent-tools/plans/r8-materialization.integration.test.ts',
        commitSha: 'abc123',
        worktreeDirty: false,
      },
      details: {
        adequacy: {
          testLayer: 'integration',
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'passed',
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: targetClause,
      evidence: [unrelatedTestBinding, mutation],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.falsifiability.rating).toBe('unknown');
    expect(result.ratings['plan-class-risk-floor'].rating).toBe('unknown');
    expect(result.verdict).not.toBe('pass');
  });

  it.each(['evidencePlane', 'evidence_plane', 'plane'].flatMap((key) =>
    ['tree', 'live', 'deployed'].map((plane) => ({ key, plane })),
  ))('reads nested adequacy.$key=$plane for required planes and traceability', ({ key, plane }) => {
    const base = evidence();
    const proof = evidence({
      details: { adequacy: { ...(base.details.adequacy as object), [key]: plane } },
    });
    const target = clause({ requiredEvidence: [plane], requiredTestLayers: [] });
    const grade = (row: SpecEvidenceForAdequacy) => evaluateSpecTestAdequacy({
      clause: target, evidence: [row], classRef: 'plan-class-feature-ship',
    });
    const covered = grade(proof);
    expect(covered.ratings['correct-layer'].rating).toBe('not-applicable');
    expect(covered.ratings['correct-layer'].evidence).toContain('cover the required evidence plane(s)');
    expect(covered.ratings.traceability.evidence).toContain(`evidencePlane="${plane}"`);

    const stale = grade({ ...proof, currentness: { ...proof.currentness, overall: 'stale' } });
    expect(stale.ratings['correct-layer'].rating).toBe('fail');
    expect(stale.ratings['correct-layer'].evidence).toContain('Required evidence plane(s) are absent');
    expect(grade(base).ratings['correct-layer'].rating).toBe('fail');
    const mismatched = grade(evidence({
      details: { adequacy: { ...(base.details.adequacy as object), [key]: plane === 'tree' ? 'live' : 'tree' } },
    }));
    expect(mismatched.ratings['correct-layer'].rating).toBe('fail');
  });

  it('preserves an explicit root plane over conflicting nested adequacy metadata', () => {
    const proof = evidence({ details: { evidencePlane: 'tree', adequacy: { evidencePlane: 'live' } } });
    const result = evaluateSpecTestAdequacy({
      clause: clause({ requiredEvidence: ['live'], requiredTestLayers: [] }), evidence: [proof],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings['correct-layer'].rating).toBe('fail');
    expect(result.ratings.traceability.evidence).toContain('evidencePlane="tree"');
  });

  it('requires live evidence for a standalone clause that declares requiredEvidence live', () => {
    const liveClause = clause({ requiredEvidence: ['live'], requiredTestLayers: [] });
    const treeProof = evidence();
    const missing = evaluateSpecTestAdequacy({
      clause: liveClause,
      evidence: [treeProof],
      classRef: 'plan-class-feature-ship',
    });
    expect(missing.ratings['correct-layer'].rating).toBe('fail');
    expect(missing.ratings['correct-layer'].evidence).toContain('Required evidence plane(s) are absent');
    expect(missing.ratings['correct-layer'].suggestion).toContain('details.evidencePlane');
    expect(missing.ratings['correct-layer'].suggestion).toContain('environmentFingerprint');
    expect(missing.wouldBlock).toContain('correct-layer');

    const liveProof = evidence({
      evidenceRef: 'live:verified-report',
      details: { ...treeProof.details, evidencePlane: 'live' },
    });
    const staleLive = evaluateSpecTestAdequacy({
      clause: liveClause,
      evidence: [treeProof, { ...liveProof, currentness: { ...liveProof.currentness, overall: 'stale' } }],
      classRef: 'plan-class-feature-ship',
    });
    expect(staleLive.ratings['correct-layer'].rating).toBe('fail');

    const covered = evaluateSpecTestAdequacy({
      clause: liveClause,
      evidence: [treeProof, liveProof],
      classRef: 'plan-class-feature-ship',
    });
    expect(covered.ratings['correct-layer'].rating).toBe('not-applicable');
    expect(covered.ratings['correct-layer'].evidence).toContain('Current bindings cover the required evidence plane(s)');
    expect(covered.ratings['correct-layer'].evidence).toContain('ref="live:verified-report"');
  });

  it('requires tree evidence when binder-authored falsifiability targets a tree clause', () => {
    const testPath = 'packages/operator-core/lib/agent-tools/plans/tree-plane-proof.integration.test.ts';
    const scenarioId = 'missing-tree-tool-reported';
    const treeClause = clause({
      requiredEvidence: ['tree'],
      requiredTestLayers: [],
      falsifier: {
        observation: 'A verb missing from the agent-tools tree is reported.',
        requiredScenarios: [scenarioId],
      },
    });
    const mutation = evidence({
      evidenceKind: 'mutation',
      evidenceRef: 'mutation:tree-plane-proof',
      testRunProvenance: { filePath: testPath, commitSha: 'abc123', worktreeDirty: false },
      details: {
        adequacy: {
          ...((evidence().details.adequacy ?? {}) as Record<string, unknown>),
          targeted: scenarioId,
          scenarioIds: [scenarioId],
          testCases: [DEFAULT_MUTATION_TEST_CASE],
          outcome: 'killed',
          falsifiable: true,
          oracleIndependent: true,
        },
      },
    });
    const baseline = successfulTestBinding(testPath, {
      targeted: treeClause.specId,
      scenarioIds: [scenarioId],
      scenarioTestCases: { [scenarioId]: [DEFAULT_MUTATION_TEST_CASE] },
    });
    const missingTree = evaluateSpecTestAdequacy({
      clause: treeClause,
      evidence: [baseline, mutation],
      classRef: 'plan-class-feature-ship',
    });

    expect(missingTree.ratings.falsifiability.rating).toBe('pass');
    expect(missingTree.ratings['correct-layer'].rating).toBe('fail');
    expect(missingTree.ratings['correct-layer'].evidence).toContain('Required evidence plane(s) are absent');
    expect(missingTree.verdict).not.toBe('pass');

    const treeProof = evidence({
      evidenceKind: 'operational',
      evidenceRef: 'tree:measured-proof',
      testRunId: null,
      coverageEvidenceRef: null,
      details: { evidencePlane: 'tree' },
    });
    const covered = evaluateSpecTestAdequacy({
      clause: treeClause,
      evidence: [baseline, mutation, treeProof],
      classRef: 'plan-class-feature-ship',
    });
    expect(covered.ratings['correct-layer'].rating).toBe('pass');
  });

  it('names active non-mutation bindings when correct-layer is not applicable', () => {
    const activeTest = successfulTestBinding('packages/example/no-layer.test.ts');
    activeTest.id = 41696;
    const result = evaluateSpecTestAdequacy({
      clause: clause({ requiredEvidence: [], requiredTestLayers: [] }),
      evidence: [activeTest],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['correct-layer'].rating).toBe('not-applicable');
    expect(result.ratings['correct-layer'].evidence).toContain('no required test layer; layer reachability is not evaluated');
    expect(result.ratings['correct-layer'].evidence).toContain('id=41696');
    expect(result.ratings['correct-layer'].evidence).not.toContain('no bound evidence rows');
  });

  it('requires each canonical evidence kind declared by the exact clause revision', () => {
    const operationalClause = clause({ requiredEvidence: ['operational'], requiredTestLayers: [] });
    const wrongRevision = evidence({
      evidenceKind: 'operational',
      specRevision: 2,
      specFingerprint: 'sha256:other-spec',
    });
    const missing = evaluateSpecTestAdequacy({
      clause: operationalClause,
      evidence: [evidence({ evidenceKind: 'test' }), wrongRevision],
      classRef: 'plan-class-feature-ship',
    });
    expect(missing.ratings['correct-layer'].rating).toBe('fail');
    expect(missing.ratings['correct-layer'].evidence).toContain('Required evidence kind(s) are absent');
    expect(missing.ratings['correct-layer'].evidence).toContain('operational');
    expect(missing.wouldBlock).toContain('correct-layer');

    const covered = evaluateSpecTestAdequacy({
      clause: operationalClause,
      evidence: [evidence({ evidenceKind: 'operational' })],
      classRef: 'plan-class-feature-ship',
    });
    expect(covered.ratings['correct-layer'].rating).toBe('not-applicable');
    expect(covered.ratings['correct-layer'].evidence).toContain('cover the required evidence kind(s)');
  });

  it('accepts a ledger-backed mutant counterexample for an L3 floor', () => {
    const scenarioId = 'reject-future-window';
    const testPath = 'packages/operator-core/lib/agent-tools/plans/reject-future-window.integration.test.ts';
    const targetClause = clause({
      falsifier: {
        observation: 'A future event window is rejected.',
        requiredScenarios: [scenarioId],
      },
    });
    const counterexample = evidence({
      evidenceKind: 'counterexample',
      evidenceRef: 'counterexample:reject-future-window',
      testRunProvenance: {
        filePath: testPath,
        commitSha: 'abc123',
        worktreeDirty: false,
        source: 'mutation-probe',
        mutationPhase: 'mutant',
        mutationFailedCaseTitles: [DEFAULT_MUTATION_TEST_CASE],
      },
      testRunExecution: {
        status: 'fail',
        passed: 0,
        failed: 1,
        skipped: 0,
        collectionFailed: false,
        testLayer: 'integration',
      },
      details: {
        adequacy: {
          fixtureCalibrated: true,
          falsifiable: true,
          testLayer: 'integration',
          pathReachable: true,
          oracleIndependent: true,
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'pass',
          targeted: scenarioId,
          scenarioIds: [scenarioId],
          testCases: [DEFAULT_MUTATION_TEST_CASE],
        },
      },
    });

    const passingBinding = successfulTestBinding(testPath, {
      scenarioIds: [scenarioId],
      scenarioTestCases: { [scenarioId]: [DEFAULT_MUTATION_TEST_CASE] },
    });
    const result = evaluateSpecTestAdequacy({
      clause: targetClause,
      evidence: [passingBinding, counterexample],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.requiredProofFloor).toBe('l3');
    expect(result.ratings['plan-class-risk-floor']).toMatchObject({ rating: 'pass' });
    expect(result.ratings['plan-class-risk-floor'].evidence).toContain('counterexample:reject-future-window');
    expect(result.verdict).toBe('pass');
  });

  it('does not treat an ordinary passing run rebound as a counterexample as proof of falsifiability', () => {
    const testPath = 'packages/operator-core/lib/agent-tools/plans/plain-pass-counterexample.integration.test.ts';
    const caseTitle = 'rejects a malformed request';
    const counterexample = evidence({
      evidenceKind: 'counterexample',
      evidenceRef: 'counterexample:plain-pass',
      testRunProvenance: { filePath: testPath, commitSha: 'abc123', worktreeDirty: false },
      testRunExecution: {
        status: 'pass',
        passed: 1,
        failed: 0,
        skipped: 0,
        collectionFailed: false,
        testLayer: 'integration',
        passedCaseTitles: [caseTitle],
      },
      details: {
        testRun: { id: 43, source: 'local', status: 'pass', mutationPhase: null },
        adequacy: {
          falsifiable: true,
          testLayer: 'integration',
          pathReachable: true,
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'survived',
          targeted: 'spec-003-01',
          scenarioIds: ['reader-refuses-wrong-cached-edition'],
          testCases: [caseTitle],
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [successfulTestBinding(testPath, { testCases: [caseTitle] }), counterexample],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.falsifiability.rating).toBe('unknown');
    expect(result.ratings.falsifiability.evidence).toContain('Binder-attested falsifiable=true');
    expect(result.verdict).not.toBe('pass');
  });

  it('does not credit prepared counterexample metadata on an ordinary passing run', () => {
    const testPath = 'packages/operator-core/lib/agent-tools/plans/prepared-counterexample.integration.test.ts';
    const caseTitle = 'rejects a malformed request';
    const counterexample = evidence({
      evidenceKind: 'counterexample',
      evidenceRef: 'counterexample:prepared-pass',
      testRunProvenance: {
        filePath: testPath,
        commitSha: 'abc123',
        worktreeDirty: false,
        source: 'local',
        mutationPhase: null,
      },
      testRunExecution: {
        status: 'pass',
        passed: 1,
        failed: 0,
        skipped: 0,
        collectionFailed: false,
        testLayer: 'integration',
        passedCaseTitles: [caseTitle],
      },
      details: {
        testExecution: {
          binding: {
            counterexample: {
              test: 'rejects malformed requests',
              messageIncludes: 'invalid payload',
            },
          },
        },
        adequacy: {
          falsifiable: true,
          targeted: RECONNECT_FALSIFIER_SCENARIO,
          scenarioIds: [RECONNECT_FALSIFIER_SCENARIO],
          testCases: [caseTitle],
        },
      },
    });
    const result = evaluateSpecTestAdequacy({
      clause: caseScopedClause(),
      evidence: [successfulTestBinding(testPath, { testCases: [caseTitle] }), counterexample],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.falsifiability.rating).toBe('unknown');
    expect(result.verdict).not.toBe('pass');
  });

  it('does not credit legacy case names on an ordinary passing counterexample run', () => {
    const testPath = 'packages/operator-core/lib/agent-tools/plans/legacy-counterexample.integration.test.ts';
    const caseTitle = 'rejects a malformed request';
    const counterexample = evidence({
      evidenceKind: 'counterexample',
      evidenceRef: 'counterexample:legacy-pass',
      testRunProvenance: {
        filePath: testPath,
        commitSha: 'abc123',
        worktreeDirty: false,
        source: 'local',
        mutationPhase: null,
      },
      testRunExecution: {
        status: 'pass',
        passed: 1,
        failed: 0,
        skipped: 0,
        collectionFailed: false,
        testLayer: 'integration',
        passedCaseTitles: [caseTitle],
      },
      details: {
        adequacy: {
          falsifiable: true,
          targeted: RECONNECT_FALSIFIER_SCENARIO,
          scenarioIds: [RECONNECT_FALSIFIER_SCENARIO],
          testCases: [caseTitle],
        },
      },
    });
    const result = evaluateSpecTestAdequacy({
      clause: caseScopedClause(),
      evidence: [successfulTestBinding(testPath, { testCases: [caseTitle] }), counterexample],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.falsifiability.rating).toBe('unknown');
    expect(result.verdict).not.toBe('pass');
  });

  it('requires the exact measured failed counterexample case in its current passing baseline', () => {
    const testPath = 'packages/operator-core/lib/agent-tools/plans/counterexample-case-pair.integration.test.ts';
    const failedCaseTitle = 'rejects a malformed request';
    const mutant = evidence({
      evidenceKind: 'counterexample',
      evidenceRef: 'counterexample:mutant-case-pair',
      testRunProvenance: {
        filePath: testPath,
        commitSha: 'abc123',
        worktreeDirty: false,
        source: 'mutation-probe',
        mutationPhase: 'mutant',
        mutationFailedCaseTitles: [failedCaseTitle],
      },
      testRunExecution: {
        status: 'fail',
        passed: 0,
        failed: 1,
        skipped: 0,
        collectionFailed: false,
        testLayer: 'integration',
      },
      details: {
        adequacy: {
          falsifiable: true,
          targeted: RECONNECT_FALSIFIER_SCENARIO,
          scenarioIds: [RECONNECT_FALSIFIER_SCENARIO],
          testCases: [failedCaseTitle],
          outcome: 'caught',
        },
      },
    });
    const result = evaluateSpecTestAdequacy({
      clause: caseScopedClause(),
      evidence: [
        successfulTestBinding(testPath, { testCases: ['rejects an unrelated request'] }),
        mutant,
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.falsifiability.rating).toBe('unknown');
    expect(result.ratings.falsifiability.evidence).toContain('measured failed case is missing');
    expect(result.verdict).not.toBe('pass');
  });

  it('ignores caller-authored mutant metadata when the canonical ledger is an ordinary run', () => {
    const testPath = 'packages/operator-core/lib/agent-tools/plans/spoofed-counterexample.integration.test.ts';
    const caseTitle = 'rejects a malformed request';
    const counterexample = evidence({
      evidenceKind: 'counterexample',
      evidenceRef: 'counterexample:spoofed-ledger-details',
      testRunProvenance: {
        filePath: testPath,
        commitSha: 'abc123',
        worktreeDirty: false,
        source: 'local',
        mutationPhase: null,
        mutationFailureLines: [caseTitle + ': expected true to be false'],
        mutationFailedCaseTitles: [caseTitle],
      },
      testRunExecution: {
        status: 'fail',
        passed: 0,
        failed: 1,
        skipped: 0,
        collectionFailed: false,
        testLayer: 'integration',
      },
      details: {
        testRun: {
          id: 44,
          source: 'mutation-probe',
          status: 'fail',
          mutationPhase: 'mutant',
        },
        adequacy: {
          falsifiable: true,
          targeted: RECONNECT_FALSIFIER_SCENARIO,
          scenarioIds: [RECONNECT_FALSIFIER_SCENARIO],
          testCases: [caseTitle],
        },
      },
    });
    const result = evaluateSpecTestAdequacy({
      clause: caseScopedClause(),
      evidence: [successfulTestBinding(testPath, { testCases: [caseTitle] }), counterexample],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.falsifiability.rating).toBe('unknown');
    expect(result.verdict).not.toBe('pass');
  });

  it('fails stale proof and reports unknown metadata without converting it to pass', () => {
    const stale = evidence({
      currentness: {
        ...evidence().currentness,
        overall: 'stale',
        staleReasons: ['source-stale'],
      },
    });
    const staleResult = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [stale],
      classRef: 'plan-class-feature-ship',
    });
    expect(staleResult.ratings.freshness.rating).toBe('fail');
    expect(staleResult.verdict).toBe('fail');

    const unknownFreshness = evidence({
      evidenceRef: 'surface:unknown-history',
      currentness: {
        ...evidence().currentness,
        overall: 'unknown',
        dimensions: {
          ...evidence().currentness.dimensions,
          source: 'unknown',
        },
        unknownReasons: ['source_fingerprint_absent'],
      },
    });
    const unknownFreshnessResult = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [unknownFreshness],
      classRef: 'plan-class-feature-ship',
    });
    expect(unknownFreshnessResult.ratings.freshness).toMatchObject({
      rating: 'unknown',
      evidence: expect.stringContaining('source_fingerprint_absent'),
    });
    expect(unknownFreshnessResult.evidenceRefs).toEqual(['surface:unknown-history']);
    expect(unknownFreshnessResult.verdict).toBe('unknown');

    const incomplete = evidence({ details: { adequacy: { coverageRungs: { l3: true } } } });
    const unknown = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [incomplete],
      classRef: 'plan-class-feature-ship',
    });
    expect(unknown.ratings['execution-integrity'].rating).toBe('pass');
    expect(unknown.ratings['oracle-independence'].rating).toBe('unknown');
    expect(unknown.verdict).toBe('fail');
  });

  it('does not rate caller-attested fingerprint equality as fresh', () => {
    const attested = evidence({
      currentness: classifySpecEvidenceCurrentness(
        {
          spec_is_current: true,
          source_fingerprint: 'git:abc',
          test_fingerprint: 'sha256:test',
          fixture_fingerprint: 'sha256:fixture',
          rubric_fingerprint: 'sha256:rubric',
          environment_fingerprint: 'node:24',
          coverage_evidence_ref: 42,
          coverage_evidence_present: true,
          test_run_id: 43,
          test_run_present: true,
        },
        {
          evidenceKind: 'coverage-census',
          evidenceRef: 'surface:reconnect',
          sourceFingerprint: 'git:abc',
          testFingerprint: 'sha256:test',
          fixtureFingerprint: 'sha256:fixture',
          rubricFingerprint: 'sha256:rubric',
          environmentFingerprint: 'node:24',
        },
      ),
    });
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [attested],
      current: [
        {
          evidenceKind: attested.evidenceKind,
          evidenceRef: attested.evidenceRef,
          ...attested.fingerprints,
        },
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.freshness).toMatchObject({ rating: 'unknown' });
    expect(result.ratings.freshness.evidence).toContain('attested-current');
    expect(result.verdict).toBe('unknown');
  });

  it('explains partially server-measured opaque dimensions without calling them missing', () => {
    const row = evidence({
      currentness: {
        ...evidence().currentness,
        overall: 'unknown',
        provenance: 'partially-server-measured',
        comparisonSupplied: true,
        unknownReasons: ['current-fingerprints-partially-attested-not-independently-measured:environment'],
      },
    });
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [row],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.freshness).toMatchObject({ rating: 'unknown' });
    expect(result.ratings.freshness.evidence).toContain(
      'Repository fingerprints were server-measured, but applicable non-repository dimensions were only caller-attested',
    );
    expect(result.ratings.freshness.evidence).not.toContain('Current fingerprints are missing');
  });

  it.each([
    'test-run-worktree-not-clean',
    'test-run-worktree-cleanliness-unproven',
  ])('surfaces server-measured unknown currentness reason %s instead of claiming fingerprints are missing', (reason) => {
    const row = evidence({
      currentness: {
        ...evidence().currentness,
        overall: 'unknown',
        provenance: 'server-measured',
        comparisonSupplied: true,
        dimensions: { ...evidence().currentness.dimensions, testRun: 'unknown' },
        unknownReasons: [reason],
      },
    });
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [row],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.freshness).toMatchObject({ rating: 'unknown' });
    expect(result.ratings.freshness.evidence).toContain(reason);
    expect(result.ratings.freshness.evidence).not.toContain('Current fingerprints are missing');
  });

  // RECURRENCE GUARD (WI-10002320). A replayed tuple that MATCHED its stored values is
  // capped at 'unknown' precisely BECAUSE it matched — so the one thing the message must
  // never say is that fingerprints are missing. Without its own arm the chain fell through
  // to 'Current fingerprints are missing', which states the opposite of what happened and
  // sends the reader hunting for absent evidence that was never absent.
  //
  // Calibration: the sibling test above feeds a row differing ONLY in provenance
  // ('partially-server-measured') and asserts ITS distinct message, so a regression that
  // collapses these arms into one fails whichever arm it swallowed — neither assertion can
  // pass vacuously while the other still holds.
  it('explains a matched replayed snapshot without calling its fingerprints missing', () => {
    const row = evidence({
      currentness: {
        ...evidence().currentness,
        overall: 'unknown',
        provenance: 'replayed-snapshot',
        comparisonSupplied: true,
        unknownReasons: ['current-fingerprints-replayed-not-independently-measured'],
      },
    });
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [row],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.freshness).toMatchObject({ rating: 'unknown' });
    expect(result.ratings.freshness.evidence).toContain('nothing is missing and nothing is stale');
    expect(result.ratings.freshness.evidence).not.toContain('Current fingerprints are missing');
  });

  it('requires the required-layer path attestation on a passing test binding, not a killed mutant binding', () => {
    const requiredTest = successfulTestBinding('test/reconnect.unit.test.ts', {
      layer: 'unit',
      testCases: [DEFAULT_MUTATION_TEST_CASE],
    });
    requiredTest.details = {
      ...requiredTest.details,
      adequacy: {
        ...(requiredTest.details.adequacy as Record<string, unknown>),
        pathReachable: false,
      },
    };
    // Mirrors the stored mutation row: the run fails because the mutant was caught,
    // while pathReachable describes the mutation target rather than a passing test binding.
    const killedMutant = evidence({
      id: 36330,
      evidenceKind: 'mutation',
      evidenceRef: 'test-run 21034321 mutation-probe mutant fail',
      testRunId: 21034321,
      testRunExecution: {
        status: 'fail',
        passed: 0,
        failed: 1,
        skipped: 0,
        collectionFailed: false,
        testLayer: 'unit',
      },
      details: {
        adequacy: {
          testLayer: 'unit',
          pathReachable: true,
          outcome: 'caught',
          targeted: 'SPEC-003-01',
          testCases: [DEFAULT_MUTATION_TEST_CASE],
        },
      },
    });
    const evaluate = (rows: SpecEvidenceForAdequacy[]) => evaluateSpecTestAdequacy({
      clause: clause({ requiredTestLayers: ['unit'] }),
      evidence: rows,
      classRef: 'plan-class-feature-ship',
    });

    const mutationOnly = evaluate([killedMutant]);
    const conflictingPath = evaluate([requiredTest, killedMutant]);
    expect(mutationOnly.ratings['correct-layer'].rating).toBe('unknown');
    expect(conflictingPath.ratings['correct-layer'].rating).toBe('fail');
    expect(conflictingPath.wouldBlock).toContain('correct-layer');
  });

  it('does not combine a passing run and declared case/path proof from separate bindings', () => {
    const passingRunWithoutCase = evidence({
      id: 36331,
      evidenceKind: 'test',
      testRunExecution: {
        status: 'pass',
        passed: 1,
        failed: 0,
        skipped: 0,
        collectionFailed: false,
        testLayer: 'unit',
        passedCaseTitles: [],
      },
      details: {
        adequacy: {
          testLayer: 'unit',
          targeted: 'SPEC-003-01',
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'passed',
        },
      },
    });
    const killedMutantWithPathClaim = evidence({
      id: 36332,
      evidenceKind: 'mutation',
      evidenceRef: 'test-run 21034321 mutation-probe mutant fail',
      testRunId: 21034321,
      testRunExecution: {
        status: 'fail',
        passed: 0,
        failed: 1,
        skipped: 0,
        collectionFailed: false,
        testLayer: 'unit',
      },
      details: {
        adequacy: {
          testLayer: 'unit',
          pathReachable: true,
          outcome: 'caught',
          targeted: 'SPEC-003-01',
          testCases: [DEFAULT_MUTATION_TEST_CASE],
        },
      },
    });
    const evaluate = (rows: SpecEvidenceForAdequacy[]) => evaluateSpecTestAdequacy({
      clause: clause({ requiredTestLayers: ['unit'] }),
      evidence: rows,
      classRef: 'plan-class-feature-ship',
    });

    expect(evaluate([successfulTestBinding('test/reconnect.unit.test.ts', { layer: 'unit' })])
      .ratings['correct-layer'].rating).toBe('pass');
    const splitProof = evaluate([passingRunWithoutCase, killedMutantWithPathClaim]);
    expect(splitProof.ratings['correct-layer'].rating).toBe('unknown');
    expect(splitProof.ratings['correct-layer'].evidence).toContain('path reachability is unverified');
    expect(splitProof.wouldBlock).toContain('correct-layer');
  });

  it('keeps correct-layer unknown when the required layer has no measured passing baseline, and names the repair (EI-25235611084337188)', () => {
    const unitUnattested = evidence({
      evidenceKind: 'test',
      evidenceRef: 'surface:reconnect-unit',
      testRunExecution: null,
      details: {
        adequacy: {
          fixtureCalibrated: true,
          falsifiable: true,
          testLayer: 'unit',
          oracleIndependent: true,
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'passed',
          targeted: true,
          coverageRungs: { l3: true, l4: false },
        },
      },
    });
    // The default coverage row is not a test binding and cannot establish the required layer.
    const result = evaluateSpecTestAdequacy({
      clause: clause({ requiredTestLayers: ['unit'] }),
      evidence: [unitUnattested, evidence()],
      classRef: 'plan-class-feature-ship',
    });
    const layer = result.ratings['correct-layer'];
    expect(layer.rating).toBe('unknown');
    expect(layer.evidence).toContain('path reachability is unverified');
    expect(layer.evidence).toContain(': unit.');
    expect(layer.suggestion).toContain('server-measured testLayer');
    expect(layer.suggestion).toContain('exact passedCaseTitles');
    expect(layer.suggestion).toContain('binder-only layer/path claims remain unknown');

    // Positive control: the same required layer has a measured passing case and path attestation.
    const attested = evaluateSpecTestAdequacy({
      clause: clause({ requiredTestLayers: ['unit'] }),
      evidence: [successfulTestBinding('test/reconnect.unit.test.ts', {
        layer: 'unit',
        testCases: ['unit binding reaches its real path'],
      })],
      classRef: 'plan-class-feature-ship',
    });
    expect(attested.ratings['correct-layer'].rating).toBe('pass');
    expect(attested.ratings['correct-layer'].suggestion).toBeUndefined();
  });

  it('requires an explicit exact-clause target before measured layer evidence can pass', () => {
    const gradedClause = clause();
    const grade = (row: SpecEvidenceForAdequacy) => evaluateSpecTestAdequacy({
      clause: gradedClause,
      evidence: [row],
      classRef: 'plan-class-feature-ship',
    });

    const missingTarget = successfulTestBinding('test/reconnect.integration.test.ts');
    delete (missingTarget.details.adequacy as Record<string, unknown>).targeted;
    const missingTargetResult = grade(missingTarget);
    expect(missingTargetResult.ratings['correct-layer'].rating).toBe('unknown');
    expect(missingTargetResult.ratings['correct-layer'].evidence).toContain('binding target does not identify the exact clause');
    expect(missingTargetResult.ratings['correct-layer'].suggestion).toContain('adequacy.targeted="SPEC-003-01"');

    const siblingTargetResult = grade(successfulTestBinding('test/reconnect.integration.test.ts', {
      targeted: 'SPEC-003-02',
    }));
    expect(siblingTargetResult.ratings['correct-layer'].rating).toBe('unknown');
    expect(siblingTargetResult.ratings['correct-layer'].evidence).toContain('binding target does not identify the exact clause');

    const exactTargetResult = grade(successfulTestBinding('test/reconnect.integration.test.ts', {
      targeted: gradedClause.specId,
    }));
    expect(exactTargetResult.ratings['correct-layer'].rating).toBe('pass');
  });

  it('requires exact passing case identity and rejects a binder layer that contradicts the run', () => {
    const missingExactCase = successfulTestBinding('test/reconnect.integration.test.ts', {
      testCases: ['declared binding case'],
    });
    missingExactCase.testRunExecution!.passedCaseTitles = ['different passing case'];
    const uncorroborated = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [missingExactCase],
      classRef: 'plan-class-feature-ship',
    });
    expect(uncorroborated.ratings['correct-layer'].rating).toBe('unknown');
    expect(uncorroborated.ratings['correct-layer'].evidence).toContain('passedCaseTitleCount":1');
    expect(uncorroborated.ratings['correct-layer'].evidence).toContain('"declared":["declared binding case"]');
    expect(uncorroborated.ratings['correct-layer'].evidence).toContain('"missing":["declared binding case"]');
    expect(uncorroborated.ratings['correct-layer'].evidence).not.toContain('different passing case');
    expect(uncorroborated.ratings['correct-layer'].suggestion).toContain('exact passedCaseTitles');

    const incompleteTitleLedger = successfulTestBinding('test/reconnect.integration.test.ts', {
      testCases: ['declared binding case'],
    });
    incompleteTitleLedger.testRunExecution!.passedCaseTitles = ['different passing case'];
    incompleteTitleLedger.testRunExecution!.passedCaseTitlesIncomplete = true;
    const unknownBecauseCapped = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [incompleteTitleLedger],
      classRef: 'plan-class-feature-ship',
    });
    expect(unknownBecauseCapped.ratings['correct-layer'].rating).toBe('unknown');
    expect(unknownBecauseCapped.ratings['correct-layer'].evidence).toContain('"passedCaseTitlesIncomplete":true');
    expect(unknownBecauseCapped.ratings['correct-layer'].evidence).toContain('"missing":[]');
    expect(unknownBecauseCapped.ratings['correct-layer'].evidence)
      .toContain('"unknown":["declared binding case"]');

    const contradictoryLayer = successfulTestBinding('test/reconnect.unit.test.ts', {
      layer: 'unit',
      testCases: ['unit binding reaches its real path'],
    });
    contradictoryLayer.details = {
      ...contradictoryLayer.details,
      adequacy: {
        ...(contradictoryLayer.details.adequacy as Record<string, unknown>),
        testLayer: 'integration',
      },
    };
    const conflict = evaluateSpecTestAdequacy({
      clause: clause({ requiredTestLayers: ['integration'] }),
      evidence: [contradictoryLayer],
      classRef: 'plan-class-feature-ship',
    });
    expect(conflict.ratings['correct-layer'].rating).toBe('fail');
    expect(conflict.ratings['correct-layer'].evidence).toContain('testLayer-claim-mismatch:integration!=unit');
  });

  it('does not count a BAR case for a sibling clause when the binding target was rewritten', () => {
    const barClause = clause({
      planSlug: 'pui-first-party-public-release-2026-09-07',
      specId: 'AUTO-BAR-R-03-P-006',
      contentHash: 'sha256:pui-p006',
    });
    const siblingCase =
      'PUI P-008 sessions and context (spec clauses) > AUTO-BAR-R-03-P-008: Context follows the selected session';
    const mismatched = successfulTestBinding('packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts', {
      targeted: barClause.specId,
      testCases: [siblingCase],
    });
    mismatched.planSlug = barClause.planSlug;
    mismatched.specId = barClause.specId;
    mismatched.specFingerprint = barClause.contentHash;

    const result = evaluateSpecTestAdequacy({
      clause: barClause,
      evidence: [mismatched],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.traceability.rating).toBe('unknown');
    expect(result.ratings.traceability.evidence).toContain('AUTO-BAR-R-03-P-008');
    expect(result.ratings.traceability.evidence).toContain('targets AUTO-BAR-R-03-P-006');
    expect(result.ratings['correct-layer'].rating).toBe('unknown');
    expect(result.ratings['correct-layer'].evidence).toContain('binding target does not identify the exact clause');
    expect(result.ratings['correct-layer'].evidence).toContain('AUTO-BAR-R-03-P-008');
    expect(result.wouldBlock).toContain('correct-layer');
  });

  describe('canonical LLM scenario reachability (EI-25409108464228474)', () => {
    const scenarioId = 'su-S38-reports-capture';
    const filePath = 'packages/operator-core/lib/llm-testing/scenarios/su/S38-reports-capture.ts';

    function scenarioBinding(): SpecEvidenceForAdequacy {
      const row = successfulTestBinding(filePath, { layer: 'llm', testCases: [scenarioId] });
      row.testRunProvenance = { filePath, framework: 'llm-test', commitSha: 'abc123', worktreeDirty: false };
      row.testRunExecution = {
        status: 'pass', passed: 1, failed: 0, skipped: 0, collectionFailed: false,
        testLayer: 'llm', scenarioId, filePath,
      };
      return row;
    }

    function grade(row: SpecEvidenceForAdequacy) {
      return evaluateSpecTestAdequacy({
        clause: clause({ requiredTestLayers: ['llm'] }), evidence: [row], classRef: 'plan-class-feature-ship',
      }).ratings['correct-layer'];
    }

    it('corroborates the exact executed LLM scenario without inventing conventional passed titles', () => {
      const row = scenarioBinding();
      const before = JSON.stringify(row);
      const result = grade(row);
      expect(result.rating).toBe('pass');
      expect(result.evidence).toContain('"scenarioId":"su-S38-reports-capture"');
      expect(result.evidence).toContain('"passed":["su-S38-reports-capture"]');
      expect(result.evidence).toContain('"passedCaseTitleCount":0');
      expect(JSON.stringify(row)).toBe(before);
    });

    it.each([
      ['missing identity', (row: SpecEvidenceForAdequacy) => { delete row.testRunExecution!.scenarioId; }],
      ['different scenario', (row: SpecEvidenceForAdequacy) => { row.testRunExecution!.scenarioId = 'su-S37-other'; }],
      ['case-folded claim', (row: SpecEvidenceForAdequacy) => {
        (row.details.adequacy as Record<string, unknown>).testCases = [scenarioId.toLowerCase()];
      }],
      ['absent declared case', (row: SpecEvidenceForAdequacy) => {
        delete (row.details.adequacy as Record<string, unknown>).testCases;
      }],
      ['replayed unit framework', (row: SpecEvidenceForAdequacy) => { row.testRunProvenance!.framework = 'vitest'; }],
      ['missing framework', (row: SpecEvidenceForAdequacy) => { delete row.testRunProvenance!.framework; }],
      ['different executed file', (row: SpecEvidenceForAdequacy) => { row.testRunExecution!.filePath = 'test/other.ts'; }],
      ['absent executed file', (row: SpecEvidenceForAdequacy) => { delete row.testRunExecution!.filePath; }],
      ['dirty source', (row: SpecEvidenceForAdequacy) => { row.testRunProvenance!.worktreeDirty = true; }],
      ['no passed run', (row: SpecEvidenceForAdequacy) => { row.testRunExecution!.passed = 0; }],
      ['failed run', (row: SpecEvidenceForAdequacy) => { row.testRunExecution!.failed = 1; }],
      ['skipped run', (row: SpecEvidenceForAdequacy) => { row.testRunExecution!.skipped = 1; }],
      ['collection failure', (row: SpecEvidenceForAdequacy) => { row.testRunExecution!.collectionFailed = true; }],
      ['wrong recorded status', (row: SpecEvidenceForAdequacy) => { row.testRunExecution!.status = 'fail'; }],
    ])('refuses %s as LLM reachability proof', (_label, mutate) => {
      const row = scenarioBinding();
      mutate(row);
      expect(grade(row).rating).not.toBe('pass');
    });

    it('does not use an LLM identity to corroborate a conventional unit case', () => {
      const row = scenarioBinding();
      row.testRunExecution!.testLayer = 'unit';
      (row.details.adequacy as Record<string, unknown>).testLayer = 'unit';
      const result = evaluateSpecTestAdequacy({
        clause: clause({ requiredTestLayers: ['unit'] }), evidence: [row], classRef: 'plan-class-feature-ship',
      });
      expect(result.ratings['correct-layer'].rating).not.toBe('pass');
    });
  });

  it('grades only the exact current cohort when historical stale or unknown bindings coexist', () => {
    const staleHistorical = evidence({
      evidenceRef: 'surface:historical-stale',
      currentness: {
        ...evidence().currentness,
        overall: 'stale',
        dimensions: {
          ...evidence().currentness.dimensions,
          source: 'stale',
        },
        staleReasons: ['source_fingerprint_mismatch'],
      },
      details: {
        adequacy: {
          fixtureCalibrated: false,
          falsifiable: false,
          testLayer: 'integration',
          pathReachable: false,
          oracleIndependent: false,
          collected: false,
          skipped: true,
          executed: false,
          outcome: 'failed',
          coverageRungs: { l3: false },
        },
      },
    });
    const unknownHistorical = evidence({
      evidenceRef: 'surface:historical-unknown',
      currentness: {
        ...evidence().currentness,
        overall: 'unknown',
        dimensions: {
          ...evidence().currentness.dimensions,
          test: 'unknown',
        },
        unknownReasons: ['test_fingerprint_absent'],
      },
    });
    const current = caseScopedNegativeEvidence({ evidenceRef: 'surface:current' });

    const passing = evaluateSpecTestAdequacy({
      clause: caseScopedClause(),
      evidence: [staleHistorical, unknownHistorical, caseScopedTestBinding(), current],
      classRef: 'plan-class-feature-ship',
    });
    expect(passing.verdict).toBe('pass');
    expect(passing.ratings.freshness.rating).toBe('pass');
    expect(passing.evidenceRefs).toEqual(['surface:current', `test-run:${CASE_SCOPED_TEST_PATH}`].sort());

    const incompleteCurrent = evidence({
      evidenceRef: 'surface:current-incomplete',
      details: { adequacy: { coverageRungs: { l3: true } } },
    });
    const notSatisfiedByHistory = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [staleHistorical, incompleteCurrent],
      classRef: 'plan-class-feature-ship',
    });
    expect(notSatisfiedByHistory.evidenceRefs).toEqual(['surface:current-incomplete']);
    expect(notSatisfiedByHistory.ratings['execution-integrity'].rating).toBe('pass');
    expect(notSatisfiedByHistory.ratings['oracle-independence'].rating).toBe('unknown');
    expect(notSatisfiedByHistory.verdict).not.toBe('pass');
  });

  it.each([
    { rung: 'l3' as const, classRef: 'plan-class-feature-ship' as const },
    { rung: 'l4' as const, classRef: 'plan-class-bugfix' as const },
  ])('does not credit $rung from a generic test binding with self-attested rung metadata', ({ rung, classRef }) => {
    const genericTestBinding = evidence({
      evidenceKind: 'test',
      evidenceRef: `test-run:generic-${rung}-rung`,
      coverageEvidenceRef: null,
      details: { adequacy: { coverageRungs: { [rung]: true } } },
    });
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [genericTestBinding],
      classRef,
    });
    expect(result.requiredProofFloor).toBe(rung);
    expect(result.ratings['plan-class-risk-floor'].rating).toBe('unknown');
    expect(result.verdict).not.toBe('pass');
  });

  it('keeps omitted bindings in the graded population when current fingerprints are partial', () => {
    const selected = evidence({ evidenceRef: 'surface:selected' });
    const omitted = evidence({ evidenceRef: 'surface:omitted' });
    const current: EvidenceCurrentInput[] = [
      {
        evidenceKind: selected.evidenceKind,
        evidenceRef: selected.evidenceRef,
        ...selected.fingerprints,
      },
    ];
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [selected, omitted].map((row) => ({
        ...row,
        currentness: classifySpecEvidenceCurrentness(
          {
            spec_is_current: true,
            source_fingerprint: row.fingerprints.sourceFingerprint,
            test_fingerprint: row.fingerprints.testFingerprint,
            fixture_fingerprint: row.fingerprints.fixtureFingerprint,
            rubric_fingerprint: row.fingerprints.rubricFingerprint,
            environment_fingerprint: row.fingerprints.environmentFingerprint,
            coverage_evidence_ref: row.coverageEvidenceRef,
            coverage_evidence_present: true,
            test_run_id: row.testRunId,
            test_run_present: true,
          },
          current.find((input) => input.evidenceKind === row.evidenceKind && input.evidenceRef === row.evidenceRef),
        ),
      })),
      current,
      classRef: 'plan-class-feature-ship',
    });

    expect(result.evidenceRefs).toEqual(['surface:omitted', 'surface:selected']);
    expect(result.ratings.freshness.rating).toBe('unknown');
    expect(result.ratings.freshness.evidence).toContain('surface:omitted');
    expect(result.verdict).toBe('unknown');
  });

  it('pins the evaluator revision when an adequacy rule changes', () => {
    expect(SPEC_TEST_ADEQUACY_EVALUATOR_REVISION).toBe(39);
  });

  it('accepts a non-automated ledger census without inventing executable fixture proof', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause({ behaviorClass: 'non-automated', requiredEvidence: ['tree'], requiredTestLayers: [] }),
      evidence: [ledgerCensusEvidence()],
      classRef: 'plan-class-bugfix',
    });

    expect(result.ratings['fixture-calibration'].rating).toBe('not-applicable');
    expect(result.ratings['correct-layer'].rating).toBe('not-applicable');
    expect(result.ratings.traceability.rating).toBe('pass');
    expect(result.verdict).toBe('pass');
  });

  it('does not count evidence-kind and plane coverage as exercised layer reachability', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause({ behaviorClass: 'non-automated', requiredEvidence: ['tree', 'coverage-census'], requiredTestLayers: [] }),
      evidence: [ledgerCensusEvidence()],
      classRef: 'plan-class-bugfix',
    });

    expect(result.ratings['correct-layer'].rating).toBe('not-applicable');
    expect(result.ratings['correct-layer'].evidence).toContain('cover the required evidence kind(s)');
    expect(result.ratings['correct-layer'].evidence).toContain('cover the required evidence plane(s)');
    expect(result.verdict).toBe('pass');
  });

  it.each(['missing-plane', 'wrong-plane', 'missing-kind', 'required-layer', 'required-scenario', 'source-suite'] as const)(
    'keeps a layer-free census blocked by %s obligations', (control) => {
      const row = ledgerCensusEvidence();
      const spec = clause({ behaviorClass: 'non-automated', requiredEvidence: ['tree'], requiredTestLayers: [] });
      if (control === 'missing-plane') delete row.details.evidencePlane;
      else if (control === 'wrong-plane') row.details.evidencePlane = 'live';
      else if (control === 'missing-kind') spec.requiredEvidence.push('manual');
      else if (control === 'required-layer') spec.requiredTestLayers = ['integration'];
      else if (control === 'required-scenario') spec.falsifier = {
        observation: 'The missing path must have been exercised.', requiredScenarios: ['missing-path'],
      };

      const result = evaluateSpecTestAdequacy({
        clause: spec, evidence: [row], classRef: 'plan-class-bugfix',
        ...(control === 'source-suite' ? {
          sourceBarTestRequirements: { status: 'required' as const, files: ['src/feature.test.ts'] },
        } : {}),
      });

      expect(['fail', 'unknown']).toContain(result.ratings['correct-layer'].rating);
      expect(result.wouldBlock).toContain('correct-layer');
      expect(result.verdict).not.toBe('pass');
    },
  );

  it.each(['executable', 'repo-files', 'test-run', 'test-execution', 'test-fingerprint', 'fixture-required',
    'unmeasured', 'malformed-measurement'] as const)(
    'keeps fixture classification required for a census with %s evidence', (control) => {
      const row = ledgerCensusEvidence();
      const spec = clause({ behaviorClass: 'non-automated', requiredEvidence: ['tree'], requiredTestLayers: [] });
      if (control === 'executable') {
        spec.behaviorClass = 'happy-path';
        spec.requiredTestLayers = ['integration'];
      } else if (control === 'repo-files') {
        row.details.currentMeasurement = { schemaVersion: 1, kind: 'repo-files', sourcePaths: ['src/feature.ts'] };
      } else if (control === 'test-run') row.testRunId = 43;
      else if (control === 'test-execution') row.testRunExecution = evidence().testRunExecution;
      else if (control === 'test-fingerprint') row.fingerprints.testFingerprint = 'sha256:test';
      else if (control === 'fixture-required') spec.falsifier = { observation: 'The fixture produces a wrong count.' };
      else if (control === 'unmeasured') row.currentness = { ...row.currentness!, provenance: 'not-supplied' };
      else row.details.currentMeasurement = { schemaVersion: 1, kind: 'work-items', workItemIds: [] };

      const result = evaluateSpecTestAdequacy({ clause: spec, evidence: [row], classRef: 'plan-class-bugfix' });

      expect(result.ratings['fixture-calibration'].rating).toBe('unknown');
      expect(result.verdict).not.toBe('pass');
    },
  );

  it('still rejects uncalibrated fixture bytes on a non-automated ledger census', () => {
    const row = ledgerCensusEvidence();
    row.fingerprints.fixtureFingerprint = 'sha256:actual-fixture';
    row.details.adequacy = { ...(row.details.adequacy as Record<string, unknown>), fixtureCalibrated: false };
    const result = evaluateSpecTestAdequacy({
      clause: clause({ behaviorClass: 'non-automated', requiredEvidence: ['tree'], requiredTestLayers: [] }),
      evidence: [row],
      classRef: 'plan-class-bugfix',
    });

    expect(result.ratings['fixture-calibration'].rating).toBe('fail');
    expect(result.verdict).toBe('fail');
  });

  it('keeps fixture calibration unknown when a null fingerprint has no independent fixture-free measurement', () => {
    const row = evidence({
      evidenceKind: 'counterexample',
      evidenceRef: 'counterexample:tree-only-spec',
      fingerprints: {
        ...evidence().fingerprints,
        fixtureFingerprint: null,
      },
      details: {
        adequacy: {
          ...((evidence().details.adequacy ?? {}) as Record<string, unknown>),
          fixtureCalibrated: true,
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause({
        behaviorClass: 'observability',
        requiredEvidence: ['tree'],
        requiredTestLayers: ['integration', 'unit'],
      }),
      evidence: [row],
      classRef: 'plan-class-bugfix',
    });

    expect(result.ratings['fixture-calibration'].rating).toBe('unknown');
    expect(result.ratings['fixture-calibration'].evidence).toContain(
      'A null fixtureFingerprint does not establish fixture-free proof',
    );
    expect(result.ratings['fixture-calibration'].evidence).toContain('fixtureCalibrated=true');
  });

  it('keeps fixture calibration unknown when an executable binding has no fixture classification', () => {
    const base = evidence();
    const row = evidence({
      evidenceKind: 'test',
      evidenceRef: 'test:unclassified-fixture-use',
      fingerprints: { ...base.fingerprints, fixtureFingerprint: null },
      details: {
        adequacy: {
          ...((base.details.adequacy ?? {}) as Record<string, unknown>),
          fixtureCalibrated: undefined,
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause({
        behaviorClass: 'observability',
        requiredEvidence: ['tree'],
        requiredTestLayers: ['integration', 'unit'],
      }),
      evidence: [row],
      classRef: 'plan-class-bugfix',
    });

    expect(result.ratings['fixture-calibration'].rating).toBe('unknown');
    expect(result.ratings['fixture-calibration'].evidence).toContain(
      'A null fixtureFingerprint does not establish fixture-free proof',
    );
    expect(result.ratings['fixture-calibration'].suggestion).toContain('independently measured');
  });

  it('does not let one calibrated fixture binding cover an executable sibling without a fixture fingerprint', () => {
    const base = evidence();
    const calibratedFixture = evidence({
      evidenceKind: 'fixture',
      evidenceRef: 'fixture:calibrated-sibling',
      details: {
        adequacy: {
          ...((base.details.adequacy ?? {}) as Record<string, unknown>),
          fixtureCalibrated: true,
        },
      },
    });
    const uncalibratedSibling = evidence({
      evidenceKind: 'test',
      evidenceRef: 'test:fixture-use-without-calibration',
      fingerprints: { ...base.fingerprints, fixtureFingerprint: null },
      details: {
        adequacy: {
          ...((base.details.adequacy ?? {}) as Record<string, unknown>),
          fixtureCalibrated: undefined,
          fixtureFree: false,
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause({ requiredEvidence: ['integration test'] }),
      evidence: [calibratedFixture, uncalibratedSibling],
      classRef: 'plan-class-bugfix',
    });

    expect(result.ratings['fixture-calibration'].rating).toBe('unknown');
    expect(result.ratings['fixture-calibration'].evidence).toContain(
      'A fixture is required or used, but no fixture fingerprint or calibration evidence is bound for',
    );
    expect(result.ratings['fixture-calibration'].evidence).toContain(
      'test:fixture-use-without-calibration',
    );
  });

  it('does not treat binder-authored fixtureFree=true as measured fixture absence', () => {
    const base = evidence();
    const row = evidence({
      evidenceKind: 'test',
      evidenceRef: 'test:fixture-free-claim-without-fixture-measurement',
      fingerprints: { ...base.fingerprints, fixtureFingerprint: null },
      details: {
        adequacy: {
          ...((base.details.adequacy ?? {}) as Record<string, unknown>),
          fixtureCalibrated: undefined,
          fixtureFree: true,
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause({ requiredEvidence: ['integration test'] }),
      evidence: [row],
      classRef: 'plan-class-bugfix',
    });

    expect(result.ratings['fixture-calibration'].rating).toBe('unknown');
    expect(result.ratings['fixture-calibration'].evidence).toContain(
      'Binder-authored fixtureFree=true does not establish fixture absence',
    );
    expect(result.ratings['fixture-calibration'].suggestion).toContain('independent measurement');
  });

  it('keeps fixture calibration unknown when test and mutation bindings lack fixture classification', () => {
    const base = evidence();
    const testBinding = evidence({
      id: 42189,
      evidenceKind: 'test',
      evidenceRef: 'test:unclassified-fixture-use',
      fingerprints: { ...base.fingerprints, fixtureFingerprint: null },
      details: {
        adequacy: {
          ...((base.details.adequacy ?? {}) as Record<string, unknown>),
          fixtureCalibrated: undefined,
          fixtureFree: undefined,
        },
      },
    });
    const mutationBinding = evidence({
      id: 42206,
      evidenceKind: 'mutation',
      evidenceRef: 'mutation:unclassified-fixture-use',
      fingerprints: { ...base.fingerprints, fixtureFingerprint: null },
      details: {
        adequacy: {
          ...((base.details.adequacy ?? {}) as Record<string, unknown>),
          fixtureCalibrated: undefined,
          fixtureFree: undefined,
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause({ requiredEvidence: ['tree'] }),
      evidence: [testBinding, mutationBinding],
      classRef: 'plan-class-bugfix',
    });

    expect(result.ratings['fixture-calibration'].rating).toBe('unknown');
    expect(result.ratings['fixture-calibration'].evidence).toContain(
      'A null fixtureFingerprint does not establish fixture-free proof',
    );
    expect(result.ratings['fixture-calibration'].evidence).toContain('id=42189');
    expect(result.ratings['fixture-calibration'].evidence).toContain('id=42206');
  });

  describe('independently verified fixture absence', () => {
    function proofPair() {
      const base = evidence();
      const cited = evidence({
        id: 901, createdBy: 'su-implementer', evidenceKind: 'test',
        evidenceRef: 'test:real-repository-subject',
        fingerprints: { ...base.fingerprints, fixtureFingerprint: null },
        details: { adequacy: { ...base.details.adequacy as Record<string, unknown>,
          fixtureFree: true, fixtureCalibrated: undefined } },
      });
      const review = evidence({ ...cited, id: 902, createdBy: 'su-reviewer',
        evidenceKind: 'independent-verification', verifiesBindingId: cited.id });
      return { cited, review };
    }

    it('accepts a current outside-lineage review of the same measured source, test, run and cases', async () => {
      const { cited, review } = proofPair();
      const fixtureAbsenceVerifications = await resolveFixtureAbsenceVerifications([cited, review], async () => true);
      expect(fixtureAbsenceVerifications.get(cited.id!)).toEqual([review.id]);
      const result = evaluateSpecTestAdequacy({ clause: clause({ requiredEvidence: ['tree'] }),
        evidence: [cited, review], classRef: 'plan-class-feature-ship', fixtureAbsenceVerifications });
      expect(result.ratings['fixture-calibration'].rating).toBe('not-applicable');
      expect(result.ratings['fixture-calibration'].evidence).toContain('independently verified');
      expect(result.ratings['fixture-calibration'].evidence).toContain('902');
    });

    it('rejects self review, related lineages, and unreadable lineage', async () => {
      const { cited, review } = proofPair();
      const self = { ...review, createdBy: cited.createdBy };
      expect((await resolveFixtureAbsenceVerifications([cited, self], async () => true)).size).toBe(0);
      expect((await resolveFixtureAbsenceVerifications([cited, review], async () => false)).size).toBe(0);
      expect((await resolveFixtureAbsenceVerifications([cited, review], async () => { throw new Error('unavailable'); })).size).toBe(0);
    });

    it('accepts the shared reader certificate without evaluator-tool-only arguments', () => {
      const { cited, review } = proofPair();
      const certified = { ...cited, fixtureAbsenceVerification: { verifierBindingIds: [review.id!] } };
      const result = evaluateSpecTestAdequacy({ clause: clause({ requiredEvidence: ['tree'] }),
        evidence: [certified, review], classRef: 'plan-class-feature-ship' });
      expect(result.ratings['fixture-calibration'].rating).toBe('not-applicable');
      const binderClaim = { ...cited, details: { ...cited.details,
        fixtureAbsenceVerification: { verifierBindingIds: [review.id!] } } };
      expect(evaluateSpecTestAdequacy({ clause: clause({ requiredEvidence: ['tree'] }),
        evidence: [binderClaim, review], classRef: 'plan-class-feature-ship' })
        .ratings['fixture-calibration'].rating).toBe('unknown');
    });

    it('rejects changed source, test, run, clause, stale proof, or incomplete reviewed case coverage', async () => {
      const { cited, review } = proofPair();
      const mismatches: SpecEvidenceForAdequacy[] = [
        { ...review, fingerprints: { ...review.fingerprints, sourceFingerprint: 'other-source' } },
        { ...review, fingerprints: { ...review.fingerprints, testFingerprint: 'other-test' } },
        { ...review, testRunId: 99 },
        { ...review, specRevision: 99 },
        { ...review, currentness: { ...review.currentness, overall: 'stale' } },
        { ...review, currentness: { ...review.currentness, provenance: 'attested-current' } },
        { ...review, details: { adequacy: { fixtureFree: true, testCases: ['unrelated case'] } } },
      ];
      for (const candidate of mismatches) {
        expect((await resolveFixtureAbsenceVerifications([cited, candidate], async () => true)).size).toBe(0);
      }
    });

    it('cannot certify an unreviewed sibling or override declared fixture use', async () => {
      const { cited, review } = proofPair();
      const sibling = { ...cited, id: 903, evidenceRef: 'test:unreviewed-subject' };
      const fixtureAbsenceVerifications = await resolveFixtureAbsenceVerifications([cited, review, sibling], async () => true);
      for (const subject of [
        { clause: clause({ requiredEvidence: ['tree'] }), evidence: [cited, review, sibling] },
        { clause: clause({ requiredEvidence: ['integration fixture'] }), evidence: [cited, review] },
      ]) {
        const result = evaluateSpecTestAdequacy({ ...subject, classRef: 'plan-class-feature-ship', fixtureAbsenceVerifications });
        expect(result.ratings['fixture-calibration'].rating).toBe('unknown');
      }
    });

    it('ignores identity and citation assertions placed only in binder details', async () => {
      const { cited, review } = proofPair();
      const forged = { ...review, createdBy: undefined, verifiesBindingId: undefined,
        details: { ...review.details, createdBy: 'su-reviewer', verifiesBindingId: cited.id } };
      expect((await resolveFixtureAbsenceVerifications([cited, forged], async () => true)).size).toBe(0);
    });

    it('keeps partial evidence without currentness unverified', async () => {
      const { cited, review } = proofPair();
      const partial = { ...review, currentness: undefined } as unknown as SpecEvidenceForAdequacy;
      expect((await resolveFixtureAbsenceVerifications([cited, partial], async () => true)).size).toBe(0);
    });
  });

  it('keeps fixture calibration unknown when the falsifier observation declares fixture use despite fixtureFree=true', () => {
    const base = evidence();
    const row = evidence({
      evidenceKind: 'test',
      evidenceRef: 'test:fixture-free-conflicts-with-falsifier-observation',
      fingerprints: { ...base.fingerprints, fixtureFingerprint: null },
      details: {
        adequacy: {
          ...((base.details.adequacy ?? {}) as Record<string, unknown>),
          fixtureCalibrated: undefined,
          fixtureFree: true,
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause({
        requiredEvidence: ['tree'],
        falsifier: {
          observation: 'For a fixture plan failing three independent gate checks, the refusal names fewer than three codes.',
        },
      }),
      evidence: [row],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['fixture-calibration'].rating).toBe('unknown');
    expect(result.ratings['fixture-calibration'].evidence).toContain('clause declares fixture use');
    expect(result.ratings['fixture-calibration'].suggestion).toContain('measured fixture fingerprint');
  });

  it('rejects fixtureFree=true when the same binding carries fixture evidence', () => {
    const base = evidence();
    const row = evidence({
      evidenceKind: 'test',
      evidenceRef: 'test:fixture-free-conflict',
      details: {
        adequacy: {
          ...((base.details.adequacy ?? {}) as Record<string, unknown>),
          fixtureFree: true,
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause({ requiredEvidence: ['integration test'] }),
      evidence: [row],
      classRef: 'plan-class-bugfix',
    });

    expect(result.ratings['fixture-calibration'].rating).toBe('fail');
    expect(result.ratings['fixture-calibration'].evidence).toContain(
      'claim fixtureFree=true while also carrying fixture evidence',
    );
  });

  it('names calibration states for exact fixture bindings outside the current grading cohort', () => {
    const current = evidence({
      id: 44282,
      evidenceKind: 'test',
      evidenceRef: 'test:current-calibrated-fixture',
      testRunId: 101,
      coverageEvidenceRef: null,
      fingerprints: { ...evidence().fingerprints, fixtureFingerprint: 'sha256:current-fixture' },
      details: {
        adequacy: {
          ...((evidence().details.adequacy ?? {}) as Record<string, unknown>),
          fixtureCalibrated: true,
          fixtureFree: false,
        },
      },
    });
    const excludedUncalibrated = evidence({
      id: 44283,
      evidenceKind: 'test',
      evidenceRef: 'test:excluded-uncalibrated-fixture',
      testRunId: 102,
      coverageEvidenceRef: null,
      fingerprints: { ...evidence().fingerprints, fixtureFingerprint: 'sha256:excluded-fixture' },
      details: {
        adequacy: {
          ...((evidence().details.adequacy ?? {}) as Record<string, unknown>),
          fixtureCalibrated: false,
          fixtureFree: false,
        },
      },
      currentness: {
        ...evidence().currentness,
        overall: 'unknown',
        provenance: 'not-supplied',
        comparisonSupplied: false,
        unknownReasons: ['test-fingerprint-not-supplied'],
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause({ requiredEvidence: ['integration test'] }),
      evidence: [current, excludedUncalibrated],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['fixture-calibration'].rating).toBe('pass');
    expect(result.ratings['fixture-calibration'].evidence).toContain('outside the current grading cohort');
    expect(result.ratings['fixture-calibration'].evidence).toContain('id=44283 fixtureCalibrated=false');
    expect(result.ratings['fixture-calibration'].evidence).not.toContain(
      'Current fixture bindings not attesting calibration:',
    );
  });

  it('names a non-passing current fixture binding when another current binding passes', () => {
    const calibrated = evidence({
      id: 44282,
      evidenceKind: 'test',
      evidenceRef: 'test:current-calibrated-fixture',
      testRunId: 101,
      coverageEvidenceRef: null,
      fingerprints: { ...evidence().fingerprints, fixtureFingerprint: 'sha256:current-fixture' },
      details: {
        adequacy: {
          ...((evidence().details.adequacy ?? {}) as Record<string, unknown>),
          fixtureCalibrated: true,
          fixtureFree: false,
        },
      },
    });
    const uncalibrated = evidence({
      id: 45129,
      evidenceKind: 'test',
      evidenceRef: 'test:current-uncalibrated-fixture',
      testRunId: 102,
      coverageEvidenceRef: null,
      fingerprints: { ...evidence().fingerprints, fixtureFingerprint: 'sha256:current-fixture-uncalibrated' },
      details: {
        adequacy: {
          ...((evidence().details.adequacy ?? {}) as Record<string, unknown>),
          fixtureCalibrated: false,
          fixtureFree: false,
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause({ requiredEvidence: ['integration test'] }),
      evidence: [calibrated, uncalibrated],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['fixture-calibration'].rating).toBe('pass');
    expect(result.ratings['fixture-calibration'].evidence).toContain(
      'Current fixture bindings not attesting calibration: id=45129 fixtureCalibrated=false',
    );
  });

  it('requires fixture calibration when the falsifier probe method uses a fixture provider', () => {
    const row = evidence({
      evidenceKind: 'test',
      evidenceRef: 'test:fixture-provider-without-binding',
      fingerprints: {
        ...evidence().fingerprints,
        fixtureFingerprint: null,
      },
      details: {
        adequacy: {
          ...((evidence().details.adequacy ?? {}) as Record<string, unknown>),
          fixtureCalibrated: undefined,
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause({
        requiredEvidence: ['integration test'],
        falsifier: {
          observation: 'A ticket from the registered provider is admitted.',
          probeMethod: 'Admit a ticket from a registered fixture provider.',
        },
      }),
      evidence: [row],
      classRef: 'plan-class-bugfix',
    });

    expect(result.ratings['fixture-calibration'].rating).toBe('unknown');
    expect(result.ratings['fixture-calibration'].evidence).toContain('A fixture is required or used');
    expect(result.ratings['fixture-calibration'].evidence).not.toContain('No fixture binding or fixture fingerprint is present');
  });

  it('does not accept fixture calibration from non-fixture evidence when the probe method uses a fixture', () => {
    const row = evidence({
      evidenceKind: 'counterexample',
      evidenceRef: 'counterexample:fixture-flag-without-binding',
      fingerprints: {
        ...evidence().fingerprints,
        fixtureFingerprint: null,
      },
      details: {
        adequacy: {
          ...((evidence().details.adequacy ?? {}) as Record<string, unknown>),
          fixtureCalibrated: true,
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause({
        requiredEvidence: ['integration test'],
        falsifier: {
          observation: 'A ticket from the registered provider is admitted.',
          probeMethod: 'Admit a ticket from a registered fixture provider.',
        },
      }),
      evidence: [row],
      classRef: 'plan-class-bugfix',
    });

    expect(result.ratings['fixture-calibration'].rating).toBe('unknown');
    expect(result.ratings['fixture-calibration'].evidence).toContain('A fixture is required or used');
    expect(result.ratings['fixture-calibration'].evidence).not.toContain('An applicable binding explicitly attests fixtureCalibrated=true.');
  });

  it('does not report exact fixture or mutation bindings as spec-scoped absence when current grading narrows the cohort', () => {
    const currentTest = evidence({
      evidenceKind: 'test',
      evidenceRef: 'packages/operator-core/lib/interview-prep.test.ts#current',
      fingerprints: {
        ...evidence().fingerprints,
        fixtureFingerprint: null,
      },
      details: {
        adequacy: {
          ...((evidence().details.adequacy ?? {}) as Record<string, unknown>),
          fixtureCalibrated: undefined,
          falsifiable: true,
        },
      },
    });
    const unknownFixture = evidence({
      evidenceKind: 'fixture',
      evidenceRef: 'packages/operator-core/lib/interview-prep-evidence/servicenow-staff-ml-manual-review.json',
      currentness: {
        ...evidence().currentness,
        overall: 'unknown',
        provenance: 'not-supplied',
        comparisonSupplied: false,
        unknownReasons: ['fixture-current-fingerprint-not-supplied'],
      },
      details: {
        adequacy: {
          ...((evidence().details.adequacy ?? {}) as Record<string, unknown>),
          fixtureCalibrated: true,
        },
      },
    });
    const unknownMutation = evidence({
      evidenceKind: 'mutation',
      evidenceRef: 'mutation-probe:reinsert-superseded-requisition:2026-09-08',
      currentness: {
        ...evidence().currentness,
        overall: 'unknown',
        provenance: 'not-supplied',
        comparisonSupplied: false,
        unknownReasons: ['source-current-fingerprint-not-supplied'],
      },
      details: {
        adequacy: {
          ...((evidence().details.adequacy ?? {}) as Record<string, unknown>),
          outcome: 'killed',
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause({ requiredEvidence: ['integration test'] }),
      evidence: [currentTest, unknownFixture, unknownMutation],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.evidenceRefs).toEqual([currentTest.evidenceRef]);
    expect(result.ratings['fixture-calibration'].rating).toBe('unknown');
    expect(result.ratings['fixture-calibration'].evidence).toContain('2 exact fixture binding(s) are outside');
    expect(result.ratings.falsifiability.evidence).not.toContain('no mutation or counterexample binding is bound');
    expect(result.ratings.falsifiability.evidence).toContain('1 mutation or counterexample binding(s) exist');
    // EI-23756870948948211: pin WHICH branch this case exercises. `unknownMutation` carries
    // provenance:'not-supplied', so it is excluded from the grading cohort while still satisfying
    // isSuccessfulExecutableEvidence — this is the genuinely-outside-the-cohort case, and the
    // cohort explanation is TRUE here. Its sibling test below covers the in-cohort case, where
    // that same sentence would be false. Keeping both pinned is what stops the two causes being
    // collapsed back into one untested assertion.
    expect(result.ratings.falsifiability.evidence).toContain('outside the current grading cohort');
  });

  it('names the unmet executable-evidence conjunct instead of asserting an untested cohort cause', () => {
    // EI-23756870948948211: a mutation binding authored the normal way sets evidenceKind + a
    // ledger ref + outcome and OMITS adequacy.collected/skipped/executed. It sits INSIDE the
    // grading cohort and fails isSuccessfulExecutableEvidence on those three booleans — but the
    // refusal used to blame "outside the current grading cohort", a cause it never tested and
    // which is impossible here. That misdirection cost ~15 respawns across three agents.
    const incompleteMutation = evidence({
      evidenceKind: 'mutation',
      evidenceRef: 'mutation-probe:unset-adequacy-booleans',
      details: {
        adequacy: {
          fixtureCalibrated: true,
          falsifiable: true,
          testLayer: 'integration',
          pathReachable: true,
          oracleIndependent: true,
          outcome: 'killed',
          targeted: true,
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause({ requiredEvidence: ['integration test'] }),
      evidence: [incompleteMutation],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.falsifiability.rating).toBe('unknown');
    // The row IS in the cohort, so the cohort-narrowing explanation would be a false statement.
    expect(result.ratings.falsifiability.evidence).not.toContain('outside the current grading cohort');
    expect(result.ratings.falsifiability.evidence).toContain('in the current grading cohort');
    // The actionable half: name the conjuncts that were actually unmet, and distinguish an unset
    // boolean from an explicit false, because the two are fixed by different edits.
    expect(result.ratings.falsifiability.evidence).toContain('collected=unset');
    expect(result.ratings.falsifiability.evidence).toContain('skipped=unset');
    expect(result.ratings.falsifiability.evidence).toContain('executed=unset');
    expect(result.ratings.falsifiability.suggestion).toContain('collected=unset');
  });

  // WI-10002082 (RETRACTED fix — this guard is what replaced it). A branch reporting "your binding
  // was stranded by the read projection" was added here and removed: it is unreachable, because
  // supersession preserves `evidenceKind` on BOTH routes (`latestLogicalEvidence` keys on it, and
  // attempt-supersession matches `scope.key`, whose `registrationKey` carries it). A dropped
  // mutation row therefore always leaves a same-kind survivor for the two REAL causes to report,
  // so the bare-absence fall-through is true whenever it prints. Make supersession kind-agnostic
  // and this test fails — at which point that fall-through becomes a false absence and the removed
  // branch has to come back.
  it('projection supersession cannot strand a mutation binding', () => {
    const mutationAttempt = attempt(1).map((row) => ({ ...row, evidenceKind: 'mutation' as const }));

    // Cross-kind: a newer wider-source TEST rerun does NOT retire a mutation attempt.
    const testRerun = attempt(2, { sources: ['src/reconnect.ts', 'src/reporter.ts'] });
    expect(activeSpecEvidence([...mutationAttempt, ...testRerun])).toContain(mutationAttempt[1]!);

    // Same-kind: supersession DOES apply — and the survivor is itself a mutation row, so the
    // dropped binding is never the only mutation binding in the clause population.
    const newerMutation = attempt(2, { sources: ['src/reconnect.ts', 'src/reporter.ts'] }).map(
      (row) => ({ ...row, evidenceKind: 'mutation' as const }),
    );
    const sameKind = activeSpecEvidence([...mutationAttempt, ...newerMutation]);
    expect(sameKind).not.toContain(mutationAttempt[1]!);
    expect(sameKind.some((row) => row.evidenceKind === 'mutation')).toBe(true);

    // Corollary: the refusal never reports a bare absence while a selector-matching mutation
    // binding exists in the table.
    const result = evaluateSpecTestAdequacy({
      clause: clause({ requiredEvidence: ['integration test'] }),
      evidence: [...mutationAttempt, ...newerMutation],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings.falsifiability.evidence).not.toContain(
      'no mutation or counterexample binding is bound',
    );
  });

  it('never lets evidence for another revision establish traceability', () => {
    const historical = evidence({ specRevision: 0 });
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [historical],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings.traceability.rating).toBe('fail');
    expect(result.evidenceRefs).toEqual([]);
  });

  it('treats malformed untyped binding details as unknown instead of throwing or passing', () => {
    const malformed = evidence({
      details: {
        adequacy: {
          outcome: 42,
          collected: 'yes',
          skipped: 0,
          coverageRungs: { l3: 'true' },
        },
      },
    });
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [malformed],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings['execution-integrity'].rating).toBe('pass');
    expect(result.ratings['plan-class-risk-floor'].rating).toBe('unknown');
    expect(result.verdict).not.toBe('pass');
  });

  it('fails correct-layer until every canonical acceptance scenario has successful ledger-backed path proof', () => {
    const scenarioClause = clause({
      falsifier: {
        observation: 'Stale or wrong-subject context wins.',
        requiredScenarios: ['stale-vs-decision', 'wrong-subject-exclusion'],
      },
    });
    const baseAdequacy = evidence().details.adequacy as Record<string, unknown>;
    const staleDecision = evidence({
      evidenceRef: 'packages/operator-core/lib/history.test.ts#stale-vs-decision',
      details: { adequacy: { ...baseAdequacy, scenarioIds: ['stale-vs-decision'] } },
    });
    const incomplete = evaluateSpecTestAdequacy({
      clause: scenarioClause,
      evidence: [staleDecision],
      classRef: 'plan-class-feature-ship',
    });
    expect(incomplete.ratings['correct-layer'].rating).toBe('fail');
    expect(incomplete.ratings['correct-layer'].evidence).toContain('wrong-subject-exclusion');

    const wrongSubject = evidence({
      evidenceRef: 'packages/operator-core/lib/history.test.ts#wrong-subject-exclusion',
      details: { adequacy: { ...baseAdequacy, scenarioIds: ['wrong-subject-exclusion'] } },
    });
    const staleCase = 'history ignores stale decision context';
    const wrongSubjectCase = 'history excludes a different subject';
    const completeBinding = successfulTestBinding('packages/operator-core/lib/history.test.ts', {
      testCases: [staleCase, wrongSubjectCase],
      scenarioIds: ['stale-vs-decision', 'wrong-subject-exclusion'],
      scenarioTestCases: {
        'stale-vs-decision': [staleCase],
        'wrong-subject-exclusion': [wrongSubjectCase],
      },
    });
    const complete = evaluateSpecTestAdequacy({
      clause: scenarioClause,
      evidence: [staleDecision, wrongSubject, completeBinding],
      classRef: 'plan-class-feature-ship',
    });
    expect(complete.ratings['correct-layer'].rating).toBe('pass');
    expect(complete.ratings['correct-layer'].evidence).toContain('Every canonical acceptance scenario');
  });

  it('requires each canonical scenario to map to an exact passing test case', () => {
    const scenarioId = 'correlated-tool-error';
    const dispatchCase = 'preserves a throwing production dispatch handler and exports its correlated sanitized exception';
    const scenarioClause = clause({
      requiredTestLayers: ['unit'],
      falsifier: { observation: 'A production dispatch failure lacks its correlated exception.', requiredScenarios: [scenarioId] },
    });
    const exporterOnly = successfulTestBinding('packages/operator-core/lib/observability/posthog-exporter.test.ts', {
      layer: 'unit',
      testCases: ['sends model and tool errors to the configured project and capture destination'],
      scenarioIds: [scenarioId],
    });
    const exporterGrade = evaluateSpecTestAdequacy({
      clause: scenarioClause,
      evidence: [exporterOnly],
      classRef: 'plan-class-feature-ship',
    });
    expect(exporterGrade.ratings['correct-layer'].rating).toBe('fail');
    expect(exporterGrade.ratings['correct-layer'].evidence).toContain(scenarioId);

    const productionDispatch = successfulTestBinding('packages/operator-core/lib/observability/runtime.dispatch.test.ts', {
      layer: 'unit',
      testCases: [dispatchCase],
      scenarioIds: [scenarioId],
      scenarioTestCases: { [scenarioId]: [dispatchCase] },
    });
    const dispatchGrade = evaluateSpecTestAdequacy({
      clause: scenarioClause,
      evidence: [productionDispatch],
      classRef: 'plan-class-feature-ship',
    });
    expect(dispatchGrade.ratings['correct-layer'].rating).toBe('pass');
  });

  it('does not count unexecuted or unbacked scenario tags as scenario coverage', () => {
    const baseAdequacy = evidence().details.adequacy as Record<string, unknown>;
    const scenarioClause = clause({
      falsifier: { observation: 'The scenario is missed.', requiredScenarios: ['goal-auto-start'] },
    });
    const unbacked = evidence({
      evidenceRef: 'packages/operator-core/lib/history.test.ts#goal-auto-start',
      testRunId: null,
      coverageEvidenceRef: null,
      details: { adequacy: { ...baseAdequacy, scenarioIds: ['goal-auto-start'] } },
    });
    const result = evaluateSpecTestAdequacy({
      clause: scenarioClause,
      evidence: [unbacked],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings['correct-layer'].rating).toBe('fail');
    expect(result.ratings['execution-integrity'].rating).toBe('unknown');
  });

  it('requires exactly one successful negative and repaired recurrence binding per causal pair id', () => {
    const pairClause = clause({
      falsifier: {
        observation: 'The original failure recurs.',
        causalPairing: 'one-to-one',
      },
    });
    const baseAdequacy = evidence().details.adequacy as Record<string, unknown>;
    const testPath = 'packages/operator-core/lib/history.test.ts';
    const pairCaseTitle = 'reproduces the missing goal history failure';
    const negative = evidence({
      evidenceKind: 'counterexample',
      evidenceRef: 'packages/operator-core/lib/history.test.ts#before-missing-goal-history',
      testRunProvenance: {
        filePath: testPath,
        commitSha: 'abc123',
        worktreeDirty: false,
        source: 'mutation-probe',
        mutationPhase: 'mutant',
        mutationFailedCaseTitles: [pairCaseTitle],
      },
      testRunExecution: {
        status: 'fail',
        passed: 0,
        failed: 1,
        skipped: 0,
        collectionFailed: false,
        testLayer: 'integration',
      },
      details: {
        adequacy: {
          ...baseAdequacy,
          outcome: 'killed',
          causalPairIds: ['missing-goal-history'],
          testCases: [pairCaseTitle],
        },
      },
    });
    const withoutRecurrence = evaluateSpecTestAdequacy({
      clause: pairClause,
      evidence: [negative],
      classRef: 'plan-class-feature-ship',
    });
    expect(withoutRecurrence.ratings['execution-integrity'].rating).toBe('fail');
    expect(withoutRecurrence.ratings['execution-integrity'].evidence).toContain(
      'missing-goal-history:expected 1 recurrence binding, found 0',
    );

    const recurrence = evidence({
      evidenceKind: 'test',
      evidenceRef: 'packages/operator-core/lib/history.test.ts#after-missing-goal-history',
      testRunProvenance: {
        filePath: testPath,
        commitSha: 'abc123',
        worktreeDirty: false,
      },
      testRunExecution: {
        status: 'pass',
        passed: 1,
        failed: 0,
        skipped: 0,
        collectionFailed: false,
        testLayer: 'integration',
        passedCaseTitles: [pairCaseTitle],
      },
      details: {
        adequacy: {
          ...baseAdequacy,
          outcome: 'passed',
          causalPairIds: ['missing-goal-history'],
          testCases: [pairCaseTitle],
        },
      },
    });
    const complete = evaluateSpecTestAdequacy({
      clause: pairClause,
      evidence: [negative, recurrence],
      classRef: 'plan-class-feature-ship',
    });
    expect(complete.ratings['execution-integrity'].rating).toBe('pass');
    expect(complete.ratings['execution-integrity'].evidence).toContain('Every original failure has exactly one');
  });

  it('preserves separate causal pairs backed by the same whole-file recurrence run', () => {
    const pairs = ['missing-history', 'missing-recovery'];
    const pairClause = clause({ falsifier: {
      observation: 'Either original failure recurs.', causalPairing: 'one-to-one', requiredScenarios: pairs,
    } });
    const testPath = 'packages/operator-core/lib/history.test.ts';
    const baseAdequacy = evidence().details.adequacy as Record<string, unknown>;
    const negatives = pairs.map((pair, index) => evidence({
      id: 100 + index, evidenceKind: 'counterexample', evidenceRef: `${testPath}#before-${pair}`,
      testRunProvenance: { filePath: testPath, commitSha: 'abc123', worktreeDirty: false,
        source: 'mutation-probe', mutationPhase: 'mutant', mutationFailedCaseTitles: [pair] },
      testRunExecution: { status: 'fail', passed: 0, failed: 1, skipped: 0,
        collectionFailed: false, testLayer: 'integration' },
      details: { adequacy: { ...baseAdequacy, outcome: 'killed', targeted: pair,
        scenarioIds: [pair], causalPairIds: [pair], testCases: [pair] } },
    }));
    const recurrences = pairs.map((pair, index) => {
      const row = successfulTestBinding(testPath, { testCases: pairs });
      return { ...row, id: 200 + index, details: { adequacy: {
        ...(row.details.adequacy as object), causalPairIds: [pair], scenarioIds: [pair], testCases: [pair],
      } } };
    });
    for (const rows of [[...negatives, ...recurrences], [...recurrences, ...negatives].reverse()]) {
      const result = evaluateSpecTestAdequacy({ clause: pairClause, evidence: rows,
        classRef: 'plan-class-feature-ship' });
      expect(result.ratings['execution-integrity'].rating).toBe('pass');
      expect(result.ratings['execution-integrity'].evidence).toContain('Every original failure has exactly one');
    }
  });

  it('supersedes a corrected recurrence within its causal pair while retaining its sibling', () => {
    const base = successfulTestBinding('packages/operator-core/lib/history.test.ts');
    const recurrence = (id: number, pair: string, executed: boolean) => ({
      ...base, id, details: { adequacy: { ...(base.details.adequacy as object),
        causalPairIds: [pair], scenarioIds: [pair], executed } },
    });
    const older = recurrence(201, 'missing-history', false);
    const sibling = recurrence(202, 'missing-recovery', true);
    const corrected = recurrence(203, 'missing-history', true);
    expect(latestLogicalEvidence([older, sibling, corrected])).toEqual([sibling, corrected]);
    const active = activeSpecEvidence([older, sibling, corrected]);
    expect(active.map(row => row.id).sort()).toEqual([202, 203]);
    expect(active.find(row => row.id === 203)?.details.adequacy).toMatchObject({
      causalPairIds: ['missing-history'], executed: true,
    });
    expect(active.find(row => row.id === 202)?.details.adequacy).toMatchObject({
      causalPairIds: ['missing-recovery'],
    });
  });

  it('rejects a collapsed causal pair even when one row claims every required scenario', () => {
    const pairClause = clause({
      falsifier: {
        observation: 'Either original failure recurs.',
        requiredScenarios: ['missing-history', 'missing-recovery'],
        causalPairing: 'one-to-one',
      },
    });
    const baseAdequacy = evidence().details.adequacy as Record<string, unknown>;
    const negative = evidence({
      evidenceKind: 'counterexample',
      evidenceRef: 'packages/operator-core/lib/history.test.ts#before-missing-history',
      details: {
        adequacy: {
          ...baseAdequacy,
          outcome: 'killed',
          causalPairIds: ['missing-history'],
        },
      },
    });
    const collapsedBase = successfulTestBinding('packages/operator-core/lib/history.test.ts', {
      testCases: ['history regression case', 'recovery regression case'],
      scenarioIds: ['missing-history', 'missing-recovery'],
      scenarioTestCases: {
        'missing-history': ['history regression case'],
        'missing-recovery': ['recovery regression case'],
      },
    });
    const collapsedRecurrence: SpecEvidenceForAdequacy = {
      ...collapsedBase,
      details: {
        ...collapsedBase.details,
        adequacy: {
          ...(collapsedBase.details.adequacy as Record<string, unknown>),
          causalPairIds: ['missing-history'],
        },
      },
    };

    const result = evaluateSpecTestAdequacy({
      clause: pairClause,
      evidence: [negative, collapsedRecurrence, successfulTestBinding('packages/operator-core/lib/history.test.ts')],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['correct-layer'].rating).toBe('pass');
    expect(result.ratings['execution-integrity'].rating).toBe('fail');
    expect(result.ratings['execution-integrity'].evidence).toContain(
      'canonical causalPairId(s) missing: missing-recovery',
    );
  });

  it('rejects a killed outcome on the repaired recurrence side of a causal pair', () => {
    const pairClause = clause({
      falsifier: { observation: 'The original failure recurs.', causalPairing: 'one-to-one' },
    });
    const baseAdequacy = evidence().details.adequacy as Record<string, unknown>;
    const negative = evidence({
      evidenceKind: 'counterexample',
      evidenceRef: 'packages/operator-core/lib/history.test.ts#before-missing-goal-history',
      details: {
        adequacy: {
          ...baseAdequacy,
          outcome: 'killed',
          causalPairIds: ['missing-goal-history'],
        },
      },
    });
    const killedRecurrence = evidence({
      evidenceKind: 'test',
      evidenceRef: 'packages/operator-core/lib/history.test.ts#after-missing-goal-history',
      details: {
        adequacy: {
          ...baseAdequacy,
          outcome: 'killed',
          causalPairIds: ['missing-goal-history'],
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: pairClause,
      evidence: [negative, killedRecurrence],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['execution-integrity'].rating).toBe('fail');
    expect(result.ratings['execution-integrity'].evidence).toContain(
      'missing-goal-history:recurrence binding is not successful ledger-backed repaired proof',
    );
  });

  it('rejects a multi-pair row and orphan recurrence under a one-to-one contract', () => {
    const pairClause = clause({
      falsifier: { observation: 'Either original failure recurs.', causalPairing: 'one-to-one' },
    });
    const baseAdequacy = evidence().details.adequacy as Record<string, unknown>;
    const negative = evidence({
      evidenceKind: 'counterexample',
      evidenceRef: 'packages/operator-core/lib/history.test.ts#combined-before',
      details: {
        adequacy: {
          ...baseAdequacy,
          outcome: 'killed',
          causalPairIds: ['missing-history', 'missing-recovery'],
        },
      },
    });
    const orphan = evidence({
      evidenceKind: 'test',
      evidenceRef: 'packages/operator-core/lib/history.test.ts#orphan-after',
      details: {
        adequacy: {
          ...baseAdequacy,
          causalPairIds: ['unrelated-repair'],
        },
      },
    });
    const result = evaluateSpecTestAdequacy({
      clause: pairClause,
      evidence: [negative, orphan],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings['execution-integrity'].rating).toBe('fail');
    expect(result.ratings['execution-integrity'].evidence).toContain('expected exactly one causalPairId');
    expect(result.ratings['execution-integrity'].evidence).toContain(
      'unrelated-repair:expected 1 negative binding, found 0',
    );
  });
});

describe('rerunRecipe is submittable to its own evaluator', () => {
  it('pins certified fixture-absence verifier bindings in the replay population', () => {
    const base = evidence();
    const cited = evidence({
      id: 45649,
      evidenceKind: 'test',
      evidenceRef: 'test:fixture-free-proof',
      fingerprints: { ...base.fingerprints, fixtureFingerprint: null },
      details: {
        ...base.details,
        adequacy: {
          ...(base.details.adequacy as Record<string, unknown>),
          fixtureFree: true,
          fixtureCalibrated: undefined,
        },
      },
      fixtureAbsenceVerification: { verifierBindingIds: [45679] },
    });
    const verifier = evidence({
      id: 45679,
      evidenceKind: 'independent-verification',
      evidenceRef: 'verification:fixture-free-proof',
      fingerprints: { ...cited.fingerprints },
      details: {
        ...cited.details,
        adequacy: {
          ...(cited.details.adequacy as Record<string, unknown>),
          fixtureFree: true,
        },
      },
    });
    const original = evaluateSpecTestAdequacy({
      clause: clause({ requiredEvidence: ['tree'] }),
      // The shared reader can attach the certificate to the cited row while the
      // verifier is outside a caller's selected cohort.
      evidence: [cited],
      classRef: 'plan-class-feature-ship',
    });
    const recipe = original.scorecardDraft.rerunRecipe;

    expect(recipe.args.bindingIds).toEqual([45649, 45679]);
    expect(recipe.selection.bindingIds).toEqual([45649, 45679]);
    expect(original.ratings['fixture-calibration'].rating).toBe('not-applicable');

    const replayCited = { ...cited, fixtureAbsenceVerification: undefined };
    const replayWithoutVerifier = evaluateSpecTestAdequacy({
      clause: clause({ requiredEvidence: ['tree'] }),
      evidence: [replayCited],
      classRef: 'plan-class-feature-ship',
    });
    const replayWithRecipePopulation = evaluateSpecTestAdequacy({
      clause: clause({ requiredEvidence: ['tree'] }),
      evidence: [replayCited, verifier],
      fixtureAbsenceVerifications: new Map([[45649, [45679]]]),
      classRef: 'plan-class-feature-ship',
    });
    expect(replayWithoutVerifier.ratings['fixture-calibration'].rating).toBe('unknown');
    expect(replayWithRecipePopulation.ratings['fixture-calibration'].rating).toBe('not-applicable');
  });

  it('pins original same-kind binding ids when a later binding reuses the evidence ref', () => {
    const sharedRef = 'packages/operator-core/lib/doc-claims/bm25-config-doc.test.ts';
    const selectedTest = evidence({ id: 37383, evidenceKind: 'test', evidenceRef: sharedRef });
    const selectedMutation = evidence({
      id: 37384,
      evidenceKind: 'mutation',
      evidenceRef: 'test-run:mutation-probe:21069197',
    });
    const laterTest = evidence({ id: 37827, evidenceKind: 'test', evidenceRef: sharedRef });
    const selected = [selectedTest, selectedMutation];
    const current: EvidenceCurrentInput[] = selected.map((row) => ({
      evidenceKind: row.evidenceKind,
      evidenceRef: row.evidenceRef,
      ...row.fingerprints,
    }));

    const original = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: selected,
      current,
      harness: 'papercusp',
      classRef: 'plan-class-feature-ship',
    });
    const recipe = original.scorecardDraft.rerunRecipe;
    const args = evaluatorArgsSchema.parse(recipe.args);
    const availableLater = [...selected, laterTest];

    expect(args.evidenceRefs).toContain(sharedRef);
    expect(availableLater.filter((row) => args.evidenceRefs?.includes(row.evidenceRef)).map((row) => row.id))
      .toEqual([37383, 37384, 37827]);
    expect(args.bindingIds).toEqual([37383, 37384]);
    expect(recipe.selection.bindingIds).toEqual([37383, 37384]);
    expect(availableLater.filter((row) => args.bindingIds?.includes(row.id!)).map((row) => row.id))
      .toEqual([37383, 37384]);
  });

  it.each(['emitted', 'persisted'] as const)(
    '%s recipe preserves the full evidence population when current fingerprints are partial',
    (surface) => {
      const selected = evidence({ id: 18874, evidenceRef: 'surface:replacement' });
      const legacy = evidence({ id: 18924, evidenceRef: 'surface:rejected-legacy' });
      const current: EvidenceCurrentInput[] = [
        {
          evidenceKind: selected.evidenceKind,
          evidenceRef: selected.evidenceRef,
          ...selected.fingerprints,
        },
      ];
      // Re-run the store's real classifier, as a fresh tool call does. Reusing the
      // already-classified fixture would conceal a recipe that omitted `current`.
      const reload = (inputs?: EvidenceCurrentInput[]) =>
        [selected, legacy].map((row) => ({
          ...row,
          currentness: classifySpecEvidenceCurrentness(
            {
              spec_is_current: true,
              source_fingerprint: row.fingerprints.sourceFingerprint,
              test_fingerprint: row.fingerprints.testFingerprint,
              fixture_fingerprint: row.fingerprints.fixtureFingerprint,
              rubric_fingerprint: row.fingerprints.rubricFingerprint,
              environment_fingerprint: row.fingerprints.environmentFingerprint,
              coverage_evidence_ref: row.coverageEvidenceRef,
              coverage_evidence_present: true,
              test_run_id: row.testRunId,
              test_run_present: true,
            },
            inputs?.find((input) => input.evidenceKind === row.evidenceKind && input.evidenceRef === row.evidenceRef),
          ),
        }));
      const original = evaluateSpecTestAdequacy({
        clause: clause(),
        evidence: reload(current),
        harness: 'papercusp',
        current,
        classRef: 'plan-class-feature-ship',
      });
      const recipe =
        surface === 'emitted'
          ? original.scorecardDraft.rerunRecipe
          : asStructuredObservation({ rerunRecipe: original.scorecardDraft.rerunRecipe })?.rerunRecipe;
      expect(recipe).toBeDefined();
      const args = evaluatorArgsSchema.parse(recipe!.args);
      expect(args.harness).toBe('papercusp');
      expect(args.evidenceRefs).toEqual([legacy.evidenceRef, selected.evidenceRef].sort());
      expect(args.bindingIds).toEqual([18874, 18924]);
      expect(recipe!.selection.bindingIds).toEqual([18874, 18924]);
      const rerunCurrent = typeof args.current === 'boolean' ? undefined : Array.isArray(args.current)
        ? args.current
        : args.current?.supplied
          ? args.current.fingerprints
          : undefined;
      const rerun = evaluateSpecTestAdequacy({
        clause: clause(),
        evidence: reload(rerunCurrent),
        harness: args.harness,
        current: rerunCurrent,
        classRef: args.classRef!,
      });
      expect(original.evidenceRefs).toEqual([legacy.evidenceRef, selected.evidenceRef]);
      expect(rerun.evidenceRefs).toEqual(original.evidenceRefs);
      expect(rerun.ratings).toEqual(original.ratings);
      expect(rerun.verdict).toBe(original.verdict);
      const withoutFingerprints = evaluateSpecTestAdequacy({
        clause: clause(),
        evidence: reload(),
        classRef: args.classRef!,
      });
      expect(withoutFingerprints.evidenceRefs).toContain(legacy.evidenceRef);
      // Both paths retain the full exact population: the caller-supplied fingerprint
      // is attested-current for one binding, while the omitted binding is unknown.
      // The important distinction is that the missing binding remains visible rather
      // than allowing a partial input to manufacture a passing subset.
      expect(withoutFingerprints.verdict).toBe('unknown');
      expect(withoutFingerprints.ratings.freshness.evidence).toContain('current[] was omitted');
      expect(withoutFingerprints.ratings.freshness.evidence).toContain('not evidence that stored bindings are stale');
      expect(withoutFingerprints.ratings.freshness.evidence).toContain('rerunRecipe.current.fingerprints');
    },
  );

  it('preserves an explicitly empty currentness input through emission and readback', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [],
      current: [],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.scorecardDraft.rerunRecipe.args).toHaveProperty('current', []);
    expect(
      asStructuredObservation({ rerunRecipe: result.scorecardDraft.rerunRecipe })?.rerunRecipe?.args,
    ).toHaveProperty('current', []);
    const omitted = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [],
      classRef: 'plan-class-feature-ship',
    });
    expect(omitted.scorecardDraft.rerunRecipe.args).not.toHaveProperty('current');
    expect(
      asStructuredObservation({ rerunRecipe: omitted.scorecardDraft.rerunRecipe })?.rerunRecipe?.args,
    ).not.toHaveProperty('current');
  });

  it('preserves an explicitly empty binding-id selector through recipe readback', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [],
      harness: 'papercusp',
      classRef: 'plan-class-feature-ship',
      rerunSelection: { bindingIds: [] },
    });
    const recipe = result.scorecardDraft.rerunRecipe;
    expect(recipe.args.bindingIds).toEqual([]);
    expect(recipe.selection.bindingIds).toEqual([]);
    expect(evaluatorArgsSchema.parse(recipe.args).bindingIds).toEqual([]);
    const readback = asStructuredObservation({ rerunRecipe: recipe })?.rerunRecipe;
    expect(readback?.args.bindingIds).toEqual([]);
    expect(readback?.selection.bindingIds).toEqual([]);
  });

  it('pins an empty evidence population when a clause has no bindings', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [],
      harness: 'papercusp',
      classRef: 'plan-class-feature-ship',
    });
    const recipe = result.scorecardDraft.rerunRecipe;

    // Empty means "the grade saw no bindings", not "select every binding added later".
    expect(recipe.args.bindingIds).toEqual([]);
    expect(recipe.selection.bindingIds).toEqual([]);
    expect(evaluatorArgsSchema.parse(recipe.args).bindingIds).toEqual([]);
  });

  function recipeFor(classRef: 'plan-class-feature-ship' | 'plan-class-bugfix' = 'plan-class-feature-ship') {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence()],
      harness: 'papercusp',
      classRef,
    });
    const recipe = result.scorecardDraft?.rerunRecipe;
    if (!recipe) throw new Error('expected a scorecardDraft with a rerunRecipe');
    return recipe;
  }

  it('stamps each generated recipe with the loaded evaluator build identity', () => {
    const recipe = recipeFor();
    expect(recipe.evaluatorBuild).toEqual(getBuildInfo());
    expect(recipe.args.evaluatorBuild).toEqual(getBuildInfo());
  });

  it("records args that PARSE against the evaluator's own schema, classRef included", () => {
    const recipe = recipeFor();
    expect(recipe.evaluator).toBe('plans:evaluate-spec-test-adequacy');

    // Validated against the evaluator's REAL exported schema, not a copy of its field
    // names — a guard that restated the names would pass through the exact drift it
    // exists to catch.
    const parsed = evaluatorArgsSchema.safeParse(recipe.args);
    expect(parsed.success).toBe(true);

    expect(recipe.args.slug).toBe('reconnect-plan');
    expect(recipe.args.specIds).toEqual(['SPEC-003-01']);
    expect(recipe.args.evidenceRefs).toEqual(['surface:reconnect']);
    expect(recipe.args).toMatchObject({
      specRevision: 1,
      specFingerprint: 'sha256:spec-v1',
      replaySnapshot: true,
      limit: 25,
    });
    expect(recipe.args.includeDraft).toBe(true);
  });

  it('keeps exact immutable evidence selection on the shared card replay recipe', () => {
    const current: EvidenceCurrentInput[] = [
      {
        planSlug: 'reconnect-plan',
        specId: 'SPEC-003-01',
        specRevision: 1,
        specFingerprint: 'sha256:spec-v1',
        evidenceKind: 'coverage-census',
        evidenceRef: 'surface:reconnect',
        ...evidence().fingerprints,
      },
    ];
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence()],
      harness: 'papercusp',
      current,
      classRef: 'plan-class-bugfix',
      rerunSelection: { workItemIds: ['WI-101'] },
    });
    const recipe = result.scorecardDraft.rerunRecipe;
    const evidenceText = result.ratings.traceability.evidence;

    expect(evaluatorArgsSchema.safeParse(recipe.args).success).toBe(true);
    expect(recipe.args).toEqual(crossGenerationAuditProbeArgs(recipe));
    expect(evidenceText).toContain(
      'Replay the shared scorecard rerunRecipe (plans:evaluate-spec-test-adequacy) once with its stored args; inspect rows[0].ratings["traceability"] against the current evidence state. ' +
        'This replay remeasures currentness at replay time, so freshness-dependent ratings may differ from the emitted card after evidence changes. ' +
        'It is not a historical as-of replay; grading-integrity audits reconstruct the emitted card using its creation-time snapshot.',
    );
    expect(evidenceText).not.toContain('with args=');
    expect(Object.values(result.ratings).every((rating) => !rating.evidence.includes('with args='))).toBe(true);
    expect(recipe.args).toMatchObject({
      harness: 'papercusp',
      slug: 'reconnect-plan',
      classRef: 'plan-class-bugfix',
      specIds: ['SPEC-003-01'],
      workItemIds: ['WI-101'],
      evaluatorBuild: getBuildInfo(),
      evidenceRefs: ['surface:reconnect'],
      current,
      specRevision: 1,
      specFingerprint: 'sha256:spec-v1',
      replaySnapshot: true,
      includeDraft: true,
      limit: 25,
    });
  });

  it('carries the classRef the verdicts were produced under, so no re-runner has to guess', () => {
    // classRef is a four-value enum that moves plan-class-risk-floor, so a recipe that
    // omitted it let a wrong guess silently change the verdict being reproduced.
    expect(recipeFor('plan-class-feature-ship').classRef).toBe('plan-class-feature-ship');
    expect(recipeFor('plan-class-bugfix').classRef).toBe('plan-class-bugfix');
    expect(recipeFor('plan-class-bugfix').args.classRef).toBe('plan-class-bugfix');
  });

  it('CALIBRATION: rejects legacy selections and invalid classes while allowing class inference', () => {
    // Without this control the test above could pass against a schema that accepts
    // anything. `selection` is the shape the recipe used to publish as its only
    // payload; submitting it is what produced `invalid_args` in the field.
    const recipe = recipeFor();
    const legacy = evaluatorArgsSchema.safeParse(recipe.selection);
    expect(legacy.success).toBe(false);

    // A normal evaluation can derive its class from the persisted acceptance contract.
    // Immutable reruns still carry the resolved class; a made-up class remains invalid.
    const withoutClassRef = { slug: 'reconnect-plan', specIds: ['SPEC-003-01'] };
    expect(evaluatorArgsSchema.safeParse(withoutClassRef).success).toBe(true);
    expect(evaluatorArgsSchema.safeParse({ ...withoutClassRef, classRef: 'unknown-class' }).success).toBe(false);
  });
});

describe('disclosed-gap criterion (P-002: a disclosure cannot coexist with a machine PASS)', () => {
  it.each([
    'Lifecycle on real PG: links a fix only when its content is in the tested PR diff, one provider comment across retries, done transition and sync-back.',
    'The admission path admits a bug only when its reproduction test fails on the current build.',
    'The gate merges only if the tested commit has green checks.',
  ])('does not confuse a production safety condition with limited proof: %s', observations => {
    const base = evidence();
    const result = evaluateSpecTestAdequacy({ clause: clause(),
      evidence: [evidence({ details: { ...base.details, observations } })], classRef: 'plan-class-feature-ship' });
    expect(result.ratings['disclosed-gap'].rating).toBe('not-applicable');
    expect(result.wouldBlock).not.toContain('disclosed-gap');
  });

  it.each([
    'Links a fix only when it is in the tested PR diff, but only unit coverage is provided.',
    'The admission path admits only if the reproduction test fails. The failure path is not covered.',
    'The test only covers the happy path when the tested commit has green checks.',
    'The failure path is tested only when the provider is healthy.',
  ])('preserves real coverage limits beside conditional safety claims: %s', observations => {
    const base = evidence();
    const result = evaluateSpecTestAdequacy({ clause: clause(),
      evidence: [evidence({ details: { ...base.details, observations } })], classRef: 'plan-class-feature-ship' });
    expect(result.ratings['disclosed-gap'].rating).toBe('fail');
    expect(result.wouldBlock).toContain('disclosed-gap');
  });

  it('never exempts a conditional phrase in an explicit disclosedGap field', () => {
    const base = evidence();
    const result = evaluateSpecTestAdequacy({ clause: clause(),
      evidence: [evidence({ details: { ...base.details,
        disclosedGap: 'Links only when the tested diff contains the fix.' } })],
      classRef: 'plan-class-feature-ship' });
    expect(result.ratings['disclosed-gap'].rating).toBe('fail');
  });

  it.each([
    'Removing the ledger-only re-aim coverage disclosure fails the named R8 rendering case while all R7 calibration cases pass.',
    'The mutation changes a read-only coverage query and the guard catches the changed result.',
    'The path persists an append-only coverage record; the mutation guard rejects a dropped field.',
  ])('keeps technical compound modifiers out of gap classification: %s', observations => {
    const base = evidence();
    const result = evaluateSpecTestAdequacy({ clause: clause(),
      evidence: [evidence({ details: { ...base.details, observations } })], classRef: 'plan-class-feature-ship' });
    expect(result.ratings['disclosed-gap'].rating).toBe('not-applicable');
  });

  it.each([
    'Clean as-committed re-proof after P-016 at e0c02c627b (lint:as-committed --materialize-only root, worktree clean): same test file as the superseded binding.',
    'The probe ran with --dry-run-only and the same test fixture remained green.',
  ])('does not treat a CLI flag ending in -only as a coverage limitation: %s', observations => {
    const base = evidence();
    const result = evaluateSpecTestAdequacy({ clause: clause(),
      evidence: [evidence({ details: { ...base.details, observations } })], classRef: 'plan-class-feature-ship' });
    expect(result.ratings['disclosed-gap'].rating).toBe('not-applicable');
    expect(result.wouldBlock).not.toContain('disclosed-gap');
  });

  it.each([
    'The field-path case asserts that an empty and a whitespace-only notApplicable value is refused.',
    'The caught test title says add-only validated test selection and is not a coverage disclosure.',
  ])('does not treat a hyphenated -only adjective as a coverage limitation: %s', observations => {
    const base = evidence();
    const result = evaluateSpecTestAdequacy({ clause: clause(),
      evidence: [evidence({ details: { ...base.details, observations } })], classRef: 'plan-class-feature-ship' });
    expect(result.ratings['disclosed-gap'].rating).toBe('not-applicable');
    expect(result.wouldBlock).not.toContain('disclosed-gap');
  });

  it.each([
    'Client-only coverage leaves the broader proof incomplete.',
    'Ledger-only re-aim detection is measured. Only the happy path is covered.',
    'The read-only query is verified, but the failure path is not covered.',
  ])('still rejects an actual scope limitation beside technical modifiers: %s', observations => {
    const base = evidence();
    const result = evaluateSpecTestAdequacy({ clause: clause(),
      evidence: [evidence({ details: { ...base.details, observations } })], classRef: 'plan-class-feature-ship' });
    expect(result.ratings['disclosed-gap'].rating).toBe('fail');
  });

  it('never exempts a technical modifier in an explicit disclosedGap field', () => {
    const base = evidence();
    const result = evaluateSpecTestAdequacy({ clause: clause(),
      evidence: [evidence({ details: { ...base.details, disclosedGap: 'ledger-only coverage' } })],
      classRef: 'plan-class-feature-ship' });
    expect(result.ratings['disclosed-gap'].rating).toBe('fail');
  });

  it('rates not-applicable and stays out of wouldBlock when no binding discloses a gap', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence()],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['disclosed-gap'].rating).toBe('not-applicable');
    expect(result.ratings['disclosed-gap'].evidence).toContain('No bound proof');
    expect(result.wouldBlock).not.toContain('disclosed-gap');
  });

  it('surfaces free-form notes for review without treating them as structured disclosures', () => {
    const note = 'Only the staffing half is covered; blocker naming is not established.';
    const base = evidence();
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence({details: {...base.details, note}})],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['disclosed-gap'].rating).toBe('not-applicable');
    expect(result.ratings['disclosed-gap'].evidence).toContain('note=' + JSON.stringify(note));
    expect(result.ratings['disclosed-gap'].evidence).toContain(
      'Record any coverage limitation under details.adequacy.disclosedGap',
    );
    expect(result.wouldBlock).not.toContain('disclosed-gap');
  });

  it('labels universal notes by selected scope and truncates at a word boundary', () => {
    const longNote = 'Historical R7cleanup ownerauthorization ' + 'detail '.repeat(100);
    const noted = (id: number, note: string) => {
      const base = evidence({
        id,
        evidenceKind: 'test',
        evidenceRef: `test-run:${id}`,
        coverageEvidenceRef: null,
      });
      return { ...base, details: { ...base.details, note } };
    };
    const selected = [noted(41767, 'selected proof note'), noted(41777, 'selected companion note')];
    const other = [noted(41765, longNote), noted(41725, 'other current binding note')];
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: selected,
      disclosedGapEvidence: [...selected, ...other],
      classRef: 'plan-class-feature-ship',
    });

    const rendered = result.ratings['disclosed-gap'].evidence;
    expect(rendered).toContain('Checked 4 active binding(s) for the clause.');
    expect(rendered).toContain('id=41767 scope=selected note="selected proof note"');
    expect(rendered).toContain('id=41777 scope=selected note="selected companion note"');
    expect(rendered).toContain('id=41765 scope=other-current note=');
    expect(rendered).toContain('id=41725 scope=other-current note=');
    expect(rendered).toContain('detail…[truncated]');
    expect(rendered).not.toContain('detai…[truncated]');
  });

  it('blocks a proof whose observations explicitly limit coverage to one leg', () => {
    const base = evidence();
    const observations =
      'P-006 leg of R-15 only (the live app round trip with a non-Google provider): 9 passed, 2 skipped. ' +
      'The cutover legs of R-15 are mapped to P-011 and P-015.';
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence({ details: { ...base.details, observations } })],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['disclosed-gap'].rating).toBe('fail');
    expect(result.ratings['disclosed-gap'].evidence).toContain(observations);
    expect(result.wouldBlock).toContain('disclosed-gap');
    expect(result.verdict).toBe('fail');
  });

  it('does not treat ordinary observation prose as a coverage disclosure', () => {
    const base = evidence();
    const observations = 'The test only passes when provider credentials are valid and records duration in the run log.';
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence({ details: { ...base.details, observations } })],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['disclosed-gap'].rating).toBe('not-applicable');
    expect(result.wouldBlock).not.toContain('disclosed-gap');
  });

  it.each([
    'The private overlay forces complete:true/warnings:[] only at the single-source coverage result.',
    'The mutant only changes the coverage flag; the paired positive retains the full input inventory.',
    'The negative control only replaces the coverage metadata before the assertions read it.',
  ])('keeps technical coverage-result mechanics separate from a proof gap: %s', (observations) => {
    const base = evidence();
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence({ details: { ...base.details, observations } })],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings['disclosed-gap'].rating).toBe('not-applicable');
    expect(result.wouldBlock).not.toContain('disclosed-gap');
  });

  it.each([
    'The proof supplies only unit coverage.',
    'The mutant only changes the coverage result. The proof only tests partial sources; unauthorized refusal is not covered.',
  ])('still blocks a real proof limitation beside technical coverage mechanics: %s', (observations) => {
    const base = evidence();
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence({ details: { ...base.details, observations } })],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings['disclosed-gap'].rating).toBe('fail');
    expect(result.wouldBlock).toContain('disclosed-gap');
  });

  it('does not treat evidence supersession scope as a proof coverage limitation', () => {
    const base = evidence();
    const observations = 'replace stale31980 only in the same test subject';
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence({ details: { ...base.details, observations } })],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['disclosed-gap'].rating).toBe('not-applicable');
    expect(result.wouldBlock).not.toContain('disclosed-gap');
  });

  it('still blocks a real partial-proof limitation beside evidence supersession scope', () => {
    const base = evidence();
    const observations =
      'replace stale31980 only in the same test subject. ' +
      'The proof only tests partial sources; unauthorized refusal is not covered.';
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence({ details: { ...base.details, observations } })],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['disclosed-gap'].rating).toBe('fail');
    expect(result.ratings['disclosed-gap'].evidence).toContain(observations);
    expect(result.wouldBlock).toContain('disclosed-gap');
  });

  it.each([
    'Recipe pins only the three actual captured expiry source files and the calibrated seeded test/fixture.',
    'The input inventory contains only production sources and test/expiry.integration.test.ts.',
    'The input inventory contains only production sources and test\\fixture.ts.',
    'The input inventory contains only production sources and test.ts.',
  ])('does not turn a qualified test noun in an input inventory into a proof gap: %s', (scope) => {
    const row = successfulTestBinding('expiry.integration.test.ts');
    row.details.observations = { scope };
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [row],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['disclosed-gap'].rating).toBe('not-applicable');
    expect(result.wouldBlock).not.toContain('disclosed-gap');
    expect(supersedeEligibilityGaps(row)).toEqual([]);
  });

  it.each([
    'The proof only tests the expiry transition.',
    'We only test the expiry transition.',
    'Recipe pins only sources and test/fixture. The proof only tests the expiry transition.',
    'Recipe pins only sources and test/fixture; reply transitions are not covered.',
  ])('retains a real proof gap beside input inventory wording: %s', (scope) => {
    const row = successfulTestBinding('expiry.integration.test.ts');
    row.details.observations = { scope };
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [row],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['disclosed-gap'].rating).toBe('fail');
    expect(supersedeEligibilityGaps(row)).toContain('an author-disclosed gap is recorded');
  });

  it('retains an explicit gap even when its text is a qualified test noun', () => {
    const row = successfulTestBinding('expiry.integration.test.ts');
    row.details.adequacy = { ...row.details.adequacy as Record<string, unknown>, disclosedGap: 'test/fixture' };
    expect(supersedeEligibilityGaps(row)).toContain('an author-disclosed gap is recorded');
  });

  it.each([
    'R3 acceptance floor and verifier independence subsection only. Scope parity, cancellation, retirement and proposal routing require separate current proof.',
    'R3 receipt validation unit subsection only; other R3 behavior needs independent maintained bindings.',
    'Scope parity controls; not whole R3 operational adoption.',
  ])('blocks an explicit scopeNote proof gap: %s', (scopeNote) => {
    const base = evidence();
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence({ details: { ...base.details, scopeNote } })],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings['disclosed-gap'].rating).toBe('fail');
    expect(result.ratings['disclosed-gap'].evidence).toContain(scopeNote);
    expect(result.wouldBlock).toContain('disclosed-gap');
    expect(result.verdict).toBe('fail');
  });

  it('preserves a same-proof disclosure moved into scopeNote even without nested adequacy', () => {
    const base = evidence();
    const scopeNote = 'Reconnect path only covers the single-subscriber case.';
    const original = evidence({ id: 23752, createdAt: '2026-10-03T12:53:27.000Z',
      details: { ...base.details, scopeNote } });
    const rebound = evidence({ id: 23763, createdAt: '2026-10-03T13:07:22.000Z',
      details: { scopeNote } });
    const result = evaluateSpecTestAdequacy({
      clause: clause(), evidence: [original, rebound], classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings['disclosed-gap'].rating).toBe('fail');
    expect(result.ratings['disclosed-gap'].evidence).toContain(scopeNote);
  });

  it.each([
    'R3 receipt validation current-source component; complete R3 composite acceptance is pending the retirement renewal and clause-scoped falsifiability. Original disclosures remain live.',
    'R3 composite acceptance remains pending current retirement proof and clause-scoped falsifiability.',
    'Current receipt cases pass. Original disclosures remain live.',
    'Coverage remains incomplete until the cancellation retry is exercised.',
  ])('blocks pending proof or unresolved disclosure in scopeNote: %s', (scopeNote) => {
    const base = evidence();
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence({ details: { ...base.details, scopeNote } })],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings['disclosed-gap'].rating).toBe('fail');
    expect(result.ratings['disclosed-gap'].evidence).toContain(scopeNote);
    expect(result.wouldBlock).toContain('disclosed-gap');
    expect(result.verdict).toBe('fail');
  });

  it('retains a pending-proof disclosure when unchanged proof is rebound without it', () => {
    const base = evidence();
    const scopeNote = 'R3 composite acceptance remains pending retirement proof.';
    const original = evidence({ id: 32219, createdAt: '2026-10-09T03:20:00.000Z',
      details: { ...base.details, scopeNote } });
    const rebound = evidence({ id: 32252, createdAt: '2026-10-09T04:00:00.000Z',
      details: { ...base.details, scopeNote: 'Composite proof recorded.' } });
    const result = evaluateSpecTestAdequacy({
      clause: clause(), evidence: [original, rebound], classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings['disclosed-gap'].rating).toBe('fail');
    expect(result.ratings['disclosed-gap'].evidence).toContain(scopeNote);
    expect(result.wouldBlock).toContain('disclosed-gap');
  });

  it.each([
    { originalDisclosure: 'R3 composite acceptance remains pending retirement proof. Original disclosures remain live.' },
    { proofBoundary: { sourceCapture: 'Producer integration remains a separate requirement.' } },
    { audit: { originalDisclosure: ['Coverage remains incomplete until cancellation is exercised.'] } },
    { customCoverageBoundary: { remaining: 'The proof only tests the single-subscriber case.' } },
  ])('blocks proof gaps in free-form disclosure-bearing metadata: %j', (metadata) => {
    const base = evidence();
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence({ details: { ...base.details, ...metadata } })],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings['disclosed-gap'].rating).toBe('fail');
    expect(result.wouldBlock).toContain('disclosed-gap');
    expect(result.verdict).toBe('fail');
  });

  it('retains a same-proof disclosure stored outside scopeNote after another metadata rebind', () => {
    const base = evidence();
    const originalDisclosure = 'R3 composite acceptance remains pending retirement proof.';
    const original = evidence({ id: 32297, createdAt: '2026-10-09T04:58:00.000Z',
      details: { ...base.details, originalDisclosure } });
    const rebound = evidence({ id: 32303, createdAt: '2026-10-09T05:05:00.000Z',
      details: { ...base.details, scopeNote: 'Composite proof recorded.' } });
    const result = evaluateSpecTestAdequacy({
      clause: clause(), evidence: [original, rebound], classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings['disclosed-gap'].rating).toBe('fail');
    expect(result.ratings['disclosed-gap'].evidence).toContain(originalDisclosure);
    expect(result.wouldBlock).toContain('disclosed-gap');
  });

  it('keeps historical references and parent-plane boundaries distinct from a live proof gap', () => {
    const base = evidence();
    const result = evaluateSpecTestAdequacy({
      clause: clause(), evidence: [evidence({ details: { ...base.details,
        originalDisclosure: 'Original disclosures are preserved in the supersession audit; changed proof closes their tree-clause gaps.',
        historicalDisclosureRef: 'thread-post:1167321',
        proofBoundary: { sourceCapture: 'Named source/test footprint; full transitive import graph unmeasured.',
          shipment: 'Operational adoption and exact shipment remain open on the parent plan.' },
      } })], classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings['disclosed-gap'].rating).toBe('not-applicable');
    expect(result.wouldBlock).not.toContain('disclosed-gap');
  });

  it.each([
    'Named source/test footprint only; full transitive import graph unmeasured.',
    'The test only passes when provider credentials are valid and records duration in the run log.',
    'No independent operational shipment claim; canonical suite and fixture identity retained.',
    'Tree clause proof is complete; operational adoption and final shipment remain open on the parent plan.',
    'Original disclosures are preserved in the supersession audit; changed proof closes their tree-clause gaps.',
  ])('keeps bookkeeping scopeNote separate from an explicit proof gap: %s', (scopeNote) => {
    const base = evidence();
    const result = evaluateSpecTestAdequacy({
      clause: clause(), evidence: [evidence({ details: { ...base.details, scopeNote } })],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings['disclosed-gap'].rating).toBe('not-applicable');
    expect(result.wouldBlock).not.toContain('disclosed-gap');
  });

  it('does not treat a resolved proof reference as an open gap, while preserving an adjacent live limitation', () => {
    const base = evidence();
    const resolved =
      'The exact live dossier gap was resolved by separate CURRENT live binding34743; only test-run20987792 is cited as its durable proof reference.';
    const stillOpen = `${resolved} The cancellation retry is not covered.`;
    const resolvedResult = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence({ details: { ...base.details, scopeNote: resolved } })],
      classRef: 'plan-class-feature-ship',
    });
    const openResult = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence({ details: { ...base.details, scopeNote: stillOpen } })],
      classRef: 'plan-class-feature-ship',
    });

    expect(resolvedResult.ratings['disclosed-gap'].rating).toBe('not-applicable');
    expect(resolvedResult.wouldBlock).not.toContain('disclosed-gap');
    expect(openResult.ratings['disclosed-gap'].rating).toBe('fail');
    expect(openResult.ratings['disclosed-gap'].evidence).toContain(stillOpen);
    expect(openResult.wouldBlock).toContain('disclosed-gap');
  });

  it.each([
    ['scope', 'Mocked unit adapter calls pass; actual producer integration remains a separate requirement.'],
    ['proofScope', 'Mocked unit adapter calls pass; actual producer integration remains a separate requirement.'],
    ['notes', ['Mocked unit adapter calls pass; actual producer integration remains a separate requirement.']],
  ] as const)(
    'blocks a structured observations.%s disclosure that leaves producer integration as a separate requirement',
    (field, disclosure) => {
      const base = evidence();
      const disclosureText = Array.isArray(disclosure) ? disclosure[0] : disclosure;
      const result = evaluateSpecTestAdequacy({
        clause: clause(),
        evidence: [evidence({ details: { ...base.details, observations: { [field]: disclosure } } })],
        classRef: 'plan-class-feature-ship',
      });

      expect(result.ratings['disclosed-gap'].rating).toBe('fail');
      expect(result.ratings['disclosed-gap'].evidence).toContain(disclosureText);
      expect(result.wouldBlock).toContain('disclosed-gap');
      expect(result.verdict).toBe('fail');
    },
  );

  it('fails the clause and names the gap text when the disclosure is nested under adequacy', () => {
    const base = evidence();
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [
        evidence({
          details: {
            adequacy: {
              ...(base.details.adequacy as Record<string, unknown>),
              disclosedGap: 'reconnect path is only covered for the single-subscriber case',
            },
          },
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['disclosed-gap'].rating).toBe('fail');
    expect(result.ratings['disclosed-gap'].evidence).toContain(
      'reconnect path is only covered for the single-subscriber case',
    );
    expect(result.wouldBlock).toContain('disclosed-gap');
    expect(result.verdict).toBe('fail');
  });

  it('fails on a TOP-LEVEL disclosure too, which the binder accepts without error', () => {
    // plans:bind-spec-evidence takes a free-form `details` object, so `details.disclosedGap`
    // is written with no complaint. Reading only the nested spelling would silently drop
    // exactly the disclosure this criterion exists to catch.
    const base = evidence();
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [
        evidence({
          details: { ...base.details, disclosedGap: ['fixture pins a stubbed clock'] },
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['disclosed-gap'].rating).toBe('fail');
    expect(result.ratings['disclosed-gap'].evidence).toContain('fixture pins a stubbed clock');
    expect(result.wouldBlock).toContain('disclosed-gap');
  });

  it.each([
    ['limitation', 'The hosted-VM run is deferred; R-4 remains degraded until it lands.'],
    ['limitations', ['The hosted-VM run is deferred; R-4 remains degraded until it lands.']],
  ] as const)(
    'blocks an explicit disclosure stored in top-level details.%s',
    (field, disclosure) => {
      const base = evidence();
      const result = evaluateSpecTestAdequacy({
        clause: clause(),
        evidence: [evidence({ details: { ...base.details, [field]: disclosure } })],
        classRef: 'plan-class-feature-ship',
      });

      expect(result.ratings['disclosed-gap'].rating).toBe('fail');
      expect(result.ratings['disclosed-gap'].evidence).toContain(
        'The hosted-VM run is deferred; R-4 remains degraded until it lands.',
      );
      expect(result.wouldBlock).toContain('disclosed-gap');
      expect(result.verdict).toBe('fail');
    },
  );

  it('keeps a disclosure when the same proof is rebound without its disclosedGap', () => {
    const base = evidence();
    const gap = 'commercial metering remains outside approved scope';
    const original = evidence({
      id: 23753,
      createdAt: '2026-10-03T12:53:27.000Z',
      details: {
        ...base.details,
        adequacy: { ...(base.details.adequacy as Record<string, unknown>), disclosedGap: [gap] },
      },
    });
    const rebound = evidence({
      id: 23762,
      createdAt: '2026-10-03T13:07:22.000Z',
      details: { ...base.details },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [original, rebound],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['disclosed-gap'].rating).toBe('fail');
    expect(result.ratings['disclosed-gap'].evidence).toContain(gap);
    expect(result.wouldBlock).toContain('disclosed-gap');
  });

  it('reconciles same-proof cases across bare, describe-prefixed, and space-joined titles', () => {
    const bareTitle = 'executes intake and summarization in the managed job and retains its actual result';
    const prefixedTitle = `background content summary through registered execution primitives > ${bareTitle}`;
    const spaceJoinedTitle = `background content summary through registered execution primitives ${bareTitle}`;
    const filePath = 'packages/operator-core/lib/background-summary.integration.test.ts';
    const base = successfulTestBinding(filePath, { testCases: [prefixedTitle] });
    const baseAdequacy = base.details.adequacy as Record<string, unknown>;
    const bareBinding = {
      ...base,
      id: 32191,
      createdAt: '2026-10-03T12:53:27.000Z',
      details: {
        ...base.details,
        adequacy: { ...baseAdequacy, testCases: [bareTitle] },
      },
    };
    const prefixedBinding = {
      ...base,
      id: 32199,
      createdAt: '2026-10-03T13:07:22.000Z',
      details: {
        ...base.details,
        adequacy: { ...baseAdequacy, testCases: [prefixedTitle] },
      },
    };
    const spaceJoinedBinding = {
      ...base,
      id: 32200,
      createdAt: '2026-10-03T13:12:22.000Z',
      details: {
        ...base.details,
        adequacy: { ...baseAdequacy, testCases: [spaceJoinedTitle] },
      },
    };

    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [bareBinding, prefixedBinding, spaceJoinedBinding],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['execution-integrity'].rating).toBe('pass');
    expect(result.ratings['correct-layer'].rating).toBe('pass');
    expect(result.ratings['correct-layer'].evidence).toContain('sameProofMetadataBindingIds=[32191,32199,32200]');
    const reconciledTitles = JSON.stringify([prefixedTitle, spaceJoinedTitle, bareTitle].sort((a, b) => a.localeCompare(b)));
    expect(result.ratings['correct-layer'].evidence).toContain(`"declared":${reconciledTitles}`);
    expect(result.ratings['correct-layer'].evidence).toContain(`"passed":${reconciledTitles},"missing":[]`);
  });

  it('preserves same-proof scenario coverage across rebinds and pins every source binding in reruns', () => {
    const electedLossCase = 'elected leader loss selects the recovery path';
    const reconnectCase = DEFAULT_MUTATION_TEST_CASE;
    const base = successfulTestBinding(CASE_SCOPED_TEST_PATH, {
      testCases: [electedLossCase, reconnectCase],
    });
    const baseAdequacy = base.details.adequacy as Record<string, unknown>;
    const earlier = {
      ...base,
      id: 23753,
      evidenceRef: 'test-run-group:27fc109b-8102-46c5-b201-23068af16109:0',
      createdAt: '2026-10-03T12:53:27.000Z',
      details: {
        ...base.details,
        adequacy: {
          ...baseAdequacy,
          pathReachable: true,
          scenarioIds: ['elected-loss-recovery', RECONNECT_FALSIFIER_SCENARIO],
          scenarioTestCases: {
            'elected-loss-recovery': [electedLossCase],
            [RECONNECT_FALSIFIER_SCENARIO]: [reconnectCase],
          },
        },
      },
    };
    const rebound = {
      ...base,
      id: 23762,
      evidenceRef: earlier.evidenceRef,
      createdAt: '2026-10-03T13:07:22.000Z',
      details: {
        ...base.details,
        adequacy: {
          ...baseAdequacy,
          pathReachable: true,
          scenarioIds: ['elected-loss-recovery'],
          scenarioTestCases: { 'elected-loss-recovery': [electedLossCase] },
        },
      },
    };
    const scenarioClause = clause({
      falsifier: {
        observation: 'Both outcomes from this unchanged test run are represented.',
        requiredScenarios: ['elected-loss-recovery', RECONNECT_FALSIFIER_SCENARIO],
      },
    });

    const sameProof = evaluateSpecTestAdequacy({
      clause: scenarioClause,
      evidence: [earlier, rebound],
      classRef: 'plan-class-feature-ship',
    });
    expect(sameProof.ratings['correct-layer'].rating).toBe('pass');
    expect(sameProof.ratings['correct-layer'].evidence).toContain('Every canonical acceptance scenario');
    expect(sameProof.ratings['correct-layer'].evidence).toContain(RECONNECT_FALSIFIER_SCENARIO);
    expect(sameProof.ratings['correct-layer'].evidence).toContain('sameProofMetadataBindingIds=[23753,23762]');
    expect(sameProof.scorecardDraft.rerunRecipe.args.bindingIds).toEqual([23753, 23762]);

    const newRun = evaluateSpecTestAdequacy({
      clause: scenarioClause,
      evidence: [earlier, { ...rebound, id: 23763, testRunId: 44 }],
      classRef: 'plan-class-feature-ship',
    });
    expect(newRun.ratings['correct-layer'].rating).toBe('fail');
    expect(newRun.ratings['correct-layer'].evidence).toContain(RECONNECT_FALSIFIER_SCENARIO);
    expect(newRun.scorecardDraft.rerunRecipe.args.bindingIds).toEqual([23763]);
  });

  it.each([
    ['a new test run', evidence({ testRunId: 44 })],
    ['a new source fingerprint', evidence({ fingerprints: { ...evidence().fingerprints, sourceFingerprint: 'git:def' } })],
  ])('allows %s to close an older disclosure', (_label, freshProof) => {
    const base = evidence();
    const original = evidence({
      id: 23753,
      createdAt: '2026-10-03T12:53:27.000Z',
      details: {
        ...base.details,
        adequacy: {
          ...(base.details.adequacy as Record<string, unknown>),
          disclosedGap: ['commercial metering remains outside approved scope'],
        },
      },
    });
    const fresh = evidence({
      ...freshProof,
      id: 23762,
      createdAt: '2026-10-03T13:07:22.000Z',
      details: { ...base.details },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [original, fresh],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['disclosed-gap'].rating).toBe('not-applicable');
    expect(result.wouldBlock).not.toContain('disclosed-gap');
  });

  it('does not treat a blank or whitespace-only disclosure as a disclosure', () => {
    const base = evidence();
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [
        evidence({
          details: {
            adequacy: { ...(base.details.adequacy as Record<string, unknown>), disclosedGap: ['   ', ''] },
          },
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['disclosed-gap'].rating).toBe('not-applicable');
    expect(result.wouldBlock).not.toContain('disclosed-gap');
  });
});

// EI-23793489732627099 — the non-code exemption used to reach ONLY plan-class-risk-floor.
//
// How this survived is worth recording, because the guard that should have caught it
// existed and passed: 'does not assign an executable proof floor to the canonical
// non-code task kind' asserts `requiredProofFloor === 'none'` and the single
// plan-class-risk-floor rating, then stops. That is exactly the half that WORKED. The
// promise a reader takes from its name — that non-code work is not blocked by executable
// proof — was never asserted, and the verdict it implies was 'unknown' the whole time.
// So these tests assert the END-TO-END verdict, which is the thing that was actually
// broken and the only assertion that could have failed.
describe('non-code clauses can reach an all-pass verdict (EI-23793489732627099)', () => {
  /** The most complete binding NON-CODE work can honestly produce: no ledger run, no coverage row. */
  function operationalEvidence(over: Partial<SpecEvidenceForAdequacy> = {}): SpecEvidenceForAdequacy {
    return evidence({
      evidenceKind: 'operational',
      evidenceRef: 'work-item:WI-10002010',
      coverageEvidenceRef: null,
      testRunId: null,
      fingerprints: {
        sourceFingerprint: 'git:abc',
        testFingerprint: null,
        fixtureFingerprint: null,
        rubricFingerprint: null,
        environmentFingerprint: null,
      },
      details: {
        adequacy: {
          fixtureCalibrated: true,
          fixtureFree: true,
          falsifiable: true,
          pathReachable: true,
          oracleIndependent: true,
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'passed',
          targeted: true,
        },
      },
      ...over,
    });
  }

  /** A clause describing non-code work: no required test layer, not automatable. */
  const nonCodeClause = clause({
    behavior: 'Every deferred filing reaches a recorded disposition.',
    behaviorClass: 'non-automated',
    requiredTestLayers: [],
    requiredEvidence: ['recorded disposition'],
  });

  it('reaches verdict pass with honest operational evidence and nothing ledger-backed', () => {
    const result = evaluateSpecTestAdequacy({
      clause: nonCodeClause,
      evidence: [operationalEvidence()],
      classRef: 'plan-class-bugfix',
      workItemKind: 'task',
    });

    expect(result.requiredProofFloor).toBe('none');
    // The assertion the original guard was missing.
    expect(result.verdict).toBe('pass');
    expect(result.wouldBlock).toEqual([]);
    expect(result.ratings.falsifiability.rating).toBe('not-applicable');
    expect(result.ratings['execution-integrity'].rating).toBe('not-applicable');
    // The exemption must SAY it applied, so a reader is never left guessing why a
    // criterion that normally demands a ledger row came back clean.
    expect(result.ratings.falsifiability.evidence).toContain("requiredProofFloor='none'");
  });

  // The safety boundary, and the reason this is scoped to 'unknown' alone. 'unknown'
  // means the criterion could not be ESTABLISHED, which for non-code work is structural.
  // 'fail' means bound evidence positively reports something bad — that is real
  // information about real evidence, and no exemption may grade it away.
  it('still blocks when bound evidence positively reports failure, exemption or not', () => {
    const contradicted = operationalEvidence({
      details: {
        adequacy: {
          fixtureCalibrated: true,
          falsifiable: false,
          pathReachable: true,
          oracleIndependent: true,
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'passed',
          targeted: true,
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: nonCodeClause,
      evidence: [contradicted],
      classRef: 'plan-class-bugfix',
      workItemKind: 'task',
    });

    expect(result.requiredProofFloor).toBe('none');
    expect(result.ratings.falsifiability.rating).toBe('fail');
    expect(result.wouldBlock).toContain('falsifiability');
    expect(result.verdict).toBe('fail');
  });

  it('still blocks a stale binding, which is a fail rather than an unestablished unknown', () => {
    const stale = operationalEvidence({
      currentness: {
        comparisonSupplied: true,
        provenance: 'server-measured',
        overall: 'stale',
        dimensions: {
          spec: 'current',
          source: 'stale',
          test: 'current',
          fixture: 'current',
          rubric: 'current',
          environment: 'current',
          coverageEvidence: 'current',
          testRun: 'current',
        },
        staleReasons: ['source moved since observation'],
        unknownReasons: [],
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: nonCodeClause,
      evidence: [stale],
      classRef: 'plan-class-bugfix',
      workItemKind: 'task',
    });

    expect(result.requiredProofFloor).toBe('none');
    expect(result.ratings.freshness.rating).toBe('fail');
    expect(result.wouldBlock).toContain('freshness');
  });

  // NEGATIVE CONTROL. Without this, every assertion above is satisfiable by an
  // evaluator that simply stopped grading executable proof for everyone — which would
  // be a far worse bug than the one being fixed, and would look identical from the
  // passing tests alone.
  it('does NOT exempt code work: an executable floor still demands ledger-backed proof', () => {
    const codeClause = clause({ behaviorClass: 'happy-path', requiredTestLayers: ['integration'] });

    const result = evaluateSpecTestAdequacy({
      clause: codeClause,
      evidence: [operationalEvidence()],
      classRef: 'plan-class-feature-ship',
      workItemKind: 'change',
    });

    expect(result.requiredProofFloor).not.toBe('none');
    expect(result.ratings['execution-integrity'].rating).not.toBe('not-applicable');
    expect(result.verdict).not.toBe('pass');
  });

  // EI-23958122348412546 — the SAME exemption, one level deeper, and the case every test
  // above structurally COULD NOT reach. All of them bind `operational`, which IS an
  // EXECUTABLE_EVIDENCE_KIND, so `executable.length` was always >= 1 and execution-integrity
  // always rated 'unknown' — the one rating the exemption was scoped to. Declared honestly as
  // `manual`, non-code evidence yields ZERO executable rows, execution-integrity rated a bare
  // 'fail', and the exemption skipped it. The clause blocked plan ship with no reachable
  // repair: verbatim the failure EI-23793489732627099 above says it fixed.
  //
  // This is why the fix is `absenceOnly` rather than "also downgrade 'fail'": the rating alone
  // cannot distinguish "no executable artifact exists, by nature" from "the artifact exists and
  // reports something bad", and only the first is exemptible.
  /** What non-code work produces when it declares its kind HONESTLY: zero executable rows. */
  function manualEvidence(over: Partial<SpecEvidenceForAdequacy> = {}): SpecEvidenceForAdequacy {
    return operationalEvidence({ evidenceKind: 'manual', ...over });
  }

  it('reaches verdict pass with honest MANUAL evidence, which binds zero executable rows', () => {
    const result = evaluateSpecTestAdequacy({
      clause: nonCodeClause,
      evidence: [manualEvidence()],
      classRef: 'plan-class-bugfix',
      workItemKind: 'task',
    });

    expect(result.requiredProofFloor).toBe('none');
    expect(result.verdict).toBe('pass');
    expect(result.wouldBlock).toEqual([]);
    expect(result.ratings['execution-integrity'].rating).toBe('not-applicable');
    // The exemption must SAY it downgraded a fail, and say which kind of fail — otherwise a
    // reader cannot tell this clean result from one that graded adverse evidence away.
    expect(result.ratings['execution-integrity'].evidence).toContain('absence of executable proof');
  });

  // THE INVERTED INCENTIVE, asserted directly rather than implied. Before the fix the WEAKER
  // binding passed and the HONEST one failed: `operational` with author-attested booleans and
  // no ledger anchor rated 'unknown' and was exempted, while `manual` rated 'fail' and was not.
  // An author was rewarded for overstating the kind of evidence they held. Asserting the two
  // together is what makes that asymmetry a test failure rather than a judgement call.
  it('does not rank honest manual evidence BELOW a weaker unanchored executable row', () => {
    const args = { clause: nonCodeClause, classRef: 'plan-class-bugfix', workItemKind: 'task' } as const;
    const honest = evaluateSpecTestAdequacy({ ...args, evidence: [manualEvidence()] });
    const overstated = evaluateSpecTestAdequacy({ ...args, evidence: [operationalEvidence()] });

    expect(overstated.verdict).toBe('pass');
    expect(honest.verdict).toBe('pass');
    expect(honest.wouldBlock).toEqual(overstated.wouldBlock);
  });

  // SAFETY BOUNDARY for the WIDENED exemption. The block above proved a 'fail' from
  // falsifiable=false still blocks; this proves the same for a failed OUTCOME, which reaches
  // execution-integrity through `explicitBadExecution` — the branch that must never set
  // `absenceOnly`. Without this, widening the exemption to 'fail' could quietly grade away
  // every adverse execution result, and the passing tests above would look identical.
  it('still blocks a FAILED outcome on an executable row — that fail is not absence-shaped', () => {
    const failed = operationalEvidence({
      testRunId: 99,
      testRunExecution: {
        status: 'fail',
        passed: 0,
        failed: 1,
        skipped: 0,
        collectionFailed: false,
      },
      details: {
        adequacy: {
          fixtureCalibrated: true,
          falsifiable: true,
          pathReachable: true,
          oracleIndependent: true,
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'failed',
          targeted: true,
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: nonCodeClause,
      evidence: [failed],
      classRef: 'plan-class-bugfix',
      workItemKind: 'task',
    });

    expect(result.requiredProofFloor).toBe('none');
    expect(result.ratings['execution-integrity'].rating).toBe('fail');
    expect(result.wouldBlock).toContain('execution-integrity');
    expect(result.verdict).not.toBe('pass');
  });
});

// plan-verification-profiles-2026-10-17 P-004 (R-10, D-009). A requirement BAR declares at least
// one test layer unless its check is explicitly manual, so a general plan's clause usually carries
// one. The resolver's non-code verdict must then lift BOTH the executable-proof floor AND layer
// reachability: a test layer names where a CODE test runs, and a non-code deliverable has none.
describe('a non-code deliverable is graded without code-test layers (plan-verification-profiles P-004)', () => {
  // requiredEvidence names no fixture: the default clause's 'integration fixture' declares fixture
  // use, which (correctly) makes fixture calibration applicable whatever the deliverable is.
  const layered = clause({
    behaviorClass: 'happy-path', requiredTestLayers: ['integration'], requiredEvidence: ['reviewed runbook'],
  });
  function manualRow(over: Partial<SpecEvidenceForAdequacy> = {}): SpecEvidenceForAdequacy {
    return evidence({
      evidenceKind: 'manual',
      evidenceRef: 'work-item:WI-10002010',
      coverageEvidenceRef: null,
      testRunId: null,
      fingerprints: {
        sourceFingerprint: 'git:abc', testFingerprint: null, fixtureFingerprint: null,
        rubricFingerprint: null, environmentFingerprint: null,
      },
      // No fixtureFree attestation: binder-authored fixture absence is never trusted, and honest
      // non-code evidence binds no fixture-dependent proof, so fixture calibration is n/a on its own.
      details: {
        adequacy: {
          fixtureCalibrated: true, falsifiable: true, pathReachable: true,
          oracleIndependent: true, collected: true, skipped: false, executed: true, outcome: 'passed', targeted: true,
        },
      },
      ...over,
    });
  }

  it('passes a layered clause on manual evidence when the resolver says non-code', () => {
    const result = evaluateSpecTestAdequacy({
      clause: layered, evidence: [manualRow()], classRef: 'plan-class-feature-ship', codeDeliverable: false,
    });
    expect(result.requiredProofFloor).toBe('none');
    expect(result.ratings['correct-layer'].rating).toBe('not-applicable');
    expect(result.ratings['correct-layer'].evidence).toContain('non-code deliverable');
    expect(result.wouldBlock).toEqual([]);
    expect(result.verdict).toBe('pass');
  });

  // NEGATIVE CONTROL: the same clause and evidence for a code deliverable still owes a test of
  // the declared layer, so the case above is the resolver's doing and not a weaker evaluator.
  it('control: the same clause and evidence for a code deliverable does not pass', () => {
    const result = evaluateSpecTestAdequacy({
      clause: layered, evidence: [manualRow()], classRef: 'plan-class-feature-ship', codeDeliverable: true,
    });
    expect(result.requiredProofFloor).not.toBe('none');
    expect(result.ratings['correct-layer'].rating).not.toBe('not-applicable');
    expect(result.verdict).not.toBe('pass');
  });

  // D-005 fail-safe: an unread deliverable (null/absent) is code, never an exemption.
  it('treats an unread deliverable as code', () => {
    for (const codeDeliverable of [null, undefined]) {
      const result = evaluateSpecTestAdequacy({
        clause: layered, evidence: [manualRow()], classRef: 'plan-class-feature-ship', codeDeliverable,
      });
      expect(result.ratings['correct-layer'].rating, String(codeDeliverable)).not.toBe('not-applicable');
      expect(result.verdict, String(codeDeliverable)).not.toBe('pass');
    }
  });

  // The layer exemption must not grade away adverse evidence elsewhere: a falsifiable=false
  // report still blocks a non-code deliverable, exactly as it does for a non-code task kind.
  it('still blocks adverse evidence on a non-code deliverable', () => {
    const contradicted = manualRow({
      details: {
        adequacy: {
          fixtureCalibrated: true, falsifiable: false, pathReachable: true, oracleIndependent: true,
          collected: true, skipped: false, executed: true, outcome: 'passed', targeted: true,
        },
      },
    });
    const result = evaluateSpecTestAdequacy({
      clause: layered, evidence: [contradicted], classRef: 'plan-class-feature-ship', codeDeliverable: false,
    });
    expect(result.ratings.falsifiability.rating).toBe('fail');
    expect(result.verdict).toBe('fail');
  });
});

// EI-23499682118230306 recurrence guard — the SAME drift class as EI-13292, one pair up.
// `ADEQUACY_CRITERIA` (what the evaluator RATES) and rubrics/spec-test-adequacy/rubric.json
// (what the rubric DECLARES) are two copies of one list, and they silently diverged: the
// evaluator gained `disclosed-gap` while the bundle stayed at 8 keys, so scorecards:emit
// refused the evaluator's OWN scorecardDraft with "unexpected criterion key(s): disclosed-gap"
// — no spec-test-adequacy card could be emitted AT ALL for a clause with a disclosed gap.
// Pin the bundle to the evaluator's own list so the two can never silently diverge again.
// review-system-rework-reduction-2026-09-23 P-002 spec C. An amendment that changes only a
// clause's test layers or check re-projects it and CARRIES its bindings onto the new
// revision verbatim (carryUnchangedBarEvidenceBindings copies `details`). The carried row
// must be judged against the NEW revision's layers, never pass on its old ones.
describe('a carried binding is re-validated against the new clause revision (P-002 C)', () => {
  it('passes at the old layers and fails correct-layer once a layers-only amendment raises them', () => {
    const carriedRow = successfulTestBinding('test/reconnect.integration.test.ts');
    const before = evaluateSpecTestAdequacy({
      clause: clause(), evidence: [carriedRow], classRef: 'plan-class-feature-ship',
    });
    expect(before.ratings['correct-layer'].rating).toBe('pass');

    const raised = clause({
      revision: 2, currentRevision: 2, contentHash: 'sha256:spec-v2', requiredTestLayers: ['integration', 'e2e'],
    });
    const carried = { ...carriedRow, specRevision: 2, specFingerprint: 'sha256:spec-v2' };
    const after = evaluateSpecTestAdequacy({ clause: raised, evidence: [carried], classRef: 'plan-class-feature-ship' });

    expect(after.ratings['correct-layer'].rating).toBe('fail');
  });
});

describe('spec-test-adequacy rubric bundle', () => {
  it('declares exactly the criteria the evaluator rates (EI-23499682118230306)', () => {
    const bundled = resolveLocalRubric('spec-test-adequacy');
    expect(bundled, 'rubrics/spec-test-adequacy/rubric.json must resolve').not.toBeNull();

    const declared = bundled!.criteria.map((c) => c.key);
    // Order-insensitive: emit compares key SETS, so a reorder is not drift.
    expect([...declared].sort()).toEqual([...ADEQUACY_CRITERIA].sort());
  });
});
