import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPlugins } from '@papercusp/plugin-loader';
import { jsonResponse, type HostFetch, type ProviderAdapter } from '@papercusp/plugin-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { getDatatype, upsertDatatype } from '../../datatype-registry-store';
import { ingestExternalTriggerEvent } from '../../external-triggers/ingestion';
import { createOwnedExternalTriggerSource, getExternalTriggerSource } from '../../external-triggers/source-store';
import { descriptorConnectionAdapter } from '../../integrations/connection-lifecycle';
import { createProviderRegistry, providerRegistry } from '../../integrations/provider-registry';
import { summarizeIntegrationProvider } from '../../integrations/ticket-integrations';
import { setPersonalVaultEnabled } from '../../personal-vault/store';
import { registerPluginProviders } from '../../plugin-host-runtime';
import { runConnectorSync } from '../connector-runtime';

const REPO = resolve(import.meta.dirname, '../../../../..');
const adapter = createRequire(import.meta.url)('../../../../../libs/papercusp/plugins/facebook/index.cjs').providerAdapter as ProviderAdapter;
const WS = 'facebook-provider-integration';
const ROOT = join(tmpdir(), `facebook-install-${process.pid}-${Date.now()}`);
let org: OrgTestDb;
let userId: string;
const registry = createProviderRegistry();
beforeAll(async () => {
  org = await createOrgTestDb();
  const sql = org.adminSql;
  const [user] = await sql<{ id: string }[]>`INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'facebook-package-' + Date.now()}, 'Facebook Owner') RETURNING id::text`;
  userId = user.id;
  await setPersonalVaultEnabled(sql, WS, userId, true, 'owner');
  const base = await getDatatype(sql, 'papercusp-workspace', 'social-post');
  if (!base) throw new Error('social-post fixture missing');
  await upsertDatatype(sql, { ...base, workspaceId: WS, createdBy: 'facebook-provider-test' });
  await registry.register({ descriptor: await adapter.describe(), adapter, pluginName: 'facebook' });
}, 120_000);
afterAll(async () => { await org?.cleanup(); await fs.rm(ROOT, { recursive: true, force: true }); });

