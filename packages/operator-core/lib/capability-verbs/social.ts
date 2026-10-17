/**
 * Provider-neutral SOCIAL capability seam (D-019 Tier 1, plan item P-004).
 *
 * WHY THIS FILE EXISTS RATHER THAN A FOURTH COPY OF mail.ts.
 *
 * `mail.ts` and `chat.ts` each resolve a CONSTANT vault source — they literally
 * hardcode `doc.source !== 'gmail'` and `vaultSource: 'gmail'` — because their
 * canonical datatype has exactly one connected provider today. `social-post`
 * does not: Bluesky, Mastodon and Reddit are simultaneously connected, and D-001
 * bounds the family at ten platforms. So for social the platform is a VARIABLE.
 *
 * Where that variable comes from is the security-relevant part, and there is
 * exactly one admissible answer: it is DERIVED FROM THE POST BEING ACTED ON.
 * It is never a caller argument. Letting a caller name the platform separately
 * from the post would hand an injected payload the choice of which of the
 * owner's identities to speak as — a strictly worse failure than a misdirected
 * reply, because the wrong ACCOUNT is not correctable by a follow-up. The ref is
 * therefore a single opaque token carrying both halves, parsed here, and the
 * platform half is used to look up the credential rather than being trusted.
 *
 * Everything below the seam (lexicon shapes, MIME, fullnames, instance hosts)
 * belongs to the adapter, exactly as threading does for mail.
 */
import type postgres from 'postgres';
import { providerSocialWriteResultIssue } from '@papercusp/plugin-sdk';
import {
  providerRegistry, readyProviderRegistry, verifiedProviderForCapability, ProviderVerificationError,
  type ProviderRegistry,
} from '../integrations/provider-registry';
import { assertDisclosurePermits } from '../personal-vault/disclosure-ledger';
import { assertTrustedAddressee, type AddresseeDecision, type AddresseeProvenance } from './addressing';
import {
  invokeOutboundProvider,
  OUTBOUND_CAPABILITIES,
  resolveCapabilitySource,
  type OutboundDispatchDeps,
  type OutboundTarget,
} from './provider-dispatch';
import { resolveCanonicalDocument, string, type CanonicalDocument, type OutboundContext } from './resolve';

/** Installed package ids are open-ended; the registry validates their syntax. */
export type SocialPlatformId = string;
export type SocialWriteVerb = 'reply' | 'post' | 'delete';

export class SocialPlatformUnusableError extends Error {
  constructor(
    readonly platformId: string,
    readonly reason: 'unknown-platform' | 'unverified' | 'owner-blocked' | 'write-unverified' | 'write-verb-unsupported',
    detail: string,
  ) {
    super(`social_platform_unusable:${platformId}:${reason}: ${detail}`);
    this.name = 'SocialPlatformUnusableError';
  }
}

/** Display and verification come from the currently installed social package. */
export interface SocialProviderInfo { id: SocialPlatformId; label: string }

export function socialProviderInfo(id: string, registry: ProviderRegistry = providerRegistry(), capability?: string): SocialProviderInfo {
  const entry = registry.get(id);
  if (!entry || !entry.descriptor.datatypes.includes('social-post')) {
    throw new SocialPlatformUnusableError(id, 'unknown-platform', 'no installed social-post provider');
  }
  try { verifiedProviderForCapability(registry, id, capability); }
  catch (error) {
    if (!(error instanceof ProviderVerificationError)) throw error;
    const reason = error.reason === 'capability-unsupported' ? 'write-verb-unsupported'
      : error.reason === 'capability-unverified' ? 'write-unverified'
      : error.reason === 'not-installed' ? 'unknown-platform' : error.reason;
    throw new SocialPlatformUnusableError(id, reason, error.message);
  }
  return { id: entry.descriptor.id as SocialPlatformId, label: entry.descriptor.displayName || entry.descriptor.id };
}

/* -------------------------------------------------------------------------- */
/* Post references                                                            */
/* -------------------------------------------------------------------------- */

/** A canonical social post: which platform, and the platform's own id for it. */
export interface SocialPostRef {
  platform: SocialPlatformId;
  externalId: string;
}

/**
 * Parse `"<platform>:<externalId>"`.
 *
 * Split on the FIRST colon only. This is load-bearing rather than stylistic:
 * an AT-URI is itself full of colons (`at://did:plc:xyz/app.bsky.feed.post/3k`),
 * so splitting on the last colon, or on every colon, silently truncates real
 * Bluesky ids into something that looks like a valid id and resolves to nothing.
 */
