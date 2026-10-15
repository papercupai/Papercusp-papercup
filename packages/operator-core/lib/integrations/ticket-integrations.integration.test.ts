/**
 * Settings → Integrations backend against real Postgres (plan linear-asana-task-sync-2026-10-05
 * P-007, design D-014).
 *
 * The REAL Linear and Asana provider packages are discovered and registered the way the host does
 * it; the shared connector driver, its default datatype sinks, admission rules and their backfill
 * all run. Only the providers' HTTP responses are recorded (served through host.fetch).
 *
 * Properties under test:
 *   - the page lists exactly the registered ticket providers that declare OAuth, described from
 *     their descriptors (status mapping, required config, the existing OAuth start link returning
 *     to this page: a return path the OAuth start route accepts);
 *   - a source's whole life on the page: missing config reported, containers listed through the
 *     provider's `ticket.containers` with the credential read from the install that connected it,
 *     config saved (validated, made due, backoff lifted), synced by the real driver, a preset rule
 *     added that admits what the source already holds, then disabled; the counts follow;
 *   - every read and write is scoped to the signed-in owner (another owner's source is a 404);
 *   - bad config and bad rules are refused before anything is written;
 *   - a provider without `ticket.containers` is refused by name before any host.fetch exists.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import type { HostFetch, HostFetchResponse, ProviderAdapter, ProviderDescriptor } from '@papercusp/plugin-sdk';
import { loadPlugins } from '@papercusp/plugin-loader';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { registerPluginProviders, type ProviderRegistrationFailure } from '../plugin-host-runtime';
import { createProviderRegistry, type ProviderRegistry } from './provider-registry';
import { descriptorOAuthPlugin } from './connection-lifecycle';
import { ingestExternalTriggerEvent, type IngestExternalTriggerInput } from '../external-triggers/ingestion';
import { runConnectorSync } from '../providers/connector-runtime';
import { safeOAuthReturnPath } from '../oauth/return-path';
import {
  disableTicketSourceRule,
  INTEGRATIONS_SETTINGS_PATH,
  listTicketSourceContainers,
  setTicketSourceConfig,
  setTicketSourceRule,
  ticketIntegrationsOverview,
  TicketIntegrationError,
  type TicketIntegrationsDeps,
} from './ticket-integrations';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql, ws: 'papercusp-workspace' }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async (orig) => ({
  ...(await orig<typeof import('../workspace-registry')>()),
  activeWorkspaceId: () => h.ws,
}));

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ROOT = join(tmpdir(), `papercusp-ticket-integrations-it-${process.pid}-${Date.now()}`);

const WS = 'papercusp-workspace';
const HARNESS = 'papercusp';
const PERSON = 'su-ticket-integrations-test';
const DESTINATIONS = { ticket: ['record'], 'ticket-status-change': ['event'], 'ticket-comment': ['document'] };

let org: OrgTestDb;
let sql: Sql;
let alice: string;
let bob: string;
let registry: ProviderRegistry;

function json(status: number, body: unknown): HostFetchResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), bodyEncoding: 'utf8' };
}

// ── Fixture providers beside the real packages ──────────────────────────────

/** A ticket provider that connects through OAuth but cannot list its containers. */
const NO_CONTAINERS = 'ticket-oauth-fixture';
const noContainersDescriptor: ProviderDescriptor = {
  id: NO_CONTAINERS,
  contractVersion: 1,
  displayName: 'Fixture Tracker',
  datatypes: ['ticket'],
  capabilities: ['ticket.read'],
  oauth: {
    authorizeUrl: 'https://tracker.example.com/oauth/authorize',
    tokenUrl: 'https://tracker.example.com/oauth/token',
    scopes: ['read'],
    clientRegistrationRef: NO_CONTAINERS,
  },
  egressHosts: ['tracker.example.com'],
} as ProviderDescriptor;
const noContainersInvoke = vi.fn(async () => ({ containers: [] }));
const noContainersAdapter: ProviderAdapter = {
  describe: () => noContainersDescriptor,
  syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
  invoke: noContainersInvoke,
};

/** A ticket provider with no OAuth block: it is not connected from this page, so the page omits it. */
const NO_OAUTH = 'ticket-nooauth-fixture';
const noOAuthDescriptor: ProviderDescriptor = {
  id: NO_OAUTH,
  contractVersion: 1,
  datatypes: ['ticket'],
  capabilities: ['ticket.read'],
  egressHosts: ['nooauth.example.com'],
};
const noOAuthAdapter: ProviderAdapter = {
  describe: () => noOAuthDescriptor,
  syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
  invoke: async () => ({}),
};

