/**
 * The Slack pilot's acceptance journeys on the real package and the real host paths
 * (plan papercusp-enterprise-readiness-roadmap-2026-10-09 P-011, child P-011c WI-6554700010012144).
 *
 * P-011 asks that source ACL change and revocation, retries, deletion, private reachability and a
 * separate write authorization be exercised on the pilot connector. Every seam already has a
 * provider-neutral test; these journeys run them on the Slack package path end to end:
 *
 *   - the package's manifest daemon runs in the provider sandbox (`startDaemonProvider`), exactly as
 *     a Cupboard install runs it, and is driven by the shared connector driver (`runConnectorSync`);
 *   - its records land through the production destination sinks into chat_messages, are rolled up
 *     (`rollupChatUnits`) into the organization corpus, and are read back through the production
 *     readers: `searchOrganizationDocuments` (stored copy) and `searchLiveSources` (live search);
 *   - `host.fetch` is the production `createSourceHostFetch`: the bot token for sync, the searching
 *     person's own user token for live search. Only Slack itself is a local stand-in.
 *
 * Deletion of a message is covered by slack-package.integration.test.ts (P-011b). Private
 * reachability is not applicable to Slack: the package reaches only slack.com (SaaS), which the
 * last journey pins so the disposition cannot silently go stale.
 */
import { promises as fs, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { ProviderDescriptor } from '@papercusp/plugin-sdk';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
// The token store mirrors to PG through getOrgPg; keep that mirror in the test database.
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { getDatatype, upsertDatatype } from '../../datatype-registry-store';
import { rollupChatUnits } from '../../data-sources/chat-retrieval-units';
import {
  mapProviderIdentity,
  revokeProviderIdentityMapping,
  searchOrganizationDocuments,
  ORGANIZATION_CORPUS_SCOPE,
} from '../../data-sources/documents-corpus';
import { LIVE_SEARCH_SYNC_MODE, providerLiveSearchAdapters, searchLiveSources } from '../../data-sources/live-search-adapter';
import { DEFAULT_SOURCE_TOKEN_HARNESS } from '../../external-triggers/source-store';
import { loadExternalTriggerAdminSnapshot } from '../../external-triggers/admin';
import { ingestExternalTriggerEvent } from '../../external-triggers/ingestion';
import { enforceInheritedPolicy } from '../../governance-policy/enforce';
import type { ChainLoad, StoredPolicyLayer } from '../../governance-policy/store';
import { startDaemonProvider, type DaemonProviderRuntime } from '../../integrations/daemon-provider';
import { providerPrincipalStoreKey, saveProviderCredentials } from '../../integrations/provider-credentials';
import { createProviderRegistry, type ProviderRegistry } from '../../integrations/provider-registry';
import { createSourceHostFetch } from '../../integrations/source-host-fetch';
import { fsTokenStorage } from '../../oauth/storage-fs';
import { createPersonalGrant } from '../../personal-vault/store';
import { ProviderSyncFailure, runConnectorSync, type ConnectorSourceOutcome } from '../connector-runtime';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const PACKAGE_DIR = resolve(REPO_ROOT, 'libs/papercusp/plugins/slack');
const manifest = JSON.parse(readFileSync(resolve(PACKAGE_DIR, 'papercusp.json'), 'utf8')) as {
  runtime: { kind: string; daemonCommand: string[] };
  provider: ProviderDescriptor & { egressHosts?: string[] };
};

const WS = 'slack-pilot-journeys';
const HARNESS = DEFAULT_SOURCE_TOKEN_HARNESS;
const ROLE = 'meeting-prep';
/** Token-shaped fakes, assembled at runtime so no credential-shaped literal sits in the tree. */
const fakeToken = (prefix: string, tail: string) => [prefix, '1', 'A0FIXTURE', '0123456789', tail].join('-');
const APP_TOKEN = fakeToken('xapp', 'app');
const BOT_TOKEN = fakeToken('xoxb', 'bot');
const ALICE_TOKEN = fakeToken('xoxp', 'alice');
const BOB_TOKEN = fakeToken('xoxp', 'bob');

let org: OrgTestDb;
let sql: Sql;
let home: string;
let runtime: DaemonProviderRuntime;
let registry: ProviderRegistry;
let http: Server;
let httpPort: number;
let alice: string;
let bob: string;

// ── Stand-in Slack ──────────────────────────────────────────────────────────

interface Channel {
  id: string;
  name: string;
  /** Slack user ids in the channel (conversations.members). */
  members: string[];
  messages: Array<Record<string, unknown>>;
}

interface SlackWorld {
  /** Channels the bot is a member of: what conversations.list reports as is_member. */
  channels: Channel[];
  /** Channels whose history Slack refuses with not_in_channel (the bot left after listing). */
  historyGone: Set<string>;
  /** One 429 per API path, with its Retry-After seconds. */
  rateLimitOnce: Map<string, number>;
  /** The bot token was revoked in Slack: every bot call answers token_revoked. */
  botRevoked: boolean;
  /** Each person's own user token → their Slack user id (Real-time Search acts as them). */
  userTokens: Map<string, string>;
}

let world: SlackWorld;
let apiCalls: Array<{ path: string; authorization: string | null; channel: string | null }>;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
  });
}

