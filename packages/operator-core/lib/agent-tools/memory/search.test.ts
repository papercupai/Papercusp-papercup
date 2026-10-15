/**
 * Tests for toWireRow — the MemoryEntry → stable wire-row mapper that the
 * memory:search response and the TUI Memory tab consume (byte-stable contract).
 * Run with:
 *   cd packages/operator-core && npx vitest run lib/agent-tools/memory/search.test.ts
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resolveJudgeMemorySearchScope, toWireRow } from './search';
import memorySearch from './search';
import type { MemoryEntry } from '../../memory/backend';

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: 'm1',
  text: 'the user prefers nuqs',
  scope: 'user',
  ...over,
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