/**
 * The shared first-colon split, factored so the two ref kinds below cannot
 * drift apart.
 *
 * This is the same reasoning as D-006 ruling (d) applied one level down: the
 * AT-URI rule is a single fact, and two hand-maintained copies of it would fail
 * in the worst available way — a post ref that parses correctly beside a
 * destination ref that truncates, or vice versa, with both looking valid.
 */
function splitPlatformToken(
  value: string,
  codes: { required: string; malformed: string; shape: string; tailName: string },
): { platform: string; tail: string } {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error(codes.required);
  const separator = raw.indexOf(':');
  if (separator <= 0 || separator === raw.length - 1) {
    throw new Error(
      `${codes.malformed}: expected "${codes.shape}", got ${JSON.stringify(raw.slice(0, 64))}`,
    );
  }
  const platform = raw.slice(0, separator).toLowerCase();
  const tail = raw.slice(separator + 1).trim();
  // DEFENCE IN DEPTH, currently unreachable — deliberately kept, and labelled
  // so nobody mistakes it for a live guard they can test. `raw` is trimmed
  // above, so its last character is non-whitespace; combined with the
  // `separator === raw.length - 1` rejection there is always at least one
  // non-whitespace character after the colon, and `tail` cannot be empty. A
  // trailing-colon token therefore refuses via the SHAPE message above, not
  // here. This branch exists only to keep the invariant local if the trim ever
  // moves. (The same branch was already unreachable in the P-005 original this
  // was factored from.)
  if (!tail) throw new Error(`${codes.malformed}: empty ${codes.tailName}`);
  return { platform, tail };
}

export function parseSocialPostRef(ref: string, registry: ProviderRegistry = providerRegistry()): SocialPostRef {
  const { platform, tail } = splitPlatformToken(ref, {
    required: 'social_post_ref_required',
    malformed: 'social_post_ref_malformed',
    shape: '<platform>:<id>',
    tailName: 'id',
  });
  // Validate through the registry so an unknown platform fails here, with the
  // registry's reason, rather than as a confusing vault miss further down.
  socialProviderInfo(platform, registry);
  return { platform: platform as SocialPlatformId, externalId: tail };
}

export function formatSocialPostRef(ref: SocialPostRef): string {
  return `${ref.platform}:${ref.externalId}`;
}

/* -------------------------------------------------------------------------- */
/* Destination references (create-shaped)                                     */
/* -------------------------------------------------------------------------- */

/**
 * Where a NEW post goes: which platform, and that platform's own name for the
 * community/page it is addressed to.
 */
export interface SocialDestinationRef {
  platform: SocialPlatformId;
  destination: string;
}

/**
 * Parse `"<platform>:<destination>"` for a create-shaped post.
 *
 * WHY THE PLATFORM RIDES INSIDE THE TOKEN RATHER THAN BESIDE IT. A reply
 * derives its platform from the stored parent (D-006 ruling a), which a create
 * has no equivalent of — so the caller unavoidably names the destination. That
 * does NOT license re-admitting a free-standing `platform` argument: a separate
 * argument could be varied INDEPENDENTLY of the destination, which is exactly
 * the failure D-006 forbids (choosing which of the owner's identities speaks).
 * Carried inside one opaque token, the platform half cannot disagree with the
 * destination half, and rail 2 below judges the token the caller actually named.
 *
 * Splits on the FIRST colon, via the shared splitter above, for the AT-URI
 * reason recorded in D-006.
 */
export function parseSocialDestinationRef(ref: string, registry: ProviderRegistry = providerRegistry()): SocialDestinationRef {
  const { platform, tail } = splitPlatformToken(ref, {
    required: 'social_destination_ref_required',
    malformed: 'social_destination_ref_malformed',
    shape: '<platform>:<destination>',
    tailName: 'destination',
  });
  socialProviderInfo(platform, registry);
  return { platform: platform as SocialPlatformId, destination: tail };
}

export function formatSocialDestinationRef(ref: SocialDestinationRef): string {
  return `${ref.platform}:${ref.destination}`;
}

