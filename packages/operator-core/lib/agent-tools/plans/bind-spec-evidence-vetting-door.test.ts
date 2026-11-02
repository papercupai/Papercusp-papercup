import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AcceptanceRubricVettingStatus } from '../../acceptance-rubric-vetting';
// Static (hoisted-mock-aware) import: the tool's module graph is heavy, so loading it at
// collection time keeps that cost out of the first test's timeout budget.
import tool, { bindSpecEvidenceTestSeams } from './bind-spec-evidence';

/**
 * P-004 of review-system-rework-reduction-2026-09-23 — VET BEFORE PROOF, at the DOOR.
 *
 * Spec clause RSR-P-004-A: "plans:bind-spec-evidence against an unvetted rubric revision
 * returns a warning naming that revision." `bind-vetting-advisory.test.ts` pins the pure
 * helper; this file pins the TOOL: the real `plans:bind-spec-evidence` handler, with only
 * its storage and rubric/vetting reads replaced. It proves the handler (a) still writes the
 * binding, (b) returns the advisory on its result, naming the rubric and its revision, and
 * (c) stays silent for a vetted rubric, a refused binding, and non-BAR proof.
 */

const mocks = vi.hoisted(() => ({
  bindSpecEvidence: vi.fn(),
  retractSpecEvidence: vi.fn(),
  retractSpecEvidenceBatch: vi.fn(),
  getAcceptanceRubricsForPlan: vi.fn(),
  getAcceptanceRubricVettingStatus: vi.fn(),
}));

vi.mock('./spec-evidence-store', async (orig) => ({
  ...(await orig<typeof import('./spec-evidence-store')>()),
  bindSpecEvidence: mocks.bindSpecEvidence,
  retractSpecEvidence: mocks.retractSpecEvidence,
  retractSpecEvidenceBatch: mocks.retractSpecEvidenceBatch,
}));
vi.mock('../../rubrics', async (orig) => ({
  ...(await orig<typeof import('../../rubrics')>()),
  getAcceptanceRubricsForPlan: mocks.getAcceptanceRubricsForPlan,
}));
vi.mock('../../acceptance-rubric-vetting', async (orig) => ({
  ...(await orig<typeof import('../../acceptance-rubric-vetting')>()),
  getAcceptanceRubricVettingStatus: mocks.getAcceptanceRubricVettingStatus,
}));
vi.mock('./adequacy-attestation-gap', async (orig) => ({
  ...(await orig<typeof import('./adequacy-attestation-gap')>()),
  rebindAttestationAdvisory: vi.fn().mockResolvedValue(null),
}));
vi.mock('../coordination/identity', async (orig) => ({
  ...(await orig<typeof import('../coordination/identity')>()),
  // No concrete workspace: runWithWorkspaceIfConcrete then runs the read inline, so the
  // test exercises the handler's own control flow rather than the ALS plumbing.
  resolveAgentIdentity: () => ({ ownerId: 'su-door-test', workspaceId: undefined }),
}));

const PLAN = 'demo-plan';
const RUBRIC_REF = 'acceptance-demo-plan';

function vetting(over: Partial<AcceptanceRubricVettingStatus> = {}): AcceptanceRubricVettingStatus {
  return {
    required: true,
    satisfied: false,
    state: 'unvetted',
    reason: 'missing-attestation',
    gateEnabled: true,
    metaRubricRef: 'meta-acceptance-rubric',
    currentRevision: 7,
    attestedRevision: null,
    attestedRevisions: [],
    attestationIssueId: null,
    consultId: null,
    workItemId: null,
    candidates: [],
    diagnosis: null,
    ...over,
  } as AcceptanceRubricVettingStatus;
}

const binding = (specId: string) => ({
  workItemId: 'WI-1',
  specId,
  evidenceKind: 'test' as const,
  evidenceRef: 'packages/demo/lib/demo.test.ts',
  sourceFingerprint: 'git:abc123',
});

type BindBody = {
  results: Array<{ ok: boolean }>;
  advisories?: Array<{
    code: string;
    rubricRef: string;
    currentRevision: number | null;
    barSpecIds: string[];
    message: string;
  }>;
};

async function bind(args: Record<string, unknown>): Promise<BindBody> {
  const ctx = { harnessSlug: 'papercusp', workspaceId: 'ws-door-test' };
  const out = (await tool.handler(args as never, ctx as never)) as { data: BindBody };
  return out.data;
}

