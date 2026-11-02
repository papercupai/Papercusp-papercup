/** Real engine + adapter + host + correlated stdio requests against a scripted
 * child. Only launch/persistence/enrollment dependencies are substituted.
 * This observes the protocol boundary, not provider inference or shipment. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SU_SESSION_PROTOCOL_VERSION, SU_SESSION_SCHEMA } from '@papercusp/chat-protocol';
import { resolveCardResponse } from '@papercusp/agent-mcp';
import type { BootstrapSuResult } from './endpoint-route/routes/agent-mcp/bootstrap-su';
import type { PuiSuSessionBinding } from './launch-agent';
import type { SuStdioPeer, RpcFrame } from './su-session-stdio-peer';

const processState = vi.hoisted(() => ({ children: new Map<string, ChildProcess>() }));
vi.mock('./task-manager/managed-spawn', () => ({ managedSpawn: async (binary: string, args: string[], _spec: unknown,
  options: { spawnOptions: object }) => {
  const child = spawn(binary, args, options.spawnOptions), taskId = randomUUID();
  processState.children.set(taskId, child); return { child, taskId };
} }));
vi.mock('./task-manager/control', () => ({ killTask: async (id: string) => {
  processState.children.get(id)?.kill('SIGKILL'); return { ok: true };
} }));
vi.mock('./task-manager/store', async original => ({
  ...(await original<typeof import('./task-manager/store')>()),
  bindLiveAgentSessionTasksToNativeSession: async (input: { initialTaskId?: string }) =>
    input.initialTaskId && processState.children.has(input.initialTaskId) ? [input.initialTaskId] : [],
}));
vi.mock('./su-session-persistence', () => ({
  bindSuSessionToAdvSession: vi.fn(async () => ({ status: 'bound' })),
  persistSuSessionDescriptor: vi.fn(async () => true),
}));
vi.mock('./su-session-commands', async original => ({
  ...(await original<typeof import('./su-session-commands')>()), loadSuOwnerTurnReceipts: vi.fn(async () => []),
}));
vi.mock('../../../apps/operator/scripts/psu-launcher.mjs', async original => ({
  ...(await original<typeof import('../../../apps/operator/scripts/psu-launcher.mjs')>()),
  assertLaunchPersona: vi.fn(), startSupervisorBeat: vi.fn(),
  prepareSuLaunch: (boot: BootstrapSuResult) => ({ env: { ...boot.envelopeEnv }, args: [], modelArgs: [], model: 'codex-model' }),
}));
import { startSuStdioPeer } from './su-session-stdio-peer';
import { startSuRpcEngine, type SuRpcEngine } from './su-session-rpc-engine';

const engines: SuRpcEngine[] = [], dirs: string[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) { await engine.close(); await engine.done; engine.adapter.dispose(); }
  expect([...processState.children.values()].every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  processState.children.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function engineFixture(mode = 'normal') {
  const dir = mkdtempSync(join(tmpdir(), 'su-codex-steer-')); dirs.push(dir);
  const script = join(dir, 'app-server.mjs'), rollout = join(dir, 'rollout.jsonl');
  writeFileSync(rollout, '');
  writeFileSync(script, String.raw`
    import { createInterface } from 'node:readline';
    const send = value => process.stdout.write(JSON.stringify(value) + '\n');
    const calls = []; let active = '', serial = 0, pending;
    const complete = status => {
      if (active) send({ method: 'turn/completed', params: {
        threadId: 'native-thread', turn: { id: active, status },
      } });
      active = '';
    };
    createInterface({ input: process.stdin }).on('line', line => {
      const call = JSON.parse(line), p = call.params || {};
      if (call.id == null) return;
      calls.push(call); const reply = result => send({ id: call.id, result });
      if (!call.method) return;
      if (call.method === 'thread/start') reply({
        thread: { id: 'native-thread', cwd: process.cwd(), path: process.env.FIXTURE_ROLLOUT }, model: 'codex-model',
      });
      else if (call.method === 'mcpServerStatus/list') reply({ data: [{ name: 'papercusp-su', tools: { 'coord:orient': {} } }] });
      else if (call.method === 'model/list') reply({ data: [] });
      else if (call.method === 'turn/start') {
        if (active) throw new Error('turn/start must never substitute for steer');
        active = 'native-' + ++serial;
        reply({ turn: { id: active } });
        send({ method: 'turn/started', params: { threadId: 'native-thread', turn: { id: active } } });
      } else if (call.method === 'turn/steer') {
        if (!active || p.expectedTurnId !== active || process.env.FIXTURE_MODE === 'refuse') {
          send({ id: call.id, error: { code: -32602, message: 'No matching steerable turn' } }); return;
        }
        const turnId = active;
        if (process.env.FIXTURE_MODE === 'finish-before-ack') complete('completed');
        if (process.env.FIXTURE_MODE === 'interrupt-before-ack') complete('interrupted');
        reply({ turnId });
      } else if (call.method === 'turn/interrupt') {
        if (p.turnId !== active) throw new Error('interrupt must target its captured native turn');
        complete('interrupted');
        if (process.env.FIXTURE_MODE === 'hold-interrupt') pending = call.id;
        else reply({});
      } else if (call.method === 'fixture/complete') { complete('completed'); reply({}); }
      else if (call.method === 'fixture/server-request') { send(p.frame); reply({}); }
      else if (call.method === 'fixture/release') { send({ id: pending, result: {} }); pending = undefined; reply({}); }
      else if (call.method === 'fixture/history') reply({ calls });
      else reply({});
    });
  `);
  const binding = { operation: 'created', backend: 'codex', advSessionId: 71, ownerId: 'su-steer-integration',
    workspaceId: 'workspace', harnessSlug: 'project', planSlug: 'plan', nativeSession: null } as PuiSuSessionBinding & { backend: 'codex' };
  const boot: BootstrapSuResult = { status: 'ok', agent: 'codex', sessionId: 71, cwd: dir, promptFile: '/sealed/su.md',
    specificationRevision: 'fixture-spec', stateRevision: 'fixture-state', compositionSource: 'blueprint',
    codexHome: dir, coordExtPath: null, nativeSessionId: null,
    workspaceId: 'workspace', harnessSlug: 'project', planSlug: 'plan', envelopeEnv: {
      PAPERCUSP_SID: binding.ownerId!, CODEX_HOME: dir, FIXTURE_MODE: mode, FIXTURE_ROLLOUT: rollout,
    } };
  let peer!: SuStdioPeer;
  const engine = startSuRpcEngine(boot, binding, { agentChatId: 'chat-codex-steer', model: 'codex-model',
    register: false, startupTimeoutMs: 10_000, deliveryTimeoutMs: 5_000, servedAccountReader: async () => null,
    turnLifecycle: { admit: async () => ({ ok: true, bindNativeTurn: async () => {}, complete: async () => {}, reconcile: async () => {} }) },
    peerFactory: async options => {
      peer = await startSuStdioPeer({ ...options, binary: process.execPath, args: [script] }); return peer;
    },
  });
  engines.push(engine); await engine.ready;
  const host = engine.adapter.host;
  const command = (type: 'owner_turn' | 'queue' | 'steer' | 'interrupt', id: string, activeTurnId = 'owner-first') => ({
    schema: SU_SESSION_SCHEMA, protocolVersion: SU_SESSION_PROTOCOL_VERSION, issuedAt: new Date().toISOString(),
    target: host.descriptor().identity, commandId: id, type, turnId: `owner-${id}`, content: `Input ${id}`, activeTurnId,
  });
  const history = async () => (await peer.request({ method: 'fixture/history' })).calls as RpcFrame[];
  return { engine, host, command, history, dir,
    request: (method: string, params?: RpcFrame) => peer.request({ method, ...(params ? { params } : {}) }) };
}

describe('Codex steering through real stdio', () => {
  it.each(['account/chatgptAuthTokens/refresh', 'attestation/generate', 'item/tool/call'])(
    'explicitly refuses unadvertised host request %s without a renderer or private payload event', async method => {
      const f = await engineFixture();
      await f.request('fixture/server-request', { frame: { id: 'host-control', method,
        params: { privateInput: 'PRIVATE_HOST_CONTROL' } } });
      await vi.waitFor(async () => expect((await f.history()).find(frame => frame.id === 'host-control'))
        .toMatchObject({ error: { code: -32601 } }));
      expect(f.host.recentSince(0).some(({ event }) => event.type === 'card')).toBe(false);
      expect(JSON.stringify(f.host.recentSince(0))).not.toContain('PRIVATE_HOST_CONTROL');
    });

  it('round-trips typed MCP forms through real native pipes with workspace and cancellation fences', async () => {
    const f = await engineFixture();
    await f.host.startCommand(f.command('owner_turn', 'first')).terminal;
    const request = (id: string) => f.request('fixture/server-request', { frame: {
      id, method: 'mcpServer/elicitation/request', params: { threadId: 'native-thread', turnId: 'native-1',
        mode: 'form', serverName: 'example', message: 'Details', requestedSchema: { type: 'object',
          properties: { count: { type: 'integer', minimum: 2 }, credential: { type: 'string', writeOnly: true } },
          required: ['count', 'credential'] },
      },
    } });
    const latest = () => {
      const opened = [...f.host.recentSince(0)].reverse().find(({ event }) => event.type === 'card' && event.phase === 'opened')?.event;
      if (opened?.type !== 'card' || opened.phase !== 'opened') throw new Error('Missing card');
      return opened.card;
    };
    const answer = (payload: unknown, workspace = 'workspace') => resolveCardResponse({
      correlationId: latest().correlationId, action: 'submit', payload, expectedWorkspaceId: workspace,
    });
    await request('native-form');
    expect(answer({ value: '1' }).ok).toBe(false);
    expect(answer({ value: '2' }, 'foreign').ok).toBe(false);
    answer({ value: '2' });
    await vi.waitFor(() => expect(latest().presentation).toMatchObject({ kind: 'text', sensitive: true }));
    answer({ value: 'private-native-value' });
    await vi.waitFor(async () => expect((await f.history()).find(frame => frame.id === 'native-form')).toMatchObject({
      result: { action: 'accept', content: { count: 2, credential: 'private-native-value' }, _meta: null },
    }));
    expect(JSON.stringify(f.host.recentSince(0))).not.toContain('private-native-value');
    await request('cancelled-form');
    const oldId = latest().correlationId;
    await f.host.startCommand(f.command('interrupt', 'stop')).terminal;
    await vi.waitFor(async () => expect((await f.history()).find(frame => frame.id === 'cancelled-form')).toMatchObject({
      result: { action: 'cancel', content: null, _meta: null },
    }));
    expect(resolveCardResponse({ correlationId: oldId, action: 'submit', payload: { value: '99' }, expectedWorkspaceId: 'workspace' }).ok).toBe(false);
  });

  it('refuses stale and completed-turn native permission requests before opening a card', async () => {
    const f = await engineFixture();
    await f.host.startCommand(f.command('owner_turn', 'first')).terminal;
    const request = (id: string, turnId: string) => f.request('fixture/server-request', { frame: {
      id, method: 'item/permissions/requestApproval', params: { threadId: 'native-thread', turnId,
        permissions: { network: { enabled: true } } },
    } });
    await request('stale-permission', 'older-native-turn');
    expect((await f.history()).find(frame => frame.id === 'stale-permission'))
      .toMatchObject({ error: { code: -32602 } });
    await f.request('fixture/complete');
    await request('completed-permission', 'native-1');
    expect((await f.history()).find(frame => frame.id === 'completed-permission'))
      .toMatchObject({ error: { code: -32602 } });
    expect(f.host.recentSince(0).some(({ event }) => event.type === 'card' && event.phase === 'opened')).toBe(false);
  });

  it('delivers actual image input on both start and steer over real pipes', async () => {
    const f = await engineFixture();
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9YkAAAAASUVORK5CYII=';
    const input = [{ type: 'image', mediaType: 'image/png', data }] as const;
    const first = f.host.startCommand({ ...f.command('owner_turn', 'first'), input });
    await expect(first.terminal).resolves.toMatchObject({ status: 'completed' });
    await expect(f.host.startCommand({ ...f.command('steer', 'correction'), input }).terminal)
      .resolves.toMatchObject({ status: 'completed' });
    const calls = (await f.history()).filter(call => ['turn/start', 'turn/steer'].includes(String(call.method)));
    expect(calls.map(call => (call.params as Record<string, unknown>)?.input)).toEqual(['first', 'correction'].map(id => [
      { type: 'text', text: `Input ${id}` }, { type: 'image', url: `data:image/png;base64,${data}` },
    ]));
  });

  it('revalidates queued file permissions before any Codex native request', async () => {
    const f = await engineFixture();
    await f.host.startCommand(f.command('owner_turn', 'first')).terminal;
    const bytes = Buffer.from('sensitive notes'), path = join(f.dir, 'notes.txt'); writeFileSync(path, bytes);
    const queued = f.host.startCommand({ ...f.command('queue', 'revoked'), input: [{ type: 'file',
      uri: 'project:notes.txt', mediaType: 'text/plain', workspaceId: 'workspace',
      sha256: createHash('sha256').update(bytes).digest('hex') }] });
    chmodSync(path, 0);
    const next = f.host.startCommand(f.command('queue', 'after-refusal'));
    await f.request('fixture/complete');
    await expect(queued.terminal).resolves.toMatchObject({ status: 'refused', refusal: { code: 'input_unreadable' } });
    await expect(next.terminal).resolves.toMatchObject({ status: 'completed' });
    const calls = (await f.history()).filter(call => call.method === 'turn/start');
    expect(calls.map(call => (call.params as Record<string, unknown>)?.input)).toEqual(['first', 'after-refusal'].map(id => [{ type: 'text', text: `Input ${id}` }]));
  });

  it('delivers a correlated steer before completion and queues the next turn exactly once', async () => {
    const f = await engineFixture();
    await f.host.startCommand(f.command('owner_turn', 'first')).terminal;
    const queued = f.host.startCommand(f.command('queue', 'next'));
    const correction = f.command('steer', 'correction');
    const dispatch = f.host.startCommand(correction);
    await expect(dispatch.terminal).resolves.toMatchObject({ status: 'completed', commandId: 'correction', commandType: 'steer' });
    expect(f.host.startCommand(correction).replayed).toBe(true);
    let calls = await f.history();
    expect(calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
    expect(calls.filter(c => c.method === 'turn/steer')).toEqual([expect.objectContaining({ params: {
      threadId: 'native-thread', expectedTurnId: 'native-1', input: [{ type: 'text', text: 'Input correction' }],
    } })]);
    await f.request('fixture/complete'); await queued.terminal;
    await expect(f.host.startCommand(f.command('steer', 'stale')).terminal).resolves.toMatchObject({ refusal: { code: 'active_turn_mismatch' } });
    await expect(f.host.startCommand(f.command('steer', 'next-correction', 'owner-next')).terminal).resolves.toMatchObject({ status: 'completed' });
    calls = await f.history();
    expect(calls.filter(c => c.method === 'turn/start')).toHaveLength(2);
    expect(calls.filter(c => c.method === 'turn/steer').map(c => (c.params as RpcFrame).expectedTurnId)).toEqual(['native-1', 'native-2']);
  });

  it.each(['finish-before-ack', 'interrupt-before-ack'])('refuses success when %s wins on the pipe', async mode => {
    const f = await engineFixture(mode);
    await f.host.startCommand(f.command('owner_turn', 'first')).terminal;
    await expect(f.host.startCommand(f.command('steer', 'late')).terminal).resolves.toMatchObject({
      status: 'refused', refusal: { code: 'steer_outcome_unknown', retryable: false },
    });
    const calls = await f.history();
    expect(calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
    expect(calls.filter(c => c.method === 'turn/steer')).toHaveLength(1);
  });

  it('keeps a correlated native refusal visible without disconnecting the session', async () => {
    const f = await engineFixture('refuse');
    await f.host.startCommand(f.command('owner_turn', 'first')).terminal;
    await expect(f.host.startCommand(f.command('steer', 'refused')).terminal).resolves.toMatchObject({
      status: 'refused', refusal: { code: 'native_steer_refused', retryable: false },
    });
    expect(f.host.snapshot().streamReady).toBe(true);
    expect((await f.history()).filter(c => c.method === 'turn/steer')).toHaveLength(1);
  });

  it('holds queued input behind the interrupt acknowledgement and refuses concurrent steering', async () => {
    const f = await engineFixture('hold-interrupt');
    await f.host.startCommand(f.command('owner_turn', 'first')).terminal;
    const stop = f.host.startCommand(f.command('interrupt', 'stop'));
    await vi.waitFor(async () => expect((await f.history()).some(c => c.method === 'turn/interrupt')).toBe(true));
    const queued = f.host.startCommand(f.command('queue', 'next'));
    await expect(f.host.startCommand(f.command('steer', 'raced')).terminal).resolves.toMatchObject({ status: 'refused' });
    expect((await f.history()).filter(c => c.method === 'turn/start')).toHaveLength(1);
    await f.request('fixture/release'); await stop.terminal; await queued.terminal;
    const calls = await f.history();
    expect(calls.filter(c => c.method === 'turn/interrupt')).toEqual([expect.objectContaining({ params: { threadId: 'native-thread', turnId: 'native-1' } })]);
    expect(calls.filter(c => c.method === 'turn/steer')).toHaveLength(0);
    expect(calls.filter(c => c.method === 'turn/start')).toHaveLength(2);
  });
});
