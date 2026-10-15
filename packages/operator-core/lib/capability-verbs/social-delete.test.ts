/**
 * P-008 — the non-idempotent-verb confirmation rail.
 *
 * The property under test: a delete confirmation must be obtainable ONLY by
 * having read the specific post being deleted. Everything else about delete is
 * ordinary plumbing; this is the part that has to hold.
 *
 * Permanent wrong-implementation CONTROLS live in this file, per the repo's
 * mutation-probe discipline — a guard that has never been shown to fail is not
 * a proven guard, and mutating the shared tree to prove it is unsafe here.
 */
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_SOCIAL_POST_CAPABILITY,
  PROVIDER_SOCIAL_REPLY_CAPABILITY,
} from '@papercusp/plugin-sdk';
import {
  assertDeleteConfirmed,
  deleteCanonicalSocialPost,
  DELETE_TOKEN_TEXT_WINDOW,
  socialDeleteIdempotencyKey,
  socialDeleteToken,
  SocialDeleteNotConfirmed,
} from './social-delete';
import { socialPostIdempotencyKey, socialReplyIdempotencyKey, type SocialPostRef } from './social';
import type { CanonicalDocument } from './resolve';
import type { OutboundDispatchDeps } from './provider-dispatch';
import { installSocialPackages, invokedArgs } from './social-provider.fixture';

const REF: SocialPostRef = { platform: 'reddit', externalId: 't3_abc123' };
const OTHER: SocialPostRef = { platform: 'reddit', externalId: 't3_zzz999' };

function doc(over: Partial<CanonicalDocument> = {}): CanonicalDocument {
  return {
    id: 'row-1',
    source: 'reddit',
    kind: 'social-post',
    externalId: REF.externalId,
    occurredAt: '2026-08-23T00:00:00.000Z',
    participants: ['u/owner'],
    title: 'A post',
    text: 'The original text of the post.',
    payload: {},
    ...over,
  };
}

describe('the confirmation token binds to the post, not to the caller', () => {
  it('is reproducible from the same post', () => {
    expect(socialDeleteToken(REF, 'hello')).toBe(socialDeleteToken(REF, 'hello'));
  });

  it('DIFFERS for a different post with identical text — so it cannot be replayed', () => {
    // The replay attack this rail exists to stop: confirm a harmless post, then
    // swap the ref. Identical text is the hardest case, so it is the one tested.
    expect(socialDeleteToken(REF, 'same words')).not.toBe(socialDeleteToken(OTHER, 'same words'));
  });

  it('DIFFERS when the post text changes — a stale confirmation goes stale', () => {
    expect(socialDeleteToken(REF, 'before')).not.toBe(socialDeleteToken(REF, 'after'));
  });

  it('is stable across the bounded window, so it matches what a reader was SHOWN', () => {
    // The read path displays a bounded body. If the token depended on bytes
    // beyond that window, a reader could never reproduce it for a long post.
    const head = 'x'.repeat(DELETE_TOKEN_TEXT_WINDOW);
    expect(socialDeleteToken(REF, head + 'TAIL-A')).toBe(socialDeleteToken(REF, head + 'TAIL-B'));
  });

  it('ignores surrounding whitespace, which storage and display disagree about', () => {
    expect(socialDeleteToken(REF, '  padded  ')).toBe(socialDeleteToken(REF, 'padded'));
  });

  it('lives in a key space disjoint from reply, post and delete-idempotency', () => {
    // Four FNV-1a derivations over similar subjects: distinct prefixes are what
    // keep them from colliding into each other's meaning.
    const keys = [
      socialDeleteToken(REF, 'text'),
      socialDeleteIdempotencyKey(REF),
      socialReplyIdempotencyKey(REF, 'text'),
      socialPostIdempotencyKey({ platform: 'reddit', destination: 't3_abc123' }, 'text'),
    ];
    expect(new Set(keys).size).toBe(4);
    expect(keys[0].startsWith('pc-social-del-')).toBe(true);
    expect(keys[1].startsWith('pc-social-delete-')).toBe(true);
  });
});

