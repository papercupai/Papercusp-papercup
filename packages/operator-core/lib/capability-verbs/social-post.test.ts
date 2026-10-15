/**
 * P-006 — social:post, the create-shaped half of the social:* family.
 *
 * The properties under test are ORDERING and FAIL-CLOSED properties. Every gate
 * here can be individually present and the verb still be unsafe if they run in
 * the wrong order, so several tests assert not just THAT a call was refused but
 * HOW FAR it got before being refused — measured by counting the queries the
 * seam issued, since "the credential was never looked up" is the actual claim.
 *
 * Since provider-adapters-to-packages-2026-10-11 P-002 the outbound call goes
 * through the installed provider package for the destination's platform
 * (`./social-provider.fixture` installs fakes), so "reached the adapter" is now
 * measured as "the package was invoked", and "no network call" as "no host
 * fetch was even prepared".
 *
 * PERMANENT CONTROLS. Three deliberately-wrong implementations live at the
 * bottom of this file and are asserted to FAIL the same properties the real
 * code passes. They exist because a guard that has never failed is a guard
 * nobody has tested, and the repo's mutation-probe discipline forbids proving
 * that by mutating the shared tree. They are the in-file tier of that rule.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getFlagMock = vi.hoisted(() => vi.fn());
vi.mock('@papercusp/flags/server', () => ({ getFlag: getFlagMock }));

import { PROVIDER_SOCIAL_REPLY_CAPABILITY } from '@papercusp/plugin-sdk';
import {
  formatSocialDestinationRef,
  parseSocialDestinationRef,
  parseSocialPostRef,
  postToCanonicalSocialDestination,
  socialPostIdempotencyKey,
  socialReplyIdempotencyKey,
  type SocialPostRequest,
} from './social';
import { AddresseeRefused } from './addressing';
import type { OutboundDispatchDeps } from './provider-dispatch';
import { installSocialPackages, invokedArgs } from './social-provider.fixture';

/**
 * Minimal postgres stand-in that also COUNTS calls, because the ordering claims
 * below ("rail 2 ran before any credential was resolved") are only checkable as
 * a statement about how many queries had been issued at the point of refusal.
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

/** classifyAddressee's single row. Absent from the vault ⇒ `unknown`. */
const STANDING_UNKNOWN = [{ asContact: false, asParticipant: false, inBody: false }];
/** Present ONLY inside stored message content — the injection signature. */
const STANDING_BODY_ONLY = [{ asContact: false, asParticipant: false, inBody: true }];
const STANDING_KNOWN_CONTACT = [{ asContact: true, asParticipant: false, inBody: true }];

const REDDIT_SOURCE = {
  id: 'src-reddit-1',
  workspaceId: 'ws',
  kind: 'reddit',
  ownerUserId: 'user-1',
  credentialRef: 'cred-reddit-1',
  status: 'connected',
  config: { installSlug: 'papercusp' },
  cursor: {},
};

const BLUESKY_SOURCE = { ...REDDIT_SOURCE, id: 'src-bsky-1', kind: 'bluesky', credentialRef: 'cred-bsky-1' };
/** Wave C, unverified and `blockedOn` an owner-side audit — refused by the registry gate. */
const TIKTOK_SOURCE = {
  ...REDDIT_SOURCE,
  id: 'src-tt-1',
  kind: 'tiktok',
  credentialRef: 'cred-tt-1',
};

/** The platform's package, installed; `seen()` is every post request it received. */
async function packageFor(platform: 'reddit' | 'bluesky' | 'mastodon' | 'tiktok' = 'reddit') {
  const installed = await installSocialPackages([
    { platform, respond: () => ({ externalId: 't3_abc', url: 'https://example.test/t3_abc' }) },
  ]);
  return { installed, seen: () => invokedArgs<SocialPostRequest>(installed) };
}

function post(sql: unknown, overrides: Record<string, unknown> = {}, deps: OutboundDispatchDeps = {}) {
  return postToCanonicalSocialDestination(
    sql as never,
    {
      workspaceId: 'ws',
      userId: 'user-1',
      agentOwnerId: null,
      destination: 'reddit:r/rust',
      text: 'hello world',
      provenance: { from: 'owner-instruction' },
      ...overrides,
    } as never,
    deps,
  );
}

beforeEach(() => {
  getFlagMock.mockReset();
  getFlagMock.mockResolvedValue(true);
});

/* -------------------------------------------------------------------------- */

