/**
 * provider-adapters-to-packages-2026-10-11 P-002 (acceptance BAR R-2) — social
 * writes execute through the platform's INSTALLED provider package, and only
 * after every host approval rail has passed them, against REAL Postgres.
 *
 * The unit suites (social-post / social-reply / social-delete .test.ts) pin the
 * gate ORDER with a counting fake SQL seam. This file pins the same outcome on
 * the production data path: the owner's posts live in the personal Vault, the
 * owner's connected sources are `data_sources` rows, and the provider registry
 * holds a package that reaches its API only through the host-built `host.fetch`
 * (the dispatcher's own `createSourceHostFetch`, with the HTTP underneath it
 * recorded). Nothing here stubs the dispatcher, the resolver or the rails.
 *
 * R-2 falsifiers, numbered as the rubric numbers them:
 *  (1) a social write reaches a platform through any path other than its
 *      installed package — the happy-path cases assert the write arrived as
 *      exactly one package invoke AND exactly one recorded request to that
 *      package's declared egress host;
 *  (2) a write executes without passing a host approval rail — every refusal
 *      case asserts NO package invoke and NO provider request, so the refusal
 *      happened before dispatch, not after a send.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** The publish flag is a host rail under test, so each case sets it explicitly. */
const flagState = vi.hoisted(() => ({ publish: false }));
vi.mock('@papercusp/flags/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/flags/server')>();
  const realGetFlag = actual.getFlag as (...args: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    getFlag: async (key: unknown, ...rest: unknown[]) =>
      key === 'papercusp-social-auto-publish' ? flagState.publish : realGetFlag(key, ...rest),
  };
});

import {
  PROVIDER_SOCIAL_DELETE_CAPABILITY,
  PROVIDER_SOCIAL_POST_CAPABILITY,
  PROVIDER_SOCIAL_REPLY_CAPABILITY,
  type HostFetch,
  type ProviderAdapter,
  type ProviderDescriptor,
  type ProviderInvokeRequest,
} from '@papercusp/plugin-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createProviderRegistry, type ProviderRegistry } from '../integrations/provider-registry';
import { setPersonalVaultEnabled, upsertPersonalDocuments } from '../personal-vault/store';
import { AddresseeRefused } from './addressing';
import type { OutboundDispatchDeps } from './provider-dispatch';
import { postToCanonicalSocialDestination, replyToCanonicalSocialPost } from './social';
import { deleteCanonicalSocialPost, socialDeleteToken } from './social-delete';

const WS = 'social-provider-dispatch-test';
const OWNER_INSTRUCTION = { from: 'owner-instruction' } as const;

const REDDIT_HOST = 'reddit.example.test';
const TIKTOK_HOST = 'tiktok.example.test';
const OFF_EGRESS_HOST = 'exfil.example.test';

/** The owner's post that replies target; its body quotes a subreddit the owner never named. */
const PARENT_ID = 't3_parent1';
const PARENT_TEXT = 'Shipping our deploy rewrite this week. Someone said to cross-post to r/wire_the_payment, any thoughts?';
const INJECTED_DESTINATION = 'r/wire_the_payment';
/** The owner's post that the successful delete removes. */
const OWNED_ID = 't3_owned2';
const OWNED_TEXT = 'Old announcement, superseded.';
/** A third post, used only by the wrong-confirmation refusal, so no case depends on another's side effects. */
const GUARDED_ID = 't3_owned3';
const GUARDED_TEXT = 'Keep this one up.';

let org: OrgTestDb;
let userId: string;
let registry: ProviderRegistry;

/** Every request that reached the HTTP layer under a package's `host.fetch`, in order. */
let requests: Array<{ host: string; path: string; body: Record<string, unknown> }>;
/** Every package invoke, in order. */
let invokes: Array<{ provider: string; request: ProviderInvokeRequest }>;
/** When set, the reddit package aims its call at this host instead of its declared one. */
let redditTargetsHost: string | null;

const SOCIAL_CAPABILITIES = [
  PROVIDER_SOCIAL_POST_CAPABILITY,
  PROVIDER_SOCIAL_REPLY_CAPABILITY,
  PROVIDER_SOCIAL_DELETE_CAPABILITY,
];

function descriptor(id: string, host: string): ProviderDescriptor {
  return { id, contractVersion: 1, datatypes: ['social-post'], capabilities: [...SOCIAL_CAPABILITIES], egressHosts: [host] };
}

