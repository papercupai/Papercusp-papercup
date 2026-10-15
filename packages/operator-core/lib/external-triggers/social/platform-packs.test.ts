/**
 * P-025 — acceptance for the per-PLATFORM social trigger packs.
 *
 * WHY THIS IS A SEPARATE FILE FROM starter-packs.test.ts. That file is P-026's
 * acceptance for the three cross-platform WORKFLOW packs (mention-triage,
 * comment-digest, scheduled-crosspost), and its per-pack table has the shape
 * those packs share: a curated platform scope, and a `defaultStormPolicy` that
 * must be safe for the TIGHTEST platform it can reach. Neither property holds
 * here. A per-platform pack's scope is exactly one platform, so its default IS
 * that platform's derivation with nothing to take a minimum over, and the set of
 * packs is not a curated list at all — it is every registry row that passes
 * `isSocialPlatformVerified`. Reusing that table would have forced a hand-kept
 * list of platforms, which is the drift this file is built to prevent.
 *
 * THE THREE PROPERTIES THIS FILE EXISTS FOR — each a second copy of a truth
 * something else owns, and each pinned rather than restated:
 *
 * 1. WHICH PLATFORMS GET A PACK. Derived from the registry (`verifiedAt !==
 *    null`, D-005), never enumerated. A newly-verified platform reds this file
 *    until its pack exists; an unverified one reds it if a pack appears early.
 *
 * 2. THE STORM POLICY NUMBERS. A manifest is static JSON: it cannot import
 *    `socialStormPolicyFor`, so every maxRuns/windowSeconds in it is a copy of a
 *    number the registry derivation owns. Recomputed here and compared.
 *
 * 3. WHETHER A PACK DECLARES OAUTH. D-045 ruled that no social pack declares an
 *    `oauthField`, and that ruling was correct FOR THE PACKS THAT PRODUCED IT —
 *    P-026's cross-platform ones, which cannot name one provider for a scope
 *    spanning four platforms. A per-platform pack is a different case, so the
 *    rule is re-derived here from scope containment rather than inherited:
 *    a pack declares OAuth exactly when its registry scopes are non-empty and
 *    wholly inside one registered provider's allowedScopes. That single rule
 *    produces the right answer for all seven, Threads included — its scopes are
 *    non-empty but deliberately absent from the Facebook consent surface,
 *    because Threads authorizes against a different host under a different app
 *    id. No `if (id === 'threads')` special case appears in this file, and that
 *    is the point: the rule, not a table, is what knows.
 *
 * And one property that is neither derived nor pinned but BEHAVIOURAL: a pack's
 * bindings are checked against the adapter's real event-name functions, driven
 * over representative inputs. A binding for an event no adapter can emit is the
 * exact shape of the phantom D-046 was written about — an artifact that
 * validates, installs, and then never fires.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateTriggerPackDeclaration,
  jsonResponse,
  type PluginOAuthRequirement,
  type PluginTriggerPack,
  type ProviderAdapter,
} from '@papercusp/plugin-sdk';
import {
  isSocialPlatformVerified,
  listSocialPlatforms,
  type SocialPlatformRow,
} from './platform-registry';
import { socialStormPolicyFor } from './storm-policy';
import {
  FACEBOOK_ALLOWED_OAUTH_SCOPES,
  GOOGLE_WORKSPACE_ALLOWED_SCOPES,
} from '../../oauth/providers';
import { blueskyEventName } from './bluesky-adapter';
import { mastodonEventName } from './mastodon-adapter';
import { redditEventName } from './reddit-adapter';
import { youtubeActivityEventName } from './youtube-activities-adapter';
import { youtubeCommentEventName } from './youtube-comments-adapter';
import { threadsReplyEventName } from './threads-conversation-adapter';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

/**
 * Overridable so falsifiability can be proven against an out-of-tree COPY
 * rather than by mutating the shared checkout — a probe holds a file mutated for
 * as long as the suite runs, and the git-sync sweep would commit it.
 */
const PLUGINS_DIR = process.env.SOCIAL_STARTER_PACKS_DIR
  ? resolve(process.env.SOCIAL_STARTER_PACKS_DIR)
  : resolve(REPO_ROOT, 'libs/papercusp/plugins');

