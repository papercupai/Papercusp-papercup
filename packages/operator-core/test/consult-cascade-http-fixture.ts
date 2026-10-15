/** Private operator-api worker; reuses the maintained builder and lifetime observer. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { readProcessIdentity } from '../lib/process-identity';
import { buildPrivateOperatorApiBundle, privateBundleRuntimeEnv, waitForPrivateOperator } from './private-http-workspace-preflight';

let host: ChildProcess | undefined;
let hostIdentity: ReturnType<typeof readProcessIdentity>;
let embedServer: Server | undefined;
async function stopEmbedServer() {
  if (!embedServer) return;
  embedServer.closeAllConnections();
  await new Promise<void>((done, reject) => embedServer!.close(error => error ? reject(error) : done()));
  embedServer = undefined;
}
async function stopHost() {
  if (!host) return;
  if (host.exitCode === null && host.signalCode === null) {
    const closed = new Promise<void>(done => host!.once('close', () => done()));
    host.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([closed, new Promise<void>(done => { timer = setTimeout(done, 5000); })]);
    clearTimeout(timer);
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
    await closed;
  }
  assert.notEqual(readProcessIdentity(host.pid!), hostIdentity, 'private host survived cleanup');
}

async function main() {
  const e = process.env;
  const workspace = e.PAPERCUSP_WORKSPACE_ID!;
  const base = e.PAPERCUSP_OPERATOR_URL!;
  assert.match(workspace, /^test-runtime-/);
  assert.equal(e.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(e.PAPERCUSP_DBOS_ENABLE, '0');
  assert.equal(e.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
  assert.notEqual(e.PAPERCUSP_PG_PORT, '5432');
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(![3070, 3170, 3271].includes(Number(new URL(base).port)));
  const root = resolve(import.meta.dirname, '../../..');
  const evidenceDir = e.CONSULT_CASCADE_HTTP_EVIDENCE_DIR!;
  assert.ok(evidenceDir, 'retained evidence directory required');
  console.log('CONSULT_CASCADE_HTTP_PHASE bundle-start');
  const { path: bundle } = await buildPrivateOperatorApiBundle(root, evidenceDir, { timeoutMs: 240_000, maxMs: 420_000 });
  const bytes = readFileSync(bundle);
  assert.ok(bytes.includes(Buffer.from('makeDeferredConsultReachDispatcher')), 'executed bundle lacks deferred cascade adapter');
  const bundleSha256 = createHash('sha256').update(bytes).digest('hex');
  // Keep the maintained private sidecar's capability preflight, but control
  // inference at an owned HTTP boundary. The same production client first
  // succeeds, then spends its ordinary deadline on a withheld response.
  const privateSidecar = e.PAPERCUSP_EMBED_SIDECAR_URL!;
  assert.match(privateSidecar, /^http:\/\/127\.0\.0\.1:\d+$/);
  let embedRequests = 0;
  const healthyQuestion = 'Private healthy HTTP inference diagnostic';
  const timeoutQuestion = 'Private timeout HTTP inference diagnostic';
  const diagnosticEmbeds = new Map([[healthyQuestion, 0], [timeoutQuestion, 0]]);
  embedServer = createServer(async (request, response) => {
    if (request.url === '/embed') {
      embedRequests++;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const query = body.kind === 'query' && body.texts?.length === 1 ? body.texts[0] : null;
      if (diagnosticEmbeds.has(query)) diagnosticEmbeds.set(query, diagnosticEmbeds.get(query)! + 1);
      // Host startup also embeds documents and unrelated queries. Attribute
      // the two controls by the exact query payload and withhold ONLY the
      // timeout control; aggregate host traffic is not an assertion oracle.
      if (query !== timeoutQuestion) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ vectors: body.texts.map(() => Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0)),
          dims: 768, runtime: 'private-http-fixture', modelRev: 'private-http-fixture' }));
      }
      return;
    }
    request.resume();
    try {
      const upstream = await fetch(privateSidecar + '/healthz', { signal: AbortSignal.timeout(2000) });
      response.writeHead(upstream.status, { 'content-type': 'application/json' });
      response.end(await upstream.text());
    } catch {
      response.writeHead(503); response.end();
    }
  });
  await new Promise<void>(done => embedServer!.listen(0, '127.0.0.1', done));
  const embedAddress = embedServer.address();
  assert.ok(embedAddress && typeof embedAddress !== 'string');
  const controlledSidecar = `http://127.0.0.1:${embedAddress.port}`;
  const hostEnv = privateBundleRuntimeEnv({ ...e,
    PAPERCUSP_MEMORY_EMBEDDER: 'gemma', PAPERCUSP_EMBED_SIDECAR_URL: controlledSidecar });
  host = spawn(process.execPath, [bundle], { cwd: root,
    env: hostEnv,
    stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout!.on('data', chunk => process.stdout.write(chunk));
  host.stderr!.on('data', chunk => process.stderr.write(chunk));
  hostIdentity = readProcessIdentity(host.pid!);
  assert.ok(hostIdentity, 'private host kernel identity required');
  const headers = { 'content-type': 'application/json', origin: base, 'x-papercusp-workspace': workspace };
  const health = await waitForPrivateOperator({ host, base, headers, evidenceDir, hostIdentity, environment: hostEnv });
  async function call(name: string, args: Record<string, unknown>) {
    const response = await fetch(base + '/api/agent-mcp/run-tool', { method: 'POST', headers,
      body: JSON.stringify({ name, args, harness: workspace, callerSid: 'private-cascade-fixture' }),
      signal: AbortSignal.timeout(20_000) });
    const envelope = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(envelope));
    assert.equal(envelope.ok, true, JSON.stringify(envelope));
    assert.notEqual(envelope.result?.isError, true, JSON.stringify(envelope));
    const text = envelope.result?.content?.find((item: any) => item.type === 'text' && item.text.trim().startsWith('{'));
    const result = envelope.result?.structuredContent ?? (text ? JSON.parse(text.text) : envelope.result?.data ?? envelope.result);
    assert.ok(!result.error, JSON.stringify(result));
    return result;
  }
  const identity = await call('coord:whoami', {});
  assert.equal(identity.workspaceId, workspace);
  assert.ok(identity.ownerId, 'HTTP actor identity required');
  const catalog = await call('agent_tools:list', {
    filter: 'consult:|plans:start', onlyAllowed: false, limit: 100,
  });
  assert.ok(Array.isArray(catalog.tools), 'production catalog must return tool entries');
  assert.equal(catalog.count, catalog.tools.length, 'catalog receipt must retain every returned entry');
  assert.ok(catalog.count < 100, 'bounded catalog must not reach its truncation limit');
  const catalogNames = catalog.tools.map((tool: { name: string }) => tool.name).sort();
  for (const name of ['consult:get_feedback', 'consult:reply', 'consult:decline', 'consult:close', 'plans:start']) {
    assert.ok(catalogNames.includes(name), `production catalog positive control ${name}`);
  }
  assert.ok(!catalogNames.includes('consult:reconcile'), 'retired reporting callable remains registered');
  const { sql } = getOrgPg();
  const diagnosticRequests: Array<Record<string, unknown>> = [];
  for (const control of ['healthy', 'timeout'] as const) {
    const question = control === 'healthy' ? healthyQuestion : timeoutQuestion;
    const accepted = await call('consult:get_feedback', { request_key: `private-http-embed-${control}`,
      question, allow_dispatch: false });
    assert.equal(accepted.verdict, 'accepted');
    let persisted: any;
    for (const stop = Date.now() + 35_000; Date.now() < stop;) {
      const [row] = await sql`SELECT state, routing FROM harness_shared.consult_state
        WHERE workspace_id = ${workspace} AND conversation_id = ${accepted.conversation_id}`;
      if (row?.state !== 'routing' && row?.routing?.measurement) { persisted = row; break; }
      await new Promise(done => setTimeout(done, 50));
    }
    assert.ok(persisted, 'production request did not persist its measured routing result');
    const measurement = persisted.routing.measurement;
    assert.equal(measurement.caller, 'consult:get_feedback');
    assert.equal(measurement.stages.embedding?.outcome, control === 'healthy' ? 'returned' : 'threw');
    if (control === 'timeout') {
      assert.equal(measurement.stages.embedding.errorCode, 'ABORT_ERR');
      assert.equal(measurement.outcome, 'degraded');
      assert.equal(measurement.errorCode, null, 'recovered stage failure must not become a terminal router exception');
    }
    const [recorded] = await sql`SELECT metadata_json FROM harness_shared.route_invocations
      WHERE workspace_id = ${workspace} AND method = 'INTERNAL' AND path = 'internal:expertise-routing'
        AND metadata_json->>'correlationId' = ${measurement.correlationId}`;
    assert.deepEqual(recorded?.metadata_json, measurement, 'durable telemetry must match the request snapshot');
    assert.ok(!JSON.stringify(recorded).includes(question), 'diagnostic telemetry leaked the request text');
    const read = await call('conversations:get', { id: accepted.conversation_id });
    writeFileSync(join(evidenceDir, `embedding-${control}.json`), JSON.stringify({ base, identity, accepted,
      persisted, recorded, read, embedRequests, diagnosticEmbedRequests: diagnosticEmbeds.get(question) }));
    diagnosticRequests.push({ control, conversationId: accepted.conversation_id,
      correlationId: measurement.correlationId, embeddingOutcome: measurement.stages.embedding.outcome,
      embeddingErrorCode: measurement.stages.embedding.errorCode ?? null, telemetryMatches: true });
  }
  assert.deepEqual([...diagnosticEmbeds.values()], [1, 1], 'each exact control must reach the real HTTP client boundary once');
  const lockKey = 741101;
  // Hold ONLY the background lease transition. The queued intent/post and
  // HTTP response must commit while this real production UPDATE waits.
  await sql.unsafe(`CREATE FUNCTION harness_shared.p011_hold_launch_lease() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.routing #>> '{cascadeDispatch,leaseToken}' IS NOT NULL
        AND OLD.routing #>> '{cascadeDispatch,leaseToken}' IS NULL THEN
        PERFORM pg_advisory_xact_lock(${lockKey});
      END IF;
      RETURN NEW;
    END $$`);
  await sql.unsafe(`CREATE TRIGGER p011_hold_launch_lease BEFORE UPDATE ON harness_shared.consult_state
    FOR EACH ROW EXECUTE FUNCTION harness_shared.p011_hold_launch_lease()`);
  console.log('CONSULT_CASCADE_HTTP_PHASE request-ready');
  const requests: Array<Record<string, unknown>> = [];
  for (const kind of ['reply', 'decline'] as const) {
    const id = `private-cascade-${kind}`;
    const thread = `thread-${id}`;
    const next = `private-untracked-${kind}`;
    await sql`INSERT INTO harness_shared.coord_conversations (workspace_id, id, kind, asker_id, body)
      VALUES (${workspace}, ${id}, 'consult', 'private-requester', 'Private acknowledgement control')`;
    await sql`INSERT INTO harness_shared.coord_threads (workspace_id, thread_id, parent_kind, parent_ref)
      VALUES (${workspace}, ${thread}, 'conversation', ${id})`;
    const selected = [identity.ownerId, next].map(ownerId => ({ ownerId, via: 'floor', score: 0.9, similarity: 0.8 }));
    await sql`INSERT INTO harness_shared.consult_state
      (workspace_id, conversation_id, requester_id, responder_id, state, question, routing, expires_at)
      VALUES (${workspace}, ${id}, 'private-requester', ${identity.ownerId}, 'awaiting_responder',
        'Private acknowledgement control', ${sql.json({ selection: { min: 1, selected } })}, now() + interval '10 minutes')`;
    const hold = await sql.reserve();
    try {
      await hold`BEGIN`;
      await hold`SELECT pg_advisory_xact_lock(${lockKey})`;
      const args = kind === 'reply' ? { conversation_id: id, kind: 'new_fact', body: 'Exact private fact' }
        : { conversation_id: id, reason: 'Different subsystem' };
      const result = await call(`consult:${kind}`, args);
      writeFileSync(join(evidenceDir, `${kind}.json`), JSON.stringify({ base, identity, result }));
      assert.ok(Number.isInteger(result.post_id), JSON.stringify(result));
      assert.equal(result.cascade?.pending, true, JSON.stringify(result));
      assert.equal(result.cascade?.advanced_to, next, JSON.stringify(result));
      assert.equal(result.cascade?.woke, 0, JSON.stringify(result));
      let waiting = false;
      for (const stop = Date.now() + 5000; Date.now() < stop;) {
        const rows = await sql`SELECT pid FROM pg_locks WHERE locktype = 'advisory'
          AND objid = ${lockKey}::oid AND NOT granted`;
        if (rows.length) { waiting = true; break; }
        await new Promise(done => setTimeout(done, 25));
      }
      assert.ok(waiting, 'production continuation did not reach the held lease');
      const [row] = await sql`SELECT cascade_cursor, routing, dispatch_attempts FROM harness_shared.consult_state
        WHERE workspace_id = ${workspace} AND conversation_id = ${id}`;
      assert.equal(row.cascade_cursor, 1);
      assert.equal(row.routing.cascadeDispatch.responder, next);
      assert.equal(row.routing.cascadeDispatch.leaseToken, null);
      assert.deepEqual(row.dispatch_attempts, []);
      const posts = await sql`SELECT post_id FROM harness_shared.consult_post_meta
        WHERE workspace_id = ${workspace} AND conversation_id = ${id}`;
      assert.deepEqual(posts.map(post => Number(post.post_id)), [result.post_id]);
      await hold`ROLLBACK`;
      let completed: any;
      for (const stop = Date.now() + 10_000; Date.now() < stop;) {
        const [after] = await sql`SELECT routing, dispatch_attempts FROM harness_shared.consult_state
          WHERE workspace_id = ${workspace} AND conversation_id = ${id}`;
        if (!after.routing.cascadeDispatch && after.dispatch_attempts.length) { completed = after; break; }
        await new Promise(done => setTimeout(done, 25));
      }
      assert.ok(completed, 'released production continuation never recorded its refusal');
      assert.ok(completed.dispatch_attempts.every((attempt: any) => attempt.dispatched === false));
      assert.ok(completed.dispatch_attempts.every((attempt: any) => attempt.attempts.length === 0));
      requests.push({ kind, pending: true, leaseWaitObserved: waiting, persistedPosts: posts.length,
        postId: result.post_id, afterRelease: 'no-launch-refusal' });
    } finally {
      await hold`ROLLBACK`.catch(() => {});
      hold.release();
    }
  }
  await stopHost();
  await stopEmbedServer();
  console.log('CONSULT_CASCADE_HTTP_RECEIPT ' + JSON.stringify({ workspace, identity,
    hostPid: host.pid, hostStopped: true, bundleSha256, health, catalogNames, requests, diagnosticRequests }));
}

try { await main(); }
catch (error) {
  const failure = error as { message?: string; stack?: string; actual?: unknown; expected?: unknown };
  console.error('CONSULT_CASCADE_HTTP_FAILURE ' + JSON.stringify({ message: failure.message ?? String(error),
    stack: failure.stack, actual: failure.actual, expected: failure.expected }));
  process.exitCode = 1;
} finally {
  await stopHost();
  await stopEmbedServer();
  await getOrgPg().sql.end({ timeout: 1 });
}
