import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcceptanceBarContractSnapshot, AcceptanceBarTrace } from './acceptance-bar-contract-snapshot';
import { readAcceptanceBarContractSnapshot } from './acceptance-bar-contract-snapshot';
import {
  evaluateAcceptanceBarContract,
  evaluateAcceptanceBarLifecycle,
  readAndEvaluateAcceptanceBarLifecycle,
} from './acceptance-bar-lifecycle-evaluator';
import { deriveNonCodeItemProofs } from './plan-requirement-realization';

vi.mock('./acceptance-bar-contract-snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./acceptance-bar-contract-snapshot')>()),
  readAcceptanceBarContractSnapshot: vi.fn(),
}));

function bar(overrides: Partial<AcceptanceBarTrace> = {}): AcceptanceBarTrace {
  return {
    barKey: 'R-1',
    criterionKey: 'r-1',
    barHash: 'a'.repeat(64),
    model: 'The outcome is true.',
    method: '',
    check: null,
    replication: null,
    falsifier: 'The outcome is absent.',
    role: 'outcome',
    mandatory: true,
    requiredScope: ['tree'],
    evidencePlane: 'tree',
    passRatings: ['healthy'],
    coversBarKeys: [],
    provenance: {
      lifecycle: 'pre-implementation',
      declaredAt: '2026-09-04T12:00:00.000Z',
      declaredBy: 'su-author',
    },
    mappings: [
      {
        planItemId: 'P-001',
        planItemStatus: 'todo',
        specId: 'spec-1',
        specRevision: 1,
        specContentHash: 'spec-hash',
        sourceBarHash: 'a'.repeat(64),
        sourceBarSetHash: 'b'.repeat(64),
        sourceRubricRevision: 1,
        evidencePlane: 'tree',
      },
    ],
    workContracts: [
      {
        workItemId: 'WI-1',
        specId: 'spec-1',
        specRevision: 1,
        specFingerprint: 'spec-hash',
        current: true,
      },
    ],
    proof: {
      state: 'missing',
      currentEvidence: 0,
      staleEvidence: 0,
      kinds: [],
      evidenceRefs: [],
      uncertainEvidence: 0,
      evidencePlanes: [],
    },
    grading: {
      state: 'missing',
      scorecardId: null,
      rubricRevision: null,
      gradedBy: null,
      selectedVia: null,
      rating: null,
      evidence: null,
    },
    readiness: {
      state: 'ready',
      codes: [],
      mapping: 'live',
      method: 'missing',
      workContract: 'current',
    },
    ...overrides,
  };
}

function snapshot(overrides: Partial<AcceptanceBarContractSnapshot> = {}): AcceptanceBarContractSnapshot {
  const trace = bar();
  return {
    schemaVersion: 1,
    contentHash: 'c'.repeat(64),
    planSlug: 'plan-a',
    applicable: true,
    plan: {
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'plan-a',
      status: 'active',
      revision: 1,
      contentHash: 'plan-content',
      adoptionEpoch: 1,
      cohort: 'post-epoch',
      barSetHash: 'b'.repeat(64),
      rubricSlug: 'acceptance-plan-a',
      rubricRevision: 1,
      seededAt: '2026-09-04T12:00:00.000Z',
      seededBy: 'su-author',
    },
    rubric: {
      rubricId: 'acceptance-plan-a',
      revision: 1,
      criteriaHash: 'criteria',
      barSetHash: 'b'.repeat(64),
      contract: {
        schemaVersion: 1,
        adoptionEpoch: 1,
        cohort: 'post-epoch',
        subjectPlanRevision: 1,
        seededAt: '2026-09-04T12:00:00.000Z',
        seededBy: 'su-author',
      },
      createdBy: 'su-author',
      ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
      classRef: null,
    },
    sourceRevisions: { subjectPlan: 1, rubricPlan: 1, clauses: [], workContracts: [], scorecardIds: [] },
    bounded: {
      plans: { rowsRead: 1, limit: 1, truncated: false },
      rubrics: { rowsRead: 1, limit: 2, truncated: false },
      planItems: { rowsRead: 1, limit: 500, truncated: false },
      clauses: { rowsRead: 1, limit: 1000, truncated: false },
      workContracts: { rowsRead: 1, limit: 1000, truncated: false },
      evidence: { rowsRead: 0, limit: 2000, truncated: false },
      scorecards: { rowsRead: 0, limit: 50, truncated: false },
      vetting: { rowsRead: 0, limit: 50, truncated: false },
      lineage: { rowsRead: 1, limit: 1000, truncated: false },
    },
    completeness: { complete: true, truncated: false, problems: [] },
    lineage: { identities: ['su-impl'], parties: [], complete: true },
    grading: {
      authoritativeScorecardId: null,
      gradedBy: null,
      selectedVia: null,
      rubricRevision: null,
      vetting: { state: 'missing', scorecardId: null, rubricRevision: null },
      authorVerdict: { state: 'missing', scorecardId: null, verdict: null },
    },
    bars: [trace],
    readiness: { state: 'ready', codes: [], nextRepair: null },
    ...overrides,
  };
}

// review-system-rework-reduction-2026-09-23 P-003/P-029: plans:start demands a complete
// METHOD/check/layer contract while it can still be supplied without discarding proof.
describe('start-door contract completeness (requireCompleteContractBeforeProof)', () => {
  const unrefined = snapshot(); // METHOD '', check null, no layers, no proof bound

  it('leaves the shared pre-start phase unchanged when the option is not requested', () => {
    const verdict = evaluateAcceptanceBarLifecycle(unrefined, 'pre-start');
    expect(verdict.codes).not.toContain('bar_snapshot_method_missing');
    expect(verdict.contractGaps).toBeUndefined();
  });

  it('blocks an unrefined contract before any proof is bound, with a field-level repair', () => {
    const verdict = evaluateAcceptanceBarLifecycle(unrefined, 'pre-start', { requireCompleteContractBeforeProof: true });
    expect(verdict.satisfied).toBe(false);
    expect(verdict.contractGapsBlocking).toBe(true);
    expect(verdict.blockingBars).toEqual([
      {
        barKey: 'R-1',
        codes: expect.arrayContaining([
          'bar_snapshot_method_missing',
          'bar_snapshot_check_missing',
          'bar_snapshot_proof_depth_missing',
        ]),
        contract: 'automated',
      },
    ]);
    expect(verdict.nextRepair?.action).toContain('METHOD is empty');
    expect(verdict.nextRepair?.action).toContain('rubrics:amend');
  });

  it('maps a check that contradicts its layers to check_invalid (the rubrics:amend repair)', () => {
    const manualWithLayers = snapshot({
      bars: [bar({ method: 'Read the report.', check: { kind: 'instrument', instrumentKey: 'none' },
        requiredTestLayers: ['e2e'] })],
    });
    const verdict = evaluateAcceptanceBarLifecycle(manualWithLayers, 'pre-start', { requireCompleteContractBeforeProof: true });
    expect(verdict.blockingBars[0]?.codes).toContain('bar_snapshot_check_invalid');
    expect(verdict.contractGaps?.map((gap) => gap.gap)).toEqual(['check_layer_mismatch']);
  });

  it('reports but does not block once proof is bound — refusing then would only strand in-flight work', () => {
    const proven = snapshot({
      bars: [bar({ proof: { ...bar().proof, state: 'current', currentEvidence: 1 } })],
    });
    const verdict = evaluateAcceptanceBarLifecycle(proven, 'pre-start', { requireCompleteContractBeforeProof: true });
    expect(verdict.contractGapsBlocking).toBe(false);
    expect(verdict.contractGaps?.length).toBeGreaterThan(0);
    expect(verdict.codes).not.toContain('bar_snapshot_method_missing');
  });
});

