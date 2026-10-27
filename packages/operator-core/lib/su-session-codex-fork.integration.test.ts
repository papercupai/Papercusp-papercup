/** Installed Codex, isolated homes and a loopback provider. No provider inference. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { stringify } from '@iarna/toml';
import { afterEach, expect, it, vi } from 'vitest';
import { codexCliResponsesBody, codexCliResponsesCompletionSse } from './inference-gateway/codex-cli-bridge';
import { forkCodexNativeHistory, prepareCodexForkHistory, type PreparedCodexForkHistory } from './su-session-codex-fork';
import { startSuStdioPeer, type RpcFrame, type SuStdioPeer } from './su-session-stdio-peer';
import { createCodexSuSessionAdapter } from './su-session-codex-adapter';

vi.mock('./su-session-persistence', () => ({ bindSuSessionToAdvSession: vi.fn(async () => ({ status: 'bound' })), persistSuSessionDescriptor: vi.fn(async () => true) }));

const processes = vi.hoisted(() => new Map<string, ChildProcess>());
vi.mock('./task-manager/managed-spawn', () => ({ managedSpawn: async (bin: string, args: string[], _spec: unknown,
  options: { spawnOptions: object }) => {
  const child = spawn(bin, args, options.spawnOptions), taskId = randomUUID(); processes.set(taskId, child); return { child, taskId };
} }));
vi.mock('./task-manager/control', () => ({ killTask: async (id: string) => { processes.get(id)?.kill('SIGKILL'); return { ok: true }; } }));
vi.mock('../../../apps/operator/scripts/psu-launcher.mjs', () => ({ startSupervisorBeat: vi.fn() }));
const peers: SuStdioPeer[] = [], homes: string[] = [];
afterEach(async () => {
  for (const p of peers.splice(0)) { await p.close(); await p.done; }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  expect([...processes.values()].every(p => p.exitCode !== null || p.signalCode !== null)).toBe(true); processes.clear();
});

it.each(['complete', 'incomplete'] as const)('transfers %s paginated history across homes and preserves parent isolation', async mode => {
  const bodies: RpcFrame[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(codexCliResponsesCompletionSse(codexCliResponsesBody({ model: 'gpt-6-sol', text: 'ACK', inputTokens: 20, outputTokens: 1 })));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local fixture port');
  const config = stringify({ model_provider: 'local_fork', model: 'gpt-6-sol',
    model_providers: { local_fork: { name: 'Local fork fixture', base_url: `http://127.0.0.1:${address.port}/v1`,
      wire_api: 'responses', requires_openai_auth: false, supports_websockets: false, request_max_retries: 0 } },
    features: { apps: false, shell_tool: false }, web_search: 'disabled' });
  async function open(home?: string, beforeStart?: (home: string) => Promise<void>) {
    home ??= mkdtempSync(join(tmpdir(), 'su-native-fork-')); if (!homes.includes(home)) homes.push(home);
    writeFileSync(join(home, 'config.toml'), config);
    await beforeStart?.(home);
    const events: RpcFrame[] = [];
    const peer = await startSuStdioPeer({ binary: 'codex', args: ['app-server'], cwd: home,
      env: { PATH: process.env.PATH, CODEX_HOME: home }, workspaceId: 'fork-fixture', ownerId: randomUUID(),
      spec: { class: 'test', title: 'Tracked native fork', launchedBy: 'vitest', argv: ['codex', 'app-server'] }, onMessage: f => events.push(f) });
    peers.push(peer);
    await peer.request({ method: 'initialize', params: { clientInfo: { name: 'papercusp_fork_test', version: '1' } } });
    peer.send({ method: 'initialized', params: {} }); return { peer, home, events };
  }
  async function turn(p: Awaited<ReturnType<typeof open>>, threadId: string, text: string) {
    const result = await p.peer.request({ method: 'turn/start', params: { threadId, input: [{ type: 'text', text }] } });
    const id = (result.turn as RpcFrame).id;
    await vi.waitFor(() => expect(p.events).toContainEqual(expect.objectContaining({ method: 'turn/completed',
      params: expect.objectContaining({ threadId, turn: expect.objectContaining({ id, status: 'completed' }) }) })), { timeout: 20_000 });
  }
  async function visible(p: Awaited<ReturnType<typeof open>>, id: string, path: string) {
    const adapter = createCodexSuSessionAdapter({ operation: 'created', backend: 'codex', advSessionId: 17,
      ownerId: 'su-child', workspaceId: 'fork-fixture', harnessSlug: null, planSlug: null, nativeSession: null }, {
      nativeSession: { backend: 'codex', source: 'adv_sessions', ownerId: 'su-child', codexHome: p.home,
        rolloutId: id, exactResumeSupported: true, missingReason: null }, rolloutPath: path,
    }, { agentChatId: 'fork-visible-history', register: false, ready: false, runtimeReady: () => false, executionKind: 'programmatic' });
    try {
      expect(adapter.host.snapshot().streamReady).toBe(false);
      // The initial snapshot must not show the child's local messages before
      // the inherited prefix. Native history is the authoritative ordered view.
      await adapter.consumeRolloutSnapshot({ preserveLifecycle: true, deferForkHistory: true });
      expect(adapter.host.recent.some(({ event }) => event.type === 'transcript')).toBe(false);
      await adapter.consumeThreadHistory(frame => p.peer.request(frame));
      const transcript = adapter.host.recent.filter(({ event }) => event.type === 'transcript');
      const count = transcript.length;
      await adapter.consumeThreadHistory(frame => p.peer.request(frame));
      expect(adapter.host.recent.filter(({ event }) => event.type === 'transcript')).toHaveLength(count);
      expect(adapter.host.snapshot().streamReady).toBe(false);
      return transcript.map(({ event }) => 'content' in event ? event.content : '').filter(Boolean).join('\n');
    } finally { adapter.dispose(); }
  }
  try {
    const parent = await open();
    const start = await parent.peer.request({ method: 'thread/start', params: { cwd: parent.home, approvalPolicy: 'never', sandbox: 'read-only' } });
    const parentId = String((start.thread as RpcFrame).id);
    await turn(parent, parentId, 'PARENT_HISTORY_MARKER');
    const read = await parent.peer.request({ method: 'thread/read', params: { threadId: parentId, includeTurns: true } });
    const sourcePath = String((read.thread as RpcFrame).path), before = readFileSync(sourcePath);
    expect((read.thread as RpcFrame).historyMode).toBe('paginated');
    let sourceHome = parent.home;
    if (mode === 'incomplete') {
      sourceHome = mkdtempSync(join(tmpdir(), 'su-incomplete-fork-')); homes.push(sourceHome);
      const dest = join(sourceHome, relative(parent.home, sourcePath));
      mkdirSync(dirname(dest), { recursive: true }); copyFileSync(sourcePath, dest);
    }
    const source = { backend: 'codex' as const, source: 'adv_sessions' as const, ownerId: 'su-parent', codexHome: sourceHome,
      rolloutId: parentId, exactResumeSupported: true, missingReason: null };
    let prepared: PreparedCodexForkHistory | undefined;
    const child = await open(undefined, async home => {
      prepared = await prepareCodexForkHistory({ source, childOwnerId: 'su-child', childHome: home });
    });
    const fork = forkCodexNativeHistory({ peer: child.peer, source, prepared,
      childOwnerId: 'su-child', childHome: child.home,
      params: { cwd: parent.home, approvalPolicy: 'never', sandbox: 'read-only' } });
    if (mode === 'incomplete') {
      await expect(fork).rejects.toThrow('Codex fork has no completed parent turn boundary');
      expect(bodies).toHaveLength(1);
    } else {
      const result = await fork, childId = String((result.thread as RpcFrame).id);
      expect(childId).not.toBe(parentId);
      expect((result.thread as RpcFrame).forkedFromId).toBe(parentId);
      expect(await visible(child, childId, String((result.thread as RpcFrame).path))).toContain('PARENT_HISTORY_MARKER');
      expect(readFileSync(sourcePath)).toEqual(before);
      await turn(child, childId, 'CHILD_ONLY_MARKER');
      expect(JSON.stringify(bodies[1])).toContain('PARENT_HISTORY_MARKER');
      expect(JSON.stringify(bodies[1])).toContain('CHILD_ONLY_MARKER');
      await turn(parent, parentId, 'PARENT_ONLY_MARKER');
      expect(JSON.stringify(bodies[2])).not.toContain('CHILD_ONLY_MARKER');
      await child.peer.close(); await child.peer.done;
      const restarted = await open(child.home);
      await restarted.peer.request({ method: 'thread/resume', params: { threadId: childId } });
      await turn(restarted, childId, 'CHILD_AFTER_RESTART');
      expect(JSON.stringify(bodies[3])).toContain('PARENT_HISTORY_MARKER');
      expect(JSON.stringify(bodies[3])).toContain('CHILD_ONLY_MARKER');
      expect(JSON.stringify(bodies[3])).not.toContain('PARENT_ONLY_MARKER');
      let descendantHistory: PreparedCodexForkHistory | undefined;
      const descendantSource = { ...source, ownerId: 'su-child', codexHome: child.home, rolloutId: childId };
      const descendant = await open(undefined, async home => {
        descendantHistory = await prepareCodexForkHistory({ source: descendantSource, childOwnerId: 'su-grandchild', childHome: home });
      });
      const descendantResult = await forkCodexNativeHistory({ peer: descendant.peer, source: descendantSource,
        prepared: descendantHistory, childOwnerId: 'su-grandchild', childHome: descendant.home,
        params: { cwd: parent.home, approvalPolicy: 'never', sandbox: 'read-only' } });
      await turn(descendant, String((descendantResult.thread as RpcFrame).id), 'GRANDCHILD_ONLY_MARKER');
      const restored = await visible(descendant, String((descendantResult.thread as RpcFrame).id), String((descendantResult.thread as RpcFrame).path));
      expect(restored).toContain('PARENT_HISTORY_MARKER');
      expect(restored).toContain('CHILD_ONLY_MARKER');
      expect(restored).toContain('CHILD_AFTER_RESTART');
      expect(restored).toContain('GRANDCHILD_ONLY_MARKER');
      expect(restored).not.toContain('PARENT_ONLY_MARKER');
      expect(restored.indexOf('PARENT_HISTORY_MARKER')).toBeLessThan(restored.indexOf('CHILD_ONLY_MARKER'));
      expect(restored.indexOf('CHILD_ONLY_MARKER')).toBeLessThan(restored.indexOf('CHILD_AFTER_RESTART'));
      expect(JSON.stringify(bodies[4])).toContain('PARENT_HISTORY_MARKER');
      expect(JSON.stringify(bodies[4])).toContain('CHILD_ONLY_MARKER');
      expect(JSON.stringify(bodies[4])).toContain('CHILD_AFTER_RESTART');
      expect(JSON.stringify(bodies[4])).not.toContain('PARENT_ONLY_MARKER');
      expect(readFileSync(join(child.home, 'config.toml'), 'utf8')).toBe(config);
      expect(readdirSync(child.home)).not.toContain('parent-only-lock');
    }
    if (mode === 'incomplete') expect(readFileSync(sourcePath)).toEqual(before);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
}, 90_000);
