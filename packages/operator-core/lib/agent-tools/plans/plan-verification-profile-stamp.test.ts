/**
 * resolveNewPlanVerificationProfile — the profile plans:new stamps
 * (plan-verification-profiles-2026-10-17 P-002, R-4/R-5).
 *
 * The harness lookup is injected, so every branch is pinned without a harness registry.
 * The DB stamp and the plans:new wiring are pinned in
 * __tests__/new-verification-profile.integration.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { resolveNewPlanVerificationProfile } from './plan-verification-profile-stamp';

const WS = 'ws-test';

describe('resolveNewPlanVerificationProfile', () => {
  it('a declared profile wins and never consults the harness', async () => {
    const isCoding = vi.fn(async () => true);
    await expect(
      resolveNewPlanVerificationProfile({ declared: 'general', harnessSlug: 'code-harness', workspaceId: WS, isCoding }),
    ).resolves.toEqual({ profile: 'general', source: 'declared', basis: 'declared' });
    expect(isCoding).not.toHaveBeenCalled();
  });

  it('a code harness defaults to coding', async () => {
    const isCoding = vi.fn(async () => true);
    await expect(
      resolveNewPlanVerificationProfile({ harnessSlug: 'code-harness', workspaceId: WS, isCoding }),
    ).resolves.toEqual({ profile: 'coding', source: 'harness-default', basis: 'coding-harness' });
    expect(isCoding).toHaveBeenCalledWith('code-harness', WS);
  });

  it('a registered non-code harness defaults to general', async () => {
    await expect(
      resolveNewPlanVerificationProfile({ harnessSlug: 'ops-pot', workspaceId: WS, isCoding: async () => false }),
    ).resolves.toEqual({ profile: 'general', source: 'harness-default', basis: 'non-coding-harness' });
  });

  it('an unresolvable harness fails safe to coding', async () => {
    await expect(
      resolveNewPlanVerificationProfile({ harnessSlug: 'unknown', workspaceId: WS, isCoding: async () => null }),
    ).resolves.toEqual({ profile: 'coding', source: 'harness-default', basis: 'harness-unresolved' });
  });

  it('a throwing harness lookup fails safe to coding instead of failing plan creation', async () => {
    await expect(
      resolveNewPlanVerificationProfile({
        harnessSlug: 'broken',
        workspaceId: WS,
        isCoding: async () => {
          throw new Error('registry unavailable');
        },
      }),
    ).resolves.toEqual({ profile: 'coding', source: 'harness-default', basis: 'harness-unresolved' });
  });

  it.each([undefined, null, '', '  ', 'all'])('no harness (%j) defaults to coding without a lookup', async (slug) => {
    const isCoding = vi.fn(async () => false);
    await expect(
      resolveNewPlanVerificationProfile({ harnessSlug: slug as string | null | undefined, workspaceId: WS, isCoding }),
    ).resolves.toEqual({ profile: 'coding', source: 'harness-default', basis: 'no-harness' });
    expect(isCoding).not.toHaveBeenCalled();
  });
});