describe('assertDeleteConfirmed', () => {
  it('accepts the token derived from this post', () => {
    const d = doc();
    const token = socialDeleteToken(REF, d.text);
    expect(assertDeleteConfirmed(d, REF, token)).toBe(token);
  });

  it('REFUSES a missing confirmation, naming irreversibility', () => {
    const d = doc();
    for (const missing of [undefined, null, '', '   ']) {
      try {
        assertDeleteConfirmed(d, REF, missing);
        throw new Error('expected a refusal');
      } catch (err) {
        expect(err).toBeInstanceOf(SocialDeleteNotConfirmed);
        expect((err as SocialDeleteNotConfirmed).reason).toBe('confirmation-missing');
      }
    }
  });

  it('REFUSES a confirmation minted for a DIFFERENT post', () => {
    const d = doc();
    // Confirm the other post, then try to spend it here — the replay.
    const stolen = socialDeleteToken(OTHER, d.text);
    try {
      assertDeleteConfirmed(d, REF, stolen);
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(SocialDeleteNotConfirmed);
      expect((err as SocialDeleteNotConfirmed).reason).toBe('confirmation-mismatch');
    }
  });

  it('REFUSES once the post has changed since it was read', () => {
    const readAt = socialDeleteToken(REF, 'the text when it was read');
    const now = doc({ text: 'the text after it was edited' });
    expect(() => assertDeleteConfirmed(now, REF, readAt)).toThrow(SocialDeleteNotConfirmed);
  });

  it('does NOT leak the expected token on a mismatch', () => {
    // Otherwise the rail becomes a two-call oracle: guess once, read the
    // expected value out of the error, spend it on the second call — which
    // would confirm a post the caller never read.
    const d = doc();
    const expected = socialDeleteToken(REF, d.text);
    try {
      assertDeleteConfirmed(d, REF, 'pc-social-del-deadbeef');
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(SocialDeleteNotConfirmed);
      expect((err as Error).message).not.toContain(expected);
    }
  });

  it('CONTROL: a boolean confirm accepts every input the rail refuses', () => {
    // This IS the design argument, as a test. `confirm: true` authenticates
    // nothing — an injected instruction sets it exactly as easily as the owner
    // does — so it admits the replayed token, the stale token and the guess.
    const booleanRail = (confirm: boolean) => confirm === true;
    const d = doc();
    const rejected = [
      socialDeleteToken(OTHER, d.text), // replayed from another post
      socialDeleteToken(REF, 'older text'), // stale
      'pc-social-del-deadbeef', // guessed
    ];
    for (const token of rejected) {
      expect(booleanRail(true)).toBe(true);
      expect(() => assertDeleteConfirmed(d, REF, token)).toThrow(SocialDeleteNotConfirmed);
    }
  });

  it('CONTROL: echoing the postId back is not a confirmation either', () => {
    // The other tempting shape. The caller already holds the postId, so
    // re-passing it proves only that it can copy a string.
    const echoRail = (postId: string, echoed: string) => postId === echoed;
    const d = doc();
    expect(echoRail('reddit:t3_abc123', 'reddit:t3_abc123')).toBe(true);
    expect(() => assertDeleteConfirmed(d, REF, 'reddit:t3_abc123')).toThrow(SocialDeleteNotConfirmed);
  });
});

