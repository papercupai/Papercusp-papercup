/**
 * Persisted authority → native WS broker → host adapter → real command process.
 * Socket bindings are trusted fixture inputs: ticket issuance/upgrade admission
 * stays in hosted-two-tenant-acceptance.integration.test.ts. The maintained
 * identity wrapper runs under the test UID; this is not SSH/provider acceptance.
 */
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildLoopbackIdentitySpawn } from '@papercusp/papercusp-shared/agent';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { HostedSessionStore } from '../auth/hosted-session';
import { PostgresHostedMembershipAuthority } from '../auth/hosted-membership-authority';
import { createHostedChannelPrincipalResolver } from '../auth/hosted-principal-resolver';
import { HostedWorkspaceSessionBroker } from '../endpoint-route/hosted-workspace-session';
import type { HostedConnectorBinding, HostedConnectorTicketBinding } from '../endpoint-route/hosted-workspace-connector';
import { HostedWorkspaceHostSessionAdapter } from './hosted-session-host';
import { bindHostedCustomerCommandExecutor } from './hosted-customer-command';
import { setTaskManagerEnabledForTest } from '../task-manager/enabled';
import { setAutoPumpEnabledForTests } from '../events/await/engine';

// Keep the actual enrollment/store/event code on the migrated private database.
const privateLedger = vi.hoisted(() => ({ sql: null as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: privateLedger.sql }),
}));
vi.mock('../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace-registry')>()),
  activeWorkspaceId: () => 'hosted-command-acceptance',
  backgroundWorkspaceIds: () => ['hosted-command-acceptance'],
}));

const CONTROL = 'hosted-command-acceptance';
let db: OrgTestDb;
beforeAll(async () => {
  db = await createOrgTestDb({ adminPoolMax: 4 });
  privateLedger.sql = db.adminSql;
  setTaskManagerEnabledForTest(true);
  // Persist terminal events without delivering any host wake from this fixture.
  setAutoPumpEnabledForTests(false);
}, 180_000);
afterAll(async () => {
  setTaskManagerEnabledForTest();
  setAutoPumpEnabledForTests(true);
  await db?.cleanup();
});
afterEach(() => { vi.unstubAllEnvs(); });

