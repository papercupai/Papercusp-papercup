/**
 * Private R1 browser runtime. Run through the maintained isolated-PG wrapper:
 * node scripts/with-test-pg.mjs --isolated-runtime=operator-api -- node --import tsx
 *   packages/operator-core/lib/workspace-host/machine-first-browser-runtime.fixture.ts --smoke
 * Omit --smoke and add --local-gui for the actual local operator browser UI.
 *
 * Uses the production hosted handler, persisted sessions/device grants, and two
 * independently enrolled operator processes. It never provisions paid machines.
 * This fixture's smoke receipt is transport evidence, not complete GUI acceptance.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { createServer as httpsServer } from 'node:https';
import { chmod, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const control = process.env.PAPERCUSP_WORKSPACE_ID ?? '';
const admin = new URL(process.env.HARNESS_ADMIN_DATABASE_URL ?? 'file:missing');
const appDb = new URL(process.env.HARNESS_DATABASE_URL ?? 'file:missing');
assert(process.env.PAPERCUSP_SKIP_PG_DISCOVERY === '1' && control.startsWith('test-runtime-'),
  'Requires with-test-pg --isolated-runtime=operator-api');
assert(['127.0.0.1', 'localhost'].includes(admin.hostname) && admin.host === appDb.host
  && admin.pathname === appDb.pathname && admin.port === process.env.PAPERCUSP_PG_PORT,
  'Requires the wrapper-owned private database');
const evidence = process.env.MACHINE_FIRST_RUNTIME_EVIDENCE ?? '/tmp/machine-first-two-target-runtime';
const privateRoot = join(process.env.HOME!, 'machine-first-two-targets');
await mkdir(privateRoot, { recursive: true, mode: 0o700 });
const containerSsh = process.env.MACHINE_FIRST_RUNTIME_CONTAINER_SSH === '1';
if (containerSsh) {
  // Only the container fixture may expose traversable parents to its real
  // customer SSH account. Private files retain their existing 0600 modes.
  await readFile('/run/.containerenv');
  const runtimeRoot = dirname(process.env.HOME!);
  assert(dirname(runtimeRoot) === process.env.PAPERCUSP_TEST_RUNTIME_TMP_BASE
    && runtimeRoot.split('/').at(-1)!.startsWith('papercusp-test-runtime-'),
  'Requires wrapper-owned runtime HOME');
  for (const path of [dirname(process.env.HOME!), process.env.HOME!, privateRoot]) await chmod(path, 0o711);
}
const children: Array<{ name: string; process: ChildProcess }> = [];
const status: Record<string, unknown> = { status: 'starting', controlWorkspace: control,
  sourceRoot: repo, startedAt: new Date().toISOString(), scope: 'two private operator processes on one OS host' };
const save = () => writeFile(`${evidence}.json`, JSON.stringify(status, null, 2));
const stage = async (phase: string) => {
  status.phase = phase;
  await save();
  console.log(JSON.stringify({ phase, at: new Date().toISOString() }));
};
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
// A forgotten browser rig must not become an unowned permanent service.
const deadline = setTimeout(() => { stopping = true; }, 15 * 60_000);

async function freePort() {
  const server = netServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
function start(name: string, env: NodeJS.ProcessEnv) {
  const fd = openSync(`${evidence}-${name}.log`, 'w', 0o600);
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/operator/bin/serve.ts'],
    { cwd: repo, env: { ...env, PAPERCUSP_USE_EMBEDDED_PG: '0' }, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  child.on('error', () => { stopping = true; });
  children.push({ name, process: child });
  return child;
}
async function waitFor<T>(name: string, probe: () => Promise<T | false>, ms = 120_000): Promise<T> {
  const until = Date.now() + ms;
  let last = 'not-ready';
  while (Date.now() < until && !stopping) {
    const exited = children.find(c => c.process.exitCode !== null || c.process.signalCode !== null);
    assert(!exited, `${exited?.name} exited; inspect its retained private log`);
    try { const result = await probe(); if (result !== false) return result; }
    catch (error) { last = error instanceof Error ? error.name : 'probe-error'; }
    await delay(500);
  }
  throw new Error(`${name}: ${stopping ? 'stopped' : 'readiness deadline'} (${last})`);
}

let server: import('node:https').Server | undefined;
let hosted: Awaited<ReturnType<typeof import('../../../../apps/operator/bin/hosted-handler').createHostedHandlerFromEnvironment>> | undefined;
let localGui: import('vite').ViteDevServer | undefined;
try {
  await stage('source-census');
  const sourcePaths = [
    'apps/operator/bin/host-app.ts', 'apps/operator/bin/hosted-handler.ts',
    'packages/operator-core/lib/workspace-host/local-machine-operator-transport.ts',
    'packages/operator-core/lib/workspace-host/hosted-workspace-host-runtime.ts',
    'packages/operator-core/lib/workspace-host/hosted-session-host.ts',
    'packages/operator-core/lib/workspace-host/hosted-operator-http.ts',
    'packages/operator-core/lib/workspace-host/operator-relay-client.ts',
    'packages/operator-core/lib/endpoint-route/routes/hosted-cli/index.ts',
    'packages/operator-core/lib/endpoint-route/routes/hosted-cli/store.ts',
    'packages/operator-core/lib/workspace-context-middleware.ts',
    'packages/operator-core/lib/workspace-host/machine-first-browser-runtime.fixture.ts',
    'apps/operator/scripts/install-standalone-mcp.sh',
  ];
  status.sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async p =>
    [p, digest(await readFile(join(repo, p), 'utf8'))])));
  status.head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const certPath = join(privateRoot, 'cert.pem'), keyPath = join(privateRoot, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore', timeout: 10_000 });
  const port = await freePort();
  const origin = `https://127.0.0.1:${port}`;
  const cookieSecret = randomBytes(48).toString('base64url');
  const config = { ...process.env, PAPERCUSP_HOSTED_PUBLIC_ORIGIN: origin,
    PAPERCUSP_HOSTED_CONTROL_PLANE_WORKSPACE_ID: control,
    PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET_REF: 'env:MF_PRIVATE_COOKIE_SECRET',
    WORKOS_API_KEY_REF: 'env:MF_PRIVATE_WORKOS_KEY', WORKOS_COOKIE_PASSWORD_REF: 'env:MF_PRIVATE_COOKIE_SECRET',
    WORKOS_WEBHOOK_SECRET_REF: 'env:MF_PRIVATE_COOKIE_SECRET', WORKOS_CLIENT_ID: 'client_private_r1',
    MF_PRIVATE_COOKIE_SECRET: cookieSecret, MF_PRIVATE_WORKOS_KEY: 'sk_test_private_r1_no_external_auth' };
  // env: references use the resolver's process environment, independently of
  // the configuration object passed to the hosted composition root.
  process.env.MF_PRIVATE_COOKIE_SECRET = config.MF_PRIVATE_COOKIE_SECRET;
  process.env.MF_PRIVATE_WORKOS_KEY = config.MF_PRIVATE_WORKOS_KEY;
  await stage('hosted-handler-import');
  const { createHostedHandlerFromEnvironment } = await import('../../../../apps/operator/bin/hosted-handler');
  await stage('hosted-handler-compose');
  hosted = await createHostedHandlerFromEnvironment(config);
  const { publicManualHostedUpgradeHeaders } = await import('../llm-testing/public-manual-hosted-fixture');
  server = serve({ fetch: hosted.handler, port, hostname: '127.0.0.1', createServer: httpsServer,
    serverOptions: { key: await readFile(keyPath), cert: await readFile(certPath) } }) as import('node:https').Server;
  server.on('upgrade', (req, socket, head) => {
    req.headers = publicManualHostedUpgradeHeaders(req, origin);
    void hosted!.upgrade(req, socket, head).then(handled => { if (!handled) socket.destroy(); }, () => socket.destroy());
  });
  await stage('private-identity-seed');
  const { getOrgPg, withHostedServiceContext, withWorkspace } = await import('@papercusp/db-org');
  const sql = getOrgPg().sql;
  const userId = randomUUID(), orgId = randomUUID();
  await sql`INSERT INTO papercusp_auth.hosted_users (id, primary_email, display_name)
    VALUES (${userId}::uuid, ${`r1-${userId}@example.invalid`}, 'Private R1 operator')`;
  await sql`INSERT INTO papercusp_auth.organizations (id, external_organization_id, display_name)
    VALUES (${orgId}::uuid, ${`r1-${orgId}`}, 'Private R1 organization')`;
  await sql`INSERT INTO papercusp_auth.organization_memberships
    (organization_id, user_id, role, status, authority, created_via)
    VALUES (${orgId}::uuid, ${userId}::uuid, 'owner', 'active', 'papercusp', 'organization_bootstrap')`;
  const targets: Array<{ label: string; hostId: string; workspaceId: string; organizationId: string; origin: string;
    home: string; workspaceRoot: string; pid: number | undefined }> = [];
  for (const label of ['a', 'b']) {
    await stage(`target-${label}-seed`);
    // The production instance-cap index permits one live hosted workspace per
    // organization. Exercise real multi-signin routing without weakening it.
    const organizationId = label === 'a' ? orgId : randomUUID();
    if (label !== 'a') {
      await sql`INSERT INTO papercusp_auth.organizations (id, external_organization_id, display_name)
        VALUES (${organizationId}::uuid, ${`r1-${organizationId}`}, 'Private R1 second organization')`;
      await sql`INSERT INTO papercusp_auth.organization_memberships
        (organization_id, user_id, role, status, authority, created_via)
        VALUES (${organizationId}::uuid, ${userId}::uuid, 'owner', 'active', 'papercusp', 'organization_bootstrap')`;
    }
    const workspaceId = `${control}-${label}`, hostId = `r1-host-${label}`, connectionId = `r1-connection-${label}`;
    const provider = { hostedDelegation: { status: 'verified', workspaceId,
      configuration: { provider: 'gcp', source: { method: 'papercusp-hosted' } } } };
    await sql`INSERT INTO harness_shared.workspace_host_connections
      (workspace_id, id, target, label, credential_ref, status, provider_config)
      VALUES (${control}, ${connectionId}, 'gcp', ${`Private target ${label}`},
        'fixture://no-paid-provider', 'connected', ${sql.json(provider)})`;
    await sql`INSERT INTO harness_shared.workspace_hosts
      (workspace_id, id, name, connection_id, target, scope_label, region, size, image,
       disk_gib, network, desired_state, observed_state)
      VALUES (${control}, ${hostId}, ${`R1 machine ${label.toUpperCase()}`}, ${connectionId}, 'gcp',
       'private-process', 'loopback', 'private', 'source', 1, 'loopback', 'running', 'running')`;
    await sql`INSERT INTO harness_shared.customer_workspaces
      (workspace_id, id, organization_id, workspace_host_id, display_name, state,
       created_by_principal_kind, created_by_principal_id)
      VALUES (${control}, ${workspaceId}, ${organizationId}::uuid, ${hostId}, ${`R1 machine ${label.toUpperCase()}`},
       'active', 'user', ${userId})`;
    const gateway = hosted.plane.components.connectorGateway!;
    const enrollment = await gateway.enroll({ controlPlaneWorkspaceId: control, organizationId,
      customerWorkspaceId: workspaceId, hostId, routeLabel: `r1-${label}`, transport: 'websocket' });
    const credential = await gateway.register(enrollment.ticket);
    assert(credential, 'Persisted connector enrollment must register');
    const targetHome = join(privateRoot, label), workspaceRoot = join(targetHome, 'project');
    await mkdir(workspaceRoot, { recursive: true });
    if (containerSsh) await chmod(workspaceRoot, 0o770);
    const targetPort = await freePort(), ingressPort = await freePort();
    const env = { ...process.env, HOME: targetHome, PAPERCUSP_HOME: join(targetHome, '.papercusp'),
      PAPERCUSP_WORKSPACES_ROOT: join(targetHome, 'workspaces'), PAPERCUSP_WORKSPACE: workspaceId,
      PAPERCUSP_WORKSPACE_ID: workspaceId, PAPERCUSP_POT_HOME_SLUG: workspaceId,
      PAPERCUSP_HONO_PORT: String(targetPort), PORT: String(targetPort),
      PAPERCUSP_EXTERNAL_INGRESS_PORT: String(ingressPort),
      PAPERCUSP_HOSTED_CONTROL_PLANE_URL: origin, PAPERCUSP_HOSTED_CONNECTOR_BEARER: credential.bearer,
      PAPERCUSP_HOSTED_WORKSPACE_ROOT: workspaceRoot, NODE_EXTRA_CA_CERTS: certPath };
    const child = start(`target-${label}`, env);
    targets.push({ label, hostId, workspaceId, organizationId, origin: `http://127.0.0.1:${targetPort}`,
      home: targetHome, workspaceRoot, pid: child.pid });
  }
  await stage('saved-cli-signin');
  const { PostgresHostedCliStore } = await import('../endpoint-route/routes/hosted-cli/store');
  const cli = new PostgresHostedCliStore(withHostedServiceContext,
    fn => withWorkspace(control, fn), control);
  const { normalizeHostedProfile, savePsuConnectionStore, PSU_CONNECTION_STORE_VERSION } = await import('../../../../apps/operator/scripts/psu-connection-front-controller.mjs');
  const expiresAt = new Date(Date.now() + 30 * 60_000);
  const profiles = [];
  for (const target of targets) {
    const grant = randomBytes(32).toString('base64url'), token = `pct_${randomBytes(32).toString('base64url')}`;
    const tokenId = `hct_${randomBytes(16).toString('base64url')}`;
    const userCode = target.label === 'a' ? 'R1AA-0001' : 'R1BB-0002';
    assert(await cli.createGrant({ deviceCodeHash: digest(grant), userCode,
      clientLabel: 'Private R1 browser', createdAt: new Date(), expiresAt }));
    assert(await cli.decideGrant({ userCode, decision: 'approved', userId,
      organizationId: target.organizationId, at: new Date() }));
    assert.equal((await cli.exchangeGrant({ deviceCodeHash: digest(grant), now: new Date(),
      minPollIntervalMs: 0, token: { id: tokenId, tokenHash: digest(token), expiresAt } })).status, 'issued');
    profiles.push(normalizeHostedProfile({ name: `private-r1-${target.label}`, origin,
      accessToken: token, tokenId, userId, organizationId: target.organizationId,
      organizationName: `Private R1 ${target.label}`, expiresAt }));
  }
  savePsuConnectionStore({ version: PSU_CONNECTION_STORE_VERSION, profiles });
  const session = await hosted.plane.components.sessionStore.create({ userId, organizationId: orgId,
    workspaceId: targets[0].workspaceId, permissionVersion: 1, upstreamProvider: 'private-r1',
    upstreamSessionId: randomUUID(), expiresAt });
  const { HOSTED_SESSION_COOKIE } = await import('../auth/hosted-session');
  await writeFile(`${evidence}.auth.json`, JSON.stringify({ cookie: { name: HOSTED_SESSION_COOKIE,
    value: hosted.plane.components.sessionCookieCodec.encode(session.id), url: origin,
    secure: true, httpOnly: true, sameSite: 'Lax' } }), { mode: 0o600 });
  const localPort = await freePort();
  const localOrigin = `http://127.0.0.1:${localPort}`;
  const localGuiPort = process.argv.includes('--local-gui') ? await freePort() : undefined;
  const portalOrigin = `http://127.0.0.1:${await freePort()}`;
  // Browser POSTs carry Origin even behind the dev/Portal proxy. Configure only
  // this rig's exact origins through the production launcher's existing hints.
  status.portalOrigin = portalOrigin;
  // A local install has its own registry and control partition. Sharing the
  // hosted control partition makes the fixture's provider rows shadow saved
  // sign-in rows, hiding the real connector tunnel from the desktop reader.
  const localWorkspaceId = `${control}-local`;
  const localWorkspacesRoot = join(privateRoot, 'local-workspaces');
  await mkdir(join(localWorkspacesRoot, localWorkspaceId), { recursive: true });
  await writeFile(join(localWorkspacesRoot, 'registry.json'), JSON.stringify({
    current: localWorkspaceId,
    workspaces: [{ id: localWorkspaceId, name: 'R1 local browser', createdAt: Date.now() }],
  }), { mode: 0o600 });
  status.origin = origin; status.localOrigin = localOrigin; status.targets = targets;
  status.localWorkspaceId = localWorkspaceId;
  start('local', { ...process.env, PAPERCUSP_HONO_PORT: String(localPort), PORT: String(localPort),
    PAPERCUSP_WORKSPACE: localWorkspaceId, PAPERCUSP_WORKSPACE_ID: localWorkspaceId,
    PAPERCUSP_WORKSPACES_ROOT: localWorkspacesRoot,
    OPERATOR_E2E_BASE_URL: localGuiPort ? `http://127.0.0.1:${localGuiPort}` : localOrigin,
    OPERATOR_BASE_URL: portalOrigin,
    NODE_EXTRA_CA_CERTS: certPath });
  const { isHostedConnectorLive } = await import('../endpoint-route/hosted-workspace-connector');
  await stage('wait-two-connectors');
  const current = await waitFor('two connectors', async () => {
    const rows = (await Promise.all(targets.map(t => cli.listWorkspaces(t.organizationId)))).flat();
    return rows.length === 2 && rows.every(row => isHostedConnectorLive(row.connector, new Date()))
      && targets.every(t => hosted!.relay.appConnector(t.workspaceId)?.binding.hostId === t.hostId)
      ? rows.map(row => ({ id: row.id, hostId: row.hostId,
        generation: row.connector!.generation, heartbeatAt: row.connector!.heartbeatAt })) : false;
  });
  if (containerSsh) {
    await stage('install-target-launchers');
    // Install the production launcher into each disposable target HOME. A
    // deferred launch returning psu_not_installed is not routing evidence.
    // The maintained installer also verifies that target's real MCP endpoint.
    for (const target of targets) {
      const fd = openSync(`${evidence}-install-${target.label}.log`, 'w', 0o600);
      try {
        execFileSync('bash', ['apps/operator/scripts/install-standalone-mcp.sh'], {
          cwd: repo,
          env: { ...process.env, HOME: target.home,
            PAPERCUSP_HOME: join(target.home, '.papercusp'),
            PAPERCUSP_OPERATOR_URL: target.origin, PAPERCUSP_MCP_PROXY: '0',
            PAPERCUSP_WORKSPACE: target.workspaceId, PAPERCUSP_WORKSPACE_ID: target.workspaceId },
          stdio: ['ignore', fd, fd], timeout: 120_000,
        });
        await readFile(join(target.home, '.local/bin/psu'));
      } finally { closeSync(fd); }
    }
    status.targetLaunchersInstalled = true;
  }
  await stage('wait-local-saved-inventory');
  const { readHostedWorkspaceConnector } = await import('../../../../apps/operator/app/cloud-workspaces/hosted-workspace-session-protocol');
  const inventoryResponse = await waitFor('local saved targets', async () => {
    const response = await fetch(`${localOrigin}/api/zero-harness/rest-query?name=workspaceHosts.control`,
      { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return false;
    const body = await response.json();
    return targets.every(t => body.rows?.some((row: any) => row.id === t.hostId
      && row.observedState === 'running'
      && readHostedWorkspaceConnector(row.tunnel)?.routeLabel === `r1-${t.label}`))
      ? { status: response.status, targets: body.rows.filter((row: any) => targets.some(t => t.hostId === row.id)) } : false;
  });
  await stage('verify-remote-destinations');
  if (containerSsh) {
    const { hostedWorkspaceSshArgs } = await import('./hosted-session-host');
    const account = execFileSync('/usr/bin/ssh', [...hostedWorkspaceSshArgs({ tty: false }), 'id -un'],
      { encoding: 'utf8', timeout: 15_000 }).trim();
    assert.equal(account, 'papercusp-workspace', 'Production loopback SSH must reach the customer account');
    status.sshPrerequisite = { account, network: 'owned-container-loopback', verified: true };
  }
  const destinations: Array<{ hostId: string; workspaceId: string; status: number;
    displayName?: string; error?: string }> = [];
  status.destinations = destinations;
  for (const target of targets) {
    // Set a real workspace-scoped product preference at the destination, then
    // independently read it through the local selector's production transport.
    const name = `R1 destination ${target.label}`;
    await waitFor(`target-${target.label}-profile`, async () => {
      const response = await fetch(`${target.origin}/api/profile`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-papercusp-workspace': target.workspaceId },
        body: JSON.stringify({ display_name: name }), signal: AbortSignal.timeout(5000) });
      return response.ok && (await response.json()).display_name === name;
    });
    const response = await fetch(`${localOrigin}/api/profile`, { headers: {
      'x-papercusp-workspace': localWorkspaceId, 'x-papercusp-machine': target.hostId },
      signal: AbortSignal.timeout(20_000) });
    const profile = await response.json();
    destinations.push({ hostId: target.hostId, workspaceId: target.workspaceId,
      status: response.status, displayName: profile.display_name, error: profile.error });
    await save();
    assert.equal(response.status, 200, `Selected ${target.hostId} profile must be reachable (${profile.error ?? 'no error code'})`);
    assert.equal(profile.display_name, name, `Selected ${target.hostId} must reach its own operator`);
  }
  if (process.argv.includes('--local-gui')) {
    await stage('start-local-gui');
    process.env.PAPERCUSP_API_TARGET = localOrigin;
    const { createServer } = await import('vite');
    localGui = await createServer({ root: join(repo, 'apps/operator-vite'),
      configFile: join(repo, 'apps/operator-vite/vite.config.ts'),
      // Container acceptance mounts source read-only. Keep generated config
      // modules and dependency optimization out of the shared checkout.
      configLoader: 'runner',
      cacheDir: join(privateRoot, 'vite-cache'),
      server: { host: '127.0.0.1', port: localGuiPort!, strictPort: true, hmr: false, watch: null } });
    await localGui.listen();
    status.localGuiOrigin = localGui.resolvedUrls?.local[0]?.replace(/\/$/, '');
    assert(status.localGuiOrigin, 'Local GUI must expose its actual loopback origin');
  }
  status.status = 'ready'; status.origin = origin; status.localOrigin = localOrigin;
  status.targets = targets; status.account = { userId, organizationIds: targets.map(t => t.organizationId) };
  status.connectors = current; status.inventory = inventoryResponse;
  status.destinations = destinations;
  status.certificatePath = certPath; status.authFile = `${evidence}.auth.json`;
  await save();
  console.log(JSON.stringify({ status: 'ready', evidence: `${evidence}.json`, origin, localOrigin,
    targets: targets.map(({ hostId, workspaceId }) => ({ hostId, workspaceId })) }));
  if (!process.argv.includes('--smoke')) while (!stopping) await delay(500);
} catch (error) {
  status.status = 'failed'; status.error = error instanceof Error ? error.message : 'runtime failed';
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await localGui?.close();
  for (const child of children) child.process.kill('SIGTERM');
  await delay(1500);
  for (const child of children) if (child.process.exitCode === null && child.process.signalCode === null)
    child.process.kill('SIGKILL');
  await delay(300);
  server?.closeAllConnections(); server?.close();
  hosted?.relay.dispose();
  status.cleanup = children.map(({ name, process: child }) => ({ name, pid: child.pid,
    exitCode: child.exitCode, signal: child.signalCode }));
  status.stoppedAt = new Date().toISOString();
  if (status.status === 'ready') status.status = 'stopped';
  await rm(`${evidence}.auth.json`, { force: true });
  await save();
  console.log(JSON.stringify({ status: status.status, evidence: `${evidence}.json`, error: status.error }));
  process.exit(process.exitCode ?? 0);
}
