/**
 * Side-effect-free activation-readiness wiring. The helper owns the dynamic
 * production imports so plans:get and plans:audit can expose the same
 * plans:start candidate preview without opening a consult thread.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const M = vi.hoisted(() => ({
  getOrgPg: vi.fn(),
  routeConsult: vi.fn(),
  buildQueryEmbedderResolved: vi.fn(),
  resolveSessionStates: vi.fn(),
  planStartConsult: vi.fn(),
  fetchTurnExcerpts: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: M.getOrgPg,
}));
vi.mock('../../consult/relevance-router', () => ({ routeConsult: M.routeConsult }));
vi.mock('../search/embedder', () => ({ buildQueryEmbedderResolved: M.buildQueryEmbedderResolved }));
vi.mock('../coordination/liveness-oracle', () => ({ resolveSessionStates: M.resolveSessionStates }));
vi.mock('../../consult/plan-start-consult', () => ({
  planStartConsult: M.planStartConsult,
  fetchTurnExcerpts: M.fetchTurnExcerpts,
}));
// getBuildInfo falls back to `git rev-parse` with a 2s timeout; under host load
// it returns (and caches) null, which flaked the buildSha assertion below.
vi.mock('../../build-info', () => ({ getBuildInfo: () => ({ sha: 'abc1234', version: '0.0.0' }) }));

import { activationDeclarationReadiness, previewPlanStartConsult } from './get-activation-readiness';

const params = {
  workspaceId: 'workspace-a',
  requesterId: 'su-reader',
  planSlug: 'plan-a',
  planContent: '---\nslug: plan-a\n---\n\n## Now\nship it',
};

beforeEach(() => {
  vi.clearAllMocks();
  const sql = vi.fn();
  M.getOrgPg.mockReturnValue({ sql });
  M.buildQueryEmbedderResolved.mockResolvedValue({
    mode: 'gemma',
    dims: 768,
    profile: {
      profileId: 'gemma-embeddinggemma-300m-768@v1',
      model: 'onnx-community/embeddinggemma-300m-ONNX',
      revision: 'v1',
      targetDims: 768,
      normalization: 'l2',
      distanceMetric: 'cosine',
      queryRecipe: 'gemma-query-v1',
      documentRecipe: 'gemma-document-v1',
    },
    embed: 'embedder',
  });
  M.resolveSessionStates.mockResolvedValue(
    new Map([['peer-live', { ownerId: 'peer-live', sessionState: 'live' }]]),
  );
  M.routeConsult.mockImplementation(async (_routeParams, options) => {
    options.getSql();
    const liveness = await options.getLiveness(['peer-live']);
    return { liveness };
  });
  M.fetchTurnExcerpts.mockResolvedValue([
    {
      ownerId: 'peer-dead',
      session_id: 'session-dead',
      turn_idx: 4,
      ts: null,
      sim: 0.7,
      excerpt: 'prior attempt',
    },
  ]);
});

describe('previewPlanStartConsult', () => {
  it('wires production routing, liveness, and excerpt callbacks without opening a consult', async () => {
    M.planStartConsult.mockImplementation(async (consultParams, deps) => {
      await deps.route({
        workspaceId: consultParams.workspaceId,
        requesterId: consultParams.requesterId,
        question: 'plan query',
      });
      const excerpts = await deps.getExcerpts([{
        ownerId: 'peer-dead',
        evidence: [{ session_id: 'session-dead', turn_idx: 4, ts: null, sim: 0.7 }],
      }]);
      return { outcome: 'proceed_with_excerpts', candidates: [], excerpts };
    });

    const result = await previewPlanStartConsult(params);

    expect(result).toMatchObject({
      outcome: 'proceed_with_excerpts',
      excerpts: [{ ownerId: 'peer-dead', excerpt: 'prior attempt' }],
      productShaping: { advisory: true, status: 'missing', semanticCompleteness: 'not-measured' },
    });
    expect(M.buildQueryEmbedderResolved).toHaveBeenCalledTimes(1);
    expect(M.planStartConsult).toHaveBeenCalledWith(params, expect.any(Object));
    expect(M.routeConsult).toHaveBeenCalledWith(
      {
        workspaceId: 'workspace-a',
        requesterId: 'su-reader',
        question: 'plan query',
        telemetry: expect.objectContaining({ caller: 'plans:activation-preview', policy: 'consult-default', buildSha: expect.any(String) }),
      },
      expect.any(Object),
    );
    expect(M.resolveSessionStates).toHaveBeenCalledWith(
      [{ ownerId: 'peer-live' }],
      { hydratePerId: true },
    );
    expect(M.fetchTurnExcerpts).toHaveBeenCalledWith(
      expect.any(Function),
      'workspace-a',
      [{ ownerId: 'peer-dead', evidence: [{ session_id: 'session-dead', turn_idx: 4, ts: null, sim: 0.7 }] }],
    );
  });

  it('reports an unavailable advisory outcome when production wiring cannot initialize', async () => {
    M.buildQueryEmbedderResolved.mockRejectedValue(new Error('embedder unavailable'));

    const result = await previewPlanStartConsult(params);

    expect(result).toMatchObject({
      outcome: 'unavailable',
      error: 'consult_preview_unavailable',
      message: 'Consult candidate preview could not be evaluated (embedder unavailable).',
      productShaping: { advisory: true, status: 'missing', reviewerBrief: { sourceRefs: [] } },
    });
    expect(M.planStartConsult).not.toHaveBeenCalled();
  });

  it('keeps the original-intent review available even when consult routing is unavailable', async () => {
    M.buildQueryEmbedderResolved.mockRejectedValue(new Error('embedder unavailable'));
    const sourceRef = 'session_turn:codex:original:1';
    const planContent = '## Product shaping\n```product-shaping\n' + JSON.stringify({
      audience: 'Collaborators', problem: 'Readers can accidentally publish', outcome: 'Readers retain read access without publishing',
      nonGoals: ['Role administration'], sourceRefs: [sourceRef], context: [], scenarios: [], considerations: [],
    }) + '\n```';
    const result = await previewPlanStartConsult({ ...params, planContent });
    expect(result).toMatchObject({ outcome: 'unavailable', productShaping: {
      status: 'incomplete', advisory: true, sourceContentVerified: false,
      reviewerBrief: { sourceRefs: [sourceRef], planSection: 'Product shaping' },
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'normal_journey_missing' })]),
    } });
    expect(result.productShaping?.reviewerBrief.instructions[0]).toContain('BEFORE');
  });
});

// plan-reuse-and-library-declarations-2026-10-20 R-3.
describe('activationDeclarationReadiness', () => {
  const plan = (sections = '') =>
    `---\ntitle: Plan A\nslug: plan-a\nstatus: draft\n---\n\n## Items\n\n- **P-001** \`todo\` Do the thing.\n${sections}`;
  const librariesNotApplicable =
    '\n## Third-party libraries\n\n```libraries\n{"needs":[],"notApplicable":"No library could do this."}\n```\n';

  it('R-3: readiness lists a missing declaration section as a blocker', () => {
    const readiness = activationDeclarationReadiness(plan(librariesNotApplicable), 'draft');
    expect(readiness).toMatchObject({
      ready: false,
      applies: true,
      reuse: 'missing',
      libraries: 'not-applicable',
      blockers: [{ code: 'plan_declarations_invalid', section: 'Existing infrastructure reused', status: 'missing' }],
    });
    expect(readiness.blockers).toHaveLength(1);
  });

  it('R-3 / D-013 #1: a plan with no status is gated (fail closed)', () => {
    expect(activationDeclarationReadiness(plan(), null)).toMatchObject({
      ready: false, applies: true, reuse: 'missing', libraries: 'missing',
    });
  });

  it('R-3: readiness reports no blockers for an active plan (no retrofit)', () => {
    expect(activationDeclarationReadiness(plan(), 'active')).toMatchObject({
      ready: true, applies: false, reuse: 'missing', libraries: 'missing', blockers: [],
    });
  });
});
