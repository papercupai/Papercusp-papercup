/**
 * R-14 — GitHub issues as the second real provider on the integration contract
 * (plan generalized-integrations-google-migration-cupboard-workflows-2026-10-05, P-010 / D-015 / D-009).
 *
 * The REAL bundled package (`libs/papercusp/plugins/github-issues`) is discovered by the real
 * plugin loader and registered by the host's `registerPluginProviders`, exactly as any
 * third-party provider package would be. It is then driven by the ONE shared connector driver
 * (`runConnectorSync`) against recorded GitHub REST responses served through a `host.fetch`
 * stub, with the driver's DEFAULT sinks, so the routing under test is production routing:
 *
 *   - `ticket`               -> a record-nature work_items row (DSR-…), never agent work;
 *   - `ticket-status-change` -> an event-nature work_items row (DSE-…) linked to its ticket;
 *   - `ticket-comment`       -> a documents-corpus row in the source's scope (the owner's personal
 *                               corpus for a personal source; organization + permission list for
 *                               an organization source);
 *   - no ticket datatype reaches the personal Vault sink or an app sink (both route by datatype).
 *
 * Also: pull requests are skipped; a backfill then an incremental pass (GitHub `since`) update in
 * place; a replayed pass dedupes; a 429 keeps the uncommitted cursor; an interrupted pass resumes
 * from the committed page; the provider's only write is `ticket.comment` (linear-asana-task-sync
 * P-002, WI-10006212), posted through host.fetch with an update id equal to the comment sync's
 * nativeId, and every other write capability is reported unsupported (registry lookup, adapter
 * invoke, and record write-back dispatch).
 *
 * The drift detectors at the end pin D-015: the host routing/driver/write-back modules name no
 * provider, the package imports only node built-ins and its own manifest, and the bespoke GitHub
 * poller and its `system:github-issues-sync` routine are gone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, promises as fs, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import type { HostFetch, HostFetchResponse } from '@papercusp/plugin-sdk';
import { loadPlugins } from '@papercusp/plugin-loader';
import { stripCommentsOnly } from '../../../../../scripts/lib/strip-comments-and-strings.mjs';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { registerPluginProviders, type ProviderRegistrationFailure } from '../../plugin-host-runtime';
import {
  createProviderRegistry,
  providerRegistry,
  type ProviderRegistry,
  type RegisteredProvider,
} from '../../integrations/provider-registry';
import { descriptorConnectionAdapter, descriptorOAuthPlugin } from '../../integrations/connection-lifecycle';
import { saveProviderCredentials, syncProviderCredentialSource } from '../../integrations/provider-credentials';
import type { TokenStorage } from '../../oauth/token';
import { setTicketSourceConfig } from '../../integrations/ticket-integrations';
import { ingestExternalTriggerEvent, type IngestExternalTriggerInput } from '../../external-triggers/ingestion';
import { VAULT_DATATYPES } from '../../personal-vault/live-sink';
import { DATATYPE_FOR_APP } from '../../app-data-producer/app-rows';
import {
  dataSourceDocumentDedupeKey,
  dataSourceEventId,
  dataSourceRecordId,
} from '../../data-sources/datatype-destination-sink';
import {
  createRecordAdmissionSource,
  recordTransitionCapability,
  recordWriteBackCapability,
} from '../../work-admission/record-source';
import { runConnectorSync, type ConnectorSyncDeps, type ConnectorSourceOutcome } from '../connector-runtime';
import { mapProviderIdentity, searchOrganizationDocuments, ORGANIZATION_CORPUS_SCOPE } from '../../data-sources/documents-corpus';
import { createPersonalGrant } from '../../personal-vault/store';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql, ws: 'papercusp-workspace' }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
// createWorkItem / mergeWorkItemPayload read in the operator's active workspace; pin it to the
// workspace the migration-1332 ticket datatype rows live in.
vi.mock('../../workspace-registry', async (orig) => ({
  ...(await orig<typeof import('../../workspace-registry')>()),
  activeWorkspaceId: () => h.ws,
}));

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const PACKAGE_DIR = join(REPO_ROOT, 'libs/papercusp/plugins/github-issues');
const ROOT = join(tmpdir(), `papercusp-github-issues-it-${process.pid}-${Date.now()}`);

const WS = 'papercusp-workspace';
const HARNESS = 'papercusp';
const KIND = 'github-issues';
const OWNER = 'acme';
const REPO = 'orchid';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const TICKET_DATATYPES = ['ticket', 'ticket-status-change', 'ticket-comment'];
const DESTINATIONS = { ticket: ['record'], 'ticket-status-change': ['event'], 'ticket-comment': ['document'] };

let org: OrgTestDb;
let sql: Sql;
let alice: string;
let registry: ProviderRegistry;
let provider: RegisteredProvider;

// ── Recorded GitHub ─────────────────────────────────────────────────────────

interface Recorded {
  issues: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  comments: Array<Record<string, unknown>>;
  collaborators: Array<Record<string, unknown>>;
  collaboratorStatus?: number;
  /** Every request URL, in order. */
  calls: string[];
  /** Phase -> Retry-After seconds for the next request to that endpoint (consumed once). */
  rateLimitOnce: Map<string, number>;
}

let gh: Recorded;

