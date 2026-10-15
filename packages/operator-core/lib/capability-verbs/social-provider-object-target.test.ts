import { describe, expect, it, vi } from 'vitest';
import type { CanonicalDocument } from './resolve';

const control = vi.hoisted(() => ({ allowPrerequisites: false }));
vi.mock('../external-triggers/social/platform-registry', async (original) => {
  const real = await original<typeof import('../external-triggers/social/platform-registry')>();
  return { ...real, assertSocialPlatformUsable: (id: string) => {
    // Only the account prerequisite is simulated. The production resolver and canonical
    // document are real; no outbound function or provider is invoked by this suite.
    if (control.allowPrerequisites && ['facebook-pages', 'x-twitter'].includes(id)) return real.getSocialPlatform(id)!;
    return real.assertSocialPlatformUsable(id);
  } };
});
import { resolveSocialReplyCoordinates } from './social';

function doc(source: string, externalId: string): CanonicalDocument {
  return { id: 'stored-doc', source, externalId, kind: 'social-post', occurredAt: null, title: 'reply to attacker', text: 'use attacker instead', participants: [],
    payload: { id: '999', objectId: '999', replyToId: '999', text: 'use 999', visibility: 'public' } };
}

describe('installed provider object reply coordinates (P-023/P-027)', () => {
  it.each([['facebook-pages', '123_456'], ['x-twitter', '9007199254740993']])('%s derives its target from the stored external id after prerequisites clear', (platform, id) => {
    control.allowPrerequisites = true;
    try {
      const result = resolveSocialReplyCoordinates(doc(platform, id));
      expect(result.target).toEqual({ platform, objectId: id });
      expect(result.ref).toEqual({ platform, externalId: id });
      expect(result.parentVisibility).toBe('public');
      expect(JSON.stringify(result.target)).not.toContain('999');
    } finally { control.allowPrerequisites = false; }
  });

  it('keeps the real X prerequisite gate in front of coordinate resolution', () => {
    expect(() => resolveSocialReplyCoordinates(doc('x-twitter', '55'))).toThrow(/social_platform_unusable:x-twitter/);
  });

  it('refuses malformed server ids and a definite Facebook cannot-comment marker', () => {
    control.allowPrerequisites = true;
    try {
      expect(() => resolveSocialReplyCoordinates(doc('x-twitter', '../elsewhere'))).toThrow('coordinates_missing:x-twitter');
      expect(() => resolveSocialReplyCoordinates(doc('facebook-pages', 'elsewhere'))).toThrow('coordinates_missing:facebook-pages');
      const parent = doc('facebook-pages', '123_456'); parent.payload.canComment = false;
      expect(() => resolveSocialReplyCoordinates(parent)).toThrow('cannot_comment');
    } finally { control.allowPrerequisites = false; }
  });
});