describe('deleteCanonicalSocialPost — through the installed provider package (P-002)', () => {
  /** A post the owner has, as `resolveCanonicalDocument` reads it from the vault. */
  const MASTODON_ROW = {
    id: 'doc-1',
    source: 'mastodon',
    kind: 'social-post',
    externalId: '109999',
    occurredAt: '2026-08-23T00:00:00.000Z',
    participants: ['owner@mastodon.social'],
    title: '',
    text: 'a post the owner wants gone',
    metadata: { statusId: '109999', instanceHost: 'mastodon.social', visibility: 'public', authorHandle: 'owner' },
  };
  const MASTODON_SOURCE = {
    id: 'src-mastodon-1',
    workspaceId: 'ws',
    kind: 'mastodon',
    ownerUserId: 'user-1',
    credentialRef: 'cred-mastodon-1',
    status: 'connected',
    config: { installSlug: 'papercusp' },
    cursor: {},
  };
  const MASTODON_REF: SocialPostRef = { platform: 'mastodon', externalId: '109999' };
  const CONFIRMED = socialDeleteToken(MASTODON_REF, MASTODON_ROW.text);

  /** Canned rows in call order: the vault read, then the owner's sources. Counts calls. */
  function fakeSql() {
    const rowSets: unknown[][] = [[MASTODON_ROW], [MASTODON_SOURCE]];
    let call = 0;
    const sql: any = () => {
      const rows = rowSets[Math.min(call, rowSets.length - 1)] ?? [];
      call += 1;
      return Promise.resolve(rows);
    };
    sql.calls = () => call;
    return sql;
  }

  function del(sql: unknown, confirmToken: string, deps: OutboundDispatchDeps) {
    return deleteCanonicalSocialPost(
      sql as never,
      { workspaceId: 'ws', userId: 'user-1', postId: 'mastodon:109999', confirmToken },
      deps,
    );
  }

  it('deletes through the package, handing it the resolved coordinates and a derived key', async () => {
    const installed = await installSocialPackages([{ platform: 'mastodon' }]);

    const result = await del(fakeSql(), CONFIRMED, installed.deps);

    expect(result.deleted).toBe(true);
    expect(result.echo.postId).toBe('mastodon:109999');
    expect(installed.invokes).toHaveLength(1);
    expect(installed.invokes[0]!.request.capability).toBe('social.delete');
    expect(installed.invokes[0]!.request.source).toBe('src-mastodon-1');
    const [args] = invokedArgs<{ externalId: string; target: unknown; idempotencyKey: string }>(installed);
    expect(args!.externalId).toBe('109999');
    expect(args!.target).toEqual({ platform: 'mastodon', inReplyToId: '109999', instanceHost: 'mastodon.social' });
    expect(args!.idempotencyKey).toBe(socialDeleteIdempotencyKey(MASTODON_REF));
  });

  it('refuses an unconfirmed delete before the owner\'s sources are even listed', async () => {
    const installed = await installSocialPackages([{ platform: 'mastodon' }]);
    const sql = fakeSql();

    await expect(del(sql, 'pc-social-del-deadbeef', installed.deps)).rejects.toBeInstanceOf(
      SocialDeleteNotConfirmed,
    );
    // Only the vault read ran: an unconfirmed delete never reaches a code path
    // holding the owner's identity.
    expect(sql.calls()).toBe(1);
    expect(installed.invokes).toHaveLength(0);
    expect(installed.hostFetchesBuilt).toBe(0);
  });

  it('refuses a platform with NO installed package by name, before any network call', async () => {
    // A package for another platform is installed, so "nothing was invoked"
    // cannot pass merely because the registry is empty.
    const installed = await installSocialPackages([{ platform: 'reddit' }]);
    const sql = fakeSql();

    await expect(del(sql, CONFIRMED, installed.deps)).rejects.toThrow(
      /^outbound_source_not_connected:social-post:mastodon — no installed provider package serves mastodon$/,
    );
    expect(sql.calls()).toBe(1);
    expect(installed.invokes).toHaveLength(0);
    expect(installed.hostFetchesBuilt).toBe(0);
  });

  it('refuses a package that does not declare social.delete', async () => {
    const installed = await installSocialPackages([
      { platform: 'mastodon', capabilities: [PROVIDER_SOCIAL_POST_CAPABILITY, PROVIDER_SOCIAL_REPLY_CAPABILITY] },
    ]);

    await expect(del(fakeSql(), CONFIRMED, installed.deps)).rejects.toThrow(
      /^provider_capability_unsupported:mastodon:social\.delete$/,
    );
    expect(installed.invokes).toHaveLength(0);
    expect(installed.hostFetchesBuilt).toBe(0);
  });

  it('carries deleted:false through rather than smoothing it into success', async () => {
    // "Nothing was there to delete" is a different fact from "I deleted it",
    // and only the package can tell them apart.
    const installed = await installSocialPackages([
      { platform: 'mastodon', respond: () => ({ deleted: false, detail: 'already gone' }) },
    ]);

    const result = await del(fakeSql(), CONFIRMED, installed.deps);
    expect(result.deleted).toBe(false);
    expect(result.detail).toBe('already gone');
  });

  it('rejects a package answer that is not a delete result', async () => {
    const installed = await installSocialPackages([{ platform: 'mastodon', respond: () => ({ deleted: 'yes' }) }]);

    await expect(del(fakeSql(), CONFIRMED, installed.deps)).rejects.toThrow(
      /^provider_result_invalid:mastodon:social\.delete:deleted must be a boolean$/,
    );
  });
});
