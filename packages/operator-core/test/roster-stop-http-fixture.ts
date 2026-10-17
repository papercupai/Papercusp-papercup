/** Private HTTP/native acceptance fixture, launched by its registered integration suite. */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getOrgPg, _resetForTests } from '@papercusp/db-org';
import { getAdvSessionInWorkspace, markAdvSessionEnded, recordAdvSession } from '../lib/adv-sessions';
import { buildPrivateOperatorApiBundle, createPrivateHealthSnapshot, preparePortalBrowserSource, preparePrivateDocsBrowserDocuments, preparePrivateHttpWorkspaces, privateBundleRuntimeEnv, privatePgStartupIdentity, resolvePreparedPrivateApiBundle, stopPrivateOperatorHost } from './private-http-workspace-preflight';
import { verifyPrivateCoordReceipt } from './private-coord-receipt';
import { seedPrivateProjectHistory, preflightPrivateProjectHistory } from './portal-project-history-fixture';
import { seedPrivateCalendar, preflightPrivateCalendar } from './portal-calendar-fixture';
import { seedPrivateLearning, preflightPrivateLearning } from './portal-learning-fixture';
import { seedPrivateWorkflows, preflightPrivateWorkflows } from './portal-workflows-fixture';
import { seedPrivateStats, preflightPrivateStats } from './portal-stats-fixture';
import { seedPrivateGit, preflightPrivateGit } from './portal-git-fixture';
import { startPrivateCupboardCatalog } from './portal-cupboard-fixture';

const root = resolve(import.meta.dirname, '../../..');
const evidence = process.env.ROSTER_STOP_HTTP_EVIDENCE_DIR!;
const healthCleanupProof = process.argv.includes('--health-cleanup-proof');
const healthPublicationProof = process.argv.includes('--health-publication-proof');
const socketOrigins = new Map<number, { socket: net.Socket; stack: string; createdAt: number; connectedAt: number }>();
const originalConnect = net.Socket.prototype.connect;
const originalWrite = net.Socket.prototype.write;
const originalEnd = net.Socket.prototype.end;
const originalDestroy = net.Socket.prototype.destroy;
const socketStartups = new WeakMap<net.Socket, NonNullable<ReturnType<typeof privatePgStartupIdentity>>>();
const socketClosures = new WeakMap<net.Socket, { endAt?: number; endStack?: string; destroyAt?: number; destroyStack?: string }>();
// Use the same creation-stack/census evidence as the native current-build
// fixture. A completed cleanup await alone cannot prove the worker will exit.
net.Socket.prototype.connect = function(this: net.Socket, ...args: unknown[]) {
  const stack = new Error('Private roster PG connection creation').stack ?? '';
  const createdAt = Date.now();
  this.once('connect', () => {
    if (this.remotePort === Number(process.env.PAPERCUSP_PG_PORT) && this.localPort)
      socketOrigins.set(this.localPort, { socket: this, stack, createdAt, connectedAt: Date.now() });
  });
  return Reflect.apply(originalConnect, this, args);
} as typeof originalConnect;
net.Socket.prototype.write = function(this: net.Socket, ...args: unknown[]) {
  if (this.remotePort === Number(process.env.PAPERCUSP_PG_PORT) && !socketStartups.has(this)) {
    const identity = privatePgStartupIdentity(args[0]);
    if (identity) socketStartups.set(this, identity);
  }
  return Reflect.apply(originalWrite, this, args);
} as typeof originalWrite;
net.Socket.prototype.end = function(this: net.Socket, ...args: unknown[]) {
  if (this.remotePort === Number(process.env.PAPERCUSP_PG_PORT)) socketClosures.set(this, {
    ...socketClosures.get(this), endAt: Date.now(), endStack: new Error('Private PG socket end').stack });
  return Reflect.apply(originalEnd, this, args);
} as typeof originalEnd;
net.Socket.prototype.destroy = function(this: net.Socket, ...args: unknown[]) {
  if (this.remotePort === Number(process.env.PAPERCUSP_PG_PORT)) socketClosures.set(this, {
    ...socketClosures.get(this), destroyAt: Date.now(), destroyStack: new Error('Private PG socket destroy').stack });
  return Reflect.apply(originalDestroy, this, args);
} as typeof originalDestroy;
const requestedBrowserProof = process.argv.find(value => value.startsWith('--browser-proof='))?.slice('--browser-proof='.length);
if (requestedBrowserProof) {
  assert.ok(['ROSTER_CONVERSATIONS_BROWSER_PROOF', 'ROSTER_CREATE_DOCK_BROWSER_PROOF'].includes(requestedBrowserProof));
  const proofEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('ROSTER_') && key.endsWith('_PROOF')));
  writeFileSync(join(evidence, 'requested-browser-proof.json'), JSON.stringify({ requestedBrowserProof, proofEnvironment,
    sourceSha256: createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex') }, null, 2));
  assert.equal(process.env[requestedBrowserProof], '1', 'requested browser proof must reach the original worker');
}
const workspace = process.env.PAPERCUSP_WORKSPACE_ID!;
const base = process.env.PAPERCUSP_OPERATOR_URL!;
assert.match(workspace, /^test-runtime-/);
assert.equal(process.env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '0');
assert.ok(![3070, 3170, 3271].includes(Number(new URL(base).port)));
assert.ok(evidence);
const preparedApiBundle = resolvePreparedPrivateApiBundle(process.argv, evidence);
const apiBundle = preparedApiBundle ?? join(evidence, 'hono-host.mjs');
const portalSourceRoot = !healthCleanupProof && !healthPublicationProof && (process.env.ROSTER_COORD_BROWSER_PROOF === '1' || process.env.ROSTER_STOP_BROWSER_PROOF === '1')
  ? preparePortalBrowserSource(process.argv) : undefined;
// Evidence paths are intentionally long; AF_UNIX addresses are bounded by bytes.
// Keep the mutable socket namespace short and retain its identity in the receipt.
const discovery = mkdtempSync(join(tmpdir(), 'rs-'));
assert.ok(Buffer.byteLength(join(discovery, 'su-rs-123456789-neighbor.sock')) < 104,
  'private socket directory exceeds the native address limit');
writeFileSync(join(evidence, 'discovery.json'), JSON.stringify({ discovery }));
process.env.PAPERCUSP_PSU_PTY_DIR = discovery;
process.env.PAPERCUSP_TURN_PROVENANCE_DIR = join(evidence, 'turn-provenance');
const { socketPathFor, metaPathFor, eventLogPathForOwner, encodeControl } = await import('../../../apps/operator/scripts/psu-pty-host.mjs');
const { shutdownViaPty } = await import('../lib/events/await/psu-pty-discovery');
const { sql } = getOrgPg();
const sessions: Array<{ owner: string; id: number; startedAt: string; done: Promise<number>; closed: boolean; output: () => string;
  pid?: number; exitedAt?: string; closedAt?: string; exitCode?: number | null; exitSignal?: NodeJS.Signals | null }> = [];
let api: ChildProcess | undefined;
let cupboardCatalog: Awaited<ReturnType<typeof startPrivateCupboardCatalog>> | undefined;
const endings: Promise<unknown>[] = [];
const inboxInvalidations: Array<Record<string, unknown>> = [];
let inboxInvalidationListener: { unlisten: () => Promise<void> } | undefined;

function retainNativeState(stage: string) {
  appendFileSync(join(evidence, 'roster-stop-native.jsonl'), JSON.stringify({ at: new Date().toISOString(), stage,
    sessions: sessions.map(({ done: _done, output, ...session }) => ({ ...session, output: output(),
      hostEvents: existsSync(eventLogPathForOwner(session.owner))
        ? readFileSync(eventLogPathForOwner(session.owner), 'utf8') : null })) }) + '\n');
}

async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error(`roster stop fixture timeout: ${label}`);
}

async function child(label: string) {
  const owner = `su-rs-${process.pid}-${label}`;
  const id = await recordAdvSession({ workspaceId: workspace, mode: 'console', agent: 'codex', role: 'su', coordOwnerId: owner });
  assert.ok(id);
  const row = await getAdvSessionInWorkspace(id, workspace);
  assert.ok(row);
  let output = '';
  const session: typeof sessions[number] = { owner, id, startedAt: row.startedAt, closed: false,
    output: () => output, done: Promise.resolve(0) };
  const host = spawn(process.execPath, [join(root, 'packages/operator-core/test/psu-pty-host-canary.mjs'), owner, String(id)], {
    cwd: evidence, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, TERM: 'xterm-256color', PAPERCUSP_PSU_PTY_DIR: discovery,
      PAPERCUSP_TURN_PROVENANCE_DIR: join(evidence, 'turn-provenance'),
      PAPERCUSP_SID: owner, PAPERCUSP_LAUNCHED_BY: 'su-private-roster-acceptance' },
  });
  host.stdout!.setEncoding('utf8');
  host.stdout!.on('data', (chunk: string) => { output += chunk; });
  host.stderr!.on('data', chunk => process.stderr.write(chunk));
  session.pid = host.pid;
  host.once('exit', (code, signal) => {
    session.exitedAt = new Date().toISOString();
    session.exitCode = code; session.exitSignal = signal;
    retainNativeState('host-exit');
  });
  session.done = new Promise((done, reject) => {
    host.once('error', reject);
    host.once('close', (code, osSignal) => {
      session.closed = true;
      session.closedAt = new Date().toISOString();
      retainNativeState('host-close');
      const line = output.split('\n').find(value => value.startsWith('ROSTER_CANARY_EXIT '));
      const signal = line ? JSON.parse(line.slice('ROSTER_CANARY_EXIT '.length)).signal : osSignal;
      endings.push(markAdvSessionEnded(id, code, signal ? 'signal' : 'self', { signal, throwOnError: true }));
      done(code ?? 1);
    });
  });
  sessions.push(session);
  await until(() => existsSync(socketPathFor(owner)) && existsSync(metaPathFor(owner)), `${label} host ready`);
  const metadata = JSON.parse(readFileSync(metaPathFor(owner), 'utf8'));
  assert.equal(metadata.pid, host.pid, 'discovery must identify its dedicated PSU host');
  return session;
}

