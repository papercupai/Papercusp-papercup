/** One private cold/fault experiment through the maintained HTTP fixture. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOrgPg, withWorkspace } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { loadHarnessRegistry, saveHarnessRegistry } from '../lib/harness-registry';
import { insertHiveIfAbsent } from '../lib/hive-store';
import { generateEd25519KeypairDer } from '../lib/identity/ed25519';
import { createWorkItem } from '../lib/work-items';
import { issuesScopeWorkspace } from '../lib/issues-engineer';
import { activeWorkspaceId } from '../lib/workspace-registry';
import { systemDistinctId } from '../lib/flag-distinct-id';
import { potExistence, resolveWorkItemPot } from '../lib/pot-membership';
import { readProcessIdentity } from '../lib/process-identity';
import { resolvePlanScope } from '../lib/agent-tools/plans/source';
import { setSpecClause } from '../lib/agent-tools/plans/spec-clauses-store';
import { ADHOC_WORK_ITEM_SPEC_SCOPE, bindSpecEvidence } from '../lib/agent-tools/plans/spec-evidence-store';

type Options = { workspace: string; harness: string; base: string;
  headers: Record<string, string>; evidenceDir: string };
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** Reuse the maintained private Pot setup before either reader creates an item. */
async function preparePrivateReaderPot(workspace: string, harness: string) {
  assert.match(workspace, /^test-runtime-/);
  const scope = await resolvePlanScope({ harnessSlug: harness });
  assert.deepEqual(scope, { workspaceId: workspace, harnessSlug: workspace });
  const owner = generateEd25519KeypairDer();
  await insertHiveIfAbsent({ workspaceId: workspace, homeSlug: workspace,
    pubkeyBase64: owner.pubkeyBase64, keychainId: 'disposable-committed-reader-owner' }, getOrgPg().sql);
  assert.equal((await potExistence(workspace, workspace)).state, 'exists');
  // The bare workspace is a global scope label. A concrete member resolves to
  // the real private Pot through the production membership resolver.
  assert.equal(await resolveWorkItemPot({ rawSlug: harness, workspaceId: workspace }), workspace);
}