describe('readAndEvaluateAcceptanceBarLifecycle — authoritative applicability', () => {
  beforeEach(() => vi.mocked(readAcceptanceBarContractSnapshot).mockReset());

  const phases = ['pre-start', 'pre-vetting', 'pre-grading', 'ship'] as const;
  it.each([false, true])('forwards bounded read diagnostics without changing the verdict (read unavailable: %s)', async unavailable => {
    const value = snapshot(unavailable ? {
      completeness: { complete: false, truncated: false, problems: [{
        code: 'bar_snapshot_source_unavailable', source: 'plan', severity: 'error', detail: 'plan read unavailable',
      }] },
    } : {});
    vi.mocked(readAcceptanceBarContractSnapshot).mockResolvedValue(value);
    const onRead = vi.fn();
    const observed = await readAndEvaluateAcceptanceBarLifecycle('plan-a', 'pre-start', {
      harnessSlug: 'project', proofMode: 'metadata', onRead,
    });
    expect(readAcceptanceBarContractSnapshot).toHaveBeenCalledWith('plan-a', {}, {
      current: undefined, harnessSlug: 'project', proofMode: 'metadata', onRead,
    });
    expect(observed).toEqual(await readAndEvaluateAcceptanceBarLifecycle('plan-a', 'pre-start', {
      harnessSlug: 'project', proofMode: 'metadata',
    }));
    if (unavailable) expect(observed).toMatchObject({ satisfied: false });
  });
  const failures = [
    { code: 'bar_snapshot_plan_missing', planPresent: false },
    { code: 'bar_snapshot_source_unavailable', planPresent: false },
    { code: 'bar_snapshot_source_unavailable', planPresent: true },
    { code: 'bar_snapshot_plan_ambiguous', planPresent: true },
    { code: 'bar_snapshot_source_truncated', planPresent: true },
  ] as const;

  for (const phase of phases) {
    it.each(failures)(`${phase} refuses $code (plan present: $planPresent) without a caller assertion`, async ({
      code,
      planPresent,
    }) => {
      const value = snapshot({
        applicable: false,
        plan: planPresent ? { ...snapshot().plan!, adoptionEpoch: null } : null,
        completeness: {
          complete: false,
          truncated: code === 'bar_snapshot_source_truncated',
          problems: [{ code, source: 'plan', severity: 'error', detail: 'subject plan cannot be resolved reliably' }],
        },
      });
      vi.mocked(readAcceptanceBarContractSnapshot).mockResolvedValue(value);

      const result = await readAndEvaluateAcceptanceBarLifecycle('plan-a', phase);
      expect(result).toMatchObject({ applicable: true, satisfied: false });
      expect(result.contractCodes).toContain(code);
      expect(value.applicable).toBe(false);
      expect(readAcceptanceBarContractSnapshot).toHaveBeenCalledWith('plan-a', {}, { current: undefined });
    });

    it(`${phase} preserves the positively known legacy bypass`, async () => {
      vi.mocked(readAcceptanceBarContractSnapshot).mockResolvedValue(snapshot({
        applicable: false,
        plan: { ...snapshot().plan!, adoptionEpoch: null },
        completeness: {
          complete: false,
          truncated: false,
          problems: [{
            code: 'bar_snapshot_source_unavailable',
            source: 'rubric',
            severity: 'error',
            detail: 'a legacy plan does not require BAR rubric reads',
          }],
        },
      }));
      expect(await readAndEvaluateAcceptanceBarLifecycle('plan-a', phase))
        .toMatchObject({ applicable: false, satisfied: true, codes: [] });
    });
  }

  it('preserves an explicit adoption assertion when the second read fails', async () => {
    vi.mocked(readAcceptanceBarContractSnapshot).mockResolvedValue(snapshot({
      applicable: false,
      plan: null,
      completeness: {
        complete: false,
        truncated: false,
        problems: [{
          code: 'bar_snapshot_source_unavailable', source: 'plan', severity: 'error', detail: 'read failed',
        }],
      },
    }));
    const result = await readAndEvaluateAcceptanceBarLifecycle('plan-a', 'pre-start', { expectedApplicable: true });
    expect(result.satisfied).toBe(false);
    expect(result.contractCodes).toContain('bar_snapshot_source_unavailable');
  });

  it('allows a ready adopted plan through the normal evaluator', async () => {
    vi.mocked(readAcceptanceBarContractSnapshot).mockResolvedValue(snapshot());
    expect(await readAndEvaluateAcceptanceBarLifecycle('plan-a', 'pre-start'))
      .toMatchObject({ applicable: true, satisfied: true, codes: [] });
  });

  it('cannot reuse a contract-only snapshot for grading, shipping or operational realization', async () => {
    const supplied = snapshot({ proofMeasured: false });
    expect(evaluateAcceptanceBarLifecycle(supplied, 'pre-start').satisfied).toBe(true);
    for (const phase of ['pre-grading', 'ship'] as const) {
      expect(evaluateAcceptanceBarLifecycle(supplied, phase)).toMatchObject({ satisfied: false,
        codes: expect.arrayContaining(['bar_snapshot_proof_uncertain']) });
    }
    const read = await readAndEvaluateAcceptanceBarLifecycle('plan-a', 'pre-start', { snapshot: supplied });
    expect(read.nonCodeItemProofs).toEqual([]);
    expect(readAcceptanceBarContractSnapshot).not.toHaveBeenCalled();
  });

  it('evaluates a supplied snapshot without starting another BAR read', async () => {
    const supplied = snapshot();

    const result = await readAndEvaluateAcceptanceBarLifecycle('plan-a', 'ship', {
      snapshot: supplied,
    });

    expect(result).toMatchObject({ applicable: true, phase: 'ship' });
    expect(readAcceptanceBarContractSnapshot).not.toHaveBeenCalled();
  });
});

