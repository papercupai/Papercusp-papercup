/**
 * POST /user/integrations/options over HTTP (cupboard-distributable-integrations-2026-10-10 P-004,
 * D-005; SPEC-R-2-P-004). The route is thin over provider-options.ts; what this pins is the HTTP
 * contract: the body names the option source, the answer is scoped to the signed-in owner, named
 * refusals keep their status, and a cross-origin request is refused before any provider is asked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteDefinition } from '../../define-route';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  listProviderOptions: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: 'org-sql' }),
}));
vi.mock('../../../auth', () => ({ getSessionUserOrDefault: mocks.getUser }));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../../integrations/provider-options', () => ({ listProviderOptions: mocks.listProviderOptions }));

import routes from './provider-options';
import { TicketIntegrationError } from '../../../integrations/ticket-integrations';

const route = (routes as RouteDefinition[]).find((r) => r.method === 'POST' && r.path === '/user/integrations/options');

const post = (body: unknown, headers: Record<string, string> = {}) =>
  route!.handler(
    new Request('http://127.0.0.1/api/user/integrations/options', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: {} } as never,
  ) as Promise<Response>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ id: 'user-1' });
});

describe('POST /user/integrations/options', () => {
  it('is registered as a loopback route', () => {
    expect(route).toMatchObject({ auth: 'loopback' });
  });

  it('asks for the declared option source as the signed-in owner and returns the groups', async () => {
    const groups = [{ sourceId: 's1', provider: 'fixture-chat', options: [{ value: 'C1', label: '#bugs' }], truncated: false, error: null }];
    mocks.listProviderOptions.mockResolvedValue({ capability: 'chat.channels', groups });

    const res = await post({ capability: 'chat.channels', args: { types: 'public' }, sourceId: 's1' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, capability: 'chat.channels', groups });
    expect(mocks.listProviderOptions).toHaveBeenCalledWith('org-sql', {
      workspaceId: 'ws-test',
      ownerUserId: 'user-1',
      capability: 'chat.channels',
      args: { types: 'public' },
      sourceId: 's1',
    });
  });

  it('passes neither args nor sourceId when the body omits them', async () => {
    mocks.listProviderOptions.mockResolvedValue({ capability: 'ticket.containers', groups: [] });
    await post({ capability: 'ticket.containers' });
    expect(mocks.listProviderOptions).toHaveBeenCalledWith('org-sql', { workspaceId: 'ws-test', ownerUserId: 'user-1', capability: 'ticket.containers' });
  });

  it('refuses a body without a capability', async () => {
    for (const body of ['"nope"', { args: {} }, { capability: 'chat.channels', sourceId: 7 }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, error: 'bad_request' });
    }
    expect(mocks.listProviderOptions).not.toHaveBeenCalled();
  });

  it('keeps a named refusal’s code and status', async () => {
    mocks.listProviderOptions.mockRejectedValue(new TicketIntegrationError('provider_capability_unsupported', "provider 'x' does not declare 'chat.channels'", 409));
    const res = await post({ capability: 'chat.channels', sourceId: 's2' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'provider_capability_unsupported' });
  });

  it('answers 500 for an unexpected failure', async () => {
    mocks.listProviderOptions.mockRejectedValue(new Error('pool closed'));
    const res = await post({ capability: 'chat.channels' });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, error: 'provider_options_failed' });
  });

  it('refuses a cross-origin request before asking any provider', async () => {
    const res = await post({ capability: 'chat.channels' }, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(mocks.listProviderOptions).not.toHaveBeenCalled();
  });
});