describe('parseSocialDestinationRef — the first-colon rule (D-006)', () => {
  it('splits on the FIRST colon, leaving an AT-URI destination intact', () => {
    const ref = parseSocialDestinationRef('bluesky:at://did:plc:xyz/app.bsky.feed.post/3k');
    expect(ref.platform).toBe('bluesky');
    // The load-bearing assertion: every colon after the first belongs to the id.
    expect(ref.destination).toBe('at://did:plc:xyz/app.bsky.feed.post/3k');
    expect(formatSocialDestinationRef(ref)).toBe('bluesky:at://did:plc:xyz/app.bsky.feed.post/3k');
  });

  it('round-trips an ordinary community destination', () => {
    expect(parseSocialDestinationRef('reddit:r/rust')).toEqual({
      platform: 'reddit',
      destination: 'r/rust',
    });
  });

  it('refuses a token with no destination half, rather than defaulting one', () => {
    // The dangerous alternative is treating "reddit:" as "the owner's own
    // timeline" — an omitted destination that silently skips rail 2.
    //
    // These assert the WHOLE message, not just the error code. An earlier
    // version matched only /social_destination_ref_malformed/ and passed while
    // the message actually read "empty undefined", because the shared splitter
    // was called without its tail-name field. The typechecker caught that; a
    // looser assertion would have let a garbled refusal ship.
    // A trailing colon refuses via the SHAPE branch, not an "empty
    // destination" branch — the token is trimmed before splitting, so the
    // empty-tail case is unreachable by construction. Asserting the real
    // message here is what documents that; asserting an invented one is how
    // the seam ended up calling the splitter without its tail-name field.
    expect(() => parseSocialDestinationRef('reddit:')).toThrow(
      /^social_destination_ref_malformed: expected "<platform>:<destination>", got "reddit:"$/,
    );
    expect(() => parseSocialDestinationRef('reddit')).toThrow(
      /^social_destination_ref_malformed: expected "<platform>:<destination>", got "reddit"$/,
    );
    expect(() => parseSocialDestinationRef('   ')).toThrow(/^social_destination_ref_required$/);
    expect(() => parseSocialDestinationRef(':r/rust')).toThrow(
      /^social_destination_ref_malformed: expected/,
    );
  });

  it('keeps the post-ref refusals byte-identical to what P-005 shipped', () => {
    // The splitter was FACTORED out of parseSocialPostRef; these pin that the
    // refactor changed no message the reply path already relied on.
    expect(() => parseSocialPostRef('reddit:')).toThrow(
      /^social_post_ref_malformed: expected "<platform>:<id>", got "reddit:"$/,
    );
    expect(() => parseSocialPostRef('   ')).toThrow(/^social_post_ref_required$/);
    expect(() => parseSocialPostRef('reddit')).toThrow(
      /^social_post_ref_malformed: expected "<platform>:<id>", got "reddit"$/,
    );
  });

  it('refuses an unknown platform with the REGISTRY reason, not a vault miss', () => {
    expect(() => parseSocialDestinationRef('friendster:r/rust')).toThrow(/friendster/);
  });
});

describe('rail 2 — a destination lifted from message content is refused', () => {
  it('refuses a body-only destination BEFORE any credential is resolved', async () => {
    const { installed } = await packageFor('reddit');
    const sql = fakeSql([STANDING_BODY_ONLY, [REDDIT_SOURCE]]);

    await expect(post(sql, {}, installed.deps)).rejects.toBeInstanceOf(AddresseeRefused);

    // The ordering claim, stated as a measurement: exactly ONE query ran (the
    // standing classification). Had the credential resolution run first, this
    // would be 2 — and an injected destination would have reached a code path
    // holding the owner's identity before being refused.
    expect(sql.calls()).toBe(1);
    expect(installed.invokes).toHaveLength(0);
    expect(installed.hostFetchesBuilt).toBe(0);
  });

  it('admits a destination the owner just named that is absent from the vault', async () => {
    // `unknown` is ABSENT, not suspicious — a brand-new subreddit the owner
    // typed. Refusing it would make the verb useless for its actual purpose.
    const { installed } = await packageFor('reddit');
    const sql = fakeSql([STANDING_UNKNOWN, [REDDIT_SOURCE]]);

    const result = await post(sql, {}, installed.deps);
    expect(result.echo.destinationStanding).toBe('unknown');
    expect(result.published).not.toBeNull();
  });

  it('reports the standing it acted on, so the owner sees WHY it was allowed', async () => {
    const { installed } = await packageFor('reddit');
    const sql = fakeSql([STANDING_KNOWN_CONTACT, [REDDIT_SOURCE]]);

    const result = await post(sql, {}, installed.deps);
    expect(result.echo.destinationStanding).toBe('known-contact');
    expect(result.echo.destinationProvenance).toBe('owner-instruction');
    // owner-instruction is unverifiable by construction — never claim otherwise.
    expect(result.echo.destinationVerified).toBe(false);
  });
});