/* -------------------------------------------------------------------------- */
/* Visibility                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Provider-neutral audience ladder, ordered narrowest to widest.
 *
 * Platforms name these differently (Mastodon says `private` for followers-only;
 * Reddit has no per-post equivalent at all and inherits the subreddit's). The
 * ladder exists so the widening rail below is expressible once instead of per
 * adapter.
 */
export type SocialVisibility = 'direct' | 'followers' | 'unlisted' | 'public';

const VISIBILITY_RANK: Record<SocialVisibility, number> = {
  direct: 0,
  followers: 1,
  unlisted: 2,
  public: 3,
};

const VISIBILITY_ALIASES: Record<string, SocialVisibility> = {
  direct: 'direct',
  dm: 'direct',
  private: 'followers',
  followers: 'followers',
  'followers-only': 'followers',
  unlisted: 'unlisted',
  public: 'public',
};

/**
 * Normalize a platform-native visibility onto the neutral ladder.
 *
 * THREE distinct cases, and collapsing any two of them is a leak:
 *
 *  - ABSENT (null/undefined/blank) → `public`. The platform does not model
 *    per-post audience at all (Reddit, Bluesky today), and those posts really
 *    are public. Narrowing here would make every Reddit reply `direct`, which
 *    is not a safer reading — it is a meaningless one.
 *  - PRESENT BUT UNRECOGNIZED (a future platform's label) → `direct`. An
 *    audience we cannot interpret is not an invitation to guess, and `public`
 *    is the one guess that can leak.
 *  - MALFORMED (present but not a string at all) → `direct`. This is corrupt
 *    stored data, so it gets the narrow floor rather than the absent default.
 *
 * The middle and last cases were originally collapsed into the first by routing
 * through `string()`, which coerces a non-string to `''` and so made malformed
 * data indistinguishable from an absent field — reaching the `public` branch.
 * The control in social.test.ts caught it; that is what the controls are for.
 */
export function normalizeSocialVisibility(value: unknown): SocialVisibility {
  if (value === undefined || value === null) return 'public';
  if (typeof value !== 'string') return 'direct';
  const raw = value.trim().toLowerCase();
  if (!raw) return 'public';
  return VISIBILITY_ALIASES[raw] ?? 'direct';
}

export class SocialVisibilityWidened extends Error {
  readonly parent: SocialVisibility;
  readonly requested: SocialVisibility;
  constructor(parent: SocialVisibility, requested: SocialVisibility) {
    super(
      `social_reply_would_widen_visibility: parent is '${parent}' but the reply asked for '${requested}'. ` +
        `A reply never widens its parent's audience — re-send at '${parent}' or narrower.`,
    );
    this.name = 'SocialVisibilityWidened';
    this.parent = parent;
    this.requested = requested;
  }
}

/**
 * A reply may match its parent's audience or narrow it, never widen it.
 *
 * This rail has no equivalent in mail or chat, which is why it lives here: an
 * email reply reaches the same recipients by construction, and a Slack thread
 * reply inherits the channel. A social reply is different in kind — the parent
 * carries an independent audience setting, and replying `public` to a
 * followers-only post republishes its content, quoted, to everyone. That is a
 * disclosure the owner never authorized and cannot retract, and it is easy to
 * do by accident because `public` is every platform's default.
 */
export function resolveReplyVisibility(
  parent: SocialVisibility,
  requested?: SocialVisibility | null,
): SocialVisibility {
  if (!requested) return parent;
  if (VISIBILITY_RANK[requested] > VISIBILITY_RANK[parent]) {
    throw new SocialVisibilityWidened(parent, requested);
  }
  return requested;
}

/* -------------------------------------------------------------------------- */
/* Rail 1 — reply coordinates derived from the stored document alone          */
/* -------------------------------------------------------------------------- */

/** Stored document handle. Native reply and delete selectors belong to the package. */
export interface SocialReplyTarget {
  platform: SocialPlatformId;
  externalId: string;
  payload: Record<string, unknown>;
}
export interface SocialReplyCoordinates {
  ref: SocialPostRef;
  target: SocialReplyTarget;
  /** The PARENT's audience. The reply may match or narrow it, never widen. */
  parentVisibility: SocialVisibility;
  /** Human-readable destination, echoed back so the caller reports where it went. */
  label: string;
}

/**
 * Derive every reply coordinate from the STORED document.
 *
 * Pure, and exported for the same reason `resolveMailReplyCoordinates` is: the
 * security claim is "these values come from the vault document, never from a
 * caller argument", and a function whose only input is the document makes that
 * claim mechanically checkable instead of merely asserted.
 */