describe('operational realization from the canonical BAR snapshot', () => {
  function proven(): AcceptanceBarContractSnapshot {
    const s = snapshot();
    const b = s.bars[0]!;
    b.evidencePlane = 'live';
    b.requiredTestLayers = ['operational'];
    b.mappings[0]!.planItemStatus = 'done';
    b.mappings[0]!.evidencePlane = 'live';
    b.proof = {
      state: 'current', currentEvidence: 1, staleEvidence: 0, uncertainEvidence: 0,
      kinds: ['operational'], evidenceRefs: ['probe:current'], evidencePlanes: ['live'],
      adequacy: { state: 'pass', checks: [{ specId: 'spec-1', revision: 1, verdict: 'pass',
        wouldBlock: [], evidenceRefs: ['probe:current'] }] },
      history: [{ id: 1, workItemId: 'WI-1', specId: 'spec-1', specRevision: 1,
        specFingerprint: 'spec-hash', evidenceKind: 'operational', evidenceRef: 'probe:current',
        testRunId: null, observedAt: '2026-09-06T00:00:00Z',
        createdAt: '2026-09-06T00:00:00Z', createdBy: 'su-grader',
        details: { evidencePlane: 'live' }, matchesCurrentSpec: true,
        currentness: { overall: 'current', comparisonSupplied: true, staleReasons: [], unknownReasons: [],
          dimensions: { spec: 'current', source: 'current', environment: 'current', test: 'not-applicable',
            fixture: 'not-applicable', rubric: 'not-applicable', coverageEvidence: 'not-applicable', testRun: 'not-applicable' } },
      }],
    };
    return s;
  }

  it.each(['operational', 'check'] as const)('derives exact %s proof before grading exists', (kind) => {
    const s = proven();
    s.bars[0]!.proof.history![0]!.evidenceKind = kind;
    expect(deriveNonCodeItemProofs(s)).toEqual([
      { planItemId: 'P-001', barKeys: ['R-1'], evidenceRefs: ['probe:current'] },
    ]);
  });

  it.each(['operational', 'check'] as const)(
    'retains the canonical %s observation ref when mechanical adequacy names separate tests', (kind) => {
      const s = proven();
      const bar = s.bars[0]!;
      bar.check = { kind: 'tests', files: ['unit.test.ts', 'public.e2e.test.ts'] };
      bar.requiredTestLayers = ['unit', 'e2e'];
      bar.proof.adequacy!.checks[0]!.evidenceRefs = [
        'unit.test.ts', 'public.e2e.test.ts', 'test-run 42 caught mutant unit.test.ts',
      ];
      const row = bar.proof.history![0]!;
      row.evidenceKind = kind;
      row.evidenceRef = 'test-run 43 operational check retained-public-census';
      row.testRunId = 43;
      row.currentness.provenance = 'server-measured';
      expect(deriveNonCodeItemProofs(s)).toEqual([
        { planItemId: 'P-001', barKeys: ['R-1'],
          evidenceRefs: ['test-run 43 operational check retained-public-census'] },
      ]);
    },
  );

  it.each(['live', 'deployed'] as const)('realizes nested %s plane proof and rejects a mismatched plane', (plane) => {
    const s = proven();
    const bar = s.bars[0]!;
    bar.evidencePlane = plane;
    bar.mappings[0]!.evidencePlane = plane;
    const row = bar.proof.history![0]!;
    row.details = { adequacy: { evidencePlane: plane } };
    expect(deriveNonCodeItemProofs(s)).toEqual([
      { planItemId: 'P-001', barKeys: ['R-1'], evidenceRefs: ['probe:current'] },
    ]);
    row.details = { adequacy: { evidencePlane: 'tree' } };
    expect(deriveNonCodeItemProofs(s)).toEqual([]);
  });

  const gaps: Array<[string, (s: AcceptanceBarContractSnapshot) => void]> = [
    ['incomplete snapshot', s => { s.completeness.complete = false; }],
    ['truncated snapshot', s => { s.completeness.truncated = true; }],
    ['unknown currentness', s => { s.bars[0]!.proof.history![0]!.currentness.overall = 'unknown'; }],
    ['stale currentness', s => { s.bars[0]!.proof.history![0]!.currentness.overall = 'stale'; }],
    ['no comparison', s => { s.bars[0]!.proof.history![0]!.currentness.comparisonSupplied = false; }],
    ['missing evidence', s => { s.bars[0]!.proof.history = []; }],
    ['mere manual claim', s => { s.bars[0]!.proof.history![0]!.evidenceKind = 'manual'; }],
    ['wrong evidence plane', s => { s.bars[0]!.proof.history![0]!.details.evidencePlane = 'tree'; }],
    ['wrong spec revision', s => { s.bars[0]!.proof.history![0]!.specRevision = 2; }],
    ['wrong spec fingerprint', s => { s.bars[0]!.proof.history![0]!.specFingerprint = 'old'; }],
    ['wrong BAR hash', s => { s.bars[0]!.mappings[0]!.sourceBarHash = 'old'; }],
    ['no current work contract', s => { s.bars[0]!.workContracts[0]!.current = false; }],
    ['wrong adequacy revision', s => { s.bars[0]!.proof.adequacy!.checks[0]!.revision = 2; }],
    ['unknown adequacy', s => { s.bars[0]!.proof.adequacy!.checks[0]!.verdict = 'unknown'; }],
    ['missing depth contract', s => { s.bars[0]!.requiredTestLayers = []; }],
    ['dropped target', s => { s.bars[0]!.mappings[0]!.planItemStatus = 'dropped'; }],
  ];
  it.each(gaps)('refuses %s', (_name, change) => {
    const s = proven();
    change(s);
    expect(deriveNonCodeItemProofs(s)).toEqual([]);
  });

  it.each(gaps)('keeps separate operational refs fail-closed with %s', (_name, change) => {
    const s = proven();
    s.bars[0]!.proof.adequacy!.checks[0]!.evidenceRefs = ['named-public.e2e.test.ts'];
    change(s);
    expect(deriveNonCodeItemProofs(s)).toEqual([]);
  });

  // review-system-rework-reduction P-001: an amendment keeps an UNCHANGED bar's clause
  // at its revision, so the clause legitimately carries the set hash and rubric revision
  // it was projected under. Refusing it for that (the pre-P-001 rule) re-created the
  // churn P-001 removes. Its own bar hash still has to match — see 'wrong BAR hash'.
  it.each([
    ['an older BAR set', (s: AcceptanceBarContractSnapshot) => { s.bars[0]!.mappings[0]!.sourceBarSetHash = 'old'; }],
    ['an older rubric revision', (s: AcceptanceBarContractSnapshot) => { s.bars[0]!.mappings[0]!.sourceRubricRevision = 2; }],
  ])('keeps a clause projected under %s current when its own bar hash matches', (_name, change) => {
    const s = proven();
    change(s);
    expect(deriveNonCodeItemProofs(s).map(p => p.planItemId)).toEqual(['P-001']);
  });

  it('does not let a passing sibling spec prove a different item', () => {
    const s = proven();
    s.bars[0]!.mappings.push({ ...s.bars[0]!.mappings[0]!, planItemId: 'P-002', specId: 'spec-2' });
    expect(deriveNonCodeItemProofs(s).map(p => p.planItemId)).toEqual(['P-001']);
  });

  it('requires every BAR projection for the item to have exact proof', () => {
    const s = proven();
    s.bars.push({ ...s.bars[0]!, barKey: 'R-2', proof: { ...s.bars[0]!.proof, history: [] } });
    expect(deriveNonCodeItemProofs(s)).toEqual([]);
  });

  // WI-10003864: `bar.mappings` lists every clause row keyed to a BAR, draft and retired ones
  // included, but the snapshot proves ENFORCEABLE clauses only. Demanding proof of a mapping
  // no evidence can ever satisfy made any plan that atomized or retired a clause unshippable.
  describe('non-enforceable clause projections', () => {
    /** A second BAR owned by P-001 whose only projection has NO proof at all. */
    function withUnprovenSibling(lifecycleStatus?: AcceptanceBarContractSnapshot['bars'][number]['mappings'][number]['lifecycleStatus']) {
      const s = proven();
      const base = s.bars[0]!;
      s.bars.push({
        ...base,
        barKey: 'R-2',
        // A fresh array: the spread above would otherwise SHARE R-1's mapping objects.
        mappings: [{ ...base.mappings[0]!, specId: 'spec-2', lifecycleStatus }],
        proof: { ...base.proof, history: [], adequacy: { state: 'pass', checks: [] } },
      });
      return s;
    }

    it.each(['draft', 'retired', 'superseded', 'exempt'] as const)(
      'does not demand proof of a %s projection on another BAR', (status) => {
        expect(deriveNonCodeItemProofs(withUnprovenSibling(status))).toEqual([
          { planItemId: 'P-001', barKeys: ['R-1'], evidenceRefs: ['probe:current'] },
        ]);
      });

    // The measured case: an atomized parent clause stays `draft` on the SAME BAR as its
    // enforceable children, and has no adequacy check of its own.
    it('does not demand proof of a draft parent clause on the same BAR', () => {
      const s = proven();
      s.bars[0]!.mappings.push({ ...s.bars[0]!.mappings[0]!, specId: 'spec-parent', lifecycleStatus: 'draft' });
      expect(deriveNonCodeItemProofs(s)).toEqual([
        { planItemId: 'P-001', barKeys: ['R-1'], evidenceRefs: ['probe:current'] },
      ]);
    });

    // Falsifiability: the skip is lifecycle-exact. An enforceable sibling is still judged.
    it.each(['accepted', 'active'] as const)('still demands proof of an unproven %s projection', (status) => {
      expect(deriveNonCodeItemProofs(withUnprovenSibling(status))).toEqual([]);
    });

    it('fails closed on a projection with no recorded lifecycle (a pre-field snapshot)', () => {
      expect(deriveNonCodeItemProofs(withUnprovenSibling(undefined))).toEqual([]);
    });

    it('gives no proof to an item whose every projection is non-enforceable', () => {
      const s = proven();
      s.bars[0]!.mappings[0]!.lifecycleStatus = 'retired';
      expect(deriveNonCodeItemProofs(s)).toEqual([]);
    });
  });

  // WI-10002089: the contract gate grew an `explicitlyManual` escape hatch, but this gate
  // never learned about it, so a manual BAR passed contract readiness and was then refused
  // here on the exact values that hatch produces — unshippable by construction.
  describe('an explicitly manual BAR', () => {
    function manualProven(): AcceptanceBarContractSnapshot {
      const s = proven();
      const b = s.bars[0]!;
      // Precisely what the projection emits for a criterion declaring no instrument: zero
      // layers, which FORCES adequacy `undeclared` AND an empty checks array.
      b.automatedProofRequired = false;
      b.requiredTestLayers = [];
      b.proof.adequacy = { state: 'undeclared', checks: [] };
      return s;
    }

    it('reaches a non-code proof on current plane-matched evidence', () => {
      expect(deriveNonCodeItemProofs(manualProven())).toEqual([
        { planItemId: 'P-001', barKeys: ['R-1'], evidenceRefs: ['probe:current'] },
      ]);
    });

    function measuredManual(): AcceptanceBarContractSnapshot {
      const s = manualProven();
      const row = s.bars[0]!.proof.history![0]!;
      row.evidenceKind = 'manual';
      row.details.instrument = { none: true, reason: 'Semantic inspection of canonical content.' };
      row.currentness.provenance = 'server-measured';
      return s;
    }

    it('realizes a manual outcome from a declared server-measured content observation', () => {
      expect(deriveNonCodeItemProofs(measuredManual())).toEqual([
        { planItemId: 'P-001', barKeys: ['R-1'], evidenceRefs: ['probe:current'] },
      ]);
    });

    it.each([
      ['undeclared instrument', (s: AcceptanceBarContractSnapshot) => { delete s.bars[0]!.proof.history![0]!.details.instrument; }],
      ['unexplained instrument absence', (s: AcceptanceBarContractSnapshot) => { s.bars[0]!.proof.history![0]!.details.instrument = { none: true, reason: ' ' }; }],
      ['caller-attested currentness', (s: AcceptanceBarContractSnapshot) => { s.bars[0]!.proof.history![0]!.currentness.provenance = 'attested-current'; }],
      ['unmeasured source', (s: AcceptanceBarContractSnapshot) => { s.bars[0]!.proof.history![0]!.currentness.dimensions.source = 'unknown'; }],
      ['unmeasured runtime', (s: AcceptanceBarContractSnapshot) => { s.bars[0]!.proof.history![0]!.currentness.dimensions.environment = 'unknown'; }],
      ['automated BAR', (s: AcceptanceBarContractSnapshot) => { s.bars[0]!.automatedProofRequired = true; }],
    ] as const)('rejects a manual observation with %s', (_name, change) => {
      const s = measuredManual();
      change(s);
      expect(deriveNonCodeItemProofs(s)).toEqual([]);
    });

    // Falsifiability: being manual lifts the DEPTH floor and nothing else. Each of these
    // must still refuse, or the fix traded a contradiction for a hole.
    const manualGaps: Array<[string, (s: AcceptanceBarContractSnapshot) => void]> = [
      ['no evidence at all', s => { s.bars[0]!.proof.history = []; }],
      ['stale currentness', s => { s.bars[0]!.proof.history![0]!.currentness.overall = 'stale'; }],
      ['unknown currentness', s => { s.bars[0]!.proof.history![0]!.currentness.overall = 'unknown'; }],
      ['no comparison supplied', s => { s.bars[0]!.proof.history![0]!.currentness.comparisonSupplied = false; }],
      ['spec fingerprint drift', s => { s.bars[0]!.proof.history![0]!.specFingerprint = 'old'; }],
      ['wrong spec revision', s => { s.bars[0]!.proof.history![0]!.specRevision = 2; }],
      ['wrong evidence plane', s => { s.bars[0]!.proof.history![0]!.details.evidencePlane = 'tree'; }],
      ['a mere manual claim as evidence', s => { s.bars[0]!.proof.history![0]!.evidenceKind = 'manual'; }],
      ['no current work contract', s => { s.bars[0]!.workContracts[0]!.current = false; }],
      ['a dropped target', s => { s.bars[0]!.mappings[0]!.planItemStatus = 'dropped'; }],
      ['stale proof state', s => { s.bars[0]!.proof.state = 'stale'; }],
      ['uncertain evidence', s => { s.bars[0]!.proof.uncertainEvidence = 1; }],
      // Manual lifts `undeclared`; it never licenses ignoring a RECORDED failure.
      ['a failed adequacy state', s => { s.bars[0]!.proof.adequacy!.state = 'fail'; }],
      ['a recorded failing check', s => {
        s.bars[0]!.proof.adequacy!.checks = [{ specId: 'spec-1', revision: 1, verdict: 'fail',
          wouldBlock: ['depth'], evidenceRefs: ['probe:current'] }];
      }],
    ];
    it.each(manualGaps)('still refuses %s', (_name, change) => {
      const s = manualProven();
      change(s);
      expect(deriveNonCodeItemProofs(s)).toEqual([]);
    });

    it('does not open the depth floor for a bar that is merely MISSING the manual flag', () => {
      const s = manualProven();
      // Fail closed: an old snapshot predating `automatedProofRequired` must keep the
      // historic automated behavior rather than inherit the manual escape by omission.
      delete s.bars[0]!.automatedProofRequired;
      expect(deriveNonCodeItemProofs(s)).toEqual([]);
    });

    it('does not open the depth floor for an explicitly AUTOMATED bar', () => {
      const s = manualProven();
      s.bars[0]!.automatedProofRequired = true;
      expect(deriveNonCodeItemProofs(s)).toEqual([]);
    });
  });
});