async function tenant(label: string, root: string) {
  const sql = db.adminSql;
  const userId = randomUUID(), organizationId = randomUUID(), customerWorkspaceId = randomUUID();
  const hostId = `command-host-${customerWorkspaceId}`, connectionId = `command-connection-${customerWorkspaceId}`;
  await sql`
    INSERT INTO papercusp_auth.hosted_users (id, primary_email, display_name)
    VALUES (${userId}::uuid, ${`${userId}@example.test`}, 'Same display name')
  `;
  await sql`
    INSERT INTO papercusp_auth.organizations (id, external_organization_id, display_name)
    VALUES (${organizationId}::uuid, ${`workos-${organizationId}`}, 'Same organization name')
  `;
  await sql`
    INSERT INTO papercusp_auth.organization_memberships
      (organization_id, user_id, role, status, authority, created_via)
    VALUES (${organizationId}::uuid, ${userId}::uuid, 'owner', 'active', 'papercusp', 'organization_bootstrap')
  `;
  await sql`
    INSERT INTO harness_shared.workspace_host_connections
      (workspace_id, id, target, label, credential_ref, status)
    VALUES (${CONTROL}, ${connectionId}, 'gcp', 'Same connection', 'acceptance://no-provider', 'connected')
  `;
  await sql`
    INSERT INTO harness_shared.workspace_hosts
      (workspace_id, id, name, connection_id, target, scope_label, region,
       size, image, disk_gib, network, desired_state, observed_state)
    VALUES (${CONTROL}, ${hostId}, 'Same host name', ${connectionId}, 'gcp', 'acceptance',
      'us-central1', 'n2-standard-2', 'ubuntu-2404', 40, 'default', 'running', 'running')
  `;
  await sql`
    INSERT INTO harness_shared.customer_workspaces
      (workspace_id, id, organization_id, workspace_host_id, display_name,
       state, created_by_principal_kind, created_by_principal_id)
    VALUES (${CONTROL}, ${customerWorkspaceId}, ${organizationId}, ${hostId}, 'Same workspace name',
      'active', 'user', ${userId})
  `;
  const store = new HostedSessionStore(sql);
  const membershipAuthority = new PostgresHostedMembershipAuthority(sql);
  const authority = await membershipAuthority.resolveActive({ userId, organizationId });
  if (!authority) throw new Error('missing command acceptance membership');
  const session = await store.create({ userId, organizationId, workspaceId: customerWorkspaceId,
    permissionVersion: authority.permissionVersion, upstreamProvider: 'workos',
    upstreamSessionId: `command-session-${userId}`, expiresAt: new Date(Date.now() + 60 * 60_000) });
  const binding: HostedConnectorBinding = { controlPlaneWorkspaceId: CONTROL, organizationId,
    customerWorkspaceId, hostId, routeLabel: `command-${label}`, generation: 1, transport: 'websocket', state: 'active' };
  const ticket: HostedConnectorTicketBinding = { ...binding, kind: 'session', audience: 'workspace-operator',
    userId, hostedSessionId: session.id, expiresAt: new Date(Date.now() + 60_000) };
  const home = join(root, label), project = join(home, "project ' $literal");
  mkdirSync(project, { recursive: true });
  const transform = vi.fn(buildLoopbackIdentitySpawn({
    transportCommand: '/bin/bash', transportArgs: ['-c'], identity: 'test-customer',
    nodePath: process.execPath, remoteHome: home, spawnRoot: join(home, 'spawns'),
    localHome: root, baseEnv: process.env, remotePath: ['/usr/bin', '/bin'],
  }));
  return { binding, ticket, session, store, project, transform };
}

async function terminalTask(taskId: string, t: Awaited<ReturnType<typeof tenant>>,
  state: 'exited' | 'killed' | 'timed_out', exitCode?: number) {
  const read = async () => (await db.adminSql`
    SELECT task_id, workspace_id, launched_by, session_id, class, state,
           exit_code, exit_reason, ended_at, detail
      FROM harness_shared.task_ledger WHERE task_id = ${taskId}
  `)[0];
  await expect.poll(async () => (await read())?.state).toBe(state);
  const row = await read();
  expect(row).toMatchObject({ task_id: taskId, workspace_id: CONTROL,
    launched_by: t.session.userId, session_id: t.session.id, class: 'other', state,
    detail: { customerWorkspaceId: t.binding.customerWorkspaceId,
      organizationId: t.binding.organizationId, foreground: true } });
  expect(row!.ended_at).toBeTruthy();
  if (exitCode !== undefined) expect(row!.exit_code).toBe(exitCode);
  // closeTask's real terminal bridge must also finish before DB teardown.
  await expect.poll(async () => (await db.adminSql`
    SELECT fire_count FROM harness_shared.event_key_fires
     WHERE event_key = ${`task:terminal:${taskId}`}
  `)[0]?.fire_count).toBe(1);
  return row!;
}

async function taskCount(t: Awaited<ReturnType<typeof tenant>>) {
  return (await db.adminSql`
    SELECT count(*)::int AS count FROM harness_shared.task_ledger
     WHERE workspace_id = ${CONTROL} AND session_id = ${t.session.id}
  `)[0]!.count as number;
}