function recorded(): Recorded {
  return {
    calls: [],
    rateLimitOnce: new Map(),
    collaborators: [{ id: 42, login: 'alice-gh' }],
    issues: [
      {
        id: 9001, number: 1, title: 'Orchid deploy fails on cold start', body: 'Steps to reproduce attached.',
        state: 'closed', state_reason: 'completed', user: { login: 'alice-gh' },
        assignees: [{ login: 'bob-gh' }], labels: ['bug', { name: 'p1' }],
        html_url: 'https://github.com/acme/orchid/issues/1',
        created_at: '2026-09-30T10:00:00Z', updated_at: '2026-10-01T09:00:00Z', closed_at: '2026-10-01T09:00:00Z',
      },
      {
        id: 9002, number: 2, title: 'Fix cold start', body: 'Closes #1', state: 'closed', user: { login: 'bob-gh' },
        pull_request: { url: `${API}/pulls/2` },
        created_at: '2026-09-30T11:00:00Z', updated_at: '2026-10-01T09:30:00Z',
      },
      {
        id: 9003, number: 3, title: 'Gazebo docs are stale', body: null, state: 'open', user: { login: 'bob-gh' },
        assignees: [], labels: [], created_at: '2026-10-01T08:00:00Z', updated_at: '2026-10-01T10:00:00Z',
      },
    ],
    // The events endpoint is newest first.
    events: [
      { id: 503, event: 'labeled', actor: { login: 'bob-gh' }, created_at: '2026-10-01T09:40:00Z', issue: { number: 3 } },
      {
        id: 502, event: 'closed', actor: { login: 'bob-gh' }, created_at: '2026-10-01T09:30:00Z',
        issue: { number: 2, pull_request: { url: 'x' } },
      },
      {
        id: 501, event: 'closed', state_reason: 'completed', actor: { login: 'alice-gh' },
        created_at: '2026-10-01T09:00:00Z', issue: { number: 1 },
      },
    ],
    comments: [
      {
        id: 101, issue_url: `${API}/issues/1`, body: 'orchid repro: the cache is cold after deploy',
        user: { login: 'bob-gh' }, html_url: 'https://github.com/acme/orchid/issues/1#issuecomment-101',
        created_at: '2026-10-01T08:30:00Z', updated_at: '2026-10-01T08:30:00Z',
      },
      {
        id: 102, issue_url: `${API}/issues/2`, body: 'lgtm', user: { login: 'alice-gh' },
        html_url: 'https://github.com/acme/orchid/pull/2#issuecomment-102',
        created_at: '2026-10-01T09:20:00Z', updated_at: '2026-10-01T09:20:00Z',
      },
    ],
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): HostFetchResponse {
  return { status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), bodyEncoding: 'utf8' };
}

/** Recorded GitHub REST, served through the provider's ONLY network path. */
const recordedHostFetch: HostFetch = async ({ request }) => {
  gh.calls.push(request.url);
  const url = new URL(request.url);
  const page = Number(url.searchParams.get('page') ?? '1');
  const since = url.searchParams.get('since');
  const fresh = (rows: Array<Record<string, unknown>>) =>
    since ? rows.filter((row) => Date.parse(String(row.updated_at)) >= Date.parse(since)) : rows;
  const phase = url.pathname.endsWith('/issues/events') ? 'events'
    : url.pathname.endsWith('/issues/comments') ? 'comments'
      : url.pathname.endsWith('/collaborators') ? 'collaborators'
      : url.pathname.endsWith('/issues') ? 'issues'
        : 'single';
  const retryAfter = gh.rateLimitOnce.get(phase);
  if (retryAfter !== undefined) {
    gh.rateLimitOnce.delete(phase);
    return json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'retry-after': String(retryAfter) });
  }
  if (phase === 'single') {
    const number = Number(url.pathname.split('/').pop());
    const issue = gh.issues.find((row) => row.number === number);
    return issue ? json(200, issue) : json(404, { message: 'Not Found' });
  }
  if (phase === 'collaborators') {
    return gh.collaboratorStatus
      ? json(gh.collaboratorStatus, { message: 'Not Found' })
      : json(200, gh.collaborators.slice((page - 1) * 100, page * 100));
  }
  if (page > 1) return json(200, []);
  if (phase === 'issues') return json(200, fresh(gh.issues));
  if (phase === 'comments') return json(200, fresh(gh.comments));
  return json(200, gh.events);
};

// ── Fixture plumbing ────────────────────────────────────────────────────────

/** Every event-bus emission is recorded instead of hitting the coord bus. */
async function ingest(db: Sql, input: IngestExternalTriggerInput) {
  return ingestExternalTriggerEvent(db, input, {
    emit: async (event) => ({ ok: true, key: event.key, woken: 0, notified: [], msgId: null, waiters: 0 }),
  });
}

function deps(overrides: Partial<ConnectorSyncDeps> = {}): ConnectorSyncDeps {
  // `sinksFor` is deliberately NOT overridden: the driver's default datatype routing is under test.
  return { registry, ingest, hostFetchFor: () => recordedHostFetch, leaseOwner: 'github-issues-it', ...overrides };
}

async function syncOne(sourceId: string, opts: { maxPagesPerSource?: number } = {}): Promise<ConnectorSourceOutcome> {
  const result = await runConnectorSync(
    sql,
    { workspaceId: WS, harness: HARNESS, sourceIds: [sourceId], pollIntervalSeconds: 300, ...opts },
    deps(),
  );
  expect(result.sources).toHaveLength(1);
  return result.sources[0]!;
}