export function resolveSocialReplyCoordinates(doc: CanonicalDocument, registry: ProviderRegistry = providerRegistry()): SocialReplyCoordinates {
  const platform = doc.source as SocialPlatformId;
  const row = socialProviderInfo(platform, registry);
  return {
    ref: { platform, externalId: doc.externalId },
    target: { platform, externalId: doc.externalId, payload: doc.payload },
    parentVisibility: normalizeSocialVisibility(doc.payload.visibility),
    label: `${row.label} · ${doc.externalId}`,
  };
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

export interface ResolvedSocialPost {
  ref: SocialPostRef;
  row: SocialProviderInfo;
  doc: CanonicalDocument;
}

/**
 * Resolve a post ref to the stored document and its platform row.
 *
 * Scoped to (workspace, user) by `resolveCanonicalDocument`, so a caller cannot
 * address another principal's post by guessing an id.
 */
export async function resolveSocialPost(
  sql: postgres.Sql | postgres.TransactionSql,
  params: { workspaceId: string; userId: string; ref: string | SocialPostRef },
  deps: Pick<OutboundDispatchDeps, 'registry'> = {},
): Promise<ResolvedSocialPost> {
  const registry = deps.registry ?? await readyProviderRegistry();
  const ref = typeof params.ref === 'string' ? parseSocialPostRef(params.ref, registry) : params.ref;
  const row = socialProviderInfo(ref.platform, registry);
  const doc = await resolveCanonicalDocument(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    source: ref.platform,
    externalId: ref.externalId,
  });
  if (doc.source !== ref.platform) {
    // Defence in depth: the query already filters on source.
    throw new Error(`social_post_platform_mismatch:${ref.platform}:${doc.source}`);
  }
  return { ref, row, doc };
}

/**
 * Resolve the owner's connected source for a social write, and the installed
 * provider package that serves it (P-002).
 *
 * The registry write gate runs first, so an unverified write path is refused
 * even when a package is installed: having a package is not evidence that we
 * know how to call the platform correctly. Then provider dispatch selects the
 * source. The platform id IS the provider id, so the post ref's platform
 * narrows the pool to that provider; a platform with no installed package, or
 * a package that does not declare the capability, is refused by name before any
 * network call.
 */
export async function resolveSocialWriteTarget(
  sql: postgres.Sql,
  params: { workspaceId: string; userId: string; platform: SocialPlatformId; verb: SocialWriteVerb },
  deps: Pick<OutboundDispatchDeps, 'registry'> = {},
): Promise<{ row: SocialProviderInfo; target: OutboundTarget; capability: string }> {
  const registry = deps.registry ?? await readyProviderRegistry();
  const capability = SOCIAL_CAPABILITY_BY_VERB[params.verb];
  const row = socialProviderInfo(params.platform, registry, capability);
  const target = await resolveCapabilitySource(
    sql,
    {
      workspaceId: params.workspaceId,
      userId: params.userId,
      datatype: 'social-post',
      capabilities: [capability],
      providerId: params.platform,
    },
    { registry },
  );
  return { row, target, capability };
}

/** The provider capability each social write verb invokes. */
export const SOCIAL_CAPABILITY_BY_VERB: Record<SocialWriteVerb, string> = {
  post: OUTBOUND_CAPABILITIES.socialPost,
  reply: OUTBOUND_CAPABILITIES.socialReply,
  delete: OUTBOUND_CAPABILITIES.socialDelete,
};

/** A provider's `social.post` / `social.reply` result, validated and given its canonical ref. */
function socialWriteOutcome(
  platform: SocialPlatformId,
  target: OutboundTarget,
  capability: string,
  result: Record<string, unknown>,
): SocialReplyOutcome {
  const issue = providerSocialWriteResultIssue(result);
  if (issue) throw new Error(`provider_result_invalid:${target.provider.id}:${capability}:${issue}`);
  const externalId = string(result.externalId);
  const url = string(result.url);
  return { externalId, ref: formatSocialPostRef({ platform, externalId }), ...(url ? { url } : {}) };
}

/* -------------------------------------------------------------------------- */
/* Write adapters                                                             */
/* -------------------------------------------------------------------------- */

