import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HostFetch, ProviderAdapter, ProviderDescriptor } from '@papercusp/plugin-sdk';
import { jsonResponse } from '@papercusp/plugin-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createProviderRegistry, type ProviderRegistry } from '../integrations/provider-registry';
import { createWebhookRoutes } from '../endpoint-route/routes/webhooks';
import { handleWebhookDelivery } from '../external-triggers/webhook';
import { handleConnectorPushDelivery, handleConnectorPushVerification } from './connector-push';
import { admitConnectorRecord } from './connector-runtime';
import { ingestExternalTriggerEvent } from '../external-triggers/ingestion';
import { upsertDatatype } from '../datatype-registry-store';
import { SOCIAL_POST_SCHEMA_FIXTURE } from '../external-triggers/social/social-post-schema.fixture';

const adapter = createRequire(import.meta.url)('../../../../libs/papercusp/plugins/instagram/index.cjs').providerAdapter as ProviderAdapter;
const h = vi.hoisted(() => ({ sql: undefined as unknown }));
vi.mock('@papercusp/db-org', async (orig) => ({ ...await orig(), getOrgPg: () => ({ sql: h.sql }) }));
const WS = 'papercusp-workspace';
const IG = '17841400000000000';
let org: OrgTestDb;
let registry: ProviderRegistry;
let sourceId: string;
let remoteOn = true;
const admit = vi.fn<typeof admitConnectorRecord>(async () => 'admitted');
const fetch: HostFetch = async () => jsonResponse(200, { id: IG, mentioned_media: { id: '333', caption: 'hello avi', timestamp: '2026-10-01T00:00:00Z' } });

