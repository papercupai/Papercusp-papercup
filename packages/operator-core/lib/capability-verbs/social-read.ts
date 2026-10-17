/**
 * The READ half of the provider-neutral social seam (P-007, D-006/D-007).
 *
 * WHY THIS EXISTS RATHER THAN "just call personal:search".
 *
 * D-007 ruling (a) made the post ref unforgeable at the PARSE end: one opaque
 * `"<platform>:<id>"` token, split on the first colon, whose platform half
 * cannot disagree with its id half. But nothing MINTED that token. The only
 * read surface, `personal:search`, returns `source` and `externalId` as two
 * SEPARATE fields (personal-vault/store.ts), so every caller wanting to reply
 * to something it found had to CONCATENATE them by hand — and `social:reply`'s
 * own guidance told it to, instructing agents to "pass the returned canonical
 * ref" that personal:search does not actually return.
 *
 * Hand-assembly is precisely where the two halves come apart: transposing them,
 * pairing one platform with another platform's id, or carrying a stale platform
 * across a loop iteration all produce a token that PARSES cleanly and addresses
 * the wrong thing. Guarding the parse while every real caller hand-builds the
 * input is a rail bolted to the wrong end of the bridge.
 *
 * So this file mints. Every ref an agent receives is built server-side from the
 * same row its id came from, and verified by round-trip before it is emitted
 * (`mintSocialPostRef`). A ref that cannot round-trip is never handed out.
 *
 * Contract evidence and each write capability are checked independently against
 * the installed descriptor. A readable provider can therefore report that replying
 * is unverified or unsupported without hiding the stored post.
 */
import type postgres from 'postgres';
import { personalScope, searchPersonalDocuments } from '../personal-vault/store';
import type { PersonalSearchResult } from '../personal-vault/types';
import { providerRegistry, readyProviderRegistry, type ProviderRegistry } from '../integrations/provider-registry';
import {
  SocialPlatformUnusableError,
  type SocialPlatformId,
  type SocialWriteVerb,
  formatSocialPostRef,
  normalizeSocialVisibility,
  parseSocialPostRef,
  resolveSocialPost,
  socialProviderInfo,
  SOCIAL_CAPABILITY_BY_VERB,
  type SocialProviderInfo,
  type SocialPostRef,
  type SocialVisibility,
} from './social';
import type { DocumentLabel } from '../personal-vault/disclosure-labels';
import { discloseDocuments } from '../personal-vault/disclosure-ledger';
import { socialDeleteToken } from './social-delete';
import { string, type CanonicalDocument } from './resolve';

/** Longest post body returned by `social:read`. Posts are short; this is a fence, not a budget. */
const READ_TEXT_LIMIT = 8_000;

/* -------------------------------------------------------------------------- */
/* Scope selection                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Every vault scope that holds social posts, DERIVED from the registry.
 *
 * Writing the ten ids out would be a second copy of a truth the registry owns,
 * and the drift is silent: a platform added to the registry would simply never
 * appear in search results, which reads as "the owner has no posts there".
 */
export function socialVaultScopes(registry: ProviderRegistry = providerRegistry()): string[] {
  return registry.forDatatype('social-post').map((entry) => personalScope(entry.descriptor.id));
}

/**
 * Narrow the owner's GRANTED scopes to the social ones.
 *
 * THIS IS THE LOAD-BEARING STEP, and both of the obvious shortcuts are wrong —
 * each verified against `authorizePersonalAccess` before this was written:
 *
 *  - Requesting NO scopes and searching whatever comes back: the authorizer
 *    returns `requested.length ? requested : granted`, and the store applies NO
 *    scope filter for an empty array. `social:search` would then span Gmail,
 *    Calendar and Contacts, and mint "social post refs" pointing at EMAILS.
 *  - Requesting all ten platform scopes up front: an owner who granted only
 *    Bluesky gets `scope_not_granted` — a HARD REFUSAL of the whole call, not a
 *    narrowing. The verb would be unusable under every partial grant, which is
 *    the normal case.
 *
 * So: take what was granted, intersect locally, and let an empty intersection be
 * an explicit named refusal. Never fall through to an unscoped search.
 */
export function selectGrantedSocialScopes(granted: readonly string[], registry: ProviderRegistry = providerRegistry()): string[] {
  const social = new Set(socialVaultScopes(registry));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of granted) {
    let scope: string;
    try {
      scope = personalScope(raw);
    } catch {
      // A malformed grant row is not this code's to repair, and skipping it is
      // the safe direction: it can only ever narrow what we search.
      continue;
    }
    if (!social.has(scope) || seen.has(scope)) continue;
    seen.add(scope);
    out.push(scope);
  }
  return out.sort();
}