export interface SocialReplyRequest {
  target: SocialReplyTarget;
  text: string;
  visibility: SocialVisibility;
  /**
   * Stable key for the logical write, so an adapter on a platform with an
   * idempotency mechanism (Mastodon's Idempotency-Key) can pass it through and
   * one without (Reddit) can carry its own dedupe guard. Derived, never caller-
   * supplied — a caller-chosen key would let a retry be forced into a NEW post.
   */
  idempotencyKey: string;
}

export interface SocialReplyOutcome {
  /** Platform id of the created post. */
  externalId: string;
  /** Canonical ref for the created post, so the caller can address it later. */
  ref: string;
  url?: string;
}

/**
 * One piece of media attached to a create-shaped post.
 *
 * `url` is a PUBLICLY FETCHABLE address, not a local path or an upload handle:
 * the platforms that take media this way (Instagram's `image_url`/`video_url`)
 * fetch it themselves, server-side, rather than accepting bytes on the create
 * call.
 */
export interface SocialPostMedia {
  url: string;
  type: 'image' | 'video';
}

/** A create-shaped write: new content, at a destination the caller named. */
export interface SocialPostRequest {
  destination: string;
  text: string;
  visibility: SocialVisibility;
  /** Derived, never caller-supplied — see `socialPostIdempotencyKey`. */
  idempotencyKey: string;
  /**
   * Media to attach. OPTIONAL HERE AND REQUIRED BY SOME PLATFORMS — which is a
   * real asymmetry rather than a loose contract, and worth stating because the
   * shape of `post` quietly assumed otherwise.
   *
   * Every Wave A platform plus Facebook Pages is TEXT-PRIMARY: a post is some
   * text, and media is a decoration you may omit. Instagram is MEDIA-PRIMARY —
   * `POST /{ig-id}/media` takes `image_url` or `video_url`, and the caption is
   * the optional half. There is no text-only Instagram feed post to create, so
   * an Instagram adapter handed a text-only request cannot degrade gracefully;
   * it can only refuse.
   *
   * Optional rather than required for the same reason `lossRisk` is optional on
   * the reconcile result: a required field would strand every existing caller
   * and every text-primary adapter to encode a fact about ONE platform. The
   * asymmetry is therefore carried where it belongs — the platform that needs
   * media asserts it, and says so in its own error rather than in this type.
   */
  media?: readonly SocialPostMedia[];
}

export type SocialPostOutcome = SocialReplyOutcome;

export interface SocialWriteAdapter {
  platform: SocialPlatformId;
  /**
   * Optional for exactly the reason `post` and `delete` are, and it was NOT
   * optional until LinkedIn (P-021) falsified the assumption behind it.
   *
   * Reply is this plan's central verb, so "every social platform can reply" was
   * a natural thing to bake into the contract. LinkedIn is the counterexample:
   * its self-serve grant (`w_member_social`, the only open write permission in
   * LinkedIn's own permissions reference) posts but does not comment — the
   * Comments API declares a DIFFERENT scope, `w_member_social_feed`, which is
   * not self-serve. So LinkedIn's registry row declares `verbs: ['post',
   * 'delete']` and `assertSocialWriteAllowed` refuses 'reply' BEFORE this
   * lookup, exactly as it does for any other undeclared verb.
   *
   * Requiring `reply` here would force such a platform to ship a method that
   * can only throw, and that throw would surface as an ADAPTER defect at the
   * call site rather than as the PLATFORM limitation it actually is — the very
   * confusion the note on `post` below exists to prevent, pointed the other
   * way. The two conditions stay separately reported.
   */
  reply?(request: SocialReplyRequest, context: OutboundContext): Promise<SocialReplyOutcome>;
  /**
   * Optional on purpose. The registry already declares per-platform write verbs
   * (`write.verbs`), and `assertSocialWriteAllowed` refuses a verb a platform
   * does not support BEFORE this lookup — so a missing `post` here means "the
   * adapter has not implemented a verb its platform does declare", which is a
   * distinct and separately-reported condition from "the platform cannot post".
   * Collapsing the two would report an unimplemented adapter as a platform
   * limitation, sending someone to verify a lexicon that was never the problem.
   */
  post?(request: SocialPostRequest, context: OutboundContext): Promise<SocialPostOutcome>;
  /**
   * Optional for the same reason `post` is — a missing implementation is an
   * adapter gap, not a platform limitation, and the two are reported
   * separately.
   *
   * `deleted:false` is a FIRST-CLASS outcome, not a failure: it is how an
   * adapter says "the platform reports nothing there to delete". Delete is the
   * one verb whose retry is indistinguishable from its success — a second call
   * on an already-gone post looks exactly like a first call that worked — so an
   * adapter that cannot tell those apart must say so here rather than return a
   * success the caller will read as "I deleted it".
   */
  delete?(request: SocialDeleteRequest, context: OutboundContext): Promise<SocialDeleteOutcome>;
}

