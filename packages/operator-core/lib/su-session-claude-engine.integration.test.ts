import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { SU_SESSION_PROTOCOL_VERSION, SU_SESSION_SCHEMA } from '@papercusp/chat-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapSuResult } from './endpoint-route/routes/agent-mcp/bootstrap-su';
import { startClaudeSuEngine, type ClaudeSuEngine } from './su-session-claude-engine';

// The real installed SDK owns stream/control framing. Only its CLI child,
// funding and persistence are fixtures; no provider inference is claimed.
const funding = vi.hoisted(() => vi.fn(async () => ({ ok: true as const })));
vi.mock('./cupboard/identity-activation-gate-io', () => ({ admitNativeIdentityInference: funding }));
vi.mock('./su-session-persistence', () => ({
  persistSuSessionDescriptor: vi.fn(async () => true),
  bindSuSessionToAdvSession: vi.fn(async () => ({ status: 'bound' })),
  readDurableSuSession: vi.fn(async () => null),
}));
vi.mock('./su-session-commands', async original => ({
  ...(await original<typeof import('./su-session-commands')>()), loadSuOwnerTurnReceipts: vi.fn(async () => []),
}));

const engines: ClaudeSuEngine[] = [], children: ChildProcessWithoutNullStreams[] = [], dirs: string[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) { await engine.close(); await engine.done; engine.adapter.dispose(); }
  for (const child of children.splice(0)) {
    await vi.waitFor(() => expect(child.exitCode !== null || child.signalCode !== null).toBe(true));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  funding.mockReset(); funding.mockResolvedValue({ ok: true });
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'su-claude-queue-')); dirs.push(dir);
  const script = join(dir, 'claude-peer.mjs'), log = join(dir, 'calls.jsonl'), promptFile = join(dir, 'su.md');
  const nativeId = '11111111-2222-4333-8444-555555555555';
  writeFileSync(log, ''); writeFileSync(promptFile, 'SU persona for a protocol integration test.\n'.repeat(100));
  writeFileSync(script, String.raw`
    import { createInterface } from 'node:readline';
    import { appendFileSync } from 'node:fs';
    const send = message => process.stdout.write(JSON.stringify(message) + '\n');
    const session_id = process.env.FIXTURE_SESSION;
    let active = false, pendingInterrupt;
    const result = interrupted => {
      send(interrupted
        ? { type: 'result', subtype: 'error_during_execution', session_id, is_error: true, errors: ['interrupted tool'] }
        : { type: 'result', subtype: 'success', session_id, is_error: false });
      active = false;
    };
    const respond = (request_id, response = {}) => send({ type: 'control_response',
      response: { subtype: 'success', request_id, response } });
    createInterface({ input: process.stdin }).on('line', line => {
      const call = JSON.parse(line);
      appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(call) + '\n');
      if (call.type === 'control_request') {
        const request = call.request;
        if (request.subtype === 'initialize') respond(call.request_id, {
          commands: [], agents: [], models: [], account: {}, output_style: 'default', available_output_styles: [] });
        else if (request.subtype === 'mcp_status') respond(call.request_id, {
          mcpServers: [{ name: 'papercusp-su', status: 'connected' }] });
        else if (request.subtype === 'interrupt') {
          result(true); pendingInterrupt = call.request_id;
        } else respond(call.request_id);
      } else if (call.type === 'user') {
        if (active) throw new Error('follow-up overtook the active turn');
        active = true;
        send({ type: 'system', subtype: 'init', session_id, cwd: process.cwd() });
        send(call);
      } else if (call.type === 'fixture') {
        if (call.action === 'release') { respond(pendingInterrupt); pendingInterrupt = undefined; }
        else if (call.action === 'finish') {
          send({ type: 'assistant', session_id, message: { content: [{ type: 'text', text: 'reply' }] } }); result(false);
        } else if (call.action === 'permission') send({ type: 'control_request', request_id: 'tool-approval',
          request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo fixture' }, tool_use_id: 'tool-1' } });
      }
    });
  `);
  const boot = { status: 'ok', specificationRevision: 'fixture-spec', stateRevision: 'fixture-state', compositionSource: 'blueprint',
    agent: 'claude', sessionId: 81, nativeSessionId: nativeId, workspaceId: 'workspace', harnessSlug: 'project', planSlug: null,
    codexHome: null, coordExtPath: null, cwd: dir, promptFile,
    envelopeEnv: { PAPERCUSP_SID: 'su-claude-queue', PAPERCUSP_WORKSPACE: 'workspace', CLAUDE_CONFIG_DIR: dir },
  } satisfies BootstrapSuResult;
  let child!: ChildProcessWithoutNullStreams;
  const engine = startClaudeSuEngine(boot, {
    operation: 'created', backend: 'claude', advSessionId: 81, ownerId: 'su-claude-queue',
    workspaceId: 'workspace', harnessSlug: 'project', planSlug: null, nativeSession: null,
  }, { nativeSession: { backend: 'claude', source: 'adv_sessions', ownerId: 'su-claude-queue', sessionId: nativeId,
    configDir: dir, configDirSource: 'live-process', configDirUnresolvedReason: null, exactResumeSupported: true, missingReason: null },
    transcriptPath: null,
  }, { agentChatId: 'claude-queue', register: false, startupTimeoutMs: 10_000, deliveryTimeoutMs: 5_000,
    toolApproval: 'prompt', servedAccountReader: async () => null,
    query: input => query({ ...input, options: { ...input.options, spawnClaudeCodeProcess: options => {
      child = spawn(process.execPath, [script], { cwd: dir,
        env: { ...options.env, FIXTURE_LOG: log, FIXTURE_SESSION: nativeId }, stdio: ['pipe', 'pipe', 'pipe'] });
      children.push(child); return child;
    } } }),
  });
  engines.push(engine); await engine.ready;
  const host = engine.adapter.host;
  const command = (type: 'owner_turn' | 'queue' | 'interrupt' | 'steer', id: string) => ({
    schema: SU_SESSION_SCHEMA, protocolVersion: SU_SESSION_PROTOCOL_VERSION, issuedAt: new Date().toISOString(),
    target: host.descriptor().identity, type, commandId: id, turnId: `owner-${id}`, content: `input ${id}`, activeTurnId: 'owner-first',
  });
  const history = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const control = (action: string) => { child.stdin.write(JSON.stringify({ type: 'fixture', action }) + '\n'); };
  return { engine, host, command, history, control, nativeId, dir };
}