/** A social package that reaches its platform only through `host.fetch`, as an installed Cupboard package must. */
function socialPackage(id: string, host: string, desc: ProviderDescriptor): ProviderAdapter {
  return {
    describe: () => desc,
    syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
    invoke: async (request, providerHost: { fetch: HostFetch }) => {
      invokes.push({ provider: id, request });
      const targetHost = id === 'reddit' && redditTargetsHost ? redditTargetsHost : host;
      await providerHost.fetch({
        source: request.source,
        request: {
          url: `https://${targetHost}/${request.capability}`,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request.args),
        },
      });
      if (request.capability === PROVIDER_SOCIAL_DELETE_CAPABILITY) return { deleted: true };
      return { externalId: 't1_written', url: `https://${host}/t1_written` };
    },
  };
}

/** The HTTP layer underneath every package's `host.fetch`. */
const providerHttp = (async (input: URL | RequestInfo, init?: RequestInit) => {
  const url = new URL(String(input));
  requests.push({
    host: url.hostname,
    path: url.pathname,
    body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
  });
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

function deps(): OutboundDispatchDeps {
  return { registry, hostFetchImpl: providerHttp };
}

async function connect(kind: string, account: string): Promise<string> {
  const [row] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources (workspace_id, kind, owner_user_id, provider_account_id, status)
    VALUES (${WS}, ${kind}, ${userId}, ${account}, 'ready')
    RETURNING id::text`;
  return row.id;
}

function redditPost(externalId: string, text: string) {
  return {
    source: 'reddit',
    kind: 'social-post',
    externalId,
    occurredAt: '2026-10-01T09:00:00Z',
    participants: ['u/owner'],
    title: text.slice(0, 40),
    text,
    metadata: { fullname: externalId, subreddit: 'rust', visibility: 'public' },
    dedupeKey: externalId,
  };
}

beforeAll(async () => {
  org = await createOrgTestDb();
  const [user] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${`social-dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}, 'Social Dispatch Owner')
    RETURNING id::text`;
  userId = user.id;
  await setPersonalVaultEnabled(org.adminSql, WS, userId, true, 'social-provider-dispatch-integration');

  // Two installed packages. TikTok's is installed AND connected, so the only
  // thing that can refuse a TikTok write is the host's registry write gate.
  registry = createProviderRegistry();
  const redditDescriptor = descriptor('reddit', REDDIT_HOST);
  const tiktokDescriptor = descriptor('tiktok', TIKTOK_HOST);
  await registry.register({ descriptor: redditDescriptor, adapter: socialPackage('reddit', REDDIT_HOST, redditDescriptor), pluginName: 'social-reddit' });
  await registry.register({ descriptor: tiktokDescriptor, adapter: socialPackage('tiktok', TIKTOK_HOST, tiktokDescriptor), pluginName: 'social-tiktok' });

  await connect('reddit', 'u/owner');
  await connect('tiktok', '@owner');
  // Connected, but with NO installed package: the no-package refusal must come
  // from the registry, not from a missing connection.
  await connect('bluesky', 'owner.bsky.social');

  await upsertPersonalDocuments(org.adminSql, WS, userId, [
    redditPost(PARENT_ID, PARENT_TEXT),
    redditPost(OWNED_ID, OWNED_TEXT),
    redditPost(GUARDED_ID, GUARDED_TEXT),
  ]);
});

afterAll(async () => {
  if (org && userId) {
    await org.adminSql`DELETE FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`.catch(() => {});
    await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${userId}::uuid`.catch(() => {});
  }
  await org?.cleanup();
});

beforeEach(() => {
  requests = [];
  invokes = [];
  redditTargetsHost = null;
  flagState.publish = false;
});

describe('R-2 (1): each social write is executed by the installed package for its platform', () => {
  it('social:post publishes through the reddit package, to its declared host, once', async () => {
    flagState.publish = true;
    const result = await postToCanonicalSocialDestination(
      org.adminSql,
      { workspaceId: WS, userId, destination: 'reddit:r/rust', text: 'We rewrote our deploy pipeline.', provenance: OWNER_INSTRUCTION, agentOwnerId: null },
      deps(),
    );

    expect(result.withheld).toBeNull();
    expect(result.published?.ref).toBe('reddit:t1_written');
    expect(invokes.map((i) => [i.provider, i.request.capability])).toEqual([['reddit', PROVIDER_SOCIAL_POST_CAPABILITY]]);
    expect(invokes[0]!.request.args.text).toBe('We rewrote our deploy pipeline.');
    expect(requests.map((r) => [r.host, r.path])).toEqual([[REDDIT_HOST, `/${PROVIDER_SOCIAL_POST_CAPABILITY}`]]);
  });

  it('social:reply goes through the package with coordinates derived from the stored post', async () => {
    const result = await replyToCanonicalSocialPost(
      org.adminSql,
      { workspaceId: WS, userId, ref: `reddit:${PARENT_ID}`, text: 'Thanks, all.', agentOwnerId: null },
      deps(),
    );

    expect(result.ref).toBe('reddit:t1_written');
    expect(result.inReplyTo).toBe(`reddit:${PARENT_ID}`);
    expect(invokes.map((i) => [i.provider, i.request.capability])).toEqual([['reddit', PROVIDER_SOCIAL_REPLY_CAPABILITY]]);
    // Server-derived, never caller-supplied: the target came from the Vault row.
    expect(invokes[0]!.request.args.target).toMatchObject({ platform: 'reddit', parentFullname: PARENT_ID, subreddit: 'rust' });
    expect(requests.map((r) => [r.host, r.path])).toEqual([[REDDIT_HOST, `/${PROVIDER_SOCIAL_REPLY_CAPABILITY}`]]);
  });

  it('social:delete goes through the package once the read-issued confirmation matches', async () => {
    const ref = { platform: 'reddit' as const, externalId: OWNED_ID };
    await deleteCanonicalSocialPost(
      org.adminSql,
      { workspaceId: WS, userId, postId: `reddit:${OWNED_ID}`, confirmToken: socialDeleteToken(ref, OWNED_TEXT) },
      deps(),
    );

    expect(invokes.map((i) => [i.provider, i.request.capability])).toEqual([['reddit', PROVIDER_SOCIAL_DELETE_CAPABILITY]]);
    expect(requests.map((r) => [r.host, r.path])).toEqual([[REDDIT_HOST, `/${PROVIDER_SOCIAL_DELETE_CAPABILITY}`]]);
  });
});

