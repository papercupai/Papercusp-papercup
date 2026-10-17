/**
 * P-005 — social:reply.
 *
 * The properties under test are ORDERING properties, which is what makes them
 * worth a suite of their own: every gate here can be individually present and
 * the verb still be unsafe if they run in the wrong order. In particular the
 * registry write gate must fire BEFORE the provider lookup, because "a package
 * is installed" is not evidence that we know how to call the API correctly —
 * a reversed order would let an unverified write path reach the owner's real
 * public identity as soon as someone installed a package for it.
 *
 * Since provider-adapters-to-packages-2026-10-11 P-002 the write goes through
 * the installed provider package for the post's platform (`./social-provider.fixture`
 * installs fakes), so "reached the adapter" is now measured as "the package was
 * invoked".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  replyToCanonicalSocialPost,
  socialReplyIdempotencyKey,
  type SocialReplyRequest,
} from './social';
import { SocialVisibilityWidened } from './social';
import { installSocialPackages, invokedArgs } from './social-provider.fixture';
import { PROVIDER_SOCIAL_POST_CAPABILITY } from '@papercusp/plugin-sdk';

/**
 * Minimal postgres stand-in. `resolveCanonicalDocument` and
 * `listOwnedExternalTriggerSources` both issue tagged-template queries; this
 * returns a canned row set for each in call order.
 */
function fakeSql(rowSets: unknown[][]) {
  let call = 0;
  const sql: any = () => {
    const rows = rowSets[Math.min(call, rowSets.length - 1)] ?? [];
    call += 1;
    return Promise.resolve(rows);
  };
  sql.calls = () => call;
  return sql;
}

const MASTODON_DOC = {
  id: 'doc-1',
  source: 'mastodon',
  kind: 'social-post',
  externalId: '109999',
  occurredAt: '2026-08-23T00:00:00.000Z',
  participants: ['alice@mastodon.social'],
  title: '',
  text: 'parent post',
  metadata: {
    statusId: '109999',
    instanceHost: 'mastodon.social',
    visibility: 'private',
    authorHandle: 'alice',
  },
};

const OWNED_SOURCE = {
  id: 'src-1',
  workspaceId: 'ws',
  kind: 'mastodon',
  ownerUserId: 'user-1',
  credentialRef: 'cred-1',
  status: 'connected',
  config: { installSlug: 'papercusp' },
  cursor: {},
};

