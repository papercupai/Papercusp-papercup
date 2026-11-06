/** P-009 discovery from a real disposable operator, before profile approval. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getOrgPg } from '@papercusp/db-org';
import { canonicalJson } from '@papercusp/hash-chain';
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
  const caller = 'su-' + randomUUID();
  const denied = await fetch(base + '/api/agent-mcp/run-tool', { method: 'POST', headers,
    body: JSON.stringify({ name: 'dev:telemetry', args: { view: 'security-census', capture: true,
      harness: workspace }, harness: workspace, callerSid: caller, confirmed: true }),
    signal: AbortSignal.timeout(120_000) });
  const refusal = await denied.json() as any;
  writeFileSync(join(evidenceDir, 'unauthenticated-response.json'), JSON.stringify(refusal));
  assert.equal(refusal.result?.isError, true);
  assert.match(JSON.stringify(refusal), /security_qualification_authenticated_actor_required/);
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
finally { await stopHost(); await getOrgPg().sql.end({ timeout: 5 }); }
