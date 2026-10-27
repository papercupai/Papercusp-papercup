/** Installed clients + production engines/cards/queues + real PG wake ledger.
 * Inference is served only by a loopback fixture; no provider inference claim. */
import postgres from 'postgres';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from '@iarna/toml';
import { spawn as spawnPty } from '@lydell/node-pty';
import { afterAll, afterEach, beforeAll, expect, inject, it, vi } from 'vitest';
import { SU_SESSION_PROTOCOL_VERSION, SU_SESSION_SCHEMA, type SuSessionIdentity } from '@papercusp/chat-protocol';
import { resolveCardResponse } from '@papercusp/agent-mcp';
import { acquireBaselineSchemaMutex, releaseBaselineSchemaMutex } from '@papercusp/test-config/baseline-schema-mutex';
import type {} from '../../../libs/test-config/src/baseline-schema-global-setup';
import type { BootstrapSuResult } from './endpoint-route/routes/agent-mcp/bootstrap-su';
import type { PuiSuSessionBinding } from './launch-agent';
import type { RpcFrame } from './su-session-stdio-peer';

const fixture = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql,
  children: new Map<string, ChildProcess>(), homes: new Map<string, string>() }));
vi.mock('@papercusp/db-org', async original => ({ ...await original<object>(), getOrgPg: () => ({ sql: fixture.sql }) }));
vi.mock('@papercusp/orchestrator/session-launch-dirs', async original => ({ ...await original<object>(),
  codexHomeForSessionKey: (id: number) => fixture.homes.get(String(id))! }));
vi.mock('./su-session-persistence', () => ({ bindSuSessionToAdvSession: vi.fn(async () => ({ status: 'bound' })),
  persistSuSessionDescriptor: vi.fn(async () => true) }));
vi.mock('./su-session-commands', async original => ({ ...await original<object>(), loadSuOwnerTurnReceipts: async () => [] }));
vi.mock('./role-codex-home', () => ({ makeCodingAssistantCodexHome: vi.fn() }));
vi.mock('./task-manager/managed-spawn', () => ({ managedSpawn: async (bin: string, args: string[], _spec: unknown,
  options: { spawnOptions: object }) => {
  const child = spawn(bin, args, options.spawnOptions), taskId = randomUUID();
  fixture.children.set(taskId, child); return { child, taskId };
} }));
vi.mock('./task-manager/control', () => ({ killTask: async (id: string) => {
  fixture.children.get(id)?.kill('SIGKILL'); return { ok: true };
} }));
vi.mock('../../../apps/operator/scripts/psu-launcher.mjs', async original => ({
  ...await original<object>(), assertLaunchPersona: vi.fn(), startSupervisorBeat: vi.fn(),
  prepareSuLaunch: (boot: BootstrapSuResult) => ({ env: { ...boot.envelopeEnv }, args: [], modelArgs: [], model: boot.model }),
}));

import { startSuRpcEngine } from './su-session-rpc-engine';
import { recordAdvSession } from './adv-sessions';
import { completeTrackedCodexFork } from './su-session-tracked-codex-fork';
import { prepareTrackedClaudeFork } from './su-session-tracked-claude-fork';
import { resumeArgsFor, resumeEnvFor } from '../../../apps/operator/scripts/psu-launcher.mjs';
import { SU_EXEC_INVENTORY } from './__fixtures__/su-execution-parity';
import { startClaudeSuEngine } from './su-session-claude-engine';
import { startSuStdioPeer } from './su-session-stdio-peer';
import { codexCliResponsesBody, codexCliResponsesCompletionSse } from './inference-gateway/codex-cli-bridge';
import { registerAwait, fireAwaitsForKey, insertDeliveries, markDeliveryDelivered, ackDelivery } from './events/await/store';

