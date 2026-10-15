/**
 * R-24: current hosted composition over TCP, with a private encrypted PG store.
 * Only the credential-store I/O adapter is redirected to the migrated fixture.
 * The source selector, encoder, producer, hosted service role and route mount are
 * production code. A local-producer control proves the store observer works.
 * This does not certify customer login, a deployed host, or finished installers.
 */
import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../../test/_org-test-db';
import type { HostedServiceContextRunner } from '../auth/hosted/workos-lifecycle-postgres';

const fixture = vi.hoisted(() => ({
  read: null as null | ((name: string) => Promise<string | undefined>),
  write: null as null | ((partial: Record<string, string | null>) => Promise<Record<string, string>>),
  sourceReads: 0,
  writes: 0,
}));

vi.mock('../integration-credentials', async (original) => ({
  ...await original<typeof import('../integration-credentials')>(),
  readIntegrationKey: async (name: string) => {
    if (!fixture.read) throw new Error('credential fixture not initialized');
    fixture.sourceReads += 1;
    return fixture.read(name);
  },
  writeIntegrationCredentials: async (partial: Record<string, string | null>) => {
    if (!fixture.write) throw new Error('credential fixture not initialized');
    fixture.writes += 1;
    return fixture.write(partial);
  },
}));

import { createHostedSecretRefResolver } from '../auth/hosted/secret-ref';
import { createHostedRuntime, type HostedRuntimeConfiguration } from './hosted-runtime';
import { createWorkspaceHostAgentCredentialsRoute } from './routes/workspace-hosts/agent-credentials';

const WORKSPACE = 'osr-r24-private-credential-fixture';
const ENCRYPTION_KEY = 'synthetic-fixture-encryption-key-never-a-provider-secret';
const HOST = 'osr-r24-customer-control';
const NEVER_EMIT_MARKER = 'never-emit-me';
const REF = `pc-agent-forward://${HOST}/default`;
const CLAUDE_SOURCE = 'R24_SERVICE_SUBSCRIPTION_SENTINEL';
const CODEX_SOURCE = 'R24_SYNTHETIC_CODEX_SENTINEL';
const sources = {
  claude: { kind: 'integration-key', name: CLAUDE_SOURCE },
  codex: { kind: 'integration-key', name: CODEX_SOURCE },
  omp: { kind: 'absent' },
};