// ── Recorded Linear (GraphQL) ───────────────────────────────────────────────

const LINEAR_API = 'https://api.linear.app/graphql';
const APP_USER = { id: 'u-app', name: 'papercusp', displayName: 'Papercusp' };
const BOB_USER = { id: 'u-bob', name: 'bob', displayName: 'Bob' };
const ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering' };
const OPS = { id: 'team-ops', key: 'OPS', name: 'Operations' };
const DOING = { id: 'eng-doing', name: 'In Progress', type: 'started', position: 3 };
const TODO = { id: 'eng-todo', name: 'Todo', type: 'unstarted', position: 2 };

function linearIssue(over: Record<string, unknown>): Record<string, unknown> {
  return {
    description: null, url: `https://linear.app/acme/issue/${String(over.identifier)}`, priority: 0, priorityLabel: 'No priority',
    estimate: null, dueDate: null, completedAt: null, canceledAt: null,
    createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T09:00:00.000Z',
    team: { id: ENG.id, key: ENG.key }, assignee: null, delegate: null, creator: BOB_USER, parent: null, project: null,
    labels: { nodes: [] }, history: { nodes: [] },
    ...over,
  };
}

/** Two issues in ENG: one delegated to the Papercusp app user, one not. */
const LINEAR_ISSUES = [
  linearIssue({ id: 'iss-1', identifier: 'ENG-1', number: 1, title: 'Cold start fails', state: DOING, assignee: BOB_USER, delegate: APP_USER }),
  linearIssue({ id: 'iss-2', identifier: 'ENG-2', number: 2, title: 'Flaky deploy check', state: TODO }),
];