describe('registry write gate — runs before the provider lookup', () => {
  it('refuses a registry-refused platform EVEN WITH a package installed', async () => {
    // The ordering claim: an installed package must never be consulted for a
    // platform the registry refuses. Installing one here is what makes the
    // claim falsifiable — if the lookup ran first, `invokes` would be non-empty.
    //
    // The subject has moved twice, for the same happy reason each time: it must
    // be a platform the registry still refuses. It was Bluesky until P-011
    // verified its write path, then LinkedIn until P-021 verified ITS posting
    // grant as self-serve. TikTok is now the standing example (unverified,
    // `blockedOn` an owner-side audit). The property is unchanged; only the
    // reason for the refusal is.
    const { installed } = await packageFor('tiktok');
    expect(installed.deps.registry.get('tiktok')).toBeDefined();
    const sql = fakeSql([STANDING_UNKNOWN, [TIKTOK_SOURCE]]);

    await expect(
      post(sql, { destination: 'tiktok:1234567890' }, installed.deps),
    ).rejects.toThrow(/social_platform_unusable:tiktok/);
    expect(installed.invokes, 'the package must not be consulted for a refused platform').toHaveLength(0);
    expect(installed.hostFetchesBuilt).toBe(0);
  });

  it('no longer refuses bluesky — its write path verified 2026-08-23 (P-011)', async () => {
    // The state change this suite must not silently absorb. If Bluesky ever
    // regresses to write-unverified, this fails loudly rather than the refusal
    // quietly returning under a test that still says "refuses bluesky".
    const { installed } = await packageFor('bluesky');
    const sql = fakeSql([STANDING_UNKNOWN, [BLUESKY_SOURCE]]);

    await post(sql, { destination: 'bluesky:at://did:plc:xyz/app.bsky.feed.post/3k' }, installed.deps);
    expect(installed.invokes, 'a verified platform must now reach its package').toHaveLength(1);
    expect(installed.invokes[0]!.provider).toBe('bluesky');
  });
});

describe('provider package — absence and a missing capability are distinct refusals (P-002)', () => {
  it('SPEC-P-002: a social write for a platform with no installed provider package is refused by name before any network call', async () => {
    // A package for ANOTHER platform is installed, so "nothing was invoked"
    // cannot pass merely because the registry is empty.
    const installed = await installSocialPackages([{ platform: 'bluesky' }]);
    const sql = fakeSql([STANDING_UNKNOWN, [REDDIT_SOURCE]]);

    await expect(post(sql, {}, installed.deps)).rejects.toThrow(
      /^outbound_source_not_connected:social-post:reddit — no installed provider package serves reddit$/,
    );
    // Only the standing classification ran: the owner's sources were never
    // listed, no package was invoked, and no provider request was prepared.
    expect(sql.calls()).toBe(1);
    expect(installed.invokes).toHaveLength(0);
    expect(installed.hostFetchesBuilt).toBe(0);
  });

  it('refuses with the publish flag OFF too — the echo never promises a post no package can make', async () => {
    getFlagMock.mockResolvedValue(false);
    const installed = await installSocialPackages([]);
    const sql = fakeSql([STANDING_UNKNOWN, [REDDIT_SOURCE]]);

    await expect(post(sql, {}, installed.deps)).rejects.toThrow(
      /^outbound_source_not_connected:social-post:reddit — no installed provider package serves reddit$/,
    );
  });

  it('distinguishes "no package" from "package cannot post"', async () => {
    const none = await installSocialPackages([]);
    await expect(post(fakeSql([STANDING_UNKNOWN, [REDDIT_SOURCE]]), {}, none.deps)).rejects.toThrow(
      /no installed provider package serves reddit/,
    );

    const replyOnly = await installSocialPackages([
      { platform: 'reddit', capabilities: [PROVIDER_SOCIAL_REPLY_CAPABILITY] },
    ]);
    // A DIFFERENT error on purpose: collapsing these would send someone to
    // install a package when the real gap is a capability the package lacks.
    await expect(post(fakeSql([STANDING_UNKNOWN, [REDDIT_SOURCE]]), {}, replyOnly.deps)).rejects.toThrow(
      /^provider_capability_unsupported:reddit:social\.post$/,
    );
    expect(replyOnly.invokes).toHaveLength(0);
    expect(replyOnly.hostFetchesBuilt).toBe(0);
  });

  it('rejects a package answer that is not a social write result', async () => {
    const installed = await installSocialPackages([
      { platform: 'reddit', respond: () => ({ externalId: 't3_abc', url: 'http://plain-http.example' }) },
    ]);
    await expect(post(fakeSql([STANDING_UNKNOWN, [REDDIT_SOURCE]]), {}, installed.deps)).rejects.toThrow(
      /^provider_result_invalid:reddit:social\.post:url, when present, must be an https URL$/,
    );
  });
});

