import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sql: { tag: 'graph-sql' },
  getPeople: vi.fn(), evidence: vi.fn(),
}));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../../relationship-graph/people', () => ({
  getPeople: h.getPeople, readPersonQualificationEvidence: h.evidence,
}));
const tool = (await import('./get')).default;
const ctx = { workspaceId: 'ws-1', isSuperuser: true };
const call = (args: unknown, context: Record<string, unknown> = ctx) =>
  tool.handler(args as never, context as never) as unknown as Promise<{ data: unknown }>;

beforeEach(() => {
  vi.clearAllMocks();
  h.getPeople.mockResolvedValue(new Map([['PER-old', { id: 'PER-current', displayName: 'Ada' }]]));
  h.evidence.mockResolvedValue({ status: 'unknown', reason: 'source_records_unavailable' });
});

describe('people:get qualification evidence opt-in (P-019)', () => {
  it('keeps ordinary identity reads free of evidence acquisition', async () => {
    await call({ id: 'PER-old' });
    expect(h.getPeople).toHaveBeenCalledWith(h.sql, 'ws-1', ['PER-old']);
    expect(h.evidence).not.toHaveBeenCalled();
  });

  it('reads evidence for the canonical survivor in the authorized workspace and preserves unknown', async () => {
    const result = await call({ id: 'PER-old', includeQualificationEvidence: true });
    expect(h.evidence).toHaveBeenCalledWith(h.sql, 'ws-1', 'PER-current');
    expect(result.data).toMatchObject({ results: [{ id: 'PER-old', person: { id: 'PER-current' },
      qualificationEvidence: { status: 'unknown', reason: 'source_records_unavailable' } }] });
  });

  it.each([{ ...ctx, role: 'coding' }, { ...ctx, workspaceId: '*' }, { ...ctx, workspaceId: '' }])(
    'never acquires evidence for a denied caller', async context => {
      await call({ id: 'PER-old', includeQualificationEvidence: true }, context);
      expect(h.getPeople).not.toHaveBeenCalled();
      expect(h.evidence).not.toHaveBeenCalled();
    },
  );

  it('does not acquire evidence when the person is missing', async () => {
    h.getPeople.mockResolvedValue(new Map());
    await call({ id: 'PER-missing', includeQualificationEvidence: true });
    expect(h.evidence).not.toHaveBeenCalled();
  });
});
