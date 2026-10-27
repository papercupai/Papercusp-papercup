import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
const h = vi.hoisted(() => ({ mismatched: false }));
vi.mock('../search/embed-backfill', () => ({ resolveBackfillEmbedder: async () => ({
  mode: 'gemma', dims: 4, profile: { profileId: 'controlled@v1' }, embed: async () => [1,0,0,0] }) }));
vi.mock('../agent-tools/search/embedder', () => ({ buildQueryEmbedderResolved: async (options?: { acquireBudgetMs: number }) => {
  // Represents a valid cold resolver that cannot finish inside the interactive
  // deadline. The off-hook producer must permit its ordinary acquisition path.
  if (options?.acquireBudgetMs) return null;
  return { mode: 'gemma', dims: 4, profile: { profileId: h.mismatched ? 'foreign@v1' : 'controlled@v1' }, embed: async () => [1,0,0,0] };
} }));
import { openSemanticCodeIndex, semanticHybridEnvironmentMatches } from './semantic-code-runtime';
import { SEMANTIC_HYBRID_MODEL } from './semantic-code-calibration';
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); h.mismatched = false; });
it('refuses calibration across unmeasured, changed or incompatible runtime/profile/dtype boundaries', () => {
  const model = SEMANTIC_HYBRID_MODEL;
  const health = { runtime: model.runtime, rerankExecution: { device: model.device, dtype: model.dtype } };
  expect(semanticHybridEnvironmentMatches(model.profile, model.dimensions, health)).toBe(true);
  for (const other of [null, {}, { ...health, runtime: 'different' },
    { ...health, rerankExecution: { device: 'cpu', dtype: 'q8' } }]) {
    expect(semanticHybridEnvironmentMatches(model.profile, model.dimensions, other)).toBe(false);
  }
  expect(semanticHybridEnvironmentMatches('foreign-profile', model.dimensions, health)).toBe(false);
  expect(semanticHybridEnvironmentMatches(model.profile, 4, health)).toBe(false);
});
it('allows ordinary cold acquisition off-hook while keeping interactive fail-closed and profile isolation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'semantic-opener-')); roots.push(root);
  await expect(openSemanticCodeIndex(root, 'ws', {} as Sql)).rejects.toThrow('profile unavailable');
  const background = await openSemanticCodeIndex(root, 'ws', {} as Sql, { background: true });
  expect(background.space).toMatchObject({ workspaceId: 'ws', profile: 'controlled@v1', dimensions: 4 });
  h.mismatched = true;
  await expect(openSemanticCodeIndex(root, 'ws', {} as Sql, { background: true })).rejects.toThrow('incompatible');
});
