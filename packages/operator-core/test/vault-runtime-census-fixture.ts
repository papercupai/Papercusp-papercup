/** P-009 discovery from a real disposable operator, before profile approval. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getOrgPg, _resetForTests } from '@papercusp/db-org';
import { canonicalJson } from '@papercusp/hash-chain';
import { stopAllManaged } from '@papercusp/scheduled-registry';
import { loadHarnessRegistry, saveHarnessRegistry } from '../lib/harness-registry';
import { readProcessIdentity } from '../lib/process-identity';
import { loadImmutableTextArtifact } from '../lib/text-artifacts';
import { isValidSuperuserBearer, readSuperuserToken, superuserTokenPath } from '../lib/superuser-token';
import { verifyAuthenticatedRuntimeSecurityCensus } from '../lib/coverage-census/security-qualification';
import { operatorArtifactSource, writeOperatorArtifactManifest } from '../lib/release/operator-artifact';
import { preparePrivateHttpWorkspaces, preparePrivateOperatorApiBundle } from './private-http-workspace-preflight';

const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const root = resolve(import.meta.dirname, '../../..');
const evidenceDir = process.env.VAULT_CENSUS_EVIDENCE_DIR!;
let host: ChildProcess | undefined;
let hostIdentity: ReturnType<typeof readProcessIdentity>;

async function unauthenticatedControl(base: string, workspace: string, caller: string,
  request: typeof fetch = fetch) {
  const denied = await request(base + '/api/agent-mcp/run-tool', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, host: new URL(base).host,
      'x-papercusp-workspace': workspace },
    body: JSON.stringify({ name: 'dev:telemetry', args: { view: 'security-census', capture: true,
      harness: workspace }, harness: workspace, callerSid: caller, confirmed: true }),
    signal: AbortSignal.timeout(30_000) });
  const responseBody = await denied.text();
  let refusal: any;
  try { refusal = JSON.parse(responseBody); }
  catch { refusal = { unparsedBody: responseBody }; }
  const observed = { phase: 'unauthenticated-control', httpStatus: denied.status, response: refusal };
  writeFileSync(join(evidenceDir, 'unauthenticated-response.json'), JSON.stringify(observed));
  console.log('VAULT_CENSUS_CONTROL_OBSERVED ' + JSON.stringify(observed));
  // A scope, route, or server failure cannot stand in for this authentication
  // canary: it must reach the signing boundary and refuse the missing actor.
  assert.equal(refusal.result?.isError, true, JSON.stringify(observed));
  assert.match(JSON.stringify(refusal), /security_qualification_authenticated_actor_required/);
}

async function stopHost() {
  if (!host) return;
  if (host.exitCode === null && host.signalCode === null) {
    const closed = new Promise<void>(done => host!.once('close', () => done()));
    host.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([closed, new Promise<void>(done => { timer = setTimeout(done, 5_000); })]);
    clearTimeout(timer);
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
    await closed;
  }
  assert.notEqual(readProcessIdentity(host.pid!), hostIdentity, 'private census host survived cleanup');
}

async function main() {
  assert.ok(evidenceDir, 'durable evidence directory required');
  const { workspace } = preparePrivateHttpWorkspaces();
  assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '1');
  assert.equal(process.env.PAPERCUSP_DBOS_ENABLE, '1');
  assert.equal(process.env.PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES, 'none');
  assert.equal(process.env.PAPERCUSP_DBOS_ROUTINES, '0');
  assert.equal(process.env.PAPERCUSP_DBOS_TIMERS, '0');
  assert.notEqual(process.env.PAPERCUSP_PG_PORT, '5432');
  const base = process.env.PAPERCUSP_OPERATOR_URL!;
  const url = new URL(base);
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(url.port && !['3070', '3170', '3271', '9071', '9171'].includes(url.port));
  // Provision the normal MCP credential only inside this disposable HOME.
  assert.equal(process.env.PAPERCUSP_HOME, join(process.env.HOME!, '.papercusp'));
  assert.equal(superuserTokenPath(), join(process.env.PAPERCUSP_HOME!, 'superuser-token'));
  mkdirSync(process.env.PAPERCUSP_HOME!, { recursive: true, mode: 0o700 });
  if (!readSuperuserToken()) writeFileSync(superuserTokenPath(), randomBytes(32).toString('base64url'),
    { mode: 0o600, flag: 'wx' });
  const bearer = readSuperuserToken();
  assert.ok(bearer && isValidSuperuserBearer(bearer), 'private MCP credential preparation required');
  // The background isolation profile creates a workspace, but unlike the
  // operator-api profile it does not register a home harness. Both scopes must
  // exist before this control can reach the authenticated signing boundary.
  const home = join(process.env.PAPERCUSP_WORKSPACES_ROOT!, workspace, 'operator-home');
  mkdirSync(home, { recursive: true });
  const before = await loadHarnessRegistry(workspace, { fresh: true });
  const existing = before.projects.find(project => project.slug === workspace);
  if (existing) assert.equal(existing.path, home, 'private harness points outside its disposable home');
  else await saveHarnessRegistry({ ...before,
    projects: [...before.projects, { slug: workspace, path: home, harness_kind: 'hive' }] }, workspace);
  const registry = await loadHarnessRegistry(workspace, { fresh: true });
  assert.equal(registry.projects.find(project => project.slug === workspace)?.path, home,
    'private home harness registration must be read back before bundle build or dispatch');
  console.log('VAULT_CENSUS_REGISTRY_PREFLIGHT ' + JSON.stringify({ workspace,
    harnessSlug: workspace, privateHome: home, registeredBefore: Boolean(existing), readbackVerified: true }));
  const caller = 'su-' + randomUUID();
  if (process.env.VAULT_CENSUS_CONTROL_PREFLIGHT === '1') {
    // Exercise the actual source route stack/catalog in disposable isolation,
    // before spending a bundle build or admitting any authenticated capture.
    const [{ Hono }, { registerRoute }, { default: route }, { workspaceContextMiddleware }] = await Promise.all([
      import('hono'), import('../lib/endpoint-route/define-route'),
      import('../lib/endpoint-route/routes/agent-mcp/run-tool'),
      import('../lib/workspace-context-middleware'),
    ]);
    const api = new Hono();
    registerRoute(api, route);
    const app = new Hono();
    app.use('*', workspaceContextMiddleware);
    app.route('/api', api);
    await unauthenticatedControl(base, workspace, caller,
      async (input, init) => app.fetch(new Request(input, init)));
    console.log('VAULT_CENSUS_CONTROL_PREFLIGHT ' + JSON.stringify({
      workspace, transport: 'in-process-real-route-stack', unauthenticatedRejected: true,
      operatorBundleBuilt: false, authenticatedCaptureAttempted: false,
      qualifyingBaselineAccepted: false }));
    return;
  }
  console.log('VAULT_CENSUS_STAGE=bundle-start');
  // Renew preparation only for distinct completed build steps. The fixed
  // synchronous deadline can interrupt a progressing full-input guard census.
  const prepared = await preparePrivateOperatorApiBundle(root, evidenceDir, { builder: {
    timeoutMs: 240_000, maxMs: 420_000,
    onProgress: progress => console.log('VAULT_CENSUS_STAGE=build-' + progress.step),
  } });
  // The generic private HTTP builder returns byte pins, not a release-artifact
  // manifest. Publish the existing source/blob binding before this child boots;
  // boot measurement must never borrow a caller's digest or checkout HEAD.
  const sourceSha = await operatorArtifactSource(root);
  const artifact = await writeOperatorArtifactManifest({ root, entry: prepared.path, sourceSha,
    artifactRoot: evidenceDir });
  assert.equal(artifact.status, 'measured', 'private artifact source binding required before boot');
  writeFileSync(join(evidenceDir, 'operator-artifact-preflight.json'), JSON.stringify(artifact));
  const originalBundle = readFileSync(prepared.path);
  // The isolation wrapper strips ambient product switches. Select this census
  // profile only for the already-isolated host; never weaken that scrub policy.
  host = spawn(process.execPath, [prepared.path], { cwd: root,
    env: { ...process.env, PAPERCUSP_DBOS_REACTIONS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [host.stdout!, host.stderr!]) stream.on('data', chunk =>
    appendFileSync(join(evidenceDir, 'operator.log'), chunk));
  hostIdentity = readProcessIdentity(host.pid!);
  assert.ok(hostIdentity, 'kernel process identity required');
  const headers = { 'content-type': 'application/json', origin: base, 'x-papercusp-workspace': workspace };
  let health: any;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    assert.equal(host.exitCode, null, 'private operator exited before readiness');
    assert.equal(host.signalCode, null, 'private operator was signaled before readiness');
    try {
      const response = await fetch(base + '/api/health', { headers, signal: AbortSignal.timeout(2_000) });
      if (response.ok) { health = await response.json(); break; }
    } catch { /* Bounded startup convergence only. */ }
    await new Promise(done => setTimeout(done, 250));
  }
  assert.equal(health?.service, 'papercusp-operator');
  console.log('VAULT_CENSUS_STAGE=runtime-capture');
  // The serving process chooses the population, signing key, actor and clock.
  // No fixture callback or caller-supplied rows can stand in for that capture.
  await unauthenticatedControl(base, workspace, caller);
  const client = new Client({ name: 'private-vault-census', version: '1' });
  const requestOptions = { timeout: 120_000 };
  const query = new URLSearchParams({ superuser: '1', client: caller, workspace,
    harness: workspace, format: 'json', profile: 'engineer' });
  let captured: any;
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/api/mcp?' + query),
      { requestInit: { headers: { Authorization: 'Bearer ' + bearer } } }), requestOptions);
    const catalog = await client.listTools(undefined, requestOptions);
    const generation = catalog.tools.find(tool => tool.name === 'dev:telemetry')?._meta?.['papercusp/servingGeneration'];
    assert.equal(typeof generation, 'string', 'serving tool contract baseline required');
    // HTTP health precedes the asynchronous production DBOS bootstrap. Observe
    // the owning process's installed-registration state before persisting the
    // single full capture; env flags alone cannot establish executor readiness.
    const backgroundDeadline = Date.now() + 240_000;
    let backgroundReady = false;
    while (Date.now() < backgroundDeadline) {
      assert.equal(host.exitCode, null, 'private background host exited before DBOS readiness');
      const probe = await client.callTool({ name: 'dev:telemetry',
        arguments: { view: 'security-census', limit: 1 },
        _meta: { 'papercusp/servingGeneration': generation } }, undefined, requestOptions);
      assert.notEqual(probe.isError, true, JSON.stringify(probe));
      const probeText = (probe as any).content?.find((item: any) =>
        item.type === 'text' && item.text?.trim().startsWith('{'))?.text;
      const payload = probe.structuredContent ?? (probeText ? JSON.parse(probeText) : null);
      assert.ok(payload, 'background readiness response lacked structured census');
      backgroundReady = Array.isArray(payload.unresolved)
        && !payload.unresolved.includes('dbos-executor-not-launched')
        && !payload.unresolved.includes('dbos-installed-registration-set-empty');
      if (backgroundReady) break;
      await new Promise(done => setTimeout(done, 500));
    }
    assert.ok(backgroundReady, 'private production DBOS launch/registration deadline; see operator.log');
    console.log('VAULT_CENSUS_STAGE=background-registered');
    captured = await client.callTool({ name: 'dev:telemetry',
      arguments: { view: 'security-census', capture: true, harness: workspace },
      _meta: { 'papercusp/servingGeneration': generation } }, undefined, requestOptions);
  } finally { await client.close(); }
  writeFileSync(join(evidenceDir, 'capture-response.json'), JSON.stringify({ transport: 'mcp', result: captured }));
  assert.notEqual(captured.isError, true, JSON.stringify(captured));
  const text = captured.content?.find((item: any) => item.type === 'text' && item.text?.trim().startsWith('{'));
  const receipt = captured.structuredContent ?? (text ? JSON.parse(text.text) : captured.data);
  assert.equal(receipt?.readbackVerified, true, JSON.stringify(captured));
  const verified = await verifyAuthenticatedRuntimeSecurityCensus(workspace, receipt);
  assert.equal(verified.receipt.actor, caller, 'authenticated MCP actor must own the signed receipt');
  const snapshotBytes = await loadImmutableTextArtifact(workspace, receipt.snapshotRef);
  const signedBytes = await loadImmutableTextArtifact(workspace, receipt.receiptRef);
  assert.ok(snapshotBytes && signedBytes);
  assert.equal(digest(snapshotBytes), receipt.snapshotRef);
  assert.equal(digest(signedBytes), receipt.receiptRef);
  const snapshot = JSON.parse(snapshotBytes);
  assert.equal(snapshot.status, 'captured');
  assert.equal(snapshot.runtimeIdentity.processId, host.pid);
  assert.equal(snapshot.runtimeIdentity.artifact.status, 'measured');
  assert.equal(snapshot.runtimeIdentity.artifact.bundleSha256, digest(originalBundle));
  assert.equal(snapshot.total, snapshot.rows.length);
  assert.ok(snapshot.total > 0 && snapshot.hostCaptureSha256);
  const workflows = snapshot.rows.filter((row: any) => row.kind === 'dbos-workflow');
  const reactions = snapshot.rows.filter((row: any) => row.kind === 'registered-event-reaction');
  assert.ok(workflows.length && workflows.every((row: any) => row.attrs.executorLaunched === true
    && /^[a-f0-9]{64}$/.test(row.attrs.loadedFunctionSha256)), 'actual launched workflow registry required');
  assert.ok(workflows.some((row: any) => row.attrs.name === 'eventReaction'), 'durable reaction executor absent');
  assert.ok(reactions.length, 'actual event reaction registry absent');
  assert.equal(snapshot.schemaCoverage, 'not-included');
  assert.equal(snapshot.populationComplete, false);
  assert.equal(snapshot.closureAccepted, false);
  assert.equal(snapshot.executionAdmitted, false);
  assert.ok(snapshot.unresolved.length, 'unreviewed coverage gaps must remain explicit');
  writeFileSync(join(evidenceDir, 'runtime-census.json'), snapshotBytes);
  writeFileSync(join(evidenceDir, 'runtime-census-signed.json'), signedBytes);
  // Capture names/types/constraints, never business rows or credential values.
  const { sql } = getOrgPg();
  const columns = await sql`SELECT table_schema, table_name, column_name, ordinal_position,
    data_type, udt_schema, udt_name, is_nullable FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      AND table_schema NOT LIKE 'pg_toast%' ORDER BY table_schema, table_name, ordinal_position`;
  const constraints = await sql`SELECT n.nspname AS schema, c.relname AS relation,
    x.conname AS name, x.contype AS type, pg_get_constraintdef(x.oid) AS definition
    FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    ORDER BY n.nspname, c.relname, x.conname`;
  assert.ok(columns.length && constraints.length, 'migrated private schema inventory is required');
  const schemaBytes = canonicalJson({ columns: [...columns], constraints: [...constraints] });
  writeFileSync(join(evidenceDir, 'schema-census.json'), schemaBytes);
  const [dbosSchema] = await sql`SELECT count(*)::int AS tables FROM information_schema.tables
    WHERE table_schema = 'dbos' AND table_name IN ('workflow_status', 'operation_outputs')`;
  assert.equal(dbosSchema.tables, 2, 'real DBOS system database/schema required');
  assert.deepEqual(readFileSync(prepared.path), originalBundle, 'loaded bundle changed during capture');
  await stopHost();
  console.log('VAULT_CENSUS_RECEIPT ' + JSON.stringify({ workspace, hostStopped: true,
    transport: 'mcp', authenticatedActor: caller, unauthenticatedRejected: true,
    bundleSha256: digest(originalBundle), runtimeSnapshotSha256: receipt.snapshotRef,
    signedReceiptSha256: receipt.receiptRef, schemaSha256: digest(schemaBytes),
    runtimeRows: snapshot.rows.length, schemaColumns: columns.length, schemaConstraints: constraints.length,
    populationComplete: false, closureAccepted: false, qualifyingBaselineAccepted: false,
    backgroundRuntime: 'captured', dbosWorkflowCount: workflows.length, reactionCount: reactions.length,
    dbosDatabase: new URL(process.env.HARNESS_ADMIN_DATABASE_URL!).pathname.slice(1), dbosSchema: 'dbos',
    recoveryAdapters: 'not-reconciled' }));
}

