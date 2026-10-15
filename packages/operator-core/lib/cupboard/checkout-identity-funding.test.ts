/**
 * agent-economy-flywheel P-016 (D-011): a per-use checkout preflight for an
 * identity release records its channel as that release's funding in the
 * workspace, so the activation gate knows which hosted channel to re-read.
 */
import { describe, expect, it } from 'vitest';
import { bindPreflightFunding, type PerUseCheckoutPreflightOk } from './commerce-door-gate-io';

function preflight(releaseRef: string): PerUseCheckoutPreflightOk {
  return {
    ok: true,
    kind: 'microcharge-preflight',
    rail: 'p2p-microcharge',
    preflightId: 'pre_1',
    channel: {
      channelId: 'ch_1',
      payer: 'org-1',
      seller: 'creator-1',
      releaseRef,
      escrowMicros: '5000000',
      committedMicros: '0',
    },
    terms: {} as PerUseCheckoutPreflightOk['terms'],
  };
}

function recorder() {
  const writes: unknown[] = [];
  return { writes, bindFunding: async (input: unknown) => { writes.push(input); } };
}

describe('bindPreflightFunding', () => {
  it('binds an identity-release preflight channel to the workspace', async () => {
    const r = recorder();
    const out = await bindPreflightFunding(preflight('identity-release:acme-reviewer@1.0.0'), {
      workspaceId: 'ws-1', actorId: 'user-1', bindFunding: r.bindFunding,
    });
    expect(out).toEqual({ ok: true, skuRef: 'identity-release:acme-reviewer@1.0.0', channelId: 'ch_1' });
    expect(r.writes).toEqual([{
      workspaceId: 'ws-1', skuRef: 'identity-release:acme-reviewer@1.0.0', channelId: 'ch_1', boundBy: 'user-1',
    }]);
  });

  it('binds an opaque installed tool SKU without changing its bytes', async () => {
    const r = recorder();
    const out = await bindPreflightFunding(preflight('plugin:acme/tool@2'), {
      workspaceId: 'ws-1', actorId: 'user-1', bindFunding: r.bindFunding,
    });
    expect(out).toEqual({ ok: true, skuRef: 'plugin:acme/tool@2', channelId: 'ch_1' });
    expect(r.writes).toEqual([{
      workspaceId: 'ws-1', skuRef: 'plugin:acme/tool@2', channelId: 'ch_1', boundBy: 'user-1',
    }]);
  });

  it.each(['', ' ', ' sku-1', 'sku-1 ', 'sku\n1', 'x'.repeat(301)])('refuses malformed hosted SKU %j before a local write', async (sku) => {
    const r = recorder();
    expect(await bindPreflightFunding(preflight(sku), { workspaceId: 'ws-1', bindFunding: r.bindFunding }))
      .toMatchObject({ ok: false, skuRef: sku, channelId: 'ch_1' });
    expect(r.writes).toEqual([]);
  });

  it('records nothing without a workspace', async () => {
    const r = recorder();
    expect(await bindPreflightFunding(preflight('identity-release:x@1.0.0'), { bindFunding: r.bindFunding })).toBeUndefined();
    expect(await bindPreflightFunding(preflight('sku-1'), { bindFunding: r.bindFunding })).toBeUndefined();
    expect(r.writes).toEqual([]);
  });

  it('reports a failed local write without failing the hosted checkout', async () => {
    const out = await bindPreflightFunding(preflight('identity-release:acme-reviewer@1.0.0'), {
      workspaceId: 'ws-1',
      bindFunding: async () => { throw new Error('relation "harness_shared.identity_release_funding" does not exist'); },
    });
    expect(out).toMatchObject({ ok: false, channelId: 'ch_1' });
    expect(out && !out.ok ? out.detail : '').toContain('identity_release_funding');
  });
});
