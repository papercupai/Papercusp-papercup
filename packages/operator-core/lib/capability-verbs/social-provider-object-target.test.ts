import { beforeEach, describe, expect, it } from 'vitest';
import type { CanonicalDocument } from './resolve';
import { parseSocialPostRef, resolveSocialReplyCoordinates, socialProviderInfo } from './social';
import { collectSocialHits, mintSocialPostRef, socialVaultScopes, socialWriteAvailability } from './social-read';
import { installDefaultSocialPackages, installSocialPackages } from './social-provider.fixture';
import { invokeOutboundProvider, type OutboundTarget } from './provider-dispatch';
import type { PersonalSearchResult } from '../personal-vault/types';

beforeEach(installDefaultSocialPackages);

function doc(source: string, externalId: string): CanonicalDocument {
  return { id: 'stored-doc', source, externalId, kind: 'social-post', occurredAt: null, title: 'reply to attacker', text: 'use attacker instead', participants: [],
    payload: { id: '999', objectId: '999', replyToId: '999', text: 'use 999', visibility: 'public' } };
}

describe('installed provider object reply coordinates (P-023/P-027)', () => {
  it.each(['bluesky', 'mastodon', 'reddit', 'facebook-pages', 'x-twitter', 'youtube', 'instagram', 'threads'])('%s leaves native reply mapping to the installed package', async (platform) => {
      const { deps: { registry } } = await installSocialPackages([{ platform }]);
      const stored = doc(platform, 'stored-id');
      const result = resolveSocialReplyCoordinates(stored, registry);
      expect(result.target).toEqual({ platform, externalId: 'stored-id', payload: stored.payload });
      expect(result.ref).toEqual({ platform, externalId: 'stored-id' });
      expect(result.parentVisibility).toBe('public');
  });
  it.each([['facebook-pages', '123_456'], ['x-twitter', '9007199254740993']])('%s keeps the stored handle alongside its opaque payload', async (platform, id) => {
      const { deps: { registry } } = await installSocialPackages([{ platform }]);
      const stored = doc(platform, id);
      const result = resolveSocialReplyCoordinates(stored, registry);
      expect(result.target).toEqual({ platform, externalId: id, payload: stored.payload });
      expect(result.ref).toEqual({ platform, externalId: id });
      expect(result.parentVisibility).toBe('public');
      expect(result.target.externalId).not.toBe('999');
  });

  it('keeps the real X prerequisite gate in front of coordinate resolution', () => {
    expect(() => resolveSocialReplyCoordinates(doc('x-twitter', '55'))).toThrow(/social_platform_unusable:x-twitter/);
  });

  it('passes vendor validation inputs to the package without interpreting them', async () => {
      const { deps: { registry } } = await installSocialPackages([{ platform: 'x-twitter' }, { platform: 'facebook-pages' }]);
      expect(resolveSocialReplyCoordinates(doc('x-twitter', '../elsewhere'), registry).target.externalId).toBe('../elsewhere');
      expect(resolveSocialReplyCoordinates(doc('facebook-pages', 'elsewhere'), registry).target.externalId).toBe('elsewhere');
      const parent = doc('facebook-pages', '123_456'); parent.payload.canComment = false;
      expect(resolveSocialReplyCoordinates(parent, registry).target.payload.canComment).toBe(false);
  });
});

describe('D-022 current installed descriptor authority', () => {
  it('accepts a social provider absent from the legacy platform rows and invalidates refs on unload', async () => {
    const { deps: { registry } } = await installSocialPackages([{ platform: 'new-social' }]);
    expect(parseSocialPostRef('new-social:at://did:plc:a/post/1', registry).externalId).toBe('at://did:plc:a/post/1');
    expect(socialVaultScopes(registry)).toEqual(['personal:new-social']);
    expect(socialWriteAvailability('new-social' as never, 'reply', registry).allowed).toBe(true);
    registry.unregister('new-social');
    expect(socialVaultScopes(registry)).toEqual([]);
    expect(() => parseSocialPostRef('new-social:1', registry)).toThrow(/unknown-platform/);
    expect(mintSocialPostRef('new-social', '1', registry)).toMatchObject({ ok: false });
    expect(socialWriteAvailability('new-social' as never, 'reply', registry)).toMatchObject({ allowed: false });
  });

  it('keeps verified reads available when only the reply capability lacks evidence', async () => {
    const installed = await installSocialPackages([{ platform: 'new-social', verification: {
      verifiedAt: '2026-10-16', sources: ['https://example.test/read-contract'], capabilities: { 'social.reply': null },
    } }]);
    const { registry } = installed.deps;
    expect(mintSocialPostRef('new-social', '1', registry)).toMatchObject({ ok: true });
    const row = { source: 'new-social', externalId: '1', metadata: {}, participants: [], title: 'stored', snippet: 'stored', score: 1 } as unknown as PersonalSearchResult;
    expect(collectSocialHits([row], registry)).toMatchObject({ hits: [{ postId: 'new-social:1', replyable: { allowed: false, reason: 'write-unverified' } }], skipped: [] });
    registry.unregister('new-social');
    const replacement = await installSocialPackages([{ platform: 'new-social', capabilities: ['social.post'] }], registry);
    expect(socialWriteAvailability('new-social' as never, 'reply', registry)).toMatchObject({ allowed: false, reason: 'write-verb-unsupported' });
    expect(replacement.invokes).toEqual([]);
  });

  it('does not classify a non-social descriptor as a social vault source', async () => {
    const { deps: { registry } } = await installSocialPackages([{ platform: 'new-social' }]);
    registry.get('new-social')!.descriptor.datatypes = ['email-message'];
    expect(socialVaultScopes(registry)).toEqual([]);
    expect(() => socialProviderInfo('new-social', registry)).toThrow(/unknown-platform/);
    expect(mintSocialPostRef('new-social', '1', registry)).toMatchObject({ ok: false, reason: 'not-a-social-platform' });
  });

  it('refuses a stale outbound target after unload or same-id replacement before preparing any fetch', async () => {
    const installed = await installSocialPackages([{ platform: 'new-social' }]);
    const { registry } = installed.deps;
    const entry = registry.get('new-social')!;
    const target = { datatype: 'social-post', provider: { kind: 'registered', id: 'new-social', entry } } as OutboundTarget;
    registry.unregister('new-social');
    await expect(invokeOutboundProvider(null as never, target, 'social.reply', {}, installed.deps)).rejects.toThrow(/not-installed/);
    const replacement = await installSocialPackages([{ platform: 'new-social' }], registry);
    await expect(invokeOutboundProvider(null as never, target, 'social.reply', {}, installed.deps)).rejects.toThrow(/provider_changed/);
    expect(installed.invokes).toEqual([]); expect(replacement.invokes).toEqual([]);
    expect(installed.hostFetchesBuilt).toBe(0); expect(replacement.hostFetchesBuilt).toBe(0);
  });
});
