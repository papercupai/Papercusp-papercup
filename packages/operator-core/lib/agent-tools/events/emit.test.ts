/**
 * emit.test.ts — events:emit envelope (GAP 6).
 *
 * Deps mocked (emitAwaitedEvent / resolveAgentIdentity). Asserts the emit
 * forwards source=identity.ownerId + workspaceId, and that the response shape is
 * { woken, notified: <count, not the array>, msg_id } off the engine result.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
  SU_ROLES: ['operator'],
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-emitter', ownerLabel: 'e', source: 'static-client', workspaceId: 'ws-x', userId: null }),
  deriveAgentRole: () => 'operator',
}));
vi.mock('../../events/await/engine', () => ({
  emitAwaitedEvent: vi.fn(),
}));
vi.mock('../../events/await/store', () => ({
  registerAnnouncement: vi.fn(async () => ({ causalGeneration: 1, expiresTs: null })),
  countActiveAwaitsByPrefixes: vi.fn(async () => new Map()),
  findNearMissKeys: vi.fn(async () => []),
}));
vi.mock('../../events/saved-event-type', () => ({
  saveEventType: vi.fn(async () => ({ eventKey: 'saved' })),
  validateSavedEventPayload: vi.fn(async () => undefined),
}));
// P-009: the federation legs — sendMessage carries the fed-event row; the scope
// resolver defaults to none (machine-local behavior unchanged).
vi.mock('../coordination/messages', () => ({
  sendMessage: vi.fn(async () => ({ msg_id: 'fed-1', to: [], ts: 't' })),
}));
vi.mock('../coordination/federation-scope', () => ({
  resolveWorkspaceHiveScope: vi.fn(async () => ({ kind: 'none' })),
}));

import emit from './emit';
import { emitAwaitedEvent } from '../../events/await/engine';
import { sendMessage } from '../coordination/messages';
import { resolveWorkspaceHiveScope } from '../coordination/federation-scope';
import { saveEventType, validateSavedEventPayload } from '../../events/saved-event-type';

const ctx = { workspaceId: 'ws-x' } as unknown as Parameters<typeof emit.handler>[1];
const call = async (args: Record<string, unknown>, callCtx = ctx) => {
  const res = (await emit.handler(args as never, callCtx)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
};

beforeEach(() => vi.clearAllMocks());

describe('events:emit envelope', () => {
  it('admits the release-fixer to emit its parent readiness gate', () => {
    expect(emit.agentRoles).toContain('release-fixer');
  });

  it('saves the final scoped declaration key without firing it', async () => {
    const out = await call({ event: 'ready', announce: true, announceScope: 'harness', announceScopeRef: 'demo', save: true });
    expect(out).toMatchObject({ announced: true, saved: true, event: 'harness:demo:ready' });
    expect(saveEventType).toHaveBeenCalledWith(expect.objectContaining({ event: 'harness:demo:ready' }));
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
  });
  it('saves a type before firing and preserves the authenticated contributor', async () => {
    vi.mocked(emitAwaitedEvent).mockResolvedValue({ ok: true, key: 'demo:ready', woken: 1, notified: [], msgId: null, waiters: 1 });
    const out = await call({ event: 'demo:ready', save: true, payloadSchema: { type: 'object' }, payload: {} });
    expect(out.saved).toBe(true);
    expect(saveEventType).toHaveBeenCalledWith(expect.objectContaining({ event: 'demo:ready', workspaceId: 'ws-x', ownerId: 'su-emitter' }));
    expect(vi.mocked(saveEventType).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(emitAwaitedEvent).mock.invocationCallOrder[0]);
  });

  it('refuses invalid payloads before waking or notifying anyone', async () => {
    vi.mocked(validateSavedEventPayload).mockRejectedValueOnce(new Error('event_payload_invalid'));
    await expect(call({ event: 'demo:ready', payload: { invalid: true } })).rejects.toThrow('event_payload_invalid');
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('retires a saved event without firing and requires save for metadata', async () => {
    expect(await call({ event: 'demo:ready', save: true, eventStatus: 'retired' })).toMatchObject({ status: 'retired', fired: false });
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
    expect(emit.args.safeParse({ event: 'demo:ready', title: 'Ready' }).success).toBe(false);
  });
  it('validates and documents announce/to incompatibility before the handler', () => {
    expect(emit.args.safeParse({ event: 'g', announce: true, to: ['su-x'] }).success).toBe(false);
    expect(emit.args.safeParse({ event: 'g', announce: true }).success).toBe(true);
    expect(emit.args.safeParse({ event: 'g', to: ['su-x'] }).success).toBe(true);
    expect(emit.description).toContain('`announce:true`, `to` is rejected');
    expect(emit.args.shape.to.description).toContain('`announce:true` rejects `to`');
  });

  it('forwards source=identity.ownerId + workspaceId, and key/summary/payload/to', async () => {
    vi.mocked(emitAwaitedEvent).mockResolvedValue({ ok: true, key: 'k1', woken: 2, notified: ['a', 'b', 'c'], msgId: 'm-9', waiters: 2 });
    await call({ event: 'k1', summary: 's', payload: { n: 1 }, to: ['x', 'y'] });
    expect(emitAwaitedEvent).toHaveBeenCalledWith({
      key: 'k1',
      summary: 's',
      payload: { n: 1 },
      to: ['x', 'y'],
      source: 'su-emitter',
      workspaceId: 'ws-x',
    });
  });

  it('omits operator-scope harness sentinel from emitted event identity', async () => {
    vi.mocked(emitAwaitedEvent).mockResolvedValue({ ok: true, key: 'k1', woken: 0, notified: [], msgId: null, waiters: 0 });
    await call({ event: 'k1' }, { ...ctx, harnessSlug: '*' } as never);
    expect(emitAwaitedEvent).toHaveBeenCalledWith(expect.not.objectContaining({ harnessSlug: '*' }));
  });

  it('response carries woken, notified=count (NOT the array), waiters, msg_id', async () => {
    vi.mocked(emitAwaitedEvent).mockResolvedValue({ ok: true, key: 'k2', woken: 5, notified: ['a', 'b', 'c'], msgId: 'm-42', waiters: 6 });
    const out = await call({ event: 'k2' });
    expect(out).toEqual({ ok: true, event: 'k2', woken: 5, notified: 3, waiters: 6, msg_id: 'm-42' });
    // notified must be the count, never the array.
    expect(Array.isArray(out.notified)).toBe(false);
  });

  it('null msgId + zero notify audience surface as msg_id:null, notified:0', async () => {
    vi.mocked(emitAwaitedEvent).mockResolvedValue({ ok: true, key: 'k3', woken: 0, notified: [], msgId: null, waiters: 0 });
    const out = await call({ event: 'k3' });
    expect(out).toMatchObject({ event: 'k3', woken: 0, notified: 0, waiters: 0, msg_id: null });
  });

  it('EI-9000: waiters:0 + no to[] + notified:0 signals the emit genuinely reached no one', async () => {
    vi.mocked(emitAwaitedEvent).mockResolvedValue({ ok: true, key: 'k4', woken: 0, notified: [], msgId: null, waiters: 0 });
    const out = await call({ event: 'k4' });
    expect(out.waiters).toBe(0);
    expect(out.woken).toBe(0);
    expect(out.notified).toBe(0);
  });
});


describe('events:emit scope:\'hive\' (P-009 federated event keys)', () => {
  const engineResult = { key: 'k1', woken: 1, notified: [], msgId: null };

  it('federates via a NO-RECIPIENT hive-scoped coord row carrying fed_event', async () => {
    vi.mocked(emitAwaitedEvent).mockResolvedValue(engineResult as never);
    vi.mocked(resolveWorkspaceHiveScope).mockResolvedValue({ kind: 'one', homeSlug: 'my-hive' } as never);
    const out = await call({ event: 'k1', payload: { sha: 'abc' }, scope: 'hive' });
    expect(out.federated).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(sendMessage).mock.calls[0][1] as unknown as Record<string, unknown>;
    expect(opts.to).toEqual([]); // zero inbox noise
    expect(opts.harnessSlug).toBe('my-hive');
    expect((opts.extra as { fed_event: { key: string; payload: unknown; source: string } }).fed_event).toMatchObject({
      key: 'k1',
      payload: { sha: 'abc' },
      source: 'su-emitter',
    });
  });

  it('no shared hive → local emit still succeeds, federated:false + federation_error', async () => {
    vi.mocked(emitAwaitedEvent).mockResolvedValue(engineResult as never);
    // clearAllMocks resets calls, not implementations — pin 'none' explicitly.
    vi.mocked(resolveWorkspaceHiveScope).mockResolvedValue({ kind: 'none' } as never);
    const out = await call({ event: 'k1', scope: 'hive' });
    expect(out.ok).toBe(true);
    expect(out.woken).toBe(1); // the LOCAL emit happened regardless
    expect(out.federated).toBe(false);
    expect(out.federation_error).toBe('no_hive_scope');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('without scope, nothing federates and the result shape is unchanged', async () => {
    vi.mocked(emitAwaitedEvent).mockResolvedValue(engineResult as never);
    vi.mocked(resolveWorkspaceHiveScope).mockResolvedValue({ kind: 'none' } as never);
    const out = await call({ event: 'k1' });
    expect(out.federated).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('an oversized payload is DROPPED from the federated frame (signal, not blob) but still federates', async () => {
    vi.mocked(emitAwaitedEvent).mockResolvedValue(engineResult as never);
    vi.mocked(resolveWorkspaceHiveScope).mockResolvedValue({ kind: 'one', homeSlug: 'my-hive' } as never);
    const out = await call({ event: 'k1', payload: { blob: 'x'.repeat(10_000) }, scope: 'hive' });
    expect(out.federated).toBe(true);
    expect(out.federation_error).toBe('payload_too_large_dropped');
    const opts = vi.mocked(sendMessage).mock.calls[0][1] as unknown as {
      extra: { fed_event: Record<string, unknown> };
    };
    expect(opts.extra.fed_event.payload).toBeUndefined();
  });
});