async function responds(session: typeof sessions[number], marker: string) {
  assert.equal(session.closed, false, `${session.owner} must remain alive`);
  let ack = '';
  await new Promise<void>((done, reject) => {
    const socket = net.connect(socketPathFor(session.owner), () => {
      socket.end(encodeControl({ mode: 'raw', data: marker + '\n', ownerId: session.owner }));
    });
    socket.setTimeout(2_000, () => { socket.destroy(); reject(new Error('private canary socket timeout')); });
    // Reading the reply puts the stream in flowing mode; otherwise close can
    // remain blocked behind the unread ACK (the maintained native helper's contract).
    socket.setEncoding('utf8');
    socket.on('data', value => { ack += value; });
    socket.once('error', reject); socket.once('close', () => done());
  });
  assert.equal(JSON.parse(ack.trim().split('\n')[0]).ok, true, 'private canary raw control ACK');
  await until(() => session.output().includes(`ECHO:${marker}`), `${session.owner} reply`);
}

async function quiet(session: typeof sessions[number]) {
  await until(() => {
    assert.equal(session.closed, false, 'canary must survive until the stop request');
    const metadata = JSON.parse(readFileSync(metaPathFor(session.owner), 'utf8'));
    return Number(metadata.lastOutputAt) > 0 && Date.now() - Number(metadata.lastOutputAt) >= 1_500;
  }, `${session.owner} native output quiet`);
}