describe('installed Facebook Personal Vault uses the shared host (P-003)', () => {
  it('stops legacy credentials until reconnect without changing source identity or other providers', async () => {
    const sql = org.adminSql;
    const legacy = await createOwnedExternalTriggerSource(sql, { workspaceId: WS, kind: 'facebook', ownerUserId: userId,
      providerAccountId: 'legacy', credentialRef: 'facebook-personal-vault:legacy', status: 'connected', cursor: { since: 'preserve' } });
    const modern = await createOwnedExternalTriggerSource(sql, { workspaceId: WS, kind: 'facebook', ownerUserId: userId,
      providerAccountId: 'modern', credentialRef: 'provider:facebook:modern', status: 'connected' });
    await sql.unsafe(await fs.readFile(join(REPO, 'libs/papercusp/libs/db/sql/1517-facebook-provider-legacy-grants-reconnect.sql'), 'utf8'));
    expect(await getExternalTriggerSource(sql, WS, legacy.id)).toMatchObject({ status: 'reconnect_required',
      providerAccountId: 'legacy', cursor: { since: 'preserve' }, credentialRef: 'facebook-personal-vault:legacy' });
    expect(await getExternalTriggerSource(sql, WS, modern.id)).toMatchObject({ status: 'connected', credentialRef: 'provider:facebook:modern' });
  });

  it('loads from the install path and derives its OAuth adapter and Integrations card from the descriptor', async () => {
    await fs.mkdir(join(ROOT, 'plugins'), { recursive: true });
    await fs.mkdir(join(ROOT, 'empty-global'), { recursive: true });
    await fs.cp(join(REPO, 'libs/papercusp/plugins/facebook'), join(ROOT, 'plugins/facebook'), { recursive: true });
    const { loaded, errors } = await loadPlugins({ projectDir: ROOT, globalPluginsDir: join(ROOT, 'empty-global'), harnessSlugs: [] });
    expect(errors).toEqual([]);
    const installed = createProviderRegistry();
    const failures: unknown[] = [];
    expect(await registerPluginProviders(loaded, (failure) => failures.push(failure), installed)).toEqual(['facebook']);
    expect(failures).toEqual([]);
    const entry = installed.get('facebook')!;
    expect(await entry.adapter!.describe()).toEqual(await adapter.describe());
    const model = summarizeIntegrationProvider(entry, [], { ref: 'facebook', configured: false, clientId: null,
      hasClientSecret: false, redirectUri: 'https://operator.test/api/oauth/callback', savedAt: null });
    expect(model).toMatchObject({ id: 'facebook', displayName: 'Facebook Personal Vault', requiredConfig: [], capabilities: [] });
    expect(new URL(model.connectHref!, 'https://operator.test').searchParams.get('plugin')).toBe('provider:facebook');
    const global = providerRegistry();
    const previous = global.get('facebook');
    try {
      global.unregister('facebook');
      await global.register({ descriptor: entry.descriptor, adapter: entry.adapter!, pluginName: 'facebook' });
      const connection = descriptorConnectionAdapter('provider:facebook')!;
      expect(connection).toMatchObject({ sourceKinds: ['facebook'], oauthPlugin: 'provider:facebook', oauthProviderId: 'provider:facebook' });
      expect(connection.requiresRefreshToken({ accessToken: 'host-only', expiresAt: Date.now() + 3600000 })).toBe(false);
      expect(connection.oauthField('provider:facebook:owner-field')).toBe('owner-field');
      expect(() => connection.assertOwnerUserId('')).toThrow();
      expect(() => connection.oauthField('other:owner-field')).toThrow();
    } finally {
      global.unregister('facebook');
      if (previous) await global.register(previous);
    }
  });

  it('commits each admitted page, resumes after a throttle, and dedupes replay into the private vault', async () => {
    const sql = org.adminSql;
    const source = await createOwnedExternalTriggerSource(sql, { workspaceId: WS, kind: 'facebook', ownerUserId: userId,
      providerAccountId: 'owner', credentialRef: 'provider:facebook:owner', status: 'ready', cursor: { since: '2026-01-01T00:00:00Z' } });
    const other = await createOwnedExternalTriggerSource(sql, { workspaceId: WS, kind: 'facebook', ownerUserId: userId,
      providerAccountId: 'other', credentialRef: 'provider:facebook:other', status: 'connected', cursor: { keep: 'other-account' } });
    let throttle = true;
    let edited = false;
    const requests: string[] = [];
    const fetch: HostFetch = async ({ source: sid, request }) => {
      expect(sid).toBe(source.id); requests.push(request.url);
      const path = new URL(request.url).pathname;
      if (path.endsWith('/me')) return jsonResponse(200, { id: 'owner', name: 'Owner', about: 'Private profile context' });
      if (path.endsWith('/feed')) return jsonResponse(200, { data: [{ id: 'post', message: edited ? 'Edited launch' : 'Launch', created_time: '2020-01-01T00:00:00Z' }] });
      return throttle ? jsonResponse(429, {}, { 'retry-after': '120' })
        : jsonResponse(200, { data: [{ id: 'photo', name: 'Photo', picture: 'https://images.test/a.jpg' }] });
    };
    const sync = async () => (await runConnectorSync(sql, { workspaceId: WS, harness: 'papercusp', sourceIds: [source.id], maxPagesPerSource: 10 }, {
      registry, hostFetchFor: () => fetch, servicesFor: async () => undefined, leaseOwner: 'facebook-package-test',
      ingest: (db, input) => ingestExternalTriggerEvent(db, input, { emit: async (event) => ({ ok: true, key: event.key, woken: 0, notified: [], msgId: null, waiters: 0 }) }),
    })).sources[0];
    const due = () => sql`UPDATE harness_shared.data_sources SET sync_next_attempt_at = now() - interval '1 second'
      WHERE workspace_id = ${WS} AND id = ${source.id}::uuid`;
    expect(await sync()).toMatchObject({ outcome: 'rate-limited', admitted: 2 });
    const limited = await getExternalTriggerSource(sql, WS, source.id);
    expect(JSON.parse(String(limited!.cursor.provider))).toMatchObject({ phase: 'photo' });
    throttle = false; await due();
    expect(await sync()).toMatchObject({ outcome: 'synced', admitted: 1 });
    await due(); expect(await sync()).toMatchObject({ outcome: 'synced', admitted: 0 });
    edited = true; await due(); expect(await sync()).toMatchObject({ outcome: 'synced', admitted: 1 });
    const docs = await sql<{ kind: string; external_id: string; text: string }[]>`
      SELECT kind, external_id, text FROM harness_shared.documents WHERE workspace_id = ${WS} AND user_id = ${userId} ORDER BY kind`;
    expect(docs).toEqual([
      expect.objectContaining({ kind: 'photo', external_id: 'photo' }),
      expect.objectContaining({ kind: 'post', external_id: 'post', text: 'Edited launch' }),
      expect.objectContaining({ kind: 'profile', external_id: 'owner' }),
    ]);
    expect(await getExternalTriggerSource(sql, WS, other.id)).toMatchObject({ cursor: { keep: 'other-account' } });
    expect(requests.every((url) => !new URL(url).searchParams.has('access_token'))).toBe(true);
    const [legacyRoutine] = await sql<{ active: boolean }[]>`SELECT active FROM harness_shared.routines WHERE name = 'facebook-personal-vault-poll' AND install_slug = 'papercusp'`;
    expect(legacyRoutine?.active ?? false).toBe(false);
  }, 120_000);
});
