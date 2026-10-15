/**
 * Provider push wake against real Postgres (plan linear-asana-task-sync-2026-10-05, P-008 /
 * WI-10006368, decision D-016).
 *
 * The provider is registered with the REAL Asana descriptor (libs/papercusp/plugins/asana), so the
 * scheme under test is the one that ships. Its adapter stands in for Asana's servers: during
 * `push.subscribe` it performs each webhook's X-Hook-Secret handshake through the real
 * `POST /api/hooks/:sourceId` route handler, exactly as Asana does inside its create call. So the
 * handshake window, the encrypted secret store, the echoed header and the signature check are all
 * exercised together, and a signed delivery is shown to do one thing only: wake the source.
 */
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { ProviderDescriptor, ProviderInvokeRequest } from '@papercusp/plugin-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createWebhookRoutes } from '../endpoint-route/routes/webhooks';
import { createWebhookSource, handleWebhookDelivery } from '../external-triggers/webhook';
import { createProviderRegistry, type ProviderRegistry } from '../integrations/provider-registry';
import { handleConnectorPushDelivery, pushStateOf, reconcileConnectorPush } from './connector-push';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const WS = 'papercusp-workspace';
const DB_KEY = 'connector-push-integration-test-key';
const ASANA_DESCRIPTOR = (JSON.parse(readFileSync(path.join(REPO, 'libs/papercusp/plugins/asana/papercusp.json'), 'utf8')) as {
  provider: ProviderDescriptor;
}).provider;
const TARGET = (sourceId: string) => `https://me.example.net/api/hooks/${sourceId}`;
const DESTINATIONS = { ticket: ['record'], 'ticket-status-change': ['event'], 'ticket-comment': ['document'] };

let org: OrgTestDb;
let sql: Sql;
let registry: ProviderRegistry;
let owner: string;
let remoteOn = true;
let invocations: ProviderInvokeRequest[] = [];
/** What the stand-in Asana answered for each handshake it performed. */
let handshakes: Array<{ project: string; status: number; echoed: string | null }> = [];

const [route] = createWebhookRoutes({
  deliver: (request) =>
    handleWebhookDelivery(request, {
      sql,
      encryptionKey: DB_KEY,
      remoteAccessEnabled: async () => remoteOn,
      connectorPush: (pushRequest, base) => handleConnectorPushDelivery(pushRequest, { ...base, registry: async () => registry }),
    }),
});

async function post(sourceId: string, body: string, headers: Record<string, string>) {
  const request = new Request(`http://127.0.0.1/api/hooks/${sourceId}`, { method: 'POST', headers, body });
  const res = await (route as unknown as { handler: (req: Request, ctx: unknown) => Promise<Response> }).handler(request, {
    params: { sourceId },
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown> };
}

const secretFor = (project: string) => `asana-secret-${project}`;
const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');

/** Stand-in for Asana: creating a webhook POSTs its handshake to the target before returning. */
const adapter = {
  describe: () => ASANA_DESCRIPTOR,
  syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
  async invoke(request: ProviderInvokeRequest) {
    invocations.push(request);
    if (request.capability === 'push.unsubscribe') return { deleted: (request.args.subscriptions as unknown[]).length };
    const target = String(request.args.targetUrl);
    const sourceId = target.split('/').pop()!;
    const projects = (request.config?.projectGids as string[]) ?? [];
    const subscriptions = [];
    for (const project of projects) {
      const res = await post(sourceId, '', { 'x-hook-secret': secretFor(project) });
      handshakes.push({ project, status: res.status, echoed: res.headers.get('x-hook-secret') });
      if (res.status !== 200 || res.headers.get('x-hook-secret') !== secretFor(project)) {
        throw new Error(`asana_http_400: POST /webhooks: The remote server did not respond with the handshake secret.`);
      }
      subscriptions.push({ id: `hook-${project}`, resource: project });
    }
    return { subscriptions };
  },
};

async function newSource(config: Record<string, unknown>, status = 'connected'): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources
      (workspace_id, kind, owner_user_id, provider_account_id, status, config, scope, destination_policy, permission_mapping)
    VALUES (${WS}, 'asana', ${owner}, ${`push-test-${Date.now()}-${Math.random()}`}, ${status},
            ${sql.json(config as Parameters<typeof sql.json>[0])}, 'personal', ${sql.json(DESTINATIONS)}, ${sql.json({ mode: 'owner' })})
    RETURNING id::text`;
  return row!.id;
}

const reconcile = (sourceId: string, now?: Date) =>
  reconcileConnectorPush(sql, { workspaceId: WS, harness: 'papercusp', sourceIds: [sourceId] }, {
    registry,
    hostFetchFor: () => async () => {
      throw new Error('the stand-in adapter makes no host.fetch call');
    },
    servicesFor: async () => undefined,
    targetUrlFor: async (id) => TARGET(id),
    remoteAccessEnabled: async () => remoteOn,
    ...(now ? { now: () => now } : {}),
  });

async function sourceRow(id: string) {
  const [row] = await sql<Array<{ cursor: Record<string, unknown> | null; wake: Date | null; secrets: number }>>`
    SELECT s.cursor, s.sync_wake_requested_at AS wake,
           (SELECT count(*)::int FROM harness_shared.connector_push_secrets p
             WHERE p.workspace_id = s.workspace_id AND p.source_id = s.id) AS secrets
      FROM harness_shared.data_sources s WHERE s.workspace_id = ${WS} AND s.id = ${id}::uuid`;
  return row!;
}

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  const migration = path.join(REPO, 'libs/papercusp/libs/db/sql/1400-connector-push-secrets.sql');
  await sql.unsafe(readFileSync(existsSync(migration) ? migration : `${migration}.DRAFT`, 'utf8'));
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name) VALUES (${`push-test-${Date.now()}`}, 'owner') RETURNING id`;
  owner = user!.id;
  registry = createProviderRegistry();
  await registry.register({ descriptor: ASANA_DESCRIPTOR, adapter, pluginName: 'asana' });
}, 180_000);