/** Every request to https://slack.com is answered by the local stand-in. */
const slackFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname !== 'slack.com') throw new Error(`unexpected host request: ${url.href}`);
  return fetch(`http://127.0.0.1:${httpPort}${url.pathname}${url.search}`, init);
}) as typeof fetch;

function slackHandler() {
  return async (req: IncomingMessage, res: import('node:http').ServerResponse) => {
    const body = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://slack.local');
    const path = url.pathname;
    const authorization = req.headers.authorization ?? null;
    const channel = url.searchParams.get('channel');
    apiCalls.push({ path, authorization, channel });
    res.setHeader('content-type', 'application/json');
    const reply = (value: unknown) => res.end(JSON.stringify(value));

    const retryAfter = world.rateLimitOnce.get(path);
    if (retryAfter !== undefined) {
      world.rateLimitOnce.delete(path);
      res.statusCode = 429;
      res.setHeader('retry-after', String(retryAfter));
      reply({ ok: false, error: 'ratelimited' });
      return;
    }

    // Real-time Search runs as the person whose user token made the call (assistant.search.context).
    if (path === '/api/assistant.search.context') {
      const token = authorization?.replace(/^Bearer /, '') ?? '';
      const user = world.userTokens.get(token);
      if (!user) return reply({ ok: false, error: 'not_authed' });
      const query = String((JSON.parse(body || '{}') as { query?: string }).query ?? '').toLowerCase();
      const messages = world.channels
        .filter((c) => c.members.includes(user))
        .flatMap((c) => c.messages
          .filter((m) => String(m.text ?? '').toLowerCase().includes(query))
          .map((m) => ({
            channel_id: c.id, channel_name: c.name, message_ts: m.ts, content: m.text,
            author_user_id: m.user, permalink: `https://slack.example/archives/${c.id}/p${String(m.ts).replace('.', '')}`,
          })));
      return reply({ ok: true, results: { messages } });
    }

    if (world.botRevoked) return reply({ ok: false, error: 'token_revoked' });
    if (authorization !== `Bearer ${BOT_TOKEN}`) return reply({ ok: false, error: 'not_authed' });
    if (path === '/api/conversations.list') {
      return reply({
        ok: true,
        channels: world.channels.map((c) => ({ id: c.id, name: c.name, is_member: true, is_archived: false })),
        response_metadata: { next_cursor: '' },
      });
    }
    const target = world.channels.find((c) => c.id === channel);
    if (path === '/api/conversations.members') {
      if (!target) return reply({ ok: false, error: 'channel_not_found' });
      return reply({ ok: true, members: target.members, response_metadata: { next_cursor: '' } });
    }
    if (path === '/api/conversations.history') {
      if (!target || world.historyGone.has(target.id)) return reply({ ok: false, error: 'not_in_channel' });
      return reply({ ok: true, messages: target.messages, response_metadata: { next_cursor: '' } });
    }
    if (path === '/api/conversations.replies') return reply({ ok: true, messages: [], response_metadata: { next_cursor: '' } });
    if (path === '/api/chat.postMessage') {
      const sent = JSON.parse(body || '{}') as { channel?: string };
      return reply({ ok: true, channel: sent.channel, ts: '1712345999.000100' });
    }
    return reply({ ok: false, error: 'unknown_method' });
  };
}

