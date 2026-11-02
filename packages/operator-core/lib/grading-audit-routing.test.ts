import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { routeGoalTenureGrading } from './grading-audit-routing';
import { mockResolvedTyped } from './testing/typed-mock';
import type { getFeedbackProd } from './consult/get-feedback-prod';
import { getFeedbackCore, type GetFeedbackDeps } from './consult/get-feedback-core';
import type { RouteResult } from './consult/relevance-router';

const NOW = Date.UTC(2026, 10, 2, 15);
const goal = { workspaceId: 'test-grading-recovery', goalId: 'goal-backlog' };

function fixture(options: { status?: string; prior?: Record<string, unknown>; pickup?: boolean; verdict?: string } = {}) {
  let prior = options.prior;
  const queries: string[] = [];
  const sql = vi.fn(async (parts: TemplateStringsArray) => {
    const query = parts.join('?'); queries.push(query);
    if (query.includes('SELECT status')) return [{ status: options.status ?? 'active' }];
    if (query.includes('SELECT conversation_id')) return prior ? [prior] : [];
    if (query.includes('SELECT DISTINCT coord_owner_id')) return [{ owner_id: 'su-holder' }];
    if (query.includes("SET state = 'expired'")) prior = undefined;
    return [];
  }) as unknown as Sql;
  const feedback = vi.fn(async () => {
    prior = { conversation_id: 'conv-new', state: 'awaiting_responder', answering_owner_id: 'su-answering',
      created_at: new Date(NOW), expires_at: new Date(NOW + 60_000) };
    return { verdict: options.verdict ?? 'routed', conversation_id: 'conv-new',
      responder: { ownerId: 'su-ended-archive-source' },
      wake: { queued: 1, woke: options.pickup ? 1 : 0, pickupConfirmed: options.pickup ?? false } };
  }) as unknown as typeof getFeedbackProd;
  const resolveResponderLiveness = vi.fn<
    NonNullable<Parameters<typeof routeGoalTenureGrading>[1]['resolveResponderLiveness']>
  >(async () => ({ sessionState: 'live' }));
  return { sql, feedback, resolveResponderLiveness, now: () => NOW, queries };
}

describe('goal tenure grading recovery through the shared dispatcher', () => {
  it('keeps queued delivery pending and dedupes the answering identity rather than its ended source', async () => {
    const d = fixture();
    expect(await routeGoalTenureGrading(goal, d)).toMatchObject({ state: 'pending', conversationId: 'conv-new' });
    expect(await routeGoalTenureGrading(goal, d)).toMatchObject({ state: 'deduped' });
    expect(d.resolveResponderLiveness).toHaveBeenCalledWith('su-answering');
    expect(d.feedback).toHaveBeenCalledTimes(1);
    const request = vi.mocked(d.feedback).mock.calls[0]![0];
    expect(request.cascade).toMatchObject({ flavor: 'goal-tenure-grading', ...goal, holderOwnerIds: ['su-holder'] });
    expect(request.excludeOwners).toEqual(['su-holder']);
    expect(request.archiveFloor).toBeGreaterThan(1);
  });

  it('serializes simultaneous sweep ticks into one persistent request', async () => {
    const d = fixture({ pickup: true });
    const results = await Promise.all([routeGoalTenureGrading(goal, d), routeGoalTenureGrading(goal, d)]);
    expect(results.map(result => result.state).sort()).toEqual(['deduped', 'routed']);
    expect(d.feedback).toHaveBeenCalledTimes(1);
  });

  it.each(['ended', 'recorded'] as const)('replaces a %s answering session while the alert stays open', async state => {
    const d = fixture({ pickup: true, prior: { conversation_id: 'old', state: 'active',
      answering_owner_id: 'su-dead-answer', created_at: new Date(NOW - 60_000), expires_at: new Date(NOW + 60_000) } });
    mockResolvedTyped(d.resolveResponderLiveness, { sessionState: state });
    expect(await routeGoalTenureGrading(goal, d)).toMatchObject({ state: 'routed' });
    expect(d.queries.some(query => query.includes("SET state = 'expired'"))).toBe(true);
    expect(d.feedback).toHaveBeenCalledTimes(1);
  });

  it('recovers an expired request with no responder but preserves unmeasured ownership', async () => {
    const prior = { conversation_id: 'old', state: 'active', answering_owner_id: null,
      created_at: new Date(NOW - 600_000), expires_at: new Date(NOW - 1) };
    expect(await routeGoalTenureGrading(goal, fixture({ prior, pickup: true }))).toMatchObject({ state: 'routed' });
    const d = fixture({ prior: { ...prior, answering_owner_id: 'su-unknown', expires_at: new Date(NOW + 60_000) } });
    d.resolveResponderLiveness.mockRejectedValue(new Error('liveness unavailable'));
    expect(await routeGoalTenureGrading(goal, d)).toMatchObject({ state: 'deduped' });
    expect(d.feedback).not.toHaveBeenCalled();
  });

  it('keeps absent routing capacity retryable and bounds exhausted-menu recruitment', async () => {
    expect(await routeGoalTenureGrading(goal, fixture({ verdict: 'no_launchable_responder' }))).toMatchObject({ state: 'retry' });
    const d = fixture({ prior: { conversation_id: 'old', state: 'declined', created_at: new Date(NOW - 1) } });
    expect(await routeGoalTenureGrading(goal, d)).toMatchObject({ state: 'retry' });
    expect(d.feedback).not.toHaveBeenCalled();
  });

  it.each(['paused', 'closed', 'draft'])('does not launch or resume a %s goal', async status => {
    const d = fixture({ status });
    expect(await routeGoalTenureGrading(goal, d)).toMatchObject({ state: 'skipped' });
    expect(d.feedback).not.toHaveBeenCalled();
  });
});

