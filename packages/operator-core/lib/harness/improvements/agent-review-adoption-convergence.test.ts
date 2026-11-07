/** P-009 convergence: exercise the adoption loop; real SQL windows have their own PG test. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '../../work-items';
import { createBranchedSqlMock } from '../../testing/sql-mock';

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { unsafe: (fragment: string) => fragment }),
}));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));

import { adoptNextAgentReviewRevision, type AgentReviewDeps } from './agent-review';

function revision(id: string, submitter: string): WorkItem {
  return {
    id, kind: 'bug', family: 'issue', harness: 'papercusp', state: 'open',
    assignee: null, createdBy: submitter, title: 'Content revision', summary: 'Measured fixture',
    payload: { agentReview: {
      status: 'revision-requested', revisionKind: 'content', round: 2,
      ledgerIdeaId: id, submittedBy: submitter,
    } },
  } as WorkItem;
}

describe('adopt-next stable refusal convergence (SPEC-BQL-P-009-CONVERGENCE)', () => {
  beforeEach(() => sqlMock.mockReset());

  it.each([
    ['unmeasured', null, 'not-submitter:liveness-unknown', true],
    ['live', { sessionState: 'live' }, 'not-submitter', false],
  ] as const)('continues past a %s submitter and stamps only stable refusals', async (_label, verdict, reason, stable) => {
    const rows = new Map([
      ['WI-HEAD', revision('WI-HEAD', 'su-head')],
      ['WI-ELIGIBLE', revision('WI-ELIGIBLE', 'su-gone')],
    ]);
    const branches = createBranchedSqlMock([
      {
        label: 'ordered adoption candidates',
        match: (query) => query.includes('SELECT feature_id'),
        respond: () => [...rows.keys()].map((feature_id) => ({ feature_id })),
      },
      // Unit subject is the loop's decisions. The companion integration suite executes
      // the composed dependency/filter/probe SQL against real PG, including >25 rows.
      { label: 'SQL composition fragments', match: (query) => !query.includes('SELECT feature_id'), respond: () => [] },
    ]);
    sqlMock.mockImplementation(branches.handler);
    const getWorkItem = vi.fn(async (id: string) => structuredClone(rows.get(id) ?? null));
    const claimWorkItem = vi.fn(async (id: string, assignee: string) => {
      const row = rows.get(id)!;
      rows.set(id, { ...row, assignee });
      return getWorkItem(id);
    });
    const mergeWorkItemPayload = vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const row = rows.get(id)!;
      rows.set(id, { ...row, payload: { ...(row.payload as Record<string, unknown>), ...patch } });
      return getWorkItem(id);
    });
    const deps = {
      getWorkItem, claimWorkItem, mergeWorkItemPayload,
      getWorkItemDetail: vi.fn(async () => ({ posts: [] })),
      commentWorkItem: vi.fn(async () => ({})),
      resolveVerifiedSubmitterAlias: vi.fn(async () => null),
      resolveSubmitterLiveness: vi.fn(async (owner: string) => owner === 'su-head' ? verdict : { sessionState: 'ended' }),
    } as unknown as AgentReviewDeps;

    const result = await adoptNextAgentReviewRevision({
      adopter: 'su-adopter', harnessSlug: 'papercusp', workspaceId: 'ws-convergence',
    }, deps);

    expect(result).toMatchObject({
      adopted: true, workItem: { id: 'WI-ELIGIBLE' }, scanned: 2, refusals: { [reason]: 1 },
    });
    expect(claimWorkItem.mock.calls.map(([id]) => id)).toEqual(['WI-ELIGIBLE']);
    expect(rows.get('WI-HEAD')?.assignee).toBeNull();
    if (stable) {
      expect(rows.get('WI-HEAD')?.payload).toMatchObject({
        agentReviewAdoptionProbe: { reason, round: 2, at: expect.any(String) },
      });
    } else {
      expect(rows.get('WI-HEAD')?.payload).not.toHaveProperty('agentReviewAdoptionProbe');
    }
    expect(rows.get('WI-ELIGIBLE')?.payload).toMatchObject({
      agentReview: { submittedBy: 'su-adopter', round: 2 },
    });
    branches.assertAllMatched();
  });
});
