import { describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '@papercusp/agent-mcp';
import { createHostedPrincipal } from '../../auth/hosted-principal';
import type { HostedProviderDelegationManager } from '../../workspace-host/hosted-provider-delegation';
import { createHostedProviderDelegationRoutes } from './hosted-provider-delegation';

const principal = createHostedPrincipal({
  workspaceId: 'control', userId: 'user-1', activeOrganizationId: 'org-1',
  selectedWorkspaceId: 'customer-1', sessionId: 'session-1', sessionVersion: 1,
  permissions: ['cloud-connection:manage'],
});

function context(workspaceId = 'customer-1'): RouteContext {
  return {
    principal, input: undefined, params: { workspaceId }, log: () => {},
    signal: new AbortController().signal,
  };
}

describe('hosted provider delegation routes', () => {
  it.each([0, 1, 2, 3])('refuses a foreign workspace after Response constructor replacement on route %i', async (index) => {
    const original = globalThis.Response;
    class AlternateResponse extends original {}
    vi.stubGlobal('Response', AlternateResponse);
    try {
      // Node HTTP hosts can replace Response while its inherited json factory
      // still returns the original constructor's response.
      expect(Response.json({ denied: true })).not.toBeInstanceOf(AlternateResponse);
      const factory = vi.fn();
      const route = createHostedProviderDelegationRoutes(factory)[index];
      const response = await route.handler(new Request('https://app.papercusp.com/api/hosted/workspaces/foreign/provider-delegations/verify', {
        method: 'POST', body: JSON.stringify({ connectionId: 'connection-1' }),
      }), context('foreign'));
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'workspace_binding_mismatch' } });
      expect(factory).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal('Response', original);
    }
  });

  it('binds onboarding to the authenticated selected workspace and reaches the manager', async () => {
    const onboard = vi.fn(async (input) => ({
      record: { ...input, schemaVersion: 'hosted-provider-delegation-v1', provider: 'gcp', generation: 1,
        status: 'pending', templateDigest: 'digest', createdAt: 'now', updatedAt: 'now' },
      template: { format: 'gcp-iam-json', document: {} },
    }));
    const factory = vi.fn(() => ({ onboard } as unknown as HostedProviderDelegationManager));
    const route = createHostedProviderDelegationRoutes(factory)[0];
    const response = await route.handler(new Request('https://app.papercusp.com/api/hosted/workspaces/customer-1/provider-delegations/onboard', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectionId: 'connection-1', label: 'Hosted GCP',
        credentialRef: 'delegation://customer-1/gcp/connection-1/1',
        configuration: { provider: 'gcp', source: { method: 'service-account-impersonation' } } }),
    }), context());
    expect(response.status).toBe(201);
    expect(onboard).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'customer-1', connectionId: 'connection-1',
    }));
  });

  it('fails closed on a cross-tenant route workspace before constructing a manager', async () => {
    const factory = vi.fn();
    const route = createHostedProviderDelegationRoutes(factory)[1];
    const response = await route.handler(new Request('https://app.papercusp.com/api/hosted/workspaces/foreign/provider-delegations/verify', {
      method: 'POST', body: JSON.stringify({ connectionId: 'connection-1' }),
    }), context('foreign'));
    expect(response.status).toBe(403);
    expect(factory).not.toHaveBeenCalled();
  });
});
