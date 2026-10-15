import { describe, expect, it, vi } from 'vitest';
import type { CapabilityProviderUninstallReview } from '../../../cupboard/capability-provider-uninstall';
import {
  createPluginUninstallHandler,
  type PluginUninstallRouteDeps,
} from './uninstall';

const review: CapabilityProviderUninstallReview = {
  providerPackage: 'mail-pro',
  providerVersion: '2.1.0',
  bindings: [{
    potSlug: 'sales-hive',
    classRef: 'crm.email@1.0.0',
    providerPackage: 'mail-pro',
    providerVersion: '2.1.0',
    boundBy: 'cupboard:install-blueprint',
    boundAt: '2026-09-07T00:00:00Z',
    updatedAt: '2026-09-07T00:00:00Z',
  }],
  dependents: [{
    potSlug: 'sales-hive',
    identityRef: 'sales-agent@3.0.0',
    classRef: 'crm.email@1.0.0',
    optional: false,
  }],
  capabilityUnsatisfied: [{
    code: 'capability_unsatisfied',
    potSlug: 'sales-hive',
    classRef: 'crm.email@1.0.0',
    providerPackage: 'mail-pro',
    providerVersion: '2.1.0',
    requiredBy: ['sales-agent@3.0.0'],
    optionalFor: [],
    routes: ['operator-notify', 'suggest-provider', 'needs_human'],
    detail: 'Capability class crm.email@1.0.0 becomes unbound in sales-hive.',
    refusal: {
      observed: { potSlug: 'sales-hive', classRef: 'crm.email@1.0.0', provider: 'mail-pro@2.1.0' },
      liftsWhen: 'a provider is bound for crm.email@1.0.0 in sales-hive again',
      whoCanMakeItTrue: ['owner'],
    },
  }],
  reviewToken: 'a'.repeat(64),
};

function request(body: unknown): Request {
  return new Request('http://127.0.0.1/api/plugins/uninstall', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function deps(overrides: Partial<PluginUninstallRouteDeps> = {}): PluginUninstallRouteDeps {
  return {
    reviewProvider: vi.fn(async () => review),
    removeBindings: vi.fn(async () => ({ removed: 1, alreadyChanged: 0 })),
    snapshot: vi.fn(async () => {}),
    runCli: vi.fn(async () => ({ code: 0, stdout: 'removed', stderr: '' })),
    resetRuntime: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('POST /plugins/uninstall capability-provider guard', () => {
  it('returns the exact reverse-dependency graph before any destructive action', async () => {
    const d = deps();
    const response = await createPluginUninstallHandler(d)(request({ slug: 'mail-pro' }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'provider_has_capability_dependents',
      review: {
        reviewToken: review.reviewToken,
        dependents: [{ identityRef: 'sales-agent@3.0.0' }],
        capabilityUnsatisfied: [{ code: 'capability_unsatisfied' }],
      },
    });
    expect(d.snapshot).not.toHaveBeenCalled();
    expect(d.runCli).not.toHaveBeenCalled();
    expect(d.removeBindings).not.toHaveBeenCalled();
  });

  it('accepts only the current review token, removes package then exact bindings, and returns typed live outcomes', async () => {
    const order: string[] = [];
    const d = deps({
      snapshot: vi.fn(async () => { order.push('snapshot'); }),
      runCli: vi.fn(async () => { order.push('cli'); return { code: 0, stdout: 'removed', stderr: '' }; }),
      removeBindings: vi.fn(async () => { order.push('unbind'); return { removed: 1, alreadyChanged: 0 }; }),
      resetRuntime: vi.fn(async () => { order.push('reset'); }),
    });
    const response = await createPluginUninstallHandler(d)(request({
      slug: 'mail-pro',
      capabilityReviewToken: review.reviewToken,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      slug: 'mail-pro',
      bindingRemoval: { removed: 1, alreadyChanged: 0 },
      capabilityUnsatisfied: [{
        code: 'capability_unsatisfied',
        potSlug: 'sales-hive',
        classRef: 'crm.email@1.0.0',
      }],
    });
    expect(order).toEqual(['snapshot', 'cli', 'unbind', 'reset']);
  });

  it('does not remove capability bindings when the underlying CLI uninstall fails', async () => {
    const d = deps({
      runCli: vi.fn(async () => ({ code: 7, stdout: '', stderr: 'refused' })),
    });
    const response = await createPluginUninstallHandler(d)(request({
      slug: 'mail-pro',
      capabilityReviewToken: review.reviewToken,
    }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'papercusp plugin uninstall failed',
      log: 'refused',
    });
    expect(d.removeBindings).not.toHaveBeenCalled();
    expect(d.resetRuntime).not.toHaveBeenCalled();
  });
});