describe('Claude persistent input through the installed SDK and real pipes', () => {
  it('delivers inline and pinned project image bytes through the installed SDK without flattening', async () => {
    const f = await fixture();
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9YkAAAAASUVORK5CYII=';
    const bytes = Buffer.from(data, 'base64');
    writeFileSync(join(f.dir, 'image.png'), bytes);
    const image = { type: 'image', mediaType: 'image/png', data } as const;
    await expect(f.host.startCommand({ ...f.command('owner_turn', 'inline'), input: [image] }).terminal)
      .resolves.toMatchObject({ status: 'completed' });
    const next = f.host.startCommand({ ...f.command('queue', 'project'), input: [{ type: 'file',
      uri: 'project:image.png', mediaType: 'image/png', workspaceId: 'workspace',
      sha256: createHash('sha256').update(bytes).digest('hex') }] });
    f.control('finish');
    await expect(next.terminal).resolves.toMatchObject({ status: 'completed' });
    const inputs = f.history().filter(call => call.type === 'user');
    expect(inputs.map(call => call.message.content)).toEqual(['inline', 'project'].map(id => [
      { type: 'text', text: `input ${id}` }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
    ]));
    expect(inputs.map(call => call.session_id)).toEqual([f.nativeId, f.nativeId]);
  });

  it.each(['revoked', 'expired', 'foreign', 'moved', 'deleted', 'changed', 'unsupported'] as const)
    ('refuses %s queued references at delivery and keeps the SDK connection usable', async reason => {
      const f = await fixture();
      const bytes = Buffer.from('private file contents');
      const path = join(f.dir, 'notes.txt'); writeFileSync(path, bytes);
      await f.host.startCommand(f.command('owner_turn', 'first')).terminal;
      const part = { type: 'file' as const, uri: 'project:notes.txt', mediaType: 'text/plain', workspaceId: 'workspace',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        ...(reason === 'expired' ? { expiresAt: '2000-01-01T00:00:00Z' } : {}),
        ...(reason === 'foreign' ? { workspaceId: 'other-workspace' } : {}),
        ...(reason === 'unsupported' ? { mediaType: 'application/zip' } : {}),
      };
      const queued = f.host.startCommand({ ...f.command('queue', 'invalid'), input: [part] });
      if (reason === 'revoked') chmodSync(path, 0);
      if (reason === 'moved') renameSync(path, join(f.dir, 'moved.txt'));
      if (reason === 'deleted') rmSync(path);
      if (reason === 'changed') writeFileSync(path, 'replacement');
      const next = f.host.startCommand(f.command('queue', 'after-refusal'));
      f.control('finish');
      const codes = { revoked: 'input_unreadable', expired: 'input_expired', foreign: 'input_workspace_mismatch',
        moved: 'input_unreadable', deleted: 'input_unreadable', changed: 'input_identity_changed', unsupported: 'unsupported_input_media_type' };
      await expect(queued.terminal).resolves.toMatchObject({ status: 'refused', refusal: { code: codes[reason] } });
      await expect(next.terminal).resolves.toMatchObject({ status: 'completed' });
      expect(f.history().filter(call => call.type === 'user').map(call => call.message.content))
        .toEqual(['input first', 'input after-refusal']);
      expect(f.host.snapshot().terminal).toBe(false);
    });

  it('queues concurrent follow-ups once and keeps the native session and transcript ordering', async () => {
    const f = await fixture();
    await expect(f.host.startCommand(f.command('owner_turn', 'first')).terminal).resolves.toMatchObject({ status: 'completed' });
    const secondCommand = f.command('queue', 'second');
    const second = f.host.startCommand(secondCommand), third = f.host.startCommand(f.command('queue', 'third'));
    expect(f.host.startCommand(secondCommand).replayed).toBe(true);
    await expect(f.host.startCommand(f.command('steer', 'correction')).terminal).resolves.toMatchObject({ refusal: { code: 'unsupported' } });
    expect(f.history().filter(call => call.type === 'user')).toHaveLength(1);
    f.control('finish'); await expect(second.terminal).resolves.toMatchObject({ status: 'completed' });
    f.control('finish'); await expect(third.terminal).resolves.toMatchObject({ status: 'completed' });
    const inputs = f.history().filter(call => call.type === 'user');
    expect(inputs.map(call => call.message.content)).toEqual(['input first', 'input second', 'input third']);
    expect(inputs.map(call => call.session_id)).toEqual([f.nativeId, f.nativeId, f.nativeId]);
    expect(new Set(inputs.map(call => call.uuid)).size).toBe(3);
    for (const id of ['first', 'second', 'third']) expect(f.host.recent.filter(({ event }) =>
      event.type === 'command_result' && event.commandId === id && event.status !== 'accepted')).toHaveLength(1);
    expect(f.host.recent.filter(({ event }) => event.type === 'transcript' && event.role === 'assistant' && event.phase === 'completed')
      .map(({ event }) => 'turnId' in event && event.turnId)).toEqual(['owner-first', 'owner-second']);
  });

  it('cancels an open tool card and holds follow-up input until the SDK interrupt acknowledgement', async () => {
    const f = await fixture();
    await f.host.startCommand(f.command('owner_turn', 'first')).terminal;
    f.control('permission');
    await vi.waitFor(() => expect(f.host.recent.some(({ event }) => event.type === 'card' && event.phase === 'opened')).toBe(true));
    const stop = f.host.startCommand(f.command('interrupt', 'stop'));
    await vi.waitFor(() => expect(f.history().some(call => call.request?.subtype === 'interrupt')).toBe(true));
    const next = f.host.startCommand(f.command('queue', 'next'));
    await vi.waitFor(() => expect(f.host.descriptor().lifecycle).toBe('waiting-for-owner'));
    expect(f.history().filter(call => call.type === 'user')).toHaveLength(1);
    await vi.waitFor(() => expect(f.history().some(call => call.type === 'control_response'
      && call.response.request_id === 'tool-approval' && call.response.response?.behavior === 'deny')).toBe(true));
    f.control('release');
    await expect(stop.terminal).resolves.toMatchObject({ status: 'completed' });
    await expect(next.terminal).resolves.toMatchObject({ status: 'completed' });
    expect(f.history().filter(call => call.type === 'user').map(call => call.session_id)).toEqual([f.nativeId, f.nativeId]);
    expect(f.host.recent.some(({ event }) => event.type === 'error' && event.code === 'claude_turn_failed')).toBe(false);
  });

  it('cancels admission before any SDK input and still delivers the next queued turn', async () => {
    let release!: () => void;
    funding.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { ok: true }; });
    const f = await fixture();
    const first = f.host.startCommand(f.command('owner_turn', 'first'));
    await vi.waitFor(() => expect(funding).toHaveBeenCalledOnce());
    const next = f.host.startCommand(f.command('queue', 'next'));
    await expect(f.host.startCommand(f.command('interrupt', 'stop')).terminal).resolves.toMatchObject({ status: 'completed' });
    release();
    await expect(first.terminal).resolves.toMatchObject({ refusal: { code: 'turn_interrupted' } });
    await expect(next.terminal).resolves.toMatchObject({ status: 'completed' });
    expect(f.history().filter(call => call.type === 'user').map(call => call.message.content)).toEqual(['input next']);
    expect(f.history().filter(call => call.request?.subtype === 'interrupt')).toEqual([]);
  });

  it('settles an accepted queued command once when the SDK process is closed', async () => {
    const f = await fixture();
    await f.host.startCommand(f.command('owner_turn', 'first')).terminal;
    const nextCommand = f.command('queue', 'next');
    const next = f.host.startCommand(nextCommand);
    await f.engine.close();
    await expect(next.terminal).resolves.toMatchObject({ status: 'refused', refusal: { code: 'engine_delivery_unknown' } });
    expect(f.history().filter(call => call.type === 'user')).toHaveLength(1);
    expect(f.host.startCommand(nextCommand).replayed).toBe(true);
    expect(f.host.recent.filter(({ event }) => event.type === 'command_result'
      && event.commandId === 'next' && event.status !== 'accepted')).toHaveLength(1);
  });
});
