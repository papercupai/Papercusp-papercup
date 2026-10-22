/**
 * memory:list / memory:search — the BYTE-STABLE wire envelope
 * (generalize-memory-backend-swappable P-003).
 *
 * The TUI Memory tab (apps/tui/src/models.rs MemoriesPayload/MemoryEntry)
 * deserializes exactly `{ ok, reason?, results: [{ id, memory, metadata?,
 * score? }] }` from these tools and reads `kind` from `metadata.kind`.
 * These tests pin that contract over the neutral-backend refactor:
 *  • neutral Entry.text → wire `memory`;
 *  • Entry.kind is materialized into `metadata.kind` (claude-file carries
 *    kind only at the entry level — without this the TUI shows no kind);
 *  • unavailable backends → `{ ok:false, reason, results: [] }`;
 *  • search slices the merged result to the global limit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../memory/backend', () => ({
  getMemoryBackend: vi.fn(),
}));
vi.mock('../../auth', () => ({
  getSessionUserOrDefault: vi.fn(),
}));
// Spread the REAL module and override only defineTool: a hand-listed factory
// strands every export the tool graph later starts importing — AGENT_ROLES did
// exactly that (testing/run.ts), breaking collection across this directory.
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
}));
vi.mock('../../harness-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../harness-registry')>();
  return {
    ...actual,
    loadHarnessRegistry: vi.fn(async () => ({ projects: [{ slug: 'papercup' }] })),
  };
});

import list from './list';
import search from './search';
import { getMemoryBackend } from '../../memory/backend';
import { getSessionUserOrDefault } from '../../auth';

type Entry = {
  id: string; text: string; kind?: string; scope: string;
  score?: number; metadata?: Record<string, unknown>;
};

const fakeBackend = (entries: Entry[], ok = true) => ({
  name: 'fake',
  available: vi.fn(async () => (ok ? { ok: true } : { ok: false, reason: 'memory_backend_disabled' })),
  list: vi.fn(async () => entries),
  search: vi.fn(async () => entries),
});

const useBackend = (b: ReturnType<typeof fakeBackend>): void => {
  vi.mocked(getMemoryBackend).mockReturnValue(b as unknown as ReturnType<typeof getMemoryBackend>);
};

const ctx = { principal: { workspaceId: 'ws-test' } } as unknown as Parameters<typeof search.handler>[1];

const parse = (res: unknown): { ok: boolean; reason?: string; results: Array<Record<string, unknown>> } =>
  JSON.parse((res as { content: { text: string }[] }).content[0].text);

beforeEach(() => {
  vi.mocked(getSessionUserOrDefault).mockResolvedValue({
    id: 'user-1',
    display_name: 'Test User',
  } as unknown as Awaited<ReturnType<typeof getSessionUserOrDefault>>);
});

describe('the byte-stable wire envelope (TUI Memory tab contract)', () => {
  it('memory:list maps neutral entries to stable wire rows with nullable outcome counts', async () => {
    const b = fakeBackend([
      { id: 'm1', text: 'prefers rust', kind: 'preference', scope: 'user-1', metadata: { kind: 'preference', a: 1 } },
      { id: 'm2', text: 'tz is ET', scope: 'user-1' },
    ]);
    useBackend(b);
    const out = parse(await list.handler({}, ctx));

    expect(out.ok).toBe(true);
    expect(out.results).toEqual([
      { id: 'm1', memory: 'prefers rust', metadata: { kind: 'preference', a: 1 }, outcomeCounts: null },
      { id: 'm2', memory: 'tz is ET', outcomeCounts: null },
    ]);
  });

  it('materializes entry-level kind into metadata.kind (claude-file shape)', async () => {
    // A backend that carries kind ONLY at the entry level (no metadata.kind).
    const b = fakeBackend([
      { id: 'c1', text: 'topic fact', kind: 'project', scope: 'user-1', metadata: { source: 'topic-file' } },
    ]);
    useBackend(b);
    const out = parse(await list.handler({}, ctx));
    expect(out.results[0].metadata).toEqual({ source: 'topic-file', kind: 'project' });
  });

  it('memory:list scopes user + requested harness pool and forwards kind', async () => {
    const b = fakeBackend([]);
    useBackend(b);
    await list.handler({ harness_slug: 'sheets', kind: 'project' }, ctx);
    expect(b.list).toHaveBeenCalledWith({
      scope: ['user-1', 'harness:sheets'],
      kind: 'project',
    });
  });

  it('memory:search fans user + workspace harnesses, slices to the global limit', async () => {
    const entries: Entry[] = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`, text: `t${i}`, scope: 'user-1', score: (9 - i) / 10,
    }));
    const b = fakeBackend(entries);
    useBackend(b);
    const out = parse(await search.handler({ query: 'q', limit: 3 }, ctx));

    expect(b.search).toHaveBeenCalledWith('q', {
      scope: ['user-1', 'harness:papercup'],
      limit: 3,
      // EI-21348316803580175: the query embed is bounded. Asserted as any Number
      // rather than the literal 4000 because the policy is env-overridable
      // (PAPERCUSP_QUERY_EMBED_ACQUIRE_BUDGET_MS) — pinning the literal would
      // make this contract test fail on a box that tunes it. Removing the option
      // entirely still fails here, which is the regression this guards.
      embedTimeoutMs: expect.any(Number),
      onLegStats: expect.any(Function),
    });
    expect(out.results).toHaveLength(3);
    expect(out.results.map((r) => r.id)).toEqual(['m0', 'm1', 'm2']);
    expect(out.results[0]).toEqual({ id: 'm0', memory: 't0', score: 0.9 });
  });

  it('memory:search harnessOnly scopes to ONLY the harness pool — excludes the user pool (isolated benchmark recall)', async () => {
    const b = fakeBackend([]);
    useBackend(b);
    // harnessOnly + harness_slug → scope is the harness pool alone, no user-1.
    await search.handler({ query: 'q', harness_slug: 'bench-run-1', harnessOnly: true }, ctx);
    expect(b.search).toHaveBeenCalledWith('q', {
      scope: ['harness:bench-run-1'],
      limit: 8,
      embedTimeoutMs: expect.any(Number),
      onLegStats: expect.any(Function),
    });
    // harnessOnly WITHOUT harness_slug is ignored (nothing to isolate to) → still fans user + workspace.
    b.search.mockClear();
    await search.handler({ query: 'q', harnessOnly: true }, ctx);
    expect(b.search).toHaveBeenCalledWith('q', {
      scope: ['user-1', 'harness:papercup'],
      limit: 8,
      embedTimeoutMs: expect.any(Number),
      onLegStats: expect.any(Function),
    });
  });

  it('PULL path applies NO relevance floor — surfaces weak scored candidates for the LLM to judge (P-021 / D-003)', async () => {
    // The read-gate split: the push/auto-inject path floors with injectMinScore()
    // (no LLM in the loop, so a bad inject already harmed the turn); the on-demand
    // PULL path must NOT floor — the calling LLM is present and judges relevance
    // itself, so memory:search returns every scored candidate (including weak ones
    // below the push floor) with scores intact.
    const entries: Entry[] = [
      { id: 'strong', text: 'a strong hit', scope: 'user-1', score: 0.83 },
      { id: 'weak', text: 'a weak hit far below the 0.42 push floor', scope: 'user-1', score: 0.18 },
    ];
    const b = fakeBackend(entries);
    useBackend(b);
    const out = parse(await search.handler({ query: 'q' }, ctx));

    // backend.search invoked WITHOUT any floor key — no minScore / minScoreRatio.
    const opts = (b.search.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect('minScore' in opts).toBe(false);
    expect('minScoreRatio' in opts).toBe(false);
    // the weak candidate is surfaced (not floored out), score preserved for judging.
    expect(out.results.map((r) => r.id)).toEqual(['strong', 'weak']);
    expect(out.results.find((r) => r.id === 'weak')?.score).toBe(0.18);
  });

  it('unavailable backend keeps list empty and marks semantic search degraded', async () => {
    const b = fakeBackend([], false);
    useBackend(b);
    expect(parse(await list.handler({}, ctx))).toEqual({
      ok: false, reason: 'memory_backend_disabled', results: [],
    });
    expect(parse(await search.handler({ query: 'q' }, ctx))).toEqual({
      ok: false, reason: 'memory_backend_disabled', degraded: true, results: [],
    });
    expect(b.list).not.toHaveBeenCalled();
    expect(b.search).not.toHaveBeenCalled();
  });
});