describe.sequential('persisted hosted channel command acceptance', () => {
  it.each([
    ...(['session-expiry', 'session-revocation', 'role-version', 'membership-revocation'] as const).map(ending => [
      `refuses command side effects after ${ending} on the original native channel while tenant B executes`, ending,
    ] as const),
    ['accounts for success, nonzero exit, cancellation, timeout and retry on the native channel', 'task-ledger-lifecycle'] as const,
    ...(['browser-detach', 'connector-disconnect'] as const).map(ending => [
      `settles a running command after ${ending} and refuses the old channel while tenant B executes`, ending,
    ] as const),
  ])('%s', async (_title, ending) => {
      const root = mkdtempSync(join(tmpdir(), 'hosted-channel-command-'));
      const sockets: WebSocket[] = [];
      const adapters: HostedWorkspaceHostSessionAdapter[] = [];
      const errors: unknown[] = [];
      let server: WebSocketServer | undefined, broker: HostedWorkspaceSessionBroker | undefined;
      try {
        vi.stubEnv('OPERATOR_DB_URL', 'synthetic-private-db');
        vi.stubEnv('PAPERCUSP_SID', 'synthetic-private-session');
        const tenants = [await tenant('a', root), await tenant('b', root)];
        const sessionStore = new HostedSessionStore(db.adminSql);
        const membershipAuthority = new PostgresHostedMembershipAuthority(db.adminSql);
        broker = new HostedWorkspaceSessionBroker({ pingIntervalMs: 0,
          resolveChannelPrincipal: binding => createHostedChannelPrincipalResolver({
            controlPlaneWorkspaceId: CONTROL, sessionStore, membershipAuthority,
          }, binding)(),
        });
        server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
        server.on('error', error => errors.push(error));
        server.on('connection', (socket, request) => {
          socket.on('error', error => errors.push(error));
          const match = /^\/(host|browser)\/([01])$/.exec(request.url ?? '');
          if (!match) { socket.close(4403); return; }
          const t = tenants[Number(match[2])];
          // Deliberately trusted bindings, supplied on the server side only.
          if (match[1] === 'host') broker!.attachConnector(t.binding, socket);
          else broker!.attachBrowser(t.ticket, socket, { kind: 'operator-http' });
        });
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('private command socket address unavailable');
        const base = `ws://127.0.0.1:${address.port}`;
        const dial = async (path: string) => {
          const socket = new WebSocket(`${base}${path}`);
          const frames: Array<Record<string, unknown>> = [];
          sockets.push(socket);
          socket.on('message', data => frames.push(JSON.parse(data.toString())));
          socket.on('error', error => errors.push(error));
          await once(socket, 'open');
          return { socket, frames };
        };
        const connections = [];
        for (const [index, t] of tenants.entries()) {
          const host = await dial(`/host/${index}`);
          const adapter = new HostedWorkspaceHostSessionAdapter({ binding: t.binding, workspaceRoot: t.project,
            send: frame => { host.socket.send(JSON.stringify(frame)); },
          });
          adapters.push(adapter);
          host.socket.on('message', data => { void adapter.accept(JSON.parse(data.toString())).catch(error => errors.push(error)); });
          host.socket.on('close', () => adapter.close());
          const browser = await dial(`/browser/${index}`);
          await vi.waitFor(() => expect(browser.frames).toContainEqual(expect.objectContaining({ type: 'session.bound' })));
          const channelId = browser.frames.find(frame => frame.type === 'session.bound')!.channelId as string;
          await vi.waitFor(() => expect(host.frames).toContainEqual(expect.objectContaining({ type: 'relay.open', channelId })));
          const deps = { resolvePrincipal: () => adapter.resolveCustomerPrincipal(channelId),
            sessionHeaders: new Headers(), customerWorkspaceId: t.binding.customerWorkspaceId,
            projectDir: t.project, transform: t.transform };
          const executor = await bindHostedCustomerCommandExecutor(deps);
          const foreign = tenants[1 - index].binding.customerWorkspaceId;
          await expect(bindHostedCustomerCommandExecutor({ ...deps, customerWorkspaceId: foreign }))
            .rejects.toThrow('hosted_customer_execution_denied');
          expect(t.transform).not.toHaveBeenCalled();
          connections.push({ t, host, browser, channelId, adapter, executor });
        }
        const [a, b] = connections;
        const first = await a.executor.run({ command: 'printf tenant-a > before; printf "%s|%s" "$OPERATOR_DB_URL" "$PAPERCUSP_SID"' });
        expect(first).toMatchObject({ exitCode: 0, stdout: '|', stderr: '', signal: null, taskEnrolled: true });
        await terminalTask(first.taskId, a.t, 'exited', 0);
        expect(await taskCount(a.t)).toBe(1);
        expect(await taskCount(b.t)).toBe(0);
        expect(readFileSync(join(a.t.project, 'before'), 'utf8')).toBe('tenant-a');
        expect(existsSync(join(b.t.project, 'before'))).toBe(false);
        expect(a.t.transform).toHaveBeenCalledTimes(1);

        const transportLost = ending === 'browser-detach' || ending === 'connector-disconnect';
        if (transportLost) {
          // Use the production channel lifetime, rather than aborting the command
          // directly: the native transport must be what revokes the invocation.
          const lifetime = a.adapter.customerInvocationSignal(a.channelId);
          const pidFile = join(a.t.project, 'transport-loss.pid');
          const operation = a.executor.run({
            command: 'printf \'%s\' "$$" > transport-loss.pid; exec sleep 300',
            signal: lifetime, timeoutMs: 20_000,
          });
          const rejected = expect(operation).rejects.toThrow('hosted_customer_execution_aborted');
          await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
          const payloadPid = Number(readFileSync(pidFile, 'utf8'));
          expect(Number.isSafeInteger(payloadPid) && payloadPid > 0).toBe(true);
          const runningTask = async () => (await db.adminSql`
            SELECT task_id FROM harness_shared.task_ledger
             WHERE workspace_id = ${CONTROL} AND session_id = ${a.t.session.id}
               AND state = 'running'
          `);
          await expect.poll(async () => (await runningTask()).length).toBe(1);
          const [running] = await runningTask();
          if (ending === 'browser-detach') {
            a.browser.socket.send(JSON.stringify({ type: 'session.detach' }));
          } else {
            a.host.socket.close(1000, 'acceptance_connector_disconnect');
          }
          await rejected;
          expect(lifetime.aborted).toBe(true);
          const stopped = await terminalTask(running!.task_id, a.t, 'killed');
          expect(stopped.exit_reason).toBe('hosted_customer_execution_aborted');
          expect(() => process.kill(payloadPid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
          await expect.poll(() => a.browser.socket.readyState).toBe(WebSocket.CLOSED);
        } else if (ending === 'task-ledger-lifecycle') {
          const nonzero = await b.executor.run({ command: 'printf failed >&2; exit 7' });
          expect(nonzero).toMatchObject({ exitCode: 7, stdout: '', stderr: 'failed', taskEnrolled: true });
          await terminalTask(nonzero.taskId, b.t, 'exited', 7);
          for (const reason of ['cancelled', 'deadline'] as const) {
            const abort = new AbortController();
            const pidFile = join(b.t.project, `${reason}.pid`);
            const operation = b.executor.run({
              command: `printf '%s' "$$" > ${reason}.pid; exec sleep 300`,
              signal: abort.signal, timeoutMs: reason === 'deadline' ? 1_000 : 20_000,
            });
            const rejected = expect(operation).rejects.toThrow('hosted_customer_execution_aborted');
            await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
            const payloadPid = Number(readFileSync(pidFile, 'utf8'));
            expect(Number.isSafeInteger(payloadPid) && payloadPid > 0).toBe(true);
            await expect.poll(async () => (await db.adminSql`
              SELECT task_id FROM harness_shared.task_ledger
               WHERE workspace_id = ${CONTROL} AND session_id = ${b.t.session.id}
                 AND state = 'running'
            `).length).toBe(1);
            const [running] = await db.adminSql`
              SELECT task_id FROM harness_shared.task_ledger
               WHERE workspace_id = ${CONTROL} AND session_id = ${b.t.session.id}
                 AND state = 'running'
            `;
            if (reason === 'cancelled') abort.abort();
            await rejected;
            const stopped = await terminalTask(running!.task_id, b.t,
              reason === 'deadline' ? 'timed_out' : 'killed');
            expect(stopped.exit_reason).toBe('hosted_customer_execution_aborted');
            expect(() => process.kill(payloadPid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
          }
        } else if (ending === 'session-expiry') {
          const changed = await db.adminSql<Array<{ id: string }>>`
            UPDATE papercusp_auth.hosted_sessions
               SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
             WHERE id = ${a.t.session.id} RETURNING id
          `;
          expect(changed).toEqual([{ id: a.t.session.id }]);
        } else if (ending === 'session-revocation') {
          expect(await a.t.store.revoke(a.t.session.id, 'command_acceptance_logout')).toBe(true);
        } else if (ending === 'role-version') {
          const changed = await db.adminSql<Array<{ user_id: string }>>`
            UPDATE papercusp_auth.organization_memberships
               SET role = 'member', updated_at = updated_at + interval '2 seconds'
             WHERE organization_id = ${a.t.session.organizationId}::uuid AND user_id = ${a.t.session.userId}::uuid
            RETURNING user_id
          `;
          expect(changed).toEqual([{ user_id: a.t.session.userId }]);
        } else {
          const changed = await db.adminSql<Array<{ user_id: string }>>`
            UPDATE papercusp_auth.organization_memberships
               SET status = 'revoked', revoked_at = now(), updated_at = updated_at + interval '2 seconds'
             WHERE organization_id = ${a.t.session.organizationId}::uuid AND user_id = ${a.t.session.userId}::uuid
            RETURNING user_id
          `;
          expect(changed).toEqual([{ user_id: a.t.session.userId }]);
        }
        if (ending !== 'task-ledger-lifecycle') {
          // Reuse the bound executor/channel, rather than reconnecting after revocation.
          await expect(a.executor.run({ command: 'printf forbidden > forbidden' }))
            .rejects.toThrow('hosted_customer_execution_denied');
        }
        expect(a.t.transform).toHaveBeenCalledTimes(transportLost ? 2 : 1);
        expect(await taskCount(a.t)).toBe(transportLost ? 2 : 1);
        expect(existsSync(join(a.t.project, 'forbidden'))).toBe(false);
        expect(readFileSync(join(a.t.project, 'before'), 'utf8')).toBe('tenant-a');
        const survivor = await b.executor.run({ command: 'printf tenant-b > survivor; printf survivor' });
        expect(survivor).toMatchObject({ exitCode: 0, stdout: 'survivor', stderr: '', signal: null, taskEnrolled: true });
        await terminalTask(survivor.taskId, b.t, 'exited', 0);
        expect(readFileSync(join(b.t.project, 'survivor'), 'utf8')).toBe('tenant-b');
        expect(existsSync(join(a.t.project, 'survivor'))).toBe(false);
        expect(b.t.transform).toHaveBeenCalledTimes(ending === 'task-ledger-lifecycle' ? 4 : 1);
        expect(await taskCount(b.t)).toBe(ending === 'task-ledger-lifecycle' ? 4 : 1);
        for (const connection of transportLost ? [b] : connections) {
          expect(connection.host.socket.readyState).toBe(WebSocket.OPEN);
          expect(connection.browser.socket.readyState).toBe(WebSocket.OPEN);
        }
        if (ending === 'browser-detach') expect(a.host.socket.readyState).toBe(WebSocket.OPEN);
        if (ending === 'connector-disconnect') expect(a.host.socket.readyState).toBe(WebSocket.CLOSED);
        expect(errors).toEqual([]);
      } finally {
        for (const adapter of adapters) adapter.close();
        broker?.dispose();
        for (const socket of sockets) socket.terminate();
        if (server) {
          for (const socket of server.clients) socket.terminate();
          await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
        }
        rmSync(root, { recursive: true, force: true });
        expect(existsSync(root)).toBe(false);
      }
    }, 30_000,
  );
});
