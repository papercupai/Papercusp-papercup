/** P-009 discovery from a real disposable operator, before profile approval. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { canonicalJson } from '@papercusp/hash-chain';
import { readProcessIdentity } from '../lib/process-identity';
import { loadImmutableTextArtifact } from '../lib/text-artifacts';
import { verifyAuthenticatedRuntimeSecurityCensus } from '../lib/coverage-census/security-qualification';
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
  assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(process.env.PAPERCUSP_DBOS_ENABLE, '0');
  assert.notEqual(process.env.PAPERCUSP_PG_PORT, '5432');
  const base = process.env.PAPERCUSP_OPERATOR_URL!;
  const url = new URL(base);
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(url.port && !['3070', '3170', '3271', '9071', '9171'].includes(url.port));
  console.log('VAULT_CENSUS_STAGE=bundle-start');
  const prepared = preparePrivateOperatorApiBundle(root, evidenceDir);
  const originalBundle = readFileSync(prepared.path);
  host = spawn(process.execPath, [prepared.path], { cwd: root, env: { ...process.env },
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
  const request = await fetch(base + '/api/agent-mcp/run-tool', { method: 'POST', headers,
    body: JSON.stringify({ name: 'dev:telemetry', args: { view: 'security-census', capture: true,
      harness: workspace }, harness: workspace, callerSid: 'su-' + randomUUID(), confirmed: true }),
    signal: AbortSignal.timeout(120_000) });
  const envelope = await request.json() as any;
  writeFileSync(join(evidenceDir, 'capture-response.json'), JSON.stringify({ status: request.status, envelope }));
  assert.equal(request.status, 200, JSON.stringify(envelope));
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.notEqual(envelope.result?.isError, true, JSON.stringify(envelope));
  const text = envelope.result?.content?.find((item: any) => item.type === 'text' && item.text?.trim().startsWith('{'));
  const receipt = envelope.result?.structuredContent ?? (text ? JSON.parse(text.text) : envelope.result?.data);
  assert.equal(receipt?.readbackVerified, true, JSON.stringify(envelope));
  await verifyAuthenticatedRuntimeSecurityCensus(workspace, receipt);
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
  assert.deepEqual(readFileSync(prepared.path), originalBundle, 'loaded bundle changed during capture');
  await stopHost();
  console.log('VAULT_CENSUS_RECEIPT ' + JSON.stringify({ workspace, hostStopped: true,
    bundleSha256: digest(originalBundle), runtimeSnapshotSha256: receipt.snapshotRef,
    signedReceiptSha256: receipt.receiptRef, schemaSha256: digest(schemaBytes),
    runtimeRows: snapshot.rows.length, schemaColumns: columns.length, schemaConstraints: constraints.length,
    populationComplete: false, closureAccepted: false, qualifyingBaselineAccepted: false,
    backgroundRuntime: 'not-captured', recoveryAdapters: 'not-reconciled' }));
}

try { await main(); }
catch (error) { console.error('VAULT_CENSUS_FAILURE ' + String(error)); process.exitCode = 1; }
finally { await stopHost(); await getOrgPg().sql.end({ timeout: 5 }); }