let mutex: postgres.Sql;
const engines: Array<{ close(): Promise<void>; done: Promise<void>; adapter: {
  dispose(): void; host: { snapshot(): { streamReady: boolean } };
} }> = [];
const roots: string[] = [], subscribers: string[] = [];
beforeAll(async () => {
  mutex = await acquireBaselineSchemaMutex(inject('baselineSchemaDsn'), { label: 'fork-pending-isolation' });
  fixture.sql = postgres(inject('baselineSchemaDsn'), { max: 2, onnotice: () => {} });
});
afterEach(async () => {
  for (const engine of engines.splice(0).reverse()) { await engine.close(); await engine.done; engine.adapter.dispose(); }
  await vi.waitFor(() => expect([...fixture.children.values()]
    .every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true));
  fixture.homes.clear();
  for (const subscriber of subscribers.splice(0)) {
    await fixture.sql`DELETE FROM harness_shared.event_wake_deliveries WHERE subscriber_id = ${subscriber}`;
    await fixture.sql`DELETE FROM harness_shared.event_awaits WHERE subscriber_id = ${subscriber}`;
    await fixture.sql`DELETE FROM harness_shared.adv_sessions WHERE coord_owner_id = ${subscriber}`;
  }
  while (roots.length) {
    const root = roots.at(-1)!;
    try { rmSync(root, { recursive: true, force: true }); }
    catch (cause) {
      // Preserve attribution and the failed root for diagnosis; no retry hides a writer race.
      throw new Error(`Native fork cleanup failed: ${JSON.stringify({ root,
        processes: [...fixture.children.values()].map(child => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode })),
        remaining: readdirSync(root, { recursive: true }).map(String).slice(0, 40),
      })}`, { cause });
    }
    roots.pop();
  }
  fixture.children.clear();
});
afterAll(async () => { await fixture.sql?.end({ timeout: 5 }); if (mutex) await releaseBaselineSchemaMutex(mutex); });