/**
 * A write adapter that is statically known to implement `reply`.
 *
 * Exists because `reply` became optional in P-021 for LinkedIn's sake, and a
 * factory returning the plain `SocialWriteAdapter` would then widen every
 * reply-implementing adapter to "might not have it" — pushing `!` assertions
 * into callers that have no doubt at all. Annotating the factory instead keeps
 * the proof where the knowledge is: an adapter that implements reply SAYS so in
 * its return type, and LinkedIn's simply does not make the claim.
 *
 * Prefer this over a non-null assertion at the call site: `!` silences the
 * checker everywhere it is written, whereas this keeps a genuinely reply-less
 * adapter a compile error if someone ever assigns one here.
 */
export type SocialReplyCapableAdapter = SocialWriteAdapter & {
  reply: NonNullable<SocialWriteAdapter['reply']>;
};

export interface SocialDeleteRequest {
  ref: SocialPostRef;
  /** Platform-native handle for the post, derived from the STORED row. */
  target: SocialReplyTarget;
  idempotencyKey: string;
}

export interface SocialDeleteOutcome {
  /** false = the platform reported nothing to delete. Never conflate with success. */
  deleted: boolean;
  detail?: string;
}

/**
 * Derive the idempotency key for a reply.
 *
 * Deliberately a function of (parent, text) and NOT of wall-clock time: the
 * whole point is that a retry of the same logical reply produces the same key.
 * A timestamp would make every retry unique, which is precisely the double-post
 * the key exists to prevent — and Reddit documents no idempotency mechanism at
 * all, so its adapter has nothing else to dedupe on.
 */
export function socialReplyIdempotencyKey(ref: SocialPostRef, text: string): string {
  let hash = 0x811c9dc5;
  for (const char of `${formatSocialPostRef(ref)}\x1f${text.trim()}`) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `pc-social-${hash.toString(16).padStart(8, '0')}`;
}

/**
 * Derive the idempotency key for a create-shaped post.
 *
 * Same (target, text) construction and the same deliberate absence of a
 * timestamp as the reply key above — a retry of the same logical write must
 * produce the same key, which a clock would defeat.
 *
 * The `-post-` infix is load-bearing rather than cosmetic. A post ref and a
 * destination ref are BOTH `"<platform>:<tail>"`, so a reply to `reddit:abc`
 * and a post addressed to `reddit:abc` carrying identical text would otherwise
 * be indistinguishable — and an adapter deduping on the key would silently drop
 * the second, genuinely different, write. The two key spaces are therefore
 * disjoint by construction, pinned by test.
 */
export function socialPostIdempotencyKey(ref: SocialDestinationRef, text: string): string {
  let hash = 0x811c9dc5;
  for (const char of `${formatSocialDestinationRef(ref)}\x1f${text.trim()}`) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `pc-social-post-${hash.toString(16).padStart(8, '0')}`;
}

export interface SocialReplyResult extends SocialReplyOutcome {
  platform: SocialPlatformId;
  /** Echoed so the caller reports WHERE it went — it never chose. */
  inReplyTo: string;
  label: string;
  visibility: SocialVisibility;
}

/**
 * `social:reply` — D-020 rail 1 for social-post.
 *
 * The caller supplies TEXT ONLY plus an opaque post ref. Destination, account,
 * credential and audience are all resolved server-side from the stored
 * document. Executes rather than drafts, per D-004: the blast radius is the
 * existing thread, it is visible, and a follow-up can correct it.
 *
 * Order of the gates matters and is not arbitrary. The registry write gate runs
 * BEFORE the provider lookup, so an unverified write path (Bluesky) is refused
 * even once its package is installed — the gate is about whether we know how
 * to call the API correctly, which having written a package does not establish.
 * The write itself goes through the installed provider package's
 * `social.reply` capability (P-002); there is no in-app adapter registry.
 */
