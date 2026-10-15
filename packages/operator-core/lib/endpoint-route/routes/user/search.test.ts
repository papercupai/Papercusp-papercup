import { afterEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerRoute } from '../../define-route';

const mocks = vi.hoisted(() => ({ available: vi.fn(), search: vi.fn(), prose: vi.fn() }));
vi.mock('../../../auth', () => ({ getSessionUserOrDefault: async () => ({ id: 'user' }) }));
vi.mock('../../../memory/backend', () => ({ getMemoryBackend: () => mocks }));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'test' }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: vi.fn() }),
}));
vi.mock('@papercusp/search', async (original) => ({
  ...await original<typeof import('@papercusp/search')>(),
  runFullTextSearch: mocks.prose, runHybridSearch: mocks.prose,
}));
vi.mock('../../../agent-tools/search/sources', () => ({ SEARCH_SOURCES: [] }));
vi.mock('../../../agent-tools/search/rerank', () => ({
  rerankCandidateCount: (n: number) => n,
  rerankProseHits: async (_q: string, hits: unknown[]) => hits,
}));
import route from './search';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it('returns prose within the interactive budget while cold memory availability remains pending', async () => {
  vi.useFakeTimers();
  mocks.available.mockImplementation(() => new Promise(() => {}));
  mocks.prose.mockResolvedValue({ results: [{ source: 'turns', source_id: '1', excerpt: 'test', highlight: 'test', score: 1 }] });
  const app = new Hono();
  registerRoute(app, route as Parameters<typeof registerRoute>[1]);
  const response = app.request('/user/search?q=test');
  await vi.advanceTimersByTimeAsync(4001);
  const result = await response;
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ memories: [], prose: [{ source_id: '1' }] });
  expect(mocks.available).toHaveBeenCalledOnce();
  expect(mocks.search).not.toHaveBeenCalled();
});
