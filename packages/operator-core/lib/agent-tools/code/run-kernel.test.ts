import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { CODE_RUN_REPLAY_PROOF_META_KEY } from '@papercusp/tooldef';

const { capture, trace, record } = vi.hoisted(() => ({
  capture: vi.fn(async () => null), trace: vi.fn(async () => null), record: vi.fn(async () => {}),
}));
vi.mock('./capture-recipe', () => ({ captureRecipe: capture }));
vi.mock('../../orchestration-trace', () => ({ normalizeExecutionTrace: trace }));
vi.mock('../../code-recipes-store', () => ({ recordRecipeRun: record }));

import codeRun, { codeRunKernelScope } from './run';

const context = (owner = 'kernel-owner', workspace = 'workspace-a', harness = 'papercusp') => ({
  uiClientId: owner, workspaceId: workspace, harnessSlug: harness,
  role: 'operator', isSuperuser: true, log: vi.fn(), emit: vi.fn(), metadata: vi.fn(),
}) as unknown as UnifiedToolContext;
const owned: Array<{ id: string; ctx: UnifiedToolContext }> = [];
async function call(args: Parameters<typeof codeRun.handler>[0], ctx = context()) {
  const result = await codeRun.handler(args, ctx);
  if (!('content' in result)) throw new Error('code:run handler did not return MCP content');
  const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
  return { result, payload };
}
async function open(ctx = context()) {
  const { payload } = await call({ kernel: { op: 'open' } }, ctx);
  expect(payload.ok).toBe(true);
  owned.push({ id: payload.kernel.id, ctx });
  return payload.kernel.id as string;
}
afterEach(async () => {
  for (const entry of owned.splice(0)) await call({ kernel: { op: 'close', id: entry.id } }, entry.ctx);
  vi.clearAllMocks();
});

describe('code:run persistent kernel boundary', () => {
  it('opens, runs live cross-call state, observes and closes through the existing tool', async () => {
    const id = await open();
    const first = await call({ kernel: { op: 'run', id }, script: 'globalThis.count = 2; return ++count;' });
    const second = await call({ kernel: { op: 'run', id }, script: 'return ++count;' });
    expect(first.payload.summary).toBe(3);
    expect(second.payload.summary).toBe(4);
    // The public code:run contract uses summary for a scalar returned by a cell.
    // Keep the API acceptance fixture aligned with the real handler boundary.
    expect(second.payload).not.toHaveProperty('result');
    expect(second.payload.kernel).toMatchObject({ state: 'live', language: 'javascript', statePersistence: 'globalThis', restartRecovery: 'unrecoverable' });
    expect((await call({ kernel: { op: 'status', id } })).payload.kernel.state).toBe('live');
    expect((await call({ kernel: { op: 'close', id } })).payload.kernel.state).toBe('closed');
    expect((await call({ kernel: { op: 'run', id }, script: 'return count;' })).payload.ok).toBe(false);
  });

  it('does not publish a replay-safe read proof or capture a state-dependent portable recipe', async () => {
    const id = await open();
    const { result, payload } = await call({ kernel: { op: 'run', id }, script: 'globalThis.counter = (globalThis.counter ?? 0) + 1; return counter;' });
    expect(payload.ok).toBe(true);
    expect((result as { _meta?: Record<string, unknown> })._meta?.[CODE_RUN_REPLAY_PROOF_META_KEY]).toBeUndefined();
    expect(capture).not.toHaveBeenCalled();
  });

  it('emits validated retained media once and keeps subsequent cells free of previous output', async () => {
    const id = await open();
    const media = { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xkAAAAASUVORK5CYII=', mimeType: 'image/png' };
    await call({ kernel: { op: 'run', id }, script: `globalThis.picture = ${JSON.stringify(media)}; return true;` });
    const { result, payload } = await call({ kernel: { op: 'run', id }, script: 'log("cell output"); return { summary: "retained image", media: [picture] };' });
    expect(payload.summary).toBe('retained image');
    expect(payload).not.toHaveProperty('media');
    expect(result.content.slice(1)).toEqual([media]);
    const next = await call({ kernel: { op: 'run', id }, script: 'return typeof picture;' });
    expect(next.payload.summary).toBe('object');
    expect(next.payload.logs).toEqual([]);
    expect(next.result.content).toHaveLength(1);
  });

  it('reports timeout state loss and rejects another cell without replaying it', async () => {
    const id = await open();
    await call({ kernel: { op: 'run', id }, script: 'globalThis.saved = 17; return saved;' });
    const expired = await call({ kernel: { op: 'run', id }, script: 'while (true) {}', timeoutSec: 1 });
    expect(expired.payload.ok).toBe(false);
    expect(expired.payload.error).toContain('script_timeout');
    expect(expired.payload.kernel.state).toBe('lost');
    const next = await call({ kernel: { op: 'run', id }, script: 'return saved;' });
    expect(next.payload.ok).toBe(false);
    expect(next.payload.error).toContain('kernel_unrecoverable');
    expect(next.payload.dispatchCount).toBe(0);
  });

  it('binds status, close and execution to owner, workspace and harness', async () => {
    const id = await open();
    for (const foreign of [context('other-owner'), context('kernel-owner', 'workspace-b'), context('kernel-owner', 'workspace-a', 'other-harness')]) {
      for (const op of ['status', 'close', 'run'] as const) {
        const { payload } = await call({ kernel: { op, id }, ...(op === 'run' ? { script: 'return 1;' } : {}) }, foreign);
        expect(payload.ok).toBe(false);
      }
    }
    expect((await call({ kernel: { op: 'status', id } })).payload.kernel.state).toBe('live');
  });

  it('uses unambiguous host-derived scope and rejects missing authenticated context', () => {
    expect(codeRunKernelScope(context('a:b', 'c'))).not.toBe(codeRunKernelScope(context('b', 'c:a')));
    expect(codeRunKernelScope(context('owner', 'workspace-a', '*')))
      .toBe(codeRunKernelScope(context('owner', 'workspace-a', '')));
    expect(() => codeRunKernelScope(context('owner', ''))).toThrow('kernel_workspace_required');
    expect(() => codeRunKernelScope({ workspaceId: 'workspace-a' } as UnifiedToolContext)).toThrow();
  });

  it('rejects caller-authored scopes and malformed lifecycle arguments', () => {
    expect(codeRun.args.safeParse({ kernel: { op: 'open', scope: 'foreign' } }).success).toBe(false);
    expect(codeRun.args.safeParse({ kernel: { op: 'run' }, script: 'return 1;' }).success).toBe(false);
    expect(codeRun.args.safeParse({ kernel: { op: 'open', id: '00000000-0000-4000-8000-000000000000' } }).success).toBe(false);
  });

  it('refuses dry-run operations without mutating or closing live state', async () => {
    expect((await call({ kernel: { op: 'open' }, dryRun: true })).payload.error).toBe('kernel_dry_run_unsupported');
    const id = await open();
    expect((await call({ kernel: { op: 'close', id }, dryRun: true })).payload.ok).toBe(false);
    expect((await call({ kernel: { op: 'status', id } })).payload.kernel.state).toBe('live');
  });

  it('reports missing scripts without dispatch and preserves standard stateless execution', async () => {
    expect((await call({})).payload).toMatchObject({ ok: false, error: 'script_required', executed: false });
    const { payload } = await call({ script: 'return typeof globalThis.count;' });
    expect(payload.summary).toBe('undefined');
    expect(payload.kernel).toBeUndefined();
  });
});