export async function replyToCanonicalSocialPost(
  sql: postgres.Sql,
  params: {
    workspaceId: string;
    userId: string;
    ref: string | SocialPostRef;
    text: string;
    visibility?: SocialVisibility | null;
    /**
     * Reader-set labels: see `sendNewMail` in ./mail. A post's audience cannot be
     * enumerated as mailboxes, so any active disclosure refuses it.
     */
    agentOwnerId: string | null;
  },
  deps: OutboundDispatchDeps = {},
): Promise<SocialReplyResult> {
  const text = params.text.trim();
  if (!text) throw new Error('social_reply_text_required');
  if (text.length > 10_000) throw new Error('social_reply_text_too_long');

  const registry = deps.registry ?? await readyProviderRegistry();
  const { ref, doc } = await resolveSocialPost(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    ref: params.ref,
  }, { registry });
  await assertDisclosurePermits(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    agentOwnerId: params.agentOwnerId,
    recipients: null,
    sink: `${ref.platform}:reply`,
  });
  const coordinates = resolveSocialReplyCoordinates(doc, registry);
  const visibility = resolveReplyVisibility(coordinates.parentVisibility, params.visibility);

  const { target, capability } = await resolveSocialWriteTarget(
    sql,
    { workspaceId: params.workspaceId, userId: params.userId, platform: ref.platform, verb: 'reply' },
    deps,
  );

  const request: SocialReplyRequest = {
    target: coordinates.target,
    text,
    visibility,
    idempotencyKey: socialReplyIdempotencyKey(ref, text),
  };
  // Package-specific coordinates stay in the server-resolved canonical payload.
  const result = await invokeOutboundProvider(sql, target, capability, { ...request, payload: doc.payload }, deps);
  const outcome = socialWriteOutcome(ref.platform, target, capability, result);

  return {
    ...outcome,
    platform: ref.platform,
    inReplyTo: formatSocialPostRef(ref),
    label: coordinates.label,
    visibility,
  };
}

/**
 * Rail 2 for social: a create-shaped destination the CALLER named.
 *
 * `social:post` targets an audience the agent supplies (a subreddit, a page, a
 * community), which is exactly the shape D-020 rail 2 governs. A destination
 * quoted inside an inbound post's body is refused for the same reason an
 * injected email address is: it carries the body-only signature.
 */
export async function assertTrustedSocialDestination(
  sql: postgres.Sql | postgres.TransactionSql,
  params: {
    workspaceId: string;
    userId: string;
    destination: string;
    provenance: AddresseeProvenance;
  },
): Promise<AddresseeDecision> {
  const destination = string(params.destination);
  if (!destination) throw new Error('social_destination_required');
  return assertTrustedAddressee(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    address: destination,
    provenance: params.provenance,
  });
}

/* -------------------------------------------------------------------------- */
/* social:post — create-shaped publishing                                     */
/* -------------------------------------------------------------------------- */

/**
 * What the caller is told BEFORE anything goes out.
 *
 * D-004 ruling (b) requires the resolved account and audience to be echoed back
 * before publish REGARDLESS OF THE FLAG, which is why this is a first-class
 * return value rather than a log line: with publishing withheld it is the whole
 * answer, and the owner's ratification decision is made against it.
 */
export interface SocialPostEcho {
  platform: SocialPlatformId;
  destination: string;
  destinationRef: string;
  visibility: SocialVisibility;
  /** WHICH of the owner's connected accounts would speak. */
  account: { sourceId: string; kind: string; credentialRef: string | null };
  /** Rail 2's verdict on the destination the caller named. */
  destinationStanding: AddresseeDecision['standing'];
  destinationProvenance: AddresseeDecision['provenance'];
  destinationVerified: boolean;
  idempotencyKey: string;
  characters: number;
}

export interface SocialPostResult {
  echo: SocialPostEcho;
  /** null iff publishing was withheld. */
  published: (SocialPostOutcome & { platform: SocialPlatformId }) | null;
  withheld: { reason: 'publish-flag-off'; detail: string } | null;
}