async function createSource(scope: 'personal' | 'organization'): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources
      (workspace_id, kind, owner_user_id, provider_account_id, status, config, scope,
       destination_policy, permission_mapping)
    VALUES (${WS}, ${KIND}, ${alice}, ${`gh-account-${scope}-${Date.now()}`}, 'connected',
            ${sql.json({ owner: OWNER, repo: REPO, harnessSlug: HARNESS })}, ${scope},
            ${sql.json(DESTINATIONS)}, ${sql.json({ mode: scope === 'personal' ? 'owner' : 'source-acl' })})
    RETURNING id::text`;
  return row!.id;
}

/** Make a source due again (the driver respects its poll cadence). */
async function due(sourceId: string): Promise<void> {
  await sql`UPDATE harness_shared.data_sources SET sync_next_attempt_at = NULL WHERE id = ${sourceId}::uuid`;
}

async function cursorOf(sourceId: string): Promise<{ raw: Record<string, unknown> | null; backfill: string | null; status: string; nextIn: number | null }> {
  const [row] = await sql<Array<{ provider: string | null; backfill_status: string | null; status: string; next_in: number | null }>>`
    SELECT cursor->>'provider' AS provider, backfill_status, status,
           EXTRACT(EPOCH FROM (sync_next_attempt_at - now()))::int AS next_in
      FROM harness_shared.data_sources WHERE id = ${sourceId}::uuid`;
  return {
    raw: row!.provider ? (JSON.parse(row!.provider) as Record<string, unknown>) : null,
    backfill: row!.backfill_status,
    status: row!.status,
    nextIn: row!.next_in,
  };
}

interface Row {
  feature_id: string;
  kind: string;
  nature: string;
  agent_work: boolean;
  payload: Record<string, unknown>;
}

async function rows(sourceId: string): Promise<Row[]> {
  return sql<Row[]>`
    SELECT feature_id, item_kind AS kind, nature,
           harness_shared.work_item_is_agent_work(nature, audience, lane, needs_owner_action) AS agent_work, payload
      FROM harness_shared.work_items
     WHERE workspace_id = ${WS} AND payload->>'dataSourceId' = ${sourceId}
     ORDER BY item_kind, payload->>'externalId'`;
}

async function docs(sourceId: string) {
  return sql<Array<{
    kind: string; scope: string; user_id: string | null; external_id: string; dedupe_key: string;
    permission_list_id: string | null; text: string; metadata: Record<string, unknown>;
  }>>`
    SELECT kind, scope, user_id::text, external_id, dedupe_key, permission_list_id::text, text, metadata
      FROM harness_shared.documents
     WHERE workspace_id = ${WS} AND metadata->>'dataSourceId' = ${sourceId}
     ORDER BY external_id`;
}

/** Sink kinds the real delivery ledger recorded, per datatype (from the version-scoped dedupe key). */
async function sinkKindsByDatatype(sourceId: string): Promise<Record<string, string[]>> {
  const ledger = await sql<Array<{ datatype: string; sink_kind: string; outcome: string }>>`
    SELECT split_part(dedupe_key, ':', 3) AS datatype, sink_kind, outcome
      FROM harness_shared.trigger_deliveries
     WHERE workspace_id = ${WS} AND source_id = ${sourceId}::uuid`;
  for (const entry of ledger) expect({ ...entry, outcome: entry.outcome }).toMatchObject({ outcome: 'delivered' });
  const out: Record<string, Set<string>> = {};
  for (const { datatype, sink_kind } of ledger) (out[datatype] ??= new Set()).add(sink_kind);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
}

async function clean(): Promise<void> {
  const sources = await sql<{ id: string }[]>`
    SELECT id::text FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND kind = ${KIND}`;
  const ids = sources.map((s) => s.id);
  if (ids.length > 0) {
    await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS} AND payload->>'dataSourceId' = ANY(${sql.array(ids)}::text[])`;
    await sql`DELETE FROM harness_shared.documents WHERE workspace_id = ${WS} AND metadata->>'dataSourceId' = ANY(${sql.array(ids)}::text[])`;
    await sql`DELETE FROM harness_shared.document_permission_lists WHERE workspace_id = ${WS} AND source_ref = ANY(${sql.array(ids)}::text[])`;
    await sql`DELETE FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS} AND source_id = ANY(${sql.array(ids)}::uuid[])`;
  }
  await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND kind = ${KIND}`;
}

/** Discover the real package the way the host does: a project `plugins/` dir holding it. */
async function discoverRealPackage() {
  const projectDir = join(ROOT, 'project');
  const target = join(projectDir, 'plugins', 'github-issues');
  await fs.mkdir(target, { recursive: true });
  await fs.cp(PACKAGE_DIR, target, { recursive: true });
  const emptyGlobal = join(ROOT, 'no-global-plugins');
  await fs.mkdir(emptyGlobal, { recursive: true });
  return loadPlugins({ projectDir, harnessSlugs: [], globalPluginsDir: emptyGlobal });
}

beforeAll(async () => {
  await fs.mkdir(ROOT, { recursive: true });
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  const [a] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name) VALUES (${`github-issues-provider-${Date.now()}`}, 'alice') RETURNING id`;
  alice = a!.id;

  const { loaded, errors } = await discoverRealPackage();
  expect(errors).toEqual([]);
  registry = createProviderRegistry();
  const failures: ProviderRegistrationFailure[] = [];
  expect(await registerPluginProviders(loaded, (f) => failures.push(f), registry)).toEqual([KIND]);
  expect(failures).toEqual([]);
  provider = registry.get(KIND)!;
});