function command(host: { descriptor(): { identity: SuSessionIdentity } }, type: 'owner_turn' | 'queue', content: string) {
  return { schema: SU_SESSION_SCHEMA, protocolVersion: SU_SESSION_PROTOCOL_VERSION, issuedAt: new Date().toISOString(),
    target: host.descriptor().identity, type, commandId: randomUUID(), turnId: randomUUID(), content };
}
function sendClaude(res: ServerResponse, question: boolean) {
  const block = question ? { type: 'tool_use', id: 'toolu_pending', name: 'AskUserQuestion', input: { questions: [{
    question: 'PARENT_PRIVATE_QUESTION', header: 'Choice', multiSelect: false,
    options: [{ label: 'Keep', description: 'Keep it' }, { label: 'Change', description: 'Change it' }],
  }] } } : { type: 'text', text: 'ACK' };
  const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(event('message_start', { message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant',
    model: 'claude-haiku-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } })
    + event('content_block_start', { index: 0, content_block: question ? { ...block, input: {} } : { type: 'text', text: '' } })
    + event('content_block_delta', { index: 0, delta: question
      ? { type: 'input_json_delta', partial_json: JSON.stringify('input' in block ? block.input : {}) }
      : { type: 'text_delta', text: 'ACK' } })
    + event('content_block_stop', { index: 0 })
    + event('message_delta', { delta: { stop_reason: question ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
    + event('message_stop', {}));
}
function sendCodex(res: ServerResponse, question: boolean, questionTool: string) {
  const response = codexCliResponsesBody({ model: 'gpt-6-sol', text: 'ACK', inputTokens: 10, outputTokens: 1 });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (!question) { res.end(codexCliResponsesCompletionSse(response)); return; }
  const toolPath = questionTool.split('.');
  const item = { id: 'fc_pending', type: 'function_call', call_id: 'call_pending', name: toolPath.at(-1),
    ...(toolPath.length > 1 ? { namespace: toolPath.slice(0, -1).join('.') } : {}),
    arguments: JSON.stringify({ questions: [{ id: 'pending', header: 'Choice', question: 'PARENT_PRIVATE_QUESTION',
      options: [{ label: 'Keep', description: 'Keep it' }, { label: 'Change', description: 'Change it' }] }] }), status: 'completed' };
  const event = (type: string, fields: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
  res.end(event('response.created', { response: { ...response, status: 'in_progress', output: [] } })
    + event('response.output_item.added', { output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } })
    + event('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: item.arguments })
    + event('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: item.arguments })
    + event('response.output_item.done', { output_index: 0, item })
    + event('response.completed', { response: { ...response, output: [item] } }));
}

function toolNames(tools: RpcFrame[], prefix = ''): string[] {
  return tools.flatMap(tool => tool.type === 'namespace' && Array.isArray(tool.tools)
    ? toolNames(tool.tools, `${prefix}${tool.name}.`) : typeof tool.name === 'string' ? [prefix + tool.name] : []);
}

for (const { backend, registrationFailure, pty, name } of [
  { backend: 'codex', registrationFailure: false, pty: false, name: 'codex native fork leaves pending question, queued input and accepted wake exclusively with parent' },
  { backend: 'claude', registrationFailure: false, pty: false, name: 'claude native fork leaves pending question, queued input and accepted wake exclusively with parent' },
  { backend: 'claude', registrationFailure: true, pty: false, name: 'claude native fork refuses changed lineage and removes unregistered history' },
  { backend: 'claude', registrationFailure: false, pty: true, name: 'claude PTY native fork preserves parent history and isolates pending consumables' },
] as const) { it(name, async () => {
  const root = mkdtempSync(join(tmpdir(), 'su-fork-pending-')); roots.push(root);
  const parentOwner = `su-parent-${randomUUID()}`, childOwner = `su-child-${randomUUID()}`;
  subscribers.push(parentOwner, childOwner);
  const bodies: object[] = [], outbound = new Map<string, string[]>(), requests: object[] = [], fixtureErrors: string[] = [];
  const nativeRequests: object[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(200); res.end('{}'); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url?.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":10}'); return; }
    bodies.push(body);
    const conversation = (backend === 'codex' ? body.input : body.messages) as Array<RpcFrame>;
    const encoded = JSON.stringify(conversation.filter(item => item.type !== 'additional_tools' && item.role !== 'system'));
    const answered = conversation.some(item => item.type === 'function_call_output'
      || Array.isArray(item.content) && item.content.some((block: RpcFrame) => block.type === 'tool_result'));
    const question = encoded.includes('ASK_PARENT_NOW') && !answered && !encoded.includes('CHILD_ONLY');
    const names = toolNames([...(body.tools ?? []), ...conversation.filter(item => item.type === 'additional_tools')
      .flatMap(item => Array.isArray(item.tools) ? item.tools : [])]);
    const questionTool = names.find(name => /(?:^|\.)request_user_input$/.test(name)) ?? '';
    requests.push({ question, answered, questionTool, questions: names.filter(name => /Question|request_user_input/.test(name)),
      toolResults: conversation.filter(item => item.type === 'function_call_output').map(item => item.output),
      lastUser: conversation.filter(item => item.role === 'user').map(item => JSON.stringify(item.content).slice(-400)).at(-1) });
    if (question && !(backend === 'codex' ? questionTool : names.includes('AskUserQuestion'))) {
      fixtureErrors.push(`Native ${backend} request did not advertise its question tool`);
      res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: fixtureErrors.at(-1) })); return;
    }
    if (backend === 'codex') sendCodex(res, question, questionTool); else sendClaude(res, question);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No loopback port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let parentNativeId = '';
  let parentAdvSessionId = 0;
  async function open(owner: string, child = false) {
    const home = join(root, child ? 'child' : 'parent'); mkdirSync(home);
    const nativeId = backend === 'claude' ? randomUUID() : null;
    const advSessionId = Number(await recordAdvSession({ agent: backend, workspaceId: 'fork-pending-fixture',
      mode: 'console', coordOwnerId: owner, cwd: root, sessionId: nativeId }));
    expect(advSessionId).toBeGreaterThan(0);
    fixture.homes.set(String(advSessionId), home);
    await fixture.sql`UPDATE harness_shared.adv_sessions SET launch_spec = ${JSON.stringify({ v: 1, agent: backend,
      workspaceId: 'fork-pending-fixture' })}::text::jsonb WHERE id = ${advSessionId}`;
    if (!child) parentAdvSessionId = advSessionId;
    const binding = { operation: 'created', backend, advSessionId, ownerId: owner,
      workspaceId: 'fork-pending-fixture', harnessSlug: null, planSlug: null, nativeSession: null } as PuiSuSessionBinding;
    const boot = { status: 'ok', agent: backend, sessionId: binding.advSessionId, nativeSessionId: nativeId,
      workspaceId: binding.workspaceId!, harnessSlug: null, planSlug: null, cwd: root,
      promptFile: join(home, 'su.md'), codexHome: backend === 'codex' ? home : null, coordExtPath: null,
      model: backend === 'codex' ? 'gpt-6-sol' : 'claude-haiku-4-5', specificationRevision: 'fixture', stateRevision: 'fixture',
      compositionSource: 'compatibility', envelopeEnv: { PAPERCUSP_SID: owner, PATH: process.env.PATH!, HOME: home,
        ...(backend === 'codex' ? { CODEX_HOME: home } : { CLAUDE_CONFIG_DIR: join(home, 'claude-config'),
          ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: 'offline-fixture-only',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }) } } satisfies BootstrapSuResult;
    writeFileSync(boot.promptFile, 'Fork isolation fixture.'); outbound.set(owner, []);
    if (backend === 'codex') {
      writeFileSync(join(home, 'config.toml'), stringify({ model_provider: 'local_fork', model: boot.model,
        model_providers: { local_fork: { name: 'Local fixture', base_url: `${baseUrl}/v1`, wire_api: 'responses',
          requires_openai_auth: false, supports_websockets: false, request_max_retries: 0 } },
        features: { apps: false, shell_tool: false }, web_search: 'disabled' }));
      // Use the production tracked-fork transaction before attaching the exact
      // registered child. A direct engine fork does not prove that route.
      const forkCalls: Array<{ frame: RpcFrame; result: RpcFrame }> = [];
      const fork = child ? await completeTrackedCodexFork(boot, {
        advSessionId: parentAdvSessionId, nativeSessionId: parentNativeId,
      }, { startPeer: async options => {
        const peer = await startSuStdioPeer(options);
        return { ...peer, request: async (frame, timeout) => {
          const result = await peer.request(frame, timeout);
          forkCalls.push({ frame, result });
          return result;
        } };
      } }) : null;
      if (fork) {
        const read = forkCalls.find(call => call.frame.method === 'thread/read');
        expect(read).toBeDefined();
        const parent = read!.result.thread as { id: string; turns: Array<{ id: string; status: string }> };
        expect(parent.id).toBe(parentNativeId);
        const completed = parent.turns.filter(turn => turn.status === 'completed');
        const pages = forkCalls.filter(call => call.frame.method === 'thread/turns/list');
        const boundary = completed.at(-1)
          ?? pages.flatMap(call => call.result.data as Array<{ id: string; status: string }>)
            .find(turn => turn.status === 'completed');
        expect(boundary, 'the native parent must expose a completed fork boundary').toBeDefined();
        const request = forkCalls.find(call => call.frame.method === 'thread/fork');
        expect(request?.frame.params).toMatchObject({ threadId: parentNativeId, lastTurnId: boundary!.id });
        const pendingIds = parent.turns.filter(turn => turn.status !== 'completed').map(turn => turn.id);
        expect(pendingIds).not.toContain((request!.frame.params as { lastTurnId: string }).lastTurnId);
      }
      const resumed = fork ? { backend: 'codex' as const, source: 'adv_sessions' as const, ownerId: owner,
        codexHome: home, rolloutId: fork.nativeSessionId, exactResumeSupported: true, missingReason: null } : null;
      if (fork) {
        const [registered] = await fixture.sql`SELECT session_id, launch_spec FROM harness_shared.adv_sessions WHERE id = ${advSessionId}`;
        expect(registered.session_id).toBe(fork.nativeSessionId);
        expect(registered.launch_spec.nativeFork).toEqual({ advSessionId: parentAdvSessionId,
          nativeSessionId: parentNativeId, ownerId: parentOwner });
      }
      const engine = startSuRpcEngine(boot, binding as PuiSuSessionBinding & { backend: 'codex' }, {
        agentChatId: owner, register: false, identity: 'coding-assistant', servedAccountReader: async () => null,
        ownerTurnReceipts: async () => [], startupTimeoutMs: 20_000,
        ...(resumed ? { nativeSession: resumed } : {}),
        turnLifecycle: { admit: async () => ({ ok: true, bindNativeTurn: async () => {}, complete: async () => {}, reconcile: async () => {} }) },
        peerFactory: async options => {
          const peer = await startSuStdioPeer({ ...options, onMessage: frame => {
            if (frame.id != null && frame.method) nativeRequests.push({ method: frame.method, params: frame.params });
            options.onMessage(frame);
          } });
          return { ...peer, request: (frame, timeout) => {
            if (frame.method === 'initialize') frame = { ...frame, params: { ...frame.params as object,
              capabilities: { experimentalApi: true } } };
            if (frame.method === 'turn/start') {
              outbound.get(owner)!.push(JSON.stringify(frame.params));
              frame = { ...frame, params: { ...frame.params as object, collaborationMode: { mode: 'plan', settings: {
                model: boot.model, reasoning_effort: null, developer_instructions: null } } } };
            }
            return peer.request(frame, timeout);
          } };
        },
      });
      engines.push(engine); await engine.ready;
      const handle = engine.nativeSession();
      if (handle.backend !== 'codex' || !handle.rolloutId) throw new Error('Missing native Codex identity');
      if (!child) {
        parentNativeId = handle.rolloutId;
        await fixture.sql`UPDATE harness_shared.adv_sessions SET session_id = ${parentNativeId} WHERE id = ${advSessionId}`;
      }
      return { host: engine.adapter.host, nativeId: handle.rolloutId };
    }
    const engine = startClaudeSuEngine(boot, binding as PuiSuSessionBinding & { backend: 'claude' }, {
      nativeSession: { backend: 'claude', source: 'adv_sessions', ownerId: owner, sessionId: nativeId!,
        configDir: join(home, 'claude-config'), configDirSource: 'live-process', configDirUnresolvedReason: null,
        exactResumeSupported: true, missingReason: null }, transcriptPath: null,
    }, { agentChatId: owner, register: false, identity: 'coding-assistant', toolApproval: 'prompt',
      ...(child && registrationFailure ? { beforeReady: async () => {
        await fixture.sql`UPDATE harness_shared.adv_sessions SET session_id = ${randomUUID()} WHERE id = ${parentAdvSessionId}`;
      } } : {}),
      ...(child ? { forkFrom: { advSessionId: parentAdvSessionId, nativeSession: {
        backend: 'claude' as const, source: 'adv_sessions' as const, ownerId: parentOwner, sessionId: parentNativeId,
        configDir: join(root, 'parent', 'claude-config'), configDirSource: 'live-process' as const,
        configDirUnresolvedReason: null, exactResumeSupported: true, missingReason: null,
      } } } : {}),
      servedAccountReader: async () => null, startupTimeoutMs: 20_000, query: input => query({
        ...input, prompt: (async function* () { for await (const message of input.prompt) {
          outbound.get(owner)!.push(JSON.stringify(message)); yield message;
        } })(), options: { ...input.options, env: { ...boot.envelopeEnv },
          settingSources: [], settings: { disableAllHooks: true }, mcpServers: {},
          spawnClaudeCodeProcess: options => {
            const process = spawn(options.command, options.args, { cwd: root, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
            fixture.children.set(randomUUID(), process); return process;
          } },
      }) });
    engines.push(engine); await engine.ready;
    if (child) {
      const [registered] = await fixture.sql`SELECT session_id, launch_spec FROM harness_shared.adv_sessions WHERE id = ${advSessionId}`;
      expect(registered.session_id).toBe(nativeId);
      expect(registered.launch_spec.nativeFork).toEqual({ advSessionId: parentAdvSessionId,
        nativeSessionId: parentNativeId, ownerId: parentOwner });
    }
    if (!child) parentNativeId = nativeId!;
    return { host: engine.adapter.host, nativeId: nativeId! };
  }
  try {
    const parent = await open(parentOwner);
    const initial = await parent.host.startCommand(command(parent.host, 'owner_turn', 'PARENT_HISTORY')).terminal;
    expect(initial, JSON.stringify(initial)).toMatchObject({ status: 'completed' });
    await vi.waitFor(() => expect(parent.host.descriptor().lifecycle).toBe('waiting-for-owner'), { timeout: 20_000 });
    await expect(parent.host.startCommand(command(parent.host, 'owner_turn', 'ASK_PARENT_NOW')).terminal)
      .resolves.toMatchObject({ status: 'completed' });
    const parentCard = () => parent.host.recentSince(0).map(row => row.event).find(event => event.type === 'card' && event.phase === 'opened');
    await vi.waitFor(() => expect(parentCard(), JSON.stringify({
      lifecycle: parent.host.descriptor().lifecycle, requests, fixtureErrors, nativeRequests,
      events: parent.host.recentSince(0).map(row => row.event).filter(event => event.type === 'transcript' || event.type === 'error').slice(-6),
    })).toBeDefined(), { timeout: 20_000 });
    const card = parentCard(); if (card?.type !== 'card' || card.phase !== 'opened') throw new Error('No parent question');
    let queueSettled = false;
    const queued = parent.host.startCommand(command(parent.host, 'queue', 'PARENT_QUEUED_PRIVATE'));
    void queued.terminal.then(() => { queueSettled = true; });
    const eventKey = `fork-pending:${randomUUID()}`;
    const awaited = await registerAwait({ subscriberId: parentOwner, eventKey, policy: 'wake' });
    const fired = await fireAwaitsForKey({ eventKey }); expect(fired.map(row => row.id)).toEqual([awaited.id]);
    expect(await insertDeliveries({ awaits: fired, payload: { secret: 'PARENT_WAKE_PRIVATE' } })).toBe(1);
    const [delivery] = await fixture.sql`SELECT * FROM harness_shared.event_wake_deliveries WHERE await_id = ${awaited.id}`;
    await markDeliveryDelivered(Number(delivery.id), 'psu-socket-inject');
    const [before] = await fixture.sql`SELECT * FROM harness_shared.event_wake_deliveries WHERE id = ${delivery.id}`;
    expect(before).toMatchObject({ status: 'delivered', turn_proof: 'awaiting', turn_started_at: null });
    expect(queueSettled).toBe(false);
    if (pty) {
      expect(execFileSync('claude', ['--version'], { encoding: 'utf8' })).toContain(SU_EXEC_INVENTORY.versions.claude);
      const home = join(root, 'pty'), configDir = join(home, 'claude-config'), nativeId = randomUUID();
      mkdirSync(home);
      const childId = Number(await recordAdvSession({ agent: 'claude', workspaceId: 'fork-pending-fixture',
        mode: 'console', coordOwnerId: childOwner, cwd: root, sessionId: nativeId }));
      await fixture.sql`UPDATE harness_shared.adv_sessions SET launch_spec = ${JSON.stringify({ v: 1, agent: 'claude',
        workspaceId: 'fork-pending-fixture' })}::text::jsonb WHERE id = ${childId}`;
      const prepared = await prepareTrackedClaudeFork({ workspaceId: 'fork-pending-fixture', cwd: root,
        childAdvSessionId: childId, childOwnerId: childOwner, childNativeSessionId: nativeId, childConfigDir: configDir,
        source: { advSessionId: parentAdvSessionId, nativeSession: { backend: 'claude', source: 'adv_sessions',
          ownerId: parentOwner, sessionId: parentNativeId, configDir: join(root, 'parent', 'claude-config'),
          configDirSource: 'live-process', configDirUnresolvedReason: null, exactResumeSupported: true, missingReason: null } } });
      const parentBytes = readFileSync(prepared.transcriptPath);
      writeFileSync(join(configDir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark',
        bypassPermissionsModeAccepted: true, projects: { [root]: { hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true, projectOnboardingSeenCount: 1, allowedTools: [] } } }));
      const session = { agent: 'claude', sessionId: parentNativeId, coordOwnerId: parentOwner,
        workspaceId: 'fork-pending-fixture' };
      const launch = resumeArgsFor(session, { fork: true, forkSessionId: nativeId, model: 'claude-haiku-4-5', env: {} });
      const terminal = spawnPty(launch.bin, [...launch.args, '--setting-sources', '', '--settings', '{"disableAllHooks":true}',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--', 'CHILD_ONLY_PTY'], {
        cwd: root, cols: 120, rows: 32, env: { PATH: process.env.PATH!, HOME: home, TERM: 'xterm-256color',
          // A fixture bearer avoids the native API-key approval dialog. No
          // credential is read from the invoking agent's environment.
          CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: 'offline-fixture-only',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
          ...resumeEnvFor(session, { fork: true, ownerId: childOwner }) },
      });
      let output = '', probeTail = '', exitCode: number | null = null;
      const exited = new Promise<void>(done => terminal.onExit(event => { exitCode = event.exitCode; done(); }));
      const data = terminal.onData(chunk => {
        output = (output + chunk).slice(-65_536);
        const probes = probeTail + chunk; probeTail = probes.slice(-3);
        if (probes.includes('\x1b[6n')) terminal.write('\x1b[1;1R');
      });
      try {
        await Promise.race([exited.then(() => { throw new Error(`Claude PTY exited (${exitCode}): ${output}`); }), vi.waitFor(() => {
          expect(exitCode, output).toBeNull();
          const request = bodies.find(body => JSON.stringify(body).includes('CHILD_ONLY_PTY'));
          expect(request, output).toBeDefined();
          expect(JSON.stringify(request)).toContain('PARENT_HISTORY');
          expect(JSON.stringify(request)).not.toContain('PARENT_QUEUED_PRIVATE');
          expect(JSON.stringify(request)).not.toContain('PARENT_WAKE_PRIVATE');
          expect(output).toContain('ACK');
        }, { timeout: 30_000 })]);
        await prepared.register();
        const [child] = await fixture.sql`SELECT session_id, launch_spec FROM harness_shared.adv_sessions WHERE id = ${childId}`;
        expect(child.session_id).toBe(nativeId);
        expect(child.launch_spec.nativeFork).toEqual({ advSessionId: parentAdvSessionId,
          nativeSessionId: parentNativeId, ownerId: parentOwner });
        expect(readFileSync(prepared.transcriptPath)).toEqual(parentBytes);
        expect(queueSettled).toBe(false);
        expect(outbound.get(parentOwner)).toHaveLength(2);
        const [retained] = await fixture.sql`SELECT * FROM harness_shared.event_wake_deliveries WHERE id = ${delivery.id}`;
        expect(retained).toEqual(before);
        expect(await fixture.sql`SELECT id FROM harness_shared.event_awaits WHERE subscriber_id = ${childOwner}`).toEqual([]);
      } finally {
        terminal.kill('SIGTERM');
        const killTimer = setTimeout(() => terminal.kill('SIGKILL'), 2000);
        try { await exited; } finally { clearTimeout(killTimer); data.dispose(); }
      }
      return;
    }
    if (registrationFailure) {
      await expect(open(childOwner, true)).rejects.toThrow('lineage registration refused');
      const [child] = await fixture.sql`SELECT launch_spec FROM harness_shared.adv_sessions WHERE coord_owner_id = ${childOwner}`;
      expect(child.launch_spec.nativeFork).toBeUndefined();
      const entries = readdirSync(join(root, 'child', 'claude-config', 'projects'), { recursive: true });
      expect(entries.some(path => String(path).endsWith('.jsonl'))).toBe(false);
      expect(engines.at(-1)!.adapter.host.snapshot().streamReady).toBe(false);
      expect(queueSettled).toBe(false);
      const [retained] = await fixture.sql`SELECT * FROM harness_shared.event_wake_deliveries WHERE id = ${delivery.id}`;
      expect(retained).toEqual(before);
      return;
    }
    const child = await open(childOwner, true);
    expect(child.nativeId).not.toBe(parent.nativeId);
    expect(child.host.recentSince(0).some(({ event }) => event.type === 'transcript' && 'content' in event && event.content === 'PARENT_HISTORY')).toBe(true);
    expect(child.host.recentSince(0).some(({ event }) => event.type === 'card')).toBe(false);
    expect(queueSettled).toBe(false);
    expect(outbound.get(childOwner)).toEqual([]);
    expect(await ackDelivery({ deliveryId: Number(delivery.id), subscriberId: childOwner }))
      .toMatchObject({ acked: false });
    const [after] = await fixture.sql`SELECT * FROM harness_shared.event_wake_deliveries WHERE id = ${delivery.id}`;
    expect(after).toEqual(before);
    const childRows = await fixture.sql`SELECT id FROM harness_shared.event_awaits WHERE subscriber_id = ${childOwner}`;
    expect(childRows).toHaveLength(0);
    await expect(child.host.startCommand(command(child.host, 'owner_turn', 'CHILD_ONLY')).terminal)
      .resolves.toMatchObject({ status: 'completed' });
    await vi.waitFor(() => expect(JSON.stringify(bodies)).toContain('CHILD_ONLY'), { timeout: 20_000 });
    const childBody = bodies.find(body => JSON.stringify(body).includes('CHILD_ONLY'));
    expect(JSON.stringify(childBody)).toContain('PARENT_HISTORY');
    expect(JSON.stringify(childBody)).not.toContain('PARENT_QUEUED_PRIVATE');
    expect(JSON.stringify(childBody)).not.toContain('PARENT_WAKE_PRIVATE');
    expect(outbound.get(parentOwner)).toHaveLength(2);
    expect(resolveCardResponse({ correlationId: card.card.correlationId, action: 'submit', payload: { picks: ['0'] },
      expectedWorkspaceId: 'fork-pending-fixture' }).ok).toBe(true);
    await expect(queued.terminal).resolves.toMatchObject({ status: 'completed' });
    expect(outbound.get(parentOwner)).toHaveLength(3);
    expect(outbound.get(parentOwner)!.at(-1)).toContain('PARENT_QUEUED_PRIVATE');
    expect(outbound.get(childOwner)).toHaveLength(1);
    const [retained] = await fixture.sql`SELECT * FROM harness_shared.event_wake_deliveries WHERE id = ${delivery.id}`;
    expect(retained).toEqual(before);
    expect(readFileSync(join(root, 'child', 'su.md'), 'utf8')).toBe('Fork isolation fixture.');
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
}, 120_000); }