// ── Host fixtures ───────────────────────────────────────────────────────────

/** The two messages the pilot workspace holds: one in #bugs (alice, bob), one in #ops (bob only). */
function pilotWorld(): SlackWorld {
  return {
    channels: [
      {
        id: 'C0BUGS', name: 'bugs', members: ['U0ALICE', 'U0BOB'],
        messages: [{ type: 'message', user: 'U0BOB', text: 'The cobalt export returns a 500 for every tenant', ts: '1712345678.000200' }],
      },
      {
        id: 'C0OPS', name: 'ops', members: ['U0BOB'],
        messages: [{ type: 'message', user: 'U0BOB', text: 'Rotate the orchid signing key before Friday', ts: '1712345690.000100' }],
      },
    ],
    historyGone: new Set(),
    rateLimitOnce: new Map(),
    botRevoked: false,
    userTokens: new Map([[ALICE_TOKEN, 'U0ALICE'], [BOB_TOKEN, 'U0BOB']]),
  };
}

async function newUser(label: string): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${`slack-pilot-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}, ${label}) RETURNING id`;
  return user!.id;
}

/** An organization Slack source: synced into the corpus, or federated (searched live, never copied). */
async function orgSource(mode: 'synced' | 'federated' = 'synced'): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources
      (workspace_id, kind, owner_user_id, provider_account_id, status, scope,
       destination_policy, permission_mapping ${mode === 'federated' ? sql`, sync_mode` : sql``})
    VALUES (${WS}, 'slack', ${alice}::uuid, ${`T0PILOT-${mode}-${Math.random().toString(36).slice(2, 8)}`}, 'connected', 'organization',
            ${sql.json(manifest.provider.defaultDestinations as never)}, ${sql.json({ mode: 'source-acl' })}
            ${mode === 'federated' ? sql`, ${LIVE_SEARCH_SYNC_MODE}` : sql``})
    RETURNING id::text`;
  return row!.id;
}

/** One driver pass over one source, through the production host.fetch (bot token from the store). */
async function syncOnce(sourceId: string, opts: { maxPagesPerSource?: number } = {}): Promise<ConnectorSourceOutcome> {
  const result = await runConnectorSync(
    sql,
    { workspaceId: WS, harness: HARNESS, sourceIds: [sourceId], pollIntervalSeconds: 300, ...opts },
    {
      registry,
      leaseOwner: 'slack-pilot-it',
      hostFetchFor: (provider, db) => createSourceHostFetch(db, {
        providerId: provider.descriptor.id, workspaceId: WS, harness: HARNESS, registry, fetchImpl: slackFetch,
        reconnectRequired: (reason) => new ProviderSyncFailure({ kind: 'auth', message: reason }),
      }),
      ingest: (db, input) => ingestExternalTriggerEvent(db, input, {
        emit: async (event) => ({ ok: true, key: event.key, woken: 0, notified: [], msgId: null, waiters: 0 }),
      }),
      afterSourceSynced: async () => null,
    },
  );
  expect(result.sources).toHaveLength(1);
  return result.sources[0]!;
}

/** Make a source due again (the driver respects its poll cadence and backoff). */
async function due(sourceId: string): Promise<void> {
  await sql`UPDATE harness_shared.data_sources SET sync_next_attempt_at = NULL WHERE id = ${sourceId}::uuid`;
}

/** What Settings → Integrations shows for a source (it renders `lastError` from this row). */
async function health(sourceId: string) {
  const [row] = await sql<Array<{
    status: string; last_error: string | null; failure_count: number; next_in: number | null;
    provider_cursor: string | null; backfill_status: string | null;
  }>>`
    SELECT status, last_error, sync_failure_count AS failure_count,
           EXTRACT(EPOCH FROM (sync_next_attempt_at - now()))::int AS next_in,
           cursor->>'provider' AS provider_cursor, backfill_status
      FROM harness_shared.data_sources WHERE id = ${sourceId}::uuid`;
  return row!;
}

/** Shared administrator projection of the actual driver's persisted state. */
async function adminHealth(sourceId: string) {
  const snapshot = await loadExternalTriggerAdminSnapshot(sql, WS);
  const row = snapshot.sources.find((source) => source.id === sourceId);
  expect(row).toBeDefined();
  return row!;
}

/** Give a person every organization-corpus prerequisite, so an empty result is the ACL speaking. */
async function enrol(userId: string, slackUserId: string): Promise<void> {
  await createPersonalGrant(sql, {
    workspaceId: WS, userId, principalType: 'agent-role', principalId: ROLE,
    scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner',
  });
  await mapProviderIdentity(sql, WS, { provider: 'slack', providerUserId: slackUserId, userId, mappedBy: 'owner' });
}

/** The stored copy, read as `userId`: the snippets of every organization hit for `query`. */
async function corpusHits(userId: string, query: string): Promise<string[]> {
  const out = await searchOrganizationDocuments(sql, { workspaceId: WS, role: ROLE }, {
    workspaceId: WS, principalUserId: userId, agentOwnerId: 'slack-pilot-it', query,
  });
  if (!out.allowed) throw new Error(`organization search refused: ${out.reason}`);
  return out.results.map((r) => r.snippet);
}

/** Live search, read as `userId` through the package's search.live and that person's own token. */
async function liveHits(userId: string, query: string) {
  const out = await searchLiveSources(sql, { workspaceId: WS, role: ROLE }, {
    workspaceId: WS, principalUserId: userId, agentOwnerId: 'slack-pilot-it', query,
    adapters: await providerLiveSearchAdapters(sql, { registry, fetchImpl: slackFetch }),
  });
  if (!out.allowed) throw new Error(`live search refused: ${out.reason}`);
  return out;
}

/** Each person pastes their own Slack user token (a per-principal credential, D-026). */
async function pasteUserToken(userId: string, token: string): Promise<void> {
  await fsTokenStorage.update(providerPrincipalStoreKey('slack', userId), HARNESS, { user_token: token });
}

function policyLayer(layerId: string, level: StoredPolicyLayer['level'], parentLayerId: string | null, rules: StoredPolicyLayer['rules']): StoredPolicyLayer {
  return {
    layerId, level, version: 1, rules, exceptions: [], scopeRef: level === 'workspace' ? WS : 'pilot-org',
    parentLayerId, contentHash: 'h', updatedBy: 'slack-pilot-it', updatedAt: '2026-10-13T00:00:00Z',
  };
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  const base = await getDatatype(sql, 'papercusp-workspace', 'chat-message');
  if (!base) throw new Error('slack_pilot_test_datatype_missing:chat-message');
  await upsertDatatype(sql, { ...base, workspaceId: WS, createdBy: 'slack-pilot-journeys' });

  expect(manifest.runtime.kind).toBe('daemon');
  runtime = await startDaemonProvider({
    pluginName: 'slack',
    pluginDir: PACKAGE_DIR,
    cmd: manifest.runtime.daemonCommand,
    declared: manifest.provider,
    healthIntervalMs: 0,
    callTimeoutMs: 15_000,
  });
  registry = createProviderRegistry();
  await registry.register({ descriptor: runtime.descriptor, adapter: runtime.adapter, pluginName: 'slack', runtime: 'daemon' });

  http = createServer(slackHandler());
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  httpPort = (http.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  await runtime?.shutdown();
  await new Promise<void>((r) => http?.close(() => r()));
  await org?.cleanup();
});

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'paperhome-slack-pilot-'));
  vi.stubEnv('PAPERCUSP_HOME', home);
  world = pilotWorld();
  apiCalls = [];
  // Every journey starts from an empty corpus, no identity mappings and no grants in its workspace.
  for (const table of ['provider_identity_mappings', 'personal_grants', 'documents', 'document_permission_lists'] as const) {
    await sql.unsafe(`DELETE FROM harness_shared.${table} WHERE workspace_id = $1`, [WS]);
  }
  alice = await newUser('alice');
  bob = await newUser('bob');
  // The owner pastes the app and bot tokens on the card (the P-001 credential store).
  await saveProviderCredentials(manifest.provider, HARNESS, { app_token: APP_TOKEN, bot_token: BOT_TOKEN });
});

afterEach(async () => {
  await sql`UPDATE harness_shared.data_sources SET status = 'disabled' WHERE workspace_id = ${WS}`;
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

// ── Journeys ────────────────────────────────────────────────────────────────

describe('Slack pilot: source ACL change and revocation (P-011)', () => {
  it('a member dropped from a channel loses its messages on the next membership refresh; others keep them', async () => {
    const sourceId = await orgSource();
    // Pass 1: the membership page (both channels, their members), then each channel's history.
    expect(await syncOnce(sourceId)).toMatchObject({ outcome: 'synced', hasMore: false, rejected: 0, membership: { applied: true, containers: 2 } });
    await rollupChatUnits(sql, WS);
    await enrol(alice, 'U0ALICE');
    await enrol(bob, 'U0BOB');

    // Each person reads exactly the channels Slack says they are in.
    expect(await corpusHits(alice, 'cobalt export')).toEqual([expect.stringContaining('cobalt export returns a 500')]);
    expect(await corpusHits(alice, 'orchid signing')).toEqual([]);
    expect(await corpusHits(bob, 'orchid signing')).toEqual([expect.stringContaining('orchid signing key')]);

    // alice leaves #bugs in Slack. The next pass refreshes membership before anything else.
    world.channels[0]!.members = ['U0BOB'];
    await due(sourceId);
    apiCalls = [];
    expect(await syncOnce(sourceId)).toMatchObject({ outcome: 'synced', membership: { applied: true, removed: 1 } });
    expect(apiCalls.map((c) => c.path)).toContain('/api/conversations.members');

    expect(await corpusHits(alice, 'cobalt export')).toEqual([]);
    // Revocation is per person: the message is still there for someone still in the channel.
    expect(await corpusHits(bob, 'cobalt export')).toEqual([expect.stringContaining('cobalt export returns a 500')]);
  });

  it('when the app leaves a channel, the stored copy of that channel loses every reader', async () => {
    const sourceId = await orgSource();
    await syncOnce(sourceId);
    await rollupChatUnits(sql, WS);
    await enrol(bob, 'U0BOB');
    expect(await corpusHits(bob, 'orchid signing')).toHaveLength(1);

    // The bot is removed from #ops: Slack stops listing it as a member channel.
    world.channels = world.channels.filter((c) => c.id !== 'C0OPS');
    await due(sourceId);
    expect(await syncOnce(sourceId)).toMatchObject({ outcome: 'synced', membership: { applied: true, containers: 1 } });
    expect(await corpusHits(bob, 'orchid signing')).toEqual([]);
    expect(await corpusHits(bob, 'cobalt export')).toHaveLength(1);
  });

  it('a channel the app left between listing and backfill is skipped, not retried forever', async () => {
    const sourceId = await orgSource();
    // Listed as a member channel, but by the time its history is read the bot is gone.
    world.channels.push({ id: 'C0GONE', name: 'gone', members: ['U0BOB'], messages: [] });
    world.historyGone.add('C0GONE');
    expect(await syncOnce(sourceId)).toMatchObject({ outcome: 'synced', hasMore: false });
    expect(apiCalls.filter((c) => c.path === '/api/conversations.history').map((c) => c.channel).sort()).toEqual(['C0BUGS', 'C0GONE', 'C0OPS']);
    expect(await health(sourceId)).toMatchObject({ status: 'connected', last_error: null, failure_count: 0, backfill_status: 'complete' });
  });

  it('live search acts as the searching person: Slack withholds a channel they left, and an unmapped person gets nothing', async () => {
    await orgSource('federated');
    await enrol(alice, 'U0ALICE');
    await pasteUserToken(alice, ALICE_TOKEN);

    const before = await liveHits(alice, 'cobalt');
    expect(before.failed).toEqual([]);
    expect(before.results).toEqual([expect.objectContaining({ externalId: 'C0BUGS:1712345678.000200', kind: 'live-hit' })]);
    // host.fetch injected alice's own user token, never the bot token.
    const searches = apiCalls.filter((c) => c.path === '/api/assistant.search.context');
    expect(searches.map((c) => c.authorization)).toEqual([`Bearer ${ALICE_TOKEN}`]);
    expect((await liveHits(alice, 'orchid')).results).toEqual([]);

    // alice leaves #bugs: Slack answers her own token with nothing from that channel.
    world.channels[0]!.members = ['U0BOB'];
    expect((await liveHits(alice, 'cobalt')).results).toEqual([]);

    // Her identity mapping is revoked: the host asks Slack nothing on her behalf.
    world.channels[0]!.members = ['U0ALICE', 'U0BOB'];
    await revokeProviderIdentityMapping(sql, WS, { provider: 'slack', providerUserId: 'U0ALICE', revokedBy: 'owner' });
    apiCalls = [];
    const revoked = await liveHits(alice, 'cobalt');
    expect(revoked).toMatchObject({ results: [], unmapped: ['slack'] });
    expect(apiCalls).toEqual([]);
  });
});

describe('Slack pilot: write authorization is separate from read (P-011, P-005)', () => {
  it('an inherited policy that denies chat:reply leaves sync and live search on the same source working', async () => {
    // The organization denies the Slack write; nothing below it re-allows it.
    const chain: ChainLoad = {
      status: 'ok',
      chain: [
        policyLayer('pilot-org', 'organization', null, { tools: { deny: ['chat:reply'] } }),
        policyLayer('pilot-dept', 'department', 'pilot-org', {}),
        policyLayer(WS, 'workspace', 'pilot-dept', {}),
      ],
    };
    const enforce = (toolName: string) => enforceInheritedPolicy(
      { toolName, capabilities: [], args: {}, boundary: 'dispatch', ctx: { workspaceId: WS } } as never,
      { loadChain: async () => chain, now: () => new Date('2026-10-14T00:00:00Z') },
    );

    // The write is refused at the dispatch seat, with the policy revision that refused it.
    const refusal = await enforce('chat:reply');
    expect(refusal).not.toBeNull();
    expect(JSON.stringify(refusal)).toContain('pilot-org@v1');
    // The read the pilot depends on is not.
    expect(await enforce('documents:search')).toBeNull();

    // Under the same policy the same organization's Slack source still syncs and is still searchable.
    const sourceId = await orgSource();
    expect(await syncOnce(sourceId)).toMatchObject({ outcome: 'synced', hasMore: false, admitted: 2 });
    await orgSource('federated');
    await enrol(alice, 'U0ALICE');
    await pasteUserToken(alice, ALICE_TOKEN);
    expect((await liveHits(alice, 'cobalt')).results).toHaveLength(1);
    // And nothing was posted to Slack by any of it.
    expect(apiCalls.some((c) => c.path === '/api/chat.postMessage')).toBe(false);
  });
});

describe('Slack pilot: retries and administrator health (P-011)', () => {
  it('a 429 keeps the uncommitted cursor and shows rate_limited; the next pass resumes where it stopped', async () => {
    const sourceId = await orgSource();
    // Interrupted after the membership page: both channels are queued for backfill.
    expect(await syncOnce(sourceId, { maxPagesPerSource: 1 })).toMatchObject({ outcome: 'synced', pages: 1, hasMore: true });
    const queued = (await health(sourceId)).provider_cursor;
    expect(JSON.parse(queued!)).toMatchObject({ queue: ['C0BUGS', 'C0OPS'] });

    // Slack rate-limits the history read with Retry-After: 30.
    world.rateLimitOnce.set('/api/conversations.history', 30);
    await due(sourceId);
    const rateLimited = await syncOnce(sourceId);
    // `error` rides along so a misclassified failure names itself in the assertion diff.
    expect({ outcome: rateLimited.outcome, pages: rateLimited.pages, admitted: rateLimited.admitted, error: rateLimited.error })
      .toMatchObject({ outcome: 'rate-limited', pages: 0, admitted: 0 });
    const limited = await health(sourceId);
    // A rate limit is Slack pacing us, not an unhealthy source: still connected, waiting it out.
    expect(limited).toMatchObject({ status: 'connected', provider_cursor: queued, failure_count: 1 });
    expect(limited.last_error).toMatch(/^rate_limited: /);
    expect(limited.next_in).toBeGreaterThan(20);
    expect(limited.next_in).toBeLessThanOrEqual(30);
    const limitedAdmin = await adminHealth(sourceId);
    expect(limitedAdmin).toMatchObject({
      scope: 'organization', scopeRef: null, permissionMode: 'source-acl', backfillStatus: 'running',
      status: 'connected', failureCount: 1, lastError: limited.last_error,
    });
    expect(limitedAdmin.lastSyncAt).toEqual(expect.any(String));
    expect(Date.parse(limitedAdmin.nextAttemptAt!)).toBeGreaterThan(Date.now());

    // The next pass resumes the queued backfill; membership is not re-walked first.
    await due(sourceId);
    apiCalls = [];
    expect(await syncOnce(sourceId)).toMatchObject({ outcome: 'synced', pages: 2, hasMore: false, admitted: 2 });
    expect(apiCalls.map((c) => `${c.path}:${c.channel ?? ''}`)).toEqual([
      '/api/conversations.history:C0BUGS',
      '/api/conversations.history:C0OPS',
    ]);
    expect(await health(sourceId)).toMatchObject({ status: 'connected', last_error: null, failure_count: 0, backfill_status: 'complete' });
    const recoveredAdmin = await adminHealth(sourceId);
    expect(recoveredAdmin).toMatchObject({ status: 'connected', lastError: null, failureCount: 0, backfillStatus: 'complete' });
    expect(Date.parse(recoveredAdmin.lastSyncAt!)).toBeGreaterThanOrEqual(Date.parse(limitedAdmin.lastSyncAt!));
    expect(Date.parse(recoveredAdmin.nextAttemptAt!)).toBeGreaterThan(Date.now());
  });

  it('a revoked bot token shows reconnect_required and stops retrying until the owner reconnects', async () => {
    const sourceId = await orgSource();
    await syncOnce(sourceId);
    world.botRevoked = true;
    await due(sourceId);
    const revoked = await syncOnce(sourceId);
    expect({ outcome: revoked.outcome, error: revoked.error }).toMatchObject({ outcome: 'reconnect-required' });
    const row = await health(sourceId);
    expect(row).toMatchObject({ status: 'error', next_in: null });
    expect(row.last_error).toMatch(/^reconnect_required: .*token_revoked/);
    expect(await adminHealth(sourceId)).toMatchObject({
      status: 'error', nextAttemptAt: null, failureCount: 1, lastError: row.last_error,
      scope: 'organization', permissionMode: 'source-acl', lastSyncAt: expect.any(String),
    });
  });
});

describe('Slack pilot: private reachability (P-011)', () => {
  it('is not applicable: the package reaches only slack.com, so no private-network path is needed', () => {
    // Disposition recorded for P-011's "private reachability" clause. If the package ever declares
    // another host (a self-hosted or private endpoint), this fails and the clause must be exercised.
    expect(manifest.provider.egressHosts).toEqual(['slack.com']);
  });
});