afterAll(async () => {
  if (org) await clean().catch(() => {});
  if (alice) await sql`DELETE FROM harness_shared.users WHERE id = ${alice}`.catch(() => {});
  await org?.cleanup();
  await fs.rm(ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  gh = recorded();
  await clean();
});

/**
 * WI-10006213: a source made by the generic OAuth connect path, then configured from Settings →
 * Integrations, syncs tickets with no hand-written SQL. Connect writes the provider's declared
 * `defaultDestinations`; the page sets the config keys the descriptor's configSchema declares.
 */
describe('a freshly connected source syncs tickets without hand-written SQL (WI-10006213)', () => {
  const policyOf = async (sourceId: string) => {
    const [row] = await sql<Array<{ policy: Record<string, unknown> }>>`
      SELECT destination_policy AS policy FROM harness_shared.data_sources WHERE id = ${sourceId}::uuid`;
    return row!.policy;
  };

  it('connect writes the default policy, the page sets owner/repo/harness, and the driver syncs', async () => {
    // The connection lifecycle resolves a credential group from the process registry.
    const live = providerRegistry();
    await live.register({ descriptor: provider.descriptor, adapter: provider.adapter, pluginName: provider.pluginName, runtime: provider.runtime });
    try {
      expect(provider.descriptor.defaultDestinations).toEqual(DESTINATIONS);
      const adapter = descriptorConnectionAdapter(descriptorOAuthPlugin(provider.descriptor));
      expect(adapter).not.toBeNull();
      const connect = () => adapter!.provision(sql, {
        owner: { workspaceId: WS, ownerUserId: alice, reconnectProviderAccountId: null },
        account: { providerAccountId: 'gh-fresh-account', displayName: 'octocat' },
        field: 'owner',
        createdBy: 'github-issues-it',
      });
      await connect();
      const [source] = await sql<Array<{ id: string; config: Record<string, unknown> }>>`
        SELECT id::text, config FROM harness_shared.data_sources
         WHERE workspace_id = ${WS} AND kind = ${KIND} AND owner_user_id = ${alice}::uuid`;
      const sourceId = source!.id;
      expect(source!.config).toEqual({ accountLabel: 'octocat' });
      expect(await policyOf(sourceId)).toEqual(DESTINATIONS);

      // GitHub's repo keys come from its configSchema; nothing hand-lists them.
      expect(await setTicketSourceConfig(
        sql,
        { workspaceId: WS, ownerUserId: alice, sourceId, patch: { owner: OWNER, repo: REPO, harnessSlug: HARNESS } },
        { registry },
      )).toEqual({ config: { accountLabel: 'octocat', owner: OWNER, repo: REPO, harnessSlug: HARNESS }, missingConfig: [] });
      // The connection owns the account label; the page may not set it.
      await expect(setTicketSourceConfig(
        sql, { workspaceId: WS, ownerUserId: alice, sourceId, patch: { accountLabel: 'x' } }, { registry },
      )).rejects.toThrow(/ticket_source_config_invalid/);

      const outcome = await syncOne(sourceId);
      expect(outcome).toMatchObject({ sourceId, outcome: 'synced', rejected: 0 });
      const synced = await rows(sourceId);
      expect(synced.filter((r) => r.kind === 'ticket').length).toBeGreaterThan(0);
      expect(synced.every((r) => r.agent_work === false)).toBe(true);
      expect(Object.keys(await sinkKindsByDatatype(sourceId)).sort()).toEqual([...TICKET_DATATYPES].sort());

      // A reconnect never overwrites a policy the owner edited...
      const edited = { ticket: ['record'] };
      await sql`UPDATE harness_shared.data_sources SET destination_policy = ${sql.json(edited)} WHERE id = ${sourceId}::uuid`;
      await connect();
      expect(await policyOf(sourceId)).toEqual(edited);
      // ...but fills a source that still has none.
      await sql`UPDATE harness_shared.data_sources SET destination_policy = '{}'::jsonb WHERE id = ${sourceId}::uuid`;
      await connect();
      expect(await policyOf(sourceId)).toEqual(DESTINATIONS);
    } finally {
      live.unregister(KIND);
    }
  });

  // cupboard-distributable-integrations-2026-10-10 P-010: GitHub is shown like any provider. The
  // generic Settings → Integrations card labels a connected account with the source's
  // accountLabel, which the generic connect derives from the package's declared identity
  // (oauth.identity: /user, idField id, displayNameField login). Nothing GitHub-specific runs.
  it('resolves the connected identity from the package\'s declared /user endpoint and labels the source with the login (P-010)', async () => {
    const live = providerRegistry();
    await live.register({ descriptor: provider.descriptor, adapter: provider.adapter, pluginName: provider.pluginName, runtime: provider.runtime });
    const requests: Array<{ url: string; method: string; authorization: string | null }> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({ url: String(input), method: init?.method ?? 'GET', authorization: headers.get('authorization') });
      // GitHub's /user answers a numeric id and the login.
      return new Response(JSON.stringify({ login: 'octocat', id: 583231, name: 'The Octocat' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    try {
      const adapter = descriptorConnectionAdapter(descriptorOAuthPlugin(provider.descriptor));
      expect(adapter).not.toBeNull();
      const account = await adapter!.resolveAccount('gho_fixture_access_token');
      expect(requests).toEqual([{ url: 'https://api.github.com/user', method: 'GET', authorization: 'Bearer gho_fixture_access_token' }]);
      expect(account).toEqual({ providerAccountId: '583231', displayName: 'octocat' });

      await adapter!.provision(sql, {
        owner: { workspaceId: WS, ownerUserId: alice, reconnectProviderAccountId: null },
        account,
        field: 'owner',
        createdBy: 'github-issues-it',
      });
      const [source] = await sql<Array<{ config: Record<string, unknown>; status: string }>>`
        SELECT config, status FROM harness_shared.data_sources
         WHERE workspace_id = ${WS} AND kind = ${KIND} AND owner_user_id = ${alice}::uuid`;
      expect(source).toMatchObject({ config: { accountLabel: 'octocat' }, status: 'connected' });
    } finally {
      vi.unstubAllGlobals();
      live.unregister(KIND);
    }
  });

  // D-016: a pasted personal access token gets the same label. The package declares the token for
  // api.github.com, which is its identity host, so the host asks /user with the token. A re-pasted
  // token for another account replaces the label; a token GitHub refuses still connects, with the
  // refusal recorded on the source; a token scoped to another host is never sent to /user.
  it('labels a personal-access-token connection with the token\'s login, re-labels on a new token, and records a refusal (P-010, D-016)', async () => {
    const store = new Map<string, Record<string, unknown>>();
    const storage: TokenStorage = {
      async read(plugin, harness) {
        return { ...(store.get(`${plugin}@${harness}`) ?? {}) };
      },
      async update(plugin, harness, patch) {
        const next = { ...(store.get(`${plugin}@${harness}`) ?? {}) };
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete next[key];
          else next[key] = value;
        }
        store.set(`${plugin}@${harness}`, next);
      },
    };
    const TOKEN_HARNESS = 'github-pat-it';
    const accounts: Record<string, { login: string; id: number }> = {
      ghp_fixtureOctocatAAAAAAAAAAAA: { login: 'octocat', id: 583231 },
      ghp_fixtureHubotBBBBBBBBBBBBBB: { login: 'hubot', id: 7 },
    };
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization');
      requests.push({ url: String(input), authorization });
      const account = accounts[(authorization ?? '').replace(/^Bearer /, '')];
      return account
        ? Response.json(account)
        : new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
    }) as typeof fetch;
    const descriptor = provider.descriptor;
    const owner = { workspaceId: WS, ownerUserId: alice };
    const paste = async (target: typeof descriptor, token: string) => {
      const statuses = await saveProviderCredentials(target, TOKEN_HARNESS, { personal_access_token: token }, { storage });
      return syncProviderCredentialSource(sql, owner, target, statuses, { harness: TOKEN_HARNESS, storage, fetchImpl });
    };
    const credentialSource = async () => {
      const [row] = await sql<Array<{ config: Record<string, unknown>; status: string; last_error: string | null }>>`
        SELECT config, status, last_error FROM harness_shared.data_sources
         WHERE workspace_id = ${WS} AND kind = ${KIND} AND owner_user_id = ${alice}::uuid
           AND credential_ref = ${`provider-setup:${KIND}`}`;
      return row;
    };

    expect(await paste(descriptor, 'ghp_fixtureOctocatAAAAAAAAAAAA')).toBe('connected');
    expect(requests).toEqual([{ url: 'https://api.github.com/user', authorization: 'Bearer ghp_fixtureOctocatAAAAAAAAAAAA' }]);
    expect(await credentialSource()).toMatchObject({ config: { accountLabel: 'octocat' }, status: 'connected', last_error: null });

    expect(await paste(descriptor, 'ghp_fixtureHubotBBBBBBBBBBBBBB')).toBe('connected');
    expect(await credentialSource()).toMatchObject({ config: { accountLabel: 'hubot' }, status: 'connected', last_error: null });

    expect(await paste(descriptor, 'ghp_fixtureRefusedCCCCCCCCCCCC')).toBe('connected');
    expect(await credentialSource()).toMatchObject({ status: 'connected', last_error: 'provider_github_issues_identity_401' });

    // A token declared for a different host is never sent to the identity endpoint.
    requests.length = 0;
    const otherHost = {
      ...descriptor,
      setup: { credentials: descriptor.setup!.credentials!.map((field) => ({ ...field, hosts: ['github.com'] })) },
    };
    expect(await paste(otherHost, 'ghp_fixtureOctocatAAAAAAAAAAAA')).toBe('connected');
    expect(requests).toEqual([]);
  });
});

// ── Registration ────────────────────────────────────────────────────────────

describe('GitHub issues registers as a provider through the plugin host (R-14)', () => {
  it('is a bundled package the production host discovers, with a non-mail datatype set and a read-and-comment subset', () => {
    // Production discovers bundled plugins at <repo>/libs/papercusp/plugins (findBundledPluginsParent).
    expect(existsSync(join(PACKAGE_DIR, 'papercusp.json'))).toBe(true);
    expect(provider.pluginName).toBe(KIND);
    expect(provider.runtime).toBe('js');
    expect(provider.descriptor.datatypes).toEqual(TICKET_DATATYPES);
    expect(provider.descriptor.datatypes.some((d) => d.startsWith('email') || d.startsWith('calendar'))).toBe(false);
    expect(provider.descriptor.capabilities).toEqual(['ticket.read', 'ticket.comment']);
    expect(provider.descriptor.egressHosts).toEqual(['api.github.com', 'github.com']);
  });

  it('posts ticket.comment through host.fetch only, with the comment sync’s nativeId as its update id', async () => {
    expect(registry.forDatatype('ticket', recordWriteBackCapability('ticket')).map((p) => p.descriptor.id)).toEqual([KIND]);
    const sourceId = await createSource('personal');
    const posted: Array<{ url: string; method: string | undefined; body: unknown }> = [];
    const writingFetch: HostFetch = async (input) => {
      const { request } = input;
      if (request.method === 'POST') {
        posted.push({ url: request.url, method: request.method, body: JSON.parse(String(request.body)) });
        return json(201, { id: 9001, html_url: `https://github.com/${OWNER}/${REPO}/issues/1#issuecomment-9001` });
      }
      return recordedHostFetch(input);
    };

    const result = await provider.adapter!.invoke(
      { source: sourceId, capability: 'ticket.comment', args: { externalId: `${OWNER}/${REPO}#1`, text: '  picked up  ' } },
      { fetch: writingFetch },
    );

    expect(result).toEqual({
      externalRef: `https://github.com/${OWNER}/${REPO}/issues/1#issuecomment-9001`,
      // readComments reports this same comment as nativeId `comment:<id>`: the host's echo key.
      updateId: 'comment:9001',
    });
    // Only the text is sent; nothing that would patch the issue's own fields.
    expect(posted).toEqual([{ url: `${API}/issues/1/comments`, method: 'POST', body: { body: 'picked up' } }]);

    // A GitHub write failure is named, not swallowed.
    await expect(provider.adapter!.invoke(
      { source: sourceId, capability: 'ticket.comment', args: { externalId: `${OWNER}/${REPO}#1`, text: 'x' } },
      { fetch: async () => json(403, { message: 'Resource not accessible by integration' }) },
    )).rejects.toThrow(`github_write_failed:403 ${API}/issues/1/comments`);
    await expect(provider.adapter!.invoke(
      { source: sourceId, capability: 'ticket.comment', args: { externalId: `${OWNER}/${REPO}#1`, text: '   ' } },
      { fetch: writingFetch },
    )).rejects.toThrow('ticket_comment_text_required');
    expect(posted).toHaveLength(1);
  });

  it('reports every other write capability unsupported: registry lookup, adapter invoke and record write-back', async () => {
    expect(registry.forDatatype('ticket', 'ticket.read').map((p) => p.descriptor.id)).toEqual([KIND]);
    expect(registry.forDatatype('ticket', recordTransitionCapability('ticket'))).toEqual([]);
    expect(registry.forDatatype('ticket', 'ticket.update')).toEqual([]);
    // R-14 (D-028): the declared subset is read + comment, so containers is undeclared too.
    expect(registry.forDatatype('ticket', 'ticket.containers')).toEqual([]);
    expect(provider.descriptor.capabilities).not.toContain('ticket.containers');

    const sourceId = await createSource('personal');
    // ticket.read is served, through host.fetch only.
    const read = (await provider.adapter!.invoke(
      { source: sourceId, capability: 'ticket.read', args: { externalId: `${OWNER}/${REPO}#3` } },
      { fetch: recordedHostFetch },
    )) as { ticket: Record<string, unknown> };
    expect(read.ticket).toMatchObject({ externalId: 'acme/orchid#3', title: 'Gazebo docs are stale', state: 'open', statusCategory: 'todo' });
    expect(gh.calls).toEqual([`${API}/issues/3`]);
    // A pull request is not a ticket.
    await expect(provider.adapter!.invoke(
      { source: sourceId, capability: 'ticket.read', args: { externalId: `${OWNER}/${REPO}#2` } },
      { fetch: recordedHostFetch },
    )).rejects.toThrow('ticket_not_found:acme/orchid#2');

    // Undeclared writes are refused by the adapter without a network call…
    gh.calls.length = 0;
    await expect(provider.adapter!.invoke(
      { source: sourceId, capability: 'ticket.transition', args: { externalId: `${OWNER}/${REPO}#1`, toCategory: 'done' } },
      { fetch: recordedHostFetch },
    )).rejects.toThrow('provider_capability_unsupported:ticket.transition');
    await expect(provider.adapter!.invoke(
      { source: sourceId, capability: 'ticket.containers', args: {} },
      { fetch: recordedHostFetch },
    )).rejects.toThrow('provider_capability_unsupported:ticket.containers');
    await expect(provider.adapter!.invoke(
      { source: sourceId, capability: 'ticket.update', args: { externalId: `${OWNER}/${REPO}#1`, title: 'x' } },
      { fetch: recordedHostFetch },
    )).rejects.toThrow('provider_capability_unsupported:ticket.update');
    expect(gh.calls).toEqual([]);
    // …and by the host's record write-back dispatch before any host.fetch is built.
    const hostFetchFor = vi.fn(() => recordedHostFetch);
    const recordSource = createRecordAdmissionSource({ registry, hostFetchFor });
    await expect(recordSource.transition!({
      db: sql as never,
      admission: {
        workspaceId: WS,
        dataSourceId: sourceId,
        sourceRef: { recordId: 'DSR-x', datatype: 'ticket', externalId: `${OWNER}/${REPO}#1` },
      } as never,
      toCategory: 'done',
    } as never)).rejects.toThrow(`provider_capability_unsupported:${KIND}:ticket.transition`);
    expect(hostFetchFor).not.toHaveBeenCalled();
    expect(gh.calls).toEqual([]);
    // The record write-back dispatch has exactly two write paths: writeBack (the declared
    // ticket.comment) and transition (refused above). ticket.update and ticket.containers have
    // no write-back route at all. A new route must fail here until it gets its own refusal case.
    expect(Object.keys(recordSource).sort()).toEqual(['kind', 'parseRef', 'resolve', 'transition', 'writeBack']);
  });
});

// ── Sync through the shared driver ──────────────────────────────────────────

describe('GitHub issues syncs through the shared connector driver (R-14)', () => {
  it('backfills tickets, status changes and comments, routed by datatype, skipping pull requests', async () => {
    const sourceId = await createSource('personal');
    const outcome = await syncOne(sourceId);
    // One pass = issues, events, comments, collaborators.
    expect(outcome).toMatchObject({ providerId: KIND, outcome: 'synced', mode: 'backfill', pages: 4, hasMore: false, rejected: 0 });
    // #1, #3 tickets + their two synthetic `opened` changes + the `closed` event on #1 + one comment.
    expect(outcome.admitted).toBe(6);
    expect((await cursorOf(sourceId))).toMatchObject({ backfill: 'complete', status: 'connected' });

    const stored = await rows(sourceId);
    expect(stored.map((r) => [r.kind, r.nature, r.agent_work, r.payload.externalId])).toEqual([
      ['ticket', 'record', false, 'acme/orchid#1'],
      ['ticket', 'record', false, 'acme/orchid#3'],
      ['ticket-status-change', 'event', false, '501'],
      ['ticket-status-change', 'event', false, 'opened:acme/orchid#1'],
      ['ticket-status-change', 'event', false, 'opened:acme/orchid#3'],
    ]);
    const ticket1 = stored.find((r) => r.payload.externalId === 'acme/orchid#1')!;
    expect(ticket1.feature_id).toBe(dataSourceRecordId(WS, sourceId, 'ticket', 'acme/orchid#1'));
    expect(ticket1.payload).toMatchObject({
      provider: 'github', container: 'acme/orchid', number: 1, state: 'closed', stateReason: 'completed',
      statusCategory: 'done', author: 'alice-gh', assignees: ['bob-gh'], labels: ['bug', 'p1'], closedAt: '2026-10-01T09:00:00.000Z',
      dataSourceId: sourceId,
    });
    const closed = stored.find((r) => r.payload.externalId === '501')!;
    expect(closed.feature_id).toBe(dataSourceEventId(WS, sourceId, 'ticket-status-change', 'event:501'));
    expect(closed.payload).toMatchObject({
      transition: 'closed', ticketExternalId: 'acme/orchid#1', ticketWorkItemId: ticket1.feature_id, actor: 'alice-gh',
    });
    // The pull request produced no ticket, no status change and no document.
    expect(stored.some((r) => JSON.stringify(r.payload).includes('acme/orchid#2'))).toBe(false);

    // The comment is a document in the owner's personal corpus.
    const comments = await docs(sourceId);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      kind: 'ticket-comment', scope: 'personal', user_id: alice, external_id: 'comment:101',
      permission_list_id: null, text: 'orchid repro: the cache is cold after deploy',
    });
    expect(comments[0]!.metadata).toMatchObject({ ticketExternalId: 'acme/orchid#1', ticketWorkItemId: ticket1.feature_id });

    // Routing by DATATYPE on the real delivery ledger: no ticket datatype reaches the personal Vault
    // sink or an app sink, though the source is personal and owned (both would attach for theirs).
    expect(TICKET_DATATYPES.some((d) => VAULT_DATATYPES.includes(d))).toBe(false);
    expect(VAULT_DATATYPES).toContain('email-message');
    expect(TICKET_DATATYPES.some((d) => Object.values(DATATYPE_FOR_APP).includes(d))).toBe(false);
    const sinks = await sinkKindsByDatatype(sourceId);
    expect(sinks.ticket).toEqual(expect.arrayContaining(['data-source-admission', 'data-source-record']));
    expect(sinks['ticket-status-change']).toEqual(expect.arrayContaining(['data-source-event']));
    expect(sinks['ticket-comment']).toEqual(expect.arrayContaining(['data-source-document']));
    for (const kinds of Object.values(sinks)) {
      expect(kinds).not.toContain('personal-vault');
      expect(kinds.filter((k) => k.startsWith('app'))).toEqual([]);
    }
  });

  it('an incremental pass updates in place; a replayed pass dedupes', async () => {
    const sourceId = await createSource('personal');
    await syncOne(sourceId);
    const firstRows = await rows(sourceId);

    gh.issues[2] = { ...gh.issues[2]!, title: 'Gazebo docs are stale (v2)', updated_at: '2026-10-01T11:00:00Z' };
    gh.events.unshift({
      id: 504, event: 'reopened', actor: { login: 'alice-gh' }, created_at: '2026-10-01T11:10:00Z', issue: { number: 1 },
    });
    gh.comments[0] = { ...gh.comments[0]!, body: 'orchid repro, edited', updated_at: '2026-10-01T11:05:00Z' };
    gh.calls.length = 0;
    await due(sourceId);

    const incremental = await syncOne(sourceId);
    expect(incremental).toMatchObject({ outcome: 'synced', mode: 'incremental', pages: 4, rejected: 0 });
    // The issues and comments reads carry the previous pass's watermark.
    expect(gh.calls[0]).toContain(`since=${encodeURIComponent('2026-10-01T10:00:00.000Z')}`);
    expect(gh.calls[2]).toContain(`since=${encodeURIComponent('2026-10-01T09:20:00.000Z')}`);

    const updated = await rows(sourceId);
    // One new event row; every pre-existing row keeps its id.
    expect(updated).toHaveLength(firstRows.length + 1);
    expect(firstRows.every((r) => updated.some((u) => u.feature_id === r.feature_id))).toBe(true);
    expect(updated.find((r) => r.payload.externalId === 'acme/orchid#3')!.payload.title).toBe('Gazebo docs are stale (v2)');
    const reopened = updated.find((r) => r.payload.externalId === '504')!;
    expect(reopened).toMatchObject({ kind: 'ticket-status-change', nature: 'event' });
    expect(reopened.payload).toMatchObject({ transition: 'reopened', ticketWorkItemId: dataSourceRecordId(WS, sourceId, 'ticket', 'acme/orchid#1') });
    const comments = await docs(sourceId);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.text).toBe('orchid repro, edited');

    // Replay: nothing changed remotely; GitHub's inclusive `since` re-reads the boundary objects,
    // and the version-scoped dedupe absorbs them.
    await due(sourceId);
    const replay = await syncOne(sourceId);
    expect(replay).toMatchObject({ outcome: 'synced', admitted: 0, rejected: 0 });
    expect(replay.deduped).toBeGreaterThan(0);
    expect(await rows(sourceId)).toHaveLength(updated.length);
    expect(await docs(sourceId)).toHaveLength(1);
  });

  it('a rate limit keeps the uncommitted cursor; an interrupted pass resumes from the committed page', async () => {
    const sourceId = await createSource('personal');
    // Interrupted: the driver is allowed one page, so only the issues page is admitted and committed.
    const first = await syncOne(sourceId, { maxPagesPerSource: 1 });
    expect(first).toMatchObject({ outcome: 'synced', pages: 1, hasMore: true });
    expect((await cursorOf(sourceId)).raw).toMatchObject({ phase: 'events', page: 1 });
    expect((await rows(sourceId)).filter((r) => r.kind === 'ticket')).toHaveLength(2);
    expect(await docs(sourceId)).toEqual([]);

    // The events read is rate limited: nothing is admitted and the cursor stays where it was.
    gh.rateLimitOnce.set('events', 120);
    gh.calls.length = 0;
    const limited = await syncOne(sourceId);
    expect(limited).toMatchObject({ outcome: 'rate-limited', pages: 0 });
    const afterLimit = await cursorOf(sourceId);
    expect(afterLimit.raw).toMatchObject({ phase: 'events', page: 1 });
    expect(afterLimit.nextIn).toBeGreaterThan(100);
    expect(afterLimit.nextIn).toBeLessThanOrEqual(120);
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]).toContain('/issues/events');

    // Resume: the pass continues from events; the committed issues page is never re-read.
    await due(sourceId);
    gh.calls.length = 0;
    const resumed = await syncOne(sourceId);
    expect(resumed).toMatchObject({ outcome: 'synced', pages: 3, hasMore: false });
    expect(gh.calls.some((url) => new URL(url).pathname.endsWith('/issues'))).toBe(false);
    expect((await cursorOf(sourceId))).toMatchObject({ backfill: 'complete' });
    expect(await rows(sourceId)).toHaveLength(5);
    expect(await docs(sourceId)).toHaveLength(1);
  });

  it('an organization-scope source writes comments to the organization corpus under a fail-closed permission list', async () => {
    const sourceId = await createSource('organization');
    await syncOne(sourceId);
    const comments = await docs(sourceId);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      kind: 'ticket-comment', scope: 'organization', user_id: null,
      dedupe_key: dataSourceDocumentDedupeKey('ticket-comment', sourceId, 'comment:101'),
    });
    expect(comments[0]!.permission_list_id).not.toBeNull();
    const members = await sql`
      SELECT provider, provider_user_id FROM harness_shared.document_permission_members
       WHERE list_id = ${comments[0]!.permission_list_id}::uuid`;
    expect(members).toEqual([{ provider: 'github', provider_user_id: '42' }]);
    await createPersonalGrant(sql, {
      workspaceId: WS, userId: alice, principalType: 'agent-role', principalId: 'meeting-prep',
      scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner',
    });
    await mapProviderIdentity(sql, WS, { provider: 'github', providerUserId: '42', userId: alice, mappedBy: 'owner' });
    const search = () => searchOrganizationDocuments(sql, { workspaceId: WS, role: 'meeting-prep' }, {
      workspaceId: WS, principalUserId: alice, agentOwnerId: 'github-issues-it', query: 'orchid repro',
    });
    expect(await search()).toMatchObject({ allowed: true, results: [expect.objectContaining({ externalId: 'comment:101' })] });
    // Replace, not union: the same user loses access on the next complete remote snapshot.
    gh.collaborators = [{ id: 99, login: 'bob-gh' }];
    await due(sourceId);
    await syncOne(sourceId);
    expect(await search()).toMatchObject({ allowed: true, results: [] });
  });

  it('commits paginated membership only when enumeration is complete, including after interruption', async () => {
    const sourceId = await createSource('organization');
    await syncOne(sourceId);
    const listId = (await docs(sourceId))[0]!.permission_list_id;
    gh.collaborators = Array.from({ length: 101 }, (_, id) => ({ id: id + 1000 }));
    await due(sourceId);
    const interrupted = await syncOne(sourceId, { maxPagesPerSource: 4 });
    expect(interrupted).toMatchObject({ outcome: 'synced', hasMore: true });
    expect((await cursorOf(sourceId)).raw).toMatchObject({ phase: 'collaborators', page: 2 });
    expect(await sql`SELECT provider_user_id FROM harness_shared.document_permission_members
      WHERE list_id = ${listId}::uuid`).toEqual([{ provider_user_id: '42' }]);
    await due(sourceId);
    expect(await syncOne(sourceId)).toMatchObject({ outcome: 'synced', hasMore: false, membership: { members: 101 } });
    expect(await sql`SELECT 1 FROM harness_shared.document_permission_members WHERE list_id = ${listId}::uuid`).toHaveLength(101);
  });

  it.each([403, 404])('clears prior membership when collaborator enumeration returns %s', async (status) => {
    const sourceId = await createSource('organization');
    await syncOne(sourceId);
    gh.collaboratorStatus = status;
    await due(sourceId);
    expect(await syncOne(sourceId)).toMatchObject({ outcome: 'synced', membership: { applied: true, members: 0, removed: 1 } });
    const comments = await docs(sourceId);
    expect(await sql`SELECT 1 FROM harness_shared.document_permission_members
      WHERE list_id = ${comments[0]!.permission_list_id}::uuid`).toHaveLength(0);
  });

  it('writes nothing for a datatype the source does not route to its nature', async () => {
    const sourceId = await createSource('personal');
    await sql`
      UPDATE harness_shared.data_sources
         SET destination_policy = ${sql.json({ 'ticket-comment': ['document'] })}
       WHERE id = ${sourceId}::uuid`;
    const outcome = await syncOne(sourceId);
    expect(outcome).toMatchObject({ outcome: 'synced', rejected: 0 });
    expect(await rows(sourceId)).toEqual([]);
    expect(await docs(sourceId)).toHaveLength(1);
  });
});

