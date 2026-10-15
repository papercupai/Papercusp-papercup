/**
 * work_items:links — family dispatch, direction, per-item limit, and tag
 * omission. The underlying stores are mocked so this stays a focused handler
 * test rather than a database integration test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => {
  const issueReader = { listOut: vi.fn(), listIn: vi.fn(), listOutMany: vi.fn(), listInMany: vi.fn() };
  const featureReader = { listOut: vi.fn(), listIn: vi.fn(), listOutMany: vi.fn(), listInMany: vi.fn() };
  const state: { storeOpts: unknown[]; readerStores: unknown[] } = { storeOpts: [], readerStores: [] };
  const PgLinkStore = vi.fn(function (this: { opts: unknown }, opts: unknown) {
    this.opts = opts;
    state.storeOpts.push(opts);
  });
  const createBlockingEdgeReader = vi.fn((store: unknown) => {
    state.readerStores.push(store);
    return issueReader;
  });
  return { issueReader, featureReader, PgLinkStore, createBlockingEdgeReader, state };
});

vi.mock('@papercusp/coordination/capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/coordination/capabilities')>();
  return { ...actual, PgLinkStore: fakes.PgLinkStore };
});
vi.mock('../coordination/log', () => ({ coordScopeWorkspace: vi.fn(() => 'workspace-live') }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'workspace-live') }));
vi.mock('../../work-item-blocking', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../work-item-blocking')>();
  return {
    ...actual,
    createBlockingEdgeReader: fakes.createBlockingEdgeReader,
    blockingEdgeReader: fakes.featureReader,
  };
});
vi.mock('../../work-items', () => ({ getWorkItem: vi.fn(), workItemObjectRef: vi.fn() }));

import { getWorkItem, workItemObjectRef } from '../../work-items';
import { workItemFixture } from '../../testing/work-item-fixture';
import tool from './links';

type Out = { data: any };
const getM = vi.mocked(getWorkItem);
const refM = vi.mocked(workItemObjectRef);
const issueOutM = fakes.issueReader.listOut;
const issueInM = fakes.issueReader.listIn;
const featureOutM = fakes.featureReader.listOut;
const featureInM = fakes.featureReader.listIn;

const issueRef = { kind: 'issue', ref: 'EI-1' } as const;
const featureRef = { kind: 'feature', ref: 'papercusp#F-1' } as const;
const row = (over: Record<string, unknown> = {}) => ({
  id: 1,
  src: issueRef,
  dst: { kind: 'issue', ref: 'EI-2' },
  rel: 'relates',
  created_by: 'agent',
  created_ts: '2026-08-27T00:00:00.000Z',
  ...over,
});

const args = (over: Record<string, unknown> = {}) => tool.args.parse({ id: 'EI-1', ...over }) as never;
const run = async (over: Record<string, unknown> = {}) => ((await tool.handler(args(over), {} as never)) as Out).data;

beforeEach(() => {
  vi.clearAllMocks();
  getM.mockResolvedValue({ family: 'issue', harness: 'papercusp', id: 'EI-1' } as never);
  refM.mockReturnValue(issueRef as never);
  issueOutM.mockResolvedValue([]);
  issueInM.mockResolvedValue([]);
  featureOutM.mockResolvedValue([]);
  featureInM.mockResolvedValue([]);
});

describe('work_items:links handler', () => {
  it('reads outgoing issue links through the dynamically scoped issue reader and omits tagged rows', async () => {
    issueOutM.mockResolvedValue([
      row({ rel: 'tagged', dst: { kind: 'topic', ref: 'coord' } }),
      row({ rel: 'fixes', dst: { kind: 'issue', ref: 'EI-2' } }),
    ] as never);
    const b = await run({ direction: 'out' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({
      ok: true,
      id: 'EI-1',
      direction: 'out',
      links: [{ rel: 'fixes', dst: { kind: 'issue', ref: 'EI-2' } }],
    });
    expect(issueOutM).toHaveBeenCalledWith(issueRef);
    expect(featureOutM).not.toHaveBeenCalled();
    const opts = fakes.state.storeOpts.find(
      (candidate) => typeof (candidate as { getWorkspaceId?: unknown }).getWorkspaceId === 'function',
    ) as { getWorkspaceId: () => string } | undefined;
    expect(opts).toBeDefined();
    expect(opts!.getWorkspaceId()).toBe('workspace-live');
  });

  it('reads incoming feature links through the canonical feature reader', async () => {
    getM.mockResolvedValue({ family: 'feature', harness: 'papercusp', id: 'F-1' } as never);
    refM.mockReturnValue(featureRef as never);
    featureInM.mockResolvedValue([
      row({ src: { kind: 'issue', ref: 'EI-9' }, dst: featureRef, rel: 'blocks' }),
      row({ src: { kind: 'topic', ref: 'coord' }, dst: featureRef, rel: 'tagged' }),
    ] as never);
    const b = await run({ id: 'F-1', direction: 'in' });
    expect(b.results[0]).toMatchObject({
      ok: true,
      id: 'F-1',
      direction: 'in',
      links: [{ rel: 'blocks', src: { kind: 'issue', ref: 'EI-9' } }],
    });
    expect(featureInM).toHaveBeenCalledWith(featureRef);
    expect(issueInM).not.toHaveBeenCalled();
  });

  it('projects the dependency satisfaction requirement from canonical edge rows', async () => {
    issueOutM.mockResolvedValue([
      row({ rel: 'blocks', dst: { kind: 'feature', ref: 'papercusp#F-2' }, satisfaction: 'success' }),
    ] as never);
    const b = await run({ direction: 'out' });
    expect(b.results[0].links).toEqual([
      { rel: 'blocks', dst: { kind: 'feature', ref: 'papercusp#F-2' }, satisfaction: 'success' },
    ]);
  });

  it('applies the limit independently to every requested id', async () => {
    getM.mockImplementation(async (id: string) => workItemFixture({ family: 'issue', harness: 'papercusp', id }));
    refM.mockImplementation((item) => ({ kind: 'issue', ref: item.id }) as never);
    issueOutM.mockResolvedValue([
      row({ id: 1 }),
      row({ id: 2, dst: { kind: 'issue', ref: 'EI-3' } }),
      row({ id: 3, dst: { kind: 'issue', ref: 'EI-4' } }),
    ] as never);
    const b = await run({ id: undefined, ids: ['EI-1', 'EI-2'], limit: 2 });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: { links: unknown[] }) => r.links)).toHaveLength(2);
    expect(b.results[0].links).toHaveLength(2);
    expect(b.results[1].links).toHaveLength(2);
  });

  it('omits empty successes and reports exact checked-set coverage for a 100-id selection', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `EI-${50_000 + i}`);
    const linkedIds = ids.filter((_, i) => i % 10 === 0);
    getM.mockImplementation(async (id: string) => workItemFixture({ family: 'issue', harness: 'papercusp', id }));
    refM.mockImplementation((item) => ({ kind: 'issue', ref: item.id }) as never);
    issueOutM.mockImplementation(async (ref: { ref: string }) =>
      Number(ref.ref.split('-').at(-1)) % 10 === 0 ? [row({ dst: { kind: 'issue', ref: `${ref.ref}-linked` } })] as never : [],
    );

    const b = await run({ id: undefined, ids, limit: 100 });

    expect(b.counts).toEqual({ ok: 100, failed: 0 });
    expect(b.results.map((result: { id: string }) => result.id)).toEqual(linkedIds);
    expect(b.coverage).toEqual({
      selectedCount: 100,
      checkedCount: 100,
      complete: true,
      linkedCount: linkedIds.length,
    });
    expect(getM).toHaveBeenCalledTimes(100);
  });

  it('defaults and caps the per-item limit, and rejects an empty id selection', () => {
    expect(tool.args.parse({ id: 'EI-1' })).toMatchObject({ direction: 'out', limit: 20 });
    expect(() => tool.args.parse({ id: 'EI-1', limit: 101 })).toThrow();
    expect(() => tool.args.parse({ id: 'EI-1', limit: 0 })).toThrow();
    expect(() => tool.args.parse({ direction: 'in' })).toThrow();
  });
});

describe('work_items:links wiring', () => {
  it('builds the issue reader with the hybrid canonical merge seam', () => {
    const scopedStores = fakes.state.storeOpts.filter(
      (candidate) => typeof (candidate as { getWorkspaceId?: unknown }).getWorkspaceId === 'function',
    ) as Array<{ getWorkspaceId: () => string }>;
    expect(scopedStores).toHaveLength(2);
    expect(scopedStores.map((store) => store.getWorkspaceId())).toEqual(['workspace-live', 'workspace-live']);
    expect(fakes.state.readerStores).toHaveLength(1);
  });
});
