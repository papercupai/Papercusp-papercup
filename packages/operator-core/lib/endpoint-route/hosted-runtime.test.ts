import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { HostedServiceContextRunner } from '../auth/hosted/workos-lifecycle-postgres';
import {
  HOSTED_RUNTIME_MOUNTED_ROUTE_KEYS,
  createHostedRuntime,
  isHostedControlPlaneDistributionProfile,
  readHostedRuntimeConfiguration,
  type HostedRuntimeConfiguration,
} from './hosted-runtime';

const configuration: HostedRuntimeConfiguration = {
  publicOrigin: 'https://app.papercusp.com',
  controlPlaneWorkspaceId: 'hosted-control-plane',
  hostedSessionCookieSecretRef: 'env:PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET',
  workosClientId: 'client_workos_test',
  workosApiKeyRef: 'env:WORKOS_API_KEY',
  workosCookiePasswordRef: 'env:WORKOS_COOKIE_PASSWORD',
  workosWebhookSecretRef: 'env:WORKOS_WEBHOOK_SECRET',
  workosWebhookSignatureKeyRef: 'workos-webhook-key-2026-08',
};

function serviceRunner(currentUser = 'hosted_service', bootOrder?: string[]): HostedServiceContextRunner {
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join(' ');
    if (!query.includes('current_user')) throw new Error(`unexpected hosted service query: ${query}`);
    return [{ current_user: currentUser }];
  }) as unknown as Sql;
  return async <T>(fn: (sql: Sql) => Promise<T>): Promise<T> => {
    bootOrder?.push('service-role');
    return fn(sql);
  };
}