interface Manifest {
  name: string;
  capabilities?: unknown[];
  oauth?: PluginOAuthRequirement[];
  configSchema?: {
    required?: string[];
    properties?: Record<string, Record<string, unknown>>;
  };
  triggerPack?: PluginTriggerPack;
}

const packDir = (id: string) => resolve(PLUGINS_DIR, `social-${id}`);
const readManifest = (id: string) =>
  JSON.parse(readFileSync(resolve(packDir(id), 'papercusp.json'), 'utf8')) as Manifest;
const readPlan = (id: string) => readFileSync(resolve(packDir(id), 'plan.md'), 'utf8');

/** Registered OAuth providers, and the scopes each will actually consent to. */
const PROVIDER_ALLOWED: ReadonlyArray<{ provider: string; allowed: ReadonlySet<string> }> = [
  { provider: 'google', allowed: new Set<string>(GOOGLE_WORKSPACE_ALLOWED_SCOPES as readonly string[]) },
  { provider: 'facebook', allowed: new Set<string>(FACEBOOK_ALLOWED_OAUTH_SCOPES as readonly string[]) },
];

/** The containment rule — the whole of property 3 above, as one function. */
function providerFor(row: SocialPlatformRow): string | null {
  if (row.auth.scopes.length === 0) return null;
  for (const { provider, allowed } of PROVIDER_ALLOWED) {
    if (row.auth.scopes.every((scope) => allowed.has(scope))) return provider;
  }
  return null;
}

/**
 * Every event name each platform's adapters can actually PRODUCE, obtained by
 * driving the real `*EventName` functions rather than by copying their source.
 *
 * `closed: false` marks a platform whose name space the provider controls:
 * YouTube activities derive the name from `snippet.type`, so the set below is
 * what we can demonstrate, not what can arrive. A pack for such a platform is
 * required NOT to claim blanket coverage — see the wildcard test.
 */
const PRODUCIBLE: Record<string, { names: Set<string>; closed: boolean }> = {
  bluesky: {
    names: new Set([
      blueskyEventName({ reply: { root: 'r', parent: 'p' } } as never, null),
      blueskyEventName({ mentions: ['did:self'] } as never, 'did:self'),
      blueskyEventName({} as never, null),
    ]),
    closed: true,
  },
  mastodon: {
    names: new Set([
      mastodonEventName({ source: 'notification-mention' } as never),
      mastodonEventName({ inReplyToId: '1' } as never),
      mastodonEventName({} as never),
    ]),
    closed: true,
  },
  reddit: {
    names: new Set([redditEventName({ kind: 't1' }), redditEventName({ kind: 't3' })]),
    closed: true,
  },
  youtube: {
    names: new Set([
      youtubeActivityEventName({ type: 'upload' }),
      youtubeCommentEventName({ parentId: undefined }),
      youtubeCommentEventName({ parentId: 'p' }),
    ]),
    closed: false, // snippet.type is provider-controlled.
  },
  'facebook-pages': {
    names: new Set<string>(), // Filled by the real installed package below.
    closed: true,
  },
  instagram: {
    names: new Set<string>(), // Filled by the installed provider, including push.
    closed: true,
  },
  threads: {
    names: new Set([
      threadsReplyEventName({ is_reply: false } as never),
      threadsReplyEventName({ is_reply: true } as never),
    ]),
    closed: true,
  },
  tiktok: {
    // tiktok-videos-adapter emits the literal.
    // ONE name, and that is the platform speaking rather than a gap: TikTok
    // exposes no comment surface at all at this grant tier, so an upload is the
    // only inbound event that can exist.
    names: new Set(['post']),
    closed: true,
  },
};