function dependencies() {
  return { sql: org.adminSql, registry: async () => registry, remoteAccessEnabled: async () => remoteOn,
    oauthSecretFor: async () => 'test-app-secret', credentialFor: async () => 'test-verify-token',
    hostFetchFor: () => fetch, admit };
}
beforeAll(async () => {
  org = await createOrgTestDb(); h.sql = org.adminSql;
  await upsertDatatype(org.adminSql, { id: 'social-post', workspaceId: WS, title: 'Social post', description: 'Recorded connector fixture', tier: 'first-class', nature: 'document', payloadSchema: SOCIAL_POST_SCHEMA_FIXTURE });
  const descriptor = await adapter.describe() as ProviderDescriptor;
  registry = createProviderRegistry();
  await registry.register({ descriptor, adapter, pluginName: 'instagram' });
  const [user] = await org.adminSql<{ id: string }[]>`INSERT INTO harness_shared.users (username, display_name) VALUES (${`mention-test-${Date.now()}`}, 'owner') RETURNING id`;
  const [source] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources
      (workspace_id, kind, provider_account_id, status, owner_user_id, credential_ref, config, cursor, scope, destination_policy, permission_mapping)
    VALUES (${WS}, 'instagram', ${`ig-${Date.now()}`}, 'ready', ${user!.id}::uuid, 'provider:instagram',
      ${JSON.stringify({ igUserId: IG, installSlug: 'papercusp' })}::text::jsonb, '{}'::jsonb, 'personal', '{}'::jsonb, ${JSON.stringify({ mode: 'owner' })}::text::jsonb)
    RETURNING id::text`;
  sourceId = source!.id;
}, 180_000);
afterAll(async () => { await org?.cleanup?.(); });

describe('signed push normalization through the existing hook route', () => {
  it('echoes a valid GET challenge and refuses incorrect, repeated or disabled credentials', async () => {
    const [, route] = createWebhookRoutes({ deliver: async () => ({ status: 200, body: {} }), verify: (id, params) => handleConnectorPushVerification(id, params, dependencies()) });
    const call = async (query: string) => (route as unknown as { handler(req: Request, ctx: unknown): Promise<Response> }).handler(new Request(`https://host/api/hooks/${sourceId}?${query}`), { params: { sourceId } });
    const query = 'hub.mode=subscribe&hub.challenge=123&hub.verify_token=test-verify-token';
    const good = await call(query);
    expect(good.status).toBe(200); expect(await good.text()).toBe('123');
    expect((await call(query.replace('test-verify-token', 'wrong'))).status).toBe(403);
    expect((await call(`${query}&hub.challenge=456`)).status).toBe(403);
    remoteOn = false; expect((await call(query)).status).toBe(403); remoteOn = true;
    expect(admit).not.toHaveBeenCalled();
  });

  it('normalizes only an authenticated source-scoped body and passes records to connector admission', async () => {
    const body = JSON.stringify({ object: 'instagram', entry: [{ id: IG, changes: [{ field: 'mentions', value: { media_id: '333' } }] }] });
    const signature = `sha256=${createHmac('sha256', 'test-app-secret').update(body).digest('hex')}`;
    const deliver = (raw: string, signed: string) => handleWebhookDelivery({ sourceId, rawBody: Buffer.from(raw), headers: new Headers({ 'x-hub-signature-256': signed }) }, {
      sql: org.adminSql, remoteAccessEnabled: async () => remoteOn,
      connectorPush: (request) => handleConnectorPushDelivery(request, dependencies()),
    });
    expect(await deliver(body, signature)).toMatchObject({ status: 200, body: { ok: true, records: 1 } });
    expect(admit).toHaveBeenCalledTimes(1);
    expect(admit.mock.calls[0]?.[1]).toMatchObject({ source: { id: sourceId, workspaceId: WS }, providerId: 'instagram', record: { nativeId: '333', event: 'mention' } });
    expect((await deliver(body.replace('333', '999'), signature)).status).toBe(401);
    expect((await deliver(body, signature.replace('sha256=', ''))).status).toBe(401);
    expect(admit).toHaveBeenCalledTimes(1);
    const [source] = await org.adminSql<{ wake: Date | null }[]>`SELECT sync_wake_requested_at AS wake FROM harness_shared.data_sources WHERE id = ${sourceId}::uuid`;
    expect(source!.wake).toBeNull();
  });

  it('ignores an authenticated event for another account before lookup or admission', async () => {
    // One Meta app secret can sign events for several connected accounts. A valid
    // signature alone must not select a different account than this source owns.
    const body = JSON.stringify({ object: 'instagram', entry: [{ id: '17841499999999999', changes: [{ field: 'mentions', value: { media_id: '333' } }] }] });
    const signature = `sha256=${createHmac('sha256', 'test-app-secret').update(body).digest('hex')}`;
    const lookup = vi.fn(fetch);
    const priorAdmissions = admit.mock.calls.length;
    const result = await handleConnectorPushDelivery({ sourceId, rawBody: Buffer.from(body), headers: new Headers({ 'x-hub-signature-256': signature }) }, {
      ...dependencies(), hostFetchFor: () => lookup,
    });
    expect(result).toMatchObject({ status: 200, body: { ok: true, records: 0 } });
    expect(lookup).not.toHaveBeenCalled();
    expect(admit).toHaveBeenCalledTimes(priorAdmissions);
  });

  it('refuses to acknowledge failed normalization and never returns provider error text', async () => {
    const body = JSON.stringify({ object: 'instagram', entry: [{ id: IG, changes: [{ field: 'mentions', value: { media_id: '333' } }] }] });
    const signature = `sha256=${createHmac('sha256', 'test-app-secret').update(body).digest('hex')}`;
    const result = await handleConnectorPushDelivery({ sourceId, rawBody: Buffer.from(body), headers: new Headers({ 'x-hub-signature-256': signature }) }, {
      ...dependencies(), hostFetchFor: () => async () => { throw new Error('sensitive-provider-error'); },
    });
    expect(result).toEqual({ status: 503, body: { ok: false, error: 'normalization_unavailable' } });
    expect(JSON.stringify(result)).not.toContain('sensitive-provider-error');
  });

  it('deduplicates signed mention redelivery in the real ledger and rejects invalid canonical payloads', async () => {
    const emitted: string[] = [];
    const admissions: string[] = [];
    const realAdmit: typeof admitConnectorRecord = async (sql, input) => {
      const outcome = await admitConnectorRecord(sql, input, {
        sinksFor: async () => [],
        ingest: (db, value) => ingestExternalTriggerEvent(db, value, { emit: async (event) => {
          emitted.push(event.key);
          return { ok: true, key: event.key, woken: 0, notified: [], msgId: null, waiters: 0 };
        } }),
      });
      admissions.push(outcome); return outcome;
    };
    const body = JSON.stringify({ object: 'instagram', entry: [{ id: IG, changes: [{ field: 'mentions', value: { media_id: '333' } }] }] });
    const signature = `sha256=${createHmac('sha256', 'test-app-secret').update(body).digest('hex')}`;
    const deliver = () => handleConnectorPushDelivery({ sourceId, rawBody: Buffer.from(body), headers: new Headers({ 'x-hub-signature-256': signature }) }, { ...dependencies(), admit: realAdmit });
    expect((await deliver())?.status).toBe(200);
    expect((await deliver())?.status).toBe(200);
    expect(admissions).toEqual(['admitted', 'deduped']);
    expect(emitted).toEqual(['ext:instagram:mention']);
    const rows = await org.adminSql<{ sink_kind: string; n: number }[]>`
      SELECT sink_kind, count(*)::int AS n FROM harness_shared.trigger_deliveries
       WHERE workspace_id = ${WS} AND source_id = ${sourceId}::uuid AND event_key = 'ext:instagram:mention'
       GROUP BY sink_kind`;
    expect(rows.find((row) => row.sink_kind === 'event-bus')?.n).toBe(1);
    expect(rows.every((row) => row.n === 1)).toBe(true);

    const original = registry;
    registry = createProviderRegistry();
    await registry.register({ descriptor: await adapter.describe(), pluginName: 'instagram', adapter: {
      ...adapter, invoke: async () => ({ records: [{ datatype: 'social-post', nativeId: 'malformed', event: 'mention', payload: { id: 'malformed' }, version: '1' }] }),
    } });
    try {
      expect(await deliver()).toEqual({ status: 503, body: { ok: false, error: 'record_admission_unavailable' } });
      expect(admissions[2]).toBe('rejected');
      expect(emitted).toHaveLength(1);
    } finally { registry = original; }
  });
});
