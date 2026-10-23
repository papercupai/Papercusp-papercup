import { describe, expect, it, vi } from 'vitest';
import type { SpecClauseRevision } from '../plans/spec-clauses-store';
import type { SpecEvidenceForAdequacy } from '../plans/spec-test-adequacy';
import { resolveItemCloseContributions, type ContributionDeferralDeps } from './item-close-contributions';
const production = vi.hoisted(() => ({
  plan: vi.fn(), rubric: vi.fn(), conformance: vi.fn(), implementers: vi.fn(), lineage: vi.fn(),
}));
vi.mock('../plans/source', () => ({ readPlanBySlug: production.plan }));
vi.mock('../../rubrics', async (original) => ({
  ...await original<typeof import('../../rubrics')>(), getRubric: production.rubric,
}));
vi.mock('../../spec-conformance/closure-guard', () => ({ conformanceClosureAssessment: production.conformance }));
vi.mock('../../acceptance-author-identity', () => ({
  resolvePlanImplementerIdentities: production.implementers, areAcceptanceLineageRelated: production.lineage,
}));

function world() {
  const covering: SpecClauseRevision = {
    planSlug: 'protocol-rollout', planItemId: 'P-002', specId: 'ITEM-P-002',
    revision: 2, currentRevision: 2, contentHash: 'cover-v2', sourceValId: null,
    behavior: 'Reject unsupported protocol versions.', behaviorClass: 'boundary',
    falsifier: { observation: 'A future version is accepted.' },
    requiredEvidence: ['test', 'mutation'], requiredTestLayers: ['unit'], mutationRequired: true,
    lifecycleStatus: 'active', supersedes: null, exemption: null,
    createdBy: 'contract-author', createdAt: '2026-10-22T00:00:00Z',
    acceptedBy: null, acceptedAt: null, acceptanceRef: null,
  };
  const projection: SpecClauseRevision = { ...covering, specId: 'AUTO-BAR-R-9-P-002',
    createdBy: 'implementer',
    contentHash: 'projection-v2', behavior: 'Ship interoperable protocol to both hosts.',
    requiredTestLayers: ['e2e'], sourceBar: { barKey: 'R-9', barHash: 'r9hash',
      barSetHash: 'sethash', rubricSlug: 'protocol-rollout-acceptance', rubricRevision: 3,
      evidencePlane: 'deployed' } };
  const proof: SpecEvidenceForAdequacy & { bindingFingerprint: string } = {
    bindingFingerprint: 'immutable-proof-10',
    id: 10, workItemId: 'WI-protocol', planSlug: covering.planSlug, specId: covering.specId,
    specRevision: covering.revision, specFingerprint: covering.contentHash,
    evidenceKind: 'test', evidenceRef: 'test-run:10', createdBy: 'implementer',
    fingerprints: { sourceFingerprint: 'source', testFingerprint: 'test',
      fixtureFingerprint: 'fixture', rubricFingerprint: null, environmentFingerprint: 'node' },
    coverageEvidenceRef: null, testRunId: 10, details: {},
    currentness: { overall: 'current', provenance: 'server-measured', comparisonSupplied: true,
      staleReasons: [], unknownReasons: [], dimensions: { spec: 'current', source: 'current',
        test: 'current', fixture: 'current', rubric: 'not-applicable', environment: 'current',
        coverageEvidence: 'not-applicable', testRun: 'current' } },
  };
  const pin = (c: SpecClauseRevision) => ({ planSlug: c.planSlug, specId: c.specId,
    revision: c.revision, contentHash: c.contentHash });
  const relation = { schemaVersion: 1, workItemId: proof.workItemId, planItemId: covering.planItemId,
    requirementKey: 'R-9', barHash: 'r9hash', projection: pin(projection), covering: pin(covering),
    proofCohort: [{ bindingId: 10, bindingFingerprint: proof.bindingFingerprint }],
    itemClose: { behavior: covering.behavior, falsifier: covering.falsifier!.observation,
      requiredTestLayers: [...covering.requiredTestLayers], requiredEvidence: [...covering.requiredEvidence],
      mutationRequired: true, evidencePlane: 'tree' }, disposition: 'defer-parent-proof-to-plan-shipment' };
  const review: SpecEvidenceForAdequacy = { ...structuredClone(proof), id: 11,
    evidenceKind: 'independent-verification', evidenceRef: 'independent:11',
    createdBy: 'outside-reviewer', verifiesBindingId: 10, details: { itemCloseContribution: relation } };
  const input = { workItem: { id: proof.workItemId, kind: 'change', harness: 'papercusp',
      sourcePlanSlug: covering.planSlug, sourcePlanItemIds: [covering.planItemId] },
    workspaceId: 'workspace', completion: { contributesTo: ['R-9'], discharges: [] as string[] },
    clauses: [projection, covering], evidence: [proof, review], codeDeliverable: () => true };
  const deps: Required<ContributionDeferralDeps> = {
    mappedProjection: vi.fn(async () => true), independent: vi.fn(async () => true),
  };
  return { input, deps, covering, projection, proof, review, relation,
    run: () => resolveItemCloseContributions(input, deps) };
}

