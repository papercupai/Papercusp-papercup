/** notify:send's host verb (P-005, D-034): the blog.ts outbound rails, applied to notifications. */
import type postgres from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderDescriptor, ProviderInvokeRequest } from '@papercusp/plugin-sdk';
import { createProviderRegistry } from '../integrations/provider-registry';
const mocks = vi.hoisted(() => ({ sources: vi.fn(), trust: vi.fn(), disclosure: vi.fn() }));
vi.mock('../external-triggers/source-store', async (original) => ({ ...(await original<object>()), listOwnedExternalTriggerSources: mocks.sources }));
vi.mock('./addressing', async (original) => ({ ...(await original<object>()), assertTrustedAddressee: mocks.trust }));
vi.mock('../personal-vault/disclosure-ledger', async (original) => ({ ...(await original<object>()), assertDisclosurePermits: mocks.disclosure }));
import { NOTIFY_TEXT_MAX, sendNotification } from './notify';

const sql = (async () => []) as unknown as postgres.Sql;
const channelId = '123456789012345678';
const base = { workspaceId: 'ws', userId: 'owner', providerId: 'notify-example', sourceId: 'owned-source',
  text: 'Release 0.4 is out.', idempotencyKey: 'release-0.4', provenance: { from: 'owner-instruction' } as const, agentOwnerId: 'agent' };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.sources.mockResolvedValue([{ id: 'owned-source', workspaceId: 'ws', ownerUserId: 'owner', kind: 'notify-example', status: 'active',
    credentialRef: 'provider-setup:notify-example', config: { channelId } }]);
});
async function fixture(capabilities = ['notify.send']) {
  const descriptor: ProviderDescriptor = { id: 'notify-example', contractVersion: 1, datatypes: ['notification'], sync: false,
    capabilities, egressHosts: ['notify.test'], verification: { verifiedAt: '2026-10-20', sources: ['https://notify.test/docs'],
      capabilities: Object.fromEntries(capabilities.map((c) => [c, '2026-10-20'])) } };
  const invoke = vi.fn(async (_request: ProviderInvokeRequest): Promise<Record<string, unknown>> => ({ externalId: 'm1', channelId }));
  const registry = createProviderRegistry();
  await registry.register({ descriptor, pluginName: descriptor.id, adapter: { describe: () => descriptor,
    syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }), invoke } });
  return { registry, invoke, deps: { registry, hostFetchFor: () => vi.fn() } };
}

describe('notifications through the existing outbound rails', () => {
  it('sends to the source-owned channel only after the addressee and disclosure rails pass', async () => {
    const f = await fixture();
    const result = await sendNotification(sql, base, f.deps);
    expect(result).toEqual({ status: 'sent', echo: { providerId: 'notify-example', sourceId: 'owned-source', destination: `notify-example:${channelId}` },
      result: { externalId: 'm1', channelId } });
    expect(mocks.trust).toHaveBeenCalledWith(sql, expect.objectContaining({ address: `notify-example:${channelId}`, provenance: base.provenance }));
    expect(mocks.disclosure).toHaveBeenCalledWith(sql, expect.objectContaining({ recipients: null, sink: `notify:notify-example:${channelId}`, agentOwnerId: 'agent' }));
    // The channel comes from the owner's source config, never from the caller's arguments.
    expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ source: 'owned-source', capability: 'notify.send', config: { channelId },
      args: { text: base.text, idempotencyKey: base.idempotencyKey } }), expect.anything());
    expect(mocks.trust.mock.invocationCallOrder[0]).toBeLessThan(f.invoke.mock.invocationCallOrder[0]);
    expect(mocks.disclosure.mock.invocationCallOrder[0]).toBeLessThan(f.invoke.mock.invocationCallOrder[0]);
  });

  it.each(['trust', 'disclosure'] as const)('refuses a %s failure before the provider', async (rail) => {
    const f = await fixture();
    mocks[rail].mockRejectedValueOnce(new Error('rail refused'));
    await expect(sendNotification(sql, base, f.deps)).rejects.toThrow('rail refused');
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('refuses bad input, unowned sources, provider mismatch and unsupported capabilities without invoking', async () => {
    const f = await fixture();
    for (const bad of [{ text: ' ' }, { text: 'x'.repeat(NOTIFY_TEXT_MAX + 1) }, { idempotencyKey: '' }, { idempotencyKey: 'k'.repeat(201) }, { sourceId: ' ' }]) {
      await expect(sendNotification(sql, { ...base, ...bad }, f.deps)).rejects.toThrow(/^notify_/);
    }
    await expect(sendNotification(sql, { ...base, sourceId: 'foreign' }, f.deps)).rejects.toThrow('not_connected');
    await expect(sendNotification(sql, { ...base, providerId: 'missing' }, f.deps)).rejects.toThrow('not_connected');
    const unsupported = await fixture(['community.presence']);
    await expect(sendNotification(sql, base, unsupported.deps)).rejects.toThrow('provider_capability_unsupported');
    expect(f.invoke).not.toHaveBeenCalled();
    expect(unsupported.invoke).not.toHaveBeenCalled();
    expect(mocks.trust).not.toHaveBeenCalled();
  });

  it('does not invoke an unverified or owner-blocked installed package', async () => {
    for (const verification of [undefined, { verifiedAt: '2026-10-20', sources: ['https://notify.test/docs'], capabilities: { 'notify.send': '2026-10-20' }, blockedOn: 'owner approval' }]) {
      const f = await fixture();
      f.registry.get(base.providerId)!.descriptor.verification = verification;
      await expect(sendNotification(sql, base, f.deps)).rejects.toThrow();
      expect(f.invoke).not.toHaveBeenCalled();
    }
  });

  it('keeps provider failures and results without a message id ambiguous, invoking once each', async () => {
    const f = await fixture();
    f.invoke.mockRejectedValueOnce(Object.assign(new Error('ambiguous'), { retrySafe: false }));
    await expect(sendNotification(sql, base, f.deps)).rejects.toMatchObject({ retrySafe: false });
    f.invoke.mockResolvedValueOnce({ externalId: '' });
    await expect(sendNotification(sql, base, f.deps)).rejects.toMatchObject({ message: 'notify_send_ambiguous_result_do_not_retry', retrySafe: false });
    expect(f.invoke).toHaveBeenCalledTimes(2);
  });
});
