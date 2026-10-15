import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { HostedServiceContextRunner } from '../auth/hosted/workos-lifecycle-postgres';
import {
  HOSTED_AUTH_RUNTIME_MOUNTED_ROUTE_KEYS,
  createHostedAuthRuntime,
  readHostedAuthRuntimeConfiguration,
  type HostedAuthRuntimeConfiguration,
} from './hosted-auth-runtime';

const configuration: HostedAuthRuntimeConfiguration = {
  publicOrigin: 'https://app.papercusp.com',
  controlPlaneWorkspaceId: 'hosted-control-plane',
  hostedSessionCookieSecretRef: 'env:PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET',
  workosClientId: 'client_workos_test',
  workosApiKeyRef: 'env:WORKOS_API_KEY',
  workosCookiePasswordRef: 'env:WORKOS_COOKIE_PASSWORD',
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

describe('narrow hosted auth runtime', () => {
  it('mounts an injected tutorial token issuer behind hosted session authority without eager provider calls', async () => {
    const voiceToken = { disabled: vi.fn(), issue: vi.fn() };
    const runtime = await createHostedAuthRuntime(configuration, {
      resolveSecret: async () => 'hosted-auth-runtime-cookie-secret-more-than-32-bytes',
      runService: serviceRunner(), tutorialAssistance: { voiceToken },
    });
    expect(runtime.tutorialMounted.map(route => `${route.method} ${route.path}`))
      .toContain('POST /hosted/browser/onboarding/tutorial-voice-token');
    const response = await runtime.tutorial.request('/api/hosted/browser/onboarding/tutorial-voice-token', { method: 'POST' });
    expect(response.status).toBe(401);
    expect(voiceToken.disabled).not.toHaveBeenCalled();
    expect(voiceToken.issue).not.toHaveBeenCalled();
  });
  it('mounts only canonical auth routes and resolves only the cookie secret at boot', async () => {
    const bootOrder: string[] = [];
    const resolveSecret = vi.fn(async (reference: string) => {
      bootOrder.push(`secret:${reference}`);
      if (reference === configuration.hostedSessionCookieSecretRef) {
        return 'hosted-auth-runtime-cookie-secret-more-than-32-bytes';
      }
      throw new Error(`unexpected eager secret read: ${reference}`);
    });
    const runtime = await createHostedAuthRuntime(configuration, {
      resolveSecret,
      runService: serviceRunner('hosted_service', bootOrder),
    });

    expect(runtime.mounted.map((route) => `${route.method} ${route.path}`)).toEqual(
      HOSTED_AUTH_RUNTIME_MOUNTED_ROUTE_KEYS,
    );
    expect(bootOrder).toEqual(['service-role', `secret:${configuration.hostedSessionCookieSecretRef}`]);
    expect(resolveSecret).toHaveBeenCalledTimes(1);
    expect(runtime.tutorialMounted.map(route => `${route.method} ${route.path}`)).toEqual([
      'GET /hosted/browser/onboarding/tutorial-progress', 'POST /hosted/browser/onboarding/tutorial-progress',
      'POST /hosted/browser/onboarding/tutorial-help',
    ]);
    for (const method of ['GET', 'POST']) {
      const progress = await runtime.tutorial.request('/api/hosted/browser/onboarding/tutorial-progress?scope=account&version=3', { method });
      expect(progress.status).toBe(401);
      expect(await progress.json()).toMatchObject({ error: { message: 'session_cookie_missing' } });
    }
    expect((await runtime.tutorial.request('/api/hosted/browser/rest-query')).status).toBe(404);
    const help = await runtime.tutorial.request('/api/hosted/browser/onboarding/tutorial-help', { method: 'POST' });
    expect(help.status).toBe(401);
    expect(await help.json()).toMatchObject({ error: { message: 'session_cookie_missing' } });
    expect((await runtime.tutorial.request('/api/hosted/browser/onboarding/tutorial-help')).status).toBe(404);
    expect((await runtime.tutorial.request('/api/hosted/browser/onboarding/tutorial-speech', { method: 'POST' })).status).toBe(404);
    expect((await runtime.app.request('/api/auth/login', { method: 'POST' })).status).toBe(404);
    const session = await runtime.app.request('/api/hosted/auth/session');
    expect(session.status).toBe(401);
    expect(await session.json()).toEqual({
      error: { code: 'unauthorized', message: 'session_cookie_missing' },
    });
  });

  it('mounts configured speech behind the same session authority without eager synthesis', async () => {
    const speech = vi.fn();
    const runtime = await createHostedAuthRuntime(configuration, {
      resolveSecret: async () => 'hosted-auth-runtime-cookie-secret-more-than-32-bytes',
      runService: serviceRunner(),
      tutorialAssistance: { speech },
    });
    expect(runtime.tutorialMounted.map(route => `${route.method} ${route.path}`)).toContain(
      'POST /hosted/browser/onboarding/tutorial-speech',
    );
    const response = await runtime.tutorial.request('/api/hosted/browser/onboarding/tutorial-speech', { method: 'POST' });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { message: 'session_cookie_missing' } });
    expect(speech).not.toHaveBeenCalled();
    expect((await runtime.tutorial.request('/api/hosted/browser/onboarding/tutorial-speech')).status).toBe(404);
  });

  it('refuses boot before secrets when the service runner is not hosted_service', async () => {
    const resolveSecret = vi.fn(async () => 'must-not-resolve');
    await expect(createHostedAuthRuntime(configuration, {
      resolveSecret,
      runService: serviceRunner('harness_app'),
    })).rejects.toThrow('hosted_runtime_service_role_mismatch:harness_app');
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it('reads only auth references and fails closed on incomplete configuration', () => {
    const env = {
      PAPERCUSP_HOSTED_PUBLIC_ORIGIN: configuration.publicOrigin,
      PAPERCUSP_HOSTED_CONTROL_PLANE_WORKSPACE_ID: configuration.controlPlaneWorkspaceId,
      PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET_REF: configuration.hostedSessionCookieSecretRef,
      WORKOS_CLIENT_ID: configuration.workosClientId,
      WORKOS_API_KEY_REF: configuration.workosApiKeyRef,
      WORKOS_COOKIE_PASSWORD_REF: configuration.workosCookiePasswordRef,
    };
    expect(readHostedAuthRuntimeConfiguration(env)).toEqual(configuration);
    expect(() => readHostedAuthRuntimeConfiguration({ ...env, WORKOS_CLIENT_ID: '' })).toThrow(
      'hosted_auth_runtime_configuration_missing:WORKOS_CLIENT_ID',
    );
  });
});