/** A mastodon package, installed; `seen()` is every reply request it received. */
async function mastodonInstalled() {
  const installed = await installSocialPackages([{ platform: 'mastodon' }]);
  return { installed, seen: () => invokedArgs<SocialReplyRequest>(installed) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const BASE = { workspaceId: 'ws', userId: 'user-1', agentOwnerId: null };

describe('social:reply — rail 1', () => {
  it('sends text to the server-resolved destination and echoes where it went', async () => {
    const { installed, seen } = await mastodonInstalled();
    const sql = fakeSql([[MASTODON_DOC], [OWNED_SOURCE]]);

    const result = await replyToCanonicalSocialPost(
      sql,
      { ...BASE, ref: 'mastodon:109999', text: '  thanks!  ' },
      installed.deps,
    );

    expect(seen()).toHaveLength(1);
    expect(installed.invokes[0]!.request.capability).toBe('social.reply');
    expect(installed.invokes[0]!.request.source).toBe('src-1');
    expect(seen()[0]!.target).toEqual({
      platform: 'mastodon',
      externalId: '109999',
      payload: MASTODON_DOC.metadata,
    });
    expect(seen()[0]!.text).toBe('thanks!');
    expect((seen()[0] as SocialReplyRequest & { payload: unknown }).payload).toMatchObject(MASTODON_DOC.metadata);
    expect(result.inReplyTo).toBe('mastodon:109999');
    expect(result.ref).toBe('mastodon:110000');
    expect(result.label).toBe('mastodon · 109999');
  });

  it('INHERITS the parent audience when none is requested', async () => {
    const { installed, seen } = await mastodonInstalled();
    const sql = fakeSql([[MASTODON_DOC], [OWNED_SOURCE]]);

    const result = await replyToCanonicalSocialPost(
      sql,
      { ...BASE, ref: 'mastodon:109999', text: 'ok' },
      installed.deps,
    );

    // The parent is Mastodon `private`, which is followers-only on the ladder.
    expect(seen()[0]!.visibility).toBe('followers');
    expect(result.visibility).toBe('followers');
  });

  it('REFUSES a reply that would widen the parent audience — and writes nothing', async () => {
    const { installed } = await mastodonInstalled();
    const sql = fakeSql([[MASTODON_DOC], [OWNED_SOURCE]]);

    await expect(
      replyToCanonicalSocialPost(
        sql,
        { ...BASE, ref: 'mastodon:109999', text: 'ok', visibility: 'public' },
        installed.deps,
      ),
    ).rejects.toBeInstanceOf(SocialVisibilityWidened);

    // The refusal must happen BEFORE the write, not be reported after it.
    expect(installed.invokes).toHaveLength(0);
    expect(installed.hostFetchesBuilt).toBe(0);
  });

  it('permits narrowing', async () => {
    const { installed, seen } = await mastodonInstalled();
    const sql = fakeSql([[MASTODON_DOC], [OWNED_SOURCE]]);

    await replyToCanonicalSocialPost(
      sql,
      { ...BASE, ref: 'mastodon:109999', text: 'ok', visibility: 'direct' },
      installed.deps,
    );
    expect(seen()[0]!.visibility).toBe('direct');
  });

  it('rejects empty or oversized text before touching the database', async () => {
    const sql = fakeSql([[MASTODON_DOC], [OWNED_SOURCE]]);
    await expect(
      replyToCanonicalSocialPost(sql, { ...BASE, ref: 'mastodon:109999', text: '   ' }),
    ).rejects.toThrow(/text_required/);
    await expect(
      replyToCanonicalSocialPost(sql, { ...BASE, ref: 'mastodon:109999', text: 'x'.repeat(10_001) }),
    ).rejects.toThrow(/too_long/);
    expect(sql.calls()).toBe(0);
  });

  it('rejects a package answer that is not a social write result', async () => {
    // The package is code we did not write; its result is validated against the
    // SDK contract rather than trusted into a canonical ref.
    const installed = await installSocialPackages([{ platform: 'mastodon', respond: () => ({ id: 42 }) }]);
    const sql = fakeSql([[MASTODON_DOC], [OWNED_SOURCE]]);

    await expect(
      replyToCanonicalSocialPost(sql, { ...BASE, ref: 'mastodon:109999', text: 'ok' }, installed.deps),
    ).rejects.toThrow(/^provider_result_invalid:mastodon:social\.reply:externalId must be a non-empty string$/);
  });
});

describe('social:reply — gate ORDER', () => {
  it('refuses a registry-refused platform even when a package is installed', async () => {
    // The ordering property: installing a package is never evidence that the
    // platform may be written to, so a refused platform must not reach it.
    //
    // This was asserted against Bluesky while its write path was unread. P-011
    // verified that path, so the subject moved to a platform the registry still
    // refuses (LinkedIn is `blockedOn` an owner-side app review). Note the
    // refusal now arrives from the USABILITY gate inside coordinate resolution
    // rather than the write-verified gate — earlier, not later, so the property
    // this test protects is strictly stronger, not weaker. If it ever fails, an
    // unusable platform can reach a real public identity.
    const installed = await installSocialPackages([{ platform: 'linkedin', capabilities: ['social.post', 'social.delete'] }]);
    const sql = fakeSql([
      [
        {
          ...MASTODON_DOC,
          source: 'linkedin',
          externalId: 'urn:li:share:123',
          metadata: { uri: 'urn:li:share:123' },
        },
      ],
      [{ ...OWNED_SOURCE, kind: 'linkedin' }],
    ]);

    await expect(
      replyToCanonicalSocialPost(
        sql,
        { ...BASE, ref: 'linkedin:urn:li:share:123', text: 'hello' },
        installed.deps,
      ),
      // LinkedIn is VERIFIED as of P-021, so it no longer demonstrates
      // "unverified" — it now demonstrates something sharper: a usable platform
      // whose grant covers posting but not commenting. The gate still refuses
      // before the installed package is consulted, which is what this asserts.
    ).rejects.toThrow(/social_platform_unusable:linkedin:write-verb-unsupported/);

    expect(installed.invokes, 'a refused platform must not reach its package').toHaveLength(0);
    expect(installed.hostFetchesBuilt).toBe(0);
  });

  it('now lets a Bluesky reply REACH the package — write path verified 2026-08-23 (P-011)', async () => {
    // The state change, asserted so it cannot silently regress. The strong ref
    // (uri AND cid) is what atproto requires for both parent and root, and is
    // exactly what the verified lexicon pinned.
    const installed = await installSocialPackages([{ platform: 'bluesky' }]);
    const sql = fakeSql([
      [
        {
          ...MASTODON_DOC,
          source: 'bluesky',
          externalId: 'at://did:plc:abc/app.bsky.feed.post/3k',
          metadata: { uri: 'at://did:plc:abc/app.bsky.feed.post/3k', cid: 'bafy-1' },
        },
      ],
      [{ ...OWNED_SOURCE, kind: 'bluesky' }],
    ]);

    await replyToCanonicalSocialPost(
      sql,
      { ...BASE, ref: 'bluesky:at://did:plc:abc/app.bsky.feed.post/3k', text: 'hello' },
      installed.deps,
    );

    expect(installed.invokes, 'a verified platform must now reach its package').toHaveLength(1);
    expect(installed.invokes[0]!.provider).toBe('bluesky');
  });

  it('refuses a platform with NO installed package by name, before the source lookup', async () => {
    // Mastodon is write-verified, so the only thing missing is the package.
    // That must read as "nothing installed serves mastodon", not as an
    // unverified write path or a disconnected account — those send the owner
    // to fix the wrong thing.
    const installed = await installSocialPackages([]);
    const sql = fakeSql([[MASTODON_DOC], [OWNED_SOURCE]]);

    await expect(
      replyToCanonicalSocialPost(sql, { ...BASE, ref: 'mastodon:109999', text: 'ok' }, installed.deps),
    ).rejects.toThrow(
      /social_platform_unusable:mastodon:unknown-platform.*no installed/,
    );
    // An absent package refuses before the vault or connected sources are read.
    expect(sql.calls()).toBe(0);
    expect(installed.hostFetchesBuilt).toBe(0);
  });

  it('refuses a package that does not declare social.reply, distinctly', async () => {
    const installed = await installSocialPackages([
      { platform: 'mastodon', capabilities: [PROVIDER_SOCIAL_POST_CAPABILITY] },
    ]);
    const sql = fakeSql([[MASTODON_DOC], [OWNED_SOURCE]]);

    await expect(
      replyToCanonicalSocialPost(sql, { ...BASE, ref: 'mastodon:109999', text: 'ok' }, installed.deps),
    ).rejects.toThrow(/social_platform_unusable:mastodon:write-verb-unsupported/);
    expect(installed.invokes).toHaveLength(0);
    expect(installed.hostFetchesBuilt).toBe(0);
  });

  it('never lets ANOTHER platform\'s package answer for this one', async () => {
    // The platform IS the provider id. Without that narrowing, an owner whose
    // only connected source is Reddit would have a Mastodon reply handed to the
    // Reddit package — one ambiguous-free candidate, so nothing would refuse it.
    const installed = await installSocialPackages([{ platform: 'mastodon' }, { platform: 'reddit' }]);
    const sql = fakeSql([[MASTODON_DOC], [{ ...OWNED_SOURCE, id: 'src-reddit', kind: 'reddit' }]]);

    await expect(
      replyToCanonicalSocialPost(sql, { ...BASE, ref: 'mastodon:109999', text: 'ok' }, installed.deps),
    ).rejects.toThrow(/^outbound_source_not_connected:social-post:mastodon$/);
    expect(installed.invokes).toHaveLength(0);
  });

  it('refuses an unverified platform before any credential lookup', async () => {
    const installed = await installSocialPackages([{ platform: 'unverified-social', verification: { verifiedAt: null, sources: [] } }]);
    const sql = fakeSql([[], []]);
    await expect(
      replyToCanonicalSocialPost(sql, {
        ...BASE,
        ref: 'unverified-social:123',
        text: 'ok',
      }, installed.deps),
    ).rejects.toThrow(/unverified/);
    expect(sql.calls()).toBe(0);
  });
});

describe('idempotency key', () => {
  it('is stable across retries of the same logical reply', () => {
    const ref = { platform: 'mastodon' as const, externalId: '109999' };
    expect(socialReplyIdempotencyKey(ref, 'hello')).toBe(socialReplyIdempotencyKey(ref, 'hello'));
    // Whitespace-only differences are the same logical reply.
    expect(socialReplyIdempotencyKey(ref, ' hello ')).toBe(socialReplyIdempotencyKey(ref, 'hello'));
  });

  it('differs by parent and by text', () => {
    const a = { platform: 'mastodon' as const, externalId: '1' };
    const b = { platform: 'mastodon' as const, externalId: '2' };
    expect(socialReplyIdempotencyKey(a, 'hi')).not.toBe(socialReplyIdempotencyKey(b, 'hi'));
    expect(socialReplyIdempotencyKey(a, 'hi')).not.toBe(socialReplyIdempotencyKey(a, 'ho'));
  });

  it('CONTROL: a time-seeded key would defeat its own purpose', () => {
    // Reddit documents no idempotency mechanism, so its package has nothing but
    // this key to dedupe on. Mixing in a clock makes every retry unique, which
    // IS the double-post the key exists to prevent.
    const broken = (text: string) => `${text}-${Date.now()}-${Math.random()}`;
    expect(broken('hi')).not.toBe(broken('hi'));
    const ref = { platform: 'reddit' as const, externalId: 't3_abc' };
    expect(socialReplyIdempotencyKey(ref, 'hi')).toBe(socialReplyIdempotencyKey(ref, 'hi'));
  });
});