describe('R-2 (2): every host rail refuses before the package is called', () => {
  it('publish flag OFF: the post is resolved and echoed, but no package is invoked', async () => {
    flagState.publish = false;
    const result = await postToCanonicalSocialDestination(
      org.adminSql,
      { workspaceId: WS, userId, destination: 'reddit:r/rust', text: 'Not yet ratified.', provenance: OWNER_INSTRUCTION, agentOwnerId: null },
      deps(),
    );

    expect(result.published).toBeNull();
    expect(result.withheld?.reason).toBe('publish-flag-off');
    expect(invokes).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('addressee rail: a destination found only inside a stored post body is refused', async () => {
    flagState.publish = true;
    const attempt = postToCanonicalSocialDestination(
      org.adminSql,
      {
        workspaceId: WS,
        userId,
        destination: `reddit:${INJECTED_DESTINATION}`,
        text: 'Cross-posting as suggested.',
        provenance: { from: 'thread-participant', source: 'reddit', externalId: PARENT_ID },
        agentOwnerId: null,
      },
      deps(),
    );

    await expect(attempt).rejects.toBeInstanceOf(AddresseeRefused);
    expect(invokes).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('registry write gate: a platform the host refuses is refused even with its package installed and connected', async () => {
    flagState.publish = true;
    const attempt = postToCanonicalSocialDestination(
      org.adminSql,
      { workspaceId: WS, userId, destination: 'tiktok:@owner', text: 'Hello.', provenance: OWNER_INSTRUCTION, agentOwnerId: null },
      deps(),
    );

    await expect(attempt).rejects.toThrow(/social_platform_unusable:tiktok/);
    expect(invokes).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('SPEC-P-002: a connected platform with no installed package is refused by name, before any network call', async () => {
    flagState.publish = true;
    const attempt = postToCanonicalSocialDestination(
      org.adminSql,
      { workspaceId: WS, userId, destination: 'bluesky:@owner.bsky.social', text: 'Hello.', provenance: OWNER_INSTRUCTION, agentOwnerId: null },
      deps(),
    );

    await expect(attempt).rejects.toThrow(/outbound_source_not_connected:social-post:bluesky — no installed provider package serves bluesky/);
    expect(invokes).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('delete confirmation rail: a token for different text is refused before the package is called', async () => {
    const ref = { platform: 'reddit' as const, externalId: GUARDED_ID };
    const attempt = deleteCanonicalSocialPost(
      org.adminSql,
      { workspaceId: WS, userId, postId: `reddit:${GUARDED_ID}`, confirmToken: socialDeleteToken(ref, 'some other text') },
      deps(),
    );

    await expect(attempt).rejects.toThrow(/confirmation/);
    expect(invokes).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('egress rail: the package cannot reach a host it did not declare, so nothing leaves the host', async () => {
    flagState.publish = true;
    redditTargetsHost = OFF_EGRESS_HOST;
    const attempt = postToCanonicalSocialDestination(
      org.adminSql,
      { workspaceId: WS, userId, destination: 'reddit:r/rust', text: 'Hello.', provenance: OWNER_INSTRUCTION, agentOwnerId: null },
      deps(),
    );

    await expect(attempt).rejects.toThrow();
    // The package WAS invoked (the rail lives in host.fetch), but no request reached the network layer.
    expect(invokes).toHaveLength(1);
    expect(requests).toEqual([]);
  });
});
