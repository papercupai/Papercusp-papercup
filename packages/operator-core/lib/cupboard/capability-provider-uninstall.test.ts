import { describe, expect, it, vi } from 'vitest';
import type { CapabilityProviderDependentRow } from '../capability-class-registry-store';
import {
  removeReviewedCapabilityProviderBindings,
  reviewCapabilityProviderUninstall,
  type CapabilityProviderUninstallDeps,
} from './capability-provider-uninstall';

const bindings: CapabilityProviderDependentRow[] = [
  {
    potSlug: 'sales-hive',
    classRef: 'crm.email@1.0.0',
    providerPackage: 'mail-pro',
    providerVersion: '2.1.0',
    boundBy: 'cupboard:install-blueprint',
    boundAt: '2026-09-07T00:00:00Z',
    updatedAt: '2026-09-07T00:00:00Z',
  },
  {
    potSlug: 'support-hive',
    classRef: 'crm.email@1.0.0',
    providerPackage: 'mail-pro',
    providerVersion: '2.1.0',
    boundBy: 'cupboard:install-blueprint',
    boundAt: '2026-09-07T00:00:00Z',
    updatedAt: '2026-09-07T00:00:00Z',
  },
];

function deps(overrides: Partial<CapabilityProviderUninstallDeps> = {}): CapabilityProviderUninstallDeps {
  return {
    workspaceId: () => 'ws-1',
    listInstalledProviders: async () => [{ name: 'mail-pro', version: '2.1.0' }],
    listProviderBindings: async () => bindings,
    listInstalledIdentities: async () => [
      { identityRef: 'sales-agent@3.0.0', requires: ['crm.email@1.0.0'] },
      { identityRef: 'calendar-agent@1.0.0', optional: ['crm.email@1.0.0'] },
    ],
    deleteBinding: async () => true,
    ...overrides,
  };
}

describe('capability provider uninstall review', () => {
  it('joins exact provider bindings to installed required/optional identity grants per pot', async () => {
    const review = await reviewCapabilityProviderUninstall('mail-pro', deps());

    expect(review.providerVersion).toBe('2.1.0');
    expect(review.bindings.map((row) => row.potSlug)).toEqual(['sales-hive', 'support-hive']);
    expect(review.dependents).toEqual([
      { potSlug: 'sales-hive', identityRef: 'calendar-agent@1.0.0', classRef: 'crm.email@1.0.0', optional: true },
      { potSlug: 'sales-hive', identityRef: 'sales-agent@3.0.0', classRef: 'crm.email@1.0.0', optional: false },
      { potSlug: 'support-hive', identityRef: 'calendar-agent@1.0.0', classRef: 'crm.email@1.0.0', optional: true },
      { potSlug: 'support-hive', identityRef: 'sales-agent@3.0.0', classRef: 'crm.email@1.0.0', optional: false },
    ]);
    expect(review.capabilityUnsatisfied[0]).toMatchObject({
      code: 'capability_unsatisfied',
      potSlug: 'sales-hive',
      classRef: 'crm.email@1.0.0',
      requiredBy: ['sales-agent@3.0.0'],
      optionalFor: ['calendar-agent@1.0.0'],
      routes: ['operator-notify', 'suggest-provider', 'needs_human'],
    });
    // WI-10005197: the unsatisfied record names what would LIFT it, who can do that, and what it compared.
    expect(review.capabilityUnsatisfied[0]?.refusal).toMatchObject({
      observed: {
        potSlug: 'sales-hive',
        classRef: 'crm.email@1.0.0',
        provider: 'mail-pro@2.1.0',
        requiredBy: '1',
        optionalFor: '1',
      },
      whoCanMakeItTrue: ['owner'],
    });
    expect(review.capabilityUnsatisfied[0]?.refusal.liftsWhen).toContain('crm.email@1.0.0');
    expect(review.reviewToken).toMatch(/^[0-9a-f]{64}$/);
    expect((await reviewCapabilityProviderUninstall('mail-pro', deps())).reviewToken).toBe(review.reviewToken);
  });

  it('removes only the exact provider-version bindings carried by the review receipt', async () => {
    const deleteBinding = vi.fn(async () => true);
    const d = deps({ deleteBinding });
    const review = await reviewCapabilityProviderUninstall('mail-pro', d);

    await expect(removeReviewedCapabilityProviderBindings(review, d)).resolves.toEqual({
      removed: 2,
      alreadyChanged: 0,
    });
    expect(deleteBinding).toHaveBeenCalledTimes(2);
    expect(deleteBinding).toHaveBeenNthCalledWith(1, {
      workspaceId: 'ws-1',
      potSlug: 'sales-hive',
      classId: 'crm.email',
      classVersion: '1.0.0',
      expectedProviderPackage: 'mail-pro',
      expectedProviderVersion: '2.1.0',
    });
  });

  it('refuses to invent a version when the requested provider is not installed', async () => {
    await expect(reviewCapabilityProviderUninstall(
      'missing-provider',
      deps({ listInstalledProviders: async () => [] }),
    )).rejects.toThrow(/installed provider package/);
  });
});
