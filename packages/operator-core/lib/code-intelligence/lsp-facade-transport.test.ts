import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeIntelAnswer } from './contracts.ts';

const state = vi.hoisted(() => ({ enabled: true, calls: [] as unknown[], snapshot: null as CodeIntelAnswer | null,
  snapshotCalls: [] as unknown[] }));
vi.mock('./push-snapshot', () => ({ queryPushSnapshot: async (query: unknown) => {
  state.snapshotCalls.push(query); return state.snapshot;
} }));
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

beforeEach(() => { state.enabled = true; state.calls.length = 0; state.snapshot = null; state.snapshotCalls.length = 0; });
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
    expect(state.snapshotCalls).toHaveLength(0);
  });
  it('answers a proven definition without starting the compiler and forwards the exact cursor/root/identity', async () => {
    state.snapshot = { backend: 'first-party-snapshot', intent: 'definition', query: 'target',
      sites: [{ path: 'target.ts', line1: 1, kind: null }], error: null, latencyMs: 3,
      truncation: { truncated: false, totalAvailable: null, continuation: null },
      freshness: { health: 'healthy', indexedAt: null, indexedCommit: null, staleVsDisk: null } };
    expect(await lspFacade('symbol', { rootPath: '/fixture', file: '/fixture/use.ts', line1: 4, character: 2 },
      { workspaceId: 'workspace-a' })).toBe(state.snapshot);
    expect(state.calls).toHaveLength(0);
    expect(state.snapshotCalls).toEqual([{ op: 'definition', root: '/fixture', workspaceId: 'workspace-a',
      file: '/fixture/use.ts', line1: 4, character: 2, limit: undefined }]);
  });
  it('falls back on a snapshot miss and preserves compiler-only intents and languages', async () => {
    await lspFacade('symbol', { rootPath: '/fixture', file: '/fixture/use.ts', line1: 1, character: 0 });
    expect(state.snapshotCalls).toHaveLength(1);
    expect(state.calls).toHaveLength(1);
    await lspFacade('symbol', { rootPath: '/fixture', language: 'rust' });
    await lspFacade('references', { rootPath: '/fixture' });
    expect(state.snapshotCalls).toHaveLength(1);
    expect(state.calls).toHaveLength(3);
  });
});