beforeAll(async () => {
  const adapter = createRequire(import.meta.url)(
    resolve(REPO_ROOT, 'libs/papercusp/plugins/facebook-pages/index.cjs'),
  ).providerAdapter as ProviderAdapter;
  const created_time = '2026-10-01T00:00:00.000Z';
  let cursor: string | null = null;
  for (let n = 0; n < 5; n++) {
    const page = await adapter.syncPage({
      source: 'facebook-events', config: { pageId: '123' }, cursor,
      mode: cursor ? 'incremental' : 'backfill',
    }, { fetch: async ({ request }) => jsonResponse(200, {
      data: new URL(request.url).pathname.endsWith('/published_posts')
        ? [{ id: '123_1', created_time, message: 'post' }]
        : [{ id: '111', created_time, message: 'comment' },
          { id: '112', created_time, message: 'reply', parent: { id: '111' } }],
    }) });
    for (const record of page.records) PRODUCIBLE['facebook-pages']!.names.add(record.event!);
    cursor = page.nextCursor;
    if (!page.hasMore) {
      expect(PRODUCIBLE['facebook-pages']!.names).toEqual(new Set(['post', 'comment', 'reply']));
      break;
    }
  }
  expect(PRODUCIBLE['facebook-pages']!.names.size).toBe(3);
  const instagram = createRequire(import.meta.url)(resolve(REPO_ROOT, 'libs/papercusp/plugins/instagram/index.cjs')).providerAdapter as ProviderAdapter;
  cursor = null;
  const config = { igUserId: '17841400000000000', watchWindow: 1 };
  for (let n = 0; n < 4; n++) {
    const page = await instagram.syncPage({ source: 'instagram-events', config, cursor, mode: cursor ? 'incremental' : 'backfill' }, {
      fetch: async ({ request }) => jsonResponse(200, { data: new URL(request.url).pathname.endsWith('/media')
        ? [{ id: '222' }]
        : [{ id: '111', text: 'comment', timestamp: created_time, replies: { data: [{ id: '112', text: 'reply', timestamp: created_time }] } }],
      }),
    });
    for (const record of page.records) PRODUCIBLE.instagram!.names.add(record.event!);
    cursor = page.nextCursor;
    if (!page.hasMore) break;
  }
  const mentions = await instagram.invoke({ source: 'instagram-events', capability: 'ingress.normalize', args: {
    sourceConfig: config, envelope: { object: 'instagram', entry: [{ id: config.igUserId, changes: [{ field: 'mentions', value: { media_id: '333' } }] }] },
  } }, { fetch: async () => jsonResponse(200, { id: config.igUserId, mentioned_media: { id: '333', caption: 'mention', timestamp: created_time } }) }) as { records: Array<{ event: string }> };
  for (const record of mentions.records) PRODUCIBLE.instagram!.names.add(record.event);
  expect(PRODUCIBLE.instagram!.names).toEqual(new Set(['comment', 'reply', 'mention']));
});

/**
 * Packs are derived from the platforms that are verified AND READABLE.
 *
 * The readability half arrived with LinkedIn (P-021), the first verified row
 * that cannot be read at any grant tier we hold. A trigger pack exists to turn
 * INBOUND platform events into plan runs, and both shipped workflows —
 * mention-triage and comment-digest — are built on reading. A write-only
 * platform emits nothing, so its pack could only be an empty shell.
 *
 * Shipping that shell is precisely what D-002 already refused for X/Twitter, in
 * its own words: a free-tier write-only adapter "cannot serve the mention-triage
 * or comment-digest workflows, so it would ship a hollow row that reads as
 * support". The same reasoning binds here rather than being re-litigated — the
 * only new thing is that LinkedIn reaches the condition by a restricted read
 * scope instead of by price.
 */
const verifiedRows = listSocialPlatforms().filter(isSocialPlatformVerified);
const packRows = verifiedRows.filter((row) => row.read !== null);
const verifiedIds = packRows.map((row) => row.id);

