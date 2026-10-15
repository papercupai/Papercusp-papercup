import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getFlag: vi.fn(),
  potHomeSlugForHarness: vi.fn(),
  resolveSeedDir: vi.fn(),
  resolveLocalGithubIdentity: vi.fn(),
  recordBootEvent: vi.fn(),
}));

vi.mock('@papercusp/flags/server', () => ({ getFlag: h.getFlag }));
vi.mock('../../hive-federation', () => ({ potHomeSlugForHarness: h.potHomeSlugForHarness }));
vi.mock('./restore-hive-seed', () => ({ resolveSeedDir: h.resolveSeedDir }));
vi.mock('../../identity/resolve-local-github-identity', () => ({
  resolveLocalGithubIdentity: h.resolveLocalGithubIdentity,
}));
vi.mock('./boot-history', () => ({ recordBootEvent: h.recordBootEvent }));

import { buildHiveRekeyBootDeps } from './hive-epoch-boot-deps';

describe('buildHiveRekeyBootDeps fail-closed scope', () => {
  beforeEach(() => {
    h.getFlag.mockReset().mockResolvedValue(true);
    h.potHomeSlugForHarness.mockReset();
    h.resolveSeedDir.mockReset().mockReturnValue({ disabled: true, seedDir: null });
    h.resolveLocalGithubIdentity.mockReset().mockResolvedValue({ kind: 'missing' });
    h.recordBootEvent.mockReset();
  });

  it('keeps the explicit flag-off path plaintext-compatible', async () => {
    h.getFlag.mockResolvedValue(false);

    await expect(buildHiveRekeyBootDeps({ workspaceId: 'ws', harnessSlug: 'private' })).resolves.toBeNull();
    expect(h.potHomeSlugForHarness).not.toHaveBeenCalled();
  });

  it('returns null only when the registry definitively says the harness is not a Hive', async () => {
    h.potHomeSlugForHarness.mockResolvedValue(null);

    await expect(buildHiveRekeyBootDeps({ workspaceId: 'ws', harnessSlug: 'private' })).resolves.toBeNull();
    expect(h.resolveLocalGithubIdentity).not.toHaveBeenCalled();
  });

  it('fails closed when Hive-scope resolution is ambiguous', async () => {
    h.potHomeSlugForHarness.mockRejectedValue(new Error('registry unavailable'));

    await expect(buildHiveRekeyBootDeps({ workspaceId: 'ws', harnessSlug: 'hive' })).rejects.toThrow(
      /failed closed \(resolve Hive scope\): registry unavailable/,
    );
    // WI-6554700010008455: no Hive is confirmed when the lookup itself throws, so the
    // verdict must never name the compose step (which would send a reader after it).
    await expect(buildHiveRekeyBootDeps({ workspaceId: 'ws', harnessSlug: 'hive' })).rejects.not.toThrow(
      /compose confirmed Hive dependencies/,
    );
    expect(h.resolveLocalGithubIdentity).not.toHaveBeenCalled();
    expect(h.recordBootEvent).toHaveBeenCalledWith(
      'ws',
      'hive',
      'epoch_gate_skipped',
      expect.stringMatching(/failed closed.*registry unavailable/),
    );
  });

  it('fails closed when a confirmed Hive has neither a member identity nor a bundled key', async () => {
    h.potHomeSlugForHarness.mockResolvedValue('home-hive');

    await expect(buildHiveRekeyBootDeps({ workspaceId: 'ws', harnessSlug: 'member' })).rejects.toThrow(
      /failed closed \(compose confirmed Hive dependencies\): no epoch-key source for confirmed Hive/,
    );
    expect(h.recordBootEvent).toHaveBeenCalledWith(
      'ws',
      'member',
      'epoch_gate_skipped',
      expect.stringMatching(/failed closed.*no epoch-key source/),
    );
  });
});
