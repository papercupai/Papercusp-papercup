import type postgres from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalTriggerSourceRow } from '../external-triggers/source-store';
import { createProviderRegistry } from '../integrations/provider-registry';
import { installSocialPackages } from './social-provider.fixture';
import { resolveOutboundContext } from './resolve';

const mocks = vi.hoisted(() => ({ owned: vi.fn(), ready: vi.fn() }));
vi.mock('../external-triggers/source-store', () => ({
  listOwnedExternalTriggerSources: mocks.owned,
  sourceTokenHarness: () => 'fixture-install',
}));
vi.mock('../integrations/provider-registry', async (original) => ({
  ...await original<typeof import('../integrations/provider-registry')>(),
  readyProviderRegistry: mocks.ready,
}));

const sql = {} as postgres.Sql;
const params = { workspaceId: 'workspace', userId: 'owner', vaultSource: 'new-social' };
const source = (id = 'source-1', account = 'account-1') => ({
  id, kind: 'new-social', ownerUserId: 'owner', providerAccountId: account,
  credentialRef: 'host-held-ref', status: 'connected', config: {},
}) as ExternalTriggerSourceRow;

beforeEach(() => { vi.clearAllMocks(); });

describe('installed social source resolution', () => {
  it('resolves an installed provider absent from the legacy platform rows', async () => {
    const registry = createProviderRegistry();
    await installSocialPackages([{ platform: 'new-social' }], registry);
    mocks.ready.mockResolvedValue(registry);
    mocks.owned.mockResolvedValue([source()]);
    expect(await resolveOutboundContext(sql, params)).toMatchObject({ source: { id: 'source-1' }, userId: 'owner' });
    expect(mocks.owned).toHaveBeenCalledWith(sql, 'workspace', 'owner');

    registry.unregister('new-social');
    mocks.owned.mockClear();
    await expect(resolveOutboundContext(sql, params)).rejects.toThrow('outbound_source_unsupported:new-social');
    expect(mocks.owned).not.toHaveBeenCalled();
  });

  it('rejects installed providers of another datatype before source lookup', async () => {
    const registry = createProviderRegistry();
    const descriptor = { id: 'new-social', contractVersion: 1, datatypes: ['email-message'], capabilities: [], egressHosts: ['mail.example'] };
    await registry.register({ descriptor, pluginName: 'mail-only', adapter: {
      describe: () => descriptor, syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }), invoke: async () => ({}),
    } });
    mocks.ready.mockResolvedValue(registry);
    await expect(resolveOutboundContext(sql, params)).rejects.toThrow('outbound_source_unsupported:new-social');
    expect(mocks.owned).not.toHaveBeenCalled();
  });

  it('keeps exact account selection and refuses ambiguity for newly installed providers', async () => {
    const registry = createProviderRegistry();
    await installSocialPackages([{ platform: 'new-social' }], registry);
    mocks.ready.mockResolvedValue(registry);
    mocks.owned.mockResolvedValue([source(), source('source-2', 'second-account')]);
    await expect(resolveOutboundContext(sql, params)).rejects.toThrow('outbound_source_ambiguous:new-social');
    expect(await resolveOutboundContext(sql, { ...params, providerAccountId: 'SECOND-ACCOUNT' }))
      .toMatchObject({ source: { id: 'source-2' } });
    await expect(resolveOutboundContext(sql, { ...params, sourceId: 'not-owned' }))
      .rejects.toThrow('outbound_source_not_connected:new-social:not-owned');
  });

  it('preserves non-social legacy mappings without loading a social registry', async () => {
    mocks.owned.mockResolvedValue([{ ...source(), kind: 'gcal' }]);
    expect(await resolveOutboundContext(sql, { ...params, vaultSource: 'calendar' }))
      .toMatchObject({ source: { kind: 'gcal' } });
    expect(mocks.ready).not.toHaveBeenCalled();
  });

  it.each(['unload', 'replace'])('refuses an %s while the owned-source lookup is in flight', async (change) => {
    const registry = createProviderRegistry();
    await installSocialPackages([{ platform: 'new-social' }], registry);
    mocks.ready.mockResolvedValue(registry);
    mocks.owned.mockImplementationOnce(async () => {
      registry.unregister('new-social');
      if (change === 'replace') await installSocialPackages([{ platform: 'new-social' }], registry);
      return [source()];
    });
    await expect(resolveOutboundContext(sql, params)).rejects.toThrow('outbound_source_unsupported:new-social');
  });
});