describe('D-004(b) — the flag withholds the OUTBOUND CALL only', () => {
  it('with publishing un-ratified, returns the real resolution and sends nothing', async () => {
    getFlagMock.mockResolvedValue(false);
    const { installed } = await packageFor('reddit');
    const sql = fakeSql([STANDING_UNKNOWN, [REDDIT_SOURCE]]);

    const result = await post(sql, {}, installed.deps);

    expect(result.published).toBeNull();
    expect(result.withheld?.reason).toBe('publish-flag-off');
    expect(installed.invokes).toHaveLength(0);
    expect(installed.hostFetchesBuilt).toBe(0);

    // The echo is the whole answer in this branch, so it must be the REAL
    // resolution rather than a prediction of one: the account it names is the
    // account that would actually have spoken.
    expect(result.echo.account).toEqual({
      sourceId: 'src-reddit-1',
      kind: 'reddit',
      credentialRef: 'cred-reddit-1',
    });
    expect(result.echo.destinationRef).toBe('reddit:r/rust');
    expect(result.echo.visibility).toBe('public');
    expect(result.echo.characters).toBe('hello world'.length);
    expect(result.echo.idempotencyKey).toMatch(/^pc-social-post-/);
  });

  it('reads the flag itself rather than trusting a caller-supplied boolean', async () => {
    getFlagMock.mockResolvedValue(false);
    const { installed } = await packageFor('reddit');
    const sql = fakeSql([STANDING_UNKNOWN, [REDDIT_SOURCE]]);

    // There is deliberately NO `publish: true` parameter to pass. If one is
    // ever added, this test should be the thing that fails.
    const result = await post(sql, { publish: true, allowPublish: true, force: true }, installed.deps);
    expect(result.published).toBeNull();
    expect(installed.invokes).toHaveLength(0);
    expect(getFlagMock).toHaveBeenCalledWith('papercusp-social-auto-publish', 'social-post:ws');
  });

  it('publishes once, with a derived key, when the owner has ratified it', async () => {
    getFlagMock.mockResolvedValue(true);
    const { installed, seen } = await packageFor('reddit');
    const sql = fakeSql([STANDING_UNKNOWN, [REDDIT_SOURCE]]);

    const result = await post(sql, {}, installed.deps);

    expect(result.withheld).toBeNull();
    expect(result.published).toEqual({
      externalId: 't3_abc',
      ref: 'reddit:t3_abc',
      url: 'https://example.test/t3_abc',
      platform: 'reddit',
    });
    expect(seen()).toHaveLength(1);
    expect(installed.invokes[0]!.request.capability).toBe('social.post');
    expect(installed.invokes[0]!.request.source).toBe('src-reddit-1');
    expect(seen()[0]!.destination).toBe('r/rust');
    expect(seen()[0]!.idempotencyKey).toBe(result.echo.idempotencyKey);
  });
});

describe('visibility on a create — no parent to inherit, so no widening rail', () => {
  async function visibilityOf(value: unknown) {
    const { installed } = await packageFor('reddit');
    const sql = fakeSql([STANDING_UNKNOWN, [REDDIT_SOURCE]]);
    const result = await post(sql, { visibility: value }, installed.deps);
    return result.echo.visibility;
  }

  it('defaults an absent audience to public — "post" means public everywhere in the registry', async () => {
    expect(await visibilityOf(undefined)).toBe('public');
    expect(await visibilityOf(null)).toBe('public');
  });

  it('honours an explicit narrower audience', async () => {
    expect(await visibilityOf('followers')).toBe('followers');
    expect(await visibilityOf('direct')).toBe('direct');
  });

  it('FAILS CLOSED on a malformed audience rather than reaching the public default', async () => {
    // The bug D-006's sub-ruling records: routing through string() coerced a
    // non-string to '' and so made corrupt data indistinguishable from an
    // absent field, landing it on `public` — the one guess that can leak.
    expect(await visibilityOf(42)).toBe('direct');
    expect(await visibilityOf({})).toBe('direct');
    expect(await visibilityOf('a-future-platforms-label')).toBe('direct');
  });
});

