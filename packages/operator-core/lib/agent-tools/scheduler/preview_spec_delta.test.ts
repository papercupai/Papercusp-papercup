import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolvePreviewHarness,
  deltaFamilyScopeIncomplete,
  FAMILY_SCOPE_BLIND_SPOT_WARNING,
} from './preview_spec_delta';
import previewSpecDeltaTool from './preview_spec_delta';

const admissionMocks = vi.hoisted(() => ({
  getClaimSpecRecord: vi.fn(),
  readClaimSpecDelta: vi.fn(),
  previewSpecFilterPartition: vi.fn(),
  getWorkItem: vi.fn(),
  explainIssueClaimFloors: vi.fn(),
  listFleetControlMembers: vi.fn(),
  setClaimSpec: vi.fn(),
}));

// Keep the real tool handler and shared authoring evaluator; replace only their
// persisted reads. Any accidental spec write is observable and forbidden here.
vi.mock('../../scheduler/claim-spec-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/claim-spec-store')>()),
  getClaimSpecRecord: (...args: unknown[]) => admissionMocks.getClaimSpecRecord(...args),
  setClaimSpec: (...args: unknown[]) => admissionMocks.setClaimSpec(...args),
}));
vi.mock('../../scheduler/get-next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/get-next')>()),
  readClaimSpecDelta: (...args: unknown[]) => admissionMocks.readClaimSpecDelta(...args),
}));
vi.mock('../../scheduler/spec-predicate-partition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/spec-predicate-partition')>()),
  previewSpecFilterPartition: (...args: unknown[]) => admissionMocks.previewSpecFilterPartition(...args),
}));
vi.mock('./set_claim_spec', async (importOriginal) => {
  const original = await importOriginal<typeof import('./set_claim_spec')>();
  return {
    ...original,
    // Exercise the real evaluator through its own persisted-read seams.
    // Concurrent dynamic imports can otherwise escape a partial ESM mock;
    // the unit rail caught that for the second ID in a mixed cohort.
    previewClaimSpecAdmission: (args: Parameters<typeof original.previewClaimSpecAdmission>[0]) =>
      original.previewClaimSpecAdmission({
        ...args,
        resolveFamily: async (id, harness) => (await admissionMocks.getWorkItem(id, harness))?.family ?? null,
        explain: (...args) => admissionMocks.explainIssueClaimFloors(...args),
        resolveFleetMembers: (fleet) => admissionMocks.listFleetControlMembers(fleet),
      }),
  };
});

const proposedSpecWithoutRevision = {
  specVersion: '1.0',
  specId: 'preview-test',
  view: { filter: { field: 'kind', op: 'in', value: ['bug'] } },
  rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
  states: ['open'],
};

describe('scheduler:preview_spec_delta args — proposed spec is self-describing', () => {
  it('publishes revision as required and accepts the complete shared claim-spec shape', () => {
    const missingRevision = previewSpecDeltaTool.args.safeParse({
      fleet: 'fleet-a',
      proposed: proposedSpecWithoutRevision,
    });
    expect(missingRevision.success).toBe(false);
    if (!missingRevision.success) {
      expect(missingRevision.error.issues.some((issue) => issue.path.join('.') === 'proposed.revision')).toBe(true);
    }

    const complete = previewSpecDeltaTool.args.safeParse({
      fleet: 'fleet-a',
      proposed: { ...proposedSpecWithoutRevision, revision: 1 },
    });
    expect(complete.success).toBe(true);
  });
});

describe('resolvePreviewHarness — operator scope must not become a literal harness', () => {
  it('rejects an unscoped operator context instead of previewing an empty `*` lane', () => {
    expect(resolvePreviewHarness(undefined, null, '*')).toBeUndefined();
  });

  it('inherits a concrete ambient harness from an unscoped sentinel argument', () => {
    expect(resolvePreviewHarness('*', null, 'papercusp')).toBe('papercusp');
  });

  it('prefers a concrete stored scope over the operator-context sentinel', () => {
    expect(resolvePreviewHarness(undefined, 'papercusp', '*')).toBe('papercusp');
  });

  it('falls back from a stale wildcard stored scope to a concrete ambient harness', () => {
    expect(resolvePreviewHarness(undefined, '*', 'papercusp')).toBe('papercusp');
  });

  it('gives an explicit concrete harness precedence over stored and ambient scopes', () => {
    expect(resolvePreviewHarness('papercusp', 'other-harness', '*')).toBe('papercusp');
  });
});

/**
 * EI-21177555351818650 regression: scheduler:preview_spec_delta reported
 * currentClaimable=0 / proposedClaimable=0 — including for a proposal naming
 * feature-family WI-40469/WI-40491/WI-40500 by id explicitly — while
 * scheduler:get_next claimed WI-40469 seconds later under the same stored spec.
 * Root cause: readClaimSpecDelta's candidate subquery is issue-family-only
 * (item_kind IN ('bug','change','task')); scheduler:get_next also claims from the
 * feature-family table via its tier 1/2. deltaFamilyScopeIncomplete is the guard
 * that flags a reading as non-exhaustive whenever a feature-family row could be
 * reachable — pinning it here keeps the two oracles' DISAGREEMENT from ever being
 * silent again, even though this function cannot make the counts themselves
 * exhaustive (that needs a feature-family-aware engine, out of scope here).
 */