/** The platform id a social vault scope names (`personal:bluesky` → `bluesky`). */
export function platformIdForScope(scope: string, registry: ProviderRegistry = providerRegistry()): SocialPlatformId | null {
  const id = scope.startsWith('personal:') ? scope.slice('personal:'.length) : scope;
  return registry.get(id)?.descriptor.datatypes.includes('social-post') ? (id as SocialPlatformId) : null;
}

/* -------------------------------------------------------------------------- */
/* Minting                                                                    */
/* -------------------------------------------------------------------------- */

export type MintRefusal =
  | 'not-a-social-platform'
  | 'external-id-missing'
  | 'ref-does-not-round-trip'
  | 'platform-unusable';

export type MintOutcome =
  | { ok: true; postId: string; ref: SocialPostRef }
  | { ok: false; reason: MintRefusal; detail: string };

/**
 * Mint a canonical post ref from a stored row, or refuse with a reason.
 *
 * SELF-CHECKING BY CONSTRUCTION: the minted token is parsed back and compared
 * to its inputs, so the only refs that escape this function are ones the seam's
 * own parser agrees address exactly the row they were built from. That closes
 * the loop rather than asserting it — a formatter and a parser that drift apart
 * is the failure mode D-007 ruling (a) was written about, and a round-trip is
 * the one check that cannot be fooled by both copies drifting the same way.
 *
 * It also catches the quiet cases a length check would miss: an id with leading
 * whitespace (the parser trims, so it would address a DIFFERENT post), and a
 * vault row whose source is `gmail` (which would mint a plausible-looking ref
 * for something that is not a post at all).
 */
