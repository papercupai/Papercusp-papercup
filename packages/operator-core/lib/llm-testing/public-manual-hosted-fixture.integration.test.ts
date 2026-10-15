import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { PostgresHostedProviderDelegationStore } from '../workspace-host/hosted-provider-delegation';
import { assertPublicManualHostedRuntimeSchema, preparePublicManualHostedDelegation, purgePublicManualHostedConnector,
  type PublicManualHostedFixtureBinding } from './public-manual-hosted-fixture';

const scoped = vi.hoisted(() => ({ sql: null as Sql | null }));
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  withWorkspace: (workspace: string, fn: (sql: Sql) => Promise<unknown>) => scoped.sql!.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id', ${workspace}, true)`;
    await tx.unsafe('SET LOCAL ROLE harness_app');
    return fn(tx as unknown as Sql);
  }),
}));
import { withWorkspace } from '@papercusp/db-org';
import { readHostedWorkspaceHosting } from '../../../../apps/operator/bin/hosted-handler';

const SHA = '9d60d682b3e67e78074e2b842aeee43d2c472b8e';
const CONTROL = 'manual-private-fixture-control';
describe('private public manual hosted fixture (real Postgres)', () => {
  let db: OrgTestDb;
  let server: Server;
  let origin: string;
  let status = 200;
  let responseSha = SHA.slice(0, 10);
  beforeAll(async () => {
    db = await createOrgTestDb();
    scoped.sql = db.adminSql;
    server = createServer((_request, response) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ sha: responseSha }));
    });
    await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, 180_000);
  afterAll(async () => {
    if (server?.listening) await new Promise<void>((ready, reject) => server.close(error => error ? reject(error) : ready()));
    await db?.cleanup();
  });
  const run = <T>(fn: (sql: Sql) => Promise<T>) => withWorkspace(CONTROL, fn);
  const service = <T>(fn: (sql: Sql) => Promise<T>) => db.adminSql.begin(async tx => {
    await tx.unsafe('SET LOCAL ROLE hosted_service');
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
  async function seed(): Promise<PublicManualHostedFixtureBinding> {
    const organizationId = randomUUID();
    const customerWorkspaceId = `ws-${randomUUID()}`;
    const hostId = `host-${randomUUID()}`;
    const connectionId = `connection-${randomUUID()}`;
    await db.adminSql`INSERT INTO papercusp_auth.organizations (id, external_organization_id, display_name)
      VALUES (${organizationId}, ${`fixture-${organizationId}`}, 'Disposable manual fixture')`;
    await db.adminSql`INSERT INTO harness_shared.workspace_host_connections
      (workspace_id, id, target, label, credential_ref, status)
      VALUES (${CONTROL}, ${connectionId}, 'gcp', 'Private fixture', 'fixture://private-host', 'connected')`;
    await db.adminSql`INSERT INTO harness_shared.workspace_hosts
      (workspace_id,id,name,connection_id,target,scope_label,region,size,image,disk_gib,network,desired_state,observed_state)
      VALUES (${CONTROL},${hostId},'Private fixture',${connectionId},'gcp','fixture','fixture','fixture','fixture',1,'fixture','running','running')`;
    await db.adminSql`INSERT INTO harness_shared.customer_workspaces
      (workspace_id,id,organization_id,workspace_host_id,display_name,state,created_by_principal_kind,created_by_principal_id)
      VALUES (${CONTROL},${customerWorkspaceId},${organizationId},${hostId},'Private fixture','active','user',${randomUUID()})`;
    return { controlPlaneWorkspaceId: CONTROL, organizationId, customerWorkspaceId, hostId, connectionId };
  }
  it('moves an inert admitted host through pending and measured verification before production hosting admission', async () => {
    status = 200;
    responseSha = SHA.slice(0, 10);
    const binding = await seed();
    const readerBinding = { ...binding, routeLabel: 'manual-regression', generation: 1,
      state: 'active' as const, transport: 'websocket' as const };
    expect(await readHostedWorkspaceHosting(readerBinding)).toBeNull();
    const delegation = await preparePublicManualHostedDelegation(binding, run, origin, SHA);
    try {
      expect(delegation.record).toMatchObject({ status: 'verified', workspaceId: binding.customerWorkspaceId,
        organizationId: binding.organizationId, configuration: { source: { hostId: binding.hostId } } });
      expect(delegation.record.evidenceRef).toContain(`/loopback-health/${binding.hostId}/${SHA.slice(0, 10)}`);
      expect(await readHostedWorkspaceHosting(readerBinding)).toBe('papercusp');
      expect(await readHostedWorkspaceHosting({ ...readerBinding, organizationId: randomUUID() })).toBeNull();
      expect(await readHostedWorkspaceHosting({ ...readerBinding, hostId: 'another-host' })).toBeNull();
    } finally { await delegation.close(); }
    expect(await readHostedWorkspaceHosting(readerBinding)).toBeNull();
  });
  it.each(['retired_at', 'retired_by', 'retired_reason'])(
    'refuses readiness before delegation when the actual migrated schema lacks %s', async column => {
      const binding = await seed();
      await expect(db.adminSql.begin(async tx => {
        // This suite owns its disposable clone. Roll back the legacy schema
        // after the actual PostgreSQL consumer probe refuses it.
        await tx.unsafe(`ALTER TABLE harness_shared.adv_sessions DROP COLUMN ${column}`);
        return preparePublicManualHostedDelegation(binding,
          fn => fn(tx as unknown as Sql), origin, SHA);
      })).rejects.toThrow('hosted_fixture_session_retirement_schema_missing');
      expect(await new PostgresHostedProviderDelegationStore(run, CONTROL)
        .read(binding.customerWorkspaceId, binding.connectionId)).toBeNull();
      await expect(assertPublicManualHostedRuntimeSchema(run)).resolves.toBeUndefined();
    },
  );
  it.each(['unhealthy', 'wrong-source'] as const)('retains invalid delegation after %s private host verification', async failure => {
    const binding = await seed();
    status = failure === 'unhealthy' ? 503 : 200;
    responseSha = failure === 'wrong-source' ? 'aaaaaaaaaa' : SHA.slice(0, 10);
    await expect(preparePublicManualHostedDelegation(binding, run, origin, SHA))
      .rejects.toThrow('hosted_provider_delegation_verification_failed');
    const record = await new PostgresHostedProviderDelegationStore(run, CONTROL).read(binding.customerWorkspaceId, binding.connectionId);
    expect(record?.status).toBe('invalid');
    expect(record?.verifiedAt).toBeUndefined();
    expect(await readHostedWorkspaceHosting({ ...binding, routeLabel: 'manual-regression', generation: 1,
      state: 'active', transport: 'websocket' })).toBeNull();
  });
  it('purges only the owned connector and its tickets so the TEST workspace can be deleted', async () => {
    const own = await seed();
    const neighbor = await seed();
    const routeLabel = `manual-${randomUUID()}`;
    for (const [binding, label] of [[own, routeLabel], [neighbor, `neighbor-${routeLabel}`]] as const) {
      await service(sql => sql`INSERT INTO papercusp_auth.hosted_workspace_connectors
        (control_workspace_id,organization_id,customer_workspace_id,host_id,route_label,state,transport,revoked_at)
        VALUES (${CONTROL},${binding.organizationId},${binding.customerWorkspaceId},${binding.hostId},${label},'revoked','websocket',now())`);
    }
    const hash = 'a'.repeat(64);
    await service(sql => sql`INSERT INTO papercusp_auth.hosted_workspace_connector_tickets
      (ticket_hash,kind,control_workspace_id,organization_id,customer_workspace_id,host_id,route_label,generation,audience,transport,issued_at,expires_at)
      VALUES (${hash},'enrollment',${CONTROL},${own.organizationId},${own.customerWorkspaceId},${own.hostId},${routeLabel},1,'fixture','websocket',now(),now()+interval '1 minute')`);
    await expect(db.adminSql`DELETE FROM harness_shared.customer_workspaces WHERE workspace_id=${CONTROL} AND id=${own.customerWorkspaceId}`)
      .rejects.toMatchObject({ code: '23503' });
    await purgePublicManualHostedConnector(service, { ...own, routeLabel: 'wrong-route' });
    expect((await service(sql => sql`SELECT ticket_hash FROM papercusp_auth.hosted_workspace_connector_tickets WHERE ticket_hash=${hash}`))).toHaveLength(1);
    await purgePublicManualHostedConnector(service, { ...own, routeLabel });
    expect((await service(sql => sql`SELECT ticket_hash FROM papercusp_auth.hosted_workspace_connector_tickets WHERE ticket_hash=${hash}`))).toHaveLength(0);
    expect((await service(sql => sql`SELECT route_label FROM papercusp_auth.hosted_workspace_connectors WHERE customer_workspace_id=${neighbor.customerWorkspaceId}`))).toHaveLength(1);
    const deleted = await db.adminSql`DELETE FROM harness_shared.customer_workspaces WHERE workspace_id=${CONTROL} AND id=${own.customerWorkspaceId} RETURNING id`;
    expect(deleted).toHaveLength(1);
  });
});
