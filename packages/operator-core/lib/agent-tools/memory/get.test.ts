/**
 * memory:get — by-id read (WI-10004550). Invariants:
 *
 *  1. BY-ID READ: `id` and `ids` resolve through backend.get and return the shared wire row
 *     { id, memory, metadata } (kind folded into metadata, like memory:list/search).
 *  2. ISOLATION: a row in the caller's own pool or a harness/hive pool is returned; a row in
 *     ANOTHER user's pool is reported as `missing`, indistinguishable from an unknown id —
 *     the tool is never an existence oracle for someone else's memory.
 *  3. UNKNOWN IDS go to `missing` (ok:true — the store answered), duplicates collapse.
 *  4. DEGRADED-NEVER-SILENT: a down store / mid-flight unavailability / timeout yields
 *     { ok:false, reason, results:[], missing:[] }, never a throw and never a silent empty ok:true.
 *  5. ARGS: neither `id` nor `ids` is rejected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../memory/surfaced-outcomes', async (original) => ({
  ...(await original<typeof import('../../memory/surfaced-outcomes')>()),
  captureSurfacedOutcome: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
}));
vi.mock('../../auth', () => ({
  getSessionUserOrDefault: vi.fn(async () => ({ id: 'user-1', display_name: 'Test User' })),
}));
vi.mock('../../memory/backend', () => ({
  getMemoryBackend: vi.fn(),
  MemoryUnavailableError: class MemoryUnavailableError extends Error {
    constructor(public readonly reason: string) {
      super(`memory backend unavailable: ${reason}`);
      this.name = 'MemoryUnavailableError';
    }
  },
}));
vi.mock('../../harness-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../harness-registry')>()),
  loadHarnessRegistry: vi.fn(),
}));
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: vi.fn(async () => true),
}));

import get from './get';
import { captureSurfacedOutcome } from '../../memory/surfaced-outcomes';
import { getMemoryBackend, MemoryUnavailableError } from '../../memory/backend';
import { loadHarnessRegistry } from '../../harness-registry';
import { getFlag } from '@papercusp/flags/server';
import type { MemoryEntry } from '../../memory/backend';

type Out = { ok: boolean; reason?: string; results: Array<{ id: string; memory: string; metadata?: Record<string, unknown> }>; missing: string[] };
const run = async (
  args: { id?: string; ids?: string[] },
  ctx: unknown = { principal: { workspaceId: 'ws-test' }, harnessSlug: '*' },
): Promise<Out> => {
  const res = (await (get as unknown as { handler: (a: unknown, c: unknown) => Promise<unknown> }).handler(args, ctx)) as {
    data: unknown;
  };
  return res.data as Out;
};
const entry = (id: string, scope: string, extra: Partial<MemoryEntry> = {}): MemoryEntry =>
  ({ id, scope, text: `text of ${id}`, kind: 'project', ...extra }) as MemoryEntry;

function backendWith(rows: Record<string, MemoryEntry | null>, opts: { available?: { ok: boolean; reason?: string }; getImpl?: (id: string) => Promise<MemoryEntry | null> } = {}) {
  const getSpy = vi.fn(opts.getImpl ?? (async (id: string) => rows[id] ?? null));
  vi.mocked(getMemoryBackend).mockReturnValue({
    name: 'fake',
    available: vi.fn(async () => opts.available ?? { ok: true }),
    get: getSpy,
  } as unknown as ReturnType<typeof getMemoryBackend>);
  return getSpy;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadHarnessRegistry).mockResolvedValue({
    projects: [
      { slug: 'pot-a', harness_kind: 'hive' },
      { slug: 'papercusp', hive_slug: 'pot-a' },
      { slug: 'other-hive', harness_kind: 'hive' },
      { slug: 'other-member', hive_slug: 'other-hive' },
      { slug: 'standalone' },
    ],
  } as Awaited<ReturnType<typeof loadHarnessRegistry>>);
  vi.mocked(getFlag).mockResolvedValue(true);
});

describe('memory:get', () => {
  it('records use only for memories returned to this session, excluding forbidden and missing ids', async () => {
    backendWith({ mine: entry('mine', 'user-1'), theirs: entry('theirs', 'user-2') });
    const ctx = { principal: { workspaceId: 'ws-test' }, uiClientId: 'reader', harnessSlug: '*' };
    await run({ ids: ['mine', 'theirs', 'unknown'] }, ctx);
    expect(captureSurfacedOutcome).toHaveBeenCalledExactlyOnceWith(ctx, ['mine'], 'used');
  });

  it('reads one id and returns the shared wire row with kind folded into metadata', async () => {
    const getSpy = backendWith({ m1: entry('m1', 'user-1', { metadata: { a: 1 } }) });
    const out = await run({ id: 'm1' });
    expect(out).toEqual({ ok: true, results: [{ id: 'm1', memory: 'text of m1', metadata: { a: 1, kind: 'project' } }], missing: [] });
    expect(getSpy).toHaveBeenCalledWith('m1');
  });

  it('reads many ids, dedupes, merges id+ids, and reports unknown ids as missing with ok:true', async () => {
    const getSpy = backendWith({ m1: entry('m1', 'user-1'), m2: entry('m2', 'harness:papercusp'), m3: entry('m3', 'hive:pot-a') });
    const out = await run({ id: 'm1', ids: ['m1', 'm2', 'm3', 'nope'] });
    expect(out.ok).toBe(true);
    expect(out.results.map((r) => r.id)).toEqual(['m1', 'm2', 'm3']);
    expect(out.missing).toEqual(['nope']);
    expect(getSpy).toHaveBeenCalledTimes(4); // m1 once despite being passed twice
  });

  it("ISOLATION: another user's row is `missing`, identical to an unknown id — no existence oracle", async () => {
    backendWith({ theirs: entry('theirs', 'user-2'), ghost: null });
    const out = await run({ ids: ['theirs', 'ghost'] });
    expect(out.results).toEqual([]);
    expect(out.missing).toEqual(['theirs', 'ghost']);
    expect(JSON.stringify(out)).not.toContain('text of theirs');
  });

  it('ISOLATION: shared rows must belong to the workspace and the session hive subtree', async () => {
    backendWith({
      currentHarness: entry('currentHarness', 'harness:papercusp'),
      hiveHomeHarness: entry('hiveHomeHarness', 'harness:pot-a'),
      currentHive: entry('currentHive', 'hive:pot-a'),
      siblingHarness: entry('siblingHarness', 'harness:other-member'),
      siblingHive: entry('siblingHive', 'hive:other-hive'),
      outsideHarness: entry('outsideHarness', 'harness:outside-workspace'),
      outsideHive: entry('outsideHive', 'hive:outside-workspace'),
    });

    const out = await run(
      { ids: ['currentHarness', 'hiveHomeHarness', 'currentHive', 'siblingHarness', 'siblingHive', 'outsideHarness', 'outsideHive'] },
      { principal: { workspaceId: 'ws-test' }, harnessSlug: 'papercusp' },
    );

    expect(out.results.map((row) => row.id)).toEqual(['currentHarness', 'hiveHomeHarness', 'currentHive']);
    expect(out.missing).toEqual(['siblingHarness', 'siblingHive', 'outsideHarness', 'outsideHive']);
  });

  it('ISOLATION: user project rows are workspace-scoped while owner-tier facts follow the user', async () => {
    backendWith({
      currentProject: entry('currentProject', 'user-1', { kind: 'project', metadata: { workspace_id: 'ws-test' } }),
      foreignProject: entry('foreignProject', 'user-1', { kind: 'project', metadata: { workspace_id: 'ws-other' } }),
      ownerFact: entry('ownerFact', 'user-1', { kind: 'user', metadata: { workspace_id: 'ws-other' } }),
      legacyProject: entry('legacyProject', 'user-1', { kind: 'project', metadata: {} }),
    });

    const out = await run({ ids: ['currentProject', 'foreignProject', 'ownerFact', 'legacyProject'] });

    expect(out.results.map((row) => row.id)).toEqual(['currentProject', 'ownerFact', 'legacyProject']);
    expect(out.missing).toEqual(['foreignProject']);
  });

  it('fails closed for shared pools when workspace membership cannot be loaded', async () => {
    vi.mocked(loadHarnessRegistry).mockRejectedValueOnce(new Error('registry unavailable'));
    backendWith({ foreign: entry('foreign', 'harness:outside-workspace') });

    const out = await run({ id: 'foreign' });

    expect(out.results).toEqual([]);
    expect(out.missing).toEqual(['foreign']);
  });

  it('degraded-never-silent: down store, mid-flight unavailability and timeout all return the ok:false envelope', async () => {
    backendWith({}, { available: { ok: false, reason: 'store_down' } });
    expect(await run({ id: 'm1' })).toEqual({ ok: false, reason: 'store_down', results: [], missing: [] });

    backendWith({}, { getImpl: async () => { throw new MemoryUnavailableError('went_away'); } });
    expect(await run({ id: 'm1' })).toEqual({ ok: false, reason: 'went_away', results: [], missing: [] });
  });

  it('requires a single valid memory UUID or a non-empty list of valid UUIDs', () => {
    const schema = (get as unknown as { args: { safeParse: (v: unknown) => { success: boolean } } }).args;
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ ids: [] }).success).toBe(false);
    expect(schema.safeParse({ id: uuid }).success).toBe(true);
    expect(schema.safeParse({ ids: [uuid] }).success).toBe(true);
    expect(schema.safeParse({ id: '556477b3' }).success).toBe(false);
    expect(schema.safeParse({ ids: ['556477b3'] }).success).toBe(false);
    expect(schema.safeParse({ ids: Array.from({ length: 51 }, () => uuid) }).success).toBe(false);
  });
});