describe('deltaFamilyScopeIncomplete — the issue-family blind spot must never be silent', () => {
  const idOnlyFilter = {
    field: 'id',
    op: 'in',
    value: ['WI-40469', 'WI-40491', 'WI-40500'],
  };
  const issueOnlyKindFilter = { field: 'kind', op: 'in', value: ['bug', 'change', 'task'] };
  const featureAdmittingKindFilter = { field: 'kind', op: 'in', value: ['bug', 'feature'] };

  it('is false when BOTH specs restrict exclusively to issue-family kinds — the reading is exhaustive', () => {
    const spec = { view: { filter: issueOnlyKindFilter } };
    expect(deltaFamilyScopeIncomplete(spec, spec)).toBe(false);
  });

  it('is true when the CURRENT spec has no kind filter at all (the live repro: the fleet sentinel spec)', () => {
    const current = { view: { filter: { all: [idOnlyFilter] } } };
    const proposed = { view: { filter: issueOnlyKindFilter } };
    expect(deltaFamilyScopeIncomplete(current, proposed)).toBe(true);
  });

  it('is true for an explicit id-list proposal with no kind leaf — the live repro\'s second preview', () => {
    const spec = { view: { filter: issueOnlyKindFilter } };
    const idListProposal = { view: { filter: idOnlyFilter } };
    expect(deltaFamilyScopeIncomplete(spec, idListProposal)).toBe(true);
    expect(deltaFamilyScopeIncomplete(idListProposal, spec)).toBe(true);
  });

  it('is true when either spec\'s kind filter explicitly admits a non-issue kind', () => {
    const spec = { view: { filter: issueOnlyKindFilter } };
    const featureSpec = { view: { filter: featureAdmittingKindFilter } };
    expect(deltaFamilyScopeIncomplete(spec, featureSpec)).toBe(true);
    expect(deltaFamilyScopeIncomplete(featureSpec, spec)).toBe(true);
  });

  it('the warning names the blind spot and tells the reader to verify with scheduler:get_next', () => {
    expect(FAMILY_SCOPE_BLIND_SPOT_WARNING).toContain('feature-family');
    expect(FAMILY_SCOPE_BLIND_SPOT_WARNING).toContain('scheduler:get_next');
  });
});