// ── D-015 drift detectors ───────────────────────────────────────────────────

const PROVIDER_TOKEN_AT_WORD_START = /(?<![A-Za-z0-9])(?:gmail|gcal|google|facebook|outlook|microsoft|github)/i;
const PROVIDER_TOKEN_AT_CAMEL_HUMP = /(?<=[a-z0-9])(?:Gmail|Gcal|Google|Facebook|Outlook|Microsoft|Git[Hh]ub)/;
const MODULE_SPECIFIER = /\b(?:require|import)\s*\(\s*['"`]([^'"`]+)['"`]|\bfrom\s+['"`]([^'"`]+)['"`]/g;

/** Lines of CODE (comments stripped) naming a provider. */
function providerNameLines(source: string, fileName: string): string[] {
  return stripCommentsOnly(source, fileName)
    .split('\n')
    .filter((line) => PROVIDER_TOKEN_AT_WORD_START.test(line) || PROVIDER_TOKEN_AT_CAMEL_HUMP.test(line))
    .map((line) => line.trim());
}

/** Module specifiers other than node built-ins and the package's own manifest. */
function foreignImports(source: string, fileName: string): string[] {
  const found: string[] = [];
  for (const match of stripCommentsOnly(source, fileName).matchAll(MODULE_SPECIFIER)) {
    const specifier = match[1] ?? match[2];
    if (!specifier || specifier.startsWith('node:') || specifier === './papercusp.json') continue;
    found.push(specifier);
  }
  return found;
}

/** Host modules on the GitHub record's path: driver, datatype routing, write-back. */
const HOST_PATH = [
  'packages/operator-core/lib/providers/connector-runtime.ts',
  'packages/operator-core/lib/data-sources/datatype-destination-sink.ts',
  'packages/operator-core/lib/work-admission/record-source.ts',
];

describe('D-015 drift detectors', () => {
  it('each detector fires on planted drift and stays quiet on a planted clean sample', () => {
    expect(providerNameLines("if (source.kind === 'github-issues') return ticketSink;", 'p.ts')).toHaveLength(1);
    expect(providerNameLines('const client = getOctokitForGitHub(token);', 'p.ts')).toHaveLength(1);
    expect(providerNameLines('// the github poller is gone\nconst sinks = await sinksFor(datatype);', 'c.ts')).toEqual([]);
    expect(foreignImports("const { db } = require('../../packages/operator-core/lib/db');", 'p.cjs')).toEqual([
      '../../packages/operator-core/lib/db',
    ]);
    expect(foreignImports("const o = require('@octokit/rest');", 'p.cjs')).toEqual(['@octokit/rest']);
    expect(foreignImports("const m = require('./papercusp.json');\nconst u = require('node:url');", 'c.cjs')).toEqual([]);
  });

  it('the host driver, datatype routing and write-back modules name no provider', () => {
    for (const path of HOST_PATH) {
      expect({ path, lines: providerNameLines(readFileSync(join(REPO_ROOT, path), 'utf8'), path) }).toEqual({ path, lines: [] });
    }
  });

  it('the package imports nothing but node built-ins and its own manifest', () => {
    const files = readdirSync(PACKAGE_DIR).sort();
    expect(files).toEqual(['index.cjs', 'papercusp.json']);
    expect(foreignImports(readFileSync(join(PACKAGE_DIR, 'index.cjs'), 'utf8'), 'index.cjs')).toEqual([]);
  });

  it('the bespoke GitHub poller, its routine action and the octokit write-back are gone', () => {
    // Positive control: the registry of routine actions is the side-effect import list, and it is
    // populated, so the missing import is a real absence rather than a moved file.
    const register = readFileSync(join(REPO_ROOT, 'packages/operator-core/lib/harness/routines/register-system-actions.ts'), 'utf8');
    expect(register.match(/^import '\.\.?\/[^']+';$/gm)?.length ?? 0).toBeGreaterThan(50);
    expect(register).toContain("import '../git-sync/git-sync-action';");
    expect(register).not.toContain('github-issues-sync');
    expect(existsSync(join(REPO_ROOT, 'packages/operator-core/lib/harness/routines/github-issues-sync-action.ts'))).toBe(false);
    expect(existsSync(join(REPO_ROOT, 'packages/operator-core/lib/data-sources/github-issues-connector.ts'))).toBe(false);
    const recordSource = readFileSync(join(REPO_ROOT, 'packages/operator-core/lib/work-admission/record-source.ts'), 'utf8');
    expect(recordSource).toContain('provider_capability_unsupported');
    expect(stripCommentsOnly(recordSource, 'record-source.ts')).not.toMatch(/octokit/i);
  });
});