describe('idempotency key', () => {
  const ref = { platform: 'reddit' as const, destination: 'r/rust' };

  it('is stable across retries and insensitive to surrounding whitespace', () => {
    expect(socialPostIdempotencyKey(ref, 'hi')).toBe(socialPostIdempotencyKey(ref, 'hi'));
    expect(socialPostIdempotencyKey(ref, ' hi ')).toBe(socialPostIdempotencyKey(ref, 'hi'));
  });

  it('separates different destinations and different text', () => {
    expect(socialPostIdempotencyKey(ref, 'hi')).not.toBe(
      socialPostIdempotencyKey({ ...ref, destination: 'r/go' }, 'hi'),
    );
    expect(socialPostIdempotencyKey(ref, 'hi')).not.toBe(socialPostIdempotencyKey(ref, 'ho'));
  });

  it('cannot collide with a REPLY key addressed to the same-looking token', () => {
    // Both refs render as "reddit:r/rust". A shared key space would let a
    // package deduping on it silently drop the second, genuinely different,
    // write.
    const replyKey = socialReplyIdempotencyKey({ platform: 'reddit', externalId: 'r/rust' }, 'hi');
    expect(socialPostIdempotencyKey(ref, 'hi')).not.toBe(replyKey);
  });
});

/* -------------------------------------------------------------------------- */
/* PERMANENT CONTROLS — deliberately-wrong implementations, asserted to fail.  */
/* -------------------------------------------------------------------------- */

describe('controls — each asserts the property above is FALSIFIABLE', () => {
  /** WRONG: splits on the LAST colon, the classic AT-URI truncation. */
  function lastColonSplit(raw: string) {
    const at = raw.lastIndexOf(':');
    return { platform: raw.slice(0, at), destination: raw.slice(at + 1) };
  }

  it('a last-colon split truncates an AT-URI into a plausible-looking wrong id', () => {
    const uri = 'bluesky:at://did:plc:xyz/app.bsky.feed.post/3k';
    const wrong = lastColonSplit(uri);
    expect(wrong.destination).not.toBe('at://did:plc:xyz/app.bsky.feed.post/3k');
    // And note WHY this is dangerous rather than merely broken: the truncated
    // value is still a non-empty, syntactically fine-looking id.
    expect(wrong.destination.length).toBeGreaterThan(0);
    expect(parseSocialDestinationRef(uri).destination).not.toBe(wrong.destination);
  });

  /** WRONG: treats an empty destination half as "the owner's own timeline". */
  function permissiveParse(raw: string) {
    const at = raw.indexOf(':');
    return { platform: raw.slice(0, at), destination: raw.slice(at + 1) };
  }

  it('a permissive parse admits "reddit:" — an omitted destination that skips rail 2', () => {
    expect(permissiveParse('reddit:').destination).toBe('');
    // The real parser refuses it, which is the only reason rail 2 always has
    // something to judge.
    expect(() => parseSocialDestinationRef('reddit:')).toThrow();
  });

  /** WRONG: a caller-supplied publish boolean, the fail-open shape. */
  async function callerControlledPublish(
    publish: boolean,
    send: () => Promise<string>,
  ): Promise<string | null> {
    return publish ? await send() : null;
  }

  it('a caller-supplied publish boolean publishes with the flag OFF', async () => {
    getFlagMock.mockResolvedValue(false);
    const wrong = await callerControlledPublish(true, async () => 'sent');
    expect(wrong).toBe('sent'); // the control fails the property...

    // ...while the real seam, handed the same intent, still sends nothing.
    const { installed } = await packageFor('reddit');
    const sql = fakeSql([STANDING_UNKNOWN, [REDDIT_SOURCE]]);
    const result = await post(sql, { publish: true }, installed.deps);
    expect(result.published).toBeNull();
    expect(installed.invokes).toHaveLength(0);
  });
});