describe('read-only named authoring admission — WI-6554700010008817', () => {
  const id = 'WI-6554700010008803';
  const holder = 'su-original-source';
  const fleet = 'shipment-fleet';
  const ctx = { isSuperuser: true, uiClientId: 'su-leader', workspaceId: 'ws-test', harnessSlug: 'papercusp' };
  const spec = {
    ...proposedSpecWithoutRevision,
    revision: 7,
    view: { filter: { field: 'id', op: 'in', value: [id] } },
    limits: { maxConcurrentClaims: 1 },
  };

  beforeEach(() => {
    for (const mock of Object.values(admissionMocks)) mock.mockReset();
    admissionMocks.getClaimSpecRecord.mockResolvedValue({
      source: 'fleet', spec, revision: 7, harnessSlug: 'papercusp', fleetSlug: fleet,
    });
    admissionMocks.readClaimSpecDelta.mockResolvedValue({
      currentClaimable: 0, proposedClaimable: 0, retained: 0,
      newlyExcludedCount: 0, newlyAdmittedCount: 0, newlyExcluded: [], newlyAdmitted: [],
      truncated: { newlyExcluded: false, newlyAdmitted: false },
    });
    admissionMocks.previewSpecFilterPartition.mockResolvedValue(null);
    admissionMocks.getWorkItem.mockResolvedValue({ id, family: 'issue' });
    admissionMocks.listFleetControlMembers.mockResolvedValue([holder]);
    admissionMocks.explainIssueClaimFloors.mockResolvedValueOnce([
      { id, admissible: false, refusedBy: 'already-taken', heldBy: holder },
    ]);
  });

  async function read(target: { fleet: string } | { cupId: string } = { fleet }, proposed = spec) {
    return (await previewSpecDeltaTool.handler(
      { ...target, harness: 'papercusp', proposed: structuredClone(proposed) } as never,
      ctx as never,
    ) as { data: Record<string, any> }).data;
  }

  it('reports normal own-fleet held admission even when the acquisition pool is empty, without writing', async () => {
    admissionMocks.explainIssueClaimFloors.mockResolvedValueOnce([{ id, admissible: true }]);
    const before = structuredClone(spec);
    const result = await read();
    expect(result.counts.proposedClaimable).toBe(0);
    expect(result.note).toContain('UNDETERMINED');
    expect(result.authoringAdmission.status).toBe('measured');
    expect(result.authoringAdmission.wouldRefuse).toBe(false);
    expect(result.authoringAdmission.preview.scopeAdmissibleIds).toEqual([id]);
    expect(result.authoringAdmission.preview.alreadyHeldIds).toEqual([id]);
    expect(admissionMocks.explainIssueClaimFloors).toHaveBeenNthCalledWith(2, 'papercusp', [id], {
      assignee: holder, states: ['open'], scopeHeldBy: [holder], claimantFleetSlug: fleet,
      claimSpecReferencesFleet: false, claimSpecReferencesGoal: false,
    });
    expect(spec).toEqual(before);
    expect(admissionMocks.setClaimSpec).not.toHaveBeenCalled();
  });

  it('preserves the holder cooldown refusal instead of waiving it with already-taken', async () => {
    admissionMocks.explainIssueClaimFloors.mockResolvedValueOnce([{ id, admissible: false, refusedBy: 'cooldown' }]);
    const result = await read();
    expect(result.authoringAdmission.wouldRefuse).toBe(true);
    expect(result.authoringAdmission.preview.scopeAdmissibleIds).toEqual([]);
    expect(result.authoringAdmission.preview.floored).toEqual([{ id, admissible: false, refusedBy: 'cooldown' }]);
    expect(result.authoringAdmission.errors[0]).toContain(id + ':cooldown');
    expect(admissionMocks.setClaimSpec).not.toHaveBeenCalled();
  });

  it('keeps an exact stop-line refusal when a different cohort row permits scope authoring', async () => {
    const repairId = 'EI-25735803469499102';
    admissionMocks.explainIssueClaimFloors.mockReset()
      .mockResolvedValueOnce([
        { id, admissible: false, refusedBy: 'already-taken', heldBy: holder },
        { id: repairId, admissible: true },
      ])
      .mockResolvedValueOnce([{ id, admissible: false, refusedBy: 'stop-line' }]);
    const result = await read({ fleet }, {
      ...spec, view: { filter: { field: 'id', op: 'in', value: [id, repairId] } },
    });
    // The write door accepts a cohort with a permitted row; that is not a
    // universal admission verdict. Consumers must inspect the named receipt.
    expect(result.authoringAdmission, JSON.stringify({
      admission: result.authoringAdmission,
      familyReads: admissionMocks.getWorkItem.mock.calls,
      floorReads: admissionMocks.explainIssueClaimFloors.mock.calls,
    })).toMatchObject({ status: 'measured', wouldRefuse: false });
    expect(result.authoringAdmission.preview.scopeAdmissibleIds).toEqual([repairId]);
    expect(result.authoringAdmission.preview.alreadyHeldIds).toEqual([]);
    expect(result.authoringAdmission.preview.floored).toEqual([{ id, admissible: false, refusedBy: 'stop-line' }]);
    expect(result.authoringAdmission.warning).toContain(id + ':stop-line');
    expect(admissionMocks.setClaimSpec).not.toHaveBeenCalled();
  });

  it('never accepts a holder outside the target fleet', async () => {
    admissionMocks.listFleetControlMembers.mockResolvedValue([]);
    const result = await read();
    expect(result.authoringAdmission.wouldRefuse).toBe(true);
    expect(result.authoringAdmission.preview.alreadyHeldIds).toEqual([]);
    expect(admissionMocks.explainIssueClaimFloors).toHaveBeenCalledTimes(1);
  });

  it('does not impersonate another cup merely because that cup inherits the fleet', async () => {
    const result = await read({ cupId: holder });
    expect(result.authoringAdmission.wouldRefuse).toBe(true);
    expect(result.authoringAdmission.preview.scopeAdmissibleIds).toEqual([]);
    expect(admissionMocks.listFleetControlMembers).not.toHaveBeenCalled();
    expect(admissionMocks.explainIssueClaimFloors).toHaveBeenCalledTimes(1);
  });

  it('reports a failed family read as unknown while retaining the independent pool reading', async () => {
    admissionMocks.getWorkItem.mockRejectedValue(new Error('family read unavailable'));
    const result = await read();
    expect(result.ok).toBe(true);
    expect(result.counts.proposedClaimable).toBe(0);
    expect(result.authoringAdmission.status).toBe('unknown');
    expect(result.authoringAdmission.wouldRefuse).toBeNull();
    expect(result.authoringAdmission.error).toBe('family read unavailable');
    expect(result.authoringAdmission.preview).toBeUndefined();
    expect(admissionMocks.setClaimSpec).not.toHaveBeenCalled();
  });

  it('leaves unchecked feature-family floors unmeasured rather than authorizing a false zero', async () => {
    admissionMocks.getWorkItem.mockResolvedValue({ id, family: 'feature' });
    const result = await read();
    expect(result.authoringAdmission.status).toBe('not-measured');
    expect(result.authoringAdmission.wouldRefuse).toBeNull();
    expect(result.authoringAdmission.preview.uncheckedFeatureIds).toEqual([id]);
    expect(admissionMocks.explainIssueClaimFloors).not.toHaveBeenCalled();
  });
});