afterAll(async () => {
  await org?.cleanup?.();
});

beforeEach(() => {
  remoteOn = true;
  invocations = [];
  handshakes = [];
});

describe('subscribing: the handshake is accepted only inside the window the host opens', () => {
  it('a handshake nobody asked for is refused and stores nothing', async () => {
    const id = await newSource({ projectGids: ['p1'] });
    const res = await post(id, '', { 'x-hook-secret': 'attacker-chosen' });
    expect(res).toMatchObject({ status: 403, body: { ok: false, error: 'handshake_not_expected' } });
    expect(res.headers.get('x-hook-secret')).toBeNull();
    expect((await sourceRow(id)).secrets).toBe(0);
  });

  it('subscribes every configured project, stores each secret encrypted, and closes the window', async () => {
    const id = await newSource({ projectGids: ['p1', 'p2'] });
    expect((await reconcile(id)).sources).toEqual([{ sourceId: id, providerId: 'asana', outcome: 'subscribed', subscriptions: 2 }]);
    expect(handshakes).toEqual([
      { project: 'p1', status: 200, echoed: secretFor('p1') },
      { project: 'p2', status: 200, echoed: secretFor('p2') },
    ]);
    expect(invocations.map((i) => [i.capability, i.args.targetUrl, i.config])).toEqual([
      ['push.subscribe', TARGET(id), { projectGids: ['p1', 'p2'] }],
    ]);
    const row = await sourceRow(id);
    expect(row.secrets).toBe(2);
    expect(pushStateOf(row.cursor)).toMatchObject({
      targetUrl: TARGET(id),
      subscriptions: [{ id: 'hook-p1', resource: 'p1' }, { id: 'hook-p2', resource: 'p2' }],
      handshakeOpenUntil: null,
      lastError: null,
    });
    const [plain] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.connector_push_secrets
       WHERE source_id = ${id}::uuid AND position(convert_to(${secretFor('p1')}, 'UTF8') IN secret_ct) > 0`;
    expect(plain!.n).toBe(0);
    // The window is closed again: a late handshake is refused.
    expect((await post(id, '', { 'x-hook-secret': 'late' })).status).toBe(403);
  });

  it('nothing is subscribed while Remote access is off, and polling is left alone', async () => {
    remoteOn = false;
    const id = await newSource({ projectGids: ['p1'] });
    expect((await reconcile(id)).sources).toEqual([
      { sourceId: id, providerId: 'asana', outcome: 'skipped', subscriptions: 0, reason: 'remote_access_off' },
    ]);
    expect(invocations).toEqual([]);
  });
});

describe('a delivery only wakes its source, and only with a valid signature', () => {
  it('wakes the source on a signature from any of its webhooks; nothing else is written', async () => {
    const id = await newSource({ projectGids: ['p1', 'p2'] });
    const otherId = await newSource({ projectGids: ['other-project'] });
    await reconcile(id);
    await reconcile(otherId);
    const otherWakeBefore = (await sourceRow(otherId)).wake;
    expect(otherWakeBefore).toBeNull();
    const body = JSON.stringify({ events: [{ action: 'changed', resource: { gid: 't-1', resource_type: 'task' } }] });
    expect((await sourceRow(id)).wake).toBeNull();
    const res = await post(id, body, { 'content-type': 'application/json', 'x-hook-signature': sign(secretFor('p2'), body) });
    expect(res).toMatchObject({ status: 200, body: { ok: true, woke: true } });
    expect((await sourceRow(id)).wake).not.toBeNull();
    expect((await sourceRow(otherId)).wake).toEqual(otherWakeBefore);
    const [deliveries] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS} AND source_id = ${id}::uuid`;
    expect(deliveries!.n).toBe(0);
  });

  it('refuses a wrong, missing or foreign-secret signature, and Remote access off, without waking', async () => {
    const id = await newSource({ projectGids: ['p1'] });
    await reconcile(id);
    const body = JSON.stringify({ events: [] });
    const refused = [
      await post(id, body, { 'x-hook-signature': sign('not-the-secret', body) }),
      await post(id, body, {}),
      await post(id, body, { 'x-hook-signature': sign(secretFor('p1'), `${body} `) }),
    ];
    for (const res of refused) expect(res).toMatchObject({ status: 401, body: { error: 'signature_invalid' } });
    remoteOn = false;
    expect((await post(id, body, { 'x-hook-signature': sign(secretFor('p1'), body) })).status).toBe(403);
    expect((await sourceRow(id)).wake).toBeNull();
  });

  it('a source with no webhook yet has nothing to verify against', async () => {
    const id = await newSource({ projectGids: ['p1'] });
    const body = '{}';
    expect(await post(id, body, { 'x-hook-signature': sign(secretFor('p1'), body) })).toMatchObject({
      status: 401, body: { reason: 'no_subscription' },
    });
  });
});

