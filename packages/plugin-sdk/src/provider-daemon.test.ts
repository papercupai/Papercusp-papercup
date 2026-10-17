import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createProviderDaemon, type ProviderDaemonMessage } from './provider-daemon';
import { providerSyncErrorOf, type ProviderAdapter, type ProviderHost } from './provider';

const descriptor = { id: 'test-provider', contractVersion: 1 as const, datatypes: ['social-post'], capabilities: ['social.post'], egressHosts: ['api.example'] };
const page = { records: [], nextCursor: null, hasMore: false };
const adapter = (overrides: Partial<ProviderAdapter> = {}): ProviderAdapter => ({ describe: () => descriptor, syncPage: async () => page, invoke: async () => null, ...overrides });
const call = (id: number, source = 'a', method = 'provider.syncPage') => ({ jsonrpc: '2.0' as const, id, method, params: { callToken: `token-${source}`, request: { source, cursor: null, mode: 'incremental', config: {} } } });
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe('portable provider daemon protocol', () => {
  it('ships reproducible self-contained launchers for every delivered social package', () => {
    const root = resolve(process.cwd(), '../..');
    execFileSync(process.execPath, [resolve(root, 'packages/plugin-sdk/scripts/build-provider-daemons.mjs'), '--check',
      ...['facebook-pages', 'instagram', 'x'].map((id) => resolve(root, 'libs/papercusp/plugins', id))], { cwd: root });
  });

  it('answers health/describe, rejects unknown methods and invalid calls, ignores malformed frames/notifications', async () => {
    const sent: ProviderDaemonMessage[] = [];
    const d = createProviderDaemon(adapter(), (m) => sent.push(m));
    for (const m of [null, 'bad', {}, { jsonrpc: '2.0', method: 'provider.invoke' }]) d.receive(m);
    d.receive({ jsonrpc: '2.0', id: 1, method: 'papercup.ping' });
    d.receive({ jsonrpc: '2.0', id: 2, method: 'provider.describe' });
    d.receive({ jsonrpc: '2.0', id: 3, method: 'nope' });
    d.receive({ jsonrpc: '2.0', id: 4, method: 'provider.invoke', params: {} });
    await flush();
    expect(sent).toHaveLength(4);
    expect(sent.find((m) => m.id === 1)?.result).toBe('pong');
    expect(sent.find((m) => m.id === 2)?.result).toEqual(descriptor);
    expect(sent.find((m) => m.id === 3)?.error?.code).toBe(-32601);
    expect(sent.find((m) => m.id === 4)?.error?.code).toBe(-32602);
    d.close();
  });

  it('binds concurrent sources/tokens and correlates out-of-order host replies without cross-talk', async () => {
    const sent: ProviderDaemonMessage[] = [];
    const fetch = (r: { source: string }, host: ProviderHost) => host.fetch({ source: r.source, request: { url: `https://api.example/${r.source}` } });
    const d = createProviderDaemon(adapter({ invoke: fetch }), (m) => sent.push(m));
    d.receive(call(1, 'a', 'provider.invoke'));
    d.receive(call(2, 'b', 'provider.invoke'));
    expect(sent.map((m) => m.params)).toEqual([
      { source: 'a', callToken: 'token-a', request: { url: 'https://api.example/a' } },
      { source: 'b', callToken: 'token-b', request: { url: 'https://api.example/b' } },
    ]);
    const [a, b] = sent;
    d.receive({ jsonrpc: '2.0', id: 'unknown', result: 'ignored' });
    d.receive({ jsonrpc: '2.0', id: b!.id, result: { body: 'B' } });
    d.receive({ jsonrpc: '2.0', id: a!.id, result: { body: 'A' } });
    await flush();
    expect(sent.find((m) => m.id === 1)?.result).toEqual({ body: 'A' });
    expect(sent.find((m) => m.id === 2)?.result).toEqual({ body: 'B' });
    expect(d.pendingFetches()).toBe(0);
    d.close();
  });

  it.each(['cursor-expired', 'rate-limited', 'auth', 'transient'] as const)('preserves %s error classification over JSON serialization', async (kind) => {
    const sent: ProviderDaemonMessage[] = [];
    const d = createProviderDaemon(adapter({ syncPage: async () => { throw Object.assign(new Error('classified'), { kind, retryAfterSeconds: 37 }); } }), (m) => sent.push(JSON.parse(JSON.stringify(m))));
    d.receive(call(1));
    await flush();
    expect(providerSyncErrorOf(sent[0]!.error)).toEqual({ kind, message: 'classified', ...(kind === 'rate-limited' ? { retryAfterSeconds: 37 } : {}) });
    d.close();
  });

  it('preserves a host refusal code/data and clears pending fetches', async () => {
    const sent: ProviderDaemonMessage[] = [];
    const d = createProviderDaemon(adapter({ invoke: (r, h) => h.fetch({ source: r.source, request: { url: 'https://api.example' } }) }), (m) => sent.push(m));
    d.receive(call(1, 'a', 'provider.invoke'));
    const error = { code: -32002, message: 'source-not-bound', data: { code: 'source-not-bound' } };
    d.receive({ jsonrpc: '2.0', id: sent[0]!.id, error });
    await flush();
    expect(sent[1]!.error).toEqual(error);
    expect(d.pendingFetches()).toBe(0);
    d.close();
  });

  it('preserves an unconfirmed operation receipt alongside its normalized typed fault', async () => {
    const sent: ProviderDaemonMessage[] = [];
    const receipt = { containerId: 'container-1', observedStatus: 'PUBLISHED', retrySafe: false, kind: 'wrong' };
    const d = createProviderDaemon(adapter({ invoke: async () => {
      throw Object.assign(new Error('publish_ambiguous_do_not_retry'), { kind: 'transient', data: receipt });
    } }), (m) => sent.push(JSON.parse(JSON.stringify(m))));
    d.receive(call(1, 'a', 'provider.invoke'));
    await flush();
    expect(sent[0]!.error?.data).toEqual({ ...receipt, kind: 'transient', message: 'publish_ambiguous_do_not_retry' });
    expect(providerSyncErrorOf(sent[0]!.error)).toEqual({ kind: 'transient', message: 'publish_ambiguous_do_not_retry' });
    d.close();
  });

  it('expires unanswered fetches and ignores late replies', async () => {
    vi.useFakeTimers();
    const sent: ProviderDaemonMessage[] = [];
    const d = createProviderDaemon(adapter({ invoke: (r, h) => h.fetch({ source: r.source, request: { url: 'https://api.example' } }) }), (m) => sent.push(m), { fetchTimeoutMs: 50 });
    d.receive(call(1, 'a', 'provider.invoke'));
    await vi.advanceTimersByTimeAsync(50);
    expect(d.pendingFetches()).toBe(0);
    expect(sent[1]!.error?.message).toBe('host.fetch timed out');
    d.receive({ jsonrpc: '2.0', id: sent[0]!.id, result: {} });
    await flush();
    expect(sent).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    d.close();
  });

  it('closes pending calls and prevents use of a saved host after the provider call finishes', async () => {
    let savedHost: ProviderHost | undefined;
    const sent: ProviderDaemonMessage[] = [];
    const d = createProviderDaemon(adapter({ syncPage: async (_r, h) => { savedHost = h; return page; } }), (m) => sent.push(m));
    d.receive(call(1));
    await flush();
    await expect(savedHost!.fetch({ source: 'a', request: { url: 'https://api.example' } })).rejects.toThrow('provider call closed');
    expect(sent).toHaveLength(1);
    const closeSent: ProviderDaemonMessage[] = [];
    const closing = createProviderDaemon(adapter({ invoke: (r, h) => h.fetch({ source: r.source, request: { url: 'https://api.example' } }) }), (m) => closeSent.push(m));
    closing.receive(call(2, 'b', 'provider.invoke'));
    closing.close();
    await flush();
    closing.receive(call(3));
    expect(closing.pendingFetches()).toBe(0);
    expect(closeSent).toHaveLength(1);
    d.close();
  });
});