try { await main(); }
catch (error) {
  console.error('VAULT_CENSUS_FAILURE ' + (error instanceof Error ? error.stack : String(error)));
  process.exitCode = 1;
}
finally {
  // The source-route preflight imports the real catalog and its managed
  // observers, including LISTEN clients outside the ordinary org pool. Retire
  // their owners before closing pools, just as the private HTTP fixture does.
  // Attempt every cleanup even if one fails, retaining each result so a hang
  // cannot masquerade as an authentication failure on the next investigation.
  const cleanup: Array<{ phase: string; ok: boolean; error?: string }> = [];
  const step = async (phase: string, close: () => void | Promise<void>) => {
    console.log('VAULT_CENSUS_CLEANUP_START ' + phase);
    try { await close(); cleanup.push({ phase, ok: true }); }
    catch (error) {
      cleanup.push({ phase, ok: false, error: String(error) });
      process.exitCode = 1;
    }
    writeFileSync(join(evidenceDir, 'cleanup.json'), JSON.stringify({ steps: cleanup }));
  };
  await step('host', stopHost);
  await step('managed-observers', async () => { stopAllManaged(); });
  await step('principal-invalidation', async () => {
    const { _stopInvalidationListenerForTests } = await import('@papercusp/agent-mcp/auth');
    await _stopInvalidationListenerForTests();
  });
  await step('sync-invalidation', async () => {
    const { stopInvalidationListener } = await import('../lib/sync-sse');
    await stopInvalidationListener();
  });
  await step('listen-hub', async () => {
    const { _stopHubForTests } = await import('../lib/pg-listen-hub');
    await _stopHubForTests();
  });
  await step('database-pools', _resetForTests);
  stopAllManaged();
  await new Promise<void>(done => setImmediate(done));
  const report = process.report!.getReport() as { libuv?: Array<Record<string, unknown>> };
  const referencedTcp = (report.libuv ?? []).filter(handle => handle.type === 'tcp'
    && handle.is_active && handle.is_referenced).map(handle => ({
    local: handle.localEndpoint, remote: handle.remoteEndpoint,
  }));
  const receipt = { steps: cleanup, activeResources: process.getActiveResourcesInfo(),
    referencedTcp, exitCode: process.exitCode ?? 0 };
  writeFileSync(join(evidenceDir, 'cleanup.json'), JSON.stringify(receipt));
  console.log('VAULT_CENSUS_CLEANUP ' + JSON.stringify(receipt));
}