describe('reconcile runs only when something moved, and tears down what can no longer be delivered', () => {
  it('is current until the config changes', async () => {
    const id = await newSource({ projectGids: ['p1'] });
    await reconcile(id);
    invocations = [];
    expect((await reconcile(id)).sources[0]).toMatchObject({ outcome: 'current', subscriptions: 1 });
    expect(invocations).toEqual([]);
    await sql`UPDATE harness_shared.data_sources SET config = ${sql.json({ projectGids: ['p1', 'p3'] })} WHERE id = ${id}::uuid`;
    expect((await reconcile(id)).sources[0]).toMatchObject({ outcome: 'subscribed', subscriptions: 2 });
  });

  it('a failed subscribe is recorded, closes the window, and waits out the retry period', async () => {
    const id = await newSource({ projectGids: ['p1'] });
    const failing = adapter;
    const original = failing.invoke;
    failing.invoke = async () => {
      throw new Error('asana_rate_limited:60s');
    };
    try {
      expect((await reconcile(id)).sources[0]).toMatchObject({ outcome: 'failed', error: 'asana_rate_limited:60s' });
      expect(pushStateOf((await sourceRow(id)).cursor)).toMatchObject({ handshakeOpenUntil: null, lastError: 'asana_rate_limited:60s' });
      expect((await reconcile(id)).sources[0]).toMatchObject({ outcome: 'current' });
    } finally {
      failing.invoke = original;
    }
    const later = new Date(Date.now() + 7 * 60 * 60 * 1000);
    expect((await reconcile(id, later)).sources[0]).toMatchObject({ outcome: 'subscribed', subscriptions: 1 });
  });

  it('a disabled source loses its webhooks and secrets, and its deliveries are refused', async () => {
    const id = await newSource({ projectGids: ['p1'] });
    await reconcile(id);
    await sql`UPDATE harness_shared.data_sources SET status = 'disabled' WHERE id = ${id}::uuid`;
    const body = '{}';
    expect((await post(id, body, { 'x-hook-signature': sign(secretFor('p1'), body) })).status).toBe(404);
    invocations = [];
    expect((await reconcile(id)).sources[0]).toMatchObject({ outcome: 'unsubscribed', reason: 'status:disabled' });
    expect(invocations.map((i) => [i.capability, i.args.subscriptions])).toEqual([
      ['push.unsubscribe', [{ id: 'hook-p1', resource: 'p1' }]],
    ]);
    const row = await sourceRow(id);
    expect(row.secrets).toBe(0);
    expect(pushStateOf(row.cursor).subscriptions).toEqual([]);
  });
});

describe('the generic webhook path is unchanged', () => {
  it('an empty body to a webhook source is still invalid_body, and an unknown id is still 404', async () => {
    const hook = await createWebhookSource(sql, { workspaceId: WS, label: 'empty body', createdBy: 'test' }, { encryptionKey: DB_KEY });
    expect(await post(hook.source.id, '', {})).toMatchObject({ status: 400, body: { error: 'invalid_body' } });
    expect(await post('00000000-0000-4000-8000-000000000000', '', { 'x-hook-secret': 's' })).toMatchObject({
      status: 404, body: { error: 'not_found' },
    });
  });
});