const linearOps: string[] = [];
const recordedLinear: HostFetch = async ({ request }) => {
  expect(request.url).toBe(LINEAR_API);
  const { query } = JSON.parse(String(request.body)) as { query: string };
  const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? '?';
  linearOps.push(op);
  const connection = (field: string, nodes: unknown[], extra: Record<string, unknown> = {}) =>
    json(200, { data: { ...extra, [field]: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
  switch (op) {
    case 'PapercuspTeams':
      return connection('teams', [OPS, ENG]);
    case 'PapercuspIssues':
      // Connected as Papercusp's app user (actor=app), so `viewer` is that user (D-012).
      return connection('issues', LINEAR_ISSUES, { viewer: { id: APP_USER.id } });
    case 'PapercuspComments':
      return connection('comments', []);
    default:
      return json(400, { errors: [{ message: `unrecorded operation ${op}` }] });
  }
};

// ── Recorded Asana (REST) ───────────────────────────────────────────────────

const ASANA_API = 'https://app.asana.com/api/1.0';
const recordedAsana: HostFetch = async ({ request }) => {
  const url = new URL(request.url);
  expect(url.origin + url.pathname.slice(0, '/api/1.0'.length)).toBe(ASANA_API);
  expect(request.method ?? 'GET').toBe('GET');
  const path = url.pathname.slice('/api/1.0'.length);
  if (path === '/workspaces') return json(200, { data: [{ gid: 'ws-1', resource_type: 'workspace', name: 'Acme' }], next_page: null });
  if (path === '/projects' && url.searchParams.get('workspace') === 'ws-1') {
    return json(200, {
      data: [
        { gid: 'proj-eng', resource_type: 'project', name: 'Engineering' },
        { gid: 'proj-ops', resource_type: 'project', name: 'Operations' },
      ],
      next_page: null,
    });
  }
  if (path === '/projects/proj-eng/sections') {
    return json(200, {
      data: [
        { gid: 'sec-todo', resource_type: 'section', name: 'To do' },
        { gid: 'sec-doing', resource_type: 'section', name: 'Doing' },
      ],
      next_page: null,
    });
  }
  return json(404, { errors: [{ message: `unrecorded ${request.method ?? 'GET'} ${path}` }] });
};

// ── Fixture plumbing ────────────────────────────────────────────────────────

/** host.fetch builder that records what it was bound to and serves the recorded provider. */
function boundFetch(serve: HostFetch) {
  const bound: Array<{ workspaceId: string; providerId: string; sourceId: string; harness: string }> = [];
  const hostFetchFor: NonNullable<TicketIntegrationsDeps['hostFetchFor']> = vi.fn((_db, input) => {
    bound.push(input);
    return async (call: Parameters<HostFetch>[0]) => {
      // The host.fetch only ever serves the source it was bound to.
      expect(call.source).toBe(input.sourceId);
      return serve(call);
    };
  });
  return { bound, hostFetchFor };
}

async function ingest(db: Sql, input: IngestExternalTriggerInput) {
  return ingestExternalTriggerEvent(db, input, {
    emit: async (event) => ({ ok: true, key: event.key, woken: 0, notified: [], msgId: null, waiters: 0 }),
  });
}

async function createSource(kind: string, owner: string, config: Record<string, unknown>): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources
      (workspace_id, kind, owner_user_id, provider_account_id, status, config, scope,
       destination_policy, permission_mapping)
    VALUES (${WS}, ${kind}, ${owner}, ${`${kind}-account-${owner}-${Date.now()}-${Math.random()}`}, 'connected',
            ${sql.json(config as never)}, 'personal',
            ${sql.json(DESTINATIONS)}, ${sql.json({ mode: 'owner' })})
    RETURNING id::text`;
  return row!.id;
}

async function configOf(sourceId: string): Promise<Record<string, unknown>> {
  const [row] = await sql<Array<{ config: Record<string, unknown> }>>`
    SELECT config FROM harness_shared.data_sources WHERE id = ${sourceId}::uuid`;
  return row!.config;
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; status: number } | string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    if (error instanceof TicketIntegrationError) return { code: error.code, status: error.status };
    return String(error);
  }
}

async function clean(): Promise<void> {
  const owners = [alice, bob].filter(Boolean);
  if (owners.length === 0) return;
  const sources = await sql<{ id: string }[]>`
    SELECT id::text FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND owner_user_id = ANY(${sql.array(owners)}::uuid[])`;
  const ids = sources.map((s) => s.id);
  if (ids.length > 0) {
    await sql`DELETE FROM harness_shared.admission_write_backs WHERE workspace_id = ${WS} AND data_source_id = ANY(${sql.array(ids)}::uuid[])`;
    await sql`
      DELETE FROM harness_shared.work_items w
       USING harness_shared.work_admissions a
       WHERE a.workspace_id = ${WS} AND w.workspace_id = a.workspace_id AND w.feature_id = a.work_item_id
         AND a.data_source_id = ANY(${sql.array(ids)}::uuid[])`;
    await sql`DELETE FROM harness_shared.work_admissions WHERE workspace_id = ${WS} AND data_source_id = ANY(${sql.array(ids)}::uuid[])`;
    await sql`DELETE FROM harness_shared.admission_rules WHERE workspace_id = ${WS} AND data_source_id = ANY(${sql.array(ids)}::uuid[])`;
    await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS} AND payload->>'dataSourceId' = ANY(${sql.array(ids)}::text[])`;
    await sql`DELETE FROM harness_shared.documents WHERE workspace_id = ${WS} AND metadata->>'dataSourceId' = ANY(${sql.array(ids)}::text[])`;
    await sql`DELETE FROM harness_shared.document_permission_lists WHERE workspace_id = ${WS} AND source_ref = ANY(${sql.array(ids)}::text[])`;
    await sql`DELETE FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS} AND source_id = ANY(${sql.array(ids)}::uuid[])`;
  }
  await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND owner_user_id = ANY(${sql.array(owners)}::uuid[])`;
}

beforeAll(async () => {
  await fs.mkdir(ROOT, { recursive: true });
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  const users = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${`ticket-integrations-alice-${Date.now()}`}, 'alice'), (${`ticket-integrations-bob-${Date.now()}`}, 'bob')
    RETURNING id`;
  alice = users[0]!.id;
  bob = users[1]!.id;

  // The real packages, discovered from a project `plugins/` dir the way the host does it.
  const projectDir = join(ROOT, 'project');
  for (const name of ['linear', 'asana']) {
    const source = join(REPO_ROOT, 'libs/papercusp/plugins', name);
    const target = join(projectDir, 'plugins', name);
    await fs.mkdir(target, { recursive: true });
    await fs.cp(source, target, { recursive: true });
  }
  const emptyGlobal = join(ROOT, 'no-global-plugins');
  await fs.mkdir(emptyGlobal, { recursive: true });
  const { loaded, errors } = await loadPlugins({ projectDir, harnessSlugs: [], globalPluginsDir: emptyGlobal });
  expect(errors).toEqual([]);
  registry = createProviderRegistry();
  const failures: ProviderRegistrationFailure[] = [];
  expect((await registerPluginProviders(loaded, (f) => failures.push(f), registry)).sort()).toEqual(['asana', 'linear']);
  expect(failures).toEqual([]);
  // register() runs the production descriptor validator and throws on an invalid descriptor.
  await registry.register({ descriptor: noContainersDescriptor, adapter: noContainersAdapter, pluginName: NO_CONTAINERS, runtime: 'js' } as never);
  await registry.register({ descriptor: noOAuthDescriptor, adapter: noOAuthAdapter, pluginName: NO_OAUTH, runtime: 'js' } as never);
});