describe('P-025 per-platform social trigger packs', () => {
  it('the platform set is non-trivial, so the per-platform assertions below are not vacuous', () => {
    // Calibration. Every test that follows iterates `verifiedRows`; an empty or
    // near-empty registry would make all of them pass while checking nothing.
    expect(verifiedRows.length).toBeGreaterThanOrEqual(7);
  });

  it('a pack exists for exactly the VERIFIED, READABLE platforms — the list is derived, never enumerated', () => {
    for (const row of listSocialPlatforms()) {
      const hasPack = existsSync(resolve(packDir(row.id), 'papercusp.json'));
      const shouldHavePack = isSocialPlatformVerified(row) && row.read !== null;
      const why = !isSocialPlatformVerified(row)
        ? `platform ${row.id} is NOT verified (verifiedAt is null) — D-005 forbids shipping a pack that would assert facts nobody read`
        : row.read === null
          ? `platform ${row.id} is verified but WRITE-ONLY — a trigger pack turns inbound events into plan runs and this platform emits none, so a pack would be a hollow shell that reads as support (D-002's reasoning)`
          : `platform ${row.id} is verified and readable but has no pack at social-${row.id}`;
      expect(hasPack, why).toBe(shouldHavePack);
    }
  });

  it('CONTROL: the readable filter excludes something, so the rule above is not a no-op', () => {
    // Without this, narrowing the derivation to "readable" would look identical
    // to leaving it at "verified" — and a future row that quietly became
    // write-only would drop out of every per-platform assertion below unnoticed.
    const writeOnlyVerified = verifiedRows.filter((row) => row.read === null).map((row) => row.id);
    expect(writeOnlyVerified).toEqual(['linkedin']);
    expect(verifiedIds).not.toContain('linkedin');
  });

  describe.each(verifiedIds)('social-%s', (id) => {
    const row = verifiedRows.find((candidate) => candidate.id === id)!;

    it('validates against the real trigger-pack validator', () => {
      expect(validateTriggerPackDeclaration(readManifest(id) as never)).toEqual([]);
    });

    it('pins its storm policy to the registry read derivation', () => {
      const derived = socialStormPolicyFor(row, 'read');
      expect(readManifest(id).triggerPack?.defaultStormPolicy).toEqual({
        maxRuns: derived.maxRuns,
        windowSeconds: derived.windowSeconds,
      });
    });

    it('declares OAuth exactly when its scopes fit a registered provider', () => {
      const manifest = readManifest(id);
      const provider = providerFor(row);
      const credField = manifest.configSchema?.required?.[0];
      expect(credField, 'every pack requires exactly one credential field').toBeTruthy();

      if (provider === null) {
        expect(
          manifest.oauth ?? [],
          `${id} has no provider whose allowedScopes contain ${JSON.stringify(row.auth.scopes)} — declaring one would fail at consent time, not build time`,
        ).toEqual([]);
        // …and no binding may name an oauthField it cannot honour.
        for (const binding of manifest.triggerPack?.bindings ?? []) {
          if (binding.source.kind === 'external') {
            expect(binding.source.oauthField ?? null).toBeNull();
          }
        }
        return;
      }

      expect(manifest.oauth).toHaveLength(1);
      const requirement = manifest.oauth![0]!;
      expect(requirement.provider).toBe(provider);
      expect(requirement.fieldName).toBe(credField);
      // The scope list is the REGISTRY's, not a copy typed into the manifest.
      expect([...(requirement.scopes ?? [])].sort()).toEqual([...row.auth.scopes].sort());
      for (const binding of manifest.triggerPack?.bindings ?? []) {
        if (binding.source.kind === 'external') {
          expect(binding.source.oauthField).toBe(credField);
        }
      }
    });

    it('strips the credential and shares only the non-secret identifier', () => {
      const manifest = readManifest(id);
      const props = manifest.configSchema?.properties ?? {};
      const credField = manifest.configSchema!.required![0]!;
      const cred = props[credField]!;
      expect(cred.secret).toBe(true);
      expect(cred.snapshotPolicy).toBe('strip');
      expect(cred.shareable).toBe(false);

      // Exactly one other field: the environment identifier, which DOES travel.
      const others = Object.keys(props).filter((key) => key !== credField);
      expect(others).toHaveLength(1);
      const identifier = props[others[0]!]!;
      expect(identifier.secret ?? false).toBe(false);
      expect(identifier.shareable).toBe(true);
    });

    it('binds only events its adapters can actually emit, one binding per event', () => {
      const manifest = readManifest(id);
      const bindings = manifest.triggerPack?.bindings ?? [];
      expect(bindings.length).toBeGreaterThan(0);

      const declared = bindings.map((binding) => {
        expect(binding.source.kind).toBe('external');
        if (binding.source.kind !== 'external') throw new Error('unreachable');
        // sourceKind is the platform id — the convention the ingestion seam uses.
        expect(binding.source.sourceKind).toBe(id);
        const pattern = binding.eventPattern;
        // Asserted rather than defaulted: `eventPattern` is optional on the SDK
        // type, and a `?? ''` here would silently turn a MISSING pattern into an
        // empty string that fails the prefix check for the wrong reason.
        expect(typeof pattern, `binding "${binding.id}" declares no eventPattern`).toBe('string');
        expect(pattern!.startsWith(`ext:${id}:`)).toBe(true);
        return pattern!.slice(`ext:${id}:`.length);
      });

      // One binding per event, so an owner can arm mentions without posts.
      expect(new Set(declared).size).toBe(declared.length);

      const producible = PRODUCIBLE[id]!;
      for (const event of declared) {
        expect(
          producible.names.has(event),
          `social-${id} binds ext:${id}:${event}, which no ${id} adapter produces — it would install cleanly and never fire`,
        ).toBe(true);
      }
      if (producible.closed) {
        // Nothing the adapters CAN emit is left unbound.
        for (const name of producible.names) {
          expect(
            declared.includes(name),
            `${id} adapters emit "${name}" but social-${id} binds no pattern for it`,
          ).toBe(true);
        }
      }
    });

    it('uses no wildcard event pattern', () => {
      // A bare `ext:<id>:*` is legal (keyMatchesPattern compiles an anchored
      // glob) and is deliberately unused. It matters most exactly where it is
      // most tempting: YouTube's name space is provider-controlled, so a
      // wildcard there fires the plan on `like` and `subscription` activities —
      // which normalize to EMPTY text — against a 3-runs-per-300s budget.
      for (const binding of readManifest(id).triggerPack?.bindings ?? []) {
        expect(binding.eventPattern).not.toContain('*');
      }
    });

    it('requests no capability, and its executable steps invoke no write verb', () => {
      expect(readManifest(id).capabilities ?? []).toEqual([]);

      // SCOPED TO `## Steps` ON PURPOSE. A whole-file grep for `social:reply`
      // cannot tell an INSTRUCTION from a PROHIBITION, and this plan's
      // "Not in scope" section names those verbs precisely in order to forbid
      // hand-assembling a postId for them. The first version of this assertion
      // was whole-file and failed on all seven packs — against the prohibition
      // text itself. Weakening the guidance to satisfy the grep would have been
      // the wrong repair: the steps are the executable half, so that is what is
      // checked, and the guidance is asserted to still be PRESENT below.
      const steps = readPlan(id).split(/^## /m).find((section) => section.startsWith('Steps')) ?? '';
      expect(steps.length, 'plan.md must have a ## Steps section').toBeGreaterThan(0);
      for (const verb of ['social:reply', 'social:post', 'social:delete']) {
        expect(
          steps.toLowerCase(),
          `social-${id}'s STEPS invoke ${verb}; this pack records and stops`,
        ).not.toContain(verb);
      }
    });

    it('its plan names no capability the agent cannot reach', () => {
      const plan = readPlan(id);
      // D-046: no agent verb exposes the delivery ledger, so a plan step that
      // reads it strands the agent at run time while validating perfectly.
      const ledgerMention = /read (the )?delivery ledger|from the delivery ledger|trigger_deliveries/i;
      expect(ledgerMention.test(plan.replace(/^.*Do not read the delivery ledger.*$/gim, ''))).toBe(false);
      // A postId is opaque and must come from social:search verbatim; the
      // documented `<platform>:<id>` FORMAT is what invites hand-assembly.
      expect(plan).toContain('social:search');

      // The two prohibitions must SURVIVE — this is the other half of scoping
      // the write-verb check to `## Steps`. Without this, the way to green a
      // failing steps-grep would be to delete the guidance rather than the
      // instruction, which is strictly worse than the phantom it prevents.
      const notInScope = plan.split(/^## /m).find((section) => section.startsWith('Not in scope')) ?? '';
      expect(notInScope, 'plan.md must have a ## Not in scope section').not.toEqual('');
      expect(notInScope).toMatch(/do not read the delivery ledger/i);
      expect(notInScope).toMatch(/do not construct a postid/i);
    });
  });
});