/**
 * `social:post` — D-020 rail 2 for social-post, gated by D-004 ruling (b).
 *
 * The ordering below is the security content of this function; every gate can
 * be individually present and the verb still be unsafe if they run out of
 * order.
 *
 *  1. PARSE. An unknown platform fails with the registry's reason before any
 *     vault or credential work happens.
 *  2. RAIL 2, before any credential is resolved. A destination the agent could
 *     only have read out of inbound message content is refused outright — and
 *     it is refused before the owner's credential is even looked up, so an
 *     injected destination never reaches a code path holding an identity.
 *  3. REGISTRY WRITE GATE, before the adapter lookup — same reasoning as
 *     `replyToCanonicalSocialPost`: having written an adapter is not evidence
 *     that we know how to call the API correctly.
 *  4. FLAG, last. It withholds the outbound call ONLY. Everything above it has
 *     already run, so the echo the owner ratifies against is the real
 *     resolution and not a prediction of one.
 *
 * The flag is read HERE rather than at the tool boundary, deliberately. A
 * `publish: boolean` parameter would put the publish authority in the caller's
 * hands, and the next caller to be written is the one that forgets — this way
 * there is exactly one decision point and no argument that can bypass it.
 */
export async function postToCanonicalSocialDestination(
  sql: postgres.Sql,
  params: {
    workspaceId: string;
    userId: string;
    destination: string | SocialDestinationRef;
    text: string;
    visibility?: SocialVisibility | null;
    provenance: AddresseeProvenance;
    /** See `replyToCanonicalSocialPost`. */
    agentOwnerId: string | null;
  },
  deps: OutboundDispatchDeps = {},
): Promise<SocialPostResult> {
  const text = params.text.trim();
  if (!text) throw new Error('social_post_text_required');
  if (text.length > 10_000) throw new Error('social_post_text_too_long');

  const registry = deps.registry ?? await readyProviderRegistry();
  const ref =
    typeof params.destination === 'string'
      ? parseSocialDestinationRef(params.destination, registry)
      : params.destination;

  // A create has no parent to inherit from, so the widening rail (D-006 ruling
  // c) has nothing to compare against and does not apply. An absent value
  // therefore lands on `public` for the reason recorded in
  // `normalizeSocialVisibility`: these posts genuinely are public, and
  // narrowing a create to `direct` would produce a DM, which is not a safer
  // reading of "post" but a different verb. A MALFORMED value still fails
  // closed to `direct` through the same normalizer.
  const visibility =
    params.visibility === undefined || params.visibility === null
      ? 'public'
      : normalizeSocialVisibility(params.visibility);

  const decision = await assertTrustedSocialDestination(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    destination: ref.destination,
    provenance: params.provenance,
  });
  // Beside rail 2 and for the same reason: before any credential is resolved,
  // and regardless of the publish flag, so the echo never promises a post the
  // labels would refuse.
  await assertDisclosurePermits(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    agentOwnerId: params.agentOwnerId,
    recipients: null,
    sink: `${ref.platform}:${ref.destination}`,
  });

  const { target, capability } = await resolveSocialWriteTarget(
    sql,
    { workspaceId: params.workspaceId, userId: params.userId, platform: ref.platform, verb: 'post' },
    deps,
  );

  const echo: SocialPostEcho = {
    platform: ref.platform,
    destination: ref.destination,
    destinationRef: formatSocialDestinationRef(ref),
    visibility,
    account: {
      sourceId: target.source.id,
      kind: target.source.kind,
      credentialRef: target.source.credentialRef ?? null,
    },
    destinationStanding: decision.standing,
    destinationProvenance: decision.provenance,
    destinationVerified: decision.verified,
    idempotencyKey: socialPostIdempotencyKey(ref, text),
    characters: text.length,
  };

  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  const enabled = await getFlag(FLAGS.SOCIAL_AUTO_PUBLISH, `social-post:${params.workspaceId}`);
  if (!enabled) {
    return {
      echo,
      published: null,
      withheld: {
        reason: 'publish-flag-off',
        detail:
          "publishing to the owner's public identity is withheld until the owner ratifies it (flag papercusp-social-auto-publish, default OFF per D-004(b)) — everything above the outbound call ran, so this echo is the real resolution. Flip it via /admin/features.",
      },
    };
  }

  const request: SocialPostRequest = {
    destination: ref.destination,
    text,
    visibility,
    idempotencyKey: echo.idempotencyKey,
  };
  const result = await invokeOutboundProvider(sql, target, capability, { ...request }, deps);
  const outcome = socialWriteOutcome(ref.platform, target, capability, result);

  return { echo, published: { ...outcome, platform: ref.platform }, withheld: null };
}