describe('plans:bind-spec-evidence — unvetted-rubric advisory at the tool door (P-004)', () => {
  beforeEach(() => {
    mocks.bindSpecEvidence.mockReset().mockResolvedValue({ status: 'created', bindingId: 1 });
    mocks.getAcceptanceRubricsForPlan.mockReset().mockResolvedValue([{ rubricId: RUBRIC_REF }]);
    mocks.getAcceptanceRubricVettingStatus.mockReset().mockResolvedValue(vetting());
    // P-011's declared-configuration check reads the clause, its BAR and the run snapshot;
    // these bars declare no configuration, so the check stays out of the advisory under test.
    bindSpecEvidenceTestSeams.declaredConfigurationDeps = () => ({
      loadClauses: vi.fn().mockResolvedValue([]),
      loadCriterion: vi.fn().mockResolvedValue(null),
      readSnapshot: vi.fn().mockResolvedValue(null),
    });
  });

  it('writes the BAR binding AND returns a warning naming the unvetted rubric revision', async () => {
    const body = await bind({ slug: PLAN, binding: binding('AUTO-BAR-R-2-P-004') });

    // Advisory, never a refusal: the proof is still recorded.
    expect(mocks.bindSpecEvidence).toHaveBeenCalledTimes(1);
    expect(body.results).toEqual([expect.objectContaining({ ok: true })]);

    expect(body.advisories).toHaveLength(1);
    const advisory = body.advisories![0]!;
    expect(advisory).toMatchObject({
      code: 'acceptance_rubric_unvetted_before_proof',
      rubricRef: RUBRIC_REF,
      currentRevision: 7,
      barSpecIds: ['AUTO-BAR-R-2-P-004'],
    });
    // "naming that revision" — in the prose a caller reads, not only in a structured field.
    expect(advisory.message).toContain(`'${RUBRIC_REF}' is UNVETTED at revision 7`);
    expect(mocks.getAcceptanceRubricsForPlan).toHaveBeenCalledWith(PLAN, { harnessSlug: 'papercusp' });
  });

  it('returns no advisory once the current revision is vetted', async () => {
    mocks.getAcceptanceRubricVettingStatus.mockResolvedValue(
      vetting({ satisfied: true, state: 'vetted', reason: 'attested' as AcceptanceRubricVettingStatus['reason'] }),
    );
    const body = await bind({ slug: PLAN, binding: binding('AUTO-BAR-R-2-P-004') });
    expect(mocks.bindSpecEvidence).toHaveBeenCalledTimes(1);
    expect(body.advisories).toBeUndefined();
  });

  it('publishes confirmed binding IDs while the post-write advisory is still pending', async () => {
    let advisoryStarted!: () => void;
    let rejectAdvisory!: (reason: Error) => void;
    const started = new Promise<void>((resolve) => {
      advisoryStarted = resolve;
    });
    mocks.bindSpecEvidence.mockResolvedValue({ status: 'created', id: 123 });
    mocks.getAcceptanceRubricsForPlan.mockImplementation(() => {
      advisoryStarted();
      return new Promise((_, reject) => {
        rejectAdvisory = reject;
      });
    });
    let latest: Record<string, unknown> = {};
    const ctx = {
      harnessSlug: 'papercusp',
      workspaceId: 'ws-door-test',
      metadata: (metadata: Record<string, unknown>) => {
        latest = metadata;
      },
    };
    const pending = tool.handler({ slug: PLAN, binding: binding('AUTO-BAR-R-2-P-004') } as never, ctx as never);
    await started;
    expect(latest.plansBindSpecEvidenceStageTimings).toMatchObject({
      active: { vettingAdvisory: 1 },
      storedBindingIds: [123],
    });
    rejectAdvisory(new Error('advisory read failed after commit'));
    const out = (await pending) as { data: BindBody };
    expect(out.data.results).toEqual([expect.objectContaining({ ok: true, id: 123 })]);
    expect(latest.plansBindSpecEvidenceStageTimings).toMatchObject({
      active: {},
      storedBindingIds: [123],
    });
  });

  it('returns no advisory for a REFUSED binding — only proof that actually landed counts', async () => {
    mocks.bindSpecEvidence.mockResolvedValue({ status: 'spec_not_found' });
    const body = await bind({ slug: PLAN, binding: binding('AUTO-BAR-R-2-P-004') });
    expect(body.results).toEqual([expect.objectContaining({ ok: false })]);
    expect(body.advisories).toBeUndefined();
    expect(mocks.getAcceptanceRubricsForPlan).not.toHaveBeenCalled();
  });

  it('returns no advisory for non-BAR proof and never reads the rubric store', async () => {
    const body = await bind({ slug: PLAN, binding: binding('RSR-P-004-A') });
    expect(mocks.bindSpecEvidence).toHaveBeenCalledTimes(1);
    expect(body.advisories).toBeUndefined();
    expect(mocks.getAcceptanceRubricsForPlan).not.toHaveBeenCalled();
  });
});

describe('plans:bind-spec-evidence batch retraction boundary', () => {
  beforeEach(() => {
    mocks.retractSpecEvidence.mockReset().mockResolvedValue({
      status: 'already_retracted',
      bindingId: 701,
      binding: null,
    });
    mocks.retractSpecEvidenceBatch.mockReset().mockResolvedValue([
      { status: 'retracted', bindingId: 701, binding: { id: 701 }, cancelledAuditIssueIds: [] },
      { status: 'already_retracted', bindingId: 702, binding: { id: 702 } },
    ]);
  });

  it('sends the full request to one store transaction instead of retracting each row separately', async () => {
    const items = [
      { bindingId: 701, reason: 'replace stale evidence' },
      { bindingId: 702, reason: 'replace stale evidence' },
    ];
    const ctx = { harnessSlug: 'papercusp', workspaceId: 'ws-door-test' };
    const out = (await tool.handler({ retract: items } as never, ctx as never)) as {
      data: { results: Array<{ ok: boolean }> };
    };

    expect(mocks.retractSpecEvidenceBatch).toHaveBeenCalledExactlyOnceWith({
      harnessSlug: 'papercusp',
      actorId: 'su-door-test',
      items,
    });
    expect(mocks.retractSpecEvidence).not.toHaveBeenCalled();
    expect(out.data.results).toEqual([
      expect.objectContaining({ ok: true, bindingId: 701 }),
      expect.objectContaining({ ok: true, bindingId: 702 }),
    ]);
  });
});