describe('hosted runtime composition', () => {
  it('probes the service role, then dereferences every runtime secret ref at boot, and pins the mounted surface', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bootOrder: string[] = [];
    const resolveSecret = vi.fn(async (reference: string) => {
      bootOrder.push(`secret:${reference}`);
      if (reference === configuration.hostedSessionCookieSecretRef) {
        return 'hosted-runtime-cookie-secret-that-is-more-than-32-bytes';
      }
      if (reference === configuration.workosWebhookSecretRef) return 'whsec_runtime_test';
      if (reference === configuration.workosApiKeyRef) return 'sk_test_runtime_api_key';
      if (reference === configuration.workosCookiePasswordRef) return 'workos-cookie-password-over-32-bytes-long';
      throw new Error(`unexpected secret read: ${reference}`);
    });
    // This constructs the complete production browser/profile/stack, so
    // session-only tutorial leaves cannot pass isolated handler tests while
    // breaking the hosted deployment at startup.
    const plane = await createHostedRuntime(configuration, {
      resolveSecret,
      runService: serviceRunner('hosted_service', bootOrder),
    });

    expect(plane.mounted.map((route) => `${route.method} ${route.path}`)).toEqual(HOSTED_RUNTIME_MOUNTED_ROUTE_KEYS);
    expect(plane.components.providerDelegationManager).toBeTypeOf('function');
    const reduction = plane.mounted.find((route) => route.path.endsWith('/reduce-access'));
    expect(reduction).toMatchObject({ method: 'POST', auth: { capabilities: ['members:manage'], kind: ['user'], trust: ['verified'] } });
    // The service-role probe still precedes every secret read, and the boot
    // preflight then dereferences each ref the runtime actually uses, in order.
    expect(bootOrder.slice(0, 5)).toEqual([
      'service-role',
      `secret:${configuration.hostedSessionCookieSecretRef}`,
      `secret:${configuration.workosApiKeyRef}`,
      `secret:${configuration.workosCookiePasswordRef}`,
      `secret:${configuration.workosWebhookSecretRef}`,
    ]);
    expect(resolveSecret).toHaveBeenCalledTimes(4);
    // The optional signature key ref is a provenance LABEL, never a secret ref —
    // dereferencing it would fail a correctly configured deployment (WI-2141402).
    expect(resolveSecret).not.toHaveBeenCalledWith(configuration.workosWebhookSignatureKeyRef);

    expect((await plane.app.request('/api/health')).status).toBe(200);
    expect((await plane.app.request('/api/auth/login', { method: 'POST' })).status).toBe(404);
    expect(
      (await plane.app.request('/api/hosted/workspaces/customer-1/provider-delegations/onboard', { method: 'POST' }))
        .status,
    ).toBe(401);

    // The static hosted SPA has a deliberately separate, tenant-aware browser
    // surface.  Its routes must be mounted (and reach the hosted auth stack),
    // while the local process-global sync/workspace-host paths stay absent.
    for (const [method, path] of [
      ['GET', '/api/hosted/browser/rest-query?name=workspaceHosts.control'],
      ['GET', '/api/hosted/browser/sse'],
      ['POST', '/api/hosted/browser/workspace-hosts/connection'],
      ['POST', '/api/hosted/browser/workspace-hosts/provision'],
      ['POST', '/api/hosted/browser/workspace-hosts/action'],
      ['POST', '/api/hosted/browser/data/organization/delete'],
      ['POST', '/api/hosted/browser/data/user/delete'],
      ['GET', '/api/hosted/browser/onboarding/tutorial-progress'],
      ['POST', '/api/hosted/browser/onboarding/tutorial-progress'],
      ['POST', '/api/hosted/browser/onboarding/tutorial-help'],
      ['POST', '/api/hosted/browser/onboarding/tutorial-speech'],
    ] as const) {
      expect((await plane.app.request(path, { method })).status).toBe(401);
    }
    expect((await plane.app.request('/api/zero-harness/rest-query?name=workspaceHosts.control')).status).toBe(404);
    expect((await plane.app.request('/api/workspace-hosts/action', { method: 'POST' })).status).toBe(404);

    const webhook = await plane.app.request('/api/auth/workos/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(webhook.status).toBe(401);
    expect(resolveSecret).toHaveBeenLastCalledWith(configuration.workosWebhookSecretRef);
    expect(warning).toHaveBeenCalledWith('[auth/workos-webhook] rejected', {
      code: 'missing_signature',
      retryable: false,
    });
    warning.mockRestore();
  });

  it('refuses local Anthropic credential production at the hosted request boundary', async () => {
    const resolveSecret = vi.fn(async (reference: string) => {
      if (reference === configuration.hostedSessionCookieSecretRef) {
        return 'hosted-runtime-cookie-secret-that-is-more-than-32-bytes';
      }
      if (reference === configuration.workosWebhookSecretRef) return 'whsec_runtime_test';
      if (reference === configuration.workosApiKeyRef) return 'sk_test_runtime_api_key';
      if (reference === configuration.workosCookiePasswordRef) return 'workos-cookie-password-over-32-bytes-long';
      throw new Error(`unexpected credential source read: ${reference}`);
    });
    const plane = await createHostedRuntime(configuration, {
      resolveSecret,
      runService: serviceRunner(),
    });
    const secretReadsAtBoot = resolveSecret.mock.calls.length;

    // D-014 / R-24: these sources belong to the local operator producer. The
    // hosted customer surface must refuse before selecting, storing or returning
    // that material, including when a request claims the own-account opt-in.
    for (const claude of [
      { kind: 'operator-home-file' },
      { kind: 'integration-key', name: 'service-owned-subscription-sentinel' },
    ]) {
      const response = await plane.app.request('/api/workspace-hosts/customer-host/agent-credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          credentialRef: 'pc-agent-forward://customer-host/default',
          generation: 1,
          sources: { claude, codex: { kind: 'operator-home-file' }, omp: { kind: 'absent' } },
          allowOwnSubscriptionRelay: true,
        }),
      });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('service-owned-subscription-sentinel');
    }
    expect(resolveSecret).toHaveBeenCalledTimes(secretReadsAtBoot);
    expect((await plane.app.request('/api/health')).status).toBe(200);
    expect(plane.mounted.some((route) => route.path.includes('agent-credentials'))).toBe(false);
  });

  it('refuses boot before resolving secrets when the service runner does not enter hosted_service', async () => {
    const resolveSecret = vi.fn(async () => 'must-not-resolve');

    await expect(
      createHostedRuntime(configuration, {
        resolveSecret,
        runService: serviceRunner('harness_app'),
      }),
    ).rejects.toThrow('hosted_runtime_service_role_mismatch:harness_app');
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  // WI-2141402 / D-046: `*_REF` names being SET never meant the referenced
  // secrets existed. Before this, such a profile started clean and passed
  // /api/health while failing every real request against app.papercusp.com.
  it.each([
    ['workosApiKeyRef', 'WORKOS_API_KEY_REF'],
    ['workosCookiePasswordRef', 'WORKOS_COOKIE_PASSWORD_REF'],
    ['workosWebhookSecretRef', 'WORKOS_WEBHOOK_SECRET_REF'],
    ['hostedSessionCookieSecretRef', 'PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET_REF'],
  ] as const)('refuses to boot when %s is set but its referenced secret is absent', async (field, envName) => {
    const absent = configuration[field];
    const resolveSecret = vi.fn(async (reference: string) => {
      if (reference === absent) {
        throw new Error(`hosted_secret_ref_missing:${reference} (no value stored)`);
      }
      return 'resolved-hosted-secret-that-is-more-than-32-bytes';
    });

    await expect(
      createHostedRuntime(configuration, { resolveSecret, runService: serviceRunner('hosted_service') }),
    ).rejects.toThrow(`hosted_runtime_secret_ref_unresolved:${envName}`);
  });

  it('refuses a reference that resolves to an empty value, and never surfaces an unknown error message', async () => {
    const empty = vi.fn(async (reference: string) =>
      reference === configuration.workosApiKeyRef ? '   ' : 'resolved-hosted-secret-that-is-more-than-32-bytes',
    );
    await expect(
      createHostedRuntime(configuration, { resolveSecret: empty, runService: serviceRunner('hosted_service') }),
    ).rejects.toThrow('hosted_runtime_secret_ref_unresolved:WORKOS_API_KEY_REF');

    // An unexpected failure (a DB error whose message can embed a connection
    // string WITH its password) must collapse to a bare code, never be echoed.
    const leaky = vi.fn(async (reference: string) => {
      if (reference === configuration.workosCookiePasswordRef) {
        throw new Error('connect ECONNREFUSED postgres://user:hunter2@127.0.0.1:5432/papercusp');
      }
      return 'resolved-hosted-secret-that-is-more-than-32-bytes';
    });
    await expect(
      createHostedRuntime(configuration, { resolveSecret: leaky, runService: serviceRunner('hosted_service') }),
    ).rejects.toThrow(/^hosted_runtime_secret_ref_unresolved:WORKOS_COOKIE_PASSWORD_REF — resolution_error$/);
    await expect(
      createHostedRuntime(configuration, { resolveSecret: leaky, runService: serviceRunner('hosted_service') }),
    ).rejects.not.toThrow(/hunter2/);
  });

  it('reads only ref-bearing production configuration and refuses an incomplete profile', () => {
    const env = {
      PAPERCUSP_HOSTED_PUBLIC_ORIGIN: configuration.publicOrigin,
      PAPERCUSP_HOSTED_CONTROL_PLANE_WORKSPACE_ID: configuration.controlPlaneWorkspaceId,
      PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET_REF: configuration.hostedSessionCookieSecretRef,
      WORKOS_CLIENT_ID: configuration.workosClientId,
      WORKOS_API_KEY_REF: configuration.workosApiKeyRef,
      WORKOS_COOKIE_PASSWORD_REF: configuration.workosCookiePasswordRef,
      WORKOS_WEBHOOK_SECRET_REF: configuration.workosWebhookSecretRef,
      WORKOS_WEBHOOK_SECRET_KEY_REF: configuration.workosWebhookSignatureKeyRef,
    };
    expect(readHostedRuntimeConfiguration(env)).toEqual(configuration);
    expect(() => readHostedRuntimeConfiguration({ ...env, WORKOS_API_KEY_REF: '' })).toThrow(
      'hosted_runtime_configuration_missing:WORKOS_API_KEY_REF',
    );
  });

  it('selects the hosted branch only through the explicit distribution profile', () => {
    expect(isHostedControlPlaneDistributionProfile({ PAPERCUSP_DISTRIBUTION_PROFILE: 'hosted-control-plane' })).toBe(
      true,
    );
    expect(isHostedControlPlaneDistributionProfile({ PAPERCUSP_DISTRIBUTION_PROFILE: 'vm-release' })).toBe(false);
    expect(isHostedControlPlaneDistributionProfile({})).toBe(false);
  });
});