describe('AcceptanceBarLifecycleEvaluator — phase-aware BAR contract', () => {
  it('allows a complete BAR with an empty METHOD at pre-start', () => {
    const verdict = evaluateAcceptanceBarLifecycle(snapshot(), 'pre-start');
    expect(verdict.satisfied).toBe(true);
    expect(verdict.codes).toEqual([]);
  });

  it('rejects missing identity/falsifier/mapping structure before start', () => {
    const current = snapshot({
      bars: [
        bar({
          barHash: null,
          falsifier: '',
          mappings: [],
          readiness: {
            state: 'blocked',
            codes: ['bar_snapshot_mapping_missing'],
            mapping: 'missing',
            method: 'missing',
            workContract: 'missing',
          },
        }),
      ],
    });
    const verdict = evaluateAcceptanceBarLifecycle(current, 'pre-start');
    expect(verdict.satisfied).toBe(false);
    expect(verdict.codes).toEqual(
      expect.arrayContaining([
        'bar_snapshot_bar_hash_missing',
        'bar_snapshot_falsifier_missing',
        'bar_snapshot_mapping_missing',
      ]),
    );
    expect(verdict.blockingBars[0]?.barKey).toBe('R-1');
  });

  it('requires METHOD and a structured/manual check before vetting and grading', () => {
    const missing = evaluateAcceptanceBarLifecycle(snapshot(), 'pre-vetting');
    expect(missing.codes).toEqual(
      expect.arrayContaining(['bar_snapshot_method_missing', 'bar_snapshot_check_missing']),
    );

    const ready = evaluateAcceptanceBarLifecycle(
      snapshot({
        grading: {
          authoritativeScorecardId: null,
          gradedBy: null,
          selectedVia: null,
          rubricRevision: null,
          vetting: { state: 'current', scorecardId: 'SC-V', rubricRevision: 1 },
          authorVerdict: { state: 'missing', scorecardId: null, verdict: null },
        },
        bars: [
          bar({
            method: 'Run the manual replication drill.',
            check: { kind: 'instrument', instrumentKey: 'none' },
            automatedProofRequired: false,
            proof: { ...bar().proof, state: 'current', currentEvidence: 1 },
            readiness: { state: 'ready', codes: [], mapping: 'live', method: 'declared', workContract: 'current' },
          }),
        ],
      }),
      'pre-grading',
    );
    expect(ready.satisfied).toBe(true);
  });

  it('requires proof depth before recruiting a grader and ranks the actionable repair', () => {
    const verdict = evaluateAcceptanceBarLifecycle(
      snapshot({
        bars: [
          bar({
            method: 'Run the tests.',
            check: { kind: 'tests', files: ['x.test.ts'] },
            readiness: {
              state: 'blocked',
              codes: ['bar_snapshot_proof_depth_missing'],
              mapping: 'live',
              method: 'declared',
              workContract: 'current',
            },
          }),
        ],
        readiness: {
          state: 'blocked',
          codes: ['bar_snapshot_proof_depth_missing'],
          nextRepair: {
            code: 'bar_snapshot_proof_depth_missing',
            barKey: 'R-1',
            action: 'Amend requiredTestLayers.',
          },
        },
      }),
      'pre-grading',
    );

    expect(verdict.codes).toContain('bar_snapshot_proof_depth_missing');
    expect(verdict.nextRepair).toBeTruthy();
  });

  it('blocks grading on proof adequacy, freshness, and declared live plane/runtime', () => {
    const trace = bar({
      method: 'Verify live behavior.', check: { kind: 'instrument', instrumentKey: 'manual' },
      requiredTestLayers: ['integration'], evidencePlane: 'live',
      proof: { ...bar().proof, state: 'stale', adequacy: { state: 'fail' } } as AcceptanceBarTrace['proof'],
    });
    const verdict = evaluateAcceptanceBarLifecycle(snapshot({ bars: [trace] }), 'pre-grading');
    expect(verdict.codes).toEqual(expect.arrayContaining([
      'bar_snapshot_proof_inadequate', 'bar_snapshot_proof_stale',
      'bar_snapshot_evidence_plane_unmet',
    ]));
    expect(verdict.satisfied).toBe(false);
  });

  it('allows a named manual delivery BAR to be reviewed before publication, while ship still requires its proof', async () => {
    const trace = bar({
      barKey: 'R-15', method: 'Before publication rate unknown; verify the public install after publication.',
      check: { kind: 'instrument', instrumentKey: 'none' }, automatedProofRequired: false,
      evidencePlane: 'deployed', requiredScope: ['deployed'], requiredTestLayers: ['manual-provenance'],
      proof: { ...bar().proof, state: 'stale', uncertainEvidence: 1,
        adequacy: { state: 'fail', checks: [] } },
      readiness: { ...bar().readiness, method: 'declared', codes: [
        'bar_snapshot_proof_stale', 'bar_snapshot_proof_inadequate',
        'bar_snapshot_proof_uncertain', 'bar_snapshot_evidence_plane_unmet',
        'bar_snapshot_evidence_runtime_unmet',
      ] },
    });
    const subject = snapshot({ bars: [trace], grading: { ...snapshot().grading,
      vetting: { state: 'current', scorecardId: 'SC-V', rubricRevision: 1 } } });
    const options = { pendingDeliveryBarKeys: ['R-15'] };
    expect(evaluateAcceptanceBarLifecycle(subject, 'pre-grading').satisfied).toBe(false);
    expect(evaluateAcceptanceBarLifecycle(subject, 'pre-grading', options)).toMatchObject({
      satisfied: true, codes: [], pendingDeliveryBarKeys: ['R-15'],
      pendingDeliverySpecClauses: [{ planSlug: 'plan-a', specId: 'spec-1',
        specRevision: 1, specContentHash: 'spec-hash' }],
    });
    expect(evaluateAcceptanceBarLifecycle(subject, 'ship', options)).toMatchObject({
      satisfied: false, codes: expect.arrayContaining([
        'bar_snapshot_proof_stale', 'bar_snapshot_evidence_plane_unmet',
      ]),
    });
    expect(evaluateAcceptanceBarLifecycle(subject, 'ship', options))
      .not.toHaveProperty('pendingDeliverySpecClauses');
    vi.mocked(readAcceptanceBarContractSnapshot).mockResolvedValue(subject);
    expect(await readAndEvaluateAcceptanceBarLifecycle('plan-a', 'pre-grading', options))
      .toMatchObject({ satisfied: true, pendingDeliveryBarKeys: ['R-15'] });

    // A review exception never hides another BAR or a malformed/unvetted contract.
    const tree = bar({ method: 'Run the tests.', check: { kind: 'tests', files: ['x.test.ts'] } });
    expect(evaluateAcceptanceBarLifecycle({ ...subject, bars: [trace, tree] }, 'pre-grading', options))
      .toMatchObject({ satisfied: false, blockingBars: expect.arrayContaining([
        expect.objectContaining({ barKey: 'R-1', codes: expect.arrayContaining(['bar_snapshot_proof_missing']) }),
      ]) });
    expect(evaluateAcceptanceBarLifecycle({ ...subject, grading: snapshot().grading }, 'pre-grading', options).codes)
      .toContain('bar_snapshot_vetting_missing');
    expect(evaluateAcceptanceBarLifecycle({ ...subject, completeness: { complete: false, truncated: false,
      problems: [{ code: 'bar_snapshot_projection_stale', severity: 'error', source: 'clauses', detail: 'stale' }] } },
    'pre-grading', options).codes).toContain('bar_snapshot_projection_stale');
  });

  it.each(['tree', 'automated', 'instrument', 'absent'])('rejects a pending-delivery selection that is %s', (invalid) => {
    const trace = bar({ method: 'Run checks.', check: { kind: 'instrument', instrumentKey: 'none' },
      automatedProofRequired: false, evidencePlane: 'deployed' });
    if (invalid === 'tree') trace.evidencePlane = 'tree';
    if (invalid === 'automated') trace.check = { kind: 'tests', files: ['x.test.ts'] };
    if (invalid === 'instrument') trace.check = { kind: 'instrument', instrumentKey: 'manual' };
    const verdict = evaluateAcceptanceBarLifecycle(snapshot({ bars: [trace] }), 'pre-grading', {
      pendingDeliveryBarKeys: [invalid === 'absent' ? 'R-missing' : trace.barKey],
    });
    expect(verdict.satisfied).toBe(false);
    expect(verdict.codes).toContain('bar_snapshot_pending_delivery_selection_invalid');
    expect(verdict.codes).not.toContain('bar_snapshot_scope_invalid');
    expect(verdict.nextRepair).toMatchObject({
      code: 'bar_snapshot_pending_delivery_selection_invalid', barKey: null,
    });
    expect(verdict.nextRepair?.action).toContain('pendingDeliveryBarKeys');
    expect(verdict.nextRepair?.action).toContain('instrumentKey:"none"');
    expect(verdict.nextRepair?.action).toContain('deployed or live');
    expect(verdict.nextRepair?.action).not.toContain('Declare a non-empty');
    expect(verdict.message).toContain(verdict.nextRepair!.action);
    expect(verdict).not.toHaveProperty('pendingDeliverySpecClauses');
  });

  it.each(['scope', 'plane'])('keeps a real %s defect ahead of an invalid pending-delivery selection', (invalid) => {
    const trace = bar({ method: 'Run checks.', check: { kind: 'tests', files: ['x.test.ts'] },
      ...(invalid === 'scope' ? { requiredScope: [] } : {
        evidencePlane: 'staging' as AcceptanceBarTrace['evidencePlane'],
      }),
    });
    const subject = snapshot({ bars: [trace] });
    const verdict = evaluateAcceptanceBarLifecycle(subject, 'pre-grading', {
      pendingDeliveryBarKeys: [trace.barKey],
    });
    expect(verdict.satisfied).toBe(false);
    expect(verdict.codes).toEqual(expect.arrayContaining([
      'bar_snapshot_scope_invalid', 'bar_snapshot_pending_delivery_selection_invalid',
    ]));
    expect(verdict.nextRepair).toMatchObject({
      code: 'bar_snapshot_scope_invalid', barKey: trace.barKey,
      action: 'Declare a non-empty tree, deployed, or live evidence scope.',
    });
    expect(verdict).not.toHaveProperty('pendingDeliverySpecClauses');
  });

  it('does not let an eligible pending-delivery selection waive an empty evidence scope', () => {
    const trace = bar({ method: 'Verify delivery.', check: { kind: 'instrument', instrumentKey: 'none' },
      automatedProofRequired: false, evidencePlane: 'deployed', requiredScope: [],
    });
    const verdict = evaluateAcceptanceBarLifecycle(snapshot({ bars: [trace] }), 'pre-grading', {
      pendingDeliveryBarKeys: [trace.barKey],
    });
    expect(verdict.satisfied).toBe(false);
    expect(verdict.codes).toContain('bar_snapshot_scope_invalid');
    expect(verdict.codes).not.toContain('bar_snapshot_pending_delivery_selection_invalid');
    expect(verdict.nextRepair?.code).toBe('bar_snapshot_scope_invalid');
    expect(verdict).not.toHaveProperty('pendingDeliverySpecClauses');
  });

  it('keeps a mixed pending-delivery request blocked without hiding automated proof', () => {
    const manual = bar({ barKey: 'R-manual', method: 'Verify delivery.',
      check: { kind: 'instrument', instrumentKey: 'none' }, automatedProofRequired: false,
      evidencePlane: 'deployed', requiredScope: ['deployed'],
    });
    const automated = bar({ method: 'Run tests.', check: { kind: 'tests', files: ['x.test.ts'] } });
    const verdict = evaluateAcceptanceBarLifecycle(snapshot({ bars: [manual, automated] }), 'pre-grading', {
      pendingDeliveryBarKeys: [manual.barKey, automated.barKey, 'R-missing'],
    });
    expect(verdict.satisfied).toBe(false);
    expect(verdict.codes).toContain('bar_snapshot_pending_delivery_selection_invalid');
    expect(verdict.codes).not.toContain('bar_snapshot_scope_invalid');
    expect(verdict.pendingDeliveryBarKeys).toEqual([manual.barKey]);
    expect(verdict.blockingBars).toEqual(expect.arrayContaining([
      expect.objectContaining({ barKey: automated.barKey,
        codes: expect.arrayContaining(['bar_snapshot_proof_missing']) }),
    ]));
    expect(verdict).not.toHaveProperty('pendingDeliverySpecClauses');
  });

  it('P-004: at ship, an unvetted rubric with missing proof is told to VET first, with the full action', () => {
    // The snapshot's own pick (proof) is still in this phase's codes, which used to be
    // enough to reuse it — so the door rendered "bind proof" ahead of the vetting the
    // runbook puts first. The phase codes are now ranked with the same order.
    const verdict = evaluateAcceptanceBarLifecycle(
      snapshot({
        bars: [
          bar({
            method: 'Run tests.',
            check: { kind: 'tests', files: ['x.test.ts'] },
            readiness: {
              state: 'blocked',
              codes: ['bar_snapshot_proof_missing'],
              mapping: 'live',
              method: 'declared',
              workContract: 'current',
            },
          }),
        ],
        readiness: {
          state: 'blocked',
          codes: ['bar_snapshot_proof_missing'],
          nextRepair: { code: 'bar_snapshot_proof_missing', barKey: 'R-1', action: 'Bind evidence.' },
        },
      }),
      'ship',
    );
    expect(verdict.codes).toEqual(
      expect.arrayContaining(['bar_snapshot_proof_missing', 'bar_snapshot_vetting_missing']),
    );
    expect(verdict.nextRepair?.code).toBe('bar_snapshot_vetting_missing');
    expect(verdict.nextRepair?.action).toMatch(/BEFORE binding proof/i);
    expect(verdict.message).toContain('NEXT REPAIR (bar_snapshot_vetting_missing)');
  });

  it('requires current proof, pass grading, vetting, and accepted author verdict at ship', () => {
    const blocked = evaluateAcceptanceBarLifecycle(
      snapshot({
        grading: {
          authoritativeScorecardId: 'SC-1',
          gradedBy: 'su-grader',
          selectedVia: 'floor',
          rubricRevision: 1,
          vetting: { state: 'current', scorecardId: 'SC-V', rubricRevision: 1 },
          authorVerdict: { state: 'accepted', scorecardId: 'SC-A', verdict: 'accept' },
        },
        bars: [bar({ method: 'Run tests.', check: { kind: 'tests', files: ['x.test.ts'] } })],
      }),
      'ship',
    );
    expect(blocked.codes).toEqual(expect.arrayContaining(['bar_snapshot_proof_missing']));

    const green = evaluateAcceptanceBarLifecycle(
      snapshot({
        grading: {
          authoritativeScorecardId: 'SC-1',
          gradedBy: 'su-grader',
          selectedVia: 'floor',
          rubricRevision: 1,
          vetting: { state: 'current', scorecardId: 'SC-V', rubricRevision: 1 },
          authorVerdict: { state: 'accepted', scorecardId: 'SC-A', verdict: 'accept' },
        },
        bars: [
          bar({
            method: 'Run tests.',
            check: { kind: 'tests', files: ['x.test.ts'] },
            requiredTestLayers: ['integration'],
            proof: {
              state: 'current',
              currentEvidence: 1,
              staleEvidence: 0,
              kinds: ['test'],
              evidenceRefs: ['x'],
              adequacy: { state: 'pass', checks: [{ specId: 'spec-1', revision: 1, verdict: 'pass', wouldBlock: [], evidenceRefs: ['x'] }] },
              uncertainEvidence: 0,
              evidencePlanes: [],
            },
            grading: {
              state: 'pass',
              scorecardId: 'SC-1',
              rubricRevision: 1,
              gradedBy: 'su-grader',
              selectedVia: 'floor',
              rating: 'healthy',
              evidence: 'pass',
            },
          }),
        ],
      }),
      'ship',
    );
    expect(green.satisfied).toBe(true);
  });

  it('does not require test-layer adequacy for a non-automated BAR with no layers', () => {
    const verdict = evaluateAcceptanceBarLifecycle(
      snapshot({ bars: [bar({ behaviorClass: 'non-automated', evidencePlane: 'live' })] }),
      'ship',
    );
    expect(verdict.codes).not.toContain('bar_snapshot_proof_depth_missing');
  });

  it('fails closed on uncertain or wrong-plane evidence, and skips legacy snapshots', () => {
    const uncertain = evaluateAcceptanceBarLifecycle(
      snapshot({
        grading: {
          authoritativeScorecardId: 'SC-1',
          gradedBy: 'su-grader',
          selectedVia: 'floor',
          rubricRevision: 1,
          vetting: { state: 'current', scorecardId: 'SC-V', rubricRevision: 1 },
          authorVerdict: { state: 'accepted', scorecardId: 'SC-A', verdict: 'accept' },
        },
        bars: [
          bar({
            method: 'Run the live drill.',
            check: { kind: 'instrument', instrumentKey: 'live-check' },
            evidencePlane: 'live',
            proof: {
              state: 'current',
              currentEvidence: 1,
              staleEvidence: 0,
              kinds: ['operational'],
              evidenceRefs: ['live'],
              uncertainEvidence: 1,
              evidencePlanes: ['tree'],
            },
            grading: {
              state: 'pass',
              scorecardId: 'SC-1',
              rubricRevision: 1,
              gradedBy: 'su-grader',
              selectedVia: 'floor',
              rating: 'healthy',
              evidence: 'pass',
            },
          }),
        ],
      }),
      'ship',
    );
    expect(uncertain.codes).toEqual(
      expect.arrayContaining(['bar_snapshot_proof_uncertain', 'bar_snapshot_evidence_plane_unmet']),
    );
    expect(evaluateAcceptanceBarContract(snapshot({ applicable: false }), 'ship').satisfied).toBe(true);
  });

  it('keeps the explicit pure-investigation classRef escape hatch for a zero-BAR rubric', () => {
    const investigation = snapshot({
      rubric: {
        rubricId: 'acceptance-investigation',
        revision: 1,
        criteriaHash: 'criteria',
        barSetHash: null,
        contract: snapshot().rubric!.contract,
        createdBy: 'su-author',
        ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
        classRef: 'plan-class-investigation',
      },
      bars: [],
    });
    expect(evaluateAcceptanceBarLifecycle(investigation, 'pre-start').satisfied).toBe(true);
    expect(evaluateAcceptanceBarLifecycle(investigation, 'ship').satisfied).toBe(true);
  });
});

