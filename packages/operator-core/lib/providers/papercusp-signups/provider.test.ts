import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { validateProviderDescriptor, type HostFetchRequest, type ProviderAdapter } from '@papercusp/plugin-sdk/provider';

const require = createRequire(import.meta.url);
const { providerAdapter: adapter } = require('../../../../../libs/papercusp/plugins/papercusp-signups/index.cjs') as { providerAdapter: ProviderAdapter };
const config = { accountId: 'a'.repeat(32), namespaceId: 'b'.repeat(32) };
const key = 'signup:2026-10-26T12:00:00.000Z:abc12345';
const value = { email: 'Lead@Example.com', what: 'Automate support', ts: '2026-10-26T12:00:00.000Z',
  ua: 'not forwarded', attribution: { distinct_id: 'PER-forged', ownerId: 'other', first_touch: { utm_campaign: 'launch', unknown: 'drop' } },
  consent: true, activated: true, personId: 'PER-forged' };

function host(options: { token?: string; status?: number; rawValue?: unknown; failValue?: boolean; keys?: string[]; list?: unknown } = {}) {
  const calls: HostFetchRequest[] = [];
  return { calls, async fetch({ source, request }: Parameters<import('@papercusp/plugin-sdk/provider').HostFetch>[0]) {
    expect(source).toBe('source-one');
    expect(request.method).toBe('GET');
    expect(new URL(request.url).origin).toBe('https://api.cloudflare.com');
    expect(request.headers).toBeUndefined(); // auth remains host-held
    calls.push(request);
    const keys = new URL(request.url).pathname.endsWith('/keys');
    return { status: options.status ?? (!keys && options.failValue ? 503 : 200), headers: { 'retry-after': '11' },
      bodyEncoding: 'utf8' as const, body: JSON.stringify(keys
        ? options.list ?? { success: true, result: (options.keys ?? [key]).map((name) => ({ name })), result_info: { cursor: options.token ?? '' } }
        : options.rawValue ?? value) };
  } };
}
const sync = (h: ReturnType<typeof host>, cursor: string | null = null, sourceConfig = config) =>
  adapter.syncPage({ source: 'source-one', cursor, mode: 'backfill', config: sourceConfig }, h);

describe('P019 captured signup provider (distribution bytes)', () => {
  it('uses the provider contract, host credentials and explicit destination selection', async () => {
    const descriptor = await adapter.describe();
    expect(validateProviderDescriptor(descriptor)).toEqual([]);
    expect(descriptor).toMatchObject({ datatypes: ['person'], capabilities: [], egressHosts: ['api.cloudflare.com'] });
    expect(descriptor.defaultDestinations).toBeUndefined();
    expect(descriptor.setup?.credentials?.[0]).toMatchObject({ key: 'kv_read_token', hosts: ['api.cloudflare.com'] });
    await expect(adapter.invoke({ source: 'source-one', capability: 'send', args: {} }, host())).rejects.toThrow('no_invokable_capabilities');
  });

  it('preserves capture evidence and treats identity, consent, activation and attribution as unverified', async () => {
    const h = host();
    const page = await sync(h);
    expect(page).toMatchObject({ nextCursor: null, hasMore: false });
    expect(page.records).toEqual([{
      datatype: 'person', nativeId: key, event: 'person.updated', occurredAt: value.ts,
      payload: { provider: 'papercusp-signups', externalId: key, observedAt: value.ts,
        emails: ['lead@example.com'], extensions: { 'papercusp-signups': {
        signupEventId: key, capturedAt: value.ts, evidenceRef: `cloudflare-kv:${config.accountId}:${config.namespaceId}:${key}`,
        emailVerified: false, communicationConsent: false,
        selfReported: { useCase: value.what, attribution: { distinct_id: 'PER-forged', first_touch: { utm_campaign: 'launch' } } },
      } } },
    }]);
    expect(h.calls).toHaveLength(2);
    expect(new URL(h.calls[0]!.url).searchParams.get('prefix')).toBe('signup:');
    expect(new URL(h.calls[0]!.url).searchParams.get('limit')).toBe('20');
    expect(decodeURIComponent(new URL(h.calls[1]!.url).pathname.split('/values/')[1]!)).toBe(key);
  });

  it('replays an interrupted page, resumes by a source-bound cursor and ends a scan explicitly', async () => {
    const first = await sync(host({ token: 'page+2/=' }));
    expect(await sync(host({ token: 'page+2/=' }))).toEqual(first);
    const nextHost = host({ keys: [] });
    expect(await sync(nextHost, first.nextCursor)).toEqual({ records: [], nextCursor: null, hasMore: false });
    expect(new URL(nextHost.calls[0]!.url).searchParams.get('cursor')).toBe('page+2/=');
    const other = host();
    await expect(sync(other, first.nextCursor, { ...config, namespaceId: 'c'.repeat(32) })).rejects.toThrow('cursor_scope_mismatch');
    expect(other.calls).toHaveLength(0);
  });

  it.each([401, 403, 429, 500])('refuses HTTP %s without returning records or advancing a cursor', async (status) => {
    await expect(sync(host({ status }))).rejects.toMatchObject({ kind: status === 429 ? 'rate-limited' : status < 429 ? 'auth' : 'transient',
      ...(status === 429 ? { retryAfterSeconds: 11 } : {}) });
  });

  it('does not return a cursor when fetching a listed value failed', async () => {
    await expect(sync(host({ token: 'next', failValue: true }))).rejects.toThrow('kv_http_503');
  });

  it.each([
    { ...value, ts: '2026-10-25T12:00:00.000Z' },
    { ...value, email: 'Name <private@example.com>' },
    { ...value, email: 'private@example.com\r\nBcc: someone@example.com' },
    [],
  ])('refuses malformed captures without logging their bodies: %j', async (rawValue) => {
    try { await sync(host({ rawValue })); throw new Error('unexpected success'); }
    catch (error) { expect(String(error)).toMatch(/papercusp_signups:/); expect(String(error)).not.toContain('private@example.com'); }
  });

  it.each([[key, key], ['hit:day:2026-10-26:count'], ['signup:malformed']])('rejects duplicate or unrelated keys: %j', async (...keys) => {
    const h = host({ keys });
    await expect(sync(h)).rejects.toThrow('kv_signup_keys_invalid');
    expect(h.calls).toHaveLength(1);
  });

  it.each([
    { success: false, result: [], result_info: { cursor: '' } },
    { success: true, result: [], result_info: {} },
    { success: true, result: {}, result_info: { cursor: '' } },
  ])('does not silently accept a malformed API page: %j', async (list) => {
    await expect(sync(host({ list }))).rejects.toThrow('papercusp_signups:');
  });

  it('rejects nonadvancing cursors and malformed cursor/config before fetch', async () => {
    const first = await sync(host({ token: 'same' }));
    await expect(sync(host({ token: 'same' }), first.nextCursor)).rejects.toThrow('kv_cursor_not_advancing');
    const h = host();
    await expect(sync(h, 'not-json')).rejects.toMatchObject({ kind: 'cursor-expired' });
    await expect(sync(h, null, { ...config, accountId: '../other' })).rejects.toThrow('account_and_namespace_required');
    expect(h.calls).toHaveLength(0);
  });
});