async function request(payload: Record<string, unknown>) {
  const response = await fetch(base + '/api/adv/sessions/close-window', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, 'x-papercusp-workspace': workspace },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** Exercise the real cookie principal and persisted inbox without touching a live agent. */
async function coordCanary(health: unknown) {
  const { signup, login, getSessionUser, SESSION_COOKIE } = await import('../lib/auth');
  const { getMessageById, readInbox } = await import('../lib/agent-tools/coordination/messages');
  const selected = `su-coord-${process.pid}-selected`;
  const neighbor = `su-coord-${process.pid}-neighbor`;
  const foreign = `su-coord-${process.pid}-foreign`;
  const stale = `su-coord-${process.pid}-stale`;
  const foreignWorkspace = workspace + '-foreign';
  const historySessions = new Map<string, { id: number; rolloutId: string; marker: string }>();
  for (const [owner, scope] of [[selected, workspace], [neighbor, workspace], [foreign, foreignWorkspace], [stale, workspace]]) {
    const nativeId = randomUUID();
    const id = await recordAdvSession({ workspaceId: scope, mode: 'console', agent: 'codex', role: 'su', coordOwnerId: owner,
      ...(process.env.ROSTER_HISTORY_BROWSER_PROOF === '1' ? { pid: process.pid, sessionId: nativeId } : {}) });
    assert.ok(id);
    if (process.env.ROSTER_HUD_BROWSER_PROOF === '1' && owner !== stale) {
      const { writePresence } = await import('../lib/agent-tools/coordination/presence');
      const hudRole = owner === selected ? 'selected' : owner === neighbor ? 'neighbor' : 'foreign';
      await writePresence({ ownerId: owner, ownerLabel: `HUD ${hudRole} ${owner}`,
        workspaceId: scope, source: 'omp-hook-session', userId: null },
      { agentRole: 'su', intent: `HUD ${hudRole} ${owner}`,
        host: 'private-hud-canary', pid: process.pid, capabilityTags: [] });
    }
    if (process.env.ROSTER_HISTORY_BROWSER_PROOF === '1') {
      const { codexHomeForSessionKey } = await import('@papercusp/orchestrator/session-launch-dirs');
      const directory = join(codexHomeForSessionKey(id), 'sessions');
      assert.ok(directory.startsWith(process.env.HOME! + '/'), 'native transcript must be inside the disposable runtime home');
      mkdirSync(directory, { recursive: true });
      const timestamp = new Date().toISOString();
      const marker = 'private-history-' + owner;
      writeFileSync(join(directory, `rollout-${timestamp.replaceAll(':', '-')}-${nativeId}.jsonl`), [
        { type: 'session_meta', timestamp, payload: { id: nativeId, timestamp, cwd: root } },
        { type: 'event_msg', timestamp, payload: { type: 'user_message', message: 'Read the private canary transcript' } },
        { type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: marker }] } },
      ].map(value => JSON.stringify(value)).join('\n') + '\n');
      historySessions.set(owner, { id, rolloutId: nativeId, marker });
    }
    if (owner === stale) await markAdvSessionEnded(id, 0, 'self', { throwOnError: true });
  }
  const username = `coord_${process.pid}`;
  await signup(username, 'Private roster canary', null);
  const ownSession = await login(username, null, { workspace_id: workspace });
  const foreignSession = await login(username, null, { workspace_id: foreignWorkspace });
  const cookie = (token: string) => `${SESSION_COOKIE}=${token}`;
  const ownPrincipal = await getSessionUser(new Headers({ cookie: cookie(ownSession.token) }));
  assert.equal(ownPrincipal?.workspace_id, workspace);
  const marker = `private-coord-${process.pid}`;
  const receipts: Array<{ status: number; body: any }> = [];
  const post = async (to: string[], wake = false, overrides: Record<string, string> = {}) => {
    const response = await fetch(base + '/api/admin/coord/send', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: cookie(ownSession.token),
        'x-papercusp-workspace': foreignWorkspace, ...overrides },
      body: JSON.stringify({ to, summary: marker, body: [{ text: marker }], expects: 'none',
        ...(wake ? { wake: 'required' } : {}) }), signal: AbortSignal.timeout(25_000) });
    return { status: response.status, body: await response.json() as any };
  };
  const verifyReceipt = (receipt: { status: number; body: any }, expectedOwner: string, wake: boolean, summary = marker) =>
    verifyPrivateCoordReceipt(receipt, { ownerId: expectedOwner, summary, wake }, getMessageById);
  if (process.env.ROSTER_COORD_BROWSER_PROOF === '1') {
    if (process.env.ROSTER_HEALTH_BROWSER_PROOF === '1') {
      const { writeSharedSnapshot } = await import('../lib/derived-reads/shared-snapshot');
      const { recordHealthHistory } = await import('../lib/system-health/history');
      const { createWorkItem, setWorkItemState, updateExternalBlockerHistory } = await import('../lib/work-items');
      // A real private needs-human row keeps the maintained Work-items collector
      // alarming across the positive ack/unack ticks; no collector is mocked.
      const { blockers } = updateExternalBlockerHistory({}, { kind: 'human', capability: 'credential',
        ref: 'credential:private-health-test', summary: 'Provide the private test credential',
        nextVerb: 'provide private test credential', defaultIfUnanswered: 'stay parked until the private credential is supplied' },
      'private-health-fixture');
      const condition = await createWorkItem({ kind: 'bug', title: 'Private Health accepted condition',
        harness: 'papercusp', workspaceId: workspace, createdBy: 'private-health-fixture', payload: { externalBlockers: blockers } });
      const needsHuman = await setWorkItemState(condition.id, 'needs-human', { harness: 'papercusp', by: 'private-health-fixture' });
      assert.equal(needsHuman?.state, 'needs-human');
      const now = Date.now();
      const snapshot = (workspaceId: string, foreign: boolean) => createPrivateHealthSnapshot(workspaceId, foreign, now);
      const current = snapshot(workspace, false);
      await writeSharedSnapshot('system.health', workspace, current, 1);
      await writeSharedSnapshot('system.health', foreignWorkspace, snapshot(foreignWorkspace, true), 1);
      const { panels, ...rest } = current;
      await recordHealthHistory({ ...rest, panels: { ...panels, workItems: { ...panels.workItems, status: 'ok' } } },
        { ...current, panels: { ...panels, workItems: { ...panels.workItems, summary: 'private-health-transition' } } });
      writeFileSync(join(evidence, 'portal-health-seed.json'), JSON.stringify({ current, foreignWorkspace, conditionId: condition.id,
        scope: 'Initial supplied snapshot/history; real private needs-human row drives subsequent Work-items collector ticks' }, null, 2));
    }
    if (healthCleanupProof) {
      // Exercise the original Health seed and browser import graph without
      // building/starting an API or replaying the browser journey.
      await import('./portal-roster-browser-fixture');
      // Collector and shared-query subscriptions also use the process-wide hub.
      // Keep one alive so this proof exercises its teardown independently of
      // the auth listener, whose unsubscribe may leave other subscribers.
      const { hubListen } = await import('../lib/pg-listen-hub');
      await hubListen('private_health_cleanup_probe', () => {});
      console.log('ROSTER_HEALTH_CLEANUP_SEEDED ' + JSON.stringify({ workspace }));
      return;
    }
    if (healthPublicationProof) {
      const { writeSharedSnapshot, readSharedSnapshot } = await import('../lib/derived-reads/shared-snapshot');
      const { waitForPrivateHealthSnapshot } = await import('./portal-roster-browser-fixture');
      const headers = { cookie: cookie(ownSession.token), origin: base, 'content-type': 'application/json' };
      const query = base + '/api/zero-harness/rest-query?name=health.snapshot&args=%7B%7D';
      const read = async () => {
        const response = await fetch(query, { headers, signal: AbortSignal.timeout(15_000) });
        assert.equal(response.status, 200);
        return response.json() as Promise<{ rows: ReturnType<typeof createPrivateHealthSnapshot>[] }>;
      };
      // Reproduce the browser's real acknowledgement tick before replacing the
      // shared reading. This primes the request process's own health cache.
      await read();
      const ack = await fetch(base + '/api/agent-tools/health/ack', { method: 'POST', headers,
        body: JSON.stringify({ panel: 'workItems', reason: 'private publication cache probe' }),
        signal: AbortSignal.timeout(90_000) });
      assert.equal(ack.status, 200);
      const baseline = await read();
      const replacement = createPrivateHealthSnapshot(workspace, false, Date.now());
      replacement.panels.infra.summary = 'private-health-publication-replacement';
      await writeSharedSnapshot('system.health', workspace, replacement, 1);
      const observations: unknown[] = [];
      await waitForPrivateHealthSnapshot(async () => {
        const shared = await readSharedSnapshot<typeof replacement>('system.health', workspace, 1, 300_000);
        const body = await read();
        observations.push({ at: Date.now(), shared, body });
        writeFileSync(join(evidence, 'portal-health-publication.json'), JSON.stringify({
          workspace, baseline, replacement, observations,
          backgroundWorkers: process.env.PAPERCUSP_BACKGROUND_WORKERS,
          scope: 'Real shared store and private HTTP reader after an acknowledgement tick; supplied replacement isolates publication, not collector or DOM acceptance',
        }, null, 2));
        return body;
      }, workspace, row => row.panels.infra.summary === replacement.panels.infra.summary);
      console.log('ROSTER_HEALTH_PUBLICATION_RECEIPT ' + JSON.stringify({ workspace, converged: true, reads: observations.length }));
      return;
    }
    let harnesses: { hive: string; selected: string; neighbor: string; foreign: string } | undefined;
    if (process.env.ROSTER_WORK_BROWSER_PROOF === '1') {
      const { mutateHarnessRegistry } = await import('../lib/harness-registry');
      const stem = `private-work-${process.pid}`;
      harnesses = { hive: stem + '-hive', selected: stem + '-selected', neighbor: stem + '-neighbor', foreign: stem + '-foreign' };
      const seedRoot = mkdtempSync(join(tmpdir(), 'work-'));
      const project = (slug: string, fields: { harness_kind?: string; hive_slug?: string } = {}) => {
        const path = join(seedRoot, slug);
        mkdirSync(join(path, '.papercusp'), { recursive: true });
        return { slug, path, ...fields };
      };
      await mutateHarnessRegistry(reg => ({ ...reg, projects: [...reg.projects,
        project(harnesses!.hive, { harness_kind: 'hive' }),
        project(harnesses!.selected, { hive_slug: harnesses!.hive }),
        project(harnesses!.neighbor, { hive_slug: harnesses!.hive })] }), workspace);
      await mutateHarnessRegistry(reg => ({ ...reg, projects: [...reg.projects,
        project(harnesses!.foreign, { harness_kind: 'hive' })] }), workspace + '-foreign');
      writeFileSync(join(evidence, 'portal-work-seed.json'), JSON.stringify(harnesses, null, 2));
    }
    let testingHarnesses: { selected: string; neighbor: string; foreign: string } | undefined;
    if (process.env.ROSTER_TESTING_BROWSER_PROOF === '1') {
      const { mutateHarnessRegistry } = await import('../lib/harness-registry');
      const stem = `private-testing-${process.pid}`;
      testingHarnesses = { selected: stem + '-selected', neighbor: stem + '-neighbor', foreign: stem + '-foreign' };
      const project = (role: 'selected' | 'neighbor' | 'foreign') => {
        const slug = testingHarnesses![role];
        const path = join(evidence, 'testing-harnesses', slug);
        mkdirSync(join(path, '.papercusp'), { recursive: true });
        mkdirSync(join(path, role), { recursive: true });
        writeFileSync(join(path, role, `${role}.test.ts`), '// private acceptance input; never executed\n');
        const title = role === 'selected' ? 'Selected' : role === 'neighbor' ? 'Neighbor' : 'Foreign';
        writeFileSync(join(path, '.papercusp', 'testing-domains.json'), JSON.stringify({
          domains: [{ id: `private-${role}-tests`, label: `${title} private tests`, description: `${title} scoped files`,
            tier: 'project', sections: [{ id: 'files', label: `${title} files`, globs: [`${role}/*.test.ts`] }] }],
          tierLabels: { project: `${title} private tier`, universal: 'Universal' },
        }));
        return { slug, path };
      };
      await mutateHarnessRegistry(reg => ({ ...reg, projects: [...reg.projects, project('selected'), project('neighbor')] }), workspace);
      await mutateHarnessRegistry(reg => ({ ...reg, projects: [...reg.projects, project('foreign')] }), workspace + '-foreign');
      writeFileSync(join(evidence, 'portal-testing-seed.json'), JSON.stringify(testingHarnesses, null, 2));
    }
    let insightsHarnesses: { selected: string; neighbor: string; foreign: string } | undefined;
    if (process.env.ROSTER_INSIGHTS_BROWSER_PROOF === '1') {
      const { mutateHarnessRegistry } = await import('../lib/harness-registry');
      const stem = `private-insights-${process.pid}`;
      insightsHarnesses = { selected: stem + '-selected', neighbor: stem + '-neighbor', foreign: stem + '-selected' };
      const seedRoot = join(evidence, 'insights-harnesses');
      const project = (slug: string) => {
        const path = join(seedRoot, slug);
        mkdirSync(join(path, '.papercusp'), { recursive: true });
        return { slug, path };
      };
      await mutateHarnessRegistry(reg => ({ ...reg, projects: [...reg.projects,
        project(insightsHarnesses!.selected), project(insightsHarnesses!.neighbor)] }), workspace);
      await mutateHarnessRegistry(reg => ({ ...reg, projects: [...reg.projects,
        project(insightsHarnesses!.foreign)] }), workspace + '-foreign');
      for (const [label, slug] of Object.entries(insightsHarnesses)) {
        await sql`INSERT INTO harness_shared.agent_usage_samples
          (workspace_id, harness_slug, ts, bucket_key, provider, model_class, source, session_id,
            cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
          VALUES (${label === 'foreign' ? workspace + '-foreign' : workspace}, ${slug}, ${Date.now()},
            'private-insights-fixture', 'anthropic', ${'private-' + label + '-model'}, 'private-insights-fixture',
            ${'private-' + label + '-session'}, ${label === 'selected' ? 1.25 : label === 'neighbor' ? 9 : 99}, 10, 2, 25, 5)`;
      }
      writeFileSync(join(evidence, 'portal-insights-seed.json'), JSON.stringify(insightsHarnesses, null, 2));
    }
    let settingsHarnesses: { selected: string; neighbor: string; foreign: string } | undefined;
    if (process.env.ROSTER_HARNESS_SETTINGS_BROWSER_PROOF === '1') {
      const { mutateHarnessRegistry } = await import('../lib/harness-registry');
      const { saveProjectFiles } = await import('../lib/harness-project-files');
      const { loadBlueprintFromFile } = await import('@papercusp/orchestrator/blueprint');
      const blueprint = loadBlueprintFromFile(join(root, '.papercusp/blueprint.yaml')).blueprint;
      const stem = `private-settings-${process.pid}`;
      settingsHarnesses = { selected: stem + '-selected', neighbor: stem + '-neighbor', foreign: stem + '-foreign' };
      const projects = Object.entries(settingsHarnesses).map(([label, slug]) => {
        const path = join(evidence, 'settings-harnesses', slug);
        mkdirSync(join(path, '.papercusp'), { recursive: true });
        writeFileSync(join(path, '.papercusp/blueprint.yaml'), JSON.stringify({ ...blueprint, extends: undefined,
          id: slug, params: { 'parity.enabled': { type: 'boolean', label: 'Private setting', default: false } } }));
        return { label, slug, path };
      });
      await mutateHarnessRegistry(reg => ({ ...reg, projects: [...reg.projects,
        ...projects.filter(project => project.label !== 'foreign').map(({ slug, path }) => ({ slug, path }))] }), workspace);
      await mutateHarnessRegistry(reg => ({ ...reg, projects: [...reg.projects,
        ...projects.filter(project => project.label === 'foreign').map(({ slug, path }) => ({ slug, path }))] }), foreignWorkspace);
      for (const project of projects) await saveProjectFiles(project.slug, { config: JSON.stringify({
        parity: { enabled: project.label !== 'selected' }, marker: project.label }) },
      { workspaceId: project.label === 'foreign' ? foreignWorkspace : workspace });
      writeFileSync(join(evidence, 'portal-settings-seed.json'), JSON.stringify(settingsHarnesses, null, 2));
    }
    let brainstormHarnesses: { selected: string; neighbor: string; foreign: string } | undefined;
    if (process.env.ROSTER_BRAINSTORM_BROWSER_PROOF === '1') {
      const { mutateHarnessRegistry } = await import('../lib/harness-registry');
      const stem = `private-brainstorm-${process.pid}`;
      brainstormHarnesses = { selected: stem + '-selected', neighbor: stem + '-neighbor', foreign: stem + '-foreign' };
      const seedRoot = join(evidence, 'brainstorm-harnesses');
      const project = (slug: string) => {
        const path = join(seedRoot, slug);
        mkdirSync(join(path, '.papercusp'), { recursive: true });
        return { slug, path };
      };
      await mutateHarnessRegistry(reg => ({ ...reg, projects: [...reg.projects,
        project(brainstormHarnesses!.selected), project(brainstormHarnesses!.neighbor)] }), workspace);
      await mutateHarnessRegistry(reg => ({ ...reg, projects: [...reg.projects,
        project(brainstormHarnesses!.foreign)] }), workspace + '-foreign');
      for (const [label, slug] of Object.entries(brainstormHarnesses)) {
        const scene = { elements: [], appState: {}, files: {} };
        const tree = { nodes: [{ id: 'root', type: 'mind', position: { x: 100, y: 200 },
          data: { text: `private-brainstorm-${label}-map`, kind: 'idea' } }], edges: [] };
        await sql`INSERT INTO harness_shared.harness_brainstorm
          (workspace_id, harness_slug, phase, content, canvas, mindmap, updated_at)
          VALUES (${label === 'foreign' ? workspace + '-foreign' : workspace}, ${slug}, 'staging',
            ${`private-brainstorm-${label}-text`}, ${sql.json(scene)}, ${sql.json(tree)}, ${Date.now()})`;
      }
      writeFileSync(join(evidence, 'portal-brainstorm-seed.json'), JSON.stringify(brainstormHarnesses, null, 2));
    }
    let docs: { harness: string; selectedDoc: string; neighborDoc: string; selectedHeading: string; neighborHeading: string } | undefined;
    if (process.env.ROSTER_DOCS_BROWSER_PROOF === '1') {
      const { mutateHarnessRegistry } = await import('../lib/harness-registry');
      const { anchorManualDoc } = await import('../lib/harness/docs/manual-anchor');
      const harness = `private-docs-${process.pid}`;
      // The actual committed repository supplies docs and HEAD read-only. Only
      // this disposable PG/registry owns the manual tracking records.
      await mutateHarnessRegistry(reg => ({ ...reg, projects: [...reg.projects, { slug: harness, path: root }] }), workspace);
      const prepared = await preparePrivateDocsBrowserDocuments(root);
      docs = { harness, ...prepared.selection };
      for (const docId of [docs.selectedDoc, docs.neighborDoc]) {
        const anchored = await anchorManualDoc({ harnessSlug: harness, docId, workspaceId: workspace,
          documents: ['packages/operator-core/lib/harness/docs/manual-anchor.ts'], verify: false });
        assert.equal(anchored.ok, true);
        assert.ok(anchored.ok && anchored.anchored && anchored.record.status === 'review');
        const { buildMergedDocs } = await import('../lib/harness/docs/merged-read');
        const merged = await buildMergedDocs(harness, { workspaceId: workspace, activePath: docId });
        assert.equal(merged.content, prepared.bodies[docId], 'private Docs read must return the actual configured body');
      }
      writeFileSync(join(evidence, 'portal-docs-seed.json'), JSON.stringify({ ...docs, workspace,
        readonlyRepo: root, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() }, null, 2));
    }
    const projectHistorySeed = process.env.ROSTER_PROJECT_HISTORY_BROWSER_PROOF === '1'
      ? await seedPrivateProjectHistory(workspace, evidence, root) : undefined;
    if (projectHistorySeed) await preflightPrivateProjectHistory(projectHistorySeed, base, cookie(ownSession.token), evidence);
    const calendarSeed = process.env.ROSTER_CALENDAR_BROWSER_PROOF === '1'
      ? await seedPrivateCalendar(workspace, evidence) : undefined;
    if (calendarSeed) await preflightPrivateCalendar(calendarSeed, base, cookie(ownSession.token), evidence);
    const learningSeed = process.env.ROSTER_LEARNING_BROWSER_PROOF === '1'
      ? await seedPrivateLearning(workspace, evidence) : undefined;
    if (learningSeed) await preflightPrivateLearning(learningSeed, base, cookie(ownSession.token), evidence);
    const workflowsSeed = process.env.ROSTER_WORKFLOWS_BROWSER_PROOF === '1'
      ? await seedPrivateWorkflows(workspace, evidence) : undefined;
    if (workflowsSeed) await preflightPrivateWorkflows(workflowsSeed, base, cookie(ownSession.token), evidence);
    const statsSeed = process.env.ROSTER_STATS_BROWSER_PROOF === '1'
      ? await seedPrivateStats(workspace, evidence, portalSourceRoot!) : undefined;
    if (statsSeed) await preflightPrivateStats(statsSeed, base, cookie(ownSession.token), cookie(foreignSession.token), evidence);
    const gitSeed = process.env.ROSTER_GIT_BROWSER_PROOF === '1'
      ? await seedPrivateGit(workspace, evidence, portalSourceRoot!) : undefined;
    if (gitSeed) await preflightPrivateGit(gitSeed, base, cookie(ownSession.token), cookie(foreignSession.token), evidence);
    let conversationsSeed: import('./portal-roster-browser-fixture').PrivateConversationsSeed | undefined;
    if (process.env.ROSTER_CONVERSATIONS_BROWSER_PROOF === '1') {
      const stem = `private-conversations-${process.pid}`;
      const definitions = [
        ['threads', 'conversation', 'questionsList', 'questionDetail'],
        ['deliberations', 'thread', 'deliberationList', 'deliberationDetail'],
        ['agentchats', 'chat', 'agentChatList', 'agentChatDetail'],
        ['messages', 'cmsg', 'agentMessageList', 'agentMessageDetail'],
      ] as const;
      const own: import('./portal-roster-browser-fixture').PrivateConversationRow[] = [];
      const foreignRows: import('./portal-roster-browser-fixture').PrivateConversationRow[] = [];
      for (const label of ['selected', 'neighbor', 'foreign'] as const) for (const [source, selection, list, detail] of definitions) {
        const scope = label === 'foreign' ? foreignWorkspace : workspace;
        const row = { id: `${stem}-${label}-${source}`, title: `${stem}-${label}-${source}`,
          body: `${stem}-${label}-${source}-body`, source, selection,
          list: 'conversations.' + list, detail: 'conversations.' + detail };
        const actor = 'su-aabbccdd-private-conversations';
        if (source === 'threads') await sql`INSERT INTO harness_shared.coord_conversations
          (workspace_id, id, kind, scope, asker_id, title, body)
          VALUES (${scope}, ${row.id}, 'question', 'operator', ${actor}, ${row.title}, ${row.body})`;
        if (source === 'deliberations') {
          await sql`INSERT INTO harness_shared.coord_threads
            (workspace_id, thread_id, parent_kind, parent_ref, title, created_by, post_count, last_post_at)
            VALUES (${scope}, ${row.id}, 'conversation', ${stem + '-' + label + '-threads'}, ${row.title}, ${actor}, 1, now())`;
          await sql`INSERT INTO harness_shared.coord_thread_posts (workspace_id, thread_id, author_id, body)
            VALUES (${scope}, ${row.id}, ${actor}, ${row.body})`;
        }
        if (source === 'agentchats') await sql`INSERT INTO harness_shared.agent_chats_consolidated
          (workspace_id, harness_slug, id, role, title, transcript, created_at, updated_at, archived_at)
          VALUES (${scope}, 'papercusp', ${row.id}, 'worker', ${row.title},
            ${JSON.stringify([{ role: 'assistant', content: row.body }])}::jsonb, ${Date.now()}, ${Date.now()}, ${Date.now()})`;
        if (source === 'messages') await sql`INSERT INTO harness_shared.coord_event_log
          (workspace_id, surface, msg_id, body) VALUES (${scope}, 'messages', ${row.id},
            ${JSON.stringify({ kind: 'message', from: actor, from_label: actor, to: ['su-eeff0011-private'],
              summary: row.title, body: row.body, expects: 'none' })}::jsonb)`;
        (label === 'foreign' ? foreignRows : own).push(row);
      }
      conversationsSeed = { workspace, own, foreign: foreignRows };
      writeFileSync(join(evidence, 'portal-conversations-seed.json'), JSON.stringify(conversationsSeed, null, 2));
      const reads = [];
      for (const row of own.filter(row => row.id.includes('-selected-'))) {
        const get = async (name: string, args: Record<string, unknown>) => {
          const url = new URL('/api/zero-harness/rest-query', base);
          url.searchParams.set('name', name); url.searchParams.set('args', JSON.stringify(args)); url.searchParams.set('ws', workspace);
          const response = await fetch(url, { headers: { cookie: cookie(ownSession.token) }, signal: AbortSignal.timeout(25_000) });
          const body = await response.json() as { rows?: unknown[] };
          reads.push({ name, args, status: response.status, body });
          writeFileSync(join(evidence, 'portal-conversations-preflight.json'), JSON.stringify(reads, null, 2));
          assert.equal(response.status, 200, name); assert.ok(Array.isArray(body.rows), name + ' requires rows');
          return body.rows;
        };
        const population = JSON.stringify(await get(row.list, { limit: 100 }));
        for (const expected of own.filter(value => value.source === row.source)) assert.ok(population.includes(expected.title));
        for (const excluded of foreignRows) assert.ok(!population.includes(excluded.title), 'foreign list exclusion: ' + excluded.id);
        assert.ok(JSON.stringify(await get(row.detail, { id: row.id })).includes(row.body), 'exact detail before Chrome: ' + row.id);
        const foreignRow = foreignRows.find(value => value.source === row.source)!;
        assert.deepEqual(await get(row.detail, { id: foreignRow.id }), [], 'foreign detail exclusion: ' + row.detail);
      }
      console.log('ROSTER_STOP_HTTP_PHASE conversations-api-preflight-ready');
    }
    let createDockPlans: import('./portal-roster-browser-fixture').PrivateCreateDockSeed | undefined;
    if (process.env.ROSTER_CREATE_DOCK_BROWSER_PROOF === '1') {
      const { operatorHomeHarnessSlug } = await import('../lib/harness/operator-home-harness');
      const { mutateHarnessRegistry } = await import('../lib/harness-registry');
      const { resolveHarnessPlansDir } = await import('../lib/agent-tools/plans/source');
      const harness = operatorHomeHarnessSlug();
      // Unlike the workspace-wide archive fixture, Create requests an
      // explicit harness fan-out. Its real registry eligibility is required.
      await mutateHarnessRegistry(reg => ({ ...reg, projects: [...reg.projects.filter(p => p.slug !== harness),
        { slug: harness, path: root }] }), workspace);
      assert.equal((await resolveHarnessPlansDir(harness, { workspaceId: workspace })).harnessSlug, harness);
      const stem = `private-create-dock-${process.pid}`;
      createDockPlans = { workspace, harness, selectedSlug: stem + '-selected', neighborSlug: stem + '-neighbor', foreignSlug: stem + '-foreign' };
      for (const [scope, slug] of [[workspace, createDockPlans.selectedSlug], [workspace, createDockPlans.neighborSlug],
        [foreignWorkspace, createDockPlans.foreignSlug]]) {
        const content = `---\nslug: ${slug}\ntitle: ${slug}\nstatus: draft\n---\n\n## Now\n${slug}-body\n`;
        await sql`INSERT INTO harness_shared.harness_plans
          (workspace_id, harness_slug, plan_slug, title, status, content, content_hash)
          VALUES (${scope}, ${harness}, ${slug}, ${slug}, 'draft', ${content}, ${createHash('sha256').update(content).digest('hex')})`;
      }
      writeFileSync(join(evidence, 'portal-create-dock-seed.json'), JSON.stringify(createDockPlans, null, 2));
      const url = new URL('/api/zero-harness/rest-query', base);
      url.searchParams.set('name', 'plans.list');
      url.searchParams.set('args', JSON.stringify({ includeFinished: false, includeArchived: true,
        includeLegacy: true, harness_slugs: [harness] }));
      const response = await fetch(url, { headers: { cookie: cookie(ownSession.token) }, signal: AbortSignal.timeout(25_000) });
      const body = await response.json() as { rows?: Array<{ slug: string }> };
      writeFileSync(join(evidence, 'portal-create-dock-preflight.json'), JSON.stringify({ status: response.status, body }, null, 2));
      assert.equal(response.status, 200);
      for (const slug of [createDockPlans.selectedSlug, createDockPlans.neighborSlug])
        assert.ok(body.rows?.some(row => row.slug === slug), 'Create list must expose its registered plan before browser: ' + slug);
      assert.ok(!body.rows?.some(row => row.slug === createDockPlans!.foreignSlug), 'Create preflight excludes the foreign workspace');
      console.log('ROSTER_STOP_HTTP_PHASE create-dock-api-preflight-ready');
    }
    let plans: { selectedSlug: string; neighborSlug: string; selectedTitle: string; neighborTitle: string; harness: string } | undefined;
    let overviewPlans: { selectedSlug: string; neighborSlug: string; foreignSlug: string; harness: string } | undefined;
    if (process.env.ROSTER_OVERVIEW_BROWSER_PROOF === '1') {
      const { operatorHomeHarnessSlug } = await import('../lib/harness/operator-home-harness');
      const harness = operatorHomeHarnessSlug();
      const stem = `private-overview-${process.pid}`;
      overviewPlans = { selectedSlug: stem + '-selected', neighborSlug: stem + '-neighbor', foreignSlug: stem + '-foreign', harness };
      for (const [scope, slug] of [[workspace, overviewPlans.selectedSlug], [workspace, overviewPlans.neighborSlug],
        [foreignWorkspace, overviewPlans.foreignSlug]]) {
        const content = `---\nslug: ${slug}\ntitle: ${slug}\nstatus: active\n---\n\n## Now\nPrivate Overview read canary.\n`;
        await sql`INSERT INTO harness_shared.harness_plans
          (workspace_id, harness_slug, plan_slug, title, status, op_status, content, content_hash)
          VALUES (${scope}, ${harness}, ${slug}, ${slug}, 'active', 'started', ${content}, ${createHash('sha256').update(content).digest('hex')})`;
      }
      writeFileSync(join(evidence, 'portal-overview-seed.json'), JSON.stringify({ ...overviewPlans, workspace, foreignWorkspace }, null, 2));
      // The real list read creates built-in rubric plans with newer timestamps.
      // Overview prioritizes operationally started rows, ahead of merely active
      // rows. Check that eligibility on the actual API before allocating Chrome.
      const url = new URL('/api/zero-harness/rest-query', base);
      url.searchParams.set('name', 'plans.list');
      url.searchParams.set('args', JSON.stringify({ includeFinished: false, includeArchived: true, includeLegacy: true }));
      const response = await fetch(url, { headers: { cookie: cookie(ownSession.token) }, signal: AbortSignal.timeout(25_000) });
      const body = await response.json() as { rows?: Array<{ slug: string; status: string; startStatus: string | null; updated: string | null }> };
      writeFileSync(join(evidence, 'portal-overview-preflight.json'), JSON.stringify({ status: response.status, body,
        expectation: 'selected and neighbor must be among six started-priority rows before the browser; foreign excluded' }, null, 2));
      assert.equal(response.status, 200);
      assert.ok(Array.isArray(body.rows), 'Overview preflight requires actual plan rows');
      const started = body.rows.filter(row => row.startStatus === 'started')
        .sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? '')).slice(0, 6);
      for (const slug of [overviewPlans.selectedSlug, overviewPlans.neighborSlug]) {
        assert.ok(started.some(row => row.slug === slug && row.status === 'active'),
          `Overview preflight: ${slug} is not eligible for the bounded started-priority tile`);
      }
      assert.ok(!body.rows.some(row => row.slug === overviewPlans!.foreignSlug), 'Overview API preflight must exclude foreign workspace');
      console.log('ROSTER_STOP_HTTP_PHASE overview-plan-preflight-ready');
    }
    if (process.env.ROSTER_PLANS_BROWSER_PROOF === '1') {
      const { operatorHomeHarnessSlug } = await import('../lib/harness/operator-home-harness');
      const harness = operatorHomeHarnessSlug();
      const stem = `private-plans-${process.pid}`;
      plans = { selectedSlug: stem + '-selected', neighborSlug: stem + '-neighbor',
        selectedTitle: stem + '-selected', neighborTitle: stem + '-neighbor', harness };
      const staleAt = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000).toISOString();
      // Private fixture population only: product reads and archive writes use
      // the maintained API and its normal workspace/harness resolution.
      for (const suffix of ['selected', 'neighbor']) {
        const slug = stem + '-' + suffix;
        const content = `---\nslug: ${slug}\ntitle: ${slug}\nstatus: draft\nupdated: ${staleAt}\n---\n\n## Now\nPrivate Plans archive canary.\n`;
        await sql`INSERT INTO harness_shared.harness_plans
          (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, updated, updated_at)
          VALUES (${workspace}, ${harness}, ${slug}, ${slug}, 'draft', ${content},
            ${createHash('sha256').update(content).digest('hex')}, ${staleAt}, ${staleAt})`;
      }
      writeFileSync(join(evidence, 'portal-plans-seed.json'), JSON.stringify({ ...plans, workspace, staleAt }, null, 2));
    }
    let inbox: { selectedMessageId: string; neighborMessageId: string; selectedTitle: string; neighborTitle: string } | undefined;
    if (process.env.ROSTER_INBOX_BROWSER_PROOF === '1') {
      const { sendMessage } = await import('../lib/agent-tools/coordination/messages');
      const selectedTitle = `private-inbox-${process.pid}-selected`;
      const neighborTitle = `private-inbox-${process.pid}-neighbor`;
      const seed = (owner: string, title: string) => sendMessage({ ownerId: owner, ownerLabel: owner,
        source: 'principal', workspaceId: workspace, userId: null },
      { to: ['human'], summary: title, body: title + ' body', harnessSlug: null, extra: { expects: 'none' } });
      const selectedMessage = await seed(selected, selectedTitle);
      const neighborMessage = await seed(neighbor, neighborTitle);
      const { coordMessageToAttention } = await import('../lib/attention/adapters');
      for (const message of [selectedMessage, neighborMessage]) {
        assert.equal(message.expects, 'none', 'private human inbox seed must preserve authored disposition');
        assert.equal(coordMessageToAttention({ msgId: message.msg_id, summary: String(message.summary),
          auto: message.auto === true, directToOwner: message.to.includes('human') }).tier, 'alert',
        'private inbox seed must match the actual Alerts scope before opening the browser');
      }
      inbox = { selectedMessageId: selectedMessage.msg_id, neighborMessageId: neighborMessage.msg_id, selectedTitle, neighborTitle };
      writeFileSync(join(evidence, 'portal-inbox-seed.json'), JSON.stringify(inbox, null, 2));
    }
    const { runPortalRosterBrowser } = await import('./portal-roster-browser-fixture');
    let devSeed: { selectedMarker: string; neighborMarker: string; foreignMarker: string; neighborWorkspace: string } | undefined;
    if (process.env.ROSTER_DEV_BROWSER_PROOF === '1') {
      devSeed = { selectedMarker: `private-dev-${process.pid}-selected`, neighborMarker: `private-dev-${process.pid}-neighbor`,
        foreignMarker: `private-dev-${process.pid}-foreign`, neighborWorkspace: workspace + '-neighbor' };
      for (const [scope, name] of [[workspace, devSeed.selectedMarker], [devSeed.neighborWorkspace, devSeed.neighborMarker],
        [foreignWorkspace, devSeed.foreignMarker]]) {
        await sql`INSERT INTO harness_shared.tool_invocations
          (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key, status, invoked_at)
          VALUES (${scope}, 'papercusp', 'agent-mcp', ${name}, 'operator', 'private-dev', 'run:private-dev', 'ok', now() + interval '1 hour')`;
      }
      const catalogResponse = await fetch(base + '/api/plugins/tools?stats=false');
      const catalog = await catalogResponse.json() as { tools: Array<{ name: string; inputSchema: any; expose: any }> };
      assert.equal(catalogResponse.status, 200);
      const tool = catalog.tools.find(value => value.name === 'dev:activity');
      assert.ok(tool?.inputSchema.properties.workspaceIds, 'real catalog must expose the workspaceIds schema');
      assert.equal(tool.expose.http.path, '/api/agent-tools/dev/activity');
      const observations = [];
      for (const [ids, included, excluded] of [[ [workspace], [devSeed.selectedMarker], [devSeed.neighborMarker, devSeed.foreignMarker] ],
        [ [devSeed.neighborWorkspace], [devSeed.neighborMarker], [devSeed.selectedMarker, devSeed.foreignMarker] ],
        [ null, [devSeed.selectedMarker, devSeed.neighborMarker, devSeed.foreignMarker], [] ]] as const) {
        const response: Response = await fetch(base + tool.expose.http.path + '?workspace=' + encodeURIComponent(workspace) + '&role=operator&run=private-dev&spawn=private-dev',
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceIds: ids, limit: 100 }) });
        const body = await response.json() as any;
        observations.push({ workspaceIds: ids, status: response.status, body });
        writeFileSync(join(evidence, 'portal-dev-preflight.json'), JSON.stringify({ tool, seed: devSeed, observations }, null, 2));
        assert.equal(response.status, 200, 'real activity projection must accept the public diagnostic read');
        const text = body.content?.find((block: any) => block.type === 'text')?.text;
        assert.equal(typeof text, 'string', 'real HTTP projection must contain its JSON content block');
        const data = JSON.parse(text);
        assert.ok(Array.isArray(data.entries), 'real activity response must contain entries');
        const names = data.entries.map((row: any) => row.tool_name);
        for (const name of included) assert.ok(names.includes(name), 'activity preflight must include ' + name);
        for (const name of excluded) assert.equal(names.includes(name), false, 'activity preflight must exclude ' + name);
      }
    }
    const receipt = await runPortalRosterBrowser({ evidence, base, workspace, selected, neighbor, foreign, portalSourceRoot: portalSourceRoot!,
      cookieName: SESSION_COOKIE, ownToken: ownSession.token, foreignToken: foreignSession.token,
      ...(cupboardCatalog ? { cupboard: true, cupboardSeed: cupboardCatalog } : {}),
      ...(devSeed ? { dev: true, devSeed } : {}),
      ...(process.env.ROSTER_SHORTCUT_BROWSER_PROOF === '1' ? { shortcuts: true } : {}),
      ...(process.env.ROSTER_SETTINGS_BROWSER_PROOF === '1' ? { settings: true } : {}),
      ...(process.env.ROSTER_PROMPTS_BROWSER_PROOF === '1' ? { prompts: true } : {}),
      ...(process.env.ROSTER_HUD_BROWSER_PROOF === '1' ? { hud: true } : {}),
      ...(process.env.ROSTER_HEALTH_BROWSER_PROOF === '1' ? { health: true } : {}),
      ...(overviewPlans ? { overview: true, overviewPlans } : {}),
      ...(projectHistorySeed ? { projectHistory: true, projectHistorySeed } : {}),
      ...(calendarSeed ? { calendar: true, calendarSeed } : {}),
      ...(learningSeed ? { learning: true, learningSeed } : {}),
      ...(workflowsSeed ? { workflows: true, workflowsSeed } : {}),
      ...(statsSeed ? { stats: true, statsSeed } : {}),
      ...(gitSeed ? { git: true, gitSeed } : {}),
      ...(conversationsSeed ? { conversations: true, conversationsSeed } : {}),
      ...(createDockPlans ? { createDock: true, createDockPlans } : {}),
      ...(insightsHarnesses ? { insights: true, insightsHarnesses } : {}),
      ...(testingHarnesses ? { testing: true, testingHarnesses } : {}),
      ...(settingsHarnesses ? { harnessSettings: true, settingsHarnesses } : {}),
      ...(brainstormHarnesses ? { brainstorm: true, brainstormHarnesses } : {}),
      ...(harnesses ? { harnesses } : {}),
      ...(docs ? { docs } : {}),
      ...(plans ? { plans } : {}),
      ...(inbox ? { inbox } : {}),
      ...(process.env.ROSTER_HISTORY_BROWSER_PROOF === '1' ? { history: {
        selectedSessionId: historySessions.get(selected)!.id, neighborSessionId: historySessions.get(neighbor)!.id,
        selectedRolloutId: historySessions.get(selected)!.rolloutId, neighborRolloutId: historySessions.get(neighbor)!.rolloutId,
        selectedMarker: historySessions.get(selected)!.marker, neighborMarker: historySessions.get(neighbor)!.marker,
      } } : {}),
      verifyReceipt: (value, summary, wake) => verifyReceipt(value, selected, wake, summary) });
    console.log('ROSTER_COORD_BROWSER_RECEIPT ' + JSON.stringify({ ...receipt, health,
      apiBundleSha256: createHash('sha256').update(readFileSync(apiBundle)).digest('hex') }));
    return;
  }
  for (const wake of [false, true]) {
    const accepted = await post([selected], wake);
    receipts.push(accepted);
    const msgId = await verifyReceipt(accepted, selected, wake);
    // Positive control: a successful response attributed to the neighbor must fail.
    await assert.rejects(() => verifyReceipt(accepted, neighbor, wake), /selected-recipient receipt correlation/);
    const inbox = await readInbox(selected, {}, { enough: entries => entries.length >= 20 });
    assert.ok(inbox.some(message => message.msg_id === msgId), 'selected inbox must contain the returned message');
  }
  const selectedIds = receipts.map(receipt => receipt.body.results[0].msg_id);
  assert.equal(new Set(selectedIds).size, 2);
  const beforeDenials = (await readInbox(selected, {}, { enough: entries => entries.length >= 20 })).filter(message => message.summary === marker).map(message => message.msg_id).sort();
  const denied = [
    await post([foreign]), await post([selected, foreign]), await post([stale]),
    await post([selected], false, { cookie: cookie(foreignSession.token), 'x-papercusp-workspace': workspace }),
    await post([selected], false, { origin: 'https://unapproved.invalid' }),
  ];
  assert.deepEqual(denied.map(receipt => receipt.status), [403, 403, 403, 403, 403]);
  const afterDenials = (await readInbox(selected, {}, { enough: entries => entries.length >= 20 })).filter(message => message.summary === marker).map(message => message.msg_id).sort();
  assert.deepEqual(afterDenials, beforeDenials, 'denied requests must not persist a partial delivery');
  for (const owner of [neighbor, foreign, stale]) {
    assert.equal((await readInbox(owner, {}, { enough: entries => entries.length >= 20 })).some(message => message.summary === marker), false,
      `${owner} must not receive the private marker`);
  }
  // Tokens are deliberately absent from retained evidence.
  console.log('ROSTER_COORD_HTTP_RECEIPT ' + JSON.stringify({ workspace, health,
    bundleSha256: createHash('sha256').update(readFileSync(apiBundle)).digest('hex'),
    authenticatedUser: ownPrincipal?.id, authMethod: 'cookie-session', selected, neighbor, foreign, stale,
    selectedMessageIds: selectedIds, receipts, denialStatuses: denied.map(receipt => receipt.status),
    neighborIsolated: true, positiveControl: 'wrong-recipient rejected',
    pickupScope: 'persisted message and synchronous wake receipt only; no parked-agent turn attested' }));
}