describe('a refusal names its REPAIR VERB and says it is not recruiting', () => {
  // Measured 2026-09-18: this refusal handed an agent seven codes and zero verbs, and
  // said nothing about recruitment. The agent spent hours recruiting a grader for a
  // phase-2 step that a phase-1 refusal cannot reach. Both halves are now asserted.

  it('does not turn an unresolved pinned rubric into absent declarations', () => {
    const subject = snapshot({
      bars: [],
      rubric: null,
      completeness: {
        complete: false,
        truncated: false,
        problems: [{
          code: 'bar_snapshot_rubric_unresolved',
          source: 'rubric',
          severity: 'error',
          detail: 'The pinned acceptance-plan-a rubric could not be resolved.',
        }],
      },
    });
    const verdict = evaluateAcceptanceBarLifecycle(subject, 'ship');
    expect(subject.plan?.rubricSlug).toBe('acceptance-plan-a');
    expect(verdict.satisfied).toBe(false);
    expect(verdict.contractCodes).toContain('bar_snapshot_rubric_unresolved');
    expect(verdict.message).toContain('no BARs resolved in this snapshot');
    expect(verdict.message).not.toContain('no BARs declared');
  });

  it('is a MEANINGFUL fixture — the default ship verdict actually refuses', () => {
    // Guards the assertions below against passing vacuously on a satisfied verdict
    // whose message is null.
    const verdict = evaluateAcceptanceBarLifecycle(snapshot(), 'ship');
    expect(verdict.satisfied).toBe(false);
    expect(typeof verdict.message).toBe('string');
  });

  it('names the prioritised repair ACTION, not just the code', () => {
    const verdict = evaluateAcceptanceBarLifecycle(snapshot(), 'ship');
    const message = verdict.message ?? '';
    expect(message).toContain('NEXT REPAIR');
    // The ACTION text itself must be present — a bare "NEXT REPAIR: <code>" would
    // satisfy a naive matcher while leaving the caller exactly as stuck as before.
    const action = verdict.nextRepair?.action;
    expect(action).toBeTruthy();
    expect(message).toContain(action ?? '__no_action_was_computed__');
  });

  it('states that this refusal does not recruit a grader', () => {
    const message = evaluateAcceptanceBarLifecycle(snapshot(), 'ship').message ?? '';
    expect(message).toContain('does NOT recruit a grader');
    // Name the codes that DO recruit, so the reader learns the two-phase shape rather
    // than just being told "not now".
    expect(message).toContain('acceptance_ungraded');
    expect(message).toContain('self_graded_only');
  });

  it('separates independent grading and its later author verdict from author repairs', () => {
    const verdict = evaluateAcceptanceBarLifecycle(snapshot(), 'ship');
    expect(verdict.codes).toContain('bar_snapshot_grading_missing');
    expect(verdict.codes).toContain('bar_snapshot_author_verdict_missing');
    expect(verdict.message).not.toContain("These repairs are the plan author's alone");
    expect(verdict.message).toContain('missing or stale independent grading is grader work');
    expect(verdict.message).toContain('author verdict after reading that grading');
    expect(verdict.message).toContain('Repair the blocking pre-grading obligations first');
    expect(verdict.message).toContain('plans:set-plan-status');
    expect(verdict.message).toContain('Never self-grade or launch a parallel reviewer');
  });

  it('still carries the original attribution — the repair line is additive', () => {
    const message = evaluateAcceptanceBarLifecycle(snapshot(), 'ship').message ?? '';
    expect(message).toContain('acceptance BAR contract is not ready for ship');
    expect(message).toMatch(/BAR\(s\) blocking/);
  });
});