/** The actual HTTP preparation and its setup-only guard share this binding path. */
export async function prepareCommittedReaderBindings(o: Pick<Options, 'workspace' | 'harness' | 'evidenceDir'>,
  targets: Array<{ path: string; fingerprint: string }>, rootHarness?: string) {
  assert.match(o.workspace, /^test-runtime-/);
  assert.ok(targets.length, 'private preparation requires an evidence target');
  await preparePrivateReaderPot(o.workspace, o.harness);
  const { sql } = getOrgPg();
  const scope = await resolvePlanScope({ harnessSlug: o.harness });
  const flags = {
    potMembership: await getFlag(FLAGS.POT_MEMBERSHIP_ENFORCEMENT, 'system'),
    issuesPerWorkspace: await getFlag(FLAGS.ISSUES_PER_WORKSPACE, systemDistinctId()),
  };
  const item = await createWorkItem({ kind: 'task', title: 'Private committed reader HTTP fixture',
    harness: o.harness, workspaceId: o.workspace, createdBy: 'private-http-fixture' });
  const clause = await setSpecClause({ harnessSlug: o.harness, specId: 'private-reader:S-001',
    planItemId: 'P-900', expectedRevision: 0, behaviorClass: 'observability',
    behavior: 'Cold HTTP evidence reads preserve committed bytes and remain available after a sidecar timeout.',
    lifecycleStatus: 'draft', mutationRequired: false, actorId: 'private-http-fixture' });
  assert.equal(clause.status, 'created', JSON.stringify(clause));
  const bindings = [];
  for (const target of targets) {
    const bound = await bindSpecEvidence({ harnessSlug: o.harness, workItemId: item.id,
      specId: 'private-reader:S-001', evidenceKind: 'manual', evidenceRef: target.path,
      sourceFingerprint: target.fingerprint, actorId: 'private-http-fixture',
      ...(rootHarness ? { details: { currentMeasurement: { schemaVersion: 1, kind: 'repo-files',
        rootHarnessSlug: rootHarness, sourcePaths: [target.path] } } } : {}) });
    assert.equal(bound.status, 'created', JSON.stringify(bound));
    bindings.push(bound);
  }
  const rows = await sql`SELECT workspace_id, harness_slug, feature_id, item_kind
    FROM harness_shared.work_items WHERE feature_id = ${item.id}`;
  const visible = await withWorkspace(scope.workspaceId, tx => tx`
    SELECT workspace_id, harness_slug, feature_id FROM harness_shared.work_items
    WHERE feature_id = ${item.id}`);
  const exact = await withWorkspace(scope.workspaceId, tx => tx`
    SELECT feature_id FROM harness_shared.work_items
    WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harnessSlug}
      AND feature_id = ${item.id}`);
  const pot = await potExistence(o.workspace, o.workspace);
  const resolvedPot = await resolveWorkItemPot({ rawSlug: o.harness, workspaceId: issuesScopeWorkspace() });
  const registry = await loadHarnessRegistry(o.workspace, { fresh: true });
  const measurement = { workspace: o.workspace, harness: o.harness, itemId: item.id,
    scope, activeWorkspace: activeWorkspaceId(), issuesWorkspace: issuesScopeWorkspace(), flags,
    pot, resolvedPot, registry: registry.projects.map(({ slug, hive_slug, harness_kind }) => ({ slug, hive_slug, harness_kind })),
    rows, visible, exact };
  // Persist before binding, so a setup failure retains the distinguishing evidence.
  await writeFile(join(o.evidenceDir, 'committed-reader-setup.json'), JSON.stringify(measurement, null, 2), { flag: 'wx' });
  assert.equal(exact.length, 1, 'private create and binding must use the same partition');
  const wrongHome = `${o.workspace}-wrong-pot`;
  const owner = generateEd25519KeypairDer();
  await insertHiveIfAbsent({ workspaceId: o.workspace, homeSlug: wrongHome,
    pubkeyBase64: owner.pubkeyBase64, keychainId: 'disposable-wrong-scope-owner' }, sql);
  const home = registry.projects.find(project => project.slug === o.workspace);
  assert.ok(home);
  await saveHarnessRegistry({ ...registry, projects: [...registry.projects,
    { slug: wrongHome, path: home.path, hive_slug: wrongHome }] }, o.workspace);
  const wrongScope = await resolvePlanScope({ harnessSlug: wrongHome });
  assert.deepEqual(wrongScope, { workspaceId: o.workspace, harnessSlug: wrongHome });
  const before = await sql`SELECT id, workspace_id, harness_slug, spec_id, evidence_ref, binding_fingerprint
    FROM harness_shared.spec_evidence_bindings WHERE work_item_id = ${item.id} ORDER BY id`;
  assert.equal(before.length, bindings.length);
  assert.ok(before.every(row => row.workspace_id === scope.workspaceId && row.harness_slug === scope.harnessSlug));
  const wrongBinding = await bindSpecEvidence({ harnessSlug: wrongHome, workItemId: item.id,
    specId: 'private-reader:S-001', evidenceKind: 'manual', evidenceRef: 'wrong-scope',
    sourceFingerprint: sha256('wrong-scope'), actorId: 'private-http-fixture' });
  assert.equal(wrongBinding.status, 'work_item_not_found', JSON.stringify(wrongBinding));
  const after = await sql`SELECT id, workspace_id, harness_slug, spec_id, evidence_ref, binding_fingerprint
    FROM harness_shared.spec_evidence_bindings WHERE work_item_id = ${item.id} ORDER BY id`;
  assert.deepEqual(after, before, 'wrong-Pot refusal must not write or alter evidence bindings');
  const columns = await sql`SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'harness_shared' AND table_name = 'tool_invocations'
      AND column_name IN ('serving_process_id', 'metadata_json', 'args_json', 'invoked_at')`;
  assert.deepEqual(columns.map(row => row.column_name).sort(),
    ['args_json', 'invoked_at', 'metadata_json', 'serving_process_id'],
    'private migrated schema must support same-invocation evidence before sidecar/host');
  const receipt = { ...measurement, preparationPath: 'prepareCommittedReaderBindings',
    binding: bindings[0], bindings, wrongScope, wrongBinding, bindingsBefore: before, bindingsAfter: after,
    requiredSchemaColumns: columns.map(row => row.column_name).sort(),
    bundleStarted: false, httpStarted: false, sidecarStarted: false };
  await writeFile(join(o.evidenceDir, 'committed-reader-setup-receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
  return receipt;
}

/** Exercise the same scope/binding preflight without starting the cold/fault experiment. */
export async function measureCommittedReaderSetup(o: Pick<Options, 'workspace' | 'harness' | 'evidenceDir'>) {
  return prepareCommittedReaderBindings(o, [{ path: 'setup-only', fingerprint: sha256('setup-only') }]);
}

export async function prepareCommittedReaderScenario(o: Options) {
  assert.match(o.workspace, /^test-runtime-/);
  await preparePrivateReaderPot(o.workspace, o.harness);
  const dir = await mkdtemp(join(tmpdir(), 'reader-http-'));
  const sockets = new Set<Socket>();
  let server: Server | undefined;
  let releaseFault: (() => void) | undefined;
  let disposed = false;
  async function dispose() {
    if (disposed) return;
    disposed = true;
    releaseFault?.();
    for (const socket of sockets) socket.destroy();
    try {
      if (server) await new Promise<void>((resolve, reject) => server!.close(error => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  try {
  const repo = join(dir, 'repo');
  await mkdir(repo);
  // The maintained server's orphan sweep is restricted to this private directory.
  process.env.TMPDIR = dir;
  process.env.PAPERCUSP_SPAWNER_IPC_SOCKET = join(dir, 's.sock');
  assert.ok(Buffer.byteLength(process.env.PAPERCUSP_SPAWNER_IPC_SOCKET) <= 100,
    'private sidecar socket must fit the Unix socket path limit');
  process.env.PAPERCUSP_PLAN_AUDIT_SPAWN_SIDECAR = '1';
  const git = (...args: string[]) => execFileSync('git', ['-C', repo,
    '-c', 'user.name=private fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const contents = ['cold.dat', 'fault.dat'].map(path => ({ path,
    bytes: Buffer.concat([Buffer.from([0, 255, 128, 10]), randomBytes(32), Buffer.alloc(128 * 1024, 255)]) }));
  git('init', '-q', '-b', 'main');
  for (const file of contents) await writeFile(join(repo, file.path), file.bytes);
  git('add', '.');
  git('commit', '-q', '-m', 'private unique cold blobs');
  const commit = git('rev-parse', 'HEAD');
  const targets = contents.map(file => ({ ...file, blob: git('rev-parse', `HEAD:${file.path}`),
    fingerprint: 'sha256-file-set-v1:' + sha256(JSON.stringify([{ path: file.path, sha256: sha256(file.bytes) }])) }));
  const rootHarness = `${o.workspace}-reader-source`;
  const registry = await loadHarnessRegistry(o.workspace, { fresh: true });
  await saveHarnessRegistry({ ...registry, projects: [...registry.projects,
    { slug: rootHarness, path: repo, hive_slug: o.workspace }] }, o.workspace);
  const preparation = await prepareCommittedReaderBindings(o, targets, rootHarness);
  const item = { id: preparation.itemId };
  // Imports occur after selecting private socket/tmp/PG identities. The real
  // server and executor retain admission, byte handoff and RPC error semantics.
  const { runSpawnerSidecarServer } = await import('../lib/fleet/spawner-sidecar-server');
  const { execProcess } = await import('../lib/fleet/sidecar-exec-process');
  const handoffs: Array<Record<string, unknown>> = [];
  let fault = false;
  server = runSpawnerSidecarServer({ executeProcess: async (params, deps) => {
    if (params.command !== 'git' || !params.args?.includes('--batch')) return execProcess(params, deps);
    const stdin = await readFile(params.stdinPath!, 'utf8');
    const target = targets.find(file => stdin === `${file.blob}\n`);
    assert.ok(target, 'sidecar request must name one exact private blob');
    assert.equal(params.cwd, repo);
    assert.equal((await stat(params.stdinPath!)).mode & 0o777, 0o600);
    assert.equal((await stat(params.stdoutPath!)).mode & 0o777, 0o600);
    const entry: Record<string, unknown> = { path: target.path, blob: target.blob, stdin,
      stdinPath: params.stdinPath, stdoutPath: params.stdoutPath, fault: fault && target.path === 'fault.dat' };
    handoffs.push(entry);
    console.log('STAGING_FIRST_HTTP_PHASE sidecar-' + (entry.fault ? 'held' : 'exec'));
    if (entry.fault) {
      // No product deadline override: the client's ordinary 50s RPC timer wins.
      return await new Promise<never>((_, reject) => {
        releaseFault = () => reject(new Error('private withheld-reply control released'));
        deps?.signal?.addEventListener('abort', releaseFault, { once: true });
      });
    }
    const result = await execProcess(params, deps);
    entry.result = result;
    assert.equal(result.code, 0, JSON.stringify(result));
    const stdout = await readFile(params.stdoutPath!);
    const expected = Buffer.concat([Buffer.from(`${target.blob} blob ${target.bytes.length}\n`), target.bytes, Buffer.from('\n')]);
    assert.deepEqual(stdout, expected, 'actual sidecar output must preserve every binary byte');
    entry.stdoutBytes = stdout.length;
    entry.stdoutSha256 = sha256(stdout);
    return result;
  } });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await once(server, 'listening');
  const { sql } = getOrgPg();
  const requests: Array<Record<string, any>> = [];
  const healthSamples: Array<Record<string, unknown>> = [];
  return {
    async execute(hostPid: number) {
      const hostProcessId = readProcessIdentity(hostPid);
      assert.ok(hostProcessId, 'private serving host kernel identity required');
      async function request(path: string, action: string) {
        const args = { harness: o.harness, slug: ADHOC_WORK_ITEM_SPEC_SCOPE,
          workItemIds: [item.id], evidenceRefs: [path], detail: 'full', limit: 1 };
        const started = new Date().toISOString();
        let done = false;
        const responsePromise = fetch(o.base + '/api/agent-mcp/run-tool', { method: 'POST',
          headers: o.headers, body: JSON.stringify({ name: 'plans:get-spec-evidence', args, harness: o.harness }),
          signal: AbortSignal.timeout(75_000) }).finally(() => { done = true; });
        const healthPromise = (async () => {
          do {
            const begin = performance.now();
            const response = await fetch(o.base + '/api/health', { headers: o.headers, signal: AbortSignal.timeout(2_000) });
            const body = await response.json() as any;
            assert.equal(response.status, 200);
            assert.equal(body.service, 'papercusp-operator');
            healthSamples.push({ action, elapsedMs: performance.now() - begin, status: response.status, service: body.service });
            if (!done) await new Promise(resolve => setTimeout(resolve, 250));
          } while (!done);
        })();
        const [responseResult, healthResult] = await Promise.allSettled([responsePromise, healthPromise]);
        if (responseResult.status === 'rejected' && healthResult.status === 'rejected') {
          throw new AggregateError([responseResult.reason, healthResult.reason], 'HTTP and health checks failed');
        }
        if (responseResult.status === 'rejected') throw responseResult.reason;
        if (healthResult.status === 'rejected') throw healthResult.reason;
        const response = responseResult.value;
        const envelope = await response.json() as any;
        assert.equal(response.status, 200, JSON.stringify(envelope));
        assert.equal(envelope.ok, true, JSON.stringify(envelope));
        assert.notEqual(envelope.result?.isError, true, JSON.stringify(envelope));
        const text = envelope.result?.content?.find((part: any) => part.type === 'text' && part.text.trim().startsWith('{'));
        const body = envelope.result?.structuredContent ?? (text ? JSON.parse(text.text) : envelope.result?.data ?? envelope.result);
        assert.equal(body.evidence?.length, 1, JSON.stringify(body));
        // This private host has one serialized invocation of this unique selector.
        // Wait only for its asynchronously written audit row; never replay HTTP.
        let ledger: any;
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const rows = await sql`SELECT id, metadata_json, serving_process_id FROM harness_shared.tool_invocations
            WHERE workspace_id = ${o.workspace} AND tool_name = 'plans:get-spec-evidence'
              AND invoked_at >= ${started}::timestamptz AND args_json->>'slug' = ${ADHOC_WORK_ITEM_SPEC_SCOPE}
              AND args_json->'evidenceRefs' = ${JSON.stringify([path])}::jsonb
            ORDER BY id DESC LIMIT 2`;
          assert.ok(rows.length <= 1, 'ambiguous invocation metadata');
          if (rows[0]?.metadata_json?.plansGetSpecEvidenceStageTimings) { ledger = rows[0]; break; }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(ledger, 'same-invocation stage metadata missing');
        assert.equal(ledger.serving_process_id, hostProcessId);
        assert.equal(readProcessIdentity(hostPid), hostProcessId, 'private serving host changed during request');
        const receipt = { action, path, status: response.status, body, ledger,
          counters: ledger.metadata_json.plansGetSpecEvidenceStageTimings.committedTree };
        requests.push(receipt);
        await writeFile(join(o.evidenceDir, `reader-${action}.json`), JSON.stringify({ args, envelope, ...receipt }));
        return receipt;
      }
      const cold = await request('cold.dat', 'cold');
      assert.equal(cold.body.evidence[0].serverMeasurement.status, 'measured');
      assert.equal(cold.body.evidence[0].serverMeasurement.current.sourceFingerprint, targets[0].fingerprint);
      assert.equal(cold.counters.memoMisses, 1);
      assert.equal(cold.counters.memoHits, 0);
      assert.equal(cold.counters.batchSucceeded, 1);
      assert.deepEqual(cold.counters.batchRoutes, { sidecar: 1, local: 0, injected: 0 });
      const warm = await request('cold.dat', 'warm');
      assert.equal(warm.counters.memoHits, 1);
      assert.equal(warm.counters.batchAttempts, 0);
      fault = true;
      const timeout = await request('fault.dat', 'timeout');
      assert.equal(timeout.body.evidence[0].serverMeasurement.status, 'unavailable');
      assert.match(timeout.body.evidence[0].serverMeasurement.reason, /timeout/i);
      assert.equal(timeout.body.evidence[0].currentness.overall, 'unknown');
      assert.equal(timeout.counters.memoMisses, 1);
      assert.equal(timeout.counters.batchFailed, 1);
      assert.deepEqual(timeout.counters.batchRoutes, { sidecar: 1, local: 0, injected: 0 });
      assert.ok(healthSamples.filter(sample => sample.action === 'timeout').length >= 5,
        'health must advance while the actual RPC is held');
      fault = false;
      releaseFault?.();
      const recovery = await request('fault.dat', 'recovery');
      assert.equal(recovery.body.evidence[0].serverMeasurement.status, 'measured');
      assert.equal(recovery.body.evidence[0].serverMeasurement.current.sourceFingerprint, targets[1].fingerprint);
      assert.equal(recovery.counters.memoMisses, 1);
      assert.equal(recovery.counters.batchSucceeded, 1);
      assert.deepEqual(recovery.counters.batchRoutes, { sidecar: 1, local: 0, injected: 0 });
      assert.deepEqual(handoffs.map(entry => [entry.path, entry.fault]),
        [['cold.dat', false], ['fault.dat', true], ['fault.dat', false]]);
      for (const entry of handoffs) {
        await assert.rejects(stat(String(entry.stdinPath)), { code: 'ENOENT' });
        await assert.rejects(stat(String(entry.stdoutPath)), { code: 'ENOENT' });
      }
      const receipt = { commit, repo, rootHarness, targets: targets.map(({ bytes, ...target }) => ({ ...target,
        byteLength: bytes.length, sha256: sha256(bytes) })), requests, handoffs, healthSamples };
      await writeFile(join(o.evidenceDir, 'reader-experiment.json'), JSON.stringify(receipt));
      return receipt;
    },
    dispose,
  };
  } catch (error) {
    try { await dispose(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Scenario preparation and cleanup failed'); }
    throw error;
  }
}
