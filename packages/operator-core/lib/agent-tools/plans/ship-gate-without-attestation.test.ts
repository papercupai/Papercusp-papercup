import { describe, expect, it, vi } from 'vitest';
import { FLAGS } from '@papercusp/flags';
import type { Rubric } from '../../rubrics';
import { getAcceptanceRubricVettingStatus } from '../../acceptance-rubric-vetting';
import { critiqueCoversRubric, readCurrentAcceptanceRubricCritique } from '../../acceptance-rubric-critique';
import { evaluatePlanAcceptanceGate } from '../../plan-acceptance-gate';

const rubric = {
  rubricId: 'acceptance-plan', revision: 4, criteriaHash: 'current-hash', workspaceId: 'ws-test',
  kind: 'acceptance', subjectPlan: 'plan', gradingAuthority: 'independent', createdBy: 'author', proposedBy: 'author',
  criteria: [{ key: 'works', title: 'Works', model: 'observable' }], ratingScale: ['pass', 'fail'],
} as Rubric;
const critique = { consultId: 'consult-review', workItemId: null, rubricRevision: 4, criteriaHash: 'current-hash',
  createdAt: '2026-08-10T00:00:00Z', critics: ['reviewer'] };
const mocks = vi.hoisted(() => ({ cards: vi.fn() }));
vi.mock('../../rubrics', async original => ({ ...await original<typeof import('../../rubrics')>(),
  getAcceptanceRubricsForPlan: async () => [rubric], getRetiredAcceptanceRubricsForPlan: async () => [],
  getRubric: async () => ({ ...rubric, rubricId: 'meta-acceptance-rubric', kind: 'standard' }),
  readRubricPlanRevision: async () => ({ ok: true, revision: 4 }), getRubricPlanRevision: async () => 4,
}));
vi.mock('../../scorecards', async original => ({ ...await original<typeof import('../../scorecards')>(), listScorecards: mocks.cards }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: async (flag: string) =>
  [FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE, FLAGS.ACCEPTANCE_RUBRIC_VETTING_GATE].includes(flag as never) }));
vi.mock('@papercusp/db-org', async original => ({ ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: async () => [{ plan_slug: 'plan', template: null, content: null }] }),
}));
vi.mock('../../acceptance-author-identity', () => ({ areAcceptanceLineageRelated: async (a: string, b: string) => a === b,
  resolvePlanImplementerIdentities: async () => [] }));
vi.mock('../../acceptance-grading-authority', async original => ({ ...await original<typeof import('../../acceptance-grading-authority')>(),
  readGraderSelectionVia: async () => new Map() }));
vi.mock('../../goals/plan-closure-observations', async original => ({
  ...await original<typeof import('../../goals/plan-closure-observations')>(), beginPlanClosureObservation: async () => null,
}));
vi.mock('../../agent-tools/work_items/design-evidence-gate', () => ({ planDesignEvidenceGate: async () => [] }));
vi.mock('../../independent-verification-gate', () => ({ evaluateIndependentVerificationGate: async () => ({ satisfied: true }) }));
vi.mock('../../blind-review-gate', () => ({ evaluateBlindReviewGate: async () => ({ satisfied: true }) }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

describe('ship gate without a vetting attestation', () => {
  it('ships with current independent critique and zero meta-scorecards or attestation audits', async () => {
    mocks.cards.mockImplementation(async ({ rubricRef }: { rubricRef: string }) => rubricRef === 'acceptance-plan' ? [{
      issueId: 'grade', rubricRef, rubricRevision: 4, criteriaHash: 'current-hash', createdBy: 'grader',
      createdAt: '2026-08-11T00:00:00Z', ratings: { works: { rating: 'pass', evidence: 'observed' } },
      rubricResolved: true, missingKeys: [], extraKeys: [], synthesized: false, linkedItems: [],
    }] : []);
    const result = await evaluatePlanAcceptanceGate('plan', { readCurrentCritique: async () => critique });
    expect(result).toMatchObject({ satisfied: true });
  });

  it('satisfies the shared grading/read gate without a meta-card', async () => {
    const listScorecards = vi.fn(async () => []);
    const result = await getAcceptanceRubricVettingStatus(rubric, {
      vettingGateEnabled: true, getRubric: async () => rubric, getRubricPlanRevision: async () => 4,
      listScorecards, readCurrentCritique: async () => critique,
    });
    expect(result).toMatchObject({ satisfied: true, attestationIssueId: null, critique });
    expect(result.pendingGradingAuditRepair).toBeUndefined();
    expect(listScorecards).not.toHaveBeenCalled();
  });

  it.each([
    ['unanswered', { exists: true, critiquePosts: 0, critics: [] }],
    ['self-review', { exists: true, critiquePosts: 1, critics: ['author'] }],
    ['declined', { exists: true, critiquePosts: 0, critics: ['reviewer'] }],
  ])('refuses %s consult evidence', async (_label, answer) => {
    expect(await readCurrentAcceptanceRubricCritique(rubric, 4, {
      candidates: async () => [{ consultId: 'consult-review', request: 'Vet acceptance-plan criteriaHash current-hash', createdAt: critique.createdAt }],
      consult: async () => answer,
    })).toBeNull();
  });

  it('admits the independent work-item critique channel directly', async () => {
    expect(await readCurrentAcceptanceRubricCritique(rubric, 4, {
      candidates: async () => [{ workItemId: 'WI-review', request: 'Vet acceptance-plan revision 4', createdAt: critique.createdAt }],
      workItem: async () => ({ exists: true, critiquePosts: 1, critics: ['reviewer'] }),
    })).toMatchObject({ workItemId: 'WI-review', critics: ['reviewer'] });
  });

  it.each(['Vet acceptance-plan revision 3', 'Vet acceptance-plan revision 4 criteriaHash old-hash',
    'Vet acceptance-plan-else revision 4', 'Vet acceptance-plan'])('rejects stale or unbound request: %s', request => {
    expect(critiqueCoversRubric(request, rubric, 4)).toBe(false);
  });
});
