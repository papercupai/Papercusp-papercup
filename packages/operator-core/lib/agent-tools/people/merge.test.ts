/**
 * merge.test.ts — the people:merge HANDLER (crm-agent-sales-onboarding-apps-2026-10-06 D-027, R-2).
 * The graph merge itself (stamping, survivor choice, idempotent replay) is pinned against real
 * Postgres in relationship-graph.integration.test.ts; this pins what the tool adds on top: the
 * caller is recorded as the merge's acceptedBy, coding agents and an unscoped workspace are refused
 * before any write, and a MergeEntitiesError becomes { ok:false, error } instead of a thrown fault.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sql: { tag: 'org-sql' },
  calls: [] as Array<{ sql: unknown; workspaceId: string; input: unknown }>,
  outcome: null as unknown,
}));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(() => ({ sql: h.sql })),
}));
vi.mock('../../relationship-graph/people', async (orig) => ({
  ...(await orig<typeof import('../../relationship-graph/people')>()),
  mergePeople: vi.fn(async (sql: unknown, workspaceId: string, input: unknown) => {
    h.calls.push({ sql, workspaceId, input });
    if (h.outcome instanceof Error) throw h.outcome;
    return h.outcome;
  }),
}));

const { MergeEntitiesError } = await import('../../relationship-graph/resolver');
const tool = (await import('./merge')).default;

// The handler returns { data }, which the tool layer serializes (same shape as people:search).
type Out = { data: Record<string, unknown> };
const SU = { isSuperuser: true, uiClientId: 'su-merge-test', workspaceId: 'ws-1' };
const call = (args: unknown, ctx: Record<string, unknown> = SU) =>
  tool.handler(args as never, ctx as never) as unknown as Promise<Out>;
const body = (o: Out) => o.data;

beforeEach(() => {
  h.calls = [];
  h.outcome = { person: { id: 'PER-1', displayName: 'Ada' }, merged: ['PER-1', 'PER-2'], alreadyMerged: false };
});

describe('people:merge handler', () => {
  it('merges in the caller workspace and records the caller as acceptedBy', async () => {
    const b = body(await call({ ids: ['PER-2', 'PER-1'] }));
    expect(b).toMatchObject({ ok: true, person: { id: 'PER-1' }, merged: ['PER-1', 'PER-2'], alreadyMerged: false });
    expect(h.calls).toEqual([{ sql: h.sql, workspaceId: 'ws-1', input: { ids: ['PER-2', 'PER-1'], acceptedBy: 'su-merge-test' } }]);
  });

  it('refuses a coding agent and an unscoped workspace without writing', async () => {
    expect(body(await call({ ids: ['PER-1', 'PER-2'] }, { ...SU, role: 'coding' }))).toMatchObject({ ok: false, error: 'coding_agent_denied' });
    expect(body(await call({ ids: ['PER-1', 'PER-2'] }, { ...SU, workspaceId: '*' }))).toMatchObject({ ok: false, error: 'workspace_required' });
    expect(body(await call({ ids: ['PER-1', 'PER-2'] }, { ...SU, workspaceId: undefined }))).toMatchObject({ ok: false, error: 'workspace_required' });
    expect(h.calls).toEqual([]);
  });

  it('returns a graph refusal as { ok:false, error } and rethrows anything else', async () => {
    h.outcome = new MergeEntitiesError('entity_missing', 'person PER-9 not found');
    expect(body(await call({ ids: ['PER-1', 'PER-9'] }))).toEqual({ ok: false, error: 'entity_missing', message: 'person PER-9 not found' });
    h.outcome = new Error('connection reset');
    await expect(call({ ids: ['PER-1', 'PER-2'] })).rejects.toThrow(/connection reset/);
  });
});