export function mintSocialPostRef(source: string, externalId: string | null, registry: ProviderRegistry = providerRegistry()): MintOutcome {
  const platform = string(source).toLowerCase();
  const row = registry.get(platform)?.descriptor.datatypes.includes('social-post');
  if (!row) {
    return {
      ok: false,
      reason: 'not-a-social-platform',
      detail: `vault source ${JSON.stringify(platform.slice(0, 32))} is not a social platform`,
    };
  }
  const id = typeof externalId === 'string' ? externalId : '';
  if (!id.trim()) {
    return {
      ok: false,
      reason: 'external-id-missing',
      detail: `${platform} row has no external_id, so it cannot be addressed`,
    };
  }
  const candidate: SocialPostRef = { platform: platform as SocialPlatformId, externalId: id };
  const postId = formatSocialPostRef(candidate);
  let parsed: SocialPostRef;
  try {
    parsed = parseSocialPostRef(postId, registry);
  } catch (err) {
    // An unverified/owner-blocked platform refuses here, via the registry's own
    // reason — the same refusal `social:reply` would give, surfaced at mint time
    // instead of after the agent has drafted a reply it cannot send.
    return {
      ok: false,
      reason: err instanceof SocialPlatformUnusableError ? 'platform-unusable' : 'ref-does-not-round-trip',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (parsed.platform !== candidate.platform || parsed.externalId !== candidate.externalId) {
    return {
      ok: false,
      reason: 'ref-does-not-round-trip',
      detail: `minted ${JSON.stringify(postId.slice(0, 64))} parses back as ${JSON.stringify(
        `${parsed.platform}:${parsed.externalId}`.slice(0, 64),
      )}`,
    };
  }
  return { ok: true, postId, ref: parsed };
}

/* -------------------------------------------------------------------------- */
/* Reply availability                                                         */
/* -------------------------------------------------------------------------- */

export interface SocialWriteAvailability {
  allowed: boolean;
  reason?: SocialPlatformUnusableError['reason'];
  detail?: string;
}

/**
 * Whether `social:reply` would be accepted for this platform, WITHOUT throwing.
 *
 * Delegates to `assertSocialWriteAllowed` rather than re-deriving the rule, so
 * a read result can never advertise a reply the write path would refuse. Told
 * at read time, this saves an agent from drafting text for a post it cannot
 * answer — a Wave B platform reads nothing and refuses every write, and any
 * platform whose read path verifies before its write path refuses writes while
 * still returning posts.
 *
 * (Bluesky was that second case until 2026-08-23, when its write path was
 * verified; it is no longer an example of a refusal.)
 */
export function socialWriteAvailability(
  platform: SocialPlatformId,
  verb: SocialWriteVerb = 'reply',
  registry: ProviderRegistry = providerRegistry(),
): SocialWriteAvailability {
  try {
    socialProviderInfo(platform, registry, SOCIAL_CAPABILITY_BY_VERB[verb]);
    return { allowed: true };
  } catch (err) {
    if (err instanceof SocialPlatformUnusableError) {
      return { allowed: false, reason: err.reason, detail: err.message };
    }
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Views                                                                      */
/* -------------------------------------------------------------------------- */

export interface SocialPostView {
  /** Minted + round-trip verified. Pass straight to `social:reply`; never rebuild it. */
  postId: string;
  platform: SocialPlatformId;
  platformLabel: string;
  author: string;
  occurredAt: string | null;
  title: string;
  text: string;
  url: string;
  visibility: SocialVisibility;
  /** Whether `social:reply` would be accepted, resolved from the same rule the write path uses. */
  replyable: SocialWriteAvailability;
  /**
   * The confirmation `social:delete` requires for THIS post (P-008).
   *
   * Handed out here, and only here, because that is what makes it mean
   * something: it is derived from the post's own text, so producing it requires
   * having read the post. Delete is irreversible and its retry is
   * indistinguishable from its success, so the rail has to be more than a
   * boolean the caller sets — see social-delete.ts.
   *
   * ⚠ NAMED to match `social:delete`'s ARG exactly (P-010). It was `deleteToken`
   * here while the consumer took `confirmToken`, and social:delete's own guidance
   * told the agent to pass "the confirmToken that social:read returns" — a field
   * that did not exist under that name. The agent's whole job with this value is
   * to move it from this result into that arg, so a rename on either side
   * reintroduces the trap; `social-guidance-routes.test.ts` pins the two names
   * together.
   */
  confirmToken: string;
}

function authorOf(payload: Record<string, unknown>, participants: readonly string[]): string {
  return string(payload.authorHandle) || string(payload.author) || string(participants[0]) || '';
}

function viewFromDocument(doc: CanonicalDocument, row: SocialProviderInfo, postId: string, registry: ProviderRegistry): SocialPostView {
  const text = doc.text.length > READ_TEXT_LIMIT ? `${doc.text.slice(0, READ_TEXT_LIMIT)}…` : doc.text;
  return {
    postId,
    platform: row.id,
    platformLabel: row.label,
    author: authorOf(doc.payload, doc.participants),
    occurredAt: doc.occurredAt,
    title: doc.title,
    text,
    url: string(doc.payload.url),
    visibility: normalizeSocialVisibility(doc.payload.visibility),
    replyable: socialWriteAvailability(row.id, 'reply', registry),
    // Computed from the FULL stored text, not the bounded `text` above: the
    // token must be reproducible at delete time from the row, and the delete
    // path bounds it identically rather than trusting what was displayed.
    confirmToken: socialDeleteToken({ platform: row.id, externalId: doc.externalId }, doc.text),
  };
}

/* -------------------------------------------------------------------------- */
/* social:read                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Read ONE stored post by its canonical ref.
 *
 * Scoped to (workspace, user) by `resolveCanonicalDocument`, so a caller cannot
 * read another principal's post by guessing an id — the same fence the reply
 * path stands behind, which is why this reuses `resolveSocialPost` rather than
 * issuing its own query.
 */
export async function readSocialPost(
  sql: postgres.Sql | postgres.TransactionSql,
  params: { workspaceId: string; userId: string; postId: string; agentOwnerId: string | null },
  deps: { registry?: ProviderRegistry } = {},
): Promise<SocialPostView & { privacy: DocumentLabel | null }> {
  const registry = deps.registry ?? await readyProviderRegistry();
  const resolved = await resolveSocialPost(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    ref: params.postId,
  }, { registry });
  // Re-mint from the STORED row rather than echoing the caller's token, so the
  // ref we hand back is anchored to what was actually found.
  const minted = mintSocialPostRef(resolved.doc.source, resolved.doc.externalId, registry);
  if (!minted.ok) throw new Error(`social_read_ref_unmintable:${minted.reason}: ${minted.detail}`);
  // Reader-set labels (P-008): the post reaches the agent only with its
  // disclosure row, exactly as a personal:search result does.
  const disclosed = await discloseDocuments(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    agentOwnerId: params.agentOwnerId,
    documents: [{ id: resolved.doc.id, source: resolved.doc.source, participants: resolved.doc.participants, metadata: resolved.doc.payload }],
    via: 'social:read',
  });
  if (disclosed.withheld) throw new Error('social_read_withheld: restricted post and no attributable agent identity');
  const current = socialProviderInfo(resolved.doc.source, registry);
  return { ...viewFromDocument(resolved.doc, current, minted.postId, registry), privacy: disclosed.documents[0]?.privacy ?? null };
}

/* -------------------------------------------------------------------------- */
/* social:search                                                              */
/* -------------------------------------------------------------------------- */

export interface SocialSearchHit {
  postId: string;
  platform: SocialPlatformId;
  platformLabel: string;
  author: string;
  occurredAt: string | null;
  title: string;
  snippet: string;
  score: number;
  replyable: SocialWriteAvailability;
}

export interface SocialSearchOutcome {
  /** Exactly the scopes searched — the intersection, never the caller's request. */
  scopesSearched: string[];
  hits: SocialSearchHit[];
  /**
   * Rows found but NOT returned because no ref could be minted, counted by
   * reason. Reported rather than silently dropped: a search that quietly
   * discards matches is indistinguishable from one that found nothing, and the
   * difference matters when an agent concludes the owner never posted about it.
   */
  skipped: Array<{ reason: MintRefusal; count: number }>;
}

export class SocialSearchNotGranted extends Error {
  readonly grantedScopes: string[];
  constructor(grantedScopes: string[]) {
    super(
      'social_search_no_social_scope: the live grant covers no social platform, so there is nothing this verb may read',
    );
    this.name = 'SocialSearchNotGranted';
    this.grantedScopes = grantedScopes;
  }
}

/**
 * Search the owner's vault, restricted to social sources, minting a usable ref
 * for every hit.
 *
 * Reuses `searchPersonalDocuments` (hybrid lexical + vector, participant and
 * time filters, grant-scoped) rather than forking a second query: the scoping
 * this verb needs is expressible as a scope list the store already accepts, so
 * a parallel implementation would buy nothing and drift.
 */
export async function searchSocialPosts(
  sql: postgres.Sql | postgres.TransactionSql,
  params: {
    workspaceId: string;
    userId: string;
    query: string;
    grantedScopes: readonly string[];
    platforms?: readonly string[];
    participants?: readonly string[];
    timeRange?: { from?: string; to?: string };
    limit?: number;
    queryEmbedding?: number[] | null;
  },
  deps: { registry?: ProviderRegistry } = {},
): Promise<SocialSearchOutcome> {
  const registry = deps.registry ?? await readyProviderRegistry();
  const grantedSocial = selectGrantedSocialScopes(params.grantedScopes, registry);
  if (!grantedSocial.length) throw new SocialSearchNotGranted([...params.grantedScopes]);

  // An explicit platform filter may only NARROW what the grant already allows —
  // it can never reach a scope the owner did not grant.
  let scopes = grantedSocial;
  if (params.platforms?.length) {
    const wanted = new Set(
      params.platforms.map((p) => personalScope(String(p).trim().toLowerCase())),
    );
    scopes = grantedSocial.filter((scope) => wanted.has(scope));
    if (!scopes.length) throw new SocialSearchNotGranted([...grantedSocial]);
  }

  const rows = await searchPersonalDocuments(sql as postgres.Sql, params.workspaceId, params.userId, {
    query: params.query,
    scopes,
    participants: params.participants ? [...params.participants] : undefined,
    timeRange: params.timeRange,
    limit: params.limit,
    queryEmbedding: params.queryEmbedding ?? null,
  });

  return { scopesSearched: scopes, ...collectSocialHits(rows, registry) };
}

/**
 * Map store rows to hits, minting a ref for each and COUNTING what could not be
 * minted.
 *
 * Split out from the query so the interesting half is testable without a
 * database — the scoping above is enforced by refusals that never reach a
 * query, while this is where a row is either handed to an agent with a usable
 * ref or accounted for.
 */
export function collectSocialHits(
  rows: readonly PersonalSearchResult[],
  registry: ProviderRegistry = providerRegistry(),
): { hits: SocialSearchHit[]; skipped: Array<{ reason: MintRefusal; count: number }> } {
  const hits: SocialSearchHit[] = [];
  const skipped = new Map<MintRefusal, number>();
  for (const row of rows) {
    const minted = mintSocialPostRef(row.source, row.externalId, registry);
    if (!minted.ok) {
      skipped.set(minted.reason, (skipped.get(minted.reason) ?? 0) + 1);
      continue;
    }
    const platformRow = socialProviderInfo(minted.ref.platform, registry);
    hits.push(hitFromRow(row, platformRow, minted.postId, registry));
  }
  return {
    hits,
    skipped: [...skipped.entries()].map(([reason, count]) => ({ reason, count })),
  };
}

function hitFromRow(
  row: PersonalSearchResult,
  platformRow: SocialProviderInfo,
  postId: string,
  registry: ProviderRegistry,
): SocialSearchHit {
  const payload = (row.metadata ?? {}) as Record<string, unknown>;
  return {
    postId,
    platform: platformRow.id,
    platformLabel: platformRow.label,
    author: authorOf(payload, row.participants ?? []),
    occurredAt: row.occurredAt,
    title: row.title,
    snippet: row.snippet,
    score: row.score,
    replyable: socialWriteAvailability(platformRow.id, 'reply', registry),
  };
}
