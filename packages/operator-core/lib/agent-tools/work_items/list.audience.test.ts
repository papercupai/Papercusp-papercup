/**
 * D-041 (enterprise-data-sources-2026-10-01, WI-10005358): an AGENT's default
 * work_items:list carries audience 'agent' (the write doors' own category predicate), the
 * owner's Queue UI and any caller naming kind/natures/audience keep the unfiltered read, and
 * the narrowing is visible as a denominator instead of reading as the whole backlog.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  listWorkItems: vi.fn(),
  countWorkItems: vi.fn(),
}));

vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../work-items')>()),
  listWorkItems: h.listWorkItems,
  countWorkItems: h.countWorkItems,
}));
// Pass-through cache: every call runs the factory, so the filter reaching the store is observable.
vi.mock('../../cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../cache')>()),
  cachedRead: (_ctx: unknown, _opts: unknown, factory: () => Promise<unknown>) => factory(),
}));
vi.mock('./_holder-lens', () => ({ attachHolderContext: async (items: unknown) => items }));
vi.mock('../coordination/holder-advisory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coordination/holder-advisory')>()),
  holderContextReader: () => null,
}));

import listTool from './list';

type Result = { data: unknown[]; denominator?: { matched: number; population: number | 'unknown'; note: string } };
const call = (args: Record<string, unknown>, ctx: Record<string, unknown> = { spawnId: 'su-agent' }) =>
  (listTool.handler as (a: unknown, c: unknown) => Promise<Result>)(listTool.args.parse(args), ctx);
const OWNER_UI = {
  spawnId: 'palette',
  principal: { kind: 'system', slug: 'loopback', authMethod: 'process-internal' },
};
const audiencePassed = () => (h.listWorkItems.mock.calls.at(-1)![0] as { audience?: string }).audience;

beforeEach(() => {
  h.listWorkItems.mockReset().mockResolvedValue([{ id: 'WI-1', title: 'agent row' }]);
  h.countWorkItems.mockReset().mockImplementation(async (f: { audience?: string }) => (f.audience === 'agent' ? 1 : 3));
});

describe('work_items:list default agent audience (D-041)', () => {
  it('an agent caller defaults to audience agent and reports the withheld rows', async () => {
    const r = await call({ harness: 'papercusp' });
    expect(audiencePassed()).toBe('agent');
    expect(h.countWorkItems).toHaveBeenCalledTimes(2);
    expect(r.denominator).toMatchObject({ matched: 1, population: 3 });
    expect(r.denominator!.note).toContain("audience:'any'");
  });

  it('reports no denominator when the default withheld nothing', async () => {
    h.countWorkItems.mockResolvedValue(1);
    const r = await call({ harness: 'papercusp' });
    expect(audiencePassed()).toBe('agent');
    expect(r.denominator).toBeUndefined();
  });

  it("the owner's Queue UI keeps the unfiltered read and counts nothing", async () => {
    const r = await call({ harness: 'papercusp' }, OWNER_UI);
    expect(audiencePassed()).toBeUndefined();
    expect(h.countWorkItems).not.toHaveBeenCalled();
    expect(r.denominator).toBeUndefined();
  });

  it.each([
    ['a named kind', { kind: 'bug' }, undefined],
    ['named natures', { natures: ['work'] }, undefined],
    ["audience 'any'", { audience: 'any' }, 'any'],
    ["audience 'human'", { audience: 'human' }, 'human'],
  ])('%s turns the default off', async (_label, extra, expected) => {
    const r = await call({ harness: 'papercusp', ...extra });
    expect(audiencePassed()).toBe(expected);
    expect(h.countWorkItems).not.toHaveBeenCalled();
    expect(r.denominator).toBeUndefined();
  });

  it('includeObservations opts a title query out of the default agent audience while preserving an explicit audience', async () => {
    await call({ harness: 'papercusp', includeObservations: true, q: 'captured title' });
    expect(audiencePassed()).toBeUndefined();
    expect(h.countWorkItems).not.toHaveBeenCalled();

    await call({ harness: 'papercusp', includeObservations: true, audience: 'agent', q: 'captured title' });
    expect(audiencePassed()).toBe('agent');
  });

  it('a q search under the default reports an unknown population rather than a wrong count', async () => {
    const r = await call({ harness: 'papercusp', q: 'renewal' });
    expect(audiencePassed()).toBe('agent');
    expect(h.countWorkItems).not.toHaveBeenCalled();
    expect(r.denominator).toMatchObject({ matched: 1, population: 'unknown' });
  });

  it('rejects an audience outside the enum', () => {
    expect(listTool.args.safeParse({ audience: 'robots' }).success).toBe(false);
  });
});
