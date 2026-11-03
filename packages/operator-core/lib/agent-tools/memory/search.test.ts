/**
 * Tests for toWireRow — the MemoryEntry → stable wire-row mapper that the
 * memory:search response and the TUI Memory tab consume (byte-stable contract).
 * Run with:
 *   cd packages/operator-core && npx vitest run lib/agent-tools/memory/search.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setSessionConfinementResolver } from '../../capability-envelope/session-confinement-port';
import type { SessionToolConfinement } from '../../capability-envelope/session-confinement';
import { getMemoryBackend } from '../../memory/backend';
import { getSessionUserOrDefault } from '../../auth';

vi.mock('@papercusp/agent-mcp', async importOriginal => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()), defineTool: (def: unknown) => def,
}));
vi.mock('../../memory/backend', async importOriginal => ({
  ...(await importOriginal<typeof import('../../memory/backend')>()), getMemoryBackend: vi.fn(),
}));
vi.mock('../../auth', async importOriginal => ({
  ...(await importOriginal<typeof import('../../auth')>()), getSessionUserOrDefault: vi.fn(),
}));
import { resolveJudgeMemorySearchScope, toWireRow } from './search';
import memorySearch from './search';
import type { MemoryEntry } from '../../memory/backend';

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: 'm1',
  text: 'the user prefers nuqs',
  scope: 'user',
  ...over,
});

const frozenRoots: string[] = [];
afterEach(() => {
  setSessionConfinementResolver(undefined); vi.clearAllMocks();
  for (const root of frozenRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('memory:search uses the native assignment frozen snapshot', () => {
  const args = { query: 'iron pickaxe', harness_slug: 'bench-private', harnessOnly: true, limit: 1 };
  const ctx = { uiClientId: 'su-frozen', workspaceId: 'private', isSuperuser: true };
  const payload = async (input = args) => {
    const result = await memorySearch.handler(input, ctx as never);
    return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
  };
  function frozen() {
    const checkout = mkdtempSync(join(tmpdir(), 'memory-frozen-')); frozenRoots.push(checkout);
    mkdirSync(join(checkout, '.papercusp/benchmark-context'), { recursive: true });
    const path = join(checkout, '.papercusp/benchmark-context/memory.json');
    const snapshot = JSON.stringify({ entries: [{ key: 'recipe:pickaxe', text: 'iron pickaxe needs iron ingots', kind: 'reference' },
      { key: 'route:portal', text: 'obsidian frame' }] });
    writeFileSync(path, snapshot);
    const snapshotSha256 = createHash('sha256').update(snapshot).digest('hex');
    const confinement: SessionToolConfinement = { denyTools: [], denyOutside: ['memory:search'], denyAmbientContext: true,
      denyWorkItemsOutside: { id: 'F-own', harness: args.harness_slug, checkout },
      denyMemoryOutside: { snapshotSha256 }, reason: 'test frozen snapshot', imposedBy: 'test host' };
    setSessionConfinementResolver(() => confinement);
    return { path, confinement, snapshotSha256 };
  }
  it('returns real pinned bytes through the real handler without live auth/backend inference', async () => {
    const f = frozen();
    expect(await payload()).toMatchObject({ ok: true, retrieval: 'frozen-lexical', score_scale: 'trigram-jaccard',
      snapshotSha256: f.snapshotSha256, results: [{ id: 'recipe:pickaxe', memory: 'iron pickaxe needs iron ingots',
        metadata: { kind: 'reference', snapshotSha256: f.snapshotSha256 } }] });
    expect(getMemoryBackend).not.toHaveBeenCalled(); expect(getSessionUserOrDefault).not.toHaveBeenCalled();
  });
  it('does not fall back for empty, foreign, disabled, corrupt or unavailable frozen recall', async () => {
    const f = frozen();
    expect(await payload({ ...args, query: 'zzzzzz' })).toMatchObject({ ok: true, results: [] });
    expect(await payload({ ...args, harness_slug: 'production' })).toMatchObject({ ok: false, results: [] });
    setSessionConfinementResolver(() => ({ ...f.confinement, denyMemoryOutside: undefined, denyOutside: [] }));
    expect(await payload()).toMatchObject({ ok: false, results: [] });
    setSessionConfinementResolver(() => f.confinement);
    writeFileSync(f.path, JSON.stringify({ entries: [{ key: 'foreign', text: 'PRIVATE_SENTINEL' }] }));
    expect(await payload()).toMatchObject({ ok: false, reason: 'frozen_memory_unavailable', results: [] });
    setSessionConfinementResolver(async () => { throw new Error('policy unavailable'); });
    expect(await payload()).toMatchObject({ ok: false, results: [] });
    expect(getMemoryBackend).not.toHaveBeenCalled(); expect(getSessionUserOrDefault).not.toHaveBeenCalled();
  });
  it('continues to the ordinary backend for an unconfined caller', async () => {
    setSessionConfinementResolver(() => null);
    vi.mocked(getSessionUserOrDefault).mockResolvedValue({ id: 'user-control' } as never);
    vi.mocked(getMemoryBackend).mockImplementation(() => { throw new Error('ordinary backend reached'); });
    await expect(payload()).rejects.toThrow('ordinary backend reached');
    expect(getMemoryBackend).toHaveBeenCalledOnce(); expect(getSessionUserOrDefault).toHaveBeenCalledOnce();
  });
});

describe('toWireRow', () => {
  it('maps id→id and text→memory; omits metadata/score when absent', () => {
    expect(toWireRow(entry())).toEqual({ id: 'm1', memory: 'the user prefers nuqs' });
  });

  it('passes metadata through untouched when there is no kind', () => {
    const meta = { anchor: 'F-001', ts: 123 };
    expect(toWireRow(entry({ metadata: meta }))).toEqual({
      id: 'm1',
      memory: 'the user prefers nuqs',
      metadata: meta,
    });
  });

  it('materializes kind into metadata.kind when there is no metadata', () => {
    expect(toWireRow(entry({ kind: 'preference' }))).toEqual({
      id: 'm1',
      memory: 'the user prefers nuqs',
      metadata: { kind: 'preference' },
    });
  });

  it('merges kind into existing metadata (kind takes precedence)', () => {
    const out = toWireRow(entry({ kind: 'correction', metadata: { anchor: 'x', kind: 'stale' } }));
    expect(out.metadata).toEqual({ anchor: 'x', kind: 'correction' });
  });

  it('does not mutate the source entry metadata', () => {
    const meta = { anchor: 'x' };
    toWireRow(entry({ kind: 'preference', metadata: meta }));
    expect(meta).toEqual({ anchor: 'x' });
  });

  it('includes score when present and omits it when undefined', () => {
    expect(toWireRow(entry({ score: 0.87 })).score).toBe(0.87);
    expect('score' in toWireRow(entry())).toBe(false);
  });

  it('preserves a score of 0 (not dropped as falsy)', () => {
    expect(toWireRow(entry({ score: 0 })).score).toBe(0);
  });
});

// Regression: memory:search was unreachable from a default (unscoped) psu
// session — the projected legacy gate threw `workspace_required` because the
// host synthesizes no tx for workspaceId '*'. The store is cross-workspace by
// design, so the fix is crossWorkspace:true (admin handle + synth principal) +
// an optional per-call `workspace` arg (EI-30 superuser scoping). This block
// runs the REAL defineTool (principal-gated path), so it also asserts that
// definePrincipalGatedTool THREADS crossWorkspace — drop the threading and
// `memorySearch.crossWorkspace` goes undefined and these fail.
describe('memory:search — psu reachability (crossWorkspace + workspace arg)', () => {
  it('is crossWorkspace:true so an unscoped superuser session gets the admin handle', () => {
    expect(memorySearch.crossWorkspace).toBe(true);
  });

  it('accepts an optional per-call `workspace` arg, and works without it', () => {
    const schema = memorySearch.args as z.ZodTypeAny;
    expect(schema.safeParse({ query: 'x' }).success).toBe(true);
    const withWs = schema.safeParse({ query: 'x', workspace: 'ws-a' });
    expect(withWs.success).toBe(true);
    if (withWs.success) expect((withWs.data as { workspace?: string }).workspace).toBe('ws-a');
  });
});

describe('memory:search — judge harness confinement', () => {
  it('requires and pins the judge session harness, excluding the personal pool', () => {
    expect(resolveJudgeMemorySearchScope({}, {
      role: 'judge', harnessSlug: 'target-harness', principal: { slug: 'system:judge' },
    })).toEqual({ ok: true, harnessSlug: 'target-harness', harnessOnly: true });
  });

  it('refuses absent, wildcard, mismatched, and caller-widened scope', () => {
    const judge = { role: 'judge', principal: { slug: 'system:judge' } };
    expect(resolveJudgeMemorySearchScope({}, judge)).toEqual({ ok: false, reason: 'judge_harness_scope_required' });
    expect(resolveJudgeMemorySearchScope({}, { ...judge, harnessSlug: '*' })).toEqual({ ok: false, reason: 'judge_harness_scope_required' });
    expect(resolveJudgeMemorySearchScope({ harness_slug: 'other' }, { ...judge, harnessSlug: 'target' }))
      .toEqual({ ok: false, reason: 'judge_harness_scope_mismatch' });
    expect(resolveJudgeMemorySearchScope({ workspace: 'other' }, { ...judge, harnessSlug: 'target' }))
      .toEqual({ ok: false, reason: 'judge_scope_override_forbidden' });
    expect(resolveJudgeMemorySearchScope({ harnessOnly: false }, { ...judge, harnessSlug: 'target' }))
      .toEqual({ ok: false, reason: 'judge_scope_override_forbidden' });
  });

  it('leaves non-judge memory-reader scoping unchanged', () => {
    expect(resolveJudgeMemorySearchScope({ harness_slug: 'requested' }, {
      role: 'operator', harnessSlug: 'active', principal: { slug: 'system:operator' },
    })).toBeNull();
  });

  it('uses the narrow search capability', () => {
    expect(memorySearch.capability).toBe('memory:search:read');
  });
});