describe('hosted credential producer isolation over real HTTP and encrypted Postgres', () => {
  let db: OrgTestDb | undefined;
  let server: ServerType | undefined;
  let origin: string;

  async function readStore(): Promise<Record<string, string>> {
    if (!db) throw new Error('database fixture not initialized');
    const [row] = await db.adminSql<Array<{ value: Record<string, string> }>>`
      SELECT pgp_sym_decrypt(payload_ct, ${ENCRYPTION_KEY})::jsonb AS value
        FROM harness_shared.operator_integration_credentials WHERE workspace_id = ${WORKSPACE}
    `;
    return row?.value ?? {};
  }

  async function writeStore(value: Record<string, string>): Promise<void> {
    if (!db) throw new Error('database fixture not initialized');
    await db.adminSql`
      INSERT INTO harness_shared.operator_integration_credentials (workspace_id, payload, payload_ct, updated_at)
      VALUES (${WORKSPACE}, '{}'::jsonb, pgp_sym_encrypt(${JSON.stringify(value)}, ${ENCRYPTION_KEY}), ${Date.now()})
      ON CONFLICT (workspace_id) DO UPDATE SET payload = '{}'::jsonb,
        payload_ct = EXCLUDED.payload_ct, updated_at = EXCLUDED.updated_at
    `;
  }

  async function snapshot() {
    if (!db) throw new Error('database fixture not initialized');
    const store = await db.adminSql`
      SELECT workspace_id, md5(payload_ct::text) AS ciphertext_fingerprint, updated_at
        FROM harness_shared.operator_integration_credentials WHERE workspace_id = ${WORKSPACE}
    `;
    const operations = await db.adminSql`
      SELECT id FROM harness_shared.workspace_host_operations
        WHERE workspace_id = ${WORKSPACE} AND host_id = ${HOST} ORDER BY id
    `;
    const events = await db.adminSql`
      SELECT id FROM harness_shared.workspace_host_events
        WHERE workspace_id = ${WORKSPACE} AND host_id = ${HOST} ORDER BY id
    `;
    return { store: [...store], operations: [...operations], events: [...events] };
  }

  beforeAll(async () => {
    const { createOrgTestDb } = await import('../../test/_org-test-db');
    db = await createOrgTestDb();
    await writeStore({
      [CLAUDE_SOURCE]: JSON.stringify({ claudeAiOauth: { accessToken: NEVER_EMIT_MARKER } }),
      [CODEX_SOURCE]: JSON.stringify({ auth_mode: 'chatgpt', tokens: {
        access_token: NEVER_EMIT_MARKER, id_token: NEVER_EMIT_MARKER, refresh_token: '',
      } }),
      R24_COOKIE: 'synthetic-cookie-secret-longer-than-thirty-two-bytes',
      R24_WORKOS_API: 'synthetic-workos-api',
      R24_WORKOS_COOKIE: 'synthetic-workos-cookie-longer-than-thirty-two-bytes',
      R24_WORKOS_WEBHOOK: 'synthetic-workos-webhook',
    });
    fixture.read = async (name) => (await readStore())[name];
    fixture.write = async (partial) => {
      const value = await readStore();
      for (const [name, next] of Object.entries(partial)) {
        if (next === null || next === '') delete value[name];
        else value[name] = next;
      }
      await writeStore(value);
      return value;
    };
    const runService: HostedServiceContextRunner = <T>(fn: (sql: Sql) => Promise<T>) =>
      db!.appSql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${WORKSPACE}, true)`;
        await tx.unsafe('SET LOCAL ROLE hosted_service');
        return fn(tx as unknown as Sql);
      }) as Promise<T>;
    const configuration: HostedRuntimeConfiguration = {
      publicOrigin: 'https://r24-fixture.invalid', controlPlaneWorkspaceId: WORKSPACE,
      hostedSessionCookieSecretRef: 'integration:R24_COOKIE', workosClientId: 'client_r24_fixture',
      workosApiKeyRef: 'integration:R24_WORKOS_API',
      workosCookiePasswordRef: 'integration:R24_WORKOS_COOKIE',
      workosWebhookSecretRef: 'integration:R24_WORKOS_WEBHOOK',
    };
    const plane = await createHostedRuntime(configuration, {
      runService, resolveSecret: createHostedSecretRefResolver(),
    });
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: plane.app.fetch, hostname: '127.0.0.1', port: 0 }, (address) => resolve(address.port));
    });
    origin = `http://127.0.0.1:${port}`;
  }, 120_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    fixture.read = null;
    fixture.write = null;
    await db?.cleanup();
  });

  it('observes a local producer write, then refuses service selectors before source, store or delivery activity', async () => {
    // Local-only observer control: fake bytes, real selector/encoder/writer and
    // encrypted fixture. This is not an allowed hosted customer credential case.
    const local = createWorkspaceHostAgentCredentialsRoute();
    const beforeControl = await snapshot();
    const response = await local.handler(new Request('http://localhost/local-control', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentialRef: REF, generation: 1, sources }),
    }), { params: { hostId: HOST } } as never);
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(receipt).toMatchObject({ stored: true, generation: 1 });
    expect(typeof receipt.key).toBe('string');
    expect(fixture.writes).toBe(1);
    expect((await readStore())[receipt.key]).toBeDefined();
    expect((await snapshot()).store).not.toEqual(beforeControl.store);

    const beforeForbidden = await snapshot();
    const reads = fixture.sourceReads;
    const writes = fixture.writes;
    for (const claude of [{ kind: 'operator-home-file' }, sources.claude]) {
      for (const action of ['agent-credentials', 'credential-lifecycle', 'initialize', 'canary']) {
        const forbidden = await fetch(`${origin}/api/workspace-hosts/${HOST}/${action}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ credentialRef: REF, generation: 2,
            sources: { ...sources, claude }, allowOwnSubscriptionRelay: true }),
          signal: AbortSignal.timeout(10_000),
        });
        expect(forbidden.status, action).toBe(404);
        expect(await forbidden.text()).not.toContain(CLAUDE_SOURCE);
      }
    }
    expect(fixture.sourceReads).toBe(reads);
    expect(fixture.writes).toBe(writes);
    expect(await snapshot()).toEqual(beforeForbidden);
    expect((await fetch(`${origin}/api/health`)).status).toBe(200);
  });
});