describe('persisted residual-grading independence', () => {
  function coreFixture(incomplete = false) {
    const candidates = ['su-holder-child', 'su-independent'].map(ownerId => ({
      ownerId, relevance: 0.9, score: 0.9, evidence: [], liveness: 'live',
      signals: { similarity: 0.9 },
    }));
    const route = { qualified: [...candidates], snapshot: { candidates: [...candidates] } } as unknown as RouteResult;
    const deps = {
      getSql: () => (async () => []) as unknown as Sql,
      route: vi.fn(async () => route),
      getPartyKeys: vi.fn(async () => new Map(incomplete ? [] : [
        ['su-holder', 'holder-party'], ['su-holder-child', 'holder-party'], ['su-independent', 'independent-party'],
      ])),
      open: vi.fn(async () => { throw new Error('stop before persistence'); }),
    } as unknown as GetFeedbackDeps;
    return { route, deps };
  }

  const request = { workspaceId: goal.workspaceId, requesterId: 'system:goal-grading-recovery',
    originTaskRef: goal.goalId, question: 'Finish residual goal tenure grading', archiveFloor: 2,
    policy: 'goal-tenure-grading',
    cascade: { flavor: 'goal-tenure-grading' as const, ...goal, holderOwnerIds: ['su-holder'] } };

  it('excludes holder lineage from the whole persisted pool before opening a request', async () => {
    const { route, deps } = coreFixture();
    await expect(getFeedbackCore(request, deps)).rejects.toThrow('stop before persistence');
    expect(deps.route).toHaveBeenCalledWith(expect.objectContaining({ excludePartyOwners: ['su-holder'] }));
    expect(route.qualified.map(candidate => candidate.ownerId)).toEqual(['su-independent']);
    expect(route.snapshot.candidates.map(candidate => candidate.ownerId)).toEqual(['su-independent']);
    expect(route.snapshot.cascade).toEqual(request.cascade);
  });

  it('refuses incomplete lineage rather than treating an unmapped holder as independent', async () => {
    const { deps } = coreFixture(true);
    await expect(getFeedbackCore(request, deps)).rejects.toThrow('goal tenure grading lineage resolution is incomplete');
    expect(deps.open).not.toHaveBeenCalled();
  });
});