describe('exact independently verified item-close contribution relations', () => {
  it('selects only the pinned contribution and credits no deployed proof', async () => {
    const w = world();
    expect(await w.run()).toEqual([{ requirementKey: 'R-9', projection: w.relation.projection,
      covering: w.relation.covering, verificationBindingId: 11, evidencePlane: 'tree',
      proofCohort: w.relation.proofCohort,
      reason: 'independently-verified-item-contract', finalGate: 'plan-shipment' }]);
    expect(w.deps.independent).toHaveBeenCalledWith('contract-author',
      ['implementer', 'implementer'], 'protocol-rollout');
    expect(w.deps.independent).toHaveBeenCalledWith('outside-reviewer',
      ['implementer', 'contract-author', 'implementer'], 'protocol-rollout');
  });

  it('preserves distinct requirement certificates citing the same proof receipt', async () => {
    const w = world();
    w.review.evidenceRef = w.proof.evidenceRef;
    const projection = { ...structuredClone(w.projection), specId: 'AUTO-BAR-R-1-P-002',
      contentHash: 'r1-projection', sourceBar: { ...w.projection.sourceBar!, barKey: 'R-1', barHash: 'r1hash' } };
    const review = { ...structuredClone(w.review), id: 12, details: { itemCloseContribution: {
      ...structuredClone(w.relation), requirementKey: 'R-1', barHash: 'r1hash',
      projection: { ...w.relation.projection, specId: projection.specId, contentHash: projection.contentHash },
    } } };
    w.input.clauses.push(projection);
    w.input.evidence.push(review);
    w.input.completion.contributesTo.push('R-1');
    expect((await w.run()).map(row => [row.requirementKey, row.verificationBindingId]))
      .toEqual([['R-9', 11], ['R-1', 12]]);
  });

  it('refuses repeated certificates even when they cite the same evidence reference', async () => {
    const w = world();
    w.review.evidenceRef = w.proof.evidenceRef;
    w.input.evidence.push({ ...structuredClone(w.review), id: 12 });
    expect(await w.run()).toEqual([]);
  });

  it.each(['omitted', 'discharge', 'conflict'] as const)('does not defer %s declarations', async (mode) => {
    const w = world();
    if (mode === 'omitted') w.input.completion.contributesTo = [];
    else { w.input.completion.discharges = ['R-9']; if (mode === 'discharge') w.input.completion.contributesTo = []; }
    expect(await w.run()).toEqual([]);
    expect(w.deps.mappedProjection).not.toHaveBeenCalled();
  });

  const invalid: Array<[string, (w: ReturnType<typeof world>) => void]> = [
    ['missing independent relation', w => { w.input.evidence = [w.proof]; }],
    ['ordinary evidence with forged review details', w => { w.review.evidenceKind = 'manual'; }],
    ['unreadable verifier identity', w => { w.review.createdBy = ''; }],
    ['self-authored covering clause', w => { w.covering.createdBy = 'implementer'; }],
    ['unreadable covering author', w => { w.covering.createdBy = ''; }],
    ['changed immutable cohort fingerprint', w => { w.relation.proofCohort[0]!.bindingFingerprint = 'other'; }],
    ['missing cohort binding', w => { w.relation.proofCohort[0]!.bindingId = 99; }],
    ['missing cited proof', w => { w.review.verifiesBindingId = 99; }],
    ['citation to another independent row', w => { w.proof.evidenceKind = 'independent-verification'; }],
    ['stale review', w => { w.review.currentness.overall = 'stale'; }],
    ['replayed fingerprints', w => { w.review.currentness.provenance = 'replayed-snapshot'; }],
    ['source mismatch', w => { w.review.fingerprints.sourceFingerprint = 'other'; }],
    ['missing environment', w => { w.review.fingerprints.environmentFingerprint = null; }],
    ['unknown environment', w => { w.review.currentness.dimensions.environment = 'unknown'; }],
    ['foreign work-item', w => { w.relation.workItemId = 'WI-other'; }],
    ['foreign plan pin', w => { w.relation.projection.planSlug = 'other'; }],
    ['foreign item', w => { w.projection.planItemId = 'P-003'; }],
    ['stale BAR pin', w => { w.relation.barHash = 'old'; }],
    ['stale projection', w => { w.projection.currentRevision++; }],
    ['draft projection', w => { w.projection.lifecycleStatus = 'draft'; }],
    ['unversioned projection', w => { w.projection.sourceBar = null; }],
    ['stale covering pin', w => { w.relation.covering.contentHash = 'old'; }],
    ['stale covering revision', w => { w.covering.currentRevision++; }],
    ['exempt covering clause', w => { w.covering.lifecycleStatus = 'exempt'; }],
    ['another projection as covering clause', w => { w.covering.sourceBar = w.projection.sourceBar; }],
    ['no falsifier', w => { w.covering.falsifier = null; }],
    ['unrelated behavior', w => { w.covering.behavior = 'Update display color.'; }],
    ['weaker falsifier', w => { w.covering.falsifier!.observation = 'A log is present.'; }],
    ['lower layer', w => { w.relation.itemClose.requiredTestLayers = ['static']; }],
    ['unproved declared mutation', w => { w.relation.itemClose.mutationRequired = false; }],
    ['false host plane', w => { w.relation.itemClose.evidencePlane = 'deployed'; }],
    ['namespace collision in proof', w => { w.proof.planSlug = 'another-plan'; }],
    ['ambiguous covering contracts', w => { w.input.clauses.push({ ...w.covering }); }],
    ['ambiguous certificates', w => { w.input.evidence.push({ ...w.review, id: 12, evidenceRef: 'independent:12' }); }],
  ];
  it.each(invalid)('retains full projection enforcement for %s', async (_label, breakIt) => {
    const w = world(); breakIt(w); expect(await w.run()).toEqual([]);
  });

  it.each(['mapping', 'identity'] as const)('fails closed for a refused or unreadable %s', async (leg) => {
    const w = world();
    const fn = w.deps[leg === 'mapping' ? 'mappedProjection' : 'independent'];
    vi.mocked(fn).mockResolvedValueOnce(false);
    expect(await w.run()).toEqual([]);
    vi.mocked(fn).mockRejectedValueOnce(new Error('unavailable'));
    expect(await w.run()).toEqual([]);
  });

  it('cannot use an exact contract in another plan namespace or unrelated clause as cover', async () => {
    const w = world(); w.covering.planSlug = 'another-plan';
    w.relation.covering.planSlug = 'another-plan';
    expect(await w.run()).toEqual([]);
  });

  it('re-reads revisions on every call instead of trusting a prior preview', async () => {
    const w = world(); expect(await w.run()).toHaveLength(1);
    w.covering.revision++; w.covering.currentRevision++;
    expect(await w.run()).toEqual([]);
  });

  it.each(['related', 'unreadable'] as const)('refuses a %s covering author even with an independent verifier', async (fault) => {
    const w = world();
    vi.mocked(w.deps.independent).mockImplementation(async identity => {
      if (identity === 'contract-author') {
        if (fault === 'unreadable') throw new Error('unreadable-contract-author');
        return false;
      }
      return true;
    });
    expect(await w.run()).toEqual([]);
  });

  it('preserves server-certified environment non-applicability for tree evidence', async () => {
    const w = world();
    for (const row of w.input.evidence) {
      row.fingerprints.environmentFingerprint = null;
      row.currentness.dimensions.environment = 'not-applicable';
    }
    expect(await w.run()).toHaveLength(1);
  });

  function productionWorld() {
    const w = world();
    const requirement = { intent: { request: 'Ship both hosts.', sourceRefs: ['P-002'] },
      acceptance: { condition: w.projection.behavior, falsifier: 'A shipped host is incompatible.' },
      verification: { method: 'Run shipped host conformance.', check: { kind: 'tests', files: ['host.test.ts'] } } };
    const planContent = ['---', 'slug: protocol-rollout', 'status: active', '---',
      '## Requirements', '**R-9 — Host compatibility.**', '```requirement', JSON.stringify(requirement), '```',
      '## Design', '### Bar-to-work map for this plan',
      '| bar | implementing plan items | evidence plane |', '|---|---|---|', '| R-9 | P-002 | deployed |',
      '## Build', '- **P-002** `todo` Protocol', '- **P-003** `todo` Conformance' ].join('\n');
    production.plan.mockReset().mockResolvedValue({ row: { content: planContent } });
    const rubric = { rubricId: 'protocol-rollout-acceptance', kind: 'acceptance', subjectPlan: 'protocol-rollout',
      revision: 3, barSetHash: 'sethash', criteria: [{ barKey: 'R-9', barHash: 'r9hash',
        evidencePlane: 'deployed', model: w.projection.behavior, requiredTestLayers: ['e2e'] }] };
    production.rubric.mockReset().mockResolvedValue(rubric);
    production.conformance.mockReset().mockResolvedValue({ applicable: true, declarationSatisfied: true,
      refusal: null, mappedRequirements: ['R-9'] });
    production.implementers.mockReset().mockResolvedValue(['implementer']);
    production.lineage.mockReset().mockImplementation(async (a: string, b: string) => a === b);
    return { ...w, planContent, rubric, runProduction: () => resolveItemCloseContributions(w.input) };
  }

  it('checks the current canonical BAR, map, conformance and acceptance lineage in production', async () => {
    const w = productionWorld(); expect(await w.runProduction()).toHaveLength(1);
    expect(production.plan).toHaveBeenCalledWith('protocol-rollout', {
      workspaceId: 'workspace', harnessSlug: 'papercusp' });
    expect(production.lineage).toHaveBeenCalledWith('implementer', 'outside-reviewer', { workspaceId: 'workspace' });
  });

  it.each(['sethash', 'prior-sethash'])('preserves an unchanged BAR with historical aggregate %s', async (barSetHash) => {
    const w = productionWorld();
    Object.assign(w.projection.sourceBar!, { rubricRevision: 2, barSetHash });
    const historical = { ...w.rubric, revision: 2, barSetHash };
    production.rubric.mockImplementation(async (_slug: string, revision?: number) =>
      revision === 2 ? historical : w.rubric);
    expect(await w.runProduction()).toHaveLength(1);
    expect(production.rubric).toHaveBeenCalledWith('protocol-rollout-acceptance', 2);
  });

  it.each(['hash', 'plane', 'behavior'] as const)(
    'refuses historical BAR %s drift even when the current BAR remains valid', async (fault) => {
      const w = productionWorld();
      w.projection.sourceBar!.rubricRevision = 2;
      const historical = { ...structuredClone(w.rubric), revision: 2 };
      production.rubric.mockImplementation(async (_slug: string, revision?: number) =>
        revision === 2 ? historical : w.rubric);
      expect(await w.runProduction()).toHaveLength(1);

      if (fault === 'hash') historical.criteria[0]!.barHash = 'different-historical-hash';
      if (fault === 'plane') historical.criteria[0]!.evidencePlane = 'tree';
      if (fault === 'behavior') historical.criteria[0]!.model = 'Different historical behavior.';
      expect(await w.runProduction()).toEqual([]);
    },
  );

  it.each(['removed-map', 'unresolvable-history', 'changed-bar', 'wrong-set-pin', 'missing-required-layer', 'changed-projection', 'wrong-plane',
    'unreadable-implementers', 'related-reviewer', 'drift-alarm', 'unknown-identity'] as const)(
    'cannot defer with production %s', async (fault) => {
      const w = productionWorld();
      if (fault === 'removed-map') production.plan.mockResolvedValue({ row: { content: w.planContent.replace('| R-9 | P-002 |', '| R-9 | P-003 |') } });
      if (fault === 'unresolvable-history') {
        w.projection.sourceBar!.rubricRevision = 2;
        production.rubric.mockImplementation(async (_slug: string, revision?: number) =>
          revision === 2 ? null : w.rubric);
      }
      if (fault === 'changed-bar') w.rubric.criteria[0]!.barHash = 'changed';
      if (fault === 'wrong-set-pin') w.projection.sourceBar!.barSetHash = 'old';
      if (fault === 'missing-required-layer') w.projection.requiredTestLayers = ['unit'];
      if (fault === 'changed-projection') w.projection.behavior = 'Different behavior.';
      if (fault === 'wrong-plane') w.projection.sourceBar!.evidencePlane = 'tree';
      if (fault === 'unreadable-implementers') production.implementers.mockResolvedValue([]);
      if (fault === 'related-reviewer') production.lineage.mockResolvedValue(true);
      if (fault === 'drift-alarm') production.conformance.mockResolvedValue({ applicable: true,
        declarationSatisfied: true, mappedRequirements: ['R-9'], refusal: { code: 'conformance_drift_alarm_open' } });
      if (fault === 'unknown-identity') production.lineage.mockRejectedValue(new Error('identity-unreadable'));
      expect(await w.runProduction()).toEqual([]);
    },
  );
});
