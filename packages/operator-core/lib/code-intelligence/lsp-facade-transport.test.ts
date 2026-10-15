import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeIntelAnswer } from './contracts.ts';

const state = vi.hoisted(() => ({ enabled: true, calls: [] as unknown[] }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: async () => state.enabled }));
vi.mock('./lsp-daemon-client.ts', () => ({ queryLspDaemon: async (request: unknown) => {
  state.calls.push(request);
  return {
    backend: 'lsp-adapter', intent: 'references', query: 'fixture', sites: [],
    truncation: { truncated: false, totalAvailable: null, continuation: null },
    freshness: { health: 'unhealthy', indexedAt: null, staleVsDisk: null, indexedCommit: null },
    latencyMs: 1, error: 'daemon unavailable',
  } satisfies CodeIntelAnswer;
} }));
vi.mock('./lsp-adapter.ts', () => { throw new Error('operator facade imported daemon adapter state'); });

import { lspFacade } from './lsp-facade.ts';

beforeEach(() => { state.enabled = true; state.calls.length = 0; });
describe('operator LSP facade transport', () => {
  it('forwards closed operation and caller identity while preserving daemon refusal', async () => {
    const answer = await lspFacade('references', { rootPath: '/fixture', file: '/fixture/x.ts', line1: 2, character: 0 },
      { workspaceId: 'workspace-a', actorId: 'agent-a', priority: 3, deadlineAtMs: Date.now() + 10_000 });
    expect(answer.error).toBe('daemon unavailable');
    expect(answer.freshness.health).toBe('unhealthy');
    expect(state.calls[0]).toMatchObject({ op: 'references', workspaceId: 'workspace-a', actorId: 'agent-a', priority: 3,
      args: { rootPath: '/fixture', file: '/fixture/x.ts', line1: 2, character: 0 } });
  });
  it('keeps the disabled flag ahead of daemon spawn', async () => {
    state.enabled = false;
    const answer = await lspFacade('health');
    expect(answer.error).toContain('disabled');
    expect(state.calls).toHaveLength(0);
  });
});
