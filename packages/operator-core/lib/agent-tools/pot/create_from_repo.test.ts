/**
 * create_from_repo.test.ts — the pot:create_from_repo HANDLER guard + delegation (the
 * composition createPotFromRepo is seam-injected + unit-tested separately). This flow
 * clones a repo + stands up a pot, so the ROOT-ONLY guard (a cup cannot create a pot —
 * hives are peers, never nested) is load-bearing. Also pins the workspace resolution and
 * the arg passthrough. A regression that lets a spawned agent create a pot is what this
 * catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/pot/create_from_repo.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockImplementationTyped, mockResolvedTyped } from '../../testing/typed-mock';
import type { StoredMcpResult, claimPendingMcpResult, finalizePendingMcpResult } from '../../endpoint-route/routes/transport/_mcp-result-replay';
import type { CreatePotFromRepoResult } from './_create_from_repo';

const receipts = vi.hoisted(() => ({ rows: new Map<string, StoredMcpResult>(),
  claim: vi.fn<typeof claimPendingMcpResult>(), finalize: vi.fn<typeof finalizePendingMcpResult>() }));
vi.mock('../../endpoint-route/routes/transport/_mcp-result-replay', () => ({
  PENDING_MCP_RESULT_STATE: 'pending', claimPendingMcpResult: receipts.claim, finalizePendingMcpResult: receipts.finalize,
}));

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn() }));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'default'),
  resolveConcreteWorkspaceId: (...c: Array<string | null | undefined>) =>
    c.find((x): x is string => typeof x === 'string' && x.trim() !== '' && x.trim() !== '*') ?? 'default',
}));
vi.mock('./_create_from_repo', () => ({ createPotFromRepo: vi.fn() }));

import { resolveAgentIdentity } from '../coordination/identity';
import { createPotFromRepo } from './_create_from_repo';
const ident = vi.mocked(resolveAgentIdentity);
const createM = vi.mocked(createPotFromRepo);
const tool = (await import('./create_from_repo')).default;

type Out = { content: { text: string }[] };
const ctx = { workspaceId: 'ws-1', principal: { workspaceId: 'ws-1' } };
const call = (args: Record<string, unknown> = {}) =>
  tool.handler({ githubUrl: 'https://github.com/x/y', ...args } as never, ctx as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);
const createdResult: CreatePotFromRepoResult = { ok: true,
  created: { potSlug: 'y-pot', memberSlug: 'y', memberPath: '/fixture/y' }, bindingUnverified: false,
  publish: { skipped: 'unpublished_hive' }, gitSync: { seeded: false, reason: 'routine_exists' } };

beforeEach(() => {
  vi.clearAllMocks();
  receipts.rows.clear();
  receipts.claim.mockImplementation(async (input) => {
    const key = `${input.ownerKey}/${input.idempotencyKey}`;
    const prior = receipts.rows.get(key);
    if (prior) return { claimed: false, pending: prior._meta?.state === 'pending', result: prior };
    receipts.rows.set(key, input.result);
    return { claimed: true, pending: true, result: input.result };
  });
  receipts.finalize.mockImplementation(async (input) => {
    receipts.rows.set(`${input.ownerKey}/${input.idempotencyKey}`, input.result);
    return true;
  });
  ident.mockReturnValue({ source: 'operator' } as never);
  mockResolvedTyped(createM, createdResult);
});

describe('keyed MCP pot creation', () => {
  const invoke = (key: string) => tool.handler({ githubUrl: 'https://github.com/x/y', force: true } as never,
    { ...ctx, transport: 'mcp', uiClientId: 'stable-owner', idempotencyKey: key } as never) as Promise<Out>;
  it('reserves before side effects and reuses one running operation across new connection contexts', async () => {
    let finish!: (value: CreatePotFromRepoResult) => void;
    mockImplementationTyped(createM, () => new Promise(resolve => { finish = resolve; }));
    const first = body(await invoke('two-connections'));
    expect(first).toMatchObject({ accepted: true, status: 'in_progress' });
    expect(createM).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(createM).toHaveBeenCalledTimes(1));
    expect(body(await invoke('two-connections')).progressId).toBe(first.progressId);
    expect(createM).toHaveBeenCalledTimes(1);
    finish(createdResult);
    await vi.waitFor(() => expect(receipts.finalize).toHaveBeenCalledTimes(1));
    expect(body(await invoke('two-connections'))).toMatchObject({ created: { potSlug: 'y-pot' } });
    expect(createM).toHaveBeenCalledTimes(1);
  });
  it('fails closed before creation when the durable reservation is unavailable', async () => {
    receipts.claim.mockRejectedValueOnce(new Error('receipt store unavailable'));
    expect(body(await invoke('store-down'))).toMatchObject({ ok: false, error: 'pot_create_receipt_unavailable' });
    expect(createM).not.toHaveBeenCalled();
  });
  it('does not re-arm a pending force-create left by a different process', async () => {
    receipts.rows.set('stable-owner/restarted', { content: [], _meta: { state: 'pending', progressId: 'original' } });
    expect(body(await invoke('restarted'))).toMatchObject({ status: 'recovery_required', progressId: 'original' });
    expect(createM).not.toHaveBeenCalled();
  });
  it('persists a thrown composition outcome instead of letting the retry create again', async () => {
    createM.mockRejectedValueOnce(new Error('publish failed after registration'));
    await invoke('failed-create');
    await vi.waitFor(() => expect(receipts.finalize).toHaveBeenCalledTimes(1));
    expect(body(await invoke('failed-create'))).toMatchObject({ ok: false, error: 'pot_create_failed' });
    expect(createM).toHaveBeenCalledTimes(1);
  });
});

describe('pot:create_from_repo handler', () => {
  it('refuses a cup (fleet-spawn) — root-only — with no clone/create', async () => {
    ident.mockReturnValue({ source: 'fleet-spawn' } as never);
    const b = body(await call());
    expect(b).toMatchObject({ ok: false, error: 'hive_create_root_only' });
    expect(createM).not.toHaveBeenCalled();
  });

  it('delegates with the resolved workspace and returns the composition result', async () => {
    const b = body(await call());
    expect(b).toMatchObject({ ok: true, created: { potSlug: 'y-pot' } });
    expect(createM.mock.calls[0]![0]).toMatchObject({ githubUrl: 'https://github.com/x/y', workspaceId: 'ws-1' });
  });

  it('passes optional args (slug/force/intoPot) through', async () => {
    await call({ slug: 'mypot', force: true, intoPot: 'parent-pot' });
    expect(createM.mock.calls[0]![0]).toMatchObject({ slug: 'mypot', force: true, intoPot: 'parent-pot' });
  });
});