// verification-system-improvements-2026-10-10 P-001: every contract refusal code the
// verification-system map names must have a test that triggers it. Each case below breaks
// exactly one field of an otherwise complete BAR, so the code cannot appear for another reason.
describe('BAR field contract codes (verification-system map)', () => {
  const preStartCodes = (bars: AcceptanceBarTrace[]) =>
    evaluateAcceptanceBarLifecycle(snapshot({ bars }), 'pre-start').codes;

  it('CALIBRATION: the unmodified BAR raises none of the field codes', () => {
    const codes = preStartCodes([bar()]);
    for (const code of [
      'bar_snapshot_role_invalid',
      'bar_snapshot_mandatory_invalid',
      'bar_snapshot_scope_invalid',
      'bar_snapshot_pass_ratings_invalid',
      'bar_snapshot_coverage_invalid',
      'bar_snapshot_bar_provenance_missing',
    ]) {
      expect(codes).not.toContain(code);
    }
  });

  it('a role other than outcome or disclosure raises bar_snapshot_role_invalid', () => {
    const codes = preStartCodes([bar({ role: 'aspiration' as AcceptanceBarTrace['role'] })]);
    expect(codes).toContain('bar_snapshot_role_invalid');
  });

  it('a non-mandatory outcome raises bar_snapshot_mandatory_invalid', () => {
    const codes = preStartCodes([bar({ mandatory: false })]);
    expect(codes).toContain('bar_snapshot_mandatory_invalid');
  });

  it('an empty required scope raises bar_snapshot_scope_invalid', () => {
    const codes = preStartCodes([bar({ requiredScope: [] })]);
    expect(codes).toContain('bar_snapshot_scope_invalid');
  });

  it('an unknown evidence plane raises bar_snapshot_scope_invalid', () => {
    const codes = preStartCodes([bar({ evidencePlane: 'staging' as AcceptanceBarTrace['evidencePlane'] })]);
    expect(codes).toContain('bar_snapshot_scope_invalid');
  });

  it('a pass rating outside the rubric rating scale raises bar_snapshot_pass_ratings_invalid', () => {
    const codes = preStartCodes([bar({ passRatings: ['excellent'] })]);
    expect(codes).toContain('bar_snapshot_pass_ratings_invalid');
  });

  it('an outcome with no pass ratings raises bar_snapshot_pass_ratings_invalid', () => {
    const codes = preStartCodes([bar({ passRatings: [] })]);
    expect(codes).toContain('bar_snapshot_pass_ratings_invalid');
  });

  it('a disclosure covering an unknown outcome raises bar_snapshot_coverage_invalid', () => {
    const disclosure = bar({
      barKey: 'R-2',
      criterionKey: 'r-2',
      role: 'disclosure',
      mandatory: false,
      passRatings: [],
      coversBarKeys: ['R-9'],
    });
    expect(preStartCodes([bar(), disclosure])).toContain('bar_snapshot_coverage_invalid');
  });

  it('CONTROL: the same disclosure covering a real outcome does not raise bar_snapshot_coverage_invalid', () => {
    const disclosure = bar({
      barKey: 'R-2',
      criterionKey: 'r-2',
      role: 'disclosure',
      mandatory: false,
      passRatings: [],
      coversBarKeys: ['R-1'],
    });
    expect(preStartCodes([bar(), disclosure])).not.toContain('bar_snapshot_coverage_invalid');
  });

  it('a BAR with no provenance raises bar_snapshot_bar_provenance_missing', () => {
    const codes = preStartCodes([bar({ provenance: null as unknown as AcceptanceBarTrace['provenance'] })]);
    expect(codes).toContain('bar_snapshot_bar_provenance_missing');
  });
});
