import { describe, expect, it, vi } from 'vitest';
import type { ProviderDescriptor } from '@papercusp/plugin-sdk';
import { validateProviderDescriptor } from '@papercusp/plugin-sdk';
import { createHostFetch } from './host-fetch';
import { createProviderRegistry } from './provider-registry';

const descriptor: ProviderDescriptor = {
  id: 'page-example', contractVersion: 1, datatypes: ['social-post'], capabilities: ['social.post'],
  egressHosts: ['graph.example.com', 'login.example.com'],
  oauth: {
    authorizeUrl: 'https://login.example.com/authorize', tokenUrl: 'https://login.example.com/token', scopes: ['pages'],
    resourceToken: {
      url: 'https://graph.example.com/me/accounts?fields=id,access_token,tasks', hosts: ['graph.example.com'],
      collectionField: 'data', idField: 'id', tokenField: 'access_token', configKey: 'pageId',
      permissions: { field: 'tasks', required: ['MODERATE', 'CREATE_CONTENT'] }, nextUrlField: 'paging.next',
    },
  },
};

async function fixture(replies: Array<unknown | Response>, config: Record<string, unknown> = { pageId: 'mine' }) {
  const registry = createProviderRegistry();
  await registry.register({ descriptor, pluginName: 'example', adapter: {
    describe: () => descriptor, syncPage: async () => ({ records: [], cursor: null, hasMore: false }), invoke: async () => ({}),
  } });
  const calls: Array<{ url: string; authorization: string | null; redirect: RequestRedirect | undefined }> = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization'), redirect: init?.redirect });
    const reply = replies.shift();
    if (reply === undefined) throw new Error('unexpected network call');
    return reply instanceof Response ? reply : Response.json(reply);
  }) as unknown as typeof globalThis.fetch; // the local `fetch` below shadows the global name
  const fetch = createHostFetch(descriptor.id, { registry,
    resolveSource: async (id) => id === 'source' ? { sourceId: id, providerId: descriptor.id, config } : null,
    accessToken: async () => 'account-private-token', fetchImpl });
  return { calls, fetch: () => fetch({ source: 'source', request: { url: 'https://graph.example.com/mine/feed', method: 'POST', body: 'hello' } }),
    direct: () => fetch({ source: 'source', request: { url: descriptor.oauth!.resourceToken!.url } }) };
}
const resource = { id: 'mine', access_token: 'page-private-token', tasks: ['MODERATE', 'CREATE_CONTENT'] };

describe('host-held resource credentials', () => {
  it('selects the configured resource across pages, keeps the exchange private, and sends only its token to the API', async () => {
    const f = await fixture([{ data: [{ ...resource, id: 'another', access_token: 'foreign' }], paging: { next: 'https://graph.example.com/me/accounts?after=one' } },
      { data: [resource] }, { id: 'published' }]);
    expect(JSON.parse((await f.fetch()).body)).toEqual({ id: 'published' });
    expect(f.calls.map((x) => x.authorization)).toEqual(['Bearer account-private-token', 'Bearer account-private-token', 'Bearer page-private-token']);
  });
  it('refuses a different resource and missing permissions before any write', async () => {
    for (const row of [{ ...resource, id: 'foreign' }, { ...resource, tasks: ['CREATE_CONTENT'] }]) {
      const f = await fixture([{ data: [row] }]);
      await expect(f.fetch()).rejects.toMatchObject({ code: 'resource-token-unavailable', kind: 'auth' });
      expect(f.calls).toHaveLength(1);
    }
  });
  it('requires persisted source selection and denies direct package access to the credential endpoint', async () => {
    const f = await fixture([], {});
    await expect(f.fetch()).rejects.toMatchObject({ code: 'resource-token-unavailable' });
    await expect(f.direct()).rejects.toMatchObject({ code: 'credential-endpoint-private' });
    expect(f.calls).toHaveLength(0);
  });
  it.each(['https://attacker.example/me/accounts', 'https://graph.example.com/other', 'https://graph.example.com/me/accounts?fields=id,access_token,tasks'])('refuses escaped or cyclic pagination %s without exposing tokens', async (next) => {
    const f = await fixture([{ data: [], paging: { next } }]);
    const error = await f.fetch().catch((e: Error) => e);
    expect(error).toMatchObject({ code: 'resource-token-unavailable' });
    expect(String(error)).not.toMatch(/private-token/);
    expect(f.calls).toHaveLength(1);
  });
  it('surfaces throttle and auth signals without retrying or echoing a credential-bearing body', async () => {
    for (const [status, kind] of [[429, 'rate-limited'], [401, 'auth'], [503, 'transient']] as const) {
      const f = await fixture([Response.json({ access_token: 'do-not-leak' }, { status, headers: { 'retry-after': '12' } })]);
      const error = await f.fetch().catch((e: Error) => e);
      expect(error).toMatchObject({ kind });
      expect(String(error)).not.toContain('do-not-leak');
      expect(f.calls).toHaveLength(1);
    }
  });
  it('refuses a credential-endpoint redirect without following it or making the API write', async () => {
    const f = await fixture([new Response(null, { status: 302, headers: { location: 'https://attacker.example/collect' } })]);
    await expect(f.fetch()).rejects.toMatchObject({ code: 'resource-token-unavailable' });
    expect(f.calls).toEqual([{ url: descriptor.oauth!.resourceToken!.url, authorization: 'Bearer account-private-token', redirect: 'manual' }]);
  });
  it('redacts API echoes of either credential from JSON, headers and binary responses', async () => {
    for (const response of [Response.json({ account: 'account-private-token', token: 'page-private-token', id: 'post' },
      { headers: { 'x-token': 'page-private-token' } }), new Response(Buffer.from('binary\u0000page-private-token'),
      { headers: { 'content-type': 'application/octet-stream' } })]) {
      const f = await fixture([{ data: [resource] }, response]);
      const reply = await f.fetch();
      const body = Buffer.from(reply.body, reply.bodyEncoding === 'base64' ? 'base64' : 'utf8').toString();
      expect(body).not.toMatch(/(?:account|page)-private-token/);
      expect(body).toContain('[redacted]');
      expect(JSON.stringify(reply.headers)).not.toContain('page-private-token');
    }
  });
  it('validates resource selectors and exchange egress when loading a descriptor', () => {
    expect(validateProviderDescriptor(descriptor)).toEqual([]);
    const invalid = structuredClone(descriptor);
    invalid.oauth!.resourceToken!.url = 'https://outside.example/accounts';
    invalid.oauth!.resourceToken!.hosts = ['outside.example'];
    invalid.oauth!.resourceToken!.tokenField = '__proto__.secret';
    const issues = validateProviderDescriptor(invalid);
    expect(issues.some((x) => x.includes('endpoint host'))).toBe(true);
    expect(issues.some((x) => x.includes('resourceToken.hosts'))).toBe(true);
    expect(issues.some((x) => x.includes('resourceToken.tokenField'))).toBe(true);
  });
  it.each([null, false, [], 'not-an-exchange'])('returns validation findings for malformed exchange %j', (exchange) => {
    expect(validateProviderDescriptor({ ...descriptor, oauth: { ...descriptor.oauth, resourceToken: exchange } }))
      .toContain('provider.oauth.resourceToken.url must be an https URL');
  });
});