async function main() {
  if (healthCleanupProof) {
    const prepared = preparePrivateHttpWorkspaces();
    assert.equal(prepared.workspace, workspace);
    assert.equal(process.env.ROSTER_HEALTH_BROWSER_PROOF, '1');
    assert.equal(process.env.ROSTER_COORD_BROWSER_PROOF, '1');
    await coordCanary({ cleanupProof: true });
    return;
  }
  if (process.env.ROSTER_CUPBOARD_BROWSER_PROOF === '1') {
    cupboardCatalog = await startPrivateCupboardCatalog(evidence);
    process.env.PAPERCUSP_CUPBOARD_URL = cupboardCatalog.base;
  }
  if (process.env.ROSTER_INBOX_BROWSER_PROOF === '1') {
    inboxInvalidationListener = await sql.listen('sync_invalidate', payload => {
      const event = JSON.parse(payload);
      if (event.name !== 'harness_shared.coord_event_log.changed') return;
      inboxInvalidations.push({ at: new Date().toISOString(), name: event.name, args: event.args });
      writeFileSync(join(evidence, 'portal-inbox-invalidations.json'), JSON.stringify(inboxInvalidations, null, 2));
    });
  }
  if (process.env.ROSTER_COORD_BROWSER_PROOF === '1' || process.env.ROSTER_STOP_BROWSER_PROOF === '1') {
    // Use the existing static-serving seam on this private API origin. No
    // cross-origin transport, API response interception or local-mode identity.
    process.env.PAPERCUSP_SPA_DIST = join(evidence, 'portal-roster-spa');
  }
  if (process.env.ROSTER_COORD_HTTP_PROOF === '1' || process.env.ROSTER_STOP_BROWSER_PROOF === '1') {
    const prepared = preparePrivateHttpWorkspaces();
    assert.equal(prepared.workspace, workspace);
    console.log('ROSTER_STOP_HTTP_PHASE registry-ready');
  }
  const bundle = apiBundle;
  if (preparedApiBundle) console.log('ROSTER_STOP_HTTP_PHASE bundle-prepared');
  else {
    console.log('ROSTER_STOP_HTTP_PHASE bundle-start');
    const built = await buildPrivateOperatorApiBundle(root, evidence, { timeoutMs: 240_000, maxMs: 420_000 });
    assert.equal(built.path, bundle);
  }
  const log = (chunk: Buffer) => process.stdout.write(chunk);
  api = spawn(process.execPath, [bundle], { cwd: root, env: privateBundleRuntimeEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
  api.stdout!.on('data', log); api.stderr!.on('data', log);
  let health: any;
  await until(async () => {
    assert.equal(api!.exitCode, null, 'private API exited');
    try { const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(1_000) });
      if (response.ok) { health = await response.json(); return health.service === 'papercusp-operator'; } }
    catch { /* bounded boot convergence only */ }
    return false;
  }, 'private API readiness', 90_000);
  console.log('ROSTER_STOP_HTTP_PHASE request-ready');
  if (process.env.ROSTER_COORD_HTTP_PROOF === '1') {
    await coordCanary(health);
    return;
  }
  const selected = await child('selected');
  const neighbor = await child('neighbor');
  if (process.env.ROSTER_STOP_BROWSER_PROOF === '1') {
    const { signup, login, getSessionUser, SESSION_COOKIE } = await import('../lib/auth');
    const username = `stop_${process.pid}`;
    await signup(username, 'Private confirmed stop canary', null);
    const ownSession = await login(username, null, { workspace_id: workspace });
    const foreignSession = await login(username, null, { workspace_id: workspace + '-foreign' });
    assert.equal((await getSessionUser(new Headers({ cookie: `${SESSION_COOKIE}=${ownSession.token}` })))?.workspace_id, workspace);
    const { runPortalRosterBrowser } = await import('./portal-roster-browser-fixture');
    let aliveProbe = 0;
    let neighborProbe = 0;
    const receipt = await runPortalRosterBrowser({ evidence, base, workspace, selected: selected.owner, neighbor: neighbor.owner,
      portalSourceRoot: portalSourceRoot!, cookieName: SESSION_COOKIE, ownToken: ownSession.token, foreignToken: foreignSession.token,
      stop: { selected, neighbor,
        assertChildrenAlive: async () => {
          aliveProbe++;
          await responds(selected, `selected-before-confirmed-stop-${aliveProbe}`);
          await responds(neighbor, `neighbor-before-confirmed-stop-${aliveProbe}`);
          await Promise.all([quiet(selected), quiet(neighbor)]);
        },
        assertSelectedStopped: async () => {
          await until(() => selected.closed, 'browser selected child stopped');
          await selected.done; await Promise.all(endings);
          assert.ok((await getAdvSessionInWorkspace(selected.id, workspace))?.endedAt);
          assert.equal(existsSync(socketPathFor(selected.owner)), false);
          await responds(neighbor, 'neighbor-after-browser-selected-stop');
        },
        assertNeighborAlive: async () => {
          await responds(neighbor, `neighbor-after-browser-control-${++neighborProbe}`);
          await quiet(neighbor);
        },
        invalidateNeighborLaunch: async () => {
          await sql`UPDATE harness_shared.adv_sessions SET started_at = started_at + interval '1 second' WHERE id = ${neighbor.id}`;
          assert.notEqual((await getAdvSessionInWorkspace(neighbor.id, workspace))?.startedAt, neighbor.startedAt);
        },
      } });
    console.log('ROSTER_STOP_BROWSER_RECEIPT ' + JSON.stringify({ ...receipt, health,
      apiBundleSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex') }));
    return;
  }
  const valid = { ownerId: selected.owner, managedSessionId: selected.id, expectedStartedAt: selected.startedAt, confirmed: true };
  const foreignId = await recordAdvSession({ workspaceId: workspace + '-foreign', mode: 'console', agent: 'codex', coordOwnerId: 'su-private-foreign' });
  assert.ok(foreignId);
  const denied = [
    await request({ ...valid, confirmed: false }),
    await request({ ...valid, managedSessionId: neighbor.id }),
    await request({ ...valid, ownerId: 'su-private-foreign', managedSessionId: foreignId }),
    await request({ ...valid, pid: process.pid }),
    await request({ ...valid, expectedStartedAt: '2000-01-01T00:00:00.000Z' }),
  ];
  assert.deepEqual(denied.map(value => value.status), [400, 403, 403, 400, 403]);
  await responds(selected, 'selected-after-denials');
  await responds(neighbor, 'neighbor-after-denials');
  // Reactivation can reuse a row id. Replay must fail against changed launch time.
  await sql`UPDATE harness_shared.adv_sessions SET started_at = started_at + interval '1 second' WHERE id = ${neighbor.id}`;
  const replay = await request({ ownerId: neighbor.owner, managedSessionId: neighbor.id,
    expectedStartedAt: neighbor.startedAt, confirmed: true });
  assert.equal(replay.status, 403);
  await responds(neighbor, 'neighbor-after-reactivation-replay');
  const currentNeighbor = await getAdvSessionInWorkspace(neighbor.id, workspace);
  assert.ok(currentNeighbor);
  // ECHO output must settle before exercising the existing supported idle stop.
  await Promise.all([quiet(selected), quiet(neighbor)]);
  const misroute = process.env.ROSTER_STOP_HTTP_MUTATION === 'misroute';
  const accepted = await request(misroute ? { ownerId: neighbor.owner, managedSessionId: neighbor.id,
    expectedStartedAt: currentNeighbor.startedAt, confirmed: true } : valid);
  assert.equal(accepted.status, 200, JSON.stringify(accepted));
  assert.equal(accepted.body.managedSessionId, selected.id, 'selected-session receipt correlation');
  await until(() => selected.closed, 'selected child stopped');
  await selected.done;
  await Promise.all(endings);
  assert.ok((await getAdvSessionInWorkspace(selected.id, workspace))?.endedAt);
  assert.equal(existsSync(socketPathFor(selected.owner)), false);
  await responds(neighbor, 'neighbor-after-selected-stop');
  console.log('ROSTER_STOP_HTTP_RECEIPT ' + JSON.stringify({ workspace, health,
    bundleSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'),
    selected: { owner: selected.owner, id: selected.id, ended: selected.closed },
    neighbor: { owner: neighbor.owner, id: neighbor.id, alive: !neighbor.closed }, denied, replay, accepted }));
}

try { await main(); }
catch (error: any) { console.error('ROSTER_STOP_HTTP_FAILURE ' + JSON.stringify({ message: error.message, stack: error.stack })); process.exitCode = 1; }
finally {
  const failures: unknown[] = [];
  const cleanupPhase = async (stage: string, run: () => Promise<unknown>) => {
    const started = Date.now();
    const record = (status: string, error?: unknown) => {
      const row = { stage, status, elapsedMs: Date.now() - started,
        ...(error ? { error: String(error) } : {}) };
      appendFileSync(join(evidence, 'roster-stop-cleanup.jsonl'), JSON.stringify(row) + '\n');
      console.log('ROSTER_STOP_HTTP_CLEANUP_PHASE ' + JSON.stringify(row));
      if (stage === 'native-shutdown' || stage === 'native-exit') retainNativeState(`${stage}:${status}`);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    record('start');
    try {
      await Promise.race([run(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Private roster cleanup stalled: ${stage}`)), 15_000);
      })]);
      record('complete');
    } catch (error) { failures.push(error); record('failed', error); }
    finally { clearTimeout(timer); }
  };
  // Retain the first stuck stage and continue releasing the other private
  // resources. A supervisor timeout must not erase which cleanup await stalled.
  await cleanupPhase('native-shutdown', async () => {
    for (const session of sessions) if (!session.closed)
      assert.equal(await shutdownViaPty(session.owner, { reason: 'Private acceptance cleanup', force: true }), 'sent');
  });
  await cleanupPhase('native-exit', () => Promise.all(sessions.map(session => session.done)));
  await cleanupPhase('session-end-records', () => Promise.all(endings));
  await cleanupPhase('api-stop', async () => { if (api) await stopPrivateOperatorHost(api); });
  await cleanupPhase('listeners-stop', async () => {
    await inboxInvalidationListener?.unlisten();
    await cupboardCatalog?.close();
  });
  // Auth capability reads lazily start a process-wide PG LISTEN subscription.
  // Close that subscription before retiring the shared db-org pools; otherwise
  // the browser proof's assertions pass but this worker remains pinned until the
  // outer execute deadline and is SIGTERM'd instead of returning its verdict.
  await cleanupPhase('auth-invalidation-listener-stop', async () => {
    const { _stopInvalidationListenerForTests } = await import('@papercusp/agent-mcp/auth');
    await _stopInvalidationListenerForTests();
  });
  let pgConnections: Array<{ client_port: number; application_name: string; datname: string; state: string }> = [];
  await cleanupPhase('database-census', async () => {
    // The broad import graph can also open a pool on another database in this
    // disposable cluster. A current_database() filter hides that pool's owner.
    pgConnections = await sql`SELECT client_port, application_name, datname, state
      FROM pg_stat_activity WHERE client_port IS NOT NULL`;
  });
  // This disposable worker owns every hub subscription in its process. Retire
  // them after the census has retained their labels, including subscriptions
  // started by collector reads after the initial auth listener was installed.
  await cleanupPhase('listen-hub-stop', async () => {
    const { _stopHubForTests } = await import('../lib/pg-listen-hub');
    await _stopHubForTests();
  });
  // Locks owns separate transaction/LISTEN pools on papercusp_su. Closing
  // db-org cannot retire them; the acknowledgement path opens the tx pool.
  // Stop subscription producers before retiring the pools they can reopen.
  await cleanupPhase('lock-listeners-stop', async () => {
    const { _resetListenersForTests } = await import('@papercusp/locks');
    await _resetListenersForTests();
  });
  await cleanupPhase('lock-pools-reset', async () => {
    const { _resetForTests: resetLockPools } = await import('@papercusp/locks');
    await resetLockPools();
  });
  await cleanupPhase('database-close', () => sql.end({ timeout: 5 }));
  await cleanupPhase('db-org-pools-reset', () => _resetForTests());
  await cleanupPhase('database-resources-closed', async () => {
    await new Promise<void>(done => setImmediate(done));
    const report = process.report!.getReport() as { libuv?: Array<Record<string, unknown>> };
    const sockets = (report.libuv ?? []).filter(handle => handle.type === 'tcp').map(handle => {
      const local = handle.localEndpoint as { port?: number } | undefined;
      const origin = socketOrigins.get(local?.port ?? 0);
      const socket = origin?.socket;
      return { active: handle.is_active, referenced: handle.is_referenced, closing: handle.is_closing,
        local, remote: handle.remoteEndpoint,
        creationStack: origin?.stack ?? null,
        // Byte counts distinguish a cancellation-only connection from an
        // authenticated pool connection without retaining protocol contents.
        socketState: socket ? { readyState: socket.readyState, connecting: socket.connecting,
          pending: socket.pending, destroyed: socket.destroyed, writableEnded: socket.writableEnded,
          bytesRead: socket.bytesRead, bytesWritten: socket.bytesWritten,
          createdAt: origin!.createdAt, connectedAt: origin!.connectedAt } : null,
        startupIdentity: socket ? socketStartups.get(socket) ?? null : null,
        socketClass: socket?.constructor.name ?? null,
        closureCalls: socket ? socketClosures.get(socket) ?? null : null,
        pgConnection: pgConnections.find(row => row.client_port === local?.port) ?? null };
    });
    const retained = sockets.filter(socket => socket.referenced &&
      (socket.remote as { port?: number } | undefined)?.port === Number(process.env.PAPERCUSP_PG_PORT));
    const activeResources = process.getActiveResourcesInfo();
    writeFileSync(join(evidence, 'roster-stop-resources.json'), JSON.stringify({
      activeResources, pgConnections, sockets, retained }, null, 2));
    assert.equal(retained.length, 0, 'private PG sockets remain after roster worker cleanup; see roster-stop-resources.json');
    // Node reports a referenced fs.watch handle as FSEventWrap, rather than
    // the public FSWatcher class name. Such a handle alone pins this worker.
    assert.equal(activeResources.some(type => type === 'FSEventWrap' || type === 'FSWatcher'), false,
      'file watchers remain referenced after roster worker cleanup; see roster-stop-resources.json');
  });
  net.Socket.prototype.connect = originalConnect;
  net.Socket.prototype.write = originalWrite;
  net.Socket.prototype.end = originalEnd;
  net.Socket.prototype.destroy = originalDestroy;
  retainNativeState('before-discovery-removal');
  if (sessions.every(session => session.closed)) rmSync(discovery, { recursive: true });
  console.log('ROSTER_STOP_HTTP_CLEANUP ' + JSON.stringify({ childrenStopped: sessions.every(session => session.closed), apiStopped: !api || api.exitCode !== null || api.signalCode !== null }));
  if (failures.length) throw new AggregateError(failures, 'Private roster cleanup failed');
}