afterAll(async () => {
  if (org) await clean().catch(() => {});
  if (alice) await sql`DELETE FROM harness_shared.users WHERE id = ANY(${sql.array([alice, bob])}::uuid[])`.catch(() => {});
  await org?.cleanup();
  await fs.rm(ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  await clean();
  linearOps.length = 0;
  noContainersInvoke.mockClear();
});

const ALICE = () => ({ workspaceId: WS, ownerUserId: alice });

describe('the providers Settings → Integrations offers (D-014.1, D-014.2)', () => {
  it('lists exactly the registered OAuth ticket providers, described from their descriptors', async () => {
    const overview = await ticketIntegrationsOverview(sql, ALICE(), { registry });
    // Sorted by display name; the provider without an OAuth block is not offered.
    expect(overview.providers.map((p) => [p.id, p.displayName])).toEqual([
      ['asana', 'Asana'],
      [NO_CONTAINERS, 'Fixture Tracker'],
      ['linear', 'Linear'],
    ]);
    const byId = new Map(overview.providers.map((p) => [p.id, p]));
    expect(byId.get('linear')).toMatchObject({
      canListContainers: true, statusMapping: 'provider-defined', requiredConfig: ['teamIds'],
    });
    // Asana's config takes a section mapping the user edits; Linear's own state types decide.
    expect(byId.get('asana')).toMatchObject({
      canListContainers: true, statusMapping: 'sections', requiredConfig: ['projectGids'],
    });
    expect(byId.get(NO_CONTAINERS)).toMatchObject({ canListContainers: false, requiredConfig: [] });
    expect(overview.sources).toEqual([]);
  });

  it('connects through the existing OAuth start route and returns to this page', async () => {
    const { providers } = await ticketIntegrationsOverview(sql, ALICE(), { registry });
    for (const provider of providers) {
      // Every fixture provider here declares OAuth, so each one offers a Connect link.
      expect(provider.connectHref).toEqual(expect.any(String));
      const href = new URL(provider.connectHref ?? '', 'http://operator.local');
      expect(href.pathname).toBe('/api/oauth/start');
      const plugin = descriptorOAuthPlugin(registry.get(provider.id)!.descriptor);
      expect(Object.fromEntries(href.searchParams)).toEqual({
        provider: plugin, plugin, harness: HARNESS, field: 'owner', return: INTEGRATIONS_SETTINGS_PATH,
      });
      // The start route keeps only a safe internal return path; this one survives it unchanged.
      expect(safeOAuthReturnPath(href.searchParams.get('return'))).toBe(INTEGRATIONS_SETTINGS_PATH);
    }
  });
});

describe('a Linear source from connect to admitted work (D-014.3 – D-014.5)', () => {
  it('reports missing config, lists teams, saves config, syncs, admits by preset, and counts it all', async () => {
    // As the connect flow leaves it: an account label, the install that holds the token, a target
    // harness for admitted work, and no teams yet.
    const sourceId = await createSource('linear', alice, {
      accountLabel: 'Acme', installSlug: 'install-a', harnessSlug: 'target-harness', providerState: 'opaque',
    });
    // A source that failed for lack of config is backing off.
    await sql`
      UPDATE harness_shared.data_sources
         SET sync_next_attempt_at = now() + interval '1 hour', sync_failure_count = 3
       WHERE id = ${sourceId}::uuid`;

    let [source] = (await ticketIntegrationsOverview(sql, ALICE(), { registry })).sources;
    expect(source).toMatchObject({
      id: sourceId, provider: 'linear', accountLabel: 'Acme', status: 'connected',
      missingConfig: ['teamIds'], mirrored: 0, admitted: 0, rules: [], failureCount: 3,
      // Only the page's own keys and the account label are reported, never other config.
      config: { accountLabel: 'Acme', harnessSlug: 'target-harness' },
    });

    // The team picker: Linear's teams through the real package, sorted by name.
    const linearFetch = boundFetch(recordedLinear);
    const teams = await listTicketSourceContainers(sql, { ...ALICE(), sourceId }, { registry, hostFetchFor: linearFetch.hostFetchFor });
    expect(teams).toEqual({
      truncated: false,
      containers: [
        { id: ENG.id, name: ENG.name, kind: 'team', key: ENG.key },
        { id: OPS.id, name: OPS.name, kind: 'team', key: OPS.key },
      ],
    });
    // Bound to this source alone, with the token read from the install that connected it, never
    // from the admission target harness (WI-10006662).
    expect(linearFetch.bound).toEqual([{ workspaceId: WS, providerId: 'linear', sourceId, harness: 'install-a' }]);
    expect(linearOps).toEqual(['PapercuspTeams']);

    // Saving the team makes the source complete and due now, with its backoff lifted.
    expect(await setTicketSourceConfig(sql, { ...ALICE(), sourceId, patch: { teamIds: [ENG.id] } }, { registry })).toEqual({
      config: { accountLabel: 'Acme', harnessSlug: 'target-harness', teamIds: [ENG.id] },
      missingConfig: [],
    });
    const [due] = await sql<Array<{ wake: Date | null; next: Date | null; installSlug: string | null; providerState: string | null }>>`
      SELECT sync_wake_requested_at AS wake, sync_next_attempt_at AS next,
             config->>'installSlug' AS "installSlug", config->>'providerState' AS "providerState"
        FROM harness_shared.data_sources WHERE id = ${sourceId}::uuid`;
    expect(due).toMatchObject({ next: null, installSlug: 'install-a', providerState: 'opaque' });
    expect(due!.wake).toBeInstanceOf(Date);

    // The real driver syncs it with the saved config.
    linearOps.length = 0;
    const result = await runConnectorSync(
      sql,
      { workspaceId: WS, harness: HARNESS, sourceIds: [sourceId] },
      { registry, ingest, hostFetchFor: () => recordedLinear, leaseOwner: 'ticket-integrations-it' },
    );
    expect(result.sources).toEqual([expect.objectContaining({ sourceId, outcome: 'synced', rejected: 0 })]);
    expect(linearOps).toContain('PapercuspIssues');
    [source] = (await ticketIntegrationsOverview(sql, ALICE(), { registry })).sources;
    expect(source).toMatchObject({ mirrored: 2, admitted: 0, missingConfig: [] });
    expect(source!.lastSyncAt).not.toBeNull();

    // "Delegated to Papercusp" admits the delegated issue already held, and only it.
    const set = await setTicketSourceRule(
      sql,
      { ...ALICE(), sourceId, preset: 'delegated-to-papercusp', harness: HARNESS, createdBy: PERSON },
      { registry },
    );
    expect(set.rule).toMatchObject({
      dataSourceId: sourceId, title: 'Delegated to Papercusp', harness: HARNESS, workKind: 'change', enabled: true,
      match: { selfRoles: { contains: 'delegate' } },
    });
    expect(set.backfill).toMatchObject({ scanned: 2, admitted: 1, refused: [] });
    [source] = (await ticketIntegrationsOverview(sql, ALICE(), { registry })).sources;
    expect(source).toMatchObject({ mirrored: 2, admitted: 1 });
    expect(source!.rules.map((r) => [r.id, r.enabled])).toEqual([[set.rule.id, true]]);

    // A value preset names its value in the title.
    const label = await setTicketSourceRule(
      sql,
      { ...ALICE(), sourceId, preset: 'label', value: 'papercusp', harness: HARNESS, workKind: 'task', createdBy: PERSON },
      { registry },
    );
    expect(label.rule).toMatchObject({ title: 'Label: papercusp', workKind: 'task', match: { labels: { contains: 'papercusp' } } });

    // Disabling keeps the rule (admissions name it) and the page still shows it, off.
    expect(await disableTicketSourceRule(sql, { ...ALICE(), sourceId, ruleId: set.rule.id }, { registry }))
      .toMatchObject({ id: set.rule.id, enabled: false });
    [source] = (await ticketIntegrationsOverview(sql, ALICE(), { registry })).sources;
    expect(source!.rules.map((r) => [r.id, r.enabled])).toEqual([[set.rule.id, false], [label.rule.id, true]]);
    expect(source!.admitted).toBe(1);
  });
});

describe('Asana: projects with their sections, and the section mapping (D-011, D-014.3)', () => {
  it('lists workspaces and projects, with sections for the configured projects', async () => {
    const sourceId = await createSource('asana', alice, { workspaceGid: 'ws-1', projectGids: ['proj-eng'] });
    const asanaFetch = boundFetch(recordedAsana);
    expect(await listTicketSourceContainers(sql, { ...ALICE(), sourceId }, { registry, hostFetchFor: asanaFetch.hostFetchFor })).toEqual({
      truncated: false,
      containers: [
        { id: 'ws-1', name: 'Acme', kind: 'workspace' },
        {
          id: 'proj-eng', name: 'Engineering', kind: 'project', parentId: 'ws-1',
          sections: [{ id: 'sec-todo', name: 'To do' }, { id: 'sec-doing', name: 'Doing' }],
        },
        { id: 'proj-ops', name: 'Operations', kind: 'project', parentId: 'ws-1' },
      ],
    });
    // No installSlug on this source: the default install holds its token.
    expect(asanaFetch.bound).toEqual([{ workspaceId: WS, providerId: 'asana', sourceId, harness: HARNESS }]);
  });

  it('saves a section mapping onto the canonical columns and refuses a column that does not exist', async () => {
    const sourceId = await createSource('asana', alice, { workspaceGid: 'ws-1', projectGids: ['proj-eng'], harnessSlug: 'target-harness' });
    expect(await setTicketSourceConfig(sql, { ...ALICE(), sourceId, patch: { sectionCategories: { 'sec-doing': 'in-progress' } } }, { registry }))
      .toEqual({
        config: { workspaceGid: 'ws-1', projectGids: ['proj-eng'], harnessSlug: 'target-harness', sectionCategories: { 'sec-doing': 'in-progress' } },
        missingConfig: [],
      });
    expect(await refusal(setTicketSourceConfig(sql, { ...ALICE(), sourceId, patch: { sectionCategories: { 'sec-doing': 'shipped' } } }, { registry })))
      .toEqual({ code: 'ticket_source_config_invalid', status: 400 });
    expect(await configOf(sourceId)).toEqual({
      workspaceGid: 'ws-1', projectGids: ['proj-eng'], harnessSlug: 'target-harness', sectionCategories: { 'sec-doing': 'in-progress' },
    });
  });
});

describe('every read and write is scoped to the signed-in owner', () => {
  it('another owner’s source is invisible and every action on it is a 404 that changes nothing', async () => {
    const bobs = await createSource('linear', bob, { teamIds: [OPS.id] });
    const mine = await createSource('linear', alice, {});
    expect((await ticketIntegrationsOverview(sql, ALICE(), { registry })).sources.map((s) => s.id)).toEqual([mine]);
    expect((await ticketIntegrationsOverview(sql, { workspaceId: WS, ownerUserId: bob }, { registry })).sources.map((s) => s.id)).toEqual([bobs]);

    const fetch = boundFetch(recordedLinear);
    const notFound = { code: 'ticket_source_not_found', status: 404 };
    expect(await refusal(listTicketSourceContainers(sql, { ...ALICE(), sourceId: bobs }, { registry, hostFetchFor: fetch.hostFetchFor }))).toEqual(notFound);
    expect(await refusal(setTicketSourceConfig(sql, { ...ALICE(), sourceId: bobs, patch: { teamIds: [ENG.id] } }, { registry }))).toEqual(notFound);
    expect(await refusal(setTicketSourceRule(sql, { ...ALICE(), sourceId: bobs, preset: 'delegated-to-papercusp', harness: HARNESS, createdBy: PERSON }, { registry })))
      .toEqual(notFound);
    expect(await refusal(disableTicketSourceRule(sql, { ...ALICE(), sourceId: bobs, ruleId: '00000000-0000-4000-8000-000000000001' }, { registry })))
      .toEqual(notFound);
    // A malformed id is the same 404, never a database error.
    expect(await refusal(setTicketSourceConfig(sql, { ...ALICE(), sourceId: 'not-a-uuid', patch: {} }, { registry }))).toEqual(notFound);

    expect(fetch.hostFetchFor).not.toHaveBeenCalled();
    expect(await configOf(bobs)).toEqual({ teamIds: [OPS.id] });
    const [rules] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.admission_rules WHERE workspace_id = ${WS} AND data_source_id = ${bobs}::uuid`;
    expect(rules!.n).toBe(0);
  });

  it('a source of a provider the page does not offer is not listed and cannot be configured here', async () => {
    const sourceId = await createSource(NO_OAUTH, alice, {});
    expect((await ticketIntegrationsOverview(sql, ALICE(), { registry })).sources).toEqual([]);
    expect(await refusal(setTicketSourceConfig(sql, { ...ALICE(), sourceId, patch: {} }, { registry })))
      .toEqual({ code: 'ticket_provider_not_registered', status: 409 });
  });

  // P-005 attempt 9 (cupboard-distributable-integrations-2026-10-10): the overview listed only
  // ticket providers' accounts, so the account a credentials-only provider's saved token created
  // never appeared on its card. Its own registry keeps the offered-provider list above exact.
  it('a credentials-only provider’s account exposes its declared source config without gaining ticket actions', async () => {
    const CREDS_ONLY = 'chat-credentials-fixture';
    const credsDescriptor = {
      id: CREDS_ONLY,
      contractVersion: 1,
      displayName: 'Fixture Chat',
      datatypes: ['chat-message'],
      capabilities: ['chat.send'],
      egressHosts: ['chat.example.com'],
      setup: { credentials: [{ key: 'bot_token', label: 'Bot token' }] },
      configSchema: { type: 'object', required: ['channelId'], properties: { channelId: { type: 'string', minLength: 1 } }, additionalProperties: true },
    } as ProviderDescriptor;
    const credsAdapter: ProviderAdapter = {
      describe: () => credsDescriptor,
      syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
      invoke: async () => ({}),
    };
    const credsRegistry = createProviderRegistry();
    await credsRegistry.register({ descriptor: credsDescriptor, adapter: credsAdapter, pluginName: CREDS_ONLY, runtime: 'js' } as never);
    await credsRegistry.register({ descriptor: noOAuthDescriptor, adapter: noOAuthAdapter, pluginName: NO_OAUTH, runtime: 'js' } as never);
    const sourceId = await createSource(CREDS_ONLY, alice, {});
    await createSource(NO_OAUTH, alice, {});

    const overview = await ticketIntegrationsOverview(sql, ALICE(), { registry: credsRegistry });
    expect(overview.providers.map((p) => p.id)).toEqual([CREDS_ONLY]);
    // Listed with its account; no ticket scope, so no config to report or demand.
    expect(overview.sources).toHaveLength(1);
    expect(overview.sources[0]).toMatchObject({
      id: sourceId, provider: CREDS_ONLY, config: {}, missingConfig: ['channelId', 'harnessSlug'], mirrored: 0, admitted: 0, rules: [],
    });
    expect(overview.providers[0].sourceConfigSchema).toMatchObject({ required: ['channelId', 'harnessSlug'] });
    expect(await refusal(setTicketSourceConfig(sql, { ...ALICE(), sourceId, patch: { channelId: 42 } }, { registry: credsRegistry })))
      .toEqual({ code: 'ticket_source_config_invalid', status: 400 });
    expect(await setTicketSourceConfig(sql, { ...ALICE(), sourceId, patch: { channelId: 'channel-1', harnessSlug: 'target-harness' } }, { registry: credsRegistry }))
      .toEqual({ config: { channelId: 'channel-1', harnessSlug: 'target-harness' }, missingConfig: [] });
    expect((await ticketIntegrationsOverview(sql, ALICE(), { registry: credsRegistry })).sources[0].config)
      .toEqual({ channelId: 'channel-1', harnessSlug: 'target-harness' });
    expect(await refusal(setTicketSourceConfig(sql, { workspaceId: WS, ownerUserId: bob, sourceId, patch: { channelId: 'other' } }, { registry: credsRegistry })))
      .toEqual({ code: 'ticket_source_not_found', status: 404 });
    expect(await refusal(listTicketSourceContainers(sql, { ...ALICE(), sourceId }, { registry: credsRegistry })))
      .toEqual({ code: 'ticket_provider_not_registered', status: 409 });
  });
});

describe('bad input is refused before anything is written', () => {
  it('config: only the page’s keys, validated against the descriptor; null removes a key', async () => {
    const sourceId = await createSource('linear', alice, { harnessSlug: 'target-harness', providerState: 'opaque' });
    const invalid = { code: 'ticket_source_config_invalid', status: 400 };
    // A key the page does not own (the connect flow's install, a provider's state) is not settable.
    expect(await refusal(setTicketSourceConfig(sql, { ...ALICE(), sourceId, patch: { installSlug: 'other' } }, { registry }))).toEqual(invalid);
    // The descriptor's schema: teamIds is a non-empty array of strings.
    expect(await refusal(setTicketSourceConfig(sql, { ...ALICE(), sourceId, patch: { teamIds: ENG.id } }, { registry }))).toEqual(invalid);
    expect(await refusal(setTicketSourceConfig(sql, { ...ALICE(), sourceId, patch: { teamIds: [] } }, { registry }))).toEqual(invalid);
    expect(await refusal(setTicketSourceConfig(sql, { ...ALICE(), sourceId, patch: [] as never }, { registry }))).toEqual(invalid);
    expect(await configOf(sourceId)).toEqual({ harnessSlug: 'target-harness', providerState: 'opaque' });

    // A ticket source with no harness cannot sync (the connector gives ticket records no default
    // harness), so the overview reports it as missing alongside the descriptor's own required keys.
    expect(await setTicketSourceConfig(sql, { ...ALICE(), sourceId, patch: { harnessSlug: null } }, { registry }))
      .toEqual({ config: {}, missingConfig: ['teamIds', 'harnessSlug'] });
    expect(await configOf(sourceId)).toEqual({ providerState: 'opaque' });
  });

  it('rules: a known preset, its value rules, a target harness and an admitted kind; a foreign rule id is a 404', async () => {
    const sourceId = await createSource('linear', alice, { teamIds: [ENG.id] });
    const other = await createSource('linear', alice, { teamIds: [OPS.id] });
    const rule = (over: Record<string, unknown>) =>
      refusal(setTicketSourceRule(sql, { ...ALICE(), sourceId, preset: 'label', value: 'bug', harness: HARNESS, createdBy: PERSON, ...over } as never, { registry }));
    const invalid = { code: 'admission_rule_invalid', status: 400 };
    expect(await rule({ preset: 'everything' })).toEqual(invalid);
    expect(await rule({ value: undefined })).toEqual(invalid);
    expect(await rule({ preset: 'delegated-to-papercusp', value: 'x' })).toEqual(invalid);
    expect(await rule({ harness: '  ' })).toEqual(invalid);
    expect(await rule({ workKind: 'feature' })).toEqual(invalid);
    const [count] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.admission_rules
       WHERE workspace_id = ${WS} AND data_source_id = ANY(${sql.array([sourceId, other])}::uuid[])`;
    expect(count!.n).toBe(0);

    // A rule of the owner's OTHER source cannot be disabled through this one.
    const foreign = await setTicketSourceRule(sql, { ...ALICE(), sourceId: other, preset: 'team', value: OPS.key, harness: HARNESS, createdBy: PERSON }, { registry });
    expect(await refusal(disableTicketSourceRule(sql, { ...ALICE(), sourceId, ruleId: foreign.rule.id }, { registry })))
      .toEqual({ code: 'admission_rule_not_found', status: 404 });
    const [still] = await sql<Array<{ enabled: boolean }>>`
      SELECT enabled FROM harness_shared.admission_rules WHERE id = ${foreign.rule.id}::uuid`;
    expect(still).toEqual({ enabled: true });
  });
});

describe('container listing dispatches by capability', () => {
  it('refuses a provider without ticket.containers by name, before any host.fetch or provider call', async () => {
    const sourceId = await createSource(NO_CONTAINERS, alice, {});
    const fetch = boundFetch(recordedLinear);
    await expect(listTicketSourceContainers(sql, { ...ALICE(), sourceId }, { registry, hostFetchFor: fetch.hostFetchFor }))
      .rejects.toThrow(`provider_capability_unsupported:${NO_CONTAINERS}:ticket.containers`);
    expect(fetch.hostFetchFor).not.toHaveBeenCalled();
    expect(noContainersInvoke).not.toHaveBeenCalled();
  });
});
