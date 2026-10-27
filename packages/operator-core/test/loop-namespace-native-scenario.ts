/** Actual bootstrap and Codex transcript; inference terminates at a local script. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { reanchorAdvSessionNativeId } from '../lib/adv-sessions';
import { createTextCollector } from '../lib/child-output';
import { getLoopStatus } from '../lib/harness/routines/loop';
import { reconcileLoopRoutines } from '../lib/harness/routines/reconcile-loop-routines';
import { codexCliResponsesBody, codexCliResponsesCompletionSse, parseBridgeModel,
  runCodexCliCompletion } from '../lib/inference-gateway/codex-cli-bridge';
import { tagTurnForInjection } from '../lib/turn-provenance/turn-provenance';
import { prepareCodexBudgetScenario } from './codex-budget-http-scenario';
import type { BootstrapSuResult } from '../lib/endpoint-route/routes/agent-mcp/bootstrap-su';

export async function measureLoopNamespaceNativeScenario(o: {
  workspace: string; base: string; headers: Record<string, string>; evidenceDir: string;
}) {
  await prepareCodexBudgetScenario(o.workspace);
  const owner = `su-private-namespace-${randomUUID()}`;
  const response = await fetch(o.base + '/api/agent-mcp/console/bootstrap-su', {
    method: 'POST', headers: o.headers, signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({ agent: 'codex', workspace: o.workspace, owner_id: owner,
      model: 'gpt-6.1-sol:low', model_source: 'explicit', account: 'default', headless: true,
      context_size: 'trimmed', bootstrap_idempotency_key: owner }),
  });
  const boot = await response.json() as BootstrapSuResult;
  assert.equal(response.status, 200, JSON.stringify(boot));
  assert.equal(boot.envelopeEnv.PAPERCUSP_SID, owner);
  assert.ok(boot.sessionId && boot.codexHome?.startsWith(process.env.HOME!));
  const dir = boot.envelopeEnv.PAPERCUSP_TURN_PROVENANCE_DIR;
  assert.ok(dir && isAbsolute(dir) && dir.startsWith(process.env.HOME!));
  const sql = getOrgPg().sql;
  const [launch] = await sql`SELECT coord_owner_id, workspace_id, launch_spec
    FROM harness_shared.adv_sessions WHERE id = ${boot.sessionId}`;
  assert.equal(launch.coord_owner_id, owner);
  assert.equal(launch.workspace_id, o.workspace);
  assert.equal(launch.launch_spec.turnProvenanceDir, dir);
  const routine = `private-loop-${randomUUID()}`;
  const fired = new Date();
  await sql`INSERT INTO harness_shared.routines
    (id, install_slug, name, trigger_kind, trigger_config, target_role, active,
     workspace_id, last_fired_at, next_fire_at, reschedule_interval_sec, target_owner_id, metadata)
    VALUES (${routine}, 'papercusp', ${routine}, 'cron', '{}', 'su', true,
      ${o.workspace}, ${fired}, 'infinity', 60, ${owner},
      ${sql.json({ fire_count: 3, armed_at: fired.toISOString() })})`;
  const tagged = await tagTurnForInjection({ sid: owner, origin: 'loop-fire', dir,
    text: 'Acknowledge this private native namespace qualification.',
    loopFire: { routineId: routine, wakeCount: 3 } });
  assert.equal(tagged.ledgerWritten, true);

  const answer = 'Private native namespace completed.';
  const requests: Array<{ at: string; method?: string; path?: string; inputHash?: string }> = [];
  let protocolError: unknown;
  const server = createServer((req, res) => {
    void (async () => {
      const request: (typeof requests)[number] = { at: new Date().toISOString(), method: req.method, path: req.url };
      requests.push(request);
      assert.match(req.url ?? '', /\/responses$/);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const input = JSON.stringify(body.input);
      // JSON serialization escapes the envelope's newline. Compare the decoded
      // input text so the real enrolled prompt is checked byte for byte.
      assert.ok(Array.isArray(body.input) && body.input.some((item: { role?: string; content?: Array<{ text?: string }> }) =>
        item.role === 'user' && Array.isArray(item.content) && item.content.some(content =>
          typeof content.text === 'string' && content.text.includes(tagged.taggedText))),
      'native request lost the enrolled prompt');
      request.inputHash = createHash('sha256').update(input).digest('hex');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(codexCliResponsesCompletionSse(codexCliResponsesBody({
        model: String(body.model), text: answer, inputTokens: 100, outputTokens: 8,
      })));
    })().catch(error => { protocolError = error; res.writeHead(500); res.end('Private protocol failed'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}/v1`;
  const native = createTextCollector();
  const model = parseBridgeModel(boot.model ?? undefined);
  const startedAt = new Date().toISOString();
  try {
    const result = await runCodexCliCompletion({ home: boot.codexHome!, model: model.id,
      effort: model.effort, prompt: tagged.taggedText, timeoutMs: 120_000,
      spawnFn: new Proxy(spawn, { apply(target, _this, [bin, args, options]) {
        assert.ok(typeof bin === 'string' && Array.isArray(args));
        // Retain the real rollout. Override only the inference transport; the
        // selected bootstrap home, environment and native executable stay real.
        const child = target(bin, [...args.filter((arg: string) => arg !== '--ephemeral'),
          '-c', 'model_provider="private_namespace"',
          '-c', 'model_providers.private_namespace.name="Private namespace"',
          '-c', `model_providers.private_namespace.base_url="${origin}"`,
          '-c', 'model_providers.private_namespace.wire_api="responses"',
          '-c', 'model_providers.private_namespace.requires_openai_auth=false',
          '-c', 'model_providers.private_namespace.supports_websockets=false'], {
          ...options, cwd: boot.cwd, env: { ...options?.env, ...boot.envelopeEnv, CODEX_HOME: boot.codexHome! },
        });
        native.attach(child.stdout);
        return child;
      } }),
    });
    assert.equal(protocolError, undefined);
    assert.equal(result.text.trim(), answer);
    assert.ok(requests.length > 0);
  } catch (error) {
    if (protocolError) throw new Error(`Private native protocol failed: ${String(protocolError)}`, { cause: error });
    throw error;
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await writeFile(join(o.evidenceDir, 'loop-namespace-native-transport.json'), JSON.stringify({
      origin, requests, protocolError: protocolError ? String(protocolError) : null,
    }), { flag: 'wx' });
    await writeFile(join(o.evidenceDir, 'loop-namespace-native-output.jsonl'), native.text(), { flag: 'wx' });
  }
  const events = native.text().trim().split('\n').map(line => JSON.parse(line));
  const nativeId = events.find(event => event.type === 'thread.started')?.thread_id;
  assert.match(nativeId ?? '', /^[a-f0-9-]{36}$/);
  assert.equal((await reanchorAdvSessionNativeId(boot.sessionId!, nativeId)).owner, owner);
  const files = (await readdir(join(boot.codexHome!, 'sessions'), { recursive: true }))
    .filter(path => path.endsWith('.jsonl') && path.includes(nativeId));
  assert.equal(files.length, 1);
  const transcript = join(boot.codexHome!, 'sessions', files[0]);
  const transcriptBytes = await readFile(transcript);
  await writeFile(join(o.evidenceDir, 'loop-namespace-native-transcript.jsonl'), transcriptBytes, { flag: 'wx' });

  // The real ingester runs in another home namespace. A global fallback would
  // miss this freshly enrolled native turn, even though bootstrap saved its pin.
  const previous = process.env.PAPERCUSP_TURN_PROVENANCE_DIR;
  process.env.PAPERCUSP_TURN_PROVENANCE_DIR = join(process.env.HOME!, 'ingester-global', 'turn-provenance');
  assert.notEqual(process.env.PAPERCUSP_TURN_PROVENANCE_DIR, dir);
  try {
    const { ingestFileNow } = await import('../lib/search/session-ingest');
    assert.ok((await ingestFileNow(transcript, { owner, sessionId: nativeId })).inserted >= 2);
    const stamps = await sql`SELECT created_at, detail FROM harness_shared.agent_activity
      WHERE owner_id = ${owner} AND detail->>'source' = 'session-ingest'`;
    assert.equal(stamps.length, 1);
    assert.deepEqual(stamps[0].detail.loopFire, { routineId: routine, wakeCount: 3 });
    assert.equal(stamps[0].detail.provenanceWorkspaceId, o.workspace);
    assert.equal(stamps[0].detail.indexedTurn.sessionId, nativeId);
    assert.ok(new Date(stamps[0].created_at).getTime() >= Date.parse(startedAt));
    const status = await getLoopStatus(owner, { sql });
    assert.ok(status, 'private loop must remain readable after native ingestion');
    assert.ok(status.lastLoopTurnAt && Date.parse(status.lastLoopTurnAt) >= Date.parse(startedAt));
    const reconciled = await reconcileLoopRoutines({ sql, nowMs: Date.now() + 10_000,
      recordFire: async () => {}, readFireState: async () => null, countAgentToolCallsInWindow: async () => null });
    const completed = reconciled.loops.find(row => row.id === routine);
    assert.equal(completed?.via, 'loop-turn');
    assert.equal(completed?.completedAt, Date.parse(status.lastLoopTurnAt!));
    assert.equal((await ingestFileNow(transcript, { owner, sessionId: nativeId })).inserted, 0);
    const receipt = { workspace: o.workspace, owner, advSessionId: boot.sessionId, nativeId,
      directoryPin: dir, nativeLaunched: true, providerForwarding: false, requests,
      transcriptSha256: createHash('sha256').update(transcriptBytes).digest('hex'),
      loopFire: stamps[0].detail.loopFire, indexedTurn: stamps[0].detail.indexedTurn,
      lastLoopTurnAt: status.lastLoopTurnAt, via: completed?.via, idempotent: true };
    await writeFile(join(o.evidenceDir, 'loop-namespace-native.json'), JSON.stringify(receipt), { flag: 'wx' });
    return receipt;
  } finally {
    if (previous === undefined) delete process.env.PAPERCUSP_TURN_PROVENANCE_DIR;
    else process.env.PAPERCUSP_TURN_PROVENANCE_DIR = previous;
  }
}
