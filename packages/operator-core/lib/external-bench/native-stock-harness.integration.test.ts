/** Actual stock factory/native CLI/SRT/task and transcript IO against private
 * Postgres. The local listener refuses every request and has no forwarding code
 * or provider credential. This is lifecycle proof, not benchmark performance. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { allCapabilities, currentProtocolFixture } from './reproducibility/_protocol-test-fixture';
import { preregister } from './reproducibility/prereg';
import { createCurrentStockBenchHarness } from './native-harness-runner';
import { currentBenchAssignmentId, currentBenchGatewayController, type CurrentSuBenchOptions } from './current-su';
import type { PapercuspUnifiedToolContext } from '../agent-tools/_tool-context';
import { GatewayRequestTelemetry } from '../inference-gateway/request-stage-telemetry';
import { startBenchEgress, type BenchEgress, type TaskNetworkLease } from './bench-egress';
import { CONTAINER_CLAUDE_BIN_PATH, CONTAINER_CODEX_BIN_PATH, resolveContainerClaudeBinary, resolveContainerCodexBinary, type DockerExecTarget } from './container-exec-target';
import { restoreRelocatedSessions } from './frontier-swe-seam';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, homes: '' }));
vi.mock('@papercusp/db-org', async original => ({ ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('@papercusp/orchestrator/session-launch-dirs', () => ({
  codexHomeForSessionKey: (id: number) => join(h.homes, String(id)),
  sessionClaudeConfigDir: (owner: string) => join(h.homes, owner),
}));
vi.mock('../workspace-registry', async original => ({ ...await original<typeof import('../workspace-registry')>(), activeWorkspaceId: () => 'private-stock-native' }));
// Keep delayed lifecycle routines from acting after the fixture DB is dropped.
vi.mock('../session-end-lease-release-hook', () => ({ scheduleSessionEndLeaseRelease: () => {} }));
vi.mock('../session-archive-hook', () => ({ scheduleArchiveForAdvSession: () => {} }));

const workspaceId = 'private-stock-native';
// A separate glibc fixture, pinned independently of the musl Codex image. These
// coordinates qualify local refusal/lifecycle evidence, not a benchmark image.
const claudeDockerFixture = {
  image: 'debian@sha256:eb593cf2c358cacef45ca0a424bbc7d30cfa3466265fc2662b9466a0ca6ba1c5',
  imageId: 'sha256:787cd32c15da653c63f8689246f8199870afdbe8d822b7e560d651e20d6def02',
  version: '2.1.293',
  binarySha256: '8968405e26db478af44eabc4635ab5ca557057b702a54460a59c13e1b253e978',
};
let db: OrgTestDb, root: string;
const execDocker = promisify(execFile);
async function docker(args: string[], timeout = 30000): Promise<string> {
  const phase = args.slice(0, 2).join(' '), started = Date.now();
  console.info('STOCK_NATIVE_DOCKER', JSON.stringify({ phase, state: 'started' }));
  try {
    const result = await execDocker('docker', args, { encoding: 'utf8', timeout });
    console.info('STOCK_NATIVE_DOCKER', JSON.stringify({ phase, state: 'completed', elapsedMs: Date.now() - started }));
    return result.stdout.trim();
  } catch (error) {
    console.info('STOCK_NATIVE_DOCKER', JSON.stringify({ phase, state: 'failed', elapsedMs: Date.now() - started, error: String(error) }));
    throw error;
  }
}
beforeAll(async () => {
  expect(execFileSync('codex', ['--version'], { encoding: 'utf8' })).toMatch(/codex/i);
  db = await createOrgTestDb(); h.sql = db.adminSql;
  // SRT has private shared-memory mounts; native files must live on physical /tmp.
  root = mkdtempSync('/tmp/stock-native-factory-'); h.homes = join(root, 'homes'); mkdirSync(h.homes);
});
afterAll(async () => { await db?.cleanup(); if (root) rmSync(root, { recursive: true, force: true }); });

async function refusedAssignment(name: string, problemStatement: string, inContainer = false, freshSessions = 1,
  agent: 'codex' | 'claude' = 'codex') {
  const claudeBinary = agent === 'claude' ? resolveContainerClaudeBinary() : undefined;
  const claudeSha = claudeBinary && createHash('sha256').update(readFileSync(claudeBinary)).digest('hex');
  if (agent === 'claude' && inContainer) expect(claudeSha).toBe(claudeDockerFixture.binarySha256);
  if (claudeBinary) console.info('STOCK_NATIVE_CLAUDE_BINARY', JSON.stringify({ path: claudeBinary, sha256: claudeSha,
    version: execFileSync(claudeBinary, ['--version'], { encoding: 'utf8', timeout: 30000 }).trim() }));
  const repoRoot = join(root, `protocol-${name}`), checkout = join(root, `checkout-${name}`); mkdirSync(repoRoot); mkdirSync(checkout);
  // Lifecycle proof, not a performance budget: the refusal ends Codex ~0.3s after its first
  // request, but sandboxed cold start (bwrap + SRT + two /v1/models probes) took 2.7-4.3s at
  // load ~140 and exceeded an 8s cap at load ~180 (WI-10007969). Keep a wide margin.
  const config = currentProtocolFixture(`PRIVATE-STOCK-NATIVE-${name}`, 30000);
  for (const arm of config.arms) arm.agent = agent;
  if (freshSessions > 1) {
    const shared = { solverGroup: 'private-stock', solverToolsHash: 'f'.repeat(64) };
    config.arms[0].control = { ...shared, topology: 'solo', capabilities: allCapabilities('on') };
    config.arms[1].control = { ...shared, topology: 'repeated-session', capabilities: allCapabilities('off'),
      repeatedSession: { matchedCostOf: 'papercusp', maxSessions: freshSessions,
        workspace: 'same-task', sessionContext: 'fresh-native', submission: 'last-session' } };
  }
  const corpus = JSON.stringify({ entries: [{ key: 'permitted:test', text: 'Permitted frozen context.' }] });
  for (const name of ['corpus', 'memory']) writeFileSync(join(repoRoot, `${name}.json`), corpus);
  config.context = { ...config.context, corpusRef: 'corpus.json', memoryRef: 'memory.json',
    corpusHash: createHash('sha256').update(corpus).digest('hex'), memoryHash: createHash('sha256').update(corpus).digest('hex') };
  const frozen = await preregister({ workspaceId, sql: h.sql as never, runId: config.runId, suites: [], config, repoRoot });
  // Immutable protocol fixture only; no commits in the shared staging checkout.
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: repoRoot });
  const body = readFileSync(frozen.absFilePath, 'utf8');
  execFileSync('git', ['fast-import', '--quiet'], { cwd: repoRoot,
    input: `blob\nmark :1\ndata ${Buffer.byteLength(body)}\n${body}\ncommit refs/heads/main\ncommitter Fixture <fixture@example.invalid> 1577836800 +0000\ndata 6\nfrozen\nM 100644 :1 ${frozen.filePath}\n\ndone\n` });
  const bodies: Array<Record<string, unknown>> = [];
  const requestHeaders: Array<Record<string, string | string[] | undefined>> = [];
  const effectiveControls: Array<Record<string, string>> = [];
  let container: string | undefined, requestWitnessError: unknown;
  // Request timing makes a cold-start budget miss distinguishable from a transport fault.
  const seen: Array<{ t: number; method?: string; url?: string }> = []; const t0 = Date.now();
  const server = createServer(async (req, res) => {
    seen.push({ t: Date.now() - t0, method: req.method, url: req.url });
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const endpoint = agent === 'claude' ? '/messages' : '/responses';
    if (new URL(req.url ?? '/', 'http://private.invalid').pathname.endsWith(endpoint)) {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      bodies.push(body);
      // Credentials are fixture-owned, but exclude them from retained evidence.
      const headers = Object.fromEntries(Object.entries(req.headers)
        .filter(([key]) => !['authorization', 'x-api-key'].includes(key)));
      requestHeaders.push(headers);
      if (agent === 'claude') console.info('STOCK_NATIVE_CLAUDE_REQUEST', JSON.stringify({ headers, body }));
      if (agent === 'claude' && inContainer) {
        try {
          // Read only this mounted executable's allowlisted controls while its
          // request is held. Never retain provider tokens or full environ data.
          const controls = await docker(['exec', container!, '/bin/sh', '-c',
            'for p in /proc/[0-9]*/exe; do if [ "$(readlink "$p")" = "$1" ]; then '
            + 'tr "\\000" "\\n" < "${p%/exe}/environ" | grep -E "^(CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC|CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS|CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK|DISABLE_INTERLEAVED_THINKING|CLAUDE_CODE_MODEL_CAPABILITIES|DISABLE_AUTOUPDATER)="; '
            + 'printf "NATIVE_PID=%s\\n" "${p#/proc/}"; fi; done', 'native-controls', CONTAINER_CLAUDE_BIN_PATH]);
          const entries = controls.split('\n').map(line => {
            const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
          });
          expect(entries).toHaveLength(7);
          const observed = Object.fromEntries(entries);
          expect(observed.NATIVE_PID).toMatch(/^\d+\/exe$/);
          delete observed.NATIVE_PID;
          effectiveControls.push(observed);
          console.info('STOCK_NATIVE_CLAUDE_EFFECTIVE_CONTROLS', JSON.stringify(observed));
        } catch (error) { requestWitnessError = error; }
      }
    }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Private no-forwarding lifecycle fixture.' } }));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  const controller = currentBenchGatewayController({ workspaceId, loopId: 'private-stock-loop', token: 'a'.repeat(64),
    preregHash: frozen.preregHash, protocol: config, armId: 'baseline', taskId: 't1', seed: 1,
    resources: { inputTokens: 100000, outputTokens: 1000, requestsPerArm: 50, usdPerArm: 3, maxOpenUsd: 3,
      wallClockMs: 60000, wallClockMsPerArm: 30000,
      armIds: config.arms.map(arm => currentBenchAssignmentId(config.runId, arm.id, 't1', 1)) }, authenticateProvider: async () => null });
  const hosted = await controller.startNativeGateway(() => {}, async () => ({ port, stop: async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  } } as never));
  const opts: CurrentSuBenchOptions = { workspaceId, runId: config.runId, armId: 'baseline', seed: 1,
    agent, model: 'configured-alias', effort: 'high', account: 'auto', pollIntervalMs: 25, driveTimeoutMs: 45000,
    preregistration: { config, preregHash: frozen.preregHash, repoRoot } };
  const ctx = { workspaceId, principal: { slug: 'authenticated-private-fixture' } } as PapercuspUnifiedToolContext;
  let egress: BenchEgress | undefined, lease: TaskNetworkLease | undefined;
  let unbind: (() => void) | undefined, containerExec: DockerExecTarget | undefined;
  let primaryError: unknown;
  try {
    if (inContainer) {
      // Preflight every local dependency before creating Docker resources.
      // Claude's bypass-permissions mode requires a non-root runtime; keep
      // mounted task/home ownership identical to the host's private fixture.
      const nativeUid = process.getuid!(), nativeGid = process.getgid!();
      if (agent === 'claude') expect(nativeUid, 'Claude Docker fixture requires a non-root host user').toBeGreaterThan(0);
      // Content IDs survive an offline daemon transfer; registry digest aliases
      // need not. Both remain recorded in the fixture's provenance below.
      const image = agent === 'claude' ? claudeDockerFixture.imageId : 'alpine';
      for (const dependency of [image, 'nginx:alpine']) await docker(['image', 'inspect', dependency]);
      if (agent === 'claude') expect(await docker(['image', 'inspect', '--format', '{{.Id}}', image])).toBe(claudeDockerFixture.imageId);
      const binary = claudeBinary ?? resolveContainerCodexBinary();
      const binPath = agent === 'claude' ? CONTAINER_CLAUDE_BIN_PATH : CONTAINER_CODEX_BIN_PATH;
      const perTaskDir = join(root, `container-homes-${name}`); mkdirSync(perTaskDir);
      egress = await startBenchEgress({ runId: `stock-native-proof-${randomUUID()}`,
        endpoints: [{ name: 'gw', listenPort: 8788, perTask: true }] });
      console.info('STOCK_NATIVE_PHASE', JSON.stringify({ phase: 'egress-ready', runId: egress.runId }));
      lease = await egress.openTaskNetwork(name);
      unbind = egress.bindTaskEndpoint(lease.network, 'gw', port);
      container = await docker(['run', '-d', '--name', `stock-native-fixture-${randomUUID()}`, '--label', `papercusp.stock-proof=${egress.runId}`,
        '--network', lease.network, '--workdir', '/app',
        ...(agent === 'claude' ? ['--user', `${nativeUid}:${nativeGid}`] : []),
        '--mount', `type=bind,src=${binary},dst=${binPath},readonly`,
        ...(agent === 'claude' ? ['--mount', `type=bind,src=${checkout},dst=/app`] : []),
        '--mount', `type=bind,src=${perTaskDir},dst=${h.homes}`, image, 'sleep', '300'], 60000);
      if (agent === 'claude') {
        expect(await docker(['inspect', '--format', '{{.Image}}', container])).toBe(claudeDockerFixture.imageId);
        expect(await docker(['exec', container, 'id', '-u'])).toBe(String(nativeUid));
        expect(await docker(['exec', container, 'id', '-g'])).toBe(String(nativeGid));
        expect(await docker(['exec', '-w', '/app', container, 'env', '-i', 'HOME=/tmp',
          'CLAUDE_CONFIG_DIR=/tmp/private-version-probe', binPath, '--version'])).toBe(`${claudeDockerFixture.version} (Claude Code)`);
        // Match the wrapper's no-policy admission without opening policy files.
        expect(await docker(['exec', container, '/bin/sh', '-c',
          'test -d /etc && test -x /etc && test ! -e /etc/claude-code && test ! -L /etc/claude-code && printf admitted'])).toBe('admitted');
        console.info('STOCK_NATIVE_CLAUDE_DOCKER_PIN', JSON.stringify({ ...claudeDockerFixture, containerId: container,
          uid: nativeUid, gid: nativeGid }));
      }
      containerExec = { kind: 'docker-exec', containerId: container, workdir: '/app', binPath,
        sessionRelocation: { sessionEnv: agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME', roots: [{ hostRoot: h.homes, perTaskDir }] },
        originRewrites: [{ from: `http://127.0.0.1:${port}`, to: egress.originFor('gw') }] };
      console.info('STOCK_NATIVE_PHASE', JSON.stringify({ phase: 'native-start', container }));
    }
    // Exercise the real native session/grant lifecycle independently of the
    // matched-cost loop: a refusal has no complete cost receipt and that loop
    // must stop rather than pretend it observed a successful free generation.
    const nativeSessionIds: string[] = [];
    const checkpoint = join(checkout, 'retained-workspace.txt');
    const started = Date.now();
    let result!: Awaited<ReturnType<ReturnType<typeof createCurrentStockBenchHarness>['spinRunAndCost']>>;
    for (let index = 0; index < freshSessions; index++) {
      const budget = { ...config.arms[1].generationBudget,
        maxWallClockMs: config.arms[1].generationBudget.maxWallClockMs! - (Date.now() - started) };
      const sessionBudget = freshSessions > 1 ? hosted.issueSessionBudget(budget) : undefined;
      const factory = createCurrentStockBenchHarness(opts, ctx, { ...hosted,
        ...(containerExec ? { containerExec } : {}), ...(sessionBudget ? { sessionBudget } : {}),
        admit: async () => ({ admitted: true, receiptRef: 'private-no-spend-admission' }), observeIdentity: async () => null }, { sql: h.sql as never });
      result = await factory.spinRunAndCost({ blueprintId: `native-${agent}`,
        task: { benchmark: 'swe-bench-pro', instanceId: 't1', problemStatement, graderMeta: {} },
        checkout: { dir: checkout, repo: 'fixture/private', baseCommit: 'fixture', cleanup: async () => {} },
        budget: sessionBudget?.budget ?? config.arms[1].generationBudget });
      expect(result.telemetry.stopReason, JSON.stringify(result)).not.toBe('done');
      expect(result.telemetry.armMeta?.costUsdMeasurementMissing, JSON.stringify(result)).toBe(true);
      const observed = await h.sql`SELECT a.session_id FROM harness_shared.adv_sessions a
        JOIN harness_shared.task_ledger t ON t.workspace_id=a.workspace_id
          AND t.detail->>'coordOwnerId'=a.coord_owner_id AND t.session_id=a.session_id
        WHERE a.workspace_id=${workspaceId}
          AND t.detail->>'assignmentId'=${currentBenchAssignmentId(config.runId, 'baseline', 't1', 1)}`;
      expect(observed, JSON.stringify({ index, telemetry: result.telemetry, observed, seen })).toHaveLength(index + 1);
      const added = observed.filter(row => !nativeSessionIds.includes(row.session_id));
      expect(added).toHaveLength(1); nativeSessionIds.push(added[0].session_id);
      if (index) expect(readFileSync(checkpoint, 'utf8')).toBe('Preserve the task checkpoint across fresh sessions.');
      else if (freshSessions > 1) writeFileSync(checkpoint, 'Preserve the task checkpoint across fresh sessions.');
    }
    if (inContainer) console.info('STOCK_NATIVE_PHASE', JSON.stringify({ phase: 'native-ended',
      requests: bodies.length, stopReason: result.telemetry.stopReason, generationError: result.telemetry.generationError }));
    // The listener supplies no model answer or billed identity. Refusal must
    // never become a verified successful generation or a complete free run.
    expect(result.telemetry.stopReason, JSON.stringify(result)).not.toBe('done');
    expect(result.telemetry.armMeta?.costUsdMeasurementMissing, JSON.stringify(result)).toBe(true);
    const tasks = await h.sql`SELECT task_id, session_id, state, exit_code FROM harness_shared.task_ledger WHERE workspace_id=${workspaceId}`;
    const sessions = await h.sql`SELECT id, session_id, ended_at FROM harness_shared.adv_sessions WHERE workspace_id=${workspaceId}`;
    const diagnostic = JSON.stringify({ telemetry: result.telemetry, tasks, sessions, seen });
    expect(bodies.length, diagnostic).toBeGreaterThan(0); expect(bodies[0].model, diagnostic).toBe('configured-alias');
    const rows = await h.sql`SELECT t.task_id, t.session_id, t.state, t.ended_at, a.id, a.coord_owner_id, a.ended_at AS session_ended_at
      FROM harness_shared.task_ledger t JOIN harness_shared.adv_sessions a
        ON a.workspace_id=t.workspace_id AND a.coord_owner_id=t.detail->>'coordOwnerId' AND a.session_id=t.session_id
      WHERE t.workspace_id=${workspaceId} AND t.detail->>'assignmentId'=${currentBenchAssignmentId(config.runId, 'baseline', 't1', 1)}`;
    expect(rows).toHaveLength(freshSessions);
    expect(new Set(rows.map(row => row.id)).size).toBe(freshSessions);
    expect(new Set(rows.map(row => row.session_id)).size).toBe(freshSessions);
    // managedSpawn persists exit asynchronously after its cgroup handoff
    // barrier. Observe its authoritative terminal row, not the stream's exit.
    await expect.poll(async () => {
      const terminals = await h.sql`SELECT ended_at FROM harness_shared.task_ledger
        WHERE workspace_id=${workspaceId} AND task_id IN ${h.sql(rows.map(row => row.task_id))}`;
      return terminals.length === freshSessions && terminals.every(row => row.ended_at instanceof Date);
    }, { timeout: 10000, interval: 50 }).toBe(true);
    const homeFor = (row: typeof rows[number]) => join(h.homes, agent === 'claude' ? row.coord_owner_id : String(row.id));
    for (const row of rows) {
      expect(row.session_id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(row.session_ended_at).not.toBeNull();
      const home = homeFor(row);
      for (const file of ['AGENTS.md', 'hooks.json', 'auth.json']) expect(existsSync(join(home, file))).toBe(false);
    }
    const files = await h.sql`SELECT file_path, byte_offset FROM harness_shared.interactive_usage_files WHERE workspace_id=${workspaceId}`;
    expect(files.length).toBeGreaterThan(0);
    for (const row of rows)
      expect(files.some(file => file.file_path.includes(join(homeFor(row), agent === 'claude' ? 'projects' : 'sessions')))).toBe(true);
    if (freshSessions > 1) {
      expect(() => hosted.issueSessionBudget(config.arms[1].generationBudget)).toThrow(/exhausted/);
      expect(bodies).toHaveLength(freshSessions);
      for (const body of bodies) expect(JSON.stringify(agent === 'claude' ? [body.system, body.messages] : body.input)).toContain(inContainer ? '/app' : checkout);
    }
    if (inContainer) {
      expect(egress!.stats().gw.connections).toBeGreaterThan(0);
      if (agent === 'codex') {
        const toml = readFileSync(join(homeFor(rows[0]), 'config.toml'), 'utf8');
        expect(toml).toContain(egress!.originFor('gw'));
        expect(toml).not.toContain('mcp_servers');
      }
      const request = JSON.stringify(agent === 'claude' ? [bodies[0].system, bodies[0].messages] : bodies[0].input);
      expect(request).toContain(agent === 'claude' ? '/app' : '<cwd>/app</cwd>');
      expect(request).not.toContain(checkout);
    }
    if (requestWitnessError) throw requestWitnessError;
    const collector = new GatewayRequestTelemetry();
    const span = collector.begin({ provider: agent, protocol: agent === 'claude' ? 'anthropic-messages' : 'openai-responses' });
    span.setCacheShape(Buffer.from(JSON.stringify(bodies[0])));
    const cache = span.finish('gateway-error', 400)!.cache;
    const text = JSON.stringify(bodies[0].input);
    if (claudeBinary) expect(createHash('sha256').update(readFileSync(claudeBinary)).digest('hex')).toBe(claudeSha);
    return { cache, checkout, body: bodies[0], bodies, requestHeaders, effectiveControls, checkoutInInput: text?.includes(checkout), nativeSessionIds };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    unbind?.();
    const cleanupErrors: string[] = [];
    const clean = async (name: string, operation: () => unknown | Promise<unknown>) => {
      try { await operation(); } catch (error) { cleanupErrors.push(`${name}: ${String(error)}`); }
    };
    if (container) {
      // Hand root-written session evidence back before the bind mount vanishes.
      await clean('session ownership', () => docker(['exec', '-u', '0', container!, 'chown', '-R', `${process.getuid!()}:${process.getgid!()}`, h.homes]));
      await clean('container', () => docker(['rm', '-f', container!]));
    }
    if (containerExec) await clean('restore', () => expect(restoreRelocatedSessions(containerExec!.sessionRelocation!.roots).errors).toEqual([]));
    if (lease) await clean('task network', async () => expect(await lease!.release()).toEqual([]));
    if (egress) await clean('egress', async () => expect((await egress!.stop()).errors).toEqual([]));
    await clean('gateway', () => hosted.stop());
    if (cleanupErrors.length) throw new Error(JSON.stringify({ primaryError: primaryError ? String(primaryError) : null, cleanupErrors }),
      { cause: primaryError });
  }
}

it('runs the clean stock native CLI in /app through internal-network egress with retained native evidence', async () => {
  await refusedAssignment('container-lifecycle', 'Describe the empty repository.', true);
}, 240000);

it('retains a real native UUID and terminal ingestion after local refusal without provider forwarding', async () => {
  await refusedAssignment('lifecycle', 'Describe the empty repository.');
}, 120000);

it('opens distinct clean native sessions on one task workspace and host gateway with retired session allowances', async () => {
  const result = await refusedAssignment('fresh-sessions', 'Describe the same task workspace.', false, 2);
  expect(result.nativeSessionIds).toHaveLength(2);
  expect(new Set(result.nativeSessionIds).size).toBe(2);
}, 120000);

it('observes fresh Claude native requests and terminal ingestion after local refusal without provider forwarding', async () => {
  const result = await refusedAssignment('claude-fresh-sessions', 'Describe the same task workspace.', false, 2, 'claude');
  expect(result.nativeSessionIds).toHaveLength(2);
  expect(new Set(result.nativeSessionIds).size).toBe(2);
  expect(result.bodies).toHaveLength(2);
  for (const [index, body] of result.bodies.entries()) {
    expect(body.model).toBe('configured-alias');
    expect(JSON.stringify(body.metadata)).toContain(result.nativeSessionIds[index]);
    expect(body.messages).toEqual(expect.any(Array));
    expect(result.requestHeaders[index]['anthropic-version']).toBe('2023-06-01');
  }
  console.info('STOCK_NATIVE_CLAUDE_SESSIONS', JSON.stringify({ sessionIds: result.nativeSessionIds }));
}, 120000);

it('qualifies pinned Claude Docker controls and fresh conversations without provider forwarding', async () => {
  const result = await refusedAssignment('claude-docker-fresh', 'Describe the same task workspace.', true, 2, 'claude');
  expect(result.nativeSessionIds).toHaveLength(2);
  expect(new Set(result.nativeSessionIds).size).toBe(2);
  expect(result.bodies).toHaveLength(2);
  expect(result.effectiveControls).toHaveLength(2);
  for (const [index, body] of result.bodies.entries()) {
    expect(result.effectiveControls[index]).toEqual({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1', CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: '1',
      DISABLE_INTERLEAVED_THINKING: '1', CLAUDE_CODE_MODEL_CAPABILITIES: '-mid_conv_system', DISABLE_AUTOUPDATER: '1' });
    expect(body.model).toBe('configured-alias');
    expect(JSON.stringify(body.metadata)).toContain(result.nativeSessionIds[index]);
    expect((body.messages as Array<{ role: string }>).map(message => message.role)).toEqual(['user']);
    expect(body).not.toHaveProperty('context_management');
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(result.requestHeaders[index]['anthropic-version']).toBe('2023-06-01');
    expect(result.requestHeaders[index]['anthropic-beta']).toBe('claude-code-20250219,effort-2025-11-24');
    expect(result.requestHeaders[index]['x-claude-code-session-id']).toBe(result.nativeSessionIds[index]);
  }
  console.info('STOCK_NATIVE_CLAUDE_DOCKER_SESSIONS', JSON.stringify({ sessionIds: result.nativeSessionIds }));
}, 240000);

it('keeps source-bound native instruction templates across distinct isolated assignments', async () => {
  const first = await refusedAssignment('fingerprint-first', 'Describe the first empty repository.');
  const second = await refusedAssignment('fingerprint-second', 'Describe the second empty repository.');
  expect(first.cache.shape).toBe('observed'); expect(second.cache.shape).toBe('observed');
  expect(first.cache.instructions?.bytes).toBe(first.cache.instructions?.hashedBytes);
  expect(first.cache.tools?.bytes).toBe(first.cache.tools?.hashedBytes);
  console.info('NATIVE_ASSIGNMENT_FINGERPRINTS', JSON.stringify({ first: first.cache, second: second.cache,
    checkoutInInput: [first.checkoutInInput, second.checkoutInInput] }));
  // This is native request-shape proof only: refusal supplies no provider answer,
  // metered success, preregistration pin or benchmark-performance evidence.
  expect(second.cache.tools).toEqual(first.cache.tools);
  expect(first.cache.instructions).not.toEqual(second.cache.instructions);
  expect(first.cache.nativeInstructionTemplate?.fingerprint?.bytes).toBeGreaterThan(0);
  expect(second.cache.nativeInstructionTemplate?.fingerprint).toEqual(first.cache.nativeInstructionTemplate?.fingerprint);
  for (const assignment of [first, second]) {
    const declaredRoot = `${String((assignment.body.input as Array<Record<string, unknown>>)
      .flatMap(item => Array.isArray(item.content) ? item.content : [])
      .find(part => String(part.text).includes('<skills_instructions>'))?.text)
      .match(/^- [\x60]r0[\x60] = [\x60]([^\x60]+)[\x60]$/m)?.[1]}`;
    expect(assignment.cache.nativeInstructionTemplate?.skillsRootHash)
      .toBe(createHash('sha256').update(declaredRoot).digest('hex'));
  }
}, 240000);
